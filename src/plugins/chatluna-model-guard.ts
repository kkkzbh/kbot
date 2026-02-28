import { type Context, Logger, type Session } from 'koishi';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { STOP: number; CONTINUE: number };
  checkConversationRoomAvailability: (ctx: Context, room: unknown) => Promise<boolean>;
  fixConversationRoomAvailability: (ctx: Context, config: unknown, room: unknown) => Promise<boolean>;
};

export const name = 'chatluna-model-guard';
export const inject = ['chatluna'];

type ChatLunaLike = {
  awaitLoadPlatform?: (platform: string, timeout?: number) => Promise<void>;
  chatChain?: {
    middleware: (name: string, middleware: (session: unknown, context: unknown) => Promise<number>) => {
      after: (name: string) => { before: (name: string) => unknown };
    };
  };
};

type ContextWithChatLuna = Context & { chatluna?: ChatLunaLike };

type RoomLike = {
  roomId?: number | string;
  model?: string;
};

type MiddlewareContextLike = {
  command?: string;
  config: unknown;
  send?: (message: string) => Promise<void>;
  options?: {
    room?: RoomLike;
  };
};

const logger = new Logger(name);

function resolvePlatform(model?: string): string | null {
  if (!model) return null;
  const value = model.trim();
  if (!value) return null;
  const index = value.indexOf('/');
  if (index <= 0) return null;
  return value.slice(0, index);
}

export function apply(ctx: Context): void {
  ctx.on('ready', () => {
    const chatluna = (ctx as ContextWithChatLuna).chatluna;
    const chain = chatluna?.chatChain;
    if (!chatluna || !chain) {
      logger.warn('chatluna service is not available, skip model guard middleware.');
      return;
    }

    chain
      .middleware('chatluna_model_guard', async (rawSession, rawContext) => {
        const session = rawSession as Session;
        const context = rawContext as MiddlewareContextLike;
        if ((context.command?.length ?? 0) > 1) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const room = context.options?.room;
        if (!room || !room.model) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const platform = resolvePlatform(room.model);
        if (platform && chatluna.awaitLoadPlatform) {
          try {
            await chatluna.awaitLoadPlatform(platform, 15000);
          } catch (error) {
            logger.warn(
              'awaitLoadPlatform failed for %s (roomId=%s): %s',
              platform,
              String(room.roomId ?? ''),
              (error as Error).message,
            );
          }
        }

        let available = false;
        try {
          available = await ChatLunaChains.checkConversationRoomAvailability(ctx, room as never);
        } catch (error) {
          logger.warn(
            'model guard check failed (roomId=%s): %s',
            String(room.roomId ?? ''),
            (error as Error).message,
          );
        }

        if (!available) {
          let fixed = false;
          try {
            fixed = await ChatLunaChains.fixConversationRoomAvailability(
              ctx,
              context.config as never,
              room as never,
            );
          }
          catch (error) {
            logger.warn(
              'auto-fix unavailable room failed (roomId=%s): %s',
              String(room.roomId ?? ''),
              (error as Error).message,
            );
          }

          if (fixed) {
            logger.info(
              'auto-fixed unavailable room model (roomId=%s, model=%s).',
              String(room.roomId ?? ''),
              String(room.model ?? ''),
            );
            return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
          }

          const modelName = room.model?.trim() || 'empty';
          await context.send?.(session.text('chatluna.room.unavailable', [modelName]));
          return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
        }

        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('resolve_room')
      .before('resolve_model');
  });
}
