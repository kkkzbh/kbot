import {
  AIMessage,
  HumanMessage,
  type MessageContent,
} from '@langchain/core/messages';
import { randomUUID } from 'node:crypto';
import { Context, h, Logger, type Fragment, type Session } from 'koishi';
import type {
  NativeFeatureCapability,
  NativeFeatureChatServiceLike,
  NativeFeatureHistoryResult,
  NativeFeatureReplyInput,
} from '../../types/native-feature-chat.js';
import '../../types/native-feature-chat.js';
import {
  createChatLunaHistoryWriter,
  type ChatLunaHistoryDatabaseLike,
  type ChatLunaHistoryServiceLike,
} from '../shared/chatluna-history.js';
import {
  resolveChatLunaRoomLike,
  type QqbotChatLunaContextOptionsLike,
} from '../shared/chatluna-conversation.js';
import { registerPromptFragment } from '../shared/prompt-context/index.js';
import { buildNativeFeatureAssistantHistoryText } from '../shared/native-feature-history.js';
import { resolveSessionDisplayName } from '../shared/session/index.js';
import { discardRealtimeMessageForSession } from '../realtime-message/index.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { CONTINUE: number };
};

export const name = 'native-feature-chat';
export const inject = { required: ['database', 'chatluna'] } as const;

export interface Config {}

type ChainHookBuilder = {
  after(name: string): ChainHookBuilder;
  before(name: string): ChainHookBuilder;
};

type ActiveConversationResolution = {
  conversationId?: string | null;
  effectiveModel?: string | null;
  conversation?: {
    id?: string | null;
    model?: string | null;
  } | null;
};

type NativeFeatureChatLuna = ChatLunaHistoryServiceLike & {
  conversation?: {
    resolveConversation?: (
      session: Session,
      options: { mode: 'active'; useRoutePresetLane: true },
    ) => Promise<ActiveConversationResolution>;
  };
  messageTransformer?: {
    transform: (
      session: Session,
      message: unknown[],
      model?: string,
      command?: unknown,
      options?: Record<string, unknown>,
    ) => Promise<{ content?: unknown }>;
  };
  chatChain?: {
    middleware: (
      name: string,
      middleware: (session: unknown, context: unknown) => Promise<number>,
    ) => ChainHookBuilder;
  };
};

type NativeFeatureContext = {
  database: ChatLunaHistoryDatabaseLike;
  chatluna: NativeFeatureChatLuna;
};

const logger = new Logger(name);

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function buildSpeakerTaggedText(session: Session, text: string): string {
  const userId = normalizeText(session.userId);
  if (!userId) {
    throw new Error('native feature history requires session.userId.');
  }
  const speakerName = resolveSessionDisplayName(session);
  return `[speaker_id=${userId} speaker_name=${JSON.stringify(speakerName)}] ${text}`.trim();
}

function normalizedReplyElements(reply: Fragment): unknown[] {
  return h.normalize(reply).filter((element) => element.type !== 'at');
}

class NativeFeatureChatService implements NativeFeatureChatServiceLike {
  private readonly capabilities = new Map<string, NativeFeatureCapability>();
  private readonly historyWriteLocks = new Map<string, Promise<void>>();
  private capabilityContextLogged = false;

  constructor(private readonly ctx: NativeFeatureContext) {}

  registerCapability(capability: NativeFeatureCapability): () => void {
    const id = normalizeText(capability.id);
    if (!id) {
      throw new Error('native feature capability id is required.');
    }
    if (this.capabilities.has(id)) {
      throw new Error(`native feature capability is already registered: ${id}`);
    }
    this.capabilities.set(id, { ...capability, id });
    logger.info('native feature capability registered: %s', id);
    return () => {
      this.capabilities.delete(id);
    };
  }

  buildCapabilityReference(session: Session): string | null {
    const sections = [...this.capabilities.values()]
      .filter((capability) => capability.isRelevant(session))
      .map((capability) => normalizeText(capability.buildReference(session)))
      .filter(Boolean);
    if (sections.length && !this.capabilityContextLogged) {
      logger.info('native feature capability context active: %s', [...this.capabilities.keys()].join(', '));
      this.capabilityContextLogged = true;
    }

    return [
      'QQ 内置功能边界：',
      '- 自由聊天是默认职责，只回应当前消息本身，不主动推荐内置功能。',
      '- 只有当前消息明确询问、尝试或要求纠正某项内置功能命令时，才可提及对应功能和命令。',
      '- 不得仅凭历史查询记录、功能可能有用或功能确实存在，主动枚举、追问或引导用户使用功能。',
      '- 历史中的功能查询结果只在当前消息明确引用或询问相关结果时作为上下文使用。',
      '- 本提示只提供命令识别参考，不授予功能调用权限；不得声称已经代替用户执行查询或账号操作。',
      ...(sections.length
        ? [
          '',
          '当前消息可能涉及的只读命令参考：',
          ...sections,
        ]
        : []),
    ].join('\n');
  }

  private async withConversationWriteLock<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.historyWriteLocks.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current, () => current);
    this.historyWriteLocks.set(conversationId, tail);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.historyWriteLocks.get(conversationId) === tail) {
        this.historyWriteLocks.delete(conversationId);
      }
    }
  }

  async sendReply(
    session: Session,
    input: NativeFeatureReplyInput,
  ): Promise<NativeFeatureHistoryResult | null> {
    await session.send(input.reply);
    try {
      return await this.recordExchange(session, input);
    } catch (error) {
      logger.warn(
        'native feature reply history write failed: feature=%s command=%s messageId=%s error=%s',
        input.featureId,
        input.commandId,
        normalizeText(session.messageId) || '<unknown>',
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  async recordExchange(
    session: Session,
    input: NativeFeatureReplyInput,
  ): Promise<NativeFeatureHistoryResult> {
    const featureId = normalizeText(input.featureId);
    const commandId = normalizeText(input.commandId);
    const userText = normalizeText(input.userText);
    const summary = normalizeText(input.summary);
    if (!featureId || !commandId || !userText || !summary) {
      throw new Error('native feature history input is incomplete.');
    }

    const conversationService = this.ctx.chatluna.conversation;
    if (typeof conversationService?.resolveConversation !== 'function') {
      throw new Error('native feature history requires ChatLuna conversation service.');
    }
    const transformer = this.ctx.chatluna.messageTransformer;
    if (input.includeReplyPayload && typeof transformer?.transform !== 'function') {
      throw new Error('native feature history requires ChatLuna message transformer for reply payloads.');
    }

    const resolved = await conversationService.resolveConversation(session, {
      mode: 'active',
      useRoutePresetLane: true,
    });
    const conversationId = normalizeText(resolved.conversation?.id) || normalizeText(resolved.conversationId);
    if (!conversationId) {
      throw new Error('native feature history could not resolve an active conversation.');
    }

    const exchangeId = randomUUID();
    const humanRecordId = `native-feature:${featureId}:${exchangeId}:human`;
    const assistantRecordId = `native-feature:${featureId}:${exchangeId}:assistant`;
    const speakerId = normalizeText(session.userId);
    const speakerName = resolveSessionDisplayName(session);
    const triggerMessageId = normalizeText(session.messageId) || null;
    const metadata = {
      version: 'v1',
      featureId,
      commandId,
      success: input.success,
      triggerMessageId,
      replyPayloadIncluded: input.includeReplyPayload,
    };

    const humanMessage = new HumanMessage({
      content: buildSpeakerTaggedText(session, userText),
      id: speakerId,
      response_metadata: {
        chatluna: { recordId: humanRecordId },
      },
      additional_kwargs: {
        qqbot_speaker_format: {
          version: 'speaker_id_v1',
          speakerId,
          speakerName,
          isDirect: session.isDirect === true,
          preformatted: true,
        },
        qqbot_native_feature: {
          ...metadata,
          role: 'request',
        },
      },
    });

    let assistantContent: MessageContent = summary;
    if (input.includeReplyPayload) {
      const model = normalizeText(resolved.effectiveModel) || normalizeText(resolved.conversation?.model);
      const replyElements = normalizedReplyElements(input.reply);
      const transformed = await transformer!.transform(
        session,
        replyElements,
        model,
        undefined,
        { quote: false, includeQuoteReply: false },
      );
      if (typeof transformed.content !== 'string' && !Array.isArray(transformed.content)) {
        throw new Error('native feature reply transformer returned no history content.');
      }
      assistantContent = buildNativeFeatureAssistantHistoryText(
        summary,
        transformed.content as MessageContent,
      );
    }

    const assistantMessage = new AIMessage({
      content: assistantContent,
      response_metadata: {
        chatluna: { recordId: assistantRecordId },
      },
      additional_kwargs: {
        qqbot_native_feature: {
          ...metadata,
          role: 'result',
          summary,
        },
      },
    });

    await this.withConversationWriteLock(conversationId, async () => {
      const writer = await createChatLunaHistoryWriter({
        database: this.ctx.database,
        logger,
        conversationId,
        chatluna: this.ctx.chatluna,
        lockMode: 'acquire',
      });
      await writer.addMessages([humanMessage, assistantMessage]);
    });
    discardRealtimeMessageForSession(session);

    return {
      conversationId,
      humanRecordId,
      assistantRecordId,
    };
  }
}

export function apply(ctx: Context, _config: Config = {}): void {
  const serviceCtx = ctx as unknown as NativeFeatureContext;
  const service = new NativeFeatureChatService(serviceCtx);
  const provider = ctx as Context & {
    provide?: (name: string) => void;
    set?: (name: string, value: unknown) => void;
  };
  if (typeof provider.provide === 'function' && typeof provider.set === 'function') {
    provider.provide('nativeFeatureChat');
    provider.set('nativeFeatureChat', service);
  } else {
    provider.nativeFeatureChat = service;
  }

  let runtimeRegistered = false;
  const ensureRuntimeRegistered = (): boolean => {
    if (runtimeRegistered) return true;
    const chain = serviceCtx.chatluna.chatChain;
    if (!chain) return false;

    chain
      .middleware('qqbot_native_feature_capabilities', async (rawSession, rawContext) => {
        const session = rawSession as Session;
        const context = rawContext as { options?: QqbotChatLunaContextOptionsLike };
        const reference = service.buildCapabilityReference(session);
        const conversationId = resolveChatLunaRoomLike(context.options)?.conversationId;
        if (!reference || !conversationId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        registerPromptFragment(conversationId, {
          source: 'qqbot_native_features',
          title: 'QQ Native Feature Capabilities',
          authority: 'reference',
          trust: 'trusted',
          ttl: 'turn',
          channel: 'nativeCapabilities',
          payload: {
            kind: 'text',
            value: reference,
          },
        });
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('qqbot_turn_context')
      .before('qqbot_memory')
      .before('qqbot_reply_transport_policy')
      .before('lifecycle-handle_command');

    runtimeRegistered = true;
    logger.info('native feature capability middleware registered.');
    return true;
  };

  ctx.on('ready', () => {
    ensureRuntimeRegistered();
  });
  ctx.on('chatluna/chat-chain-added', () => {
    ensureRuntimeRegistered();
  });
}
