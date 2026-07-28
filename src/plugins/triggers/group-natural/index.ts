import { Context, Logger, Schema, Session } from 'koishi';
import { buildGroupSessionScopeKey, normalizeGroupId } from '../../shared/group-id.js';
import type { ModelRuntimeClient } from '../../model-config/index.js';
import type {
  NaturalTriggerConfig,
  NaturalTriggerConfigService,
} from '../../natural-trigger-config/index.js';
import {
  containsAlias,
  createEmptySpamState,
  recordSpamMessage,
  shouldTriggerByHeuristic,
  type SpamState,
} from './matcher.js';
import {
  getNaturalTriggerState,
  setNaturalTriggerState,
  type NaturalTriggerReason,
  type NaturalTriggerState,
} from './state.js';

const logger = new Logger('group-natural-trigger');
const allowReplyResolverName = 'group-natural-trigger';
const STATE_CLEANUP_INTERVAL_MS = 60_000;

export const name = 'group-natural-trigger';
export const inject = {
  required: ['chatluna', 'modelRuntime', 'naturalTriggerConfig'],
} as const;
export const Config = Schema.object({});

export {
  getNaturalTriggerState,
  setNaturalTriggerState,
  type NaturalTriggerReason,
  type NaturalTriggerState,
} from './state.js';

interface ModelDecisionResponse {
  trigger?: boolean;
  confidence?: number;
}

interface TriggerDecisionResult {
  trigger: boolean;
  confidence: number | null;
  rawContent: string | null;
}

type NaturalTriggerContext = Context & {
  naturalTriggerConfig?: NaturalTriggerConfigService;
  modelRuntime?: ModelRuntimeClient;
  chatluna?: {
    registerAllowReplyResolver?: (
      name: string,
      resolver: (arg: { session: Session; context: unknown }) => boolean | void | Promise<boolean | void>,
    ) => () => void;
  };
};

export class GroupReplyScheduler {
  private readonly nextReplyAt = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  async reserve(groupScopeKey: string, intervalMs: number): Promise<number> {
    const previous = this.tails.get(groupScopeKey) ?? Promise.resolve();
    const reservation = previous.then(async () => {
      const delay = Math.max(0, (this.nextReplyAt.get(groupScopeKey) ?? 0) - this.now());
      if (delay > 0) await this.wait(delay);
      const handlingAt = this.now();
      this.nextReplyAt.set(groupScopeKey, handlingAt + intervalMs);
    });
    this.tails.set(groupScopeKey, reservation);
    try {
      await reservation;
      return this.nextReplyAt.get(groupScopeKey)! - intervalMs;
    } finally {
      if (this.tails.get(groupScopeKey) === reservation) {
        this.tails.delete(groupScopeKey);
      }
    }
  }

  cleanup(now = this.now()): void {
    for (const [key, expiresAt] of this.nextReplyAt) {
      if (expiresAt <= now && !this.tails.has(key)) this.nextReplyAt.delete(key);
    }
  }

  get stateSize(): number {
    return this.nextReplyAt.size + this.tails.size;
  }
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
  config: NaturalTriggerConfig,
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
    if (!Number.isFinite(confidence) || confidence < config.modelDecision.minConfidence) {
      return {
        trigger: false,
        confidence: Number.isFinite(confidence) ? confidence : null,
        rawContent: contentText,
      };
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

function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) ?? raw.match(/```\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : null;
}

function normalizeMessageContent(session: Session): string {
  const stripped = session.stripped?.content?.trim();
  if (stripped) return stripped;
  return session.content?.trim() ?? '';
}

function hasImageInput(session: Session): boolean {
  const elements = Array.isArray(session.elements) ? session.elements : [];
  if (elements.some((element) => {
    const type = typeof element?.type === 'string' ? element.type.toLowerCase() : '';
    return type === 'img' || type === 'image';
  })) {
    return true;
  }
  const rawContent = String(session.content ?? '');
  return /<img\b/i.test(rawContent) || /\[CQ:image,[^\]]+\]/i.test(rawContent);
}

function isQuotedToBot(session: Session): boolean {
  const quote = session.quote as { user?: { id?: string } } | undefined;
  return Boolean(quote?.user?.id && quote.user.id === session.bot?.selfId);
}

function resolveGroupId(session: Session): string | null {
  return normalizeGroupId(session.guildId) ?? normalizeGroupId(session.channelId);
}

export function naturalTriggerAllowsGroup(
  session: Pick<Session, 'isDirect' | 'guildId' | 'channelId'>,
  config: NaturalTriggerConfig,
): boolean {
  if (!config.enabled || session.isDirect) return false;
  const groupId = normalizeGroupId(session.guildId) ?? normalizeGroupId(session.channelId);
  return Boolean(groupId && config.allowedGroupIds.includes(groupId));
}

function buildSpamKey(groupScopeKey: string, session: Session): string {
  return `${groupScopeKey}:user:${session.userId ?? ''}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function apply(ctx: Context): void {
  const serviceCtx = ctx as NaturalTriggerContext;
  const configService = serviceCtx.naturalTriggerConfig;
  const modelRuntime = serviceCtx.modelRuntime;
  const chatluna = serviceCtx.chatluna;
  const registerAllowReplyResolver = chatluna?.registerAllowReplyResolver;
  if (!configService) throw new Error('group-natural-trigger requires naturalTriggerConfig service.');
  if (!modelRuntime) throw new Error('group-natural-trigger requires modelRuntime service.');
  if (!chatluna || typeof registerAllowReplyResolver !== 'function') {
    throw new Error('group-natural-trigger requires chatluna.registerAllowReplyResolver.');
  }
  const runtime = configService.getRuntimeSnapshot();
  const config = runtime.config;
  const focusExpires = new Map<string, number>();
  const spamStates = new Map<string, SpamState>();
  const scheduler = new GroupReplyScheduler();
  let disposeAllowReplyResolver: (() => void) | null = null;

  const ensureAllowReplyResolverRegistered = (): void => {
    if (disposeAllowReplyResolver) return;
    disposeAllowReplyResolver = registerAllowReplyResolver.call(
      chatluna,
      allowReplyResolverName,
      ({ session }) => {
        const naturalTrigger = getNaturalTriggerState(
          session as unknown as Record<string, unknown>,
        );
        if (!naturalTrigger) return;
        logger.info(
          'natural trigger allow resolver hit: channel=%s user=%s reason=%s explicit=%s',
          session.channelId,
          session.userId,
          naturalTrigger.reason,
          String(naturalTrigger.explicit),
        );
        return true;
      },
    );
  };

  ctx.middleware(async (session, next) => {
    if (!session.userId || session.userId === session.bot?.selfId) return next();
    if (!naturalTriggerAllowsGroup(session, config)) return next();
    const content = normalizeMessageContent(session);
    const imageInput = hasImageInput(session);
    if (!content && !imageInput) return next();
    const groupScopeKey = buildGroupSessionScopeKey(session);
    if (!groupScopeKey) return next();
    const now = Date.now();

    if (config.antiSpam.enabled) {
      const spamKey = buildSpamKey(groupScopeKey, session);
      const spamResult = recordSpamMessage(
        spamStates.get(spamKey) ?? createEmptySpamState(),
        now,
        {
          windowMs: config.antiSpam.windowMs,
          threshold: config.antiSpam.threshold,
          muteMs: config.antiSpam.muteMs,
        },
      );
      spamStates.set(spamKey, spamResult.state);
      if (spamResult.muted) {
        if (spamResult.justMuted) {
          logger.info(
            'mute natural trigger for spam user: channel=%s user=%s durationMs=%d',
            session.channelId,
            session.userId,
            config.antiSpam.muteMs,
          );
        }
        return next();
      }
    }

    const quotedToBot = isQuotedToBot(session);
    const aliases = config.mechanisms.alias.aliases;
    const hasAlias = content && config.mechanisms.alias.enabled
      ? containsAlias(content, aliases)
      : false;
    const focusUntil = focusExpires.get(groupScopeKey) ?? 0;
    let reason: NaturalTriggerReason | null = null;

    if (config.mechanisms.quote.enabled && quotedToBot && (content || imageInput)) {
      reason = 'quote';
    } else if (hasAlias) {
      reason = 'alias';
    } else if (
      config.mechanisms.heuristic.enabled
      && content
      && shouldTriggerByHeuristic(content)
    ) {
      reason = 'rule';
    } else if (config.mechanisms.focus.enabled && focusUntil > now) {
      reason = 'focus';
    } else if (content) {
      const modelDecision = await shouldTriggerByModel(content, config, modelRuntime);
      if (modelDecision.trigger) reason = 'model';
    }
    if (
      !reason
      && config.mechanisms.random.enabled
      && Math.random() < config.mechanisms.random.probability
    ) {
      reason = 'direct';
    }
    if (!reason) return next();

    const handlingAt = await scheduler.reserve(
      groupScopeKey,
      config.pacing.minReplyIntervalMs,
    );
    if (config.mechanisms.focus.enabled) {
      focusExpires.set(groupScopeKey, handlingAt + config.mechanisms.focus.windowMs);
    }
    const naturalTrigger: NaturalTriggerState = {
      reason,
      explicit: reason === 'quote' || reason === 'alias' || reason === 'rule',
    };
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

  ctx.setInterval(() => {
    const now = Date.now();
    for (const [key, expiresAt] of focusExpires) {
      if (expiresAt <= now) focusExpires.delete(key);
    }
    for (const [key, state] of spamStates) {
      const latest = state.timestamps.at(-1) ?? 0;
      if (state.mutedUntil <= now && latest + config.antiSpam.windowMs <= now) {
        spamStates.delete(key);
      }
    }
    scheduler.cleanup(now);
  }, STATE_CLEANUP_INTERVAL_MS);

  ctx.on('ready', () => {
    ensureAllowReplyResolverRegistered();
    logger.info(
      'group natural trigger loaded: revision=%d groups=%d aliases=%d',
      runtime.revision,
      config.allowedGroupIds.length,
      config.mechanisms.alias.aliases.length,
    );
  });
  ctx.on('dispose', () => {
    disposeAllowReplyResolver?.();
    disposeAllowReplyResolver = null;
  });
}
