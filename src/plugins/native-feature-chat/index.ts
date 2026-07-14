import {
  AIMessage,
  HumanMessage,
  type MessageContent,
  type MessageContentComplex,
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

function isTextPart(part: MessageContentComplex): part is MessageContentComplex & { type: 'text'; text: string } {
  return part.type === 'text' && typeof (part as { text?: unknown }).text === 'string';
}

function mergeSummaryIntoContent(summary: string, content: MessageContent): MessageContent {
  const normalizedSummary = normalizeText(summary);
  if (!normalizedSummary) return content;

  if (typeof content === 'string') {
    const normalizedContent = content.trim();
    if (!normalizedContent) return normalizedSummary;
    if (normalizedContent.includes(normalizedSummary)) return normalizedContent;
    return `${normalizedSummary}\n${normalizedContent}`;
  }

  const parts = Array.isArray(content)
    ? content.filter((part): part is MessageContentComplex => Boolean(part && typeof part === 'object'))
    : [];
  const textIndex = parts.findIndex(isTextPart);
  if (textIndex < 0) {
    return [{ type: 'text', text: normalizedSummary }, ...parts];
  }

  return parts.map((part, index) => {
    if (index !== textIndex || !isTextPart(part)) return part;
    const visibleText = part.text.trim();
    if (!visibleText) return { ...part, text: normalizedSummary };
    if (visibleText.includes(normalizedSummary)) return part;
    return { ...part, text: `${normalizedSummary}\n${visibleText}` };
  });
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

type HistoryElement = {
  type?: unknown;
  attrs?: Record<string, unknown>;
  children?: unknown;
};

function collectReplyImageUrls(elements: unknown[]): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const element = value as HistoryElement;
    if (element.type === 'img' || element.type === 'image') {
      const attrs = element.attrs ?? {};
      const url = normalizeText(attrs.imageUrl) || normalizeText(attrs.src) || normalizeText(attrs.url);
      if (url && !seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
    if (Array.isArray(element.children)) {
      for (const child of element.children) visit(child);
    }
  };
  for (const element of elements) visit(element);
  return urls;
}

function resolveContentImageUrl(part: MessageContentComplex): string | null {
  if (part.type !== 'image_url') return null;
  const raw = (part as { image_url?: unknown }).image_url;
  if (typeof raw === 'string') return normalizeText(raw) || null;
  if (!raw || typeof raw !== 'object') return null;
  return normalizeText((raw as { url?: unknown }).url) || null;
}

function appendReplyImagesToContent(content: MessageContent, elements: unknown[]): MessageContent {
  const imageUrls = collectReplyImageUrls(elements);
  if (!imageUrls.length) return content;

  const parts: MessageContentComplex[] = typeof content === 'string'
    ? content.trim()
      ? [{ type: 'text', text: content.trim() }]
      : []
    : content.filter((part): part is MessageContentComplex => Boolean(part && typeof part === 'object'));
  const existingUrls = new Set(parts.map(resolveContentImageUrl).filter((url): url is string => Boolean(url)));
  let missingImageCount = Math.max(0, imageUrls.length - existingUrls.size);

  for (const url of imageUrls) {
    if (missingImageCount < 1 || existingUrls.has(url)) continue;
    parts.push({ type: 'image_url', image_url: { url } });
    existingUrls.add(url);
    missingImageCount -= 1;
  }
  return parts;
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
      .map((capability) => normalizeText(capability.buildReference(session)))
      .filter(Boolean);
    if (!sections.length) return null;
    if (!this.capabilityContextLogged) {
      logger.info('native feature capability context active: %s', [...this.capabilities.keys()].join(', '));
      this.capabilityContextLogged = true;
    }

    return [
      'QQ 内置功能使用规则：',
      '- 这些功能由关键词插件执行，不是 Agent tool。不要声称已经代替用户执行查询或账号操作。',
      '- 用户表达相关意图、漏写参数或写错格式时，指出问题并给出可以直接发送的准确命令。',
      '- 用户只想查看功能列表时，引导其发送对应的总入口命令。',
      '',
      ...sections,
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
      assistantContent = appendReplyImagesToContent(
        mergeSummaryIntoContent(summary, transformed.content as MessageContent),
        replyElements,
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
