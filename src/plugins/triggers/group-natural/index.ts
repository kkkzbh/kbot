import { Context, Logger, Schema, Session } from 'koishi';
import type { FeaturePolicyServiceLike } from '../../../types/feature-policy.js';
import { buildGroupSessionScopeKey, normalizeGroupId, parseGroupSet } from '../../shared/group-id.js';
import {
  containsAlias,
  createEmptySpamState,
  parseAliasList,
  recordSpamMessage,
  shouldTriggerByRule,
  type SpamState,
} from './matcher.js';
import {
  getNaturalTriggerState,
  setNaturalTriggerState,
  type NaturalTriggerReason,
  type NaturalTriggerState,
} from './state.js';
import type { ModelRuntimeClient } from '../../model-config/index.js';

const logger = new Logger('group-natural-trigger');
const allowReplyResolverName = 'group-natural-trigger';

export const name = 'group-natural-trigger';
export const inject = {
  required: ['chatluna', 'featurePolicy', 'modelRuntime'],
} as const;
export {
  getNaturalTriggerState,
  setNaturalTriggerState,
  type NaturalTriggerReason,
  type NaturalTriggerState,
} from './state.js';

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
  decisionMinConfidence?: number;
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().description('是否启用群聊自然触发。'),
  enabledGroups: Schema.union([
    Schema.array(Schema.string()).role('table').description('启用自然触发的白名单群号列表。留空表示不在任何群自动触发。'),
    Schema.string().description('启用自然触发的白名单群号（逗号分隔，留空表示不在任何群自动触发）。'),
  ]),
  aliases: Schema.union([
    Schema.array(Schema.string()).role('table').description('可触发机器人对话的称呼列表。'),
    Schema.string().description('可触发机器人对话的称呼（逗号分隔）。'),
  ]),
  directTriggerProbability: Schema.number()
    .min(0)
    .max(1)
    .description('任意消息直接触发回复的概率。'),
  focusWindowMs: Schema.natural().role('time').description('会话焦点窗口（毫秒）。'),
  replyIntervalMs: Schema.natural().role('time').description('机器人两次回复最小时间间隔（毫秒）。'),
  spamWindowMs: Schema.natural().role('time').description('刷屏判定窗口（毫秒）。'),
  spamThreshold: Schema.natural().description('刷屏判定阈值（窗口内消息数）。'),
  spamMuteMs: Schema.natural().role('time').description('刷屏后忽略时长（毫秒）。'),
  decisionMinConfidence: Schema.number().min(0).max(1).description('触发判定模型最小置信度。'),
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
  decisionMinConfidence: number;
}

interface ModelDecisionResponse {
  trigger?: boolean;
  confidence?: number;
}

interface TriggerDecisionResult {
  trigger: boolean;
  confidence: number | null;
  rawContent: string | null;
}

type ContextWithFeaturePolicy = Context & {
  featurePolicy?: FeaturePolicyServiceLike;
  modelRuntime?: ModelRuntimeClient;
  chatluna?: {
    registerAllowReplyResolver?: (
      name: string,
      resolver: (arg: { session: Session; context: unknown }) => boolean | void | Promise<boolean | void>,
    ) => () => void;
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) ?? raw.match(/```\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return null;
}

function requireConfigValue<T>(config: Config, key: keyof Config): NonNullable<T> {
  const value = config[key] as T | null | undefined;
  if (value == null) {
    throw new Error(`群聊自然触发配置缺失：${String(key)}。默认值必须由 koishi.yml 显式传入。`);
  }
  return value as NonNullable<T>;
}

function requireBooleanConfig(config: Config, key: keyof Config): boolean {
  const value = requireConfigValue<unknown>(config, key);
  if (typeof value !== 'boolean') {
    throw new Error(`群聊自然触发配置 ${String(key)} 必须是 boolean。`);
  }
  return value;
}

function requireNumberConfig(config: Config, key: keyof Config, options: { min?: number; max?: number } = {}): number {
  const value = Number(requireConfigValue<unknown>(config, key));
  if (!Number.isFinite(value)) {
    throw new Error(`群聊自然触发配置 ${String(key)} 必须是有效数字。`);
  }
  if (options.min != null && value < options.min) {
    throw new Error(`群聊自然触发配置 ${String(key)} 不能小于 ${options.min}。`);
  }
  if (options.max != null && value > options.max) {
    throw new Error(`群聊自然触发配置 ${String(key)} 不能大于 ${options.max}。`);
  }
  return value;
}

function toRuntimeConfig(config: Config): RuntimeConfig {
  const configuredAliases = parseAliasList(requireConfigValue<string[] | string>(config, 'aliases'));
  const configuredGroups = parseGroupSet(requireConfigValue<string[] | string>(config, 'enabledGroups'));
  const directTriggerProbability = requireNumberConfig(config, 'directTriggerProbability', { min: 0, max: 1 });
  return {
    enabled: requireBooleanConfig(config, 'enabled'),
    enabledGroups: configuredGroups,
    aliases: configuredAliases,
    directTriggerProbability,
    focusWindowMs: requireNumberConfig(config, 'focusWindowMs', { min: 0 }),
    replyIntervalMs: requireNumberConfig(config, 'replyIntervalMs', { min: 0 }),
    spamWindowMs: requireNumberConfig(config, 'spamWindowMs', { min: 0 }),
    spamThreshold: requireNumberConfig(config, 'spamThreshold', { min: 1 }),
    spamMuteMs: requireNumberConfig(config, 'spamMuteMs', { min: 0 }),
    decisionMinConfidence: requireNumberConfig(config, 'decisionMinConfidence', { min: 0, max: 1 }),
  };
}

function normalizeMessageContent(session: Session): string {
  const stripped = session.stripped?.content?.trim();
  if (stripped) return stripped;
  return session.content?.trim() ?? '';
}

function hasImageInput(session: Session): boolean {
  const elements = Array.isArray(session.elements) ? session.elements : [];
  if (
    elements.some((element) => {
      const type = typeof element?.type === 'string' ? element.type.toLowerCase() : '';
      return type === 'img' || type === 'image';
    })
  ) {
    return true;
  }

  const rawContent = String(session.content ?? '');
  return /<img\b/i.test(rawContent) || /\[CQ:image,[^\]]+\]/i.test(rawContent);
}

function isQuotedToBot(session: Session): boolean {
  const quote = session.quote as { user?: { id?: string } } | undefined;
  return Boolean(quote?.user?.id && quote.user.id === session.bot?.selfId);
}

const NATURAL_TRIGGER_DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['trigger', 'confidence'],
  properties: {
    trigger: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

async function shouldTriggerByModel(
  content: string,
  runtime: RuntimeConfig,
  modelRuntime: ModelRuntimeClient,
): Promise<TriggerDecisionResult> {
  const binding = modelRuntime.resolve('naturalTrigger.decision');
  if (!binding.target) {
    return { trigger: false, confidence: null, rawContent: null };
  }

  const systemPrompt =
    '你是群聊机器人触发判定器。仅输出 JSON：{"trigger":true|false,"confidence":0~1}。' +
    '当用户在和机器人说话、向机器人提问、或明确希望机器人响应时 trigger=true；否则 false。';

  try {
    const response = await modelRuntime.executeChat({
      workload: 'naturalTrigger.decision',
      request: {
        maxOutputTokens: 120,
        structuredOutput: {
          name: 'natural_trigger_decision',
          schema: NATURAL_TRIGGER_DECISION_SCHEMA,
          strict: true,
        },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `消息: ${content}` },
        ],
      },
    });
    const contentText = response.text.trim();
    if (!contentText) return { trigger: false, confidence: null, rawContent: null };

    const jsonText = extractJsonObject(contentText);
    if (!jsonText) return { trigger: false, confidence: null, rawContent: contentText };

    const parsed = JSON.parse(jsonText) as ModelDecisionResponse;
    const confidence = Number(parsed.confidence ?? 0);
    if (!Number.isFinite(confidence) || confidence < runtime.decisionMinConfidence) {
      return { trigger: false, confidence: Number.isFinite(confidence) ? confidence : null, rawContent: contentText };
    }

    return {
      trigger: Boolean(parsed.trigger),
      confidence,
      rawContent: contentText,
    };
  } catch (error) {
    logger.warn(
      'natural trigger model decision failed: %s',
      error instanceof Error ? error.message : String(error),
    );
    return { trigger: false, confidence: null, rawContent: null };
  }
}

function buildSpamKey(groupScopeKey: string, session: Session): string {
  return `${groupScopeKey}:user:${session.userId ?? ''}`;
}

function resolveGroupId(session: Session): string | null {
  return normalizeGroupId(session.guildId) ?? normalizeGroupId(session.channelId);
}

function buildNaturalTriggerGroupScopeKey(session: Session): string | null {
  return buildGroupSessionScopeKey(session);
}

function shouldHandleGroup(session: Session, runtime: RuntimeConfig): boolean {
  if (session.isDirect) return false;
  const groupId = resolveGroupId(session);
  if (!groupId) return false;
  if (!runtime.enabledGroups.size) return false;
  return runtime.enabledGroups.has(groupId);
}

export function apply(ctx: Context, config: Config): void {
  const runtime = toRuntimeConfig(config);
  const serviceCtx = ctx as ContextWithFeaturePolicy;
  const featurePolicy = serviceCtx.featurePolicy;
  if (!featurePolicy) {
    throw new Error('group-natural-trigger requires featurePolicy service.');
  }
  const modelRuntime = serviceCtx.modelRuntime;
  if (!modelRuntime) {
    throw new Error('group-natural-trigger requires modelRuntime service.');
  }
  const chatluna = serviceCtx.chatluna;
  const registerAllowReplyResolver = chatluna?.registerAllowReplyResolver;
  if (!chatluna || typeof registerAllowReplyResolver !== 'function') {
    throw new Error('group-natural-trigger requires chatluna.registerAllowReplyResolver.');
  }
  const focusExpires = new Map<string, number>();
  const spamStates = new Map<string, SpamState>();
  const nextReplyAt = new Map<string, number>();
  let disposeAllowReplyResolver: (() => void) | null = null;

  const ensureAllowReplyResolverRegistered = (): void => {
    if (disposeAllowReplyResolver) return;
    disposeAllowReplyResolver = registerAllowReplyResolver.call(chatluna, allowReplyResolverName, ({ session }) => {
      const naturalTrigger = getNaturalTriggerState(session as unknown as Record<string, unknown>);
      if (!naturalTrigger) return;
      logger.info(
        'natural trigger allow resolver hit: channel=%s user=%s reason=%s explicit=%s',
        session.channelId,
        session.userId,
        naturalTrigger.reason,
        String(naturalTrigger.explicit),
      );
      return true;
    });
    logger.info('natural trigger allow resolver registered.');
  };

  ctx.middleware(async (session, next) => {
    if (!runtime.enabled) return next();
    if (!(await featurePolicy.resolveFeatureEnabled(session, 'CHAT_NATURAL_TRIGGER_ENABLED'))) {
      return next();
    }
    if (!session.userId || session.userId === session.bot?.selfId) return next();
    if (!shouldHandleGroup(session, runtime)) return next();

    const content = normalizeMessageContent(session);
    const imageInput = hasImageInput(session);
    if (!content && !imageInput) return next();

    const groupScopeKey = buildNaturalTriggerGroupScopeKey(session);
    if (!groupScopeKey) return next();
    const now = Date.now();
    const spamKey = buildSpamKey(groupScopeKey, session);
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
    const focusUntil = focusExpires.get(groupScopeKey) ?? 0;
    const inFocus = focusUntil > now;
    const quotedToBot = isQuotedToBot(session);
    const hasAlias = content ? containsAlias(content, runtime.aliases) : false;
    const ruleTriggered = content ? shouldTriggerByRule(content, runtime.aliases, quotedToBot) : quotedToBot && imageInput;
    let triggerReason: NaturalTriggerReason | null = directHit ? 'direct' : null;
    let explicitTrigger = false;
    let modelDecision: TriggerDecisionResult | null = null;

    let shouldTrigger = directHit;

    if (!shouldTrigger) {
      shouldTrigger = ruleTriggered;
      if (shouldTrigger) {
        if (quotedToBot) {
          triggerReason = 'quote';
        } else if (hasAlias) {
          triggerReason = 'alias';
        } else {
          triggerReason = 'rule';
        }
        explicitTrigger = true;
      }
    }

    if (!shouldTrigger && !inFocus && content) {
      modelDecision = await shouldTriggerByModel(content, runtime, modelRuntime);
      shouldTrigger = modelDecision.trigger;
      if (shouldTrigger) {
        triggerReason = 'model';
        explicitTrigger = false;
      }
    } else if (!shouldTrigger && inFocus) {
      shouldTrigger = true;
      triggerReason = 'focus';
      explicitTrigger = false;
    }

    if (!shouldTrigger) return next();

    const naturalTrigger: NaturalTriggerState = {
      reason: triggerReason ?? 'direct',
      explicit: explicitTrigger,
    };

    const replyReadyAt = nextReplyAt.get(groupScopeKey) ?? 0;
    if (replyReadyAt > now) {
      await sleep(replyReadyAt - now);
    }

    const handlingAt = Date.now();
    nextReplyAt.set(groupScopeKey, handlingAt + runtime.replyIntervalMs);
    focusExpires.set(groupScopeKey, handlingAt + runtime.focusWindowMs);

    try {
      setNaturalTriggerState(session as unknown as Record<string, unknown>, naturalTrigger);
      logger.info(
        'natural trigger decision hit: channel=%s user=%s reason=%s explicit=%s',
        session.channelId,
        session.userId,
        naturalTrigger.reason,
        String(naturalTrigger.explicit),
      );
      return await next();
    } finally {
      setNaturalTriggerState(session as unknown as Record<string, unknown>, null);
    }
  });

  ctx.on('ready', () => {
    ensureAllowReplyResolverRegistered();
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

  ctx.on('dispose', () => {
    if (disposeAllowReplyResolver) {
      disposeAllowReplyResolver();
      disposeAllowReplyResolver = null;
    }
  });
}
