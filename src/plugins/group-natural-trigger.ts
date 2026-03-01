import { Context, Logger, Schema, Session } from 'koishi';
import { normalizeGroupId, parseGroupSet } from './task-automation-core.js';
import {
  containsAlias,
  createEmptySpamState,
  DEFAULT_TRIGGER_ALIASES,
  parseAliasList,
  recordSpamMessage,
  shouldTriggerByRule,
  type SpamState,
} from './group-natural-trigger-core.js';

const logger = new Logger('group-natural-trigger');

export const name = 'group-natural-trigger';

export interface Config {
  enabled?: boolean;
  enabledGroups?: string[] | string;
  aliases?: string[] | string;
  directTriggerProbability?: number;
  focusWindowMs?: number;
  replyIntervalMs?: number;
  spamWindowMs?: number;
  spamThreshold?: number;
  spamMuteMs?: number;
  decisionEnabled?: boolean;
  decisionBaseUrl?: string;
  decisionApiKey?: string;
  decisionModel?: string;
  decisionTimeoutMs?: number;
  decisionMinConfidence?: number;
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用群聊自然触发。'),
  enabledGroups: Schema.union([
    Schema.array(Schema.string()).role('table').description('启用自然触发的群号列表。留空表示全部群。'),
    Schema.string().description('启用自然触发的群号（逗号分隔，留空表示全部群）。'),
  ]),
  aliases: Schema.union([
    Schema.array(Schema.string()).role('table').description('可触发机器人对话的称呼列表。'),
    Schema.string().description('可触发机器人对话的称呼（逗号分隔）。'),
  ]),
  directTriggerProbability: Schema.number()
    .min(0)
    .max(1)
    .default(0.25)
    .description('任意消息直接触发回复的概率。'),
  focusWindowMs: Schema.natural().role('time').default(300000).description('会话焦点窗口（毫秒）。'),
  replyIntervalMs: Schema.natural().role('time').default(2000).description('机器人两次回复最小时间间隔（毫秒）。'),
  spamWindowMs: Schema.natural().role('time').default(10000).description('刷屏判定窗口（毫秒）。'),
  spamThreshold: Schema.natural().default(10).description('刷屏判定阈值（窗口内消息数）。'),
  spamMuteMs: Schema.natural().role('time').default(180000).description('刷屏后忽略时长（毫秒）。'),
  decisionEnabled: Schema.boolean().default(true).description('是否启用模型触发判定。'),
  decisionBaseUrl: Schema.string()
    .role('link')
    .description('触发判定模型 API Base URL（默认复用 OPENAI_BASE_URL）。'),
  decisionApiKey: Schema.string().role('secret').description('触发判定模型 API Key（默认复用 OPENAI_API_KEY）。'),
  decisionModel: Schema.string().description('触发判定模型名（默认复用 OPENAI_MODEL）。'),
  decisionTimeoutMs: Schema.natural().role('time').default(4000).description('触发判定模型超时（毫秒）。'),
  decisionMinConfidence: Schema.number().min(0).max(1).default(0.62).description('触发判定模型最小置信度。'),
});

interface RuntimeConfig {
  enabled: boolean;
  enabledGroups: Set<string>;
  aliases: string[];
  directTriggerProbability: number;
  focusWindowMs: number;
  replyIntervalMs: number;
  spamWindowMs: number;
  spamThreshold: number;
  spamMuteMs: number;
  decisionEnabled: boolean;
  decisionBaseUrl: string;
  decisionApiKey: string;
  decisionModel: string;
  decisionTimeoutMs: number;
  decisionMinConfidence: number;
}

interface ModelDecisionResponse {
  trigger?: boolean;
  confidence?: number;
}

function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) ?? raw.match(/```\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return null;
}

function toRuntimeConfig(config: Config): RuntimeConfig {
  const configuredAliases = parseAliasList(config.aliases ?? process.env.CHAT_NATURAL_TRIGGER_ALIASES);
  const configuredGroups = parseGroupSet(config.enabledGroups ?? process.env.CHAT_NATURAL_TRIGGER_GROUPS);
  const directTriggerProbability = Number(
    config.directTriggerProbability ?? process.env.CHAT_NATURAL_TRIGGER_DIRECT_PROBABILITY ?? 0.25,
  );
  const decisionBaseUrl = (
    config.decisionBaseUrl ??
    process.env.CHAT_NATURAL_TRIGGER_DECISION_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    ''
  ).replace(/\/+$/, '');

  return {
    enabled:
      config.enabled ??
      String(process.env.CHAT_NATURAL_TRIGGER_ENABLED ?? 'true').toLowerCase() !== 'false',
    enabledGroups: configuredGroups,
    aliases: configuredAliases.length ? configuredAliases : DEFAULT_TRIGGER_ALIASES.map((item) => item.toLowerCase()),
    directTriggerProbability: Number.isFinite(directTriggerProbability)
      ? Math.max(0, Math.min(1, directTriggerProbability))
      : 0.25,
    focusWindowMs: Number(config.focusWindowMs ?? process.env.CHAT_NATURAL_TRIGGER_FOCUS_WINDOW_MS ?? 300000),
    replyIntervalMs: Number(config.replyIntervalMs ?? process.env.CHAT_NATURAL_TRIGGER_REPLY_INTERVAL_MS ?? 2000),
    spamWindowMs: Number(config.spamWindowMs ?? process.env.CHAT_NATURAL_TRIGGER_SPAM_WINDOW_MS ?? 10000),
    spamThreshold: Number(config.spamThreshold ?? process.env.CHAT_NATURAL_TRIGGER_SPAM_THRESHOLD ?? 10),
    spamMuteMs: Number(config.spamMuteMs ?? process.env.CHAT_NATURAL_TRIGGER_SPAM_MUTE_MS ?? 180000),
    decisionEnabled:
      config.decisionEnabled ??
      String(process.env.CHAT_NATURAL_TRIGGER_DECISION_ENABLED ?? 'true').toLowerCase() !== 'false',
    decisionBaseUrl,
    decisionApiKey:
      config.decisionApiKey ?? process.env.CHAT_NATURAL_TRIGGER_DECISION_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
    decisionModel:
      config.decisionModel ?? process.env.CHAT_NATURAL_TRIGGER_DECISION_MODEL ?? process.env.OPENAI_MODEL ?? '',
    decisionTimeoutMs: Number(
      config.decisionTimeoutMs ?? process.env.CHAT_NATURAL_TRIGGER_DECISION_TIMEOUT_MS ?? 4000,
    ),
    decisionMinConfidence: Number(
      config.decisionMinConfidence ?? process.env.CHAT_NATURAL_TRIGGER_DECISION_MIN_CONFIDENCE ?? 0.62,
    ),
  };
}

function normalizeMessageContent(session: Session): string {
  const stripped = session.stripped?.content?.trim();
  if (stripped) return stripped;
  return session.content?.trim() ?? '';
}

function isQuotedToBot(session: Session): boolean {
  const quote = session.quote as { user?: { id?: string } } | undefined;
  return Boolean(quote?.user?.id && quote.user.id === session.bot?.selfId);
}

async function shouldTriggerByModel(content: string, runtime: RuntimeConfig): Promise<boolean> {
  if (!runtime.decisionEnabled || !runtime.decisionBaseUrl || !runtime.decisionApiKey || !runtime.decisionModel) {
    return false;
  }

  const systemPrompt =
    '你是群聊机器人触发判定器。仅输出 JSON：{"trigger":true|false,"confidence":0~1}。' +
    '当用户在和机器人说话、向机器人提问、或明确希望机器人响应时 trigger=true；否则 false。';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.decisionTimeoutMs);

  try {
    const response = await fetch(`${runtime.decisionBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runtime.decisionApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: runtime.decisionModel,
        max_tokens: 120,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `机器人别名: ${runtime.aliases.join(', ')}\n消息: ${content}`,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) return false;

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };

    const rawContent = payload.choices?.[0]?.message?.content;
    const contentText = Array.isArray(rawContent)
      ? rawContent
          .map((item) => (typeof item?.text === 'string' ? item.text : ''))
          .join('')
          .trim()
      : typeof rawContent === 'string'
        ? rawContent.trim()
        : '';

    if (!contentText) return false;

    const jsonText = extractJsonObject(contentText);
    if (!jsonText) return false;

    const parsed = JSON.parse(jsonText) as ModelDecisionResponse;
    const confidence = Number(parsed.confidence ?? 0);
    if (!Number.isFinite(confidence) || confidence < runtime.decisionMinConfidence) return false;

    return Boolean(parsed.trigger);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function buildSpamKey(session: Session): string {
  return `${session.channelId ?? ''}:${session.userId ?? ''}`;
}

function shouldHandleGroup(session: Session, runtime: RuntimeConfig): boolean {
  if (session.isDirect) return false;
  const groupId = normalizeGroupId(session.guildId) ?? normalizeGroupId(session.channelId);
  if (!groupId) return false;
  if (!runtime.enabledGroups.size) return true;
  return runtime.enabledGroups.has(groupId);
}

export function apply(ctx: Context, config: Config): void {
  const runtime = toRuntimeConfig(config);
  const focusExpires = new Map<string, number>();
  const spamStates = new Map<string, SpamState>();
  let lastReplyAt = 0;

  ctx.middleware(async (session, next) => {
    if (!runtime.enabled) return next();
    if (!session.userId || !session.content || session.userId === session.bot?.selfId) return next();
    if (!shouldHandleGroup(session, runtime)) return next();

    const content = normalizeMessageContent(session);
    if (!content) return next();

    const now = Date.now();
    const spamKey = buildSpamKey(session);
    const spamState = spamStates.get(spamKey) ?? createEmptySpamState();
    const spamResult = recordSpamMessage(spamState, now, {
      windowMs: runtime.spamWindowMs,
      threshold: runtime.spamThreshold,
      muteMs: runtime.spamMuteMs,
    });
    spamStates.set(spamKey, spamResult.state);

    if (spamResult.muted) {
      if (spamResult.justMuted) {
        logger.info('mute spam user for %d ms: channel=%s user=%s', runtime.spamMuteMs, session.channelId, session.userId);
      }
      return;
    }

    const directHit = Math.random() < runtime.directTriggerProbability;
    const focusUntil = focusExpires.get(spamKey) ?? 0;
    const inFocus = focusUntil > now;

    let shouldTrigger = directHit;

    if (!shouldTrigger) {
      shouldTrigger = shouldTriggerByRule(content, runtime.aliases, isQuotedToBot(session));
    }

    if (!shouldTrigger && !inFocus) {
      shouldTrigger = await shouldTriggerByModel(content, runtime);
    } else if (!shouldTrigger && inFocus) {
      shouldTrigger = true;
    }

    if (!shouldTrigger) return next();

    if (now - lastReplyAt < runtime.replyIntervalMs) {
      return;
    }

    lastReplyAt = now;
    focusExpires.set(spamKey, now + runtime.focusWindowMs);

    const triggerName = runtime.aliases[0] ?? '祥子';
    const originalContent = session.content;
    const stripped = session.stripped as { content?: string } | undefined;
    const originalStripped = stripped?.content;

    session.content = `${triggerName} ${content}`;
    if (stripped && typeof stripped.content === 'string') {
      stripped.content = `${triggerName} ${stripped.content}`;
    }

    try {
      return await next();
    } finally {
      session.content = originalContent;
      if (stripped && typeof originalStripped === 'string') {
        stripped.content = originalStripped;
      }
    }
  });

  ctx.on('ready', () => {
    logger.info(
      'group natural trigger loaded: groups=%d, aliases=%d, direct=%s, focusWindowMs=%d, replyIntervalMs=%d, spam=%d/%dms mute=%dms',
      runtime.enabledGroups.size,
      runtime.aliases.length,
      runtime.directTriggerProbability.toFixed(2),
      runtime.focusWindowMs,
      runtime.replyIntervalMs,
      runtime.spamThreshold,
      runtime.spamWindowMs,
      runtime.spamMuteMs,
    );
  });
}
