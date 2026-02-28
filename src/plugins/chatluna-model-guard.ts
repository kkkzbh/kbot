import { type Context, Logger } from 'koishi';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { CONTINUE: number };
  checkConversationRoomAvailability: (ctx: Context, room: unknown) => Promise<boolean>;
  fixConversationRoomAvailability: (ctx: Context, config: unknown, room: unknown) => Promise<boolean>;
};

export const name = 'chatluna-model-guard';

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
      .middleware('chatluna_model_guard', async (_session, rawContext) => {
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

        try {
          const available = await ChatLunaChains.checkConversationRoomAvailability(ctx, room as never);
          if (!available) {
            const fixed = await ChatLunaChains.fixConversationRoomAvailability(
              ctx,
              context.config as never,
              room as never,
            );
            if (fixed) {
              logger.info(
                'auto-fixed unavailable room model (roomId=%s, model=%s).',
                String(room.roomId ?? ''),
                String(room.model ?? ''),
              );
            }
          }
        } catch (error) {
          logger.warn(
            'model guard check failed (roomId=%s): %s',
            String(room.roomId ?? ''),
            (error as Error).message,
          );
        }

        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('resolve_room')
      .before('resolve_model');
  });
}
