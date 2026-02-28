/**
 * @deprecated 旧版 group-chat 插件链路。
 * 该文件仅保留用于回滚/参考，默认不启用。
 */
import { h, type Context, type Session, Logger, Schema } from 'koishi';
import {
  buildConversationKey,
  decideChatPolicy,
  extractMentionText,
  GroupInFlightLimiter,
  MemoryConversationStore,
  requestChatCompletion,
  resolveSystemPrompt,
  trimConversation,
  UserCooldownTracker,
  type GroupChatConfig,
} from './group-chat-core.js';

const logger = new Logger('group-chat');

export const name = 'group-chat';

export interface Config {
  enabledGroups?: string[] | string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxContextTurns?: number;
  timeoutMs?: number;
  userCooldownMs?: number;
  groupQpsLimit?: number;
  systemPrompt?: string;
  systemPromptFile?: string;
}

export const Config: Schema<Config> = Schema.object({
  enabledGroups: Schema.union([
    Schema.array(Schema.string()).role('table').description('允许聊天的群号列表。'),
    Schema.string().description('逗号分隔的群号列表。'),
  ]).description('白名单群。'),
  baseUrl: Schema.string().role('link').description('OpenAI 兼容 API 的 Base URL。'),
  apiKey: Schema.string().role('secret').description('OpenAI 兼容 API Key。'),
  model: Schema.string().description('OpenAI 兼容模型名。'),
  maxContextTurns: Schema.natural().default(8).description('上下文轮数。'),
  timeoutMs: Schema.natural().role('time').default(20000).description('模型请求超时（毫秒）。'),
  userCooldownMs: Schema.natural().role('time').default(8000).description('用户冷却时间（毫秒）。'),
  groupQpsLimit: Schema.natural().default(1).description('每群并发限制。'),
  systemPrompt: Schema.string().description('系统提示词。'),
  systemPromptFile: Schema.string().description('系统提示词文件路径（支持多行）。'),
});

function parseGroupSet(value: Config['enabledGroups']): Set<string> {
  if (!value) return new Set<string>();
  if (Array.isArray(value)) {
    return new Set(
      value
        .map((item) => normalizeGroupId(String(item)))
        .filter((item): item is string => Boolean(item)),
    );
  }

  return new Set(
    value
      .split(',')
      .map((item) => normalizeGroupId(item))
      .filter((item): item is string => Boolean(item)),
  );
}

function toRuntimeConfig(config: Config): GroupChatConfig {
  const triggerMode = process.env.CHAT_TRIGGER_MODE ?? 'mention';
  if (triggerMode !== 'mention') {
    throw new Error(`CHAT_TRIGGER_MODE must be mention, got: ${triggerMode}`);
  }

  const enabledGroups = parseGroupSet(config.enabledGroups ?? process.env.CHAT_ENABLED_GROUPS);
  const baseUrl = (config.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  const model = config.model ?? process.env.OPENAI_MODEL ?? '';

  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY (or plugin config apiKey).');
  }
  if (!model) {
    throw new Error('Missing OPENAI_MODEL (or plugin config model).');
  }

  return {
    enabledGroups,
    baseUrl,
    apiKey,
    model,
    maxContextTurns: config.maxContextTurns ?? Number(process.env.CHAT_MAX_CONTEXT_TURNS || 8),
    timeoutMs: config.timeoutMs ?? Number(process.env.CHAT_TIMEOUT_MS || 20000),
    userCooldownMs: config.userCooldownMs ?? Number(process.env.CHAT_USER_COOLDOWN_MS || 8000),
    groupQpsLimit: config.groupQpsLimit ?? Number(process.env.CHAT_GROUP_QPS_LIMIT || 1),
    systemPrompt: resolveSystemPrompt({
      systemPrompt: config.systemPrompt,
      systemPromptFile: config.systemPromptFile,
    }),
  };
}

function formatBusyMessage(session: Session): string {
  return `${h.at(session.userId!)} 当前群聊请求较多，请稍后再试。`;
}

function formatCooldownMessage(session: Session, retryAfterMs?: number): string {
  const retrySeconds = Math.max(1, Math.ceil((retryAfterMs ?? 1000) / 1000));
  return `${h.at(session.userId!)} 请稍等 ${retrySeconds} 秒再试。`;
}

function formatFailureMessage(session: Session): string {
  return `${h.at(session.userId!)} 模型服务暂时不可用，请稍后再试。`;
}

function normalizeGroupId(input?: string | null): string | null {
  if (!input) return null;
  const value = String(input).trim();
  if (!value) return null;

  if (value.startsWith('group:')) return value.slice('group:'.length);
  if (value.startsWith('guild:')) return value.slice('guild:'.length);
  return value;
}

function resolveGroupId(session: Session): string | null {
  if (session.isDirect) return null;
  return normalizeGroupId(session.guildId) ?? normalizeGroupId(session.channelId);
}

export function apply(ctx: Context, config: Config): void {
  const runtime = toRuntimeConfig(config);
  const conversationStore = new MemoryConversationStore();
  const cooldownTracker = new UserCooldownTracker();
  const inFlightLimiter = new GroupInFlightLimiter();
  const contextTtlMs = 20 * 60 * 1000;

  const handleMessage = async (session: Session) => {
    if (!session.userId || !session.content || !session.bot?.selfId) {
      return;
    }

    const now = Date.now();

    if (session.userId === session.bot.selfId) {
      return;
    }

    const groupId = resolveGroupId(session);
    if (!groupId) {
      return;
    }

    const stripped = session.stripped;
    const mentionText =
      extractMentionText(session.content, session.bot.selfId) ??
      ((stripped.hasAt || stripped.atSelf || stripped.appel) ? (stripped.content.trim() || null) : null);
    const decision = decideChatPolicy({
      groupId,
      mentionText,
      enabledGroups: runtime.enabledGroups,
    });

    if (!decision.allowed) {
      if (stripped.hasAt || stripped.atSelf || stripped.appel) {
        logger.info(
          'chat skipped: reason=%s groupId=%s channelId=%s guildId=%s',
          decision.reason,
          groupId,
          session.channelId ?? '',
          session.guildId ?? '',
        );
      }
      return;
    }

    if (mentionText === null) {
      return;
    }
    const prompt = mentionText;

    const userKey = `${groupId}:${session.userId}`;
    const cooldownResult = cooldownTracker.checkAndTouch(userKey, now, runtime.userCooldownMs);
    if (!cooldownResult.allowed) {
      await session.send(formatCooldownMessage(session, cooldownResult.retryAfterMs));
      return;
    }

    const acquired = inFlightLimiter.tryAcquire(groupId, runtime.groupQpsLimit);
    if (!acquired) {
      await session.send(formatBusyMessage(session));
      return;
    }

    const conversationKey = buildConversationKey(groupId, session.userId);
    const history = conversationStore.get(conversationKey, now, contextTtlMs);

    const messages = [
      { role: 'system' as const, content: runtime.systemPrompt },
      ...history,
      { role: 'user' as const, content: prompt },
    ];

    try {
      const completion = await requestChatCompletion(runtime, messages);

      const nextHistory = trimConversation(
        [...history, { role: 'user', content: prompt }, { role: 'assistant', content: completion.text }],
        runtime.maxContextTurns,
      );
      conversationStore.set(conversationKey, nextHistory, now);

      await session.send(`${h.at(session.userId)} ${completion.text}`);
    } catch (error) {
      const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
      const causeSummary = cause ? ` (cause=${cause.code ?? 'unknown'}: ${cause.message ?? 'unknown'})` : '';
      logger.warn('chat completion failed: %s%s', (error as Error).message, causeSummary);
      await session.send(formatFailureMessage(session));
    } finally {
      inFlightLimiter.release(groupId);
    }
  };

  ctx.on('message', handleMessage);

  logger.info(
    'group chat plugin loaded, enabled groups: %d, system prompt length: %d',
    runtime.enabledGroups.size,
    runtime.systemPrompt.length,
  );
}
