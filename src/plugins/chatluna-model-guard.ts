import { type Context, Logger, type Session } from 'koishi';
import { injectUserStampedPrompt } from './chat-time-context.js';
import {
  createKeyedStrandRunner,
  createBypassLineSplitOptions,
  dropLeadingLeakedReasoningLines,
  resolveSessionStrandKey,
  sendByLinesWithSmartInterval,
  shouldBypassLineSplit,
  splitMessageByLines,
} from './message-send-utils.js';
import { inferPlatformFromBaseUrl, normalizeRawModelName, resolvePlatform } from './model-utils.js';
import { resolveSessionDisplayName } from './session-user-name.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { STOP: number; CONTINUE: number };
  checkConversationRoomAvailability: (ctx: Context, room: unknown) => Promise<boolean>;
  fixConversationRoomAvailability: (ctx: Context, config: unknown, room: unknown) => Promise<boolean>;
};
const ChatLunaPlatformTypes = require('koishi-plugin-chatluna/llm-core/platform/types') as {
  ModelType?: { llm?: number };
};

export const name = 'chatluna-model-guard';
export const inject = ['chatluna'];

type ChatLunaLike = {
  awaitLoadPlatform?: (platform: string, timeout?: number) => Promise<void>;
  platform?: {
    listAllModels?: (type: number) => { value?: Array<{ toModelName?: () => string; platform?: string; name?: string }> };
  };
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
    inputMessage?: {
      content?: unknown;
    };
  };
};

const logger = new Logger(name);
const LLM_MODEL_TYPE = ChatLunaPlatformTypes.ModelType?.llm ?? 1;

function listAllLlmModels(chatluna: ChatLunaLike): string[] {
  try {
    const models = chatluna.platform?.listAllModels?.(LLM_MODEL_TYPE).value ?? [];
    return models
      .map((model) => {
        if (typeof model.toModelName === 'function') return model.toModelName().trim();
        if (model.platform && model.name) return `${model.platform}/${model.name}`.trim();
        return '';
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function resolveDefaultModelForGuard(): string | null {
  return process.env.CHATLUNA_DEFAULT_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || null;
}

function resolvePreferredPlatformForGuard(defaultModel: string | null): string | null {
  return (
    resolvePlatform(defaultModel ?? undefined) ??
    inferPlatformFromBaseUrl(process.env.OPENAI_BASE_URL) ??
    null
  );
}

export function apply(ctx: Context): void {
  const inboundStrand = createKeyedStrandRunner();
  const sendStrand = createKeyedStrandRunner();

  ctx.middleware(
    async (session, next) => {
      if (session.platform !== 'onebot') return next();
      if (!session.userId || session.userId === session.bot?.selfId) return next();

      const strandKey = resolveSessionStrandKey(session);
      if (!strandKey) return next();

      return inboundStrand.run(strandKey, async () => next());
    },
    true,
  );

  ctx.on('before-send', async (session, options) => {
    if (shouldBypassLineSplit(options)) return;
    if (session.platform !== 'onebot') return;
    if (!session.channelId || !session.content || !session.content.includes('\n')) return;

    const channelId = session.channelId;
    const rawLines = splitMessageByLines(session.content);
    if (rawLines.length <= 1) return;
    const lines = dropLeadingLeakedReasoningLines(rawLines);
    const shouldIntercept = lines.length !== rawLines.length || lines.length > 1;
    if (!shouldIntercept) return;

    const strandKey = resolveSessionStrandKey(session);
    const sendTask = async () => {
      if (!lines.length) return;
      if (lines.length === 1) {
        const lineOptions = createBypassLineSplitOptions(session);
        await session.bot.sendMessage(channelId, lines[0], undefined, lineOptions);
        return;
      }

      await sendByLinesWithSmartInterval(lines.join('\n'), async (line) => {
        const lineOptions = createBypassLineSplitOptions(session);
        await session.bot.sendMessage(channelId, line, undefined, lineOptions);
      });
    };

    if (strandKey) {
      await sendStrand.run(strandKey, sendTask);
    } else {
      await sendTask();
    }

    return true;
  });

  ctx.on('ready', () => {
    const chatluna = (ctx as ContextWithChatLuna).chatluna;
    const chain = chatluna?.chatChain;
    if (!chatluna || !chain) {
      logger.warn('chatluna service is not available, skip model guard middleware.');
      return;
    }

    chain
      .middleware('chatluna_time_context', async (rawSession, rawContext) => {
        const session = rawSession as Session;
        const context = rawContext as MiddlewareContextLike;
        const inputMessage = context.options?.inputMessage;
        if (!inputMessage) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        const userName = resolveSessionDisplayName(session);
        inputMessage.content = injectUserStampedPrompt(inputMessage.content, userName);
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('read_chat_message')
      .before('lifecycle-handle_command');

    chain
      .middleware('chatluna_model_guard', async (rawSession, rawContext) => {
        const context = rawContext as MiddlewareContextLike;
        try {
          if ((context.command?.length ?? 0) > 1) {
            return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
          }

          const room = context.options?.room;
          if (!room) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;

          const defaultModel = resolveDefaultModelForGuard();
          const preferredPlatform = resolvePreferredPlatformForGuard(defaultModel);
          const normalizedModel = normalizeRawModelName(room.model, {
            availableModels: listAllLlmModels(chatluna),
            preferredPlatform,
            defaultModel,
          });
          if (normalizedModel && normalizedModel !== room.model?.trim()) {
            room.model = normalizedModel;
            logger.info(
              'normalized room model for guard (roomId=%s, model=%s).',
              String(room.roomId ?? ''),
              normalizedModel,
            );
          }
          if (!room.model) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;

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
            } catch (error) {
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
            } else {
              logger.warn(
                'room still unavailable after model guard fix (roomId=%s, model=%s), continue to builtin resolver.',
                String(room.roomId ?? ''),
                String(room.model ?? ''),
              );
            }
          }
        } catch (error) {
          logger.warn('model guard middleware failed: %s', (error as Error).message);
        }

        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('resolve_room')
      .before('resolve_model');
  });
}
