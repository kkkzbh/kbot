import { createHash } from 'node:crypto';
import {
  redactDataUrls,
  redactSensitiveUrls,
  summarizeDataUrl,
  type ModelContextMessage,
  type ModelContextPayload,
} from 'koishi-plugin-chatluna/context-trace';
import type { ModelUsagePayload } from 'koishi-plugin-chatluna/llm-core/platform/usage';
import type {
  AdminJsonValue,
  ContextSnapshot,
  ContextSnapshotResponse,
  ContextTarget,
} from '../../admin/contracts/index.js';

export const MODEL_CONTEXT_MAX_SESSIONS = 32;
export const MODEL_CONTEXT_MAX_ITEM_BYTES = 2 * 1024 * 1024;
export const MODEL_CONTEXT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const MODEL_CONTEXT_PENDING_TTL_MS = 2 * 60 * 1000;
export type { ModelContextPayload };

type SnapshotEntry = {
  sequence: number;
  size: number;
  snapshot: ContextSnapshot;
};

type PendingContext = {
  sequence: number;
  expiresAt: number;
  conversationId: string;
};

type PendingUsage = {
  expiresAt: number;
  usage: ModelUsagePayload;
};

type UnavailableEntry = {
  reason: string;
  sequence: number | null;
};

type ConversationRow = {
  id?: unknown;
  bindingKey?: unknown;
  title?: unknown;
  status?: unknown;
  legacyRoomId?: unknown;
};

type RoomRow = {
  roomId?: unknown;
  roomName?: unknown;
  conversationId?: unknown;
  visibility?: unknown;
};

type RoomGroupRow = {
  roomId?: unknown;
  groupId?: unknown;
};

export type ContextDatabase = {
  get: (table: string, query: Record<string, unknown>) => Promise<unknown[]>;
};

const SECRET_FIELD_NAMES = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'cookies',
  'setcookie',
  'header',
  'headers',
  'apikey',
  'apitoken',
  'token',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'sessionsecret',
  'password',
  'credential',
  'credentials',
  'toolcredential',
  'toolcredentials',
  'secret',
]);

function isSecretFieldName(value: string): boolean {
  const normalized = value.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SECRET_FIELD_NAMES.has(normalized)
    || normalized === 'sig'
    || normalized.includes('credential')
    || normalized.includes('signature')
    || normalized.includes('authorization')
    || normalized.includes('password')
    || normalized.includes('secret')
    || normalized.includes('cookie')
    || normalized.endsWith('token')
    || /^(?:api|access|private|secret)key/.test(normalized);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  const result = Number(value);
  return Number.isInteger(result) && result > 0 ? result : null;
}

function positiveCallOrdinal(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function modelRequestMode(
  value: string | undefined,
): 'chat_completions' | 'responses' | null {
  if (value == null) return null;
  if (value === 'chat_completions' || value === 'responses') return value;
  throw new Error(`unsupported model request mode in context snapshot: ${value}`);
}

function timestamp(value: Date): number {
  const result = value.getTime();
  if (!Number.isFinite(result) || result < 0) {
    throw new Error('model-context createdAt must be a valid date');
  }
  return result;
}

function binaryDescriptor(data: Uint8Array, mimeType: string): AdminJsonValue {
  return {
    kind: 'binary',
    mimeType,
    size: data.byteLength,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

function dataUrlDescriptor(value: string): AdminJsonValue | null {
  const summary = summarizeDataUrl(value);
  if (!summary) return null;
  return {
    kind: 'binary',
    mimeType: summary.mimeType,
    size: summary.size,
    sha256: summary.sha256,
    ...(summary.malformed ? { malformed: true } : {}),
  };
}

export function sanitizeContextValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): AdminJsonValue {
  if (value === undefined) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') {
    return dataUrlDescriptor(value)
      ?? redactSensitiveUrls(redactDataUrls(value));
  }
  if (value instanceof Uint8Array) return binaryDescriptor(value, 'application/octet-stream');
  if (value instanceof ArrayBuffer) {
    return binaryDescriptor(new Uint8Array(value), 'application/octet-stream');
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return { kind: 'redacted', reason: 'cyclic_reference' };
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => sanitizeContextValue(item, seen));
    seen.delete(value);
    return output;
  }
  const output: Record<string, AdminJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSecretFieldName(key)) continue;
    output[key] = sanitizeContextValue(item, seen);
  }
  seen.delete(value);
  return output;
}

const SENSITIVE_SCHEMA_ANNOTATIONS = new Set([
  'const',
  'default',
  'example',
  'examples',
]);

function sanitizeContextSchemaNode(
  value: unknown,
  seen: WeakSet<object>,
  propertyNames: boolean,
): AdminJsonValue {
  if (value === undefined) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') {
    return dataUrlDescriptor(value)
      ?? redactSensitiveUrls(redactDataUrls(value));
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return { kind: 'redacted', reason: 'cyclic_reference' };
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => sanitizeContextSchemaNode(item, seen, false));
    seen.delete(value);
    return output;
  }
  const output: Record<string, AdminJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_SCHEMA_ANNOTATIONS.has(key)) continue;
    if (!propertyNames && isSecretFieldName(key)) continue;
    output[key] = sanitizeContextSchemaNode(
      item,
      seen,
      ['properties', 'patternProperties', '$defs', 'definitions'].includes(key),
    );
  }
  seen.delete(value);
  return output;
}

export function sanitizeContextSchema(value: unknown): AdminJsonValue {
  return sanitizeContextSchemaNode(value, new WeakSet(), false);
}

function snapshotMessage(
  message: ModelContextMessage,
  index: number,
  included: boolean,
  dropReason?: string,
): ContextSnapshot['messages'][number] {
  return {
    id: message.id,
    index,
    role: message.role,
    ...(message.name ? { name: message.name } : {}),
    content: sanitizeContextValue(message.content),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            ...(call.args === undefined ? {} : { args: sanitizeContextValue(call.args) }),
          })),
        }
      : {}),
    stage: message.stage,
    source: message.source.name,
    ...(message.source.path ? { sourcePath: message.source.path } : {}),
    ...(message.source.authority ? { authority: message.source.authority } : {}),
    ...(message.source.trust ? { trust: message.source.trust } : {}),
    ...(message.source.ttl ? { ttl: message.source.ttl } : {}),
    estimatedTokens: message.tokenEstimate,
    included,
    ...(dropReason ? { dropReason } : {}),
  };
}

type ResolvedModelContextPayload = ModelContextPayload & {
  presetId: string;
  presetResolution: NonNullable<ModelContextPayload['presetResolution']>;
};

const PRESET_RESOLUTION_SOURCES = new Set([
  'fixed',
  'conversation',
  'presetLane',
  'constraintDefault',
  'globalDefault',
]);

function hasResolvedPreset(
  payload: ModelContextPayload,
): payload is ResolvedModelContextPayload {
  const resolution = payload.presetResolution;
  return typeof payload.presetId === 'string'
    && payload.presetId.length > 0
    && resolution != null
    && resolution.presetId === payload.presetId
    && PRESET_RESOLUTION_SOURCES.has(resolution.source)
    && resolution.bindingKey.length > 0;
}

function buildSnapshot(payload: ResolvedModelContextPayload): ContextSnapshot {
  const assembledById = new Map(payload.assembledMessages.map((message, index) => [
    message.id,
    { message, index },
  ]));
  const finalById = new Map(payload.finalMessages.map((message, index) => [
    message.id,
    { message, index },
  ]));
  const messages: ContextSnapshot['messages'] = [];
  const seen = new Set<string>();

  for (const trace of payload.trace) {
    if (trace.role === 'document' && trace.status === 'included') continue;
    const id = trace.messageId ?? trace.id;
    const final = finalById.get(id);
    const assembled = assembledById.get(id);
    const semantic = final?.message ?? assembled?.message;
    const included = trace.status === 'included';
    messages.push({
      id,
      index: trace.finalOrder ?? trace.assembledOrder ?? final?.index ?? assembled?.index ?? messages.length,
      role: trace.role,
      ...(semantic?.name ? { name: semantic.name } : {}),
      content: sanitizeContextValue(trace.content),
      ...(semantic?.toolCallId ? { toolCallId: semantic.toolCallId } : {}),
      ...(semantic?.toolCalls
        ? {
            toolCalls: semantic.toolCalls.map((call) => ({
              ...(call.id ? { id: call.id } : {}),
              name: call.name,
              ...(call.args === undefined ? {} : { args: sanitizeContextValue(call.args) }),
            })),
          }
        : {}),
      stage: trace.stage,
      source: trace.source.name,
      ...(trace.source.path ? { sourcePath: trace.source.path } : {}),
      ...(trace.source.authority ? { authority: trace.source.authority } : {}),
      ...(trace.source.trust ? { trust: trace.source.trust } : {}),
      ...(trace.source.ttl ? { ttl: trace.source.ttl } : {}),
      estimatedTokens: trace.tokenEstimate,
      included,
      ...(!included ? { dropReason: trace.reason ?? 'not_included' } : {}),
    });
    seen.add(id);
  }

  for (const [id, { message, index }] of assembledById) {
    if (seen.has(id)) continue;
    const included = finalById.has(id);
    messages.push(snapshotMessage(
      message,
      finalById.get(id)?.index ?? index,
      included,
      included ? undefined : 'model_crop',
    ));
  }

  messages.sort((left, right) => {
    if (left.included !== right.included) return left.included ? -1 : 1;
    return left.index - right.index;
  });

  return {
    requestId: payload.requestId,
    callId: payload.callId,
    callOrdinal: payload.callOrdinal,
    conversationId: payload.conversationId,
    createdAt: timestamp(payload.createdAt),
    platform: payload.platform,
    model: payload.canonicalModel ?? payload.model,
    transportModel: payload.transportModel ?? null,
    requestMode: modelRequestMode(payload.requestMode),
    stream: payload.stream,
    semanticStage: payload.semanticStage,
    effectivePresetId: payload.presetId ?? null,
    presetResolution: payload.presetResolution,
    presetRevision: payload.presetRevision ?? null,
    contextSize: payload.estimatedTokens,
    contextRatio: payload.contextLimit > 0
      ? payload.estimatedTokens / payload.contextLimit
      : null,
    contextLimit: payload.contextLimit,
    modelContextSize: payload.modelContextSize,
    estimatedTokens: payload.estimatedTokens,
    providerInputTokens: null,
    providerOutputTokens: null,
    providerUsageEstimated: null,
    assembledCount: payload.assembledCount,
    finalCount: payload.finalCount,
    truncated: payload.truncated,
    messages,
    tools: payload.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: sanitizeContextSchema(tool.schema),
    })),
  };
}

function modelUsageCallIdentity(
  payload: ModelUsagePayload,
): { callId: string; callOrdinal: number } | null {
  const callId = nonEmptyString(payload.context?.callId);
  const callOrdinal = payload.context?.callOrdinal;
  if (
    !callId
    || callId !== payload.context?.callId
    || !Number.isInteger(callOrdinal)
    || (callOrdinal ?? 0) <= 0
  ) {
    return null;
  }
  return { callId, callOrdinal: callOrdinal as number };
}

function assertUsageCallOrdinal(
  payload: ModelUsagePayload,
  expected: number,
  callId: string,
): void {
  if (payload.context?.callOrdinal !== expected) {
    throw new Error(
      `model-usage callOrdinal mismatch for callId ${callId}: expected ${expected}, received ${payload.context?.callOrdinal ?? 'missing'}`,
    );
  }
}

export class ModelContextSnapshotStore {
  private readonly snapshots = new Map<string, SnapshotEntry>();
  private readonly unavailable = new Map<string, UnavailableEntry>();
  private readonly pendingContexts = new Map<string, PendingContext>();
  private readonly pendingUsages = new Map<string, PendingUsage>();
  private totalBytes = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly diagnostic: (message: string) => void = () => undefined,
  ) {}

  ingestContext(payload: ModelContextPayload): void {
    this.prunePending();
    if (!hasResolvedPreset(payload)) {
      this.markUnavailable(
        payload.conversationId,
        '最近一次模型上下文事件缺少有效 preset resolution，无法确认实际预设来源。',
        positiveCallOrdinal(payload.callOrdinal),
        nonEmptyString(payload.callId),
      );
      this.diagnostic(
        `ignored model-context without preset resolution: requestId=${payload.requestId}`,
      );
      return;
    }
    const callId = nonEmptyString(payload.callId);
    if (
      !callId
      || callId !== payload.callId
      || !Number.isInteger(payload.callOrdinal)
      || payload.callOrdinal <= 0
    ) {
      this.markUnavailable(
        payload.conversationId,
        '最近一次模型上下文事件缺少有效 callId/callOrdinal，无法建立调用实况。',
        positiveCallOrdinal(payload.callOrdinal),
        nonEmptyString(payload.callId),
      );
      this.diagnostic(`ignored model-context without valid call identity: requestId=${payload.requestId}`);
      return;
    }
    if (this.pendingContexts.has(callId)) {
      throw new Error(`duplicate model-context callId: ${callId}`);
    }
    const snapshot = buildSnapshot(payload);
    const pending: PendingContext = {
      sequence: snapshot.callOrdinal,
      expiresAt: this.now() + MODEL_CONTEXT_PENDING_TTL_MS,
      conversationId: snapshot.conversationId,
    };
    if (!this.store(pending.sequence, snapshot)) return;

    const usage = this.pendingUsages.get(callId);
    if (usage) {
      assertUsageCallOrdinal(usage.usage, pending.sequence, callId);
      this.pendingUsages.delete(callId);
      this.applyUsage(pending, usage.usage);
      return;
    }

    this.pendingContexts.set(callId, pending);
  }

  ingestUsage(payload: ModelUsagePayload): void {
    if (payload.callType !== 'llm') return;
    const identity = modelUsageCallIdentity(payload);
    if (!identity) {
      const conversationId = nonEmptyString(payload.context?.conversationId);
      if (conversationId) {
        this.markUnavailable(
          conversationId,
          '最近一次 LLM usage 缺少有效 callId/callOrdinal，未与上下文实况关联。',
          positiveCallOrdinal(payload.context?.callOrdinal),
          nonEmptyString(payload.context?.callId),
        );
      }
      this.diagnostic(
        `ignored llm model-usage without valid call identity: requestId=${nonEmptyString(payload.context?.requestId) ?? 'unknown'}`,
      );
      return;
    }
    const { callId, callOrdinal } = identity;
    this.prunePending();
    const context = this.pendingContexts.get(callId);
    if (context) {
      assertUsageCallOrdinal(payload, context.sequence, callId);
      this.pendingContexts.delete(callId);
      this.applyUsage(context, payload);
      return;
    }

    if (this.pendingUsages.has(callId)) {
      throw new Error(`duplicate model-usage callId: ${callId}`);
    }
    this.pendingUsages.set(callId, {
      expiresAt: this.now() + MODEL_CONTEXT_PENDING_TTL_MS,
      usage: payload,
    });
  }

  latest(conversationId: string): ContextSnapshotResponse {
    this.prunePending();
    const entry = this.snapshots.get(conversationId);
    if (!entry) {
      return {
        snapshot: null,
        unavailableReason: this.unavailable.get(conversationId)?.reason
          ?? '该会话还没有 cutover 后的模型上下文实况。',
      };
    }
    this.snapshots.delete(conversationId);
    this.snapshots.set(conversationId, entry);
    return { snapshot: structuredClone(entry.snapshot), unavailableReason: null };
  }

  latestContextLimit(model: string): number | null {
    let latest: SnapshotEntry | null = null;
    for (const entry of this.snapshots.values()) {
      const snapshot = entry.snapshot;
      if (snapshot.model === model || snapshot.transportModel === model) {
        if (!latest || entry.sequence > latest.sequence) latest = entry;
      }
    }
    return latest?.snapshot.contextLimit ?? null;
  }

  prunePending(): void {
    const now = this.now();
    for (const [callId, context] of this.pendingContexts) {
      if (context.expiresAt <= now) this.pendingContexts.delete(callId);
    }
    for (const [callId, usage] of this.pendingUsages) {
      if (usage.expiresAt <= now) this.pendingUsages.delete(callId);
    }
  }

  private applyUsage(context: PendingContext, payload: ModelUsagePayload): void {
    const current = this.snapshots.get(context.conversationId);
    if (!current || current.sequence !== context.sequence) return;
    const snapshot: ContextSnapshot = {
      ...current.snapshot,
      providerInputTokens: payload.usageMetadata.input_tokens ?? 0,
      providerOutputTokens: payload.usageMetadata.output_tokens ?? 0,
      providerUsageEstimated: payload.estimated,
    };
    this.store(context.sequence, snapshot);
  }

  private store(sequence: number, snapshot: ContextSnapshot): boolean {
    const conversationId = snapshot.conversationId;
    const previous = this.snapshots.get(conversationId);
    if (previous && previous.sequence > sequence) return false;
    const unavailable = this.unavailable.get(conversationId);
    if (
      unavailable?.sequence != null
      && unavailable.sequence > sequence
    ) {
      return false;
    }
    if (
      previous
      && previous.sequence === sequence
      && previous.snapshot.callId !== snapshot.callId
    ) {
      throw new Error(
        `duplicate model callOrdinal ${sequence} for conversation ${conversationId}`,
      );
    }
    const serialized = JSON.stringify(snapshot);
    const size = Buffer.byteLength(serialized, 'utf8');
    if (previous) {
      this.totalBytes -= previous.size;
      this.snapshots.delete(conversationId);
    }

    if (size > MODEL_CONTEXT_MAX_ITEM_BYTES) {
      this.unavailable.delete(conversationId);
      this.unavailable.set(
        conversationId,
        {
          reason: `最近一次上下文实况超过 ${MODEL_CONTEXT_MAX_ITEM_BYTES} bytes，未保存在管理端内存中。`,
          sequence,
        },
      );
      while (this.unavailable.size > MODEL_CONTEXT_MAX_SESSIONS) {
        const oldest = this.unavailable.keys().next().value as string | undefined;
        if (!oldest) break;
        this.unavailable.delete(oldest);
      }
      return false;
    }

    this.unavailable.delete(conversationId);
    this.snapshots.set(conversationId, { sequence, size, snapshot });
    this.totalBytes += size;
    while (
      this.snapshots.size > MODEL_CONTEXT_MAX_SESSIONS
      || this.totalBytes > MODEL_CONTEXT_MAX_TOTAL_BYTES
    ) {
      const oldest = this.snapshots.entries().next().value as [string, SnapshotEntry] | undefined;
      if (!oldest) break;
      this.snapshots.delete(oldest[0]);
      this.totalBytes -= oldest[1].size;
    }
    return true;
  }

  private markUnavailable(
    conversationId: string,
    reason: string,
    reportedSequence: number | null,
    relatedCallId: string | null = null,
  ): void {
    const snapshot = this.snapshots.get(conversationId);
    const unavailable = this.unavailable.get(conversationId);
    const knownSequences = [
      snapshot?.sequence,
      unavailable?.sequence,
      ...[...this.pendingContexts.values()]
        .filter((context) => context.conversationId === conversationId)
        .map((context) => context.sequence),
      ...[...this.pendingUsages.values()]
        .filter((usage) => (
          nonEmptyString(usage.usage.context?.conversationId) === conversationId
        ))
        .map((usage) => positiveCallOrdinal(usage.usage.context?.callOrdinal)),
    ].filter((value): value is number => value != null);
    const latestKnownSequence = knownSequences.length > 0
      ? Math.max(...knownSequences)
      : null;
    const sequence = reportedSequence
      ?? (latestKnownSequence == null ? null : latestKnownSequence + 1);

    for (const [callId, context] of this.pendingContexts) {
      if (
        context.conversationId === conversationId
        && (sequence == null || context.sequence <= sequence)
      ) {
        this.pendingContexts.delete(callId);
      }
    }
    for (const [callId, usage] of this.pendingUsages) {
      const usageConversationId = nonEmptyString(
        usage.usage.context?.conversationId,
      );
      const usageSequence = positiveCallOrdinal(
        usage.usage.context?.callOrdinal,
      );
      if (
        usageConversationId === conversationId
        && (
          sequence == null
          || usageSequence == null
          || usageSequence <= sequence
        )
      ) {
        this.pendingUsages.delete(callId);
      }
    }
    if (relatedCallId) {
      const context = this.pendingContexts.get(relatedCallId);
      if (
        context
        && (sequence == null || context.sequence <= sequence)
      ) {
        this.pendingContexts.delete(relatedCallId);
      }
      const usage = this.pendingUsages.get(relatedCallId);
      const usageSequence = positiveCallOrdinal(
        usage?.usage.context?.callOrdinal,
      );
      if (
        usage
        && (
          sequence == null
          || usageSequence == null
          || usageSequence <= sequence
        )
      ) {
        this.pendingUsages.delete(relatedCallId);
      }
    }

    if (
      sequence != null
      && (
        (snapshot != null && snapshot.sequence > sequence)
        || (
          unavailable?.sequence != null
          && unavailable.sequence > sequence
        )
      )
    ) {
      return;
    }
    if (snapshot) {
      this.snapshots.delete(conversationId);
      this.totalBytes -= snapshot.size;
    }
    this.unavailable.delete(conversationId);
    this.unavailable.set(conversationId, { reason, sequence });
    while (this.unavailable.size > MODEL_CONTEXT_MAX_SESSIONS) {
      const oldest = this.unavailable.keys().next().value as string | undefined;
      if (!oldest) break;
      this.unavailable.delete(oldest);
    }
  }
}

export async function buildContextTargets(
  database: ContextDatabase,
): Promise<ContextTarget[]> {
  const [conversationValues, roomValues, groupValues] = await Promise.all([
    database.get('chatluna_conversation', {}),
    database.get('chathub_room', {}),
    database.get('chathub_room_group_member', {}),
  ]);
  const conversations = conversationValues as ConversationRow[];
  const rooms = roomValues as RoomRow[];
  const groups = groupValues as RoomGroupRow[];
  const roomByConversation = new Map<string, RoomRow>();
  for (const room of rooms) {
    const conversationId = nonEmptyString(room.conversationId);
    if (conversationId) roomByConversation.set(conversationId, room);
  }
  const groupByRoom = new Map<number, string>();
  for (const group of groups) {
    const roomId = positiveInteger(group.roomId);
    const groupId = nonEmptyString(group.groupId);
    if (roomId && groupId) groupByRoom.set(roomId, groupId);
  }

  return conversations.flatMap((conversation): ContextTarget[] => {
    const conversationId = nonEmptyString(conversation.id);
    const bindingKey = nonEmptyString(conversation.bindingKey);
    const status = nonEmptyString(conversation.status);
    if (!conversationId || !bindingKey || status === 'deleted' || status === 'broken') return [];
    const room = roomByConversation.get(conversationId);
    const roomId = positiveInteger(room?.roomId) ?? positiveInteger(conversation.legacyRoomId);
    const groupId = roomId ? groupByRoom.get(roomId) : undefined;
    const visibility = nonEmptyString(room?.visibility);
    const scope = groupId
      ? `group:${groupId}`
      : visibility
        ? visibility
        : bindingKey.split(':', 1)[0];
    return [{
      conversationId,
      ...(roomId ? { roomId } : {}),
      label: nonEmptyString(room?.roomName)
        ?? nonEmptyString(conversation.title)
        ?? conversationId,
      ...(scope ? { scope } : {}),
    }];
  }).sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
}
