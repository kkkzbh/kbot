import { randomUUID } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';
import { Logger, type Context, type Session } from 'koishi';
import {
  CanonicalModelBindingResolver,
  serializeModelConfigDiagnostic,
  type ModelConfigService,
  type ModelRuntimeClient,
  type ResolvedModelTarget,
} from '../model-config/index.js';
import { registerPromptFragment } from '../shared/prompt-context/index.js';
import {
  createChatLunaHistoryWriter,
  type ChatLunaHistoryServiceLike,
  type ChatLunaHistoryWriter,
} from '../shared/chatluna-history.js';
import type { ReplyTransportPlan } from '../shared/outbound/index.js';
import type { ToolMask } from '../../types/tool-policy.js';
import { normalizeMentionLikeText } from '../shared/mention-text.js';
import { resolveSessionDisplayName } from '../shared/session/index.js';
import { decodeStoredMessageText } from '../shared/stored-message.js';
import { buildGroupScopeKey, realtimeMessageCache } from '../realtime-message/index.js';
import {
  createVoiceRuntimeConfigFromEnv,
  deliverStandaloneReplyPlan,
  type RuntimeConfig as ReplyVoiceRuntimeConfig,
} from '../reply/index.js';
import { resolveStickerCapabilityArtifacts } from '../sticker/index.js';
import type {
  AffinityAuditRecord,
  AffinityConfigRecord,
  AffinityEffectTier,
  AffinityEventType,
  AffinityEventRecord,
  AffinityManualRandomPlanInput,
  AffinityManualRandomPlanResponse,
  AffinityPanelHistorySyncResult,
  AffinityMutationResponse,
  AffinityPanelView,
  AffinityRandomDirection,
  AffinityRandomMemoryRecord,
  AffinityRandomPlanRecord,
  AffinityScopeConfigRecord,
  AffinityScopeKind,
  AffinityServiceLike,
  AffinitySettings,
  AffinityStateSummary,
  AffinityUserStateRecord,
  AffinityWhitelistInput,
} from '../../types/affinity.js';
import {
  analyzeAffinityEvent,
} from './analysis.js';
import {
  CHARACTER_ID,
  DEFAULT_RANDOM_COUNT_WEIGHTS,
  DEFAULT_RANDOM_DIRECTIONS,
  applyTemporalDecay,
  createInitialState,
  createRandomScheduleTimes,
  formatStateForPrompt,
  getShanghaiDayStartMs,
  getShanghaiDayKey,
  pickRandomDirection,
  resolveAffinityEvent,
  selectRandomCount,
  stateFromRecord,
  type AffinityEventAnalysis,
  type AffinityStateInput,
} from './rules.js';
import { fetchWebHotTopicSummary } from './web-source.js';
import { materialToPromptText, pickRandomMaterial } from './random-materials.js';
import { buildAffinityPanelView } from './panel.js';
import {
  type AffinityRandomContextTurn,
  type AffinityRandomGenerationInput,
  type AffinityRandomGenerationResult,
  type AffinityRandomMemoryItem,
} from './proactive-types.js';
import {
  generateAffinityProactiveViaChatLuna,
  type AffinityProactiveChatLunaConversation,
  type AffinityProactiveGenerationResult,
} from './proactive-chatluna.js';
import { proactiveDirectionUsesConversationContext } from './proactive-task.js';

const logger = new Logger('affinity');
const INVISIBLE_OR_CONTROL_TEXT_PATTERN = /[\p{Cf}\p{Cc}\p{Cs}]/gu;

export type AffinityDatabaseLike = {
  get(table: string, query: Record<string, unknown>): Promise<any[]>;
  set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<unknown>;
  create(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>>;
  remove(table: string, query: Record<string, unknown>): Promise<unknown>;
  upsert: (table: string, rows: Record<string, unknown>[], keys?: string[]) => Promise<unknown>;
};

type AffinityBotLike = {
  selfId?: string;
  platform?: string;
  sendMessage: (channelId: string, content: unknown, guildId?: string, options?: unknown) => Promise<unknown>;
  session?: (event?: Record<string, unknown>) => Session;
};

type ChatLunaConversationRecord = {
  id: string;
  seq?: number | null;
  bindingKey?: string | null;
  title?: string | null;
  preset?: string | null;
  model?: string | null;
  chatMode?: string | null;
  createdBy?: string | null;
  createdAt?: Date | number | string | null;
  updatedAt?: Date | number | string | null;
  lastChatAt?: Date | number | string | null;
  status?: string | null;
  latestMessageId?: string | null;
  additional_kwargs?: string | null;
  compression?: string | null;
  archivedAt?: Date | number | string | null;
  archiveId?: string | null;
  autoTitle?: boolean | number | null;
};

type ChatLunaHistoryLike = ChatLunaHistoryServiceLike & {
  chat?: (
    session: Session,
    conversation: AffinityProactiveChatLunaConversation,
    message: { content?: unknown; additional_kwargs?: Record<string, unknown> },
    options?: {
      event?: Record<string, unknown>;
      stream?: boolean;
      variables?: Record<string, unknown>;
      requestId?: string;
      toolMask: ToolMask;
    },
  ) => Promise<{ content?: unknown; additional_kwargs?: Record<string, unknown> } | null | undefined>;
  contextManager?: {
    inject: (options: {
      name: string;
      value: unknown;
      once?: boolean;
      conversationId?: string;
      stage?: string;
    }) => void;
  };
};

type ProactiveVoiceRuntimeProvider = () => ReplyVoiceRuntimeConfig;

type ChatHistoryWriterResolution =
  | {
      ok: true;
      conversationId: string;
      addMessages: ChatLunaHistoryWriter['addMessages'];
    }
  | {
      ok: false;
      reason: string;
      conversationId?: string;
    };

type ConversationMessageRow = {
  id: string;
  role?: string | null;
  parentId?: string | null;
  content?: unknown;
  createdAt?: Date | number | string | null;
};

type OpenThreadSummary = {
  id?: number;
  title?: string;
  summary?: string;
  payloadJson?: string | null;
  expiresAt?: number;
  randomPayload?: RandomThreadPayload;
};

type RandomThreadPayload = {
  planId: number;
  direction: AffinityRandomDirection;
  contextSeedSummary: string | null;
  eventTypeHint: AffinityEventType | 'none';
  reason: string;
};

type ActiveProactiveThreadPromptState = {
  direction: AffinityRandomDirection;
  message: string;
  contextSummary: string | null;
  eventTypeHint: AffinityEventType | 'none';
};

type AffinityPromptEventResult = {
  eventType: AffinityEventType;
  effectTier: AffinityEffectTier;
  replyHint: string | null;
};

type RandomGenerationWithTransport = AffinityRandomGenerationResult & {
  transportPlan?: ReplyTransportPlan | null;
  deliveryHistoryText?: string | null;
};

type RandomDeliveryResult =
  | {
      sent: true;
      messageText: string;
      historyText: string;
      receipts: string[][];
      reason: 'failed_after_partial_send' | null;
    }
  | {
      sent: false;
      messageText: null;
      historyText: string | null;
      receipts: string[][];
      reason: string;
    };

type AffinityConfirmedDeliveryPayload = {
  version: 'v1';
  messageText: string;
  historyText: string;
  materialJson: string | null;
  generation: {
    contextSeedSummary: string | null;
    eventTypeHint: AffinityEventType | 'none';
    memorySummary: string | null;
    reason: string;
    risk: 'low' | 'medium' | 'high';
    outputProtocol: string | null;
  };
};

type ProactiveSourceConversationResolution =
  | {
      sourceConversation: ChatLunaConversationRecord;
      skipReason: null;
    }
  | {
      sourceConversation: null;
      skipReason: string;
    };

const RANDOM_MEMORY_TTL_MS = 45 * 24 * 60 * 60 * 1000;
const RANDOM_OPEN_THREAD_TTL_MS = 3 * 60 * 60 * 1000;
const RANDOM_TRANSPORT_RETRY_DELAY_MS = 10 * 60 * 1000;
const RECENT_CONTEXT_LIMIT = 18;
const RECENT_MEMORY_LIMIT = 12;

export interface RuntimeConfig {
  enabled: boolean;
  proactiveEnabled: boolean;
  pollIntervalMs: number;
  randomWindowStartHour: number;
  randomWindowEndHour: number;
  randomCountWeights: [number, number, number, number];
  enabledDirections: AffinityRandomDirection[];
  webSourceEnabled: boolean;
}

export interface AffinitySessionResult {
  shouldAllowReply: boolean;
  analysis: AffinityEventAnalysis;
}

const DEFAULT_SETTINGS: AffinitySettings = {
  enabled: true,
  proactiveEnabled: true,
  randomWindowStartHour: 8,
  randomWindowEndHour: 22,
  randomCountWeights: [...DEFAULT_RANDOM_COUNT_WEIGHTS],
  enabledDirections: [...DEFAULT_RANDOM_DIRECTIONS],
  webSourceEnabled: false,
};

const SESSION_RESULT_KEY = Symbol('qqbot-affinity-result');
const VALID_RANDOM_DIRECTIONS = new Set<AffinityRandomDirection>([
  'local_thread',
  'daily_greeting',
  'music_rehearsal',
  'contest_discussion',
  'computer_knowledge',
  'web_hot_topic',
  'relationship_scene',
]);
const VALID_EVENT_TYPE_HINTS = new Set<AffinityEventType | 'none'>([
  'none',
  'greeting_contextual',
  'offer_tea',
  'music_help',
  'care_subtle',
  'keep_promise',
  'boundary_respect',
  'light_tease',
  'contest_discussion',
  'computer_knowledge',
  'answer_random_prompt',
  'over_interaction',
  'pressure_or_spam',
  'promise_broken',
]);
function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function sanitizePromptMemoryText(value: unknown): string {
  return normalizeMentionLikeText(String(value ?? ''))
    .replace(/\[CQ:reply,[^\]]+\]/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/\[CQ:image,[^\]]+\]/gi, ' ')
    .replace(/<audio\b[^>]*\/?>/gi, ' ')
    .replace(/\[CQ:record,[^\]]+\]/gi, ' ')
    .replace(INVISIBLE_OR_CONTROL_TEXT_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseOptionalJsonArray(raw: string | null | undefined, label: string): unknown[] {
  if (raw == null) return [];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`${label} must contain JSON.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array.`);
  }
  return parsed;
}

function parseRequiredJsonRecord(raw: string | null | undefined, label: string): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`${label} must contain JSON.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseGeneratedJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}

function parseRandomThreadPayload(raw: string | null | undefined): RandomThreadPayload {
  const label = 'affinity_open_thread.payloadJson';
  const record = parseRequiredJsonRecord(raw, label);
  if (typeof record.planId !== 'number' || !Number.isInteger(record.planId) || record.planId <= 0) {
    throw new Error(`${label}.planId must be a positive integer.`);
  }
  if (typeof record.direction !== 'string' || !VALID_RANDOM_DIRECTIONS.has(record.direction as AffinityRandomDirection)) {
    throw new Error(`${label}.direction is invalid.`);
  }
  if (record.contextSeedSummary != null && typeof record.contextSeedSummary !== 'string') {
    throw new Error(`${label}.contextSeedSummary must be a string or null.`);
  }
  if (typeof record.eventTypeHint !== 'string' || !VALID_EVENT_TYPE_HINTS.has(record.eventTypeHint as AffinityEventType | 'none')) {
    throw new Error(`${label}.eventTypeHint is invalid.`);
  }
  if (typeof record.reason !== 'string' || !record.reason.trim()) {
    throw new Error(`${label}.reason must be a non-empty string.`);
  }
  return {
    planId: record.planId,
    direction: record.direction as AffinityRandomDirection,
    contextSeedSummary: record.contextSeedSummary ?? null,
    eventTypeHint: record.eventTypeHint as AffinityEventType | 'none',
    reason: record.reason,
  };
}

function activeProactiveThreadPromptState(thread: OpenThreadSummary): ActiveProactiveThreadPromptState {
  const payload = thread.randomPayload ?? parseRandomThreadPayload(thread.payloadJson);
  return {
    direction: payload.direction,
    message: thread.summary ?? '',
    contextSummary: payload.contextSeedSummary,
    eventTypeHint: payload.eventTypeHint,
  };
}

function affinityPromptEventResult(result: AffinitySessionResult): AffinityPromptEventResult {
  return {
    eventType: result.analysis.eventType,
    effectTier: result.analysis.effectTier,
    replyHint: result.analysis.replyHint,
  };
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseConfirmedDeliveryPayload(raw: string | null): AffinityConfirmedDeliveryPayload {
  const record = parseRequiredJsonRecord(raw, 'affinity_random_plan.deliveryPayloadJson');
  if (record.version !== 'v1') {
    throw new Error('affinity_random_plan.deliveryPayloadJson.version must be "v1".');
  }
  const messageText = normalizeText(record.messageText);
  const historyText = normalizeText(record.historyText);
  if (!messageText || !historyText) {
    throw new Error('affinity_random_plan.deliveryPayloadJson must contain delivered message text.');
  }
  if (record.materialJson != null && typeof record.materialJson !== 'string') {
    throw new Error('affinity_random_plan.deliveryPayloadJson.materialJson must be a string or null.');
  }
  const generation = record.generation;
  if (!generation || typeof generation !== 'object' || Array.isArray(generation)) {
    throw new Error('affinity_random_plan.deliveryPayloadJson.generation must be an object.');
  }
  const value = generation as Record<string, unknown>;
  if (value.contextSeedSummary != null && typeof value.contextSeedSummary !== 'string') {
    throw new Error('affinity_random_plan.deliveryPayloadJson.generation.contextSeedSummary is invalid.');
  }
  if (value.memorySummary != null && typeof value.memorySummary !== 'string') {
    throw new Error('affinity_random_plan.deliveryPayloadJson.generation.memorySummary is invalid.');
  }
  if (typeof value.eventTypeHint !== 'string' || !VALID_EVENT_TYPE_HINTS.has(value.eventTypeHint as AffinityEventType | 'none')) {
    throw new Error('affinity_random_plan.deliveryPayloadJson.generation.eventTypeHint is invalid.');
  }
  if (typeof value.reason !== 'string' || !value.reason.trim()) {
    throw new Error('affinity_random_plan.deliveryPayloadJson.generation.reason is invalid.');
  }
  if (value.risk !== 'low' && value.risk !== 'medium' && value.risk !== 'high') {
    throw new Error('affinity_random_plan.deliveryPayloadJson.generation.risk is invalid.');
  }
  if (value.outputProtocol != null && typeof value.outputProtocol !== 'string') {
    throw new Error('affinity_random_plan.deliveryPayloadJson.generation.outputProtocol is invalid.');
  }
  return {
    version: 'v1',
    messageText,
    historyText,
    materialJson: record.materialJson == null ? null : record.materialJson,
    generation: {
      contextSeedSummary: value.contextSeedSummary == null ? null : value.contextSeedSummary,
      eventTypeHint: value.eventTypeHint as AffinityEventType | 'none',
      memorySummary: value.memorySummary == null ? null : value.memorySummary,
      reason: value.reason.trim(),
      risk: value.risk,
      outputProtocol: value.outputProtocol == null ? null : value.outputProtocol,
    },
  };
}

function parseConfirmedDeliveryReceipts(raw: string | null): string[][] {
  if (!raw?.trim()) {
    throw new Error('affinity_random_plan.deliveryReceipt must contain JSON.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error('affinity_random_plan.deliveryReceipt must contain valid JSON.', { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('affinity_random_plan.deliveryReceipt must contain confirmed receipts.');
  }
  return parsed.map((receipt) => {
    if (!Array.isArray(receipt) || receipt.length === 0) {
      throw new Error('affinity_random_plan.deliveryReceipt contains an empty receipt.');
    }
    return receipt.map((messageId) => {
      if (typeof messageId !== 'string' || !messageId.trim()) {
        throw new Error('affinity_random_plan.deliveryReceipt contains an invalid message id.');
      }
      return messageId.trim();
    });
  });
}

function confirmedDeliveryGeneration(
  payload: AffinityConfirmedDeliveryPayload,
): AffinityRandomGenerationResult {
  return {
    shouldSend: true,
    message: payload.messageText,
    contextSeedSummary: payload.generation.contextSeedSummary,
    eventTypeHint: payload.generation.eventTypeHint,
    memorySummary: payload.generation.memorySummary,
    reason: payload.generation.reason,
    risk: payload.generation.risk,
    skipReason: null,
    outputProtocol: payload.generation.outputProtocol,
    deliveryHistoryText: payload.historyText,
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseStoredBooleanSetting(
  byKey: Map<string, string | null | undefined>,
  key: string,
  fallback: boolean,
): boolean {
  if (!byKey.has(key)) return fallback;
  const raw = byKey.get(key);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`affinity_config.${key} must be "true" or "false".`);
}

function parseStoredNumberSetting(
  byKey: Map<string, string | null | undefined>,
  key: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!byKey.has(key)) return fallback;
  const raw = byKey.get(key);
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`affinity_config.${key} must be a finite number.`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`affinity_config.${key} must be a finite number.`);
  }
  if (value < min || value > max) {
    throw new Error(`affinity_config.${key} must be between ${min} and ${max}.`);
  }
  return value;
}

function parseStoredJsonSetting(
  byKey: Map<string, string | null | undefined>,
  key: string,
  fallback: unknown,
): unknown {
  if (!byKey.has(key)) return fallback;
  const raw = byKey.get(key);
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`affinity_config.${key} must contain JSON.`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`affinity_config.${key} must contain valid JSON.`);
  }
}

function parseStoredWeightValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1.`);
  }
  return value;
}

function parseStoredRandomCountWeights(value: unknown): [number, number, number, number] {
  const label = 'affinity_config.randomCountWeights';
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`${label} must be an array of four numbers.`);
  }
  return [
    parseStoredWeightValue(value[0], `${label}[0]`),
    parseStoredWeightValue(value[1], `${label}[1]`),
    parseStoredWeightValue(value[2], `${label}[2]`),
    parseStoredWeightValue(value[3], `${label}[3]`),
  ];
}

function parseStoredEnabledDirections(value: unknown): AffinityRandomDirection[] {
  const label = 'affinity_config.enabledDirections';
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value.map((item, index) => {
    if (typeof item === 'string' && VALID_RANDOM_DIRECTIONS.has(item as AffinityRandomDirection)) {
      return item as AffinityRandomDirection;
    }
    throw new Error(`${label}[${index}] is invalid.`);
  });
}

function normalizeDate(value: unknown): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = new Date(value as string | number);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function parseSettings(rows: AffinityConfigRecord[]): AffinitySettings {
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const randomCountWeights = parseStoredRandomCountWeights(
    parseStoredJsonSetting(byKey, 'randomCountWeights', [...DEFAULT_SETTINGS.randomCountWeights]),
  );
  const enabledDirections = parseStoredEnabledDirections(
    parseStoredJsonSetting(byKey, 'enabledDirections', [...DEFAULT_SETTINGS.enabledDirections]),
  );
  return {
    enabled: parseStoredBooleanSetting(byKey, 'enabled', DEFAULT_SETTINGS.enabled),
    proactiveEnabled: parseStoredBooleanSetting(byKey, 'proactiveEnabled', DEFAULT_SETTINGS.proactiveEnabled),
    randomWindowStartHour: parseStoredNumberSetting(byKey, 'randomWindowStartHour', 0, 23, DEFAULT_SETTINGS.randomWindowStartHour),
    randomWindowEndHour: parseStoredNumberSetting(byKey, 'randomWindowEndHour', 1, 24, DEFAULT_SETTINGS.randomWindowEndHour),
    randomCountWeights,
    enabledDirections,
    webSourceEnabled: parseStoredBooleanSetting(byKey, 'webSourceEnabled', DEFAULT_SETTINGS.webSourceEnabled),
  };
}

function mergeSettings(current: AffinitySettings, patch: Partial<AffinitySettings>): AffinitySettings {
  return {
    enabled: patch.enabled ?? current.enabled,
    proactiveEnabled: patch.proactiveEnabled ?? current.proactiveEnabled,
    randomWindowStartHour: clampNumber(patch.randomWindowStartHour, 0, 23, current.randomWindowStartHour),
    randomWindowEndHour: clampNumber(patch.randomWindowEndHour, 1, 24, current.randomWindowEndHour),
    randomCountWeights: Array.isArray(patch.randomCountWeights) && patch.randomCountWeights.length === 4
      ? [
          clampNumber(patch.randomCountWeights[0], 0, 1, current.randomCountWeights[0]),
          clampNumber(patch.randomCountWeights[1], 0, 1, current.randomCountWeights[1]),
          clampNumber(patch.randomCountWeights[2], 0, 1, current.randomCountWeights[2]),
          clampNumber(patch.randomCountWeights[3], 0, 1, current.randomCountWeights[3]),
        ]
      : current.randomCountWeights,
    enabledDirections: Array.isArray(patch.enabledDirections) ? patch.enabledDirections : current.enabledDirections,
    webSourceEnabled: patch.webSourceEnabled ?? current.webSourceEnabled,
  };
}

function scopeFromSession(session: Session): { scopeKind: AffinityScopeKind; scopeId: string } | null {
  if (session.isDirect) {
    const scopeId = normalizeText(session.channelId) || normalizeText(session.userId);
    return scopeId ? { scopeKind: 'private', scopeId } : null;
  }
  const scopeId = normalizeText(session.guildId) || normalizeText(session.channelId);
  return scopeId ? { scopeKind: 'group', scopeId } : null;
}

function userKeyFromSession(session: Session): string | null {
  const platform = normalizeText(session.platform);
  const userId = normalizeText(session.userId);
  return platform && userId ? `${platform}:${userId}` : null;
}

function extractSessionText(session: Session): string {
  return normalizeText(session.stripped?.content) || normalizeText(session.content);
}

function snapshotState(state: AffinityStateInput): Record<string, unknown> {
  return {
    trust: state.trust,
    familiarity: state.familiarity,
    comfort: state.comfort,
    tension: state.tension,
    mood: state.mood,
    attentionHeat: state.attentionHeat,
    energy: state.energy,
    stage: state.stage,
  };
}

function formatPanelEffectsForHistory(effects: AffinityPanelView['recentEvents'][number]['effects']): string {
  if (!effects.length) return '';
  return effects.map((effect) => `${effect.name}${effect.sign}`).join('、');
}

function buildPanelHistoryContent(view: AffinityPanelView): string {
  const axes = view.axes.map((axis) => `${axis.name} ${axis.value}`).join('、');
  const rhythm = view.rhythm.map((item) => `${item.label} ${item.value}`).join('、');
  const recentEvents = view.recentEvents
    .map((event) => {
      const effects = formatPanelEffectsForHistory(event.effects);
      return effects ? `${event.time}：${event.title}（${effects}）` : `${event.time}：${event.title}`;
    })
    .join('；');
  return [
    '发送了一张好感面板。',
    `面板显示：阶段「${view.stageName}」，上次变化「${view.lastRelationChange}」。`,
    `关系轴：${axes}。`,
    `今日节奏：${rhythm}。`,
    `最近变化：${recentEvents || '无'}。`,
    `随后发送固定台词：「${view.fixedLine}」`,
  ].join('\n');
}

function buildPanelHistoryMetadata(view: AffinityPanelView): Record<string, unknown> {
  return {
    version: 'v1',
    characterId: view.characterId,
    userKey: view.userKey,
    stage: view.stage,
    stageName: view.stageName,
    lastRelationChange: view.lastRelationChange,
    lineKind: view.lineKind,
    fixedLine: view.fixedLine,
    visibleText: view.fixedLine,
    imageAlt: '好感面板',
    axes: view.axes.map((axis) => ({
      name: axis.name,
      value: axis.value,
    })),
    rhythm: view.rhythm.map((item) => ({
      label: item.label,
      value: item.value,
    })),
    recentEvents: view.recentEvents.map((event) => ({
      time: event.time,
      title: event.title,
      effects: event.effects,
    })),
  };
}

function parseStringArray(raw: string | null | undefined, label = 'affinity_random_memory.responderNames'): string[] {
  return parseOptionalJsonArray(raw, label)
    .map((item) => sanitizePromptMemoryText(item))
    .filter(Boolean);
}

function parseResponseSummary(raw: string | null | undefined, label = 'affinity_random_memory.responseSummary'): Array<{ at: number; speaker: string; summary: string }> {
  return parseOptionalJsonArray(raw, label)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const speaker = sanitizePromptMemoryText(record.speaker);
      const summary = sanitizePromptMemoryText(record.summary);
      const at = Number(record.at);
      if (!speaker || !summary || !Number.isFinite(at)) return null;
      return { at, speaker, summary };
    })
    .filter((item): item is { at: number; speaker: string; summary: string } => Boolean(item));
}

function truncateText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function formatAgeForPrompt(now: number, at: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return '不到1分钟前';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (hours < 24) {
    return remainMinutes > 0 ? `${hours}小时${remainMinutes}分钟前` : `${hours}小时前`;
  }
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours > 0 ? `${days}天${remainHours}小时前` : `${days}天前`;
}

function formatResponseSummaryForPrompt(raw: string | null | undefined, now: number): string | null {
  const items = parseResponseSummary(raw);
  if (!items.length) return null;
  return items
    .slice(-8)
    .map((item) => `${item.speaker}(${formatAgeForPrompt(now, item.at)}): ${truncateText(item.summary, 80)}`)
    .join('；');
}

function parseStoredJsonArray(raw: string | null | undefined, label: string): unknown[] | null {
  if (raw == null) return null;
  return parseOptionalJsonArray(raw, label);
}

function normalizeStoredResponseSummaryJson(raw: string | null | undefined): string | null {
  const parsed = parseStoredJsonArray(raw, 'affinity_random_memory.responseSummary');
  if (!parsed) return null;
  const normalized = parsed
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const at = Number(record.at);
      const speaker = sanitizePromptMemoryText(record.speaker);
      const summary = sanitizePromptMemoryText(record.summary);
      if (!Number.isFinite(at) || !speaker || !summary) return null;
      return { at, speaker, summary };
    })
    .filter((item): item is { at: number; speaker: string; summary: string } => Boolean(item));
  return stringifyJson(normalized);
}

function normalizeStoredStringArrayJson(raw: string | null | undefined): string | null {
  const parsed = parseStoredJsonArray(raw, 'affinity_random_memory.responderNames');
  if (!parsed) return null;
  return stringifyJson(parsed.map((item) => sanitizePromptMemoryText(item)).filter(Boolean));
}

function hotTopicLooksUnsafe(title: string): boolean {
  return /(死亡|遇难|自杀|凶杀|强奸|性侵|开盒|人肉|网暴|未成年|诈骗|涉政|战争|恐袭|仇恨|色情|裸照|癌症|处方|贷款|投资建议)/u.test(title);
}

function formatWebTopicForPrompt(topic: Awaited<ReturnType<typeof fetchWebHotTopicSummary>>): string | null {
  if (!topic?.title || hotTopicLooksUnsafe(topic.title)) return null;
  return JSON.stringify({
    source: topic.source,
    title: truncateText(topic.title, 80),
    fetchedAt: topic.fetchedAt,
    claimStatus: 'unverified_current',
    safety: 'title_only_low_confidence',
  });
}

const SPEAKER_TAG_PATTERN = /^\[speaker_id=([^\]\s]+)(?:\s+speaker_name=("(?:\\.|[^"\\])*"|'[^']*'|[^\]\s]+))?[^\]]*\]\s*([\s\S]*)$/u;

function parseSpeakerNameToken(rawName: string | undefined): string | null {
  const normalized = normalizeText(rawName);
  if (!normalized) return null;
  if (!normalized.startsWith('"')) return null;
  try {
    const parsed = JSON.parse(normalized) as unknown;
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function parseSpeakerTaggedText(text: string): { speakerName: string | null; text: string } {
  const match = text.match(SPEAKER_TAG_PATTERN);
  if (!match) return { speakerName: null, text };
  return {
    speakerName: normalizeText(parseSpeakerNameToken(match[2])) || null,
    text: normalizeText(match[3]),
  };
}

function buildScopeLabel(scope: AffinityScopeConfigRecord): string | null {
  return normalizeText(scope.label) || `${scope.scopeKind}:${scope.scopeId}`;
}

export function setSessionAffinityResult(session: Session, result: AffinitySessionResult | null): void {
  (session as unknown as Record<symbol, AffinitySessionResult | null>)[SESSION_RESULT_KEY] = result;
}

export function getSessionAffinityResult(session: Session): AffinitySessionResult | null {
  return ((session as unknown as Record<symbol, AffinitySessionResult | null>)[SESSION_RESULT_KEY] ?? null) as AffinitySessionResult | null;
}

export class AffinityService implements AffinityServiceLike {
  private settingsCache: AffinitySettings | null = null;
  private scheduleRefresh: () => void = () => {};
  private runtimeEnabled = true;
  private runtimeProactiveEnabled = true;

  constructor(
    private readonly database: AffinityDatabaseLike,
    private readonly modelConfig: ModelConfigService,
    private readonly modelRuntime: ModelRuntimeClient,
    private readonly getBots: () => AffinityBotLike[],
    private readonly random: () => number = Math.random,
    private readonly getChatLuna: () => ChatLunaHistoryLike | undefined = () => undefined,
    private readonly getProactiveVoiceRuntime: ProactiveVoiceRuntimeProvider = createVoiceRuntimeConfigFromEnv,
  ) {}

  private createProactiveSkipGeneration(reason: string): AffinityProactiveGenerationResult {
    return {
      shouldSend: false,
      message: null,
      contextSeedSummary: null,
      eventTypeHint: 'none',
      memorySummary: null,
      reason,
      risk: 'low',
      skipReason: reason,
      transportPlan: null,
      outputProtocol: null,
    };
  }

  private requireProactiveChatLuna(): ChatLunaHistoryLike {
    const chatluna = this.getChatLuna();
    if (typeof chatluna?.chat !== 'function') {
      throw new Error('affinity proactive generation requires chatluna.chat.');
    }
    if (!chatluna.contextManager) {
      throw new Error('affinity proactive generation requires chatluna.contextManager.');
    }
    return chatluna;
  }

  private async failPlan(plan: AffinityRandomPlanRecord, reason: string, now: number): Promise<void> {
    await this.database.set('affinity_random_plan', { id: plan.id }, {
      status: 'failed',
      skipReason: reason,
      updatedAt: now,
    });
    await this.writeAudit('random_message_generation_skipped', {
      scopeKind: plan.scopeKind,
      scopeId: plan.scopeId,
      detail: {
        planId: plan.id,
        direction: plan.direction,
        reason,
        status: 'failed',
      },
    });
  }

  private createProactiveSession(args: {
    bot: AffinityBotLike;
    scope: AffinityScopeConfigRecord;
    plan: AffinityRandomPlanRecord;
    channelId: string;
    sourceConversation: ChatLunaConversationRecord | null;
  }): Session {
    const event = {
      platform: normalizeText(args.plan.platform) || normalizeText(args.scope.platform) || normalizeText(args.bot.platform),
      channelId: args.channelId,
      guildId: normalizeText(args.plan.guildId) || normalizeText(args.scope.guildId) || undefined,
      userId: normalizeText(args.plan.botSelfId) || normalizeText(args.bot.selfId) || 'affinity-proactive',
    };
    const created = typeof args.bot.session === 'function' ? args.bot.session(event) : ({} as Session);
    const session = created as Session & { state?: Record<string, unknown>; event?: Record<string, unknown> };
    session.event = event as any;
    Object.assign(session, {
      platform: event.platform || 'onebot',
      channelId: args.channelId,
      guildId: event.guildId,
      userId: event.userId,
      isDirect: args.scope.scopeKind === 'private',
      bot: args.bot,
      messageId: `affinity-random-plan:${args.plan.id}:trigger`,
    });
    const stickerArtifacts = resolveStickerCapabilityArtifacts(normalizeText(args.sourceConversation?.preset) || null);
    session.state = {
      ...(session.state ?? {}),
      qqSticker: stickerArtifacts.state as unknown,
    };
    return session;
  }

  private async resolveChatHistoryWriter(conversationId: string): Promise<ChatHistoryWriterResolution> {
    const normalizedConversationId = normalizeText(conversationId);
    if (!normalizedConversationId) {
      return { ok: false, reason: 'missing_conversation_id' };
    }

    const chatluna = this.getChatLuna();
    if (!chatluna) {
      return {
        ok: false,
        reason: 'chatluna_history_unavailable',
        conversationId: normalizedConversationId,
      };
    }

    const [conversation] = await this.database.get('chatluna_conversation', { id: normalizedConversationId }) as ChatLunaConversationRecord[];
    if (!conversation?.id) {
      return {
        ok: false,
        reason: 'conversation_unavailable',
        conversationId: normalizedConversationId,
      };
    }

    const history = await createChatLunaHistoryWriter({
      database: this.database,
      logger,
      conversationId: normalizedConversationId,
      chatluna,
      lockMode: 'acquire',
    });

    return {
      ok: true,
      conversationId: normalizedConversationId,
      addMessages: (messages) => history.addMessages(messages),
    };
  }

  private async createTemporaryProactiveConversation(args: {
    sourceConversation: ChatLunaConversationRecord;
    session: Session;
    plan: AffinityRandomPlanRecord;
    modelTarget: ResolvedModelTarget;
  }): Promise<AffinityProactiveChatLunaConversation> {
    const id = `affinity-proactive-${randomUUID()}`;
    const now = new Date();
    const conversation: AffinityProactiveChatLunaConversation = {
      id,
      bindingKey:
        normalizeText(args.sourceConversation.bindingKey) ||
        `affinity-proactive:${args.plan.scopeKind}:${args.plan.scopeId}`,
      title: `affinity-random-${args.plan.id}`,
      model: args.modelTarget.canonicalModel,
      preset: normalizeText(args.sourceConversation.preset),
      chatMode: 'plugin',
      createdBy: normalizeText(args.session.userId) || 'affinity-proactive',
      createdAt: now,
      updatedAt: now,
      lastChatAt: now,
      status: 'active',
      latestMessageId: null,
      additional_kwargs: null,
      compression: null,
      archivedAt: null,
      archiveId: null,
      autoTitle: false,
    };
    await this.database.create('chatluna_conversation', conversation as unknown as Record<string, unknown>);
    return conversation;
  }

  private async deleteTemporaryProactiveConversation(conversation: AffinityProactiveChatLunaConversation): Promise<void> {
    await this.database.remove('chatluna_message', { conversationId: conversation.id });
    await this.database.remove('chatluna_conversation', { id: conversation.id });
  }

  private async resolveProactiveSourceConversation(args: {
    plan: AffinityRandomPlanRecord;
    scope: AffinityScopeConfigRecord;
  }): Promise<ProactiveSourceConversationResolution> {
    const targetConversationId = normalizeText(args.plan.conversationId) || normalizeText(args.scope.conversationId) || null;
    if (!targetConversationId) {
      return {
        sourceConversation: null,
        skipReason: 'missing_conversation_id',
      };
    }

    const [sourceConversation] = await this.database.get('chatluna_conversation', { id: targetConversationId }) as ChatLunaConversationRecord[];
    if (!sourceConversation?.id) {
      return {
        sourceConversation: null,
        skipReason: 'conversation_unavailable',
      };
    }

    return {
      sourceConversation,
      skipReason: null,
    };
  }

  setScheduleRefreshCallback(callback: () => void): void {
    this.scheduleRefresh = callback;
  }

  setRuntimeGate(enabled: boolean, proactiveEnabled: boolean): void {
    this.runtimeEnabled = enabled;
    this.runtimeProactiveEnabled = proactiveEnabled;
    this.settingsCache = null;
    this.scheduleRefresh();
  }

  private applyRuntimeGate(settings: AffinitySettings): AffinitySettings {
    return {
      ...settings,
      enabled: settings.enabled && this.runtimeEnabled,
      proactiveEnabled: settings.proactiveEnabled && this.runtimeProactiveEnabled,
    };
  }

  private async loadStoredSettings(): Promise<AffinitySettings> {
    const rows = await this.database.get('affinity_config', {} as Record<string, never>) as AffinityConfigRecord[];
    return parseSettings(rows);
  }

  async getSettings(): Promise<AffinitySettings> {
    if (this.settingsCache) return this.settingsCache;
    this.settingsCache = this.applyRuntimeGate(await this.loadStoredSettings());
    return this.settingsCache;
  }

  async normalizeStoredRandomMemoryPromptText(): Promise<number> {
    const rows = await this.database.get('affinity_random_memory', { characterId: CHARACTER_ID }) as AffinityRandomMemoryRecord[];
    let cleaned = 0;
    for (const row of rows) {
      const update: Record<string, unknown> = {};
      const responseSummary = normalizeStoredResponseSummaryJson(row.responseSummary);
      if (responseSummary != null && responseSummary !== row.responseSummary) {
        update.responseSummary = responseSummary;
      }
      const responderNames = normalizeStoredStringArrayJson(row.responderNames);
      if (responderNames != null && responderNames !== row.responderNames) {
        update.responderNames = responderNames;
      }
      if (!Object.keys(update).length) continue;
      update.updatedAt = Date.now();
      await this.database.set('affinity_random_memory', { id: row.id }, update);
      cleaned += 1;
    }
    return cleaned;
  }

  async saveSettings(settingsPatch: Partial<AffinitySettings>): Promise<AffinityStateSummary> {
    const current = await this.loadStoredSettings();
    const next = mergeSettings(current, settingsPatch);
    const now = Date.now();
    const rows = [
      ['enabled', String(next.enabled)],
      ['proactiveEnabled', String(next.proactiveEnabled)],
      ['randomWindowStartHour', String(next.randomWindowStartHour)],
      ['randomWindowEndHour', String(next.randomWindowEndHour)],
      ['randomCountWeights', stringifyJson(next.randomCountWeights)],
      ['enabledDirections', stringifyJson(next.enabledDirections)],
      ['webSourceEnabled', String(next.webSourceEnabled)],
    ] as const;
    for (const [key, value] of rows) {
      const [existing] = await this.database.get('affinity_config', { key }) as AffinityConfigRecord[];
      if (existing?.id) {
        await this.database.set('affinity_config', { id: existing.id }, { key, value, updatedAt: now });
      } else {
        await this.database.create('affinity_config', { key, value, updatedAt: now });
      }
    }
    this.settingsCache = this.applyRuntimeGate(next);
    this.scheduleRefresh();
    return this.getAdminState();
  }

  async getAdminState(): Promise<AffinityStateSummary> {
    const [settings, scopes, users, recentEvents, randomPlans, audit] = await Promise.all([
      this.getSettings(),
      this.database.get('affinity_scope_config', { characterId: CHARACTER_ID }) as Promise<AffinityScopeConfigRecord[]>,
      this.database.get('affinity_user_state', { characterId: CHARACTER_ID }) as Promise<AffinityUserStateRecord[]>,
      this.database.get('affinity_event', { characterId: CHARACTER_ID }) as Promise<AffinityEventRecord[]>,
      this.database.get('affinity_random_plan', { characterId: CHARACTER_ID }) as Promise<AffinityRandomPlanRecord[]>,
      this.database.get('affinity_audit', { characterId: CHARACTER_ID }) as Promise<AffinityAuditRecord[]>,
    ]);
    return {
      available: true,
      settings,
      scopes: scopes.sort((left, right) => `${left.scopeKind}:${left.scopeId}`.localeCompare(`${right.scopeKind}:${right.scopeId}`, 'zh-CN')),
      users: users.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 100),
      recentEvents: recentEvents.sort((left, right) => right.createdAt - left.createdAt).slice(0, 80),
      randomPlans: randomPlans.sort((left, right) => right.scheduledAt - left.scheduledAt).slice(0, 80),
      audit: audit.sort((left, right) => right.createdAt - left.createdAt).slice(0, 80),
    };
  }

  async buildPanelView(session: Session, now = Date.now()): Promise<AffinityPanelView> {
    const userKey = userKeyFromSession(session);
    if (!userKey) throw new Error('无法识别当前用户。');
    const [stateRows, recentEvents] = await Promise.all([
      this.database.get('affinity_user_state', { characterId: CHARACTER_ID, userKey }) as Promise<AffinityUserStateRecord[]>,
      this.database.get('affinity_event', { characterId: CHARACTER_ID, userKey }) as Promise<AffinityEventRecord[]>,
    ]);
    const state = applyTemporalDecay(stateFromRecord(stateRows[0], now), now);
    return buildAffinityPanelView({
      userKey,
      state,
      recentEvents,
      now,
    });
  }

  async syncPanelCommandToChatHistory(
    session: Session,
    view: AffinityPanelView,
  ): Promise<AffinityPanelHistorySyncResult> {
    const userKey = userKeyFromSession(session);
    let scope: AffinityScopeConfigRecord | null = null;
    let conversationId = '';

    try {
      scope = await this.resolveScope(session);
      if (!scope) {
        await this.writePanelHistorySyncAudit('panel_history_sync_skipped', session, view, null, {
          reason: 'scope_unavailable',
        });
        return { synced: false, reason: 'scope_unavailable' };
      }

      conversationId = normalizeText(scope.conversationId);
      if (!conversationId) {
        await this.writePanelHistorySyncAudit('panel_history_sync_skipped', session, view, scope, {
          reason: 'missing_conversation_id',
        });
        return { synced: false, reason: 'missing_conversation_id' };
      }

      const writer = await this.resolveChatHistoryWriter(conversationId);
      if (!writer.ok) {
        await this.writePanelHistorySyncAudit('panel_history_sync_skipped', session, view, scope, {
          reason: writer.reason,
          conversationId: writer.conversationId ?? conversationId,
        });
        return {
          synced: false,
          reason: writer.reason,
          conversationId: writer.conversationId ?? conversationId,
        };
      }

      const panelMessageId = `affinity-panel-command:${normalizeText(session.messageId) || randomUUID()}`;
      await writer.addMessages([
        new AIMessage({
          content: buildPanelHistoryContent(view),
          id: panelMessageId,
          response_metadata: {
            chatluna: {
              recordId: panelMessageId,
            },
          },
          additional_kwargs: {
            qqbot_affinity_panel_command: {
              ...buildPanelHistoryMetadata(view),
              scopeKind: scope.scopeKind,
              scopeId: scope.scopeId,
              platform: normalizeText(session.platform) || scope.platform || null,
              botSelfId: normalizeText(session.bot?.selfId) || scope.botSelfId || null,
              channelId: normalizeText(session.channelId) || scope.channelId || null,
              guildId: normalizeText(session.guildId) || scope.guildId || null,
              conversationId: writer.conversationId,
              triggerMessageId: normalizeText(session.messageId) || null,
            },
          },
        }),
      ]);
      await this.writePanelHistorySyncAudit('panel_history_synced', session, view, scope, {
        conversationId: writer.conversationId,
        userKey,
      });
      return { synced: true, conversationId: writer.conversationId };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(
        'affinity panel history sync skipped: userKey=%s conversationId=%s error=%s',
        userKey ?? '<unknown>',
        conversationId || '<unknown>',
        errorMessage,
      );
      await this.writePanelHistorySyncAudit('panel_history_sync_skipped', session, view, scope, {
        reason: 'write_failed',
        conversationId: conversationId || null,
        error: errorMessage,
      });
      return conversationId
        ? { synced: false, reason: 'write_failed', conversationId }
        : { synced: false, reason: 'write_failed' };
    }
  }

  async saveWhitelist(scopes: AffinityWhitelistInput[]): Promise<AffinityStateSummary> {
    const now = Date.now();
    const existing = await this.database.get('affinity_scope_config', { characterId: CHARACTER_ID }) as AffinityScopeConfigRecord[];
    const seen = new Set<string>();
    for (const item of scopes) {
      const scopeKind = item.scopeKind === 'private' ? 'private' : 'group';
      const scopeId = normalizeText(item.scopeId);
      if (!scopeId) continue;
      const key = `${scopeKind}:${scopeId}`;
      seen.add(key);
      const patch = {
        characterId: CHARACTER_ID,
        scopeKind,
        scopeId,
        enabled: item.enabled ? 1 : 0,
        proactiveEnabled: item.proactiveEnabled ? 1 : 0,
        label: normalizeText(item.label) || null,
        platform: normalizeText(item.platform) || null,
        botSelfId: normalizeText(item.botSelfId) || null,
        channelId: normalizeText(item.channelId) || scopeId,
        guildId: scopeKind === 'group' ? normalizeText(item.guildId) || scopeId : normalizeText(item.guildId) || null,
        conversationId: normalizeText(item.conversationId) || null,
        updatedAt: now,
      };
      const found = existing.find((row) => row.scopeKind === scopeKind && row.scopeId === scopeId);
      if (found?.id) {
        await this.database.set('affinity_scope_config', { id: found.id }, patch);
      } else {
        await this.database.create('affinity_scope_config', patch);
      }
    }
    for (const row of existing) {
      if (!seen.has(`${row.scopeKind}:${row.scopeId}`)) {
        await this.database.remove('affinity_scope_config', { id: row.id });
      }
    }
    this.scheduleRefresh();
    return this.getAdminState();
  }

  async createManualRandomPlan(input: AffinityManualRandomPlanInput, now = Date.now()): Promise<AffinityManualRandomPlanResponse> {
    const settings = await this.getSettings();
    if (!settings.enabled) {
      throw new Error('affinity is disabled');
    }
    const scopeKind = input.scopeKind === 'private' ? 'private' : 'group';
    const scopeId = normalizeText(input.scopeId);
    if (!scopeId) throw new Error('scopeId is required.');
    const delayMs = clampNumber(input.delayMs ?? 5000, 0, 10 * 60 * 1000, 5000);
    const scheduledAt = now + delayMs;
    const dayKey = getShanghaiDayKey(scheduledAt);
    const [scope] = await this.database.get('affinity_scope_config', {
      characterId: CHARACTER_ID,
      scopeKind,
      scopeId,
    }) as AffinityScopeConfigRecord[];
    const direction = pickRandomDirection(settings.enabledDirections, this.random);
    const created = await this.database.create('affinity_random_plan', {
      planKey: `${CHARACTER_ID}:${scopeKind}:${scopeId}:manual:${now}:${Math.floor(this.random() * 1_000_000_000)}`,
      characterId: CHARACTER_ID,
      triggerKind: 'manual',
      scopeKind,
      scopeId,
      platform: normalizeText(input.platform) || scope?.platform || null,
      botSelfId: normalizeText(input.botSelfId) || scope?.botSelfId || null,
      channelId: normalizeText(input.channelId) || scope?.channelId || scopeId,
      guildId: scopeKind === 'group' ? normalizeText(input.guildId) || scope?.guildId || scopeId : normalizeText(input.guildId) || scope?.guildId || null,
      conversationId: normalizeText(input.conversationId) || scope?.conversationId || null,
      dayKey,
      slotIndex: 0,
      direction,
      scheduledAt,
      status: 'pending',
      messageText: null,
      skipReason: null,
      sentAt: null,
      deliveryState: 'not_started',
      deliveryAttemptId: null,
      deliveryReceipt: null,
      deliveryPayloadJson: null,
      deliveryConfirmedAt: null,
      createdAt: now,
      updatedAt: now,
    }) as unknown as AffinityRandomPlanRecord;
    await this.writeAudit('random_plan_created', {
      scopeKind,
      scopeId,
      detail: { dayKey, count: 1, triggerKind: 'manual', delayMs, planId: created.id },
    });
    this.scheduleRefresh();
    return {
      ok: true,
      planId: Number(created.id),
      scheduledAt,
      triggerKind: 'manual',
    };
  }

  async adjustUserState(input: {
    userKey: string;
    reason: string;
    trust?: number;
    familiarity?: number;
    comfort?: number;
    tension?: number;
  }): Promise<AffinityStateSummary> {
    const userKey = normalizeText(input.userKey);
    if (!userKey) throw new Error('userKey is required.');
    const [row] = await this.database.get('affinity_user_state', { characterId: CHARACTER_ID, userKey }) as AffinityUserStateRecord[];
    if (!row?.id) throw new Error('关系用户不存在。');
    const patch: Record<string, unknown> = { updatedAt: Date.now(), lastUpdatedAt: Date.now() };
    for (const key of ['trust', 'familiarity', 'comfort', 'tension'] as const) {
      if (input[key] != null) patch[key] = clampNumber(input[key], 0, 100, row[key]);
    }
    await this.database.set('affinity_user_state', { id: row.id }, patch);
    await this.writeAudit('admin_update', {
      userKey,
      detail: { reason: input.reason, patch },
    });
    return this.getAdminState();
  }

  async resolveScope(session: Session): Promise<AffinityScopeConfigRecord | null> {
    const scope = scopeFromSession(session);
    if (!scope) return null;
    const [row] = await this.database.get('affinity_scope_config', {
      characterId: CHARACTER_ID,
      scopeKind: scope.scopeKind,
      scopeId: scope.scopeId,
    }) as AffinityScopeConfigRecord[];
    if (!row || Number(row.enabled) !== 1) return null;

    const patch: Record<string, unknown> = {};
    const channelId = normalizeText(session.channelId);
    const guildId = normalizeText(session.guildId);
    const platform = normalizeText(session.platform);
    const botSelfId = normalizeText(session.bot?.selfId);
    if (channelId && row.channelId !== channelId) patch.channelId = channelId;
    if (guildId && row.guildId !== guildId) patch.guildId = guildId;
    if (platform && row.platform !== platform) patch.platform = platform;
    if (botSelfId && row.botSelfId !== botSelfId) patch.botSelfId = botSelfId;
    if (Object.keys(patch).length) {
      patch.updatedAt = Date.now();
      await this.database.set('affinity_scope_config', { id: row.id }, patch);
      return { ...row, ...patch } as AffinityScopeConfigRecord;
    }
    return row;
  }

  async processIncomingSession(session: Session): Promise<AffinitySessionResult | null> {
    const settings = await this.getSettings();
    if (!settings.enabled || !session.userId || session.userId === session.bot?.selfId) return null;
    const scope = await this.resolveScope(session);
    if (!scope) return null;
    const text = extractSessionText(session);
    if (!text) return null;

    const now = Date.now();
    const userKey = userKeyFromSession(session);
    if (!userKey) return null;
    const openThreads = await this.listOpenThreads(scope.scopeKind, scope.scopeId, userKey, now);
    await this.validateOpenRandomMemoryPromptState(openThreads);
    const stateRow = await this.getOrCreateUserState(session, userKey, now);
    const state = stateFromRecord(stateRow, now);
    const openThreadSummaries = openThreads.map((thread) => `${thread.title ?? 'open'}: ${thread.summary ?? ''}`.trim());
    const analysis = await analyzeAffinityEvent({
      text,
      openThreads: openThreadSummaries,
      relationSummary: formatStateForPrompt(state),
      randomPending: openThreadSummaries.some((thread) => thread.includes('random')),
    }, this.modelRuntime, {
      onModelError: (diagnostic) => {
        logger.warn(
          'affinity analysis model failed: diagnostic=%s',
          JSON.stringify(diagnostic),
        );
      },
    });
    const resolution = resolveAffinityEvent(state, analysis, now);
    await this.persistResolution({
      session,
      scope,
      userKey,
      stateRow,
      analysis,
      resolution,
      evidence: analysis.evidence ?? text.slice(0, 100),
    });
    await this.updateRandomMemoryFromReply({
      scope,
      openThreads,
      speakerName: resolveSessionDisplayName(session),
      text,
      analysis,
      now,
    });
    const shouldAllowReply = analysis.route !== 'ignore'
      && analysis.route !== 'normal_chat'
      && analysis.confidence >= 0.55
      && resolution.effectTier !== 'ignore';
    const result = {
      shouldAllowReply,
      analysis,
    };
    setSessionAffinityResult(session, result);
    return result;
  }

  async injectPromptForTurn(conversationId: string, session: Session): Promise<void> {
    const userKey = userKeyFromSession(session);
    if (!userKey) return;
    const scope = scopeFromSession(session);
    const activeProactiveThreads = scope
      ? (await this.listOpenThreads(scope.scopeKind, scope.scopeId, userKey, Date.now()))
          .filter((thread) => normalizeText(thread.title).startsWith('random:'))
          .map(activeProactiveThreadPromptState)
      : [];
    await this.injectPromptForUser(conversationId, userKey, getSessionAffinityResult(session), activeProactiveThreads);
  }

  async ensureDailyRandomPlans(now = Date.now()): Promise<void> {
    const settings = await this.getSettings();
    if (!settings.enabled || !settings.proactiveEnabled) return;
    const dayKey = getShanghaiDayKey(now);
    const scopes = await this.database.get('affinity_scope_config', { characterId: CHARACTER_ID }) as AffinityScopeConfigRecord[];
    for (const scope of scopes.filter((row) => Number(row.enabled) === 1 && Number(row.proactiveEnabled) === 1)) {
      const existing = await this.database.get('affinity_random_plan', {
        characterId: CHARACTER_ID,
        scopeKind: scope.scopeKind,
        scopeId: scope.scopeId,
        dayKey,
      }) as AffinityRandomPlanRecord[];
      if (existing.some((plan) => !this.isManualRandomPlan(plan))) continue;
      const count = selectRandomCount(settings.randomCountWeights, this.random);
      if (count === 0) {
        await this.database.create('affinity_random_plan', {
          planKey: `${CHARACTER_ID}:${scope.scopeKind}:${scope.scopeId}:${dayKey}:0`,
          characterId: CHARACTER_ID,
          triggerKind: 'scheduled',
          scopeKind: scope.scopeKind,
          scopeId: scope.scopeId,
          platform: scope.platform,
          botSelfId: scope.botSelfId,
          channelId: scope.channelId ?? scope.scopeId,
          guildId: scope.guildId,
          conversationId: scope.conversationId,
          dayKey,
          slotIndex: 0,
          direction: 'daily_greeting',
          scheduledAt: now,
          status: 'skipped',
          messageText: null,
          skipReason: 'daily_count_zero',
          sentAt: null,
          deliveryState: 'not_started',
          deliveryAttemptId: null,
          deliveryReceipt: null,
          deliveryPayloadJson: null,
          deliveryConfirmedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        await this.writeAudit('random_plan_created', {
          scopeKind: scope.scopeKind,
          scopeId: scope.scopeId,
          detail: { dayKey, count },
        });
        continue;
      }
      const times = createRandomScheduleTimes({
        now,
        count,
        startHour: settings.randomWindowStartHour,
        endHour: settings.randomWindowEndHour,
        random: this.random,
      });
      for (const [index, scheduledAt] of times.entries()) {
        const direction = pickRandomDirection(settings.enabledDirections, this.random);
        const planKey = `${CHARACTER_ID}:${scope.scopeKind}:${scope.scopeId}:${dayKey}:${index}`;
        await this.database.create('affinity_random_plan', {
          planKey,
          characterId: CHARACTER_ID,
          triggerKind: 'scheduled',
          scopeKind: scope.scopeKind,
          scopeId: scope.scopeId,
          platform: scope.platform,
          botSelfId: scope.botSelfId,
          channelId: scope.channelId ?? scope.scopeId,
          guildId: scope.guildId,
          conversationId: scope.conversationId,
          dayKey,
          slotIndex: index,
          direction,
          scheduledAt,
          status: 'pending',
          messageText: null,
          skipReason: null,
          sentAt: null,
          deliveryState: 'not_started',
          deliveryAttemptId: null,
          deliveryReceipt: null,
          deliveryPayloadJson: null,
          deliveryConfirmedAt: null,
          createdAt: now,
          updatedAt: now,
        });
      }
      await this.writeAudit('random_plan_created', {
        scopeKind: scope.scopeKind,
        scopeId: scope.scopeId,
        detail: { dayKey, count },
      });
    }
  }

  async runDueRandomPlans(now = Date.now()): Promise<void> {
    await this.reconcileInterruptedRandomDeliveries(now);
    await this.ensureDailyRandomPlans(now);
    await this.pruneRandomMemories(now);
    const settings = await this.getSettings();
    if (!settings.enabled) return;
    const pending = await this.database.get('affinity_random_plan', {
      characterId: CHARACTER_ID,
      status: 'pending',
    }) as AffinityRandomPlanRecord[];
    for (const plan of pending
      .filter((item) => item.scheduledAt <= now)
      .filter((item) => item.deliveryState === 'not_started')
      .filter((item) => this.isManualRandomPlan(item) || settings.proactiveEnabled)
      .sort((a, b) => a.scheduledAt - b.scheduledAt)) {
      await this.fireRandomPlan(plan, settings, now);
    }
  }

  async getNextPendingRandomPlanAt(now = Date.now()): Promise<number | null> {
    const settings = await this.getSettings();
    if (!settings.enabled) return null;
    const pending = await this.database.get('affinity_random_plan', {
      characterId: CHARACTER_ID,
      status: 'pending',
    }) as AffinityRandomPlanRecord[];
    const next = pending
      .filter((item) => item.deliveryState === 'not_started')
      .filter((item) => item.scheduledAt >= now || this.isManualRandomPlan(item))
      .filter((item) => this.isManualRandomPlan(item) || settings.proactiveEnabled)
      .sort((a, b) => a.scheduledAt - b.scheduledAt)[0];
    return next ? Number(next.scheduledAt) : null;
  }

  private async getOrCreateUserState(session: Session, userKey: string, now: number): Promise<AffinityUserStateRecord> {
    const [existing] = await this.database.get('affinity_user_state', { characterId: CHARACTER_ID, userKey }) as AffinityUserStateRecord[];
    const displayName = resolveSessionDisplayName(session);
    if (existing?.id) {
      await this.database.set('affinity_user_state', { id: existing.id }, {
        displayName,
        lastSeenAt: now,
        updatedAt: now,
      });
      return { ...existing, displayName, lastSeenAt: now, updatedAt: now };
    }
    const initial = createInitialState(now);
    const created = await this.database.create('affinity_user_state', {
      characterId: CHARACTER_ID,
      userKey,
      platform: normalizeText(session.platform),
      userId: normalizeText(session.userId),
      displayName,
      trust: initial.trust,
      familiarity: initial.familiarity,
      comfort: initial.comfort,
      tension: initial.tension,
      mood: initial.mood,
      attentionHeat: initial.attentionHeat,
      energy: initial.energy,
      stage: initial.stage,
      flags: null,
      unlockedScenes: null,
      dailyState: stringifyJson(initial.dailyState),
      weeklyState: stringifyJson(initial.weeklyState),
      lastSeenAt: now,
      lastUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
    }) as unknown as AffinityUserStateRecord;
    return created;
  }

  private async persistResolution(args: {
    session: Session;
    scope: AffinityScopeConfigRecord;
    userKey: string;
    stateRow: AffinityUserStateRecord;
    analysis: AffinityEventAnalysis;
    resolution: ReturnType<typeof resolveAffinityEvent>;
    evidence: string | null;
  }): Promise<void> {
    const now = Date.now();
    const { session, scope, stateRow, analysis, resolution } = args;
    if (resolution.accepted) {
      await this.database.set('affinity_user_state', { id: stateRow.id }, {
        trust: resolution.after.trust,
        familiarity: resolution.after.familiarity,
        comfort: resolution.after.comfort,
        tension: resolution.after.tension,
        mood: resolution.after.mood,
        attentionHeat: resolution.after.attentionHeat,
        energy: resolution.after.energy,
        stage: resolution.after.stage,
        dailyState: stringifyJson(resolution.after.dailyState),
        weeklyState: stringifyJson(resolution.after.weeklyState),
        lastUpdatedAt: now,
        updatedAt: now,
      });
    }
    await this.database.create('affinity_event', {
      characterId: CHARACTER_ID,
      userKey: args.userKey,
      scopeKind: scope.scopeKind,
      scopeId: scope.scopeId,
      platform: normalizeText(session.platform),
      botSelfId: normalizeText(session.bot?.selfId) || null,
      channelId: normalizeText(session.channelId) || null,
      guildId: normalizeText(session.guildId) || null,
      conversationId: scope.conversationId,
      messageId: normalizeText(session.messageId) || null,
      eventType: analysis.eventType,
      effectTier: resolution.effectTier,
      route: analysis.route,
      confidence: analysis.confidence,
      reasonCode: resolution.reasonCode,
      deltaJson: stringifyJson(resolution.delta),
      beforeJson: stringifyJson(snapshotState(resolution.before)),
      afterJson: stringifyJson(snapshotState(resolution.after)),
      evidence: args.evidence,
      createdAt: now,
    });
    await this.writeAudit('event_analysis', {
      userKey: args.userKey,
      scopeKind: scope.scopeKind,
      scopeId: scope.scopeId,
      detail: {
        route: analysis.route,
        eventType: analysis.eventType,
        effectTier: resolution.effectTier,
        accepted: resolution.accepted,
        reasonCode: resolution.reasonCode,
      },
    });
  }

  private async listOpenThreads(
    scopeKind: AffinityScopeKind,
    scopeId: string,
    userKey: string,
    now: number,
  ): Promise<OpenThreadSummary[]> {
    const rows = await this.database.get('affinity_open_thread', {
      characterId: CHARACTER_ID,
      scopeKind,
      scopeId,
      status: 'open',
    }) as Array<OpenThreadSummary & { userKey?: string | null }>;
    return rows
      .filter((row) => !row.userKey || row.userKey === userKey)
      .filter((row) => Number(row.expiresAt ?? 0) > now)
      .slice(0, 6)
      .map((row) => {
        if (!normalizeText(row.title).startsWith('random:')) return row;
        return {
          ...row,
          randomPayload: parseRandomThreadPayload(row.payloadJson),
        };
      });
  }

  private async validateOpenRandomMemoryPromptState(openThreads: OpenThreadSummary[]): Promise<void> {
    for (const thread of openThreads) {
      if (!normalizeText(thread.title).startsWith('random:')) continue;
      const payload = thread.randomPayload ?? parseRandomThreadPayload(thread.payloadJson);
      const [memory] = await this.database.get('affinity_random_memory', {
        characterId: CHARACTER_ID,
        sourcePlanId: payload.planId,
      }) as AffinityRandomMemoryRecord[];
      if (!memory?.id) continue;
      parseResponseSummary(memory.responseSummary);
      parseStringArray(memory.responderNames);
    }
  }

  private async updateRandomMemoryFromReply(args: {
    scope: AffinityScopeConfigRecord;
    openThreads: OpenThreadSummary[];
    speakerName: string;
    text: string;
    analysis: AffinityEventAnalysis;
    now: number;
  }): Promise<void> {
    if (
      args.analysis.route === 'ignore' ||
      args.analysis.route === 'normal_chat' ||
      args.analysis.eventType === 'none' ||
      args.analysis.confidence < 0.45
    ) {
      return;
    }

    const thread = args.openThreads.find((item) => normalizeText(item.title).startsWith('random:'));
    if (!thread?.payloadJson) return;
    const payload = thread.randomPayload ?? parseRandomThreadPayload(thread.payloadJson);
    const planId = payload.planId;

    const [memory] = await this.database.get('affinity_random_memory', {
      characterId: CHARACTER_ID,
      sourcePlanId: planId,
    }) as AffinityRandomMemoryRecord[];
    if (!memory?.id) return;

    const speaker = sanitizePromptMemoryText(args.speakerName) || 'unknown';
    const responses = parseResponseSummary(memory.responseSummary);
    responses.push({
      at: args.now,
      speaker,
      summary: truncateText(sanitizePromptMemoryText(args.analysis.evidence ?? args.text), 120),
    });
    const responderNames = new Set(parseStringArray(memory.responderNames));
    responderNames.add(speaker);
    await this.database.set('affinity_random_memory', { id: memory.id }, {
      responseSummary: stringifyJson(responses.slice(-20)),
      responderNames: stringifyJson([...responderNames]),
      lastResponseAt: args.now,
      updatedAt: args.now,
    });
    await this.writeAudit('random_memory_updated', {
      userKey: null,
      scopeKind: args.scope.scopeKind,
      scopeId: args.scope.scopeId,
      detail: {
        planId,
        direction: payload.direction ?? memory.direction,
        speaker,
        eventType: args.analysis.eventType,
      },
    });
  }

  private async injectPromptForUser(
    conversationId: string,
    userKey: string,
    result: AffinitySessionResult | null,
    activeProactiveThreads: ActiveProactiveThreadPromptState[] = [],
  ): Promise<void> {
    const [row] = await this.database.get('affinity_user_state', { characterId: CHARACTER_ID, userKey }) as AffinityUserStateRecord[];
    const state = applyTemporalDecay(stateFromRecord(row, Date.now()), Date.now());
    registerPromptFragment(conversationId, {
      source: 'qqbot_affinity',
      title: 'Sakiko Relationship State',
      authority: 'assistant_state',
      trust: 'trusted',
      ttl: 'turn',
      channel: 'relationshipState',
      payload: {
        kind: 'json',
        value: {
          relation: formatStateForPrompt(state),
          activeProactiveThreads,
          eventResult: result ? affinityPromptEventResult(result) : null,
        },
      },
    });
  }

  private async pruneRandomMemories(now: number): Promise<void> {
    const rows = await this.database.get('affinity_random_memory', { characterId: CHARACTER_ID }) as AffinityRandomMemoryRecord[];
    await Promise.all(
      rows
        .filter((row) => Number(row.expiresAt) <= now)
        .map((row) => this.database.remove('affinity_random_memory', { id: row.id })),
    );
  }

  private async loadRecentRandomMemories(
    scope: AffinityScopeConfigRecord,
    now: number,
  ): Promise<AffinityRandomMemoryItem[]> {
    const rows = await this.database.get('affinity_random_memory', {
      characterId: CHARACTER_ID,
      scopeKind: scope.scopeKind,
      scopeId: scope.scopeId,
    }) as AffinityRandomMemoryRecord[];
    return rows
      .filter((row) => Number(row.expiresAt) > now)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, RECENT_MEMORY_LIMIT)
      .map((row) => {
        const responses = parseResponseSummary(row.responseSummary);
        return {
          direction: row.direction,
          messageText: row.messageText,
          contextSummary: row.contextSummary,
          responseSummary: formatResponseSummaryForPrompt(row.responseSummary, now),
          responses: responses.slice(-8).map((item) => ({
            at: item.at,
            speakerName: item.speaker,
            summary: item.summary,
          })),
          responderNames: parseStringArray(row.responderNames),
          createdAt: row.createdAt,
          lastResponseAt: row.lastResponseAt,
        };
      });
  }

  private async loadRecentConversationTurns(conversationId: string | null | undefined): Promise<AffinityRandomContextTurn[]> {
    const normalizedConversationId = normalizeText(conversationId);
    if (!normalizedConversationId) return [];
    const [conversation] = await this.database.get('chatluna_conversation', { id: normalizedConversationId }) as ChatLunaConversationRecord[];
    if (!conversation?.latestMessageId) return [];
    const rows = await this.database.get('chatluna_message', { conversationId: normalizedConversationId }) as ConversationMessageRow[];
    const messageMap = new Map(rows.map((row) => [row.id, row]));
    const turns: AffinityRandomContextTurn[] = [];
    let cursor: string | null | undefined = conversation.latestMessageId;
    while (cursor && turns.length < RECENT_CONTEXT_LIMIT) {
      const row = messageMap.get(cursor);
      if (!row) break;
      if (row.role === 'human' || row.role === 'ai') {
        const text = normalizeText(await decodeStoredMessageText(row.content));
        const parsed = parseSpeakerTaggedText(text);
        const normalized = sanitizePromptMemoryText(parsed.text || text);
        if (normalized) {
          turns.push({
            role: row.role,
            text: normalized,
            speakerName: parsed.speakerName,
            observedAt: null,
            source: 'history',
          });
        }
      }
      cursor = row.parentId ?? null;
    }
    return turns.reverse();
  }

  private loadRealtimeContextTurns(
    scope: AffinityScopeConfigRecord,
    bot: AffinityBotLike,
  ): { turns: AffinityRandomContextTurn[]; lastRealtimeMessageAt: number | null } {
    if (scope.scopeKind !== 'group') {
      return { turns: [], lastRealtimeMessageAt: null };
    }
    const groupScopeKey = buildGroupScopeKey({
      isDirect: false,
      platform: normalizeText(scope.platform) || normalizeText(bot.platform) || undefined,
      bot: { selfId: normalizeText(scope.botSelfId) || normalizeText(bot.selfId) || undefined },
      guildId: normalizeText(scope.guildId) || normalizeText(scope.scopeId),
      channelId: normalizeText(scope.channelId) || normalizeText(scope.scopeId),
    });
    if (!groupScopeKey) {
      return { turns: [], lastRealtimeMessageAt: null };
    }
    const entries = realtimeMessageCache.get(groupScopeKey).slice(-RECENT_CONTEXT_LIMIT);
    return {
      turns: entries.map((entry): AffinityRandomContextTurn => ({
        role: 'human',
        text: truncateText(sanitizePromptMemoryText([entry.text, entry.voiceTranscript ?? ''].filter(Boolean).join('\n')), 220),
        speakerName: sanitizePromptMemoryText(entry.speakerName),
        observedAt: entry.capturedAt,
        source: 'realtime',
      })).filter((turn) => Boolean(turn.text)),
      lastRealtimeMessageAt: entries.length ? entries[entries.length - 1].capturedAt : null,
    };
  }

  private async buildRelationOverview(now: number): Promise<Record<string, unknown>> {
    const rows = await this.database.get('affinity_user_state', { characterId: CHARACTER_ID }) as AffinityUserStateRecord[];
    const recent = rows
      .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
      .slice(0, 12)
      .map((row) => applyTemporalDecay(stateFromRecord(row, now), now));
    const stageCounts: Record<string, number> = {};
    for (const item of recent) {
      stageCounts[item.stage] = Number(stageCounts[item.stage] ?? 0) + 1;
    }
    return {
      character: CHARACTER_ID,
      scope: 'shared_cross_group_private_relation_state',
      recentUserCount: recent.length,
      stageCounts,
      highestAttentionHeat: recent.length ? Math.max(...recent.map((item) => item.attentionHeat)) : 0,
      dominantMood: recent[0]?.mood ?? 'neutral',
      representativeStage: recent[0]?.stage ?? 'stranger',
      rules: [
        'Do not mention numeric scores or stage labels in proactive messages.',
        'Private chat details are not available for group proactive messages.',
      ],
    };
  }

  private async buildRandomGenerationInput(args: {
    plan: AffinityRandomPlanRecord;
    scope: AffinityScopeConfigRecord;
    bot: AffinityBotLike;
    settings: AffinitySettings;
    now: number;
    manual: boolean;
  }): Promise<{ input: AffinityRandomGenerationInput | null; skipReason: string | null; materialJson: string | null }> {
    const activeThreads = await this.database.get('affinity_open_thread', {
      characterId: CHARACTER_ID,
      scopeKind: args.scope.scopeKind,
      scopeId: args.scope.scopeId,
      status: 'open',
    }) as OpenThreadSummary[];
    if (!args.manual && activeThreads.some((thread) => normalizeText(thread.title).startsWith('random:') && Number(thread.expiresAt ?? 0) > args.now)) {
      return { input: null, skipReason: 'open_random_thread_exists', materialJson: null };
    }

    const relationSummary = await this.buildRelationOverview(args.now);
    const representativeStage = String(relationSummary.representativeStage ?? 'stranger') as AffinityStateInput['stage'];
    const material = pickRandomMaterial({
      direction: args.plan.direction,
      stage: representativeStage,
      random: this.random,
    });
    const materialJson = materialToPromptText(material);
    let webTopicText: string | null = null;
    if (args.plan.direction === 'web_hot_topic') {
      if (!args.settings.webSourceEnabled) {
        return { input: null, skipReason: 'web_source_disabled', materialJson: null };
      }
      webTopicText = formatWebTopicForPrompt(await fetchWebHotTopicSummary(this.random));
      if (!webTopicText) {
        return { input: null, skipReason: 'web_topic_unavailable', materialJson: null };
      }
    }

    const shouldLoadConversationContext = proactiveDirectionUsesConversationContext(args.plan.direction);
    const [historyTurns, recentMemories] = await Promise.all([
      shouldLoadConversationContext
        ? this.loadRecentConversationTurns(args.plan.conversationId ?? args.scope.conversationId)
        : Promise.resolve([] as AffinityRandomContextTurn[]),
      this.loadRecentRandomMemories(args.scope, args.now),
    ]);
    const realtime = shouldLoadConversationContext
      ? this.loadRealtimeContextTurns(args.scope, args.bot)
      : { turns: [] as AffinityRandomContextTurn[], lastRealtimeMessageAt: null };
    const recentTurns = [...historyTurns, ...realtime.turns].slice(-RECENT_CONTEXT_LIMIT);
    const latestTurns = recentTurns.slice(-2);
    if (latestTurns.length > 0 && latestTurns.every((turn) => turn.role === 'ai')) {
      return { input: null, skipReason: 'bot_recently_spoke', materialJson };
    }
    if (args.plan.direction === 'local_thread' && recentTurns.length < 1) {
      return { input: null, skipReason: 'no_recent_context', materialJson };
    }

    return {
      input: {
        direction: args.plan.direction,
        now: args.now,
        scopeLabel: buildScopeLabel(args.scope),
        relationSummary,
        recentTurns,
        recentMemories,
        materialText: materialJson,
        webTopicText,
        lastRealtimeMessageAt: realtime.lastRealtimeMessageAt,
      },
      skipReason: null,
      materialJson,
    };
  }

  private async persistRandomMemory(args: {
    plan: AffinityRandomPlanRecord;
    scope: AffinityScopeConfigRecord;
    messageText: string;
    generation: AffinityRandomGenerationResult;
    materialJson: string | null;
    now: number;
  }): Promise<void> {
    const [existing] = await this.database.get('affinity_random_memory', {
      sourcePlanId: args.plan.id,
    }) as AffinityRandomMemoryRecord[];
    if (existing?.id) return;
    await this.database.create('affinity_random_memory', {
      characterId: CHARACTER_ID,
      scopeKind: args.scope.scopeKind,
      scopeId: args.scope.scopeId,
      direction: args.plan.direction,
      sourcePlanId: args.plan.id,
      messageText: args.messageText,
      contextSummary: args.generation.contextSeedSummary ?? args.generation.memorySummary,
      materialJson: args.materialJson,
      responseSummary: null,
      responderNames: stringifyJson([]),
      createdAt: args.now,
      lastResponseAt: null,
      expiresAt: args.now + RANDOM_MEMORY_TTL_MS,
      updatedAt: args.now,
    });
  }

  private async generateProactiveReply(args: {
    plan: AffinityRandomPlanRecord;
    scope: AffinityScopeConfigRecord;
    bot: AffinityBotLike;
    input: AffinityRandomGenerationInput;
    channelId: string;
  }): Promise<AffinityProactiveGenerationResult> {
    const source = await this.resolveProactiveSourceConversation({
      plan: args.plan,
      scope: args.scope,
    });
    if (!source.sourceConversation) return this.createProactiveSkipGeneration(source.skipReason);
    const chatluna = this.requireProactiveChatLuna();
    const runtime = this.getProactiveVoiceRuntime();

    const session = this.createProactiveSession({
      bot: args.bot,
      scope: args.scope,
      plan: args.plan,
      channelId: args.channelId,
      sourceConversation: source.sourceConversation,
    });
    let tempConversation: AffinityProactiveChatLunaConversation | null = null;
    try {
      const modelTarget = new CanonicalModelBindingResolver(
        this.modelConfig.getRuntimeSnapshot(),
      ).resolve('main.chat').target!;
      tempConversation = await this.createTemporaryProactiveConversation({
        sourceConversation: source.sourceConversation,
        session,
        plan: args.plan,
        modelTarget,
      });
      return await generateAffinityProactiveViaChatLuna({
        chatluna: chatluna as any,
        conversation: tempConversation,
        session,
        input: args.input,
        requestId: `affinity-random-plan:${args.plan.id}:${args.plan.direction}`,
        runtime,
        modelTarget,
      });
    } catch (error) {
      logger.warn(
        'affinity proactive generation skipped: planId=%s direction=%s diagnostic=%s',
        String(args.plan.id),
        args.plan.direction,
        JSON.stringify(serializeModelConfigDiagnostic(error)),
      );
      return this.createProactiveSkipGeneration('chatluna_generation_error');
    } finally {
      if (tempConversation) {
        await this.deleteTemporaryProactiveConversation(tempConversation).catch((error: unknown) => {
          logger.warn(
            'affinity temporary proactive conversation cleanup failed: planId=%s conversationId=%s error=%s',
            String(args.plan.id),
            String(tempConversation?.id ?? '<unknown>'),
            error instanceof Error ? error.message : String(error),
          );
        });
      }
    }
  }

  private async deliverRandomGeneration(args: {
    plan: AffinityRandomPlanRecord;
    scope: AffinityScopeConfigRecord;
    bot: AffinityBotLike;
    channelId: string;
    generation: RandomGenerationWithTransport;
  }): Promise<RandomDeliveryResult> {
    const { plan, scope, bot, channelId, generation } = args;
    const transportPlan = generation.transportPlan ?? null;
    if (!transportPlan) {
      return { sent: false, messageText: null, historyText: null, receipts: [], reason: 'missing_transport_plan' };
    }

    const conversationId = normalizeText(plan.conversationId) || normalizeText(scope.conversationId);
    const [sourceConversation] = conversationId
      ? await this.database.get('chatluna_conversation', { id: conversationId }) as ChatLunaConversationRecord[]
      : [];
    const session = this.createProactiveSession({
      bot,
      scope,
      plan,
      channelId,
      sourceConversation: sourceConversation ?? null,
    });
    const delivery = await deliverStandaloneReplyPlan({
      runtime: this.getProactiveVoiceRuntime(),
      session,
      plan: transportPlan,
      modalityPolicy: null,
    });
    const committedHistoryText = normalizeText(delivery.historyText);
    const hasConfirmedReceipt = delivery.receipts.length > 0;
    if (delivery.status === 'delivered' || delivery.status === 'failed_after_partial_send') {
      if (!hasConfirmedReceipt || !committedHistoryText) {
        return {
          sent: false,
          messageText: null,
          historyText: null,
          receipts: delivery.receipts,
          reason: 'delivery_commit_missing',
        };
      }
      return {
        sent: true,
        messageText: committedHistoryText,
        historyText: committedHistoryText,
        receipts: delivery.receipts,
        reason: delivery.status === 'delivered' ? null : delivery.status,
      };
    }
    return {
      sent: false,
      messageText: null,
      historyText: committedHistoryText || null,
      receipts: delivery.receipts,
      reason: delivery.status,
    };
  }

  private async beginRandomDelivery(
    plan: AffinityRandomPlanRecord,
    generation: RandomGenerationWithTransport,
    materialJson: string | null,
    now: number,
  ): Promise<string> {
    const attemptId = `affinity-random-plan:${plan.id}`;
    await this.database.set('affinity_random_plan', { id: plan.id }, {
      deliveryState: 'dispatching',
      deliveryAttemptId: attemptId,
      deliveryReceipt: null,
      deliveryConfirmedAt: null,
      deliveryPayloadJson: stringifyJson({
        version: 'v1',
        messageText: normalizeText(generation.message),
        historyText: null,
        materialJson,
        generation: {
          contextSeedSummary: generation.contextSeedSummary,
          eventTypeHint: generation.eventTypeHint,
          memorySummary: generation.memorySummary,
          reason: generation.reason,
          risk: generation.risk,
          outputProtocol: generation.outputProtocol ?? null,
        },
      }),
      updatedAt: now,
    });
    return attemptId;
  }

  private async clearRandomDeliveryCheckpoint(plan: AffinityRandomPlanRecord, now: number): Promise<void> {
    await this.database.set('affinity_random_plan', { id: plan.id }, {
      deliveryState: 'not_started',
      deliveryAttemptId: null,
      deliveryReceipt: null,
      deliveryPayloadJson: null,
      deliveryConfirmedAt: null,
      updatedAt: now,
    });
  }

  private async checkpointConfirmedRandomDelivery(args: {
    plan: AffinityRandomPlanRecord;
    attemptId: string;
    delivery: Extract<RandomDeliveryResult, { sent: true }>;
    generation: RandomGenerationWithTransport;
    materialJson: string | null;
    now: number;
  }): Promise<AffinityConfirmedDeliveryPayload> {
    const payload: AffinityConfirmedDeliveryPayload = {
      version: 'v1',
      messageText: args.delivery.messageText,
      historyText: args.delivery.historyText,
      materialJson: args.materialJson,
      generation: {
        contextSeedSummary: args.generation.contextSeedSummary,
        eventTypeHint: args.generation.eventTypeHint,
        memorySummary: args.generation.memorySummary,
        reason: args.generation.reason,
        risk: args.generation.risk,
        outputProtocol: args.generation.outputProtocol ?? null,
      },
    };
    const receipt = stringifyJson(args.delivery.receipts);
    await this.database.set('affinity_random_plan', { id: args.plan.id }, {
      deliveryState: 'confirmed',
      deliveryAttemptId: args.attemptId,
      deliveryReceipt: receipt,
      deliveryPayloadJson: stringifyJson(payload),
      deliveryConfirmedAt: args.now,
      updatedAt: args.now,
    });
    return payload;
  }

  private async checkpointOutcomeUnknownRandomDelivery(args: {
    plan: AffinityRandomPlanRecord;
    attemptId: string;
    delivery: Extract<RandomDeliveryResult, { sent: false }>;
    generation: RandomGenerationWithTransport;
    materialJson: string | null;
    now: number;
  }): Promise<AffinityConfirmedDeliveryPayload | null> {
    const historyText = normalizeText(args.delivery.historyText);
    const hasConfirmedUnits = args.delivery.receipts.length > 0 && Boolean(historyText);
    const payload: AffinityConfirmedDeliveryPayload | null = hasConfirmedUnits
      ? {
          version: 'v1',
          messageText: historyText,
          historyText,
          materialJson: args.materialJson,
          generation: {
            contextSeedSummary: args.generation.contextSeedSummary,
            eventTypeHint: args.generation.eventTypeHint,
            memorySummary: args.generation.memorySummary,
            reason: args.generation.reason,
            risk: args.generation.risk,
            outputProtocol: args.generation.outputProtocol ?? null,
          },
        }
      : null;
    await this.database.set('affinity_random_plan', { id: args.plan.id }, {
      status: 'failed',
      deliveryState: 'outcome_unknown',
      deliveryAttemptId: args.attemptId,
      deliveryReceipt: hasConfirmedUnits ? stringifyJson(args.delivery.receipts) : null,
      ...(payload ? { deliveryPayloadJson: stringifyJson(payload) } : {}),
      deliveryConfirmedAt: hasConfirmedUnits ? args.now : null,
      skipReason: 'delivery_outcome_unknown',
      messageText: null,
      sentAt: null,
      updatedAt: args.now,
    });
    return payload;
  }

  private async ensureRandomOpenThread(args: {
    plan: AffinityRandomPlanRecord;
    payload: AffinityConfirmedDeliveryPayload;
    now: number;
  }): Promise<void> {
    const [existing] = await this.database.get('affinity_open_thread', {
      sourcePlanId: args.plan.id,
    });
    if (existing?.id) return;
    await this.database.create('affinity_open_thread', {
      sourcePlanId: args.plan.id,
      characterId: CHARACTER_ID,
      scopeKind: args.plan.scopeKind,
      scopeId: args.plan.scopeId,
      userKey: null,
      threadType: `random:${args.plan.direction}`,
      title: `random:${args.plan.direction}`,
      summary: args.payload.messageText,
      status: 'open',
      payloadJson: stringifyJson({
        planId: args.plan.id,
        direction: args.plan.direction,
        contextSeedSummary: args.payload.generation.contextSeedSummary,
        eventTypeHint: args.payload.generation.eventTypeHint,
        reason: args.payload.generation.reason,
      }),
      expiresAt: args.now + RANDOM_OPEN_THREAD_TTL_MS,
      createdAt: args.now,
      updatedAt: args.now,
    });
  }

  private async materializeRandomDeliveryArtifacts(args: {
    plan: AffinityRandomPlanRecord;
    scope: AffinityScopeConfigRecord;
    payload: AffinityConfirmedDeliveryPayload;
    now: number;
  }) {
    const { plan, scope, payload, now } = args;
    const generation = confirmedDeliveryGeneration(payload);
    await this.ensureRandomOpenThread({ plan, payload, now });
    await this.persistRandomMemory({
      plan,
      scope,
      messageText: payload.messageText,
      generation,
      materialJson: payload.materialJson,
      now,
    });
    const historySync = await this.syncRandomMessageToChatHistory({
      plan,
      scope,
      messageText: payload.messageText,
      generation,
      materialJson: payload.materialJson,
    });
    if (!historySync.synced) {
      throw new Error(`affinity confirmed delivery history reconciliation failed: ${historySync.reason ?? 'unknown'}`);
    }

    return { generation, historySync };
  }

  private async materializeConfirmedRandomDelivery(args: {
    plan: AffinityRandomPlanRecord;
    scope: AffinityScopeConfigRecord;
    payload: AffinityConfirmedDeliveryPayload;
    now: number;
  }): Promise<void> {
    const { plan, payload, now } = args;
    const { generation, historySync } = await this.materializeRandomDeliveryArtifacts(args);

    await this.database.set('affinity_random_plan', { id: plan.id }, {
      status: 'sent',
      deliveryState: 'reconciled',
      messageText: payload.messageText,
      skipReason: null,
      sentAt: plan.deliveryConfirmedAt ?? now,
      updatedAt: now,
    });
    await this.writeAudit('random_message_generated', {
      scopeKind: plan.scopeKind,
      scopeId: plan.scopeId,
      detail: {
        planId: plan.id,
        direction: plan.direction,
        eventTypeHint: generation.eventTypeHint,
        contextSeedSummary: generation.contextSeedSummary,
        reason: generation.reason,
      },
    });
    await this.writeAudit('random_plan_sent', {
      scopeKind: plan.scopeKind,
      scopeId: plan.scopeId,
      detail: {
        planId: plan.id,
        direction: plan.direction,
        historySynced: true,
        historySkipReason: null,
        conversationId: historySync.conversationId ?? null,
      },
    });
  }

  private async markRandomDeliveryReconciliationFailed(
    plan: AffinityRandomPlanRecord,
    error: unknown,
    now: number,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.database.set('affinity_random_plan', { id: plan.id }, {
      deliveryState: 'reconciliation_failed',
      skipReason: `delivery_reconciliation_failed: ${message}`,
      updatedAt: now,
    });
    await this.writeAudit('random_history_sync_skipped', {
      scopeKind: plan.scopeKind,
      scopeId: plan.scopeId,
      detail: {
        planId: plan.id,
        direction: plan.direction,
        reason: 'delivery_reconciliation_failed',
        error: message,
      },
    });
  }

  private async reconcileInterruptedRandomDeliveries(now: number): Promise<void> {
    const plans = await this.database.get('affinity_random_plan', {
      characterId: CHARACTER_ID,
    }) as AffinityRandomPlanRecord[];
    for (const plan of plans) {
      if (plan.deliveryState === 'dispatching') {
        await this.database.set('affinity_random_plan', { id: plan.id }, {
          status: 'failed',
          deliveryState: 'outcome_unknown',
          skipReason: 'delivery_outcome_unknown_after_restart',
          updatedAt: now,
        });
        await this.writeAudit('random_message_generation_skipped', {
          scopeKind: plan.scopeKind,
          scopeId: plan.scopeId,
          detail: {
            planId: plan.id,
            direction: plan.direction,
            reason: 'delivery_outcome_unknown_after_restart',
          },
        });
        continue;
      }
      if (plan.deliveryState === 'outcome_unknown') {
        if (!plan.deliveryReceipt?.trim() || plan.sentAt) continue;
        const [scope] = await this.database.get('affinity_scope_config', {
          characterId: CHARACTER_ID,
          scopeKind: plan.scopeKind,
          scopeId: plan.scopeId,
        }) as AffinityScopeConfigRecord[];
        if (!scope) {
          await this.database.set('affinity_random_plan', { id: plan.id }, {
            skipReason: 'delivery_outcome_unknown_reconciliation_failed: affinity scope is unavailable',
            updatedAt: now,
          });
          continue;
        }
        try {
          parseConfirmedDeliveryReceipts(plan.deliveryReceipt);
          const payload = parseConfirmedDeliveryPayload(plan.deliveryPayloadJson);
          await this.materializeRandomDeliveryArtifacts({ plan, scope, payload, now });
          await this.database.set('affinity_random_plan', { id: plan.id }, {
            status: 'failed',
            deliveryState: 'outcome_unknown',
            messageText: payload.messageText,
            skipReason: 'delivery_outcome_unknown',
            sentAt: plan.deliveryConfirmedAt ?? now,
            updatedAt: now,
          });
        } catch (error) {
          await this.database.set('affinity_random_plan', { id: plan.id }, {
            status: 'failed',
            deliveryState: 'outcome_unknown',
            skipReason: `delivery_outcome_unknown_reconciliation_failed: ${error instanceof Error ? error.message : String(error)}`,
            updatedAt: now,
          });
        }
        continue;
      }
      if (plan.deliveryState !== 'confirmed' && plan.deliveryState !== 'reconciliation_failed') continue;
      const [scope] = await this.database.get('affinity_scope_config', {
        characterId: CHARACTER_ID,
        scopeKind: plan.scopeKind,
        scopeId: plan.scopeId,
      }) as AffinityScopeConfigRecord[];
      if (!scope) {
        await this.markRandomDeliveryReconciliationFailed(plan, new Error('affinity scope is unavailable'), now);
        continue;
      }
      try {
        if (!plan.deliveryAttemptId?.trim() || !plan.deliveryConfirmedAt) {
          throw new Error('affinity confirmed delivery checkpoint is incomplete.');
        }
        parseConfirmedDeliveryReceipts(plan.deliveryReceipt);
        const payload = parseConfirmedDeliveryPayload(plan.deliveryPayloadJson);
        await this.materializeConfirmedRandomDelivery({ plan, scope, payload, now });
      } catch (error) {
        await this.markRandomDeliveryReconciliationFailed(plan, error, now);
      }
    }
  }

  private isManualRandomPlan(plan: AffinityRandomPlanRecord): boolean {
    return plan.triggerKind === 'manual';
  }

  private async resolvePlanScope(plan: AffinityRandomPlanRecord, manual: boolean, now: number): Promise<AffinityScopeConfigRecord | null> {
    const [scope] = await this.database.get('affinity_scope_config', {
      characterId: CHARACTER_ID,
      scopeKind: plan.scopeKind,
      scopeId: plan.scopeId,
    }) as AffinityScopeConfigRecord[];
    if (scope) return scope;
    if (!manual) return null;
    return {
      id: 0,
      characterId: CHARACTER_ID,
      scopeKind: plan.scopeKind,
      scopeId: plan.scopeId,
      enabled: 1,
      proactiveEnabled: 1,
      label: null,
      platform: normalizeText(plan.platform) || null,
      botSelfId: normalizeText(plan.botSelfId) || null,
      channelId: normalizeText(plan.channelId) || plan.scopeId,
      guildId: plan.scopeKind === 'group' ? normalizeText(plan.guildId) || plan.scopeId : normalizeText(plan.guildId) || null,
      conversationId: normalizeText(plan.conversationId) || null,
      updatedAt: now,
    };
  }

  private async fireRandomPlan(plan: AffinityRandomPlanRecord, settings: AffinitySettings, now: number): Promise<void> {
    const manual = this.isManualRandomPlan(plan);
    const scope = await this.resolvePlanScope(plan, manual, now);
    if (!scope || (!manual && (Number(scope.enabled) !== 1 || Number(scope.proactiveEnabled) !== 1))) {
      await this.skipPlan(plan, 'scope_disabled', now);
      return;
    }
    const channelId = normalizeText(plan.channelId) || normalizeText(scope.channelId) || scope.scopeId;
    if (!channelId) {
      await this.skipPlan(plan, 'missing_channel', now);
      return;
    }
    const bot = this.resolveBot(plan, scope);
    if (!bot) {
      await this.skipPlan(plan, 'bot_unavailable', now);
      return;
    }
    const prepared = await this.buildRandomGenerationInput({ plan, scope, bot, settings, now, manual });
    if (!prepared.input) {
      await this.skipPlan(plan, prepared.skipReason ?? 'random_context_unavailable', now);
      return;
    }
    let generation: RandomGenerationWithTransport;
    try {
      generation = await this.generateProactiveReply({
        plan,
        scope,
        bot,
        input: prepared.input,
        channelId,
      });
    } catch (error) {
      await this.failPlan(plan, error instanceof Error ? error.message : String(error), now);
      return;
    }
    if (!generation.shouldSend || !generation.message) {
      await this.writeAudit('random_message_generation_skipped', {
        scopeKind: plan.scopeKind,
        scopeId: plan.scopeId,
        detail: {
          planId: plan.id,
          direction: plan.direction,
          reason: generation.skipReason ?? generation.reason,
          risk: generation.risk,
        },
      });
      await this.skipPlan(plan, generation.skipReason ?? generation.reason ?? 'random_generation_skipped', now);
      return;
    }
    const deliveryAttemptId = await this.beginRandomDelivery(plan, generation, prepared.materialJson, now);
    let delivery: RandomDeliveryResult;
    try {
      delivery = await this.deliverRandomGeneration({
        plan,
        scope,
        bot,
        channelId,
        generation,
      });
    } catch (error) {
      await this.database.set('affinity_random_plan', { id: plan.id }, {
        status: 'failed',
        deliveryState: 'outcome_unknown',
        skipReason: `delivery_outcome_unknown: ${error instanceof Error ? error.message : String(error)}`,
        updatedAt: now,
      });
      return;
    }
    if (!delivery.sent) {
      const deliveryReason = delivery.reason;
      if (deliveryReason === 'outcome_unknown') {
        const payload = await this.checkpointOutcomeUnknownRandomDelivery({
          plan,
          attemptId: deliveryAttemptId,
          delivery,
          generation,
          materialJson: prepared.materialJson,
          now,
        });
        if (payload) {
          try {
            await this.materializeRandomDeliveryArtifacts({ plan, scope, payload, now });
            await this.database.set('affinity_random_plan', { id: plan.id }, {
              status: 'failed',
              deliveryState: 'outcome_unknown',
              messageText: payload.messageText,
              skipReason: 'delivery_outcome_unknown',
              sentAt: now,
              updatedAt: now,
            });
          } catch (error) {
            await this.database.set('affinity_random_plan', { id: plan.id }, {
              skipReason: `delivery_outcome_unknown_reconciliation_failed: ${error instanceof Error ? error.message : String(error)}`,
              updatedAt: now,
            });
          }
        }
        await this.writeAudit('random_message_generation_skipped', {
          scopeKind: plan.scopeKind,
          scopeId: plan.scopeId,
          detail: {
            planId: plan.id,
            direction: plan.direction,
            reason: 'delivery_outcome_unknown',
            risk: generation.risk,
          },
        });
        return;
      }
      await this.clearRandomDeliveryCheckpoint(plan, now);
      if (!manual && deliveryReason === 'transport_unavailable') {
        const requeued = await this.requeuePlanAfterTransportUnavailable({
          plan,
          settings,
          now,
          risk: generation.risk,
        });
        if (requeued) return;
      }
      await this.writeAudit('random_message_generation_skipped', {
        scopeKind: plan.scopeKind,
        scopeId: plan.scopeId,
        detail: {
          planId: plan.id,
          direction: plan.direction,
          reason: deliveryReason,
          risk: generation.risk,
        },
      });
      await this.skipPlan(plan, deliveryReason, now);
      return;
    }
    const payload = await this.checkpointConfirmedRandomDelivery({
      plan,
      attemptId: deliveryAttemptId,
      delivery,
      generation,
      materialJson: prepared.materialJson,
      now,
    });
    const checkpointedPlan: AffinityRandomPlanRecord = {
      ...plan,
      deliveryState: 'confirmed',
      deliveryAttemptId,
      deliveryReceipt: stringifyJson(delivery.receipts),
      deliveryPayloadJson: stringifyJson(payload),
      deliveryConfirmedAt: now,
    };
    try {
      await this.materializeConfirmedRandomDelivery({
        plan: checkpointedPlan,
        scope,
        payload,
        now,
      });
    } catch (error) {
      await this.markRandomDeliveryReconciliationFailed(checkpointedPlan, error, now);
    }
  }

  private async syncRandomMessageToChatHistory(args: {
    plan: AffinityRandomPlanRecord;
    scope: AffinityScopeConfigRecord;
    messageText: string;
    generation: AffinityRandomGenerationResult;
    materialJson: string | null;
  }): Promise<{ synced: boolean; reason?: string; conversationId?: string }> {
    const { plan, scope, messageText, generation, materialJson } = args;
    const conversationId = normalizeText(plan.conversationId) || normalizeText(scope.conversationId);
    if (!conversationId) {
      await this.writeRandomHistorySyncAudit('random_history_sync_skipped', plan, {
        reason: 'missing_conversation_id',
      });
      return { synced: false, reason: 'missing_conversation_id' };
    }

    try {
      const recordId = `affinity-random-plan:${plan.id}`;
      const writer = await this.resolveChatHistoryWriter(conversationId);
      if (!writer.ok) {
        await this.writeRandomHistorySyncAudit('random_history_sync_skipped', plan, {
          reason: writer.reason,
          conversationId: writer.conversationId ?? conversationId,
        });
        return {
          synced: false,
          reason: writer.reason,
          conversationId: writer.conversationId ?? conversationId,
        };
      }

      const historyContent = normalizeText(generation.deliveryHistoryText) || messageText;
      await writer.addMessages([
        new AIMessage({
          content: historyContent,
          id: recordId,
          response_metadata: {
            chatluna: {
              recordId,
            },
          },
          additional_kwargs: {
            qqbot_affinity_random_event: {
              version: 'v1',
              characterId: CHARACTER_ID,
              planId: plan.id,
              direction: plan.direction,
              scopeKind: plan.scopeKind,
              scopeId: plan.scopeId,
              visibleText: messageText,
              deliveryHistoryText: generation.deliveryHistoryText ?? null,
              outputProtocol: generation.outputProtocol ?? null,
              contextSeedSummary: generation.contextSeedSummary,
              eventTypeHint: generation.eventTypeHint,
              material: materialJson ? parseGeneratedJson(materialJson, 'affinity random materialJson') : null,
            },
          },
        }),
      ]);
      await this.writeRandomHistorySyncAudit('random_history_synced', plan, {
        conversationId: writer.conversationId,
      });
      return { synced: true, conversationId: writer.conversationId };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(
        'affinity random history sync skipped: planId=%s conversationId=%s error=%s',
        plan.id,
        conversationId,
        errorMessage,
      );
      await this.writeRandomHistorySyncAudit('random_history_sync_skipped', plan, {
        reason: 'write_failed',
        conversationId,
        error: errorMessage,
      });
      return { synced: false, reason: 'write_failed', conversationId };
    }
  }

  private resolveBot(plan: AffinityRandomPlanRecord, scope: AffinityScopeConfigRecord): AffinityBotLike | null {
    const bots = this.getBots();
    const platform = normalizeText(plan.platform) || normalizeText(scope.platform);
    const botSelfId = normalizeText(plan.botSelfId) || normalizeText(scope.botSelfId);
    return (
      bots.find((bot) => (!platform || bot.platform === platform) && (!botSelfId || bot.selfId === botSelfId)) ??
      bots.find((bot) => !platform || bot.platform === platform) ??
      bots[0] ??
      null
    );
  }

  private resolveTransportRetryAt(settings: AffinitySettings, now: number): number | null {
    const dayStart = getShanghaiDayStartMs(now);
    const windowEnd = dayStart + Math.floor(settings.randomWindowEndHour) * 3_600_000;
    const latestRetryAt = windowEnd - 1;
    if (latestRetryAt <= now) return null;
    return Math.min(now + RANDOM_TRANSPORT_RETRY_DELAY_MS, latestRetryAt);
  }

  private async requeuePlanAfterTransportUnavailable(args: {
    plan: AffinityRandomPlanRecord;
    settings: AffinitySettings;
    now: number;
    risk: string | null;
  }): Promise<boolean> {
    const retryAt = this.resolveTransportRetryAt(args.settings, args.now);
    if (retryAt == null) return false;
    await this.database.set('affinity_random_plan', { id: args.plan.id }, {
      status: 'pending',
      scheduledAt: retryAt,
      messageText: null,
      skipReason: 'transport_unavailable',
      sentAt: null,
      updatedAt: args.now,
    });
    await this.writeAudit('random_plan_requeued', {
      scopeKind: args.plan.scopeKind,
      scopeId: args.plan.scopeId,
      detail: {
        planId: args.plan.id,
        direction: args.plan.direction,
        reason: 'transport_unavailable',
        retryAt,
        delayMs: retryAt - args.now,
        risk: args.risk,
      },
    });
    this.scheduleRefresh();
    return true;
  }

  private async skipPlan(plan: AffinityRandomPlanRecord, reason: string, now: number): Promise<void> {
    await this.database.set('affinity_random_plan', { id: plan.id }, {
      status: 'skipped',
      skipReason: reason,
      updatedAt: now,
    });
    await this.writeAudit('random_plan_skipped', {
      scopeKind: plan.scopeKind,
      scopeId: plan.scopeId,
      detail: { planId: plan.id, reason },
    });
  }

  private async writeRandomHistorySyncAudit(
    eventType: 'random_history_synced' | 'random_history_sync_skipped',
    plan: AffinityRandomPlanRecord,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.writeAudit(eventType, {
        scopeKind: plan.scopeKind,
        scopeId: plan.scopeId,
        detail: {
          planId: plan.id,
          direction: plan.direction,
          ...detail,
        },
      });
    } catch (error) {
      logger.warn('affinity random history sync audit failed: %s', error instanceof Error ? error.message : String(error));
    }
  }

  private async writePanelHistorySyncAudit(
    eventType: 'panel_history_synced' | 'panel_history_sync_skipped',
    session: Session,
    view: AffinityPanelView,
    scope: AffinityScopeConfigRecord | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.writeAudit(eventType, {
        userKey: userKeyFromSession(session) ?? view.userKey,
        scopeKind: scope?.scopeKind ?? null,
        scopeId: scope?.scopeId ?? null,
        detail: {
          characterId: view.characterId,
          lineKind: view.lineKind,
          fixedLine: view.fixedLine,
          triggerMessageId: normalizeText(session.messageId) || null,
          ...detail,
        },
      });
    } catch (error) {
      logger.warn('affinity panel history sync audit failed: %s', error instanceof Error ? error.message : String(error));
    }
  }

  private async writeAudit(
    eventType: AffinityAuditRecord['eventType'],
    args: {
      userKey?: string | null;
      scopeKind?: AffinityScopeKind | null;
      scopeId?: string | null;
      detail?: unknown;
    },
  ): Promise<void> {
    await this.database.create('affinity_audit', {
      eventType,
      characterId: CHARACTER_ID,
      userKey: args.userKey ?? null,
      scopeKind: args.scopeKind ?? null,
      scopeId: args.scopeId ?? null,
      detail: args.detail == null ? null : stringifyJson(args.detail),
      createdAt: Date.now(),
    });
  }
}

export function createUnavailableAffinityState(): AffinityStateSummary {
  return {
    available: false,
    settings: DEFAULT_SETTINGS,
    scopes: [],
    users: [],
    recentEvents: [],
    randomPlans: [],
    audit: [],
  };
}

export async function affinityMutationResponse(service: AffinityServiceLike, ok = true): Promise<AffinityMutationResponse> {
  return {
    ok,
    affinity: await service.getAdminState(),
  };
}
