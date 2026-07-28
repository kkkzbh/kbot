import { type Context, Logger, type Session } from 'koishi';
import {
  buildNaturalTriggerReference,
  formatStructuredLogBlock,
  buildProactiveOpeningState,
  buildUserContextReference,
  resolveUserTurnIntentState,
} from '../reply/index.js';
import {
  CanonicalModelBindingResolver,
  type ResolvedModelBinding,
  type ModelConfigService,
} from '../model-config/index.js';
import type { PromptFragmentPolicyServiceLike } from '../prompt-fragment-policy/index.js';
import {
  resolveChatLunaRoomLike,
  type QqbotChatLunaRoomLike,
  type QqbotChatLunaContextOptionsLike,
} from '../shared/chatluna-conversation.js';
import { beginPromptAssemblyTurn, registerPromptFragment } from '../shared/prompt-context/index.js';
import { resolveSessionDisplayName } from '../shared/session/index.js';
import { getNaturalTriggerState } from '../triggers/group-natural/index.js';
import { syncRoomModelToMainBinding } from './hot-switch.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { STOP: number; CONTINUE: number };
};

export const name = 'chatluna-model-guard';
export const inject = ['chatluna', 'database', 'modelConfig', 'promptFragmentPolicy'];

export interface Config {}

type ChainHookBuilder = {
  after: (name: string) => ChainHookBuilder;
  before: (name: string) => ChainHookBuilder;
};

type ChatLunaLike = {
  awaitLoadPlatform?: (platform: string, timeout?: number) => Promise<void>;
  clearCache?: (room: QqbotChatLunaRoomLike) => Promise<unknown>;
  conversation?: {
    createConversation?: (session: Session, options: {
      bindingKey?: string;
      title: string;
      model: string;
      preset: string;
      chatMode: string;
    }) => Promise<NonNullable<QqbotChatLunaContextOptionsLike['conversation']>['conversation']>;
  };
  platform?: {
    findModel?: (fullModelName: string) => { value?: unknown } | null | undefined;
  };
  chatChain?: {
    middleware: (name: string, middleware: (session: unknown, context: unknown) => Promise<number>) => ChainHookBuilder;
  };
};

type ContextServices = {
  chatluna?: ChatLunaLike;
  modelConfig?: ModelConfigService;
  promptFragmentPolicy?: PromptFragmentPolicyServiceLike;
};

type MiddlewareContextLike = {
  command?: string;
  config: unknown;
  send?: (message: string) => Promise<void>;
  options?: QqbotChatLunaContextOptionsLike & {
    messageId?: string;
    inputMessage?: {
      content?: unknown;
    };
  };
};

const logger = new Logger(name);

function trimOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function updateResolvedConversationModel(options: MiddlewareContextLike['options'], model: unknown): void {
  const conversation = options?.conversation?.conversation;
  const nextModel = trimOptionalText(model);
  if (!conversation || !nextModel) return;
  conversation.model = nextModel;
}

function isQqReplySession(session: Session): boolean {
  return session.platform === 'onebot' && Boolean(session.channelId) && Boolean(session.userId) && session.userId !== session.bot?.selfId;
}

async function resolveOrEnsureReplyRoom(
  chatluna: ChatLunaLike,
  session: Session,
  context: MiddlewareContextLike,
  mainBinding: ResolvedModelBinding,
): Promise<QqbotChatLunaRoomLike | undefined> {
  const resolved = resolveChatLunaRoomLike(context.options);
  if (resolved) return resolved;
  if (!isQqReplySession(session)) return undefined;

  const conversationService = chatluna.conversation;
  if (typeof conversationService?.createConversation !== 'function') {
    throw new Error('ChatLuna conversation service is required before model guard can create a QQ reply conversation.');
  }

  context.options ??= {};
  const current = context.options.conversation;
  const currentRecord = current as (NonNullable<QqbotChatLunaContextOptionsLike['conversation']> & {
    effectivePreset?: unknown;
    effectiveChatMode?: unknown;
    constraint?: { allowNew?: boolean | null } | null;
  }) | null | undefined;
  if (currentRecord?.constraint?.allowNew === false) {
    throw new Error('ChatLuna conversation constraint forbids creating a QQ reply conversation.');
  }
  const bindingKey = trimOptionalText(currentRecord?.bindingKey);
  const preset = trimOptionalText(currentRecord?.effectivePreset) ?? trimOptionalText(currentRecord?.conversation?.preset);
  const chatMode = trimOptionalText(currentRecord?.effectiveChatMode) ?? trimOptionalText(currentRecord?.conversation?.chatMode);
  if (!bindingKey || !preset || !chatMode) {
    throw new Error('ChatLuna resolved conversation context is incomplete for QQ reply activation.');
  }
  if (!mainBinding.target || !mainBinding.model) {
    throw new Error('main.chat did not resolve to a dedicated model.');
  }
  const conversation = await conversationService.createConversation(session, {
    bindingKey,
    title: trimOptionalText(currentRecord?.presetLane) ?? 'New Conversation',
    model: mainBinding.model,
    preset,
    chatMode,
  });
  context.options.conversation = {
    ...(currentRecord ?? {}),
    mode: 'active',
    conversationId: conversation?.id ?? null,
    conversation,
  };

  return resolveChatLunaRoomLike(context.options);
}

export function apply(ctx: Context, config: Config = {}): void {
  const services = ctx as unknown as ContextServices;
  void config;
  let modelGuardRegistered = false;

  const ensureModelGuardRegistered = (): boolean => {
    if (modelGuardRegistered) return true;
    const chatluna = services.chatluna;
    const modelConfig = services.modelConfig;
    const promptFragmentPolicy = services.promptFragmentPolicy;
    const chain = chatluna?.chatChain;
    if (!chatluna || !chain || !modelConfig || !promptFragmentPolicy) return false;

    chain
      .middleware('qqbot_turn_context', async (rawSession, rawContext) => {
        const session = rawSession as Session;
        const context = rawContext as MiddlewareContextLike;
        const inputMessage = context.options?.inputMessage;
        if (!inputMessage) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        const room = resolveChatLunaRoomLike(context.options);
        const conversationId = room?.conversationId?.trim();
        if (conversationId) {
          const contextPresetId = room?.preset?.trim();
          if (!contextPresetId) {
            throw new Error(`conversation ${conversationId} has no canonical context preset id.`);
          }
          const fragmentPolicy = await promptFragmentPolicy.get(contextPresetId);
          beginPromptAssemblyTurn(conversationId, {
            turnId: context.options?.messageId,
            selection: fragmentPolicy.config,
          });
        }
        const turnIntent = resolveUserTurnIntentState(session.stripped?.content, inputMessage.content);
        const userName = resolveSessionDisplayName(session);
        const contextReference = buildUserContextReference(userName);
        const naturalTrigger = getNaturalTriggerState(session as unknown as Record<string, unknown>);
        if (conversationId) {
          registerPromptFragment(conversationId, {
            source: 'qqbot_turn_context',
            title: 'User Turn Metadata',
            authority: 'reference',
            trust: 'trusted',
            ttl: 'turn',
            channel: 'required',
            payload: {
              kind: 'json',
              value: contextReference,
            },
          });
          if (turnIntent.mode === 'proactive_opening') {
            registerPromptFragment(conversationId, {
              source: 'qqbot_proactive_opening_mode',
              title: 'Proactive Opening State',
              authority: 'assistant_state',
              trust: 'trusted',
              ttl: 'turn',
              channel: 'required',
              payload: {
                kind: 'json',
                value: buildProactiveOpeningState(turnIntent),
              },
            });
          }
          if (naturalTrigger && !naturalTrigger.explicit) {
            registerPromptFragment(conversationId, {
              source: 'qqbot_natural_trigger',
              title: 'Natural Trigger Context',
              authority: 'reference',
              trust: 'trusted',
              ttl: 'turn',
              channel: 'required',
              payload: {
                kind: 'json',
                value: buildNaturalTriggerReference(naturalTrigger),
              },
            });
          }
        }
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

          const session = rawSession as Session;
          const mainBinding = new CanonicalModelBindingResolver(
            modelConfig.getRuntimeSnapshot(),
          ).resolve('main.chat');
          if (!mainBinding.target) {
            throw new Error('main.chat binding is not dedicated.');
          }
          const room = await resolveOrEnsureReplyRoom(
            chatluna,
            session,
            context,
            mainBinding,
          );
          if (!room) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;

          const syncResult = await syncRoomModelToMainBinding({
            room,
            target: mainBinding.target,
            revision: mainBinding.revision,
            clearCache: chatluna.clearCache?.bind(chatluna),
            updateConversationModel: (conversationId, model) => (
              ctx.database as unknown as {
                set: (table: string, query: unknown, row: unknown) => Promise<unknown>;
              }
            ).set('chatluna_conversation', { id: conversationId }, { model }),
          });
          updateResolvedConversationModel(context.options, room.model);
          if (syncResult.changed) {
            logger.info(
              'synchronized conversation model binding (conversationId=%s, model=%s, revision=%s, connection=%s, requestMode=%s).',
              trimOptionalText(room.conversationId) ?? '<unknown>',
              syncResult.canonicalModel,
              String(syncResult.revision),
              syncResult.connectionId,
              syncResult.requestMode,
            );
          }
          logger.info(
            '%s',
            formatStructuredLogBlock('reply-plan-debug', {
              stage: 'model_guard_effective_model',
              conversationId: trimOptionalText(room.conversationId) ?? null,
              originalRoomModel: syncResult.originalModel,
              effectiveModel: syncResult.canonicalModel,
              effectiveTransportModel: syncResult.transportModel,
              effectiveConnectionId: syncResult.connectionId,
              effectiveModelId: syncResult.modelId,
              effectiveAdapter: syncResult.adapter,
              modelConfigRevision: syncResult.revision,
              effectiveRequestMode: syncResult.requestMode,
              effectiveOutputProtocol: syncResult.outputProtocol,
              preset: trimOptionalText(room.preset) ?? null,
            }),
          );
          if (!room.model) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;

          const platform = `qqbot-${mainBinding.target.connection.id}`;
          if (chatluna.awaitLoadPlatform) {
            try {
              await chatluna.awaitLoadPlatform(platform, 15000);
            } catch (error) {
              logger.warn(
                'awaitLoadPlatform failed for %s (conversationId=%s): %s',
                platform,
                trimOptionalText(room.conversationId) ?? '<unknown>',
                (error as Error).message,
              );
            }
          }

          const available = Boolean(chatluna.platform?.findModel?.(room.model)?.value);

          if (!available) {
            const modelName = trimOptionalText(room.model) ?? 'unknown';
            logger.warn(
              'current main chat model is unavailable (conversationId=%s, model=%s).',
              trimOptionalText(room.conversationId) ?? '<unknown>',
              modelName,
            );
            if (context.send) {
              await context.send(`当前主聊天模型不可用：${modelName}`);
            }
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }
        } catch (error) {
          logger.warn('model guard middleware failed: %s', (error as Error).message);
          if (context.send) {
            try {
              await context.send('主聊天模型同步失败，请稍后重试。');
            } catch (sendError) {
              logger.warn('model guard failure notice failed: %s', (sendError as Error).message);
            }
          }
          return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
        }

        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('resolve_conversation')
      .before('resolve_model');
    modelGuardRegistered = true;
    return true;
  };

  ctx.on('ready', () => {
    ensureModelGuardRegistered();
  });

  ctx.on('chatluna/chat-chain-added', () => {
    ensureModelGuardRegistered();
  });
}
