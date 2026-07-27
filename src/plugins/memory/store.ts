import { createHash, randomUUID } from 'node:crypto';
import type {
  MemoryAddress,
  MemoryAssertionType,
  MemoryAudiencePolicy,
  MemoryLedgerCounts,
  MemoryLedgerItem,
  MemoryOutputProtocolId,
  MemoryQueueSummary,
  MemorySensitivity,
  MemoryV2AuditRecord,
  MemoryV2CursorRecord,
  MemoryV2EmbeddingRecord,
  MemoryV2EvidenceRecord,
  MemoryV2EventRecord,
  MemoryV2HeadRecord,
  MemoryV2PayloadRecord,
  MemoryV2SuppressionRecord,
  MemoryV2WorkRecord,
  MemoryWorkStatus,
  MemoryWorkType,
} from '../../types/memory.js';
import {
  MEMORY_LEDGER_SCHEMA_VERSION,
  MEMORY_LEDGER_TABLES,
  assertMemoryLedgerSqliteSchema,
} from './schema.js';
import { asMemoryRuntimeError, MemoryRuntimeError, memoryErrorDetail, type MemoryOperation } from './errors.js';
import { runDeterministicCaptureGuard, type ExtractedMemoryCandidate } from './gates.js';
import { createMemoryExtractLaneKey } from './identity.js';
import {
  MemoryPolicyService,
  parseAudienceContextKeys,
  parseAudienceSnapshots,
  parseCaptureAudienceSubjectKeys,
} from './policy.js';
import type { MemoryConversationTurn } from './providers/schemas.js';
import {
  memoryLexicalProjectionMatches,
  SqliteMemorySearchIndex,
  type MemoryLexicalProjectionRow,
  type MemorySearchIndex,
} from './search-index.js';

export interface StoredConversationRecord {
  id: string;
  latestMessageId?: string | null;
}

export interface StoredMessageRecord {
  id: string;
  role?: string | null;
  parentId?: string | null;
  conversationId?: string | null;
  content?: unknown;
  additional_kwargs?: unknown;
  additional_kwargs_binary?: unknown;
  name?: string | null;
  createdAt?: number | null;
}

export interface ExtractWorkPayload {
  address: MemoryAddress;
  targetSpeakerId: string;
  targetSpeakerName: string | null;
  latestAnchorMessageId: string;
  maxMessages: number;
  capturedAudiences: Array<{
    messageId: string;
    observedAt: number;
    audienceSubjectKeys: string[];
  }>;
}

export interface EmbeddingWorkPayload {
  streamId: string;
  eventId: string;
  revision: number;
  canonicalModel: string;
  modelRevision: number;
  contentHash: string;
}

export type MemoryWorkPayload = ExtractWorkPayload | EmbeddingWorkPayload | Record<string, unknown>;

export interface MemoryEmbeddingIdentity {
  canonicalModel: string;
  modelRevision: number;
}

export interface MemoryDatabaseLike {
  get(
    table: string,
    query: Record<string, unknown>,
    modifiers?: Record<string, unknown>,
  ): Promise<any[]>;
  set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<unknown>;
  create(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>>;
  remove(table: string, query: Record<string, unknown>): Promise<unknown>;
  withTransaction<T>(callback: (database: MemoryDatabaseLike) => Promise<T>): Promise<T>;
}

export interface MemoryPrincipalPatch {
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface MemoryEvidenceInput {
  messageId: string;
  speakerId: string;
  contextKey: string;
  threadId?: string | null;
  captureAudienceSubjectKeys: string[];
  replyToMessageId?: string | null;
  excerpt?: string | null;
  occurredAt: number;
}

export interface AppendAssertionInput {
  streamId?: string;
  idempotencyKey: string;
  assertionType: MemoryAssertionType;
  subjectType: 'user' | 'group' | 'assistant';
  subjectKey: string;
  actorKey: string;
  sourceContextKey: string;
  audiencePolicy: MemoryAudiencePolicy;
  audienceContextKeys: string[];
  audienceSnapshots: Record<string, string[]>;
  sensitivity: MemorySensitivity;
  state: 'active' | 'pendingReview';
  content: string;
  retrievalText: string;
  importance: number;
  confidence: number;
  validFrom?: number | null;
  validUntil?: number | null;
  expiresAt?: number | null;
  evidence: MemoryEvidenceInput[];
  embeddingIdentity?: MemoryEmbeddingIdentity | null;
  causationId?: string | null;
  auditWorkKey?: string | null;
  createdAt?: number;
}

export interface DeterministicDomainMemoryInput {
  address: MemoryAddress;
  content: string;
  retrievalText: string;
  evidenceMessageIds: string[];
  capturedAudiences?: ExtractWorkPayload['capturedAudiences'];
  turns: readonly MemoryConversationTurn[];
  sensitivity: MemorySensitivity;
  importance: number;
  confidence: number;
  validFrom?: number | null;
  validUntil?: number | null;
  expiresAt?: number | null;
  embeddingIdentity?: MemoryEmbeddingIdentity | null;
  createdAt?: number;
}

export interface DeterministicDomainMemoryResult {
  head: MemoryV2HeadRecord;
  laneKey: string;
  workKey: string;
  idempotencyKey: string;
}

export interface ClaimedMemoryWork {
  work: MemoryV2WorkRecord;
  leaseToken: string;
}

export type EmbeddingWorkResolution =
  | {
      state: 'ready';
      payload: EmbeddingWorkPayload;
      text: string;
    }
  | {
      state: 'obsolete';
      reasonCode:
        | 'memory_embedding_identity_superseded'
        | 'memory_embedding_target_superseded';
    };

interface ForgottenSourceIdentity {
  contextKey: string;
  sourceMessageDigest: string;
}

interface ForgetDependencyClosure {
  heads: MemoryV2HeadRecord[];
  sources: ForgottenSourceIdentity[];
}

const FORBIDDEN_AUDIT_KEY = /(?:content|payload|excerpt|summary|title|providerbody|response|token|cookie|secret|password)/iu;
const CANONICAL_MEMORY_REASON_CODES = new Set([
  'attribution_evidence_outside_window',
  'attribution_evidence_audience_missing',
  'attribution_evidence_untrusted',
  'attribution_missing_evidence',
  'attribution_owner_mismatch',
  'attribution_speaker_mismatch',
  'attribution_subject_assistant',
  'attribution_subject_group_shared',
  'attribution_subject_other_speaker',
  'attribution_subject_unknown',
  'candidate_invalid',
  'duplicate',
  'empty_candidate',
  'forgotten-source',
  'group_joke_guard',
  'incorrect-memory',
  'lexical',
  'memory_deletion_generation_changed',
  'memory_embedding_identity_superseded',
  'memory_embedding_superseded',
  'memory_embedding_target_superseded',
  'memory_lease_expired',
  'operator-archive',
  'operator-delete',
  'outdated',
  'pii_guard',
  'privacy-request',
  'provider_drop',
  'quality',
  'quality-review',
  'retention-policy',
  'secret_guard',
  'semantic',
  'subject-forget',
  'superseded',
  'third_party_privacy_guard',
]);
const CANONICAL_REASON_CODE_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u;
const TRUSTED_ATTRIBUTION_SOURCES = new Set<MemoryConversationTurn['attributionSource']>([
  'additional_kwargs',
  'direct_session',
]);

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(raw: string, operation: MemoryOperation, stage: 'validation' | 'read' | 'decode'): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new MemoryRuntimeError(operation, stage, 'memory_json_invalid', 'Stored memory JSON is invalid.', {
      cause: error,
    });
  }
}

function toTimestamp(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp01(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))].sort();
}

function intersectStringSets(values: readonly string[][]): string[] {
  if (!values.length) return [];
  const [first, ...rest] = values.map((items) => uniqueStrings(items));
  return first!.filter((item) => rest.every((items) => items.includes(item)));
}

function messageSuppressionDigest(messageId: string): string {
  return sha256(serialize(['memory-source-message-v2', messageId]));
}

function sourceSuppressionKey(identity: ForgottenSourceIdentity): string {
  return `source:${sha256(serialize([
    'memory-source-evidence-v2',
    identity.contextKey,
    identity.sourceMessageDigest,
  ]))}`;
}

function parseVector(raw: string): number[] {
  const value = parseJson<unknown>(raw, 'recall', 'read');
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new MemoryRuntimeError('recall', 'validation', 'memory_embedding_invalid', 'Stored memory embedding is invalid.');
  }
  return value;
}

export function extractPlainText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object' && 'text' in raw) {
    return normalizeText((raw as { text?: unknown }).text);
  }
  if (!Array.isArray(raw)) return '';
  return raw.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object' && 'text' in item) {
      return typeof (item as { text?: unknown }).text === 'string'
        ? (item as { text: string }).text
        : '';
    }
    return '';
  }).join('').trim();
}

async function decodeStoredMessageText(content: unknown): Promise<string> {
  const direct = extractPlainText(content);
  if (direct) return direct;
  const { decodeStoredMessageText: decode } = await import('../shared/stored-message.js');
  return decode(content);
}

function hasStoredBinary(raw: unknown): boolean {
  if (raw instanceof ArrayBuffer) return raw.byteLength > 0;
  if (ArrayBuffer.isView(raw)) return raw.byteLength > 0;
  return false;
}

function parsePlainRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parsed = parseJson<unknown>(raw, 'extract', 'decode');
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

async function decodeStoredAdditionalKwargs(row: StoredMessageRecord): Promise<Record<string, unknown> | null> {
  if (!hasStoredBinary(row.additional_kwargs_binary)) return parsePlainRecord(row.additional_kwargs);
  try {
    const { decodeStoredMessageJson } = await import('../shared/stored-message.js');
    return parsePlainRecord(await decodeStoredMessageJson(row.additional_kwargs_binary));
  } catch (error) {
    throw asMemoryRuntimeError(error, 'extract', 'decode', 'memory_message_metadata_decode_failed');
  }
}

type ParsedSpeaker = {
  speakerId: string | null;
  speakerName: string | null;
  text: string;
  ownerUserKey: string | null;
  isTarget: boolean;
  attributionSource: MemoryConversationTurn['attributionSource'];
};

const SPEAKER_TAG_PREFIX = /^\[speaker_id=([^\]\s]+)(?:\s+speaker_name=("(?:\\.|[^"\\])*"|[^\]\s]+))?\][ \t]*/;

function parseSpeakerTag(text: string): { speakerId: string; speakerName: string | null; end: number } | null {
  const match = text.match(SPEAKER_TAG_PREFIX);
  const speakerId = normalizeText(match?.[1]);
  if (!speakerId) return null;
  const nameToken = normalizeText(match?.[2]);
  let speakerName: string | null = nameToken || null;
  if (nameToken.startsWith('"')) {
    speakerName = normalizeText(parseJson<unknown>(nameToken, 'extract', 'decode')) || null;
  }
  return {
    speakerId,
    speakerName,
    end: match?.[0]?.length ?? 0,
  };
}

function parseSpeakerFormat(raw: unknown): { speakerId: string; speakerName: string | null } | null {
  const record = parsePlainRecord(raw);
  const format = parsePlainRecord(record?.qqbot_speaker_format);
  if (normalizeText(format?.version) !== 'speaker_id_v1') return null;
  if (format?.isDirect === true || format?.preformatted === true) return null;
  const speakerId = normalizeText(format?.speakerId);
  if (!speakerId) return null;
  return {
    speakerId,
    speakerName: normalizeText(format?.speakerName) || null,
  };
}

function safeAuditDetail(detail: Record<string, unknown> | null): string | null {
  if (!detail) return null;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_AUDIT_KEY.test(key)) {
        throw new MemoryRuntimeError('audit', 'validation', 'memory_audit_contains_content', `Audit key is not content-safe: ${key}`);
      }
      if (key === 'reasonCode') {
        assertCanonicalMemoryReasonCode(child, 'audit');
      }
      visit(child);
    }
  };
  visit(detail);
  return serialize(detail);
}

function assertCanonicalMemoryReasonCode(
  value: unknown,
  operation: MemoryOperation,
): string {
  if (
    typeof value !== 'string'
    || !CANONICAL_REASON_CODE_PATTERN.test(value)
    || !CANONICAL_MEMORY_REASON_CODES.has(value)
  ) {
    throw new MemoryRuntimeError(
      operation,
      'validation',
      'memory_reason_code_invalid',
      'Memory reason code is not canonical.',
    );
  }
  return value;
}

function workPayload<T>(work: MemoryV2WorkRecord): T {
  return parseJson<T>(work.payload, work.workType === 'embed' || work.workType === 'backfill' ? 'embed' : 'extract', 'validation');
}

function dueSort(left: MemoryV2WorkRecord, right: MemoryV2WorkRecord): number {
  return left.nextRunAt - right.nextRunAt || left.id - right.id;
}

function embeddingTuple(payload: EmbeddingWorkPayload): string {
  return serialize([
    payload.streamId,
    payload.eventId,
    payload.revision,
    payload.canonicalModel,
    payload.modelRevision,
    payload.contentHash,
  ]);
}

function embeddingWorkKey(type: 'embed' | 'backfill', payload: EmbeddingWorkPayload): string {
  return `${type}:${sha256(embeddingTuple(payload))}`;
}

function candidateContent(candidate: ExtractedMemoryCandidate): {
  assertionType: MemoryAssertionType;
  content: string;
  retrievalText: string;
} | null {
  if (candidate.candidateType === 'fact') {
    const content = normalizeText(candidate.content);
    if (!content) return null;
    const keywords = uniqueStrings(candidate.keywords);
    return {
      assertionType: candidate.subject === 'group_shared'
        ? 'groupArtifact'
        : candidate.subject === 'assistant'
          ? 'assistantCommitment'
          : 'userAssertion',
      content,
      retrievalText: [candidate.kind, candidate.topicKey, content, ...keywords].filter(Boolean).join('\n'),
    };
  }
  if (candidate.candidateType === 'episode') {
    const title = normalizeText(candidate.title);
    const summary = normalizeText(candidate.summary);
    if (!title || !summary) return null;
    return {
      assertionType: 'episode',
      content: `${title}\n${summary}`,
      retrievalText: [title, summary, ...uniqueStrings(candidate.keywords)].join('\n'),
    };
  }
  return null;
}

export class MemoryUnitOfWork {
  constructor(private readonly database: MemoryDatabaseLike) {}

  async run<T>(
    operation: MemoryOperation,
    callback: (database: MemoryDatabaseLike) => Promise<T>,
  ): Promise<T> {
    if (typeof this.database.withTransaction !== 'function') {
      throw new MemoryRuntimeError(
        operation,
        'transaction',
        'memory_transaction_unavailable',
        'The memory database does not provide transactional writes.',
      );
    }
    try {
      return await this.database.withTransaction(callback);
    } catch (error) {
      throw asMemoryRuntimeError(error, operation, 'transaction', 'memory_transaction_failed');
    }
  }
}

export class MemoryStore {
  private readonly unitOfWork: MemoryUnitOfWork;

  constructor(
    private readonly database: MemoryDatabaseLike,
    readonly policy = new MemoryPolicyService(),
    private readonly searchIndex: MemorySearchIndex = new SqliteMemorySearchIndex(),
  ) {
    this.unitOfWork = new MemoryUnitOfWork(database);
  }

  async assertSchemaVersion(): Promise<void> {
    const rows = await this.database.get(MEMORY_LEDGER_TABLES.meta, { key: 'schemaVersion' });
    if (rows.length !== 1 || String(rows[0]?.value) !== String(MEMORY_LEDGER_SCHEMA_VERSION)) {
      throw new MemoryRuntimeError(
        'startup',
        'schema',
        'memory_schema_version_invalid',
        `Memory Ledger schemaVersion=${MEMORY_LEDGER_SCHEMA_VERSION} is required.`,
      );
    }
    assertMemoryLedgerSqliteSchema(this.database);
    await this.searchIndex.assertReady(this.database);
  }

  async upsertAddress(address: MemoryAddress, patch: MemoryPrincipalPatch | null = null): Promise<void> {
    await this.unitOfWork.run('address', async (database) => {
      const [principal] = await database.get(MEMORY_LEDGER_TABLES.principal, { userKey: address.userKey });
      const principalPatch = {
        displayName: patch?.displayName ?? principal?.displayName ?? null,
        avatarUrl: patch?.avatarUrl ?? principal?.avatarUrl ?? null,
        lastSeenAt: address.observedAt,
      };
      if (principal) {
        await database.set(MEMORY_LEDGER_TABLES.principal, { id: principal.id }, principalPatch);
      } else {
        await database.create(MEMORY_LEDGER_TABLES.principal, {
          userKey: address.userKey,
          platform: address.platform,
          userId: address.userId,
          ...principalPatch,
          readEnabled: 1,
          writeEnabled: 1,
          firstSeenAt: address.observedAt,
        });
      }

      const [context] = await database.get(MEMORY_LEDGER_TABLES.context, { contextKey: address.contextKey });
      const contextPatch = {
        platform: address.platform,
        botSelfId: address.botSelfId,
        channelType: address.channelType,
        groupId: address.groupId ?? null,
        channelId: address.channelId ?? null,
        rawContextId: address.rawContextId ?? null,
        lastSeenAt: address.observedAt,
      };
      if (context) {
        await database.set(MEMORY_LEDGER_TABLES.context, { id: context.id }, contextPatch);
      } else {
        await database.create(MEMORY_LEDGER_TABLES.context, {
          contextKey: address.contextKey,
          ...contextPatch,
          firstSeenAt: address.observedAt,
        });
      }
    });
  }

  async getUserFlags(userKey: string): Promise<{ readEnabled: boolean; writeEnabled: boolean }> {
    const [row] = await this.database.get(MEMORY_LEDGER_TABLES.principal, { userKey });
    return {
      readEnabled: row ? Number(row.readEnabled) === 1 : true,
      writeEnabled: row ? Number(row.writeEnabled) === 1 : true,
    };
  }

  async setUserFlags(userKey: string, flags: { readEnabled?: boolean; writeEnabled?: boolean }): Promise<void> {
    await this.unitOfWork.run('address', async (database) => {
      const [row] = await database.get(MEMORY_LEDGER_TABLES.principal, { userKey });
      if (!row) {
        throw new MemoryRuntimeError('address', 'validation', 'memory_principal_missing', 'Memory principal does not exist.');
      }
      const update: Record<string, unknown> = { lastSeenAt: Date.now() };
      if (flags.readEnabled != null) update.readEnabled = flags.readEnabled ? 1 : 0;
      if (flags.writeEnabled != null) update.writeEnabled = flags.writeEnabled ? 1 : 0;
      await database.set(MEMORY_LEDGER_TABLES.principal, { id: row.id }, update);
    });
  }

  private async laneGeneration(
    database: MemoryDatabaseLike,
    subjectKey: string,
    contextKey: string | null,
  ): Promise<number> {
    const rows = await database.get(MEMORY_LEDGER_TABLES.suppression, { subjectKey }) as MemoryV2SuppressionRecord[];
    return rows
      .filter((row) => (
        row.sourceMessageDigest == null
        && row.streamId == null
        && (
        row.contextKey == null || row.contextKey === contextKey
        )
      ))
      .reduce((max, row) => Math.max(max, Number(row.generation)), 0);
  }

  private async streamGeneration(
    database: MemoryDatabaseLike,
    subjectKey: string,
    streamId: string,
  ): Promise<number> {
    const rows = await database.get(MEMORY_LEDGER_TABLES.suppression, {
      subjectKey,
      streamId,
    }) as MemoryV2SuppressionRecord[];
    return rows
      .filter((row) => row.sourceMessageDigest == null)
      .reduce((max, row) => Math.max(max, Number(row.generation)), 0);
  }

  private async filterSuppressedTurnsTx(
    database: MemoryDatabaseLike,
    subjectKey: string,
    contextKey: string,
    turns: readonly MemoryConversationTurn[],
  ): Promise<MemoryConversationTurn[]> {
    const [laneRows, contextRows] = await Promise.all([
      database.get(MEMORY_LEDGER_TABLES.suppression, {
        subjectKey,
      }) as Promise<MemoryV2SuppressionRecord[]>,
      database.get(MEMORY_LEDGER_TABLES.suppression, {
        contextKey,
      }) as Promise<MemoryV2SuppressionRecord[]>,
    ]);
    const suppressedSources = new Set(
      contextRows
        .filter((row) => row.subjectKey == null && row.streamId == null)
        .map((row) => row.sourceMessageDigest)
        .filter((digest): digest is string => Boolean(digest)),
    );
    const cutoff = laneRows
      .filter((row) => (
        row.cutoffAt != null
        && row.sourceMessageDigest == null
        && row.streamId == null
        && (row.contextKey == null || row.contextKey === contextKey)
      ))
      .reduce((latest, row) => Math.max(latest, Number(row.cutoffAt)), 0);
    return turns.filter((turn) => (
      !suppressedSources.has(messageSuppressionDigest(turn.id))
      && (!cutoff || (turn.occurredAt != null && turn.occurredAt > cutoff))
    ));
  }

  private async assertEvidenceSourcesAvailable(
    database: MemoryDatabaseLike,
    evidence: readonly Pick<MemoryEvidenceInput, 'contextKey' | 'messageId'>[],
  ): Promise<void> {
    const contexts = uniqueStrings(evidence.map((item) => item.contextKey));
    const suppressed = new Set<string>();
    for (const contextKey of contexts) {
      const rows = await database.get(MEMORY_LEDGER_TABLES.suppression, {
        contextKey,
      }) as MemoryV2SuppressionRecord[];
      for (const row of rows) {
        if (
          row.subjectKey == null
          && row.streamId == null
          && row.sourceMessageDigest
        ) {
          suppressed.add(sourceSuppressionKey({
            contextKey,
            sourceMessageDigest: row.sourceMessageDigest,
          }));
        }
      }
    }
    if (evidence.some((item) => suppressed.has(sourceSuppressionKey({
      contextKey: item.contextKey,
      sourceMessageDigest: messageSuppressionDigest(item.messageId),
    })))) {
      throw new MemoryRuntimeError(
        'extract',
        'finalize',
        'memory_source_suppressed',
        'Memory evidence was invalidated by a source deletion barrier.',
      );
    }
  }

  private async writeAudit(
    database: MemoryDatabaseLike,
    input: {
      idempotencyKey: string;
      subjectKey?: string | null;
      contextKey?: string | null;
      eventType: string;
      streamId?: string | null;
      eventId?: string | null;
      workKey?: string | null;
      detail?: Record<string, unknown> | null;
      createdAt?: number;
    },
  ): Promise<void> {
    const existing = await database.get(MEMORY_LEDGER_TABLES.audit, { idempotencyKey: input.idempotencyKey });
    if (existing.length) return;
    await database.create(MEMORY_LEDGER_TABLES.audit, {
      auditId: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      subjectKey: input.subjectKey ?? null,
      contextKey: input.contextKey ?? null,
      eventType: input.eventType,
      streamId: input.streamId ?? null,
      eventId: input.eventId ?? null,
      workKey: input.workKey ?? null,
      detailJson: safeAuditDetail(input.detail ?? null),
      createdAt: input.createdAt ?? Date.now(),
    });
  }

  async audit(input: {
    idempotencyKey?: string;
    subjectKey?: string | null;
    contextKey?: string | null;
    eventType: string;
    streamId?: string | null;
    eventId?: string | null;
    workKey?: string | null;
    detail?: Record<string, unknown> | null;
    createdAt?: number;
  }): Promise<void> {
    await this.unitOfWork.run('audit', (database) => this.writeAudit(database, {
      ...input,
      idempotencyKey: input.idempotencyKey ?? `audit:${randomUUID()}`,
    }));
  }

  private async queueWork(
    database: MemoryDatabaseLike,
    input: {
      workKey: string;
      workType: MemoryWorkType;
      subjectKey?: string | null;
      contextKey?: string | null;
      streamId?: string | null;
      laneKey?: string | null;
      payload: MemoryWorkPayload;
      inputHash: string;
      targetRevision?: number | null;
      deletionGeneration: number;
      nextRunAt?: number;
    },
  ): Promise<boolean> {
    const existing = await database.get(MEMORY_LEDGER_TABLES.work, { workKey: input.workKey }) as MemoryV2WorkRecord[];
    if (existing.length) return false;
    const now = Date.now();
    await database.create(MEMORY_LEDGER_TABLES.work, {
      workKey: input.workKey,
      workType: input.workType,
      status: 'pending',
      subjectKey: input.subjectKey ?? null,
      contextKey: input.contextKey ?? null,
      streamId: input.streamId ?? null,
      laneKey: input.laneKey ?? null,
      payload: serialize(input.payload),
      inputHash: input.inputHash,
      targetRevision: input.targetRevision ?? null,
      deletionGeneration: input.deletionGeneration,
      retryCount: 0,
      nextRunAt: input.nextRunAt ?? now,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorStage: null,
      upstreamStatus: null,
      providerCode: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    return true;
  }

  async queueExtractWork(input: {
    address: MemoryAddress;
    targetSpeakerId: string;
    targetSpeakerName: string | null;
    maxMessages: number;
    nextRunAt: number;
  }): Promise<boolean> {
    const expectedUserKey = `${input.address.platform}:user:${input.targetSpeakerId}`;
    if (
      input.targetSpeakerId !== input.address.userId
      || input.address.userKey !== expectedUserKey
    ) {
      throw new MemoryRuntimeError(
        'enqueue',
        'validation',
        'memory_extract_target_conflict',
        'Extraction target conflicts with the authenticated session speaker.',
      );
    }
    const [conversation] = await this.database.get('chatluna_conversation', {
      id: input.address.conversationId,
    }) as StoredConversationRecord[];
    const latestAnchorMessageId = normalizeText(conversation?.latestMessageId);
    if (!latestAnchorMessageId) return false;
    const audienceSubjectKeys = uniqueStrings(
      input.address.currentAudienceSubjectKeys ?? [],
    );
    if (
      audienceSubjectKeys.length === 0
      || !audienceSubjectKeys.includes(input.address.userKey)
    ) {
      throw new MemoryRuntimeError(
        'enqueue',
        'validation',
        'memory_extract_audience_missing',
        'Extraction requires the authoritative audience captured for this message.',
      );
    }

    return this.unitOfWork.run('enqueue', async (database) => {
      const key = createMemoryExtractLaneKey(
        input.address.userKey,
        input.address.contextKey,
      );
      const [cursor] = await database.get(MEMORY_LEDGER_TABLES.cursor, { laneKey: key }) as MemoryV2CursorRecord[];
      const effectiveCursorMessageId = cursor?.discardBeforeMessageId ?? cursor?.lastMessageId ?? null;
      if (effectiveCursorMessageId === latestAnchorMessageId) {
        return false;
      }
      if (
        cursor?.lastMessageAt != null
        && cursor.lastMessageAt >= input.address.observedAt
      ) {
        return false;
      }
      const pendingRows = (
        await database.get(MEMORY_LEDGER_TABLES.work, {
          laneKey: key,
          workType: 'extract',
          status: 'pending',
        }) as MemoryV2WorkRecord[]
      ).sort(dueSort);
      const pending = pendingRows[0];
      const capturedAudience = {
        messageId: latestAnchorMessageId,
        observedAt: input.address.observedAt,
        audienceSubjectKeys,
      };
      if (pending) {
        const existingPayloads = pendingRows.map(
          (row) => workPayload<ExtractWorkPayload>(row),
        );
        if (existingPayloads.some((payload) => (
          payload.address.conversationId !== input.address.conversationId
          || payload.targetSpeakerId !== input.targetSpeakerId
        ))) {
          throw new MemoryRuntimeError(
            'enqueue',
            'validation',
            'memory_extract_lane_conflict',
            'A pending extraction lane targets a different conversation or speaker.',
          );
        }
        const alreadyCaptured = existingPayloads.some(
          (payload) => payload.capturedAudiences.some(
            (capture) => capture.messageId === latestAnchorMessageId,
          ),
        );
        if (alreadyCaptured && pendingRows.length === 1) {
          return false;
        }
        const maxMessages = Math.max(
          1,
          Math.floor(Math.max(
            input.maxMessages,
            ...existingPayloads.map((payload) => payload.maxMessages),
          )),
        );
        const captureByMessageId = new Map(
          existingPayloads
            .flatMap((payload) => payload.capturedAudiences)
            .map((capture) => [capture.messageId, capture]),
        );
        if (!captureByMessageId.has(capturedAudience.messageId)) {
          captureByMessageId.set(capturedAudience.messageId, capturedAudience);
        }
        const capturedAudiences = [...captureByMessageId.values()]
          .sort((left, right) => (
            left.observedAt - right.observedAt
            || left.messageId.localeCompare(right.messageId)
          ))
          .slice(-maxMessages);
        const payload: ExtractWorkPayload = {
          address: input.address,
          targetSpeakerId: input.targetSpeakerId,
          targetSpeakerName: input.targetSpeakerName,
          latestAnchorMessageId,
          maxMessages,
          capturedAudiences,
        };
        const inputHash = sha256(serialize(payload));
        await database.set(MEMORY_LEDGER_TABLES.work, {
          id: pending.id,
          status: 'pending',
          inputHash: pending.inputHash,
        }, {
          payload: serialize(payload),
          inputHash,
          retryCount: 0,
          nextRunAt: input.nextRunAt,
          lastErrorCode: null,
          lastErrorStage: null,
          upstreamStatus: null,
          providerCode: null,
          completedAt: null,
          updatedAt: Date.now(),
        });
        for (const duplicate of pendingRows.slice(1)) {
          await database.set(MEMORY_LEDGER_TABLES.work, {
            id: duplicate.id,
            status: 'pending',
            inputHash: duplicate.inputHash,
          }, {
            status: 'cancelled',
            payload: '{}',
            leaseToken: null,
            leaseExpiresAt: null,
            lastErrorCode: 'memory_extract_lane_coalesced',
            lastErrorStage: 'finalize',
            upstreamStatus: null,
            providerCode: null,
            updatedAt: Date.now(),
            completedAt: Date.now(),
          });
        }
        return true;
      }
      const payload: ExtractWorkPayload = {
        address: input.address,
        targetSpeakerId: input.targetSpeakerId,
        targetSpeakerName: input.targetSpeakerName,
        latestAnchorMessageId,
        maxMessages: input.maxMessages,
        capturedAudiences: [capturedAudience],
      };
      const inputHash = sha256(serialize(payload));
      const generation = await this.laneGeneration(
        database,
        input.address.userKey,
        input.address.contextKey,
      );
      return this.queueWork(database, {
        workKey: `extract:${key}:${randomUUID()}`,
        workType: 'extract',
        subjectKey: input.address.userKey,
        contextKey: input.address.contextKey,
        laneKey: key,
        payload,
        inputHash,
        deletionGeneration: generation,
        nextRunAt: input.nextRunAt,
      });
    });
  }

  async claimDueWork(
    workType: MemoryWorkType,
    now: number,
    leaseMs: number,
  ): Promise<ClaimedMemoryWork | null> {
    return this.unitOfWork.run('claim', async (database) => {
      const [rows, leased] = await Promise.all([
        database.get(MEMORY_LEDGER_TABLES.work, {
          workType,
          status: 'pending',
        }) as Promise<MemoryV2WorkRecord[]>,
        database.get(MEMORY_LEDGER_TABLES.work, {
          workType,
          status: 'leased',
        }) as Promise<MemoryV2WorkRecord[]>,
      ]);
      const leasedLanes = new Set(
        leased.map((row) => row.laneKey).filter((key): key is string => Boolean(key)),
      );
      const work = rows
        .filter((row) => (
          row.nextRunAt <= now
          && (!row.laneKey || !leasedLanes.has(row.laneKey))
        ))
        .sort(dueSort)[0];
      if (!work) return null;
      const leaseToken = randomUUID();
      await database.set(MEMORY_LEDGER_TABLES.work, {
        id: work.id,
        status: 'pending',
        inputHash: work.inputHash,
      }, {
        status: 'leased',
        leaseToken,
        leaseExpiresAt: now + leaseMs,
        updatedAt: now,
      });
      const [claimed] = await database.get(MEMORY_LEDGER_TABLES.work, { id: work.id }) as MemoryV2WorkRecord[];
      if (!claimed || claimed.status !== 'leased' || claimed.leaseToken !== leaseToken) return null;
      return { work: claimed, leaseToken };
    });
  }

  async requeueExpiredLeases(
    now = Date.now(),
    maxRetries = 1,
  ): Promise<number> {
    return this.unitOfWork.run('maintenance', async (database) => {
      const rows = await database.get(MEMORY_LEDGER_TABLES.work, { status: 'leased' }) as MemoryV2WorkRecord[];
      const expired = rows.filter((row) => row.leaseExpiresAt != null && row.leaseExpiresAt <= now);
      let resolved = 0;
      for (const row of expired) {
        if (await this.resolveExpiredLeaseTx(
          database,
          row,
          row.leaseToken,
          maxRetries,
          now,
        )) {
          resolved += 1;
        }
      }
      return resolved;
    });
  }

  parseWorkPayload<T extends MemoryWorkPayload>(work: MemoryV2WorkRecord): T {
    return workPayload<T>(work);
  }

  private async assertLease(
    database: MemoryDatabaseLike,
    work: MemoryV2WorkRecord,
    leaseToken: string,
    allowExpired = false,
  ): Promise<MemoryV2WorkRecord> {
    const [current] = await database.get(MEMORY_LEDGER_TABLES.work, { id: work.id }) as MemoryV2WorkRecord[];
    if (!current || current.status !== 'leased' || current.leaseToken !== leaseToken || current.inputHash !== work.inputHash) {
      throw new MemoryRuntimeError('claim', 'finalize', 'memory_lease_lost', 'Memory work lease is no longer valid.');
    }
    const generation = !current.subjectKey
      ? 0
      : current.workType === 'extract'
        ? await this.laneGeneration(database, current.subjectKey, current.contextKey)
        : current.streamId
          ? await this.streamGeneration(database, current.subjectKey, current.streamId)
          : 0;
    if (generation !== current.deletionGeneration) {
      throw new MemoryRuntimeError(
        current.workType === 'embed' || current.workType === 'backfill' ? 'embed' : 'extract',
        'finalize',
        'memory_deletion_generation_changed',
        'Memory work was invalidated by a deletion barrier.',
      );
    }
    if (
      !allowExpired
      && (current.leaseExpiresAt == null || current.leaseExpiresAt <= Date.now())
    ) {
      throw new MemoryRuntimeError(
        current.workType === 'embed' || current.workType === 'backfill' ? 'embed' : 'extract',
        'finalize',
        'memory_lease_expired',
        'Memory work lease expired before finalization.',
      );
    }
    return current;
  }

  private async terminateInvalidLease(
    work: MemoryV2WorkRecord,
    leaseToken: string,
    reasonCode: 'memory_deletion_generation_changed',
  ): Promise<void> {
    await this.unitOfWork.run(
      work.workType === 'embed' || work.workType === 'backfill' ? 'embed' : 'extract',
      async (database) => {
        const [current] = await database.get(MEMORY_LEDGER_TABLES.work, {
          id: work.id,
        }) as MemoryV2WorkRecord[];
        if (
          !current
          || current.status !== 'leased'
          || current.leaseToken !== leaseToken
          || current.inputHash !== work.inputHash
        ) {
          return;
        }
        const now = Date.now();
        await database.set(MEMORY_LEDGER_TABLES.work, { id: current.id }, {
          status: 'cancelled',
          leaseToken: null,
          leaseExpiresAt: null,
          payload: '{}',
          lastErrorCode: reasonCode,
          lastErrorStage: 'finalize',
          upstreamStatus: null,
          providerCode: null,
          updatedAt: now,
          completedAt: now,
        });
        await this.writeAudit(database, {
          idempotencyKey: `work-invalidated:${current.workKey}:${reasonCode}`,
          subjectKey: current.subjectKey,
          contextKey: current.contextKey,
          eventType: 'work_invalidated',
          workKey: current.workKey,
          detail: { reasonCode },
          createdAt: now,
        });
      },
    );
  }

  private async expiredLeaseInvalidationReason(
    database: MemoryDatabaseLike,
    work: MemoryV2WorkRecord,
  ): Promise<string | null> {
    const generation = !work.subjectKey
      ? 0
      : work.workType === 'extract'
        ? await this.laneGeneration(database, work.subjectKey, work.contextKey)
        : work.streamId
          ? await this.streamGeneration(database, work.subjectKey, work.streamId)
          : 0;
    if (generation !== work.deletionGeneration) {
      return 'memory_deletion_generation_changed';
    }
    if (work.workType === 'extract') {
      const payload = workPayload<ExtractWorkPayload>(work);
      const anchorCapture = payload.capturedAudiences?.find(
        (capture) => capture.messageId === payload.latestAnchorMessageId,
      );
      if (!payload.address?.contextKey || !anchorCapture) {
        throw new MemoryRuntimeError(
          'extract',
          'validation',
          'memory_extract_payload_invalid',
          'Active extraction work payload is invalid.',
        );
      }
      const [cursor] = await database.get(MEMORY_LEDGER_TABLES.cursor, {
        laneKey: work.laneKey,
      }) as MemoryV2CursorRecord[];
      if (
        cursor?.lastMessageAt != null
        && cursor.lastMessageAt >= anchorCapture.observedAt
        && cursor.lastMessageId !== payload.latestAnchorMessageId
      ) {
        return 'memory_extract_anchor_superseded';
      }
      return null;
    }
    if (
      (work.workType === 'embed' || work.workType === 'backfill')
      && work.streamId
    ) {
      const payload = workPayload<EmbeddingWorkPayload>(work);
      const [head] = await database.get(MEMORY_LEDGER_TABLES.head, {
        streamId: work.streamId,
      }) as MemoryV2HeadRecord[];
      if (
        !head
        || head.state !== 'active'
        || head.eventId !== payload.eventId
        || head.revision !== payload.revision
        || head.contentHash !== payload.contentHash
        || head.deletionGeneration !== work.deletionGeneration
      ) {
        return 'memory_embedding_target_superseded';
      }
    }
    return null;
  }

  private async resolveExpiredLeaseTx(
    database: MemoryDatabaseLike,
    work: MemoryV2WorkRecord,
    leaseToken: string | null,
    maxRetries: number,
    now: number,
  ): Promise<boolean> {
    const [current] = await database.get(MEMORY_LEDGER_TABLES.work, {
      id: work.id,
      status: 'leased',
      leaseToken,
      inputHash: work.inputHash,
    }) as MemoryV2WorkRecord[];
    if (
      !current
      || current.leaseExpiresAt == null
      || current.leaseExpiresAt > now
    ) {
      return false;
    }
    const invalidationReason = await this.expiredLeaseInvalidationReason(
      database,
      current,
    );
    if (invalidationReason) {
      await database.set(MEMORY_LEDGER_TABLES.work, {
        id: current.id,
        status: 'leased',
        leaseToken,
        inputHash: current.inputHash,
      }, {
        status: 'cancelled',
        leaseToken: null,
        leaseExpiresAt: null,
        payload: '{}',
        lastErrorCode: invalidationReason,
        lastErrorStage: 'finalize',
        upstreamStatus: null,
        providerCode: null,
        updatedAt: now,
        completedAt: now,
      });
      await this.writeAudit(database, {
        idempotencyKey: `work-invalidated:${current.workKey}:${invalidationReason}`,
        subjectKey: current.subjectKey,
        contextKey: current.contextKey,
        eventType: 'work_invalidated',
        workKey: current.workKey,
        detail: { errorCode: invalidationReason },
        createdAt: now,
      });
      return true;
    }

    const retryCount = current.retryCount + 1;
    const retry = retryCount <= maxRetries;
    await database.set(MEMORY_LEDGER_TABLES.work, {
      id: current.id,
      status: 'leased',
      leaseToken,
      inputHash: current.inputHash,
    }, {
      status: retry ? 'pending' : 'deadLetter',
      retryCount,
      nextRunAt: retry ? now : current.nextRunAt,
      leaseToken: null,
      leaseExpiresAt: null,
      payload: retry ? current.payload : '{}',
      lastErrorCode: 'memory_lease_expired',
      lastErrorStage: 'finalize',
      upstreamStatus: null,
      providerCode: null,
      updatedAt: now,
      completedAt: retry ? null : now,
    });
    await this.writeAudit(database, {
      idempotencyKey: `work-expired:${current.workKey}:${retryCount}`,
      subjectKey: current.subjectKey,
      contextKey: current.contextKey,
      eventType: retry ? 'work_retry_scheduled' : 'work_dead_lettered',
      workKey: current.workKey,
      detail: {
        reasonCode: 'memory_lease_expired',
        retryCount,
      },
      createdAt: now,
    });
    return true;
  }

  private async requeueExpiredLease(
    work: MemoryV2WorkRecord,
    leaseToken: string,
    maxRetries: number,
  ): Promise<void> {
    await this.unitOfWork.run(
      work.workType === 'embed' || work.workType === 'backfill' ? 'embed' : 'extract',
      async (database) => {
        const [current] = await database.get(MEMORY_LEDGER_TABLES.work, {
          id: work.id,
        }) as MemoryV2WorkRecord[];
        if (
          !current
          || current.status !== 'leased'
          || current.leaseToken !== leaseToken
          || current.inputHash !== work.inputHash
        ) {
          return;
        }
        await this.resolveExpiredLeaseTx(
          database,
          current,
          leaseToken,
          maxRetries,
          Date.now(),
        );
      },
    );
  }

  private async runLeaseTransaction<T>(
    operation: 'extract' | 'embed',
    work: MemoryV2WorkRecord,
    leaseToken: string,
    callback: (database: MemoryDatabaseLike, current: MemoryV2WorkRecord) => Promise<T>,
    options: {
      allowExpired?: boolean;
      maxLeaseRetries?: number;
    } = {},
  ): Promise<T> {
    try {
      return await this.unitOfWork.run(operation, async (database) => (
        callback(
          database,
          await this.assertLease(
            database,
            work,
            leaseToken,
            options.allowExpired ?? false,
          ),
        )
      ));
    } catch (error) {
      if (
        error instanceof MemoryRuntimeError
        && error.code === 'memory_lease_expired'
      ) {
        await this.requeueExpiredLease(
          work,
          leaseToken,
          options.maxLeaseRetries ?? 1,
        );
      } else if (
        error instanceof MemoryRuntimeError
        && error.code === 'memory_deletion_generation_changed'
      ) {
        await this.terminateInvalidLease(work, leaseToken, error.code);
      }
      throw error;
    }
  }

  async failWork(
    work: MemoryV2WorkRecord,
    leaseToken: string,
    error: unknown,
    options: { maxRetries: number; retryDelayMs: number },
  ): Promise<void> {
    await this.runLeaseTransaction(work.workType === 'embed' || work.workType === 'backfill' ? 'embed' : 'extract', work, leaseToken, async (database, current) => {
      const detail = memoryErrorDetail(error);
      const retryCount = current.retryCount + 1;
      const retry = detail.retryable && retryCount <= options.maxRetries;
      await database.set(MEMORY_LEDGER_TABLES.work, { id: current.id }, {
        status: retry ? 'pending' : 'deadLetter',
        retryCount,
        nextRunAt: retry ? Date.now() + options.retryDelayMs : current.nextRunAt,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: detail.code,
        lastErrorStage: detail.stage,
        upstreamStatus: detail.upstreamStatus,
        providerCode: detail.providerCode,
        updatedAt: Date.now(),
        completedAt: retry ? null : Date.now(),
        payload: retry ? current.payload : '{}',
      });
      await this.writeAudit(database, {
        idempotencyKey: `work-failed:${current.workKey}:${retryCount}`,
        subjectKey: current.subjectKey,
        contextKey: current.contextKey,
        eventType: retry ? 'work_retry_scheduled' : 'work_dead_lettered',
        workKey: current.workKey,
        detail: {
          errorCode: detail.code,
          errorStage: detail.stage,
          upstreamStatus: detail.upstreamStatus,
          providerCode: detail.providerCode,
          retryable: detail.retryable,
          retryCount,
        },
      });
    }, {
      maxLeaseRetries: options.maxRetries,
    });
  }

  private buildTurnSpeaker(
    row: StoredMessageRecord,
    text: string,
    additionalKwargs: Record<string, unknown> | null,
    payload: ExtractWorkPayload,
  ): ParsedSpeaker {
    if (row.role !== 'human') {
      return {
        text,
        speakerId: payload.address.botSelfId,
        speakerName: 'assistant',
        ownerUserKey: null,
        isTarget: false,
        attributionSource: 'assistant',
      };
    }
    if (payload.address.channelType === 'direct') {
      return {
        text,
        speakerId: payload.targetSpeakerId,
        speakerName: payload.targetSpeakerName,
        ownerUserKey: payload.address.userKey,
        isTarget: true,
        attributionSource: 'direct_session',
      };
    }
    const formatted = parseSpeakerFormat(additionalKwargs);
    if (formatted) {
      const ownerUserKey = `${payload.address.platform}:user:${formatted.speakerId}`;
      const tag = parseSpeakerTag(text);
      return {
        text: tag?.speakerId === formatted.speakerId ? text.slice(tag.end).trim() : text,
        speakerId: formatted.speakerId,
        speakerName: formatted.speakerName ?? (normalizeText(row.name) || null),
        ownerUserKey,
        isTarget: ownerUserKey === payload.address.userKey && formatted.speakerId === payload.targetSpeakerId,
        attributionSource: 'additional_kwargs',
      };
    }
    const tag = parseSpeakerTag(text);
    if (!tag) {
      return {
        text,
        speakerId: null,
        speakerName: null,
        ownerUserKey: null,
        isTarget: false,
        attributionSource: 'unknown',
      };
    }
    const ownerUserKey = `${payload.address.platform}:user:${tag.speakerId}`;
    return {
      text: text.slice(tag.end).trim(),
      speakerId: tag.speakerId,
      speakerName: tag.speakerName ?? (normalizeText(row.name) || null),
      ownerUserKey,
      isTarget: ownerUserKey === payload.address.userKey && tag.speakerId === payload.targetSpeakerId,
      attributionSource: 'speaker_tag',
    };
  }

  async readConversationWindow(payload: ExtractWorkPayload): Promise<MemoryConversationTurn[]> {
    const rows = await this.database.get('chatluna_message', {
      conversationId: payload.address.conversationId,
    }) as StoredMessageRecord[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const [laneCursor] = await this.database.get(MEMORY_LEDGER_TABLES.cursor, {
      laneKey: createMemoryExtractLaneKey(
        payload.address.userKey,
        payload.address.contextKey,
      ),
    }) as MemoryV2CursorRecord[];
    const rangeStartAfterMessageId = laneCursor?.discardBeforeMessageId
      ?? laneCursor?.lastMessageId
      ?? null;
    if (rangeStartAfterMessageId === payload.latestAnchorMessageId) return [];
    const anchorCapture = payload.capturedAudiences.find(
      (capture) => capture.messageId === payload.latestAnchorMessageId,
    );
    if (!anchorCapture) {
      throw new MemoryRuntimeError(
        'extract',
        'validation',
        'memory_extract_anchor_audience_missing',
        'Extraction anchor has no immutable audience capture.',
      );
    }
    if (
      laneCursor?.lastMessageAt != null
      && laneCursor.lastMessageAt >= anchorCapture.observedAt
      && laneCursor.lastMessageId !== payload.latestAnchorMessageId
    ) {
      return [];
    }
    const window: MemoryConversationTurn[] = [];
    const maxMessages = Math.max(1, Math.floor(payload.maxMessages));
    const maxScan = maxMessages * 4;
    let cursor: string | null = payload.latestAnchorMessageId;
    let scanned = 0;
    while (cursor && cursor !== rangeStartAfterMessageId && scanned < maxScan) {
      const row = byId.get(cursor);
      if (!row) {
        throw new MemoryRuntimeError(
          'extract',
          'read',
          'memory_message_chain_broken',
          'Stored memory message chain is incomplete.',
        );
      }
      const storedOccurredAt = Number(row.createdAt);
      if (laneCursor?.lastMessageAt != null) {
        if (!Number.isFinite(storedOccurredAt)) {
          throw new MemoryRuntimeError(
            'extract',
            'read',
            'memory_message_time_missing',
            'Stored memory message is missing its immutable occurrence time.',
          );
        }
        if (storedOccurredAt <= laneCursor.lastMessageAt) break;
      }
      const occurredAt = Number.isFinite(storedOccurredAt)
        ? storedOccurredAt
        : payload.address.observedAt;
      scanned += 1;
      if (row.role === 'human' || row.role === 'ai') {
        let text: string;
        try {
          text = await decodeStoredMessageText(row.content);
        } catch (error) {
          throw asMemoryRuntimeError(error, 'extract', 'decode', 'memory_message_content_decode_failed');
        }
        if (text) {
          const kwargs = await decodeStoredAdditionalKwargs(row);
          const speaker = this.buildTurnSpeaker(row, text, kwargs, payload);
          window.push({
            id: row.id,
            role: row.role,
            text: speaker.text,
            speakerId: speaker.speakerId,
            speakerName: speaker.speakerName,
            ownerUserKey: speaker.ownerUserKey,
            isTarget: speaker.isTarget,
            attributionSource: speaker.attributionSource,
            parentId: row.parentId ?? null,
            occurredAt,
          });
        }
      }
      cursor = row.parentId ?? null;
    }
    return window.reverse().slice(-maxMessages);
  }

  async filterSuppressedTurns(
    subjectKey: string,
    contextKey: string,
    turns: MemoryConversationTurn[],
  ): Promise<MemoryConversationTurn[]> {
    return this.filterSuppressedTurnsTx(
      this.database,
      subjectKey,
      contextKey,
      turns,
    );
  }

  private capturedAudienceForEvidence(
    payload: ExtractWorkPayload,
    messageId: string,
  ): string[] | null {
    const audience = this.capturedAudienceForMessage(payload, messageId);
    if (!audience?.includes(payload.address.userKey)) return null;
    return audience;
  }

  private capturedAudienceForMessage(
    payload: ExtractWorkPayload,
    messageId: string,
  ): string[] | null {
    const capture = payload.capturedAudiences.find(
      (item) => item.messageId === messageId,
    );
    if (!capture) return null;
    const audience = uniqueStrings(capture.audienceSubjectKeys);
    return audience.length ? audience : null;
  }

  private async messageDescendsFrom(
    database: MemoryDatabaseLike,
    conversationId: string,
    descendantMessageId: string,
    ancestorMessageId: string,
  ): Promise<boolean> {
    const rows = await database.get('chatluna_message', {
      conversationId,
    }) as StoredMessageRecord[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const visited = new Set<string>();
    let messageId: string | null = descendantMessageId;
    while (messageId) {
      if (messageId === ancestorMessageId) return true;
      if (visited.has(messageId)) {
        throw new MemoryRuntimeError(
          'extract',
          'read',
          'memory_message_chain_cycle',
          'Stored memory message chain contains a cycle.',
        );
      }
      visited.add(messageId);
      const row = byId.get(messageId);
      if (!row) {
        throw new MemoryRuntimeError(
          'extract',
          'read',
          'memory_message_chain_broken',
          'Stored memory message chain is incomplete.',
        );
      }
      messageId = row.parentId ?? null;
    }
    return false;
  }

  private evaluateAttribution(
    candidate: ExtractedMemoryCandidate,
    turns: readonly MemoryConversationTurn[],
    payload: ExtractWorkPayload,
  ): {
      ok: true;
      evidence: Array<{
        turn: MemoryConversationTurn;
        captureAudienceSubjectKeys: string[];
      }>;
    } | { ok: false; reasonCode: string } {
    if (candidate.subject !== 'target_user') return { ok: false, reasonCode: `attribution_subject_${candidate.subject}` };
    if (normalizeText(candidate.ownerSpeakerId) !== payload.targetSpeakerId) {
      return { ok: false, reasonCode: 'attribution_owner_mismatch' };
    }
    const evidenceIds = uniqueStrings(candidate.evidenceMessageIds ?? []);
    const declaredSpeakers = uniqueStrings(candidate.evidenceSpeakerIds ?? []);
    if (!evidenceIds.length) return { ok: false, reasonCode: 'attribution_missing_evidence' };
    if (declaredSpeakers.length !== 1 || declaredSpeakers[0] !== payload.targetSpeakerId) {
      return { ok: false, reasonCode: 'attribution_speaker_mismatch' };
    }
    const byId = new Map(turns.map((turn) => [turn.id, turn]));
    const evidence: Array<{
      turn: MemoryConversationTurn;
      captureAudienceSubjectKeys: string[];
    }> = [];
    for (const messageId of evidenceIds) {
      const turn = byId.get(messageId);
      if (!turn) return { ok: false, reasonCode: 'attribution_evidence_outside_window' };
      if (
        turn.role !== 'human'
        || !turn.isTarget
        || turn.speakerId !== payload.targetSpeakerId
        || !TRUSTED_ATTRIBUTION_SOURCES.has(turn.attributionSource)
      ) {
        return { ok: false, reasonCode: 'attribution_evidence_untrusted' };
      }
      const captureAudienceSubjectKeys = this.capturedAudienceForEvidence(
        payload,
        messageId,
      );
      if (!captureAudienceSubjectKeys) {
        return { ok: false, reasonCode: 'attribution_evidence_audience_missing' };
      }
      evidence.push({ turn, captureAudienceSubjectKeys });
    }
    return { ok: true, evidence };
  }

  private evaluateDomainAttribution(
    candidate: ExtractedMemoryCandidate,
    turns: readonly MemoryConversationTurn[],
    payload: ExtractWorkPayload,
  ): {
      ok: true;
      assertionType: 'groupArtifact' | 'assistantCommitment';
      subjectType: 'group' | 'assistant';
      subjectKey: string;
      evidence: MemoryEvidenceInput[];
      safeAudience: string[];
    } | { ok: false; reasonCode: string } {
    if (
      candidate.candidateType !== 'fact'
      || (candidate.subject !== 'group_shared' && candidate.subject !== 'assistant')
    ) {
      return { ok: false, reasonCode: 'candidate_invalid' };
    }
    if (candidate.sensitivity !== 'low') {
      return { ok: false, reasonCode: 'quality' };
    }
    const evidenceIds = uniqueStrings(candidate.evidenceMessageIds ?? []);
    const declaredSpeakers = uniqueStrings(candidate.evidenceSpeakerIds ?? []);
    if (!evidenceIds.length) {
      return { ok: false, reasonCode: 'attribution_missing_evidence' };
    }
    const byId = new Map(turns.map((turn) => [turn.id, turn]));
    const evidence: MemoryEvidenceInput[] = [];

    if (candidate.subject === 'group_shared') {
      const groupId = normalizeText(
        payload.address.groupId
        ?? payload.address.channelId
        ?? payload.address.rawContextId,
      );
      if (payload.address.channelType !== 'group' || !groupId) {
        return { ok: false, reasonCode: 'candidate_invalid' };
      }
      if (normalizeText(candidate.ownerSpeakerId) !== 'group') {
        return { ok: false, reasonCode: 'attribution_owner_mismatch' };
      }
      const actualSpeakers: string[] = [];
      for (const messageId of evidenceIds) {
        const turn = byId.get(messageId);
        if (!turn) {
          return { ok: false, reasonCode: 'attribution_evidence_outside_window' };
        }
        const speakerId = normalizeText(turn.speakerId);
        const speakerKey = `${payload.address.platform}:user:${speakerId}`;
        if (
          turn.role !== 'human'
          || turn.attributionSource !== 'additional_kwargs'
          || !speakerId
          || turn.ownerUserKey !== speakerKey
        ) {
          return { ok: false, reasonCode: 'attribution_evidence_untrusted' };
        }
        const captureAudienceSubjectKeys = this.capturedAudienceForMessage(
          payload,
          messageId,
        );
        if (
          !captureAudienceSubjectKeys
          || !captureAudienceSubjectKeys.includes(speakerKey)
        ) {
          return { ok: false, reasonCode: 'attribution_evidence_audience_missing' };
        }
        actualSpeakers.push(speakerId);
        evidence.push({
          messageId,
          speakerId,
          contextKey: payload.address.contextKey,
          threadId: payload.address.conversationId,
          captureAudienceSubjectKeys,
          replyToMessageId: turn.parentId ?? null,
          excerpt: turn.text,
          occurredAt: turn.occurredAt ?? payload.address.observedAt,
        });
      }
      if (serialize(uniqueStrings(actualSpeakers)) !== serialize(declaredSpeakers)) {
        return { ok: false, reasonCode: 'attribution_speaker_mismatch' };
      }
      const safeAudience = intersectStringSets(
        evidence.map((item) => item.captureAudienceSubjectKeys),
      );
      if (!safeAudience.length) {
        return { ok: false, reasonCode: 'attribution_evidence_audience_missing' };
      }
      return {
        ok: true,
        assertionType: 'groupArtifact',
        subjectType: 'group',
        subjectKey: `${payload.address.platform}:group:${groupId}`,
        evidence,
        safeAudience,
      };
    }

    if (normalizeText(candidate.ownerSpeakerId) !== payload.address.botSelfId) {
      return { ok: false, reasonCode: 'attribution_owner_mismatch' };
    }
    if (
      declaredSpeakers.length !== 1
      || declaredSpeakers[0] !== payload.address.botSelfId
    ) {
      return { ok: false, reasonCode: 'attribution_speaker_mismatch' };
    }
    for (const messageId of evidenceIds) {
      const turn = byId.get(messageId);
      if (
        !turn
        || turn.role !== 'ai'
        || turn.attributionSource !== 'assistant'
        || turn.speakerId !== payload.address.botSelfId
      ) {
        return {
          ok: false,
          reasonCode: turn
            ? 'attribution_evidence_untrusted'
            : 'attribution_evidence_outside_window',
        };
      }
      const parent = turn.parentId ? byId.get(turn.parentId) : null;
      const actorSpeakerId = normalizeText(parent?.speakerId);
      const actorKey = `${payload.address.platform}:user:${actorSpeakerId}`;
      if (
        !parent
        || parent.role !== 'human'
        || !actorSpeakerId
        || parent.ownerUserKey !== actorKey
        || !TRUSTED_ATTRIBUTION_SOURCES.has(parent.attributionSource)
      ) {
        return { ok: false, reasonCode: 'attribution_evidence_untrusted' };
      }
      const captureAudienceSubjectKeys = this.capturedAudienceForMessage(
        payload,
        parent.id,
      );
      if (
        !captureAudienceSubjectKeys
        || !captureAudienceSubjectKeys.includes(actorKey)
      ) {
        return { ok: false, reasonCode: 'attribution_evidence_audience_missing' };
      }
      evidence.push({
        messageId,
        speakerId: payload.address.botSelfId,
        contextKey: payload.address.contextKey,
        threadId: payload.address.conversationId,
        captureAudienceSubjectKeys,
        replyToMessageId: parent.id,
        excerpt: turn.text,
        occurredAt: turn.occurredAt ?? payload.address.observedAt,
      });
    }
    const safeAudience = intersectStringSets(
      evidence.map((item) => item.captureAudienceSubjectKeys),
    );
    if (!safeAudience.length) {
      return { ok: false, reasonCode: 'attribution_evidence_audience_missing' };
    }
    return {
      ok: true,
      assertionType: 'assistantCommitment',
      subjectType: 'assistant',
      subjectKey: `${payload.address.platform}:bot:${payload.address.botSelfId}`,
      evidence,
      safeAudience,
    };
  }

  private async appendAssertionTx(
    database: MemoryDatabaseLike,
    input: AppendAssertionInput,
  ): Promise<MemoryV2HeadRecord> {
    const duplicate = await database.get(MEMORY_LEDGER_TABLES.event, { idempotencyKey: input.idempotencyKey }) as MemoryV2EventRecord[];
    if (duplicate.length) {
      const [head] = await database.get(MEMORY_LEDGER_TABLES.head, { streamId: duplicate[0]!.streamId }) as MemoryV2HeadRecord[];
      if (!head) {
        throw new MemoryRuntimeError('extract', 'write', 'memory_idempotency_projection_missing', 'Existing memory event has no head projection.');
      }
      return head;
    }
    if (
      !input.content.trim()
      || !input.retrievalText.trim()
      || input.evidence.length === 0
      || input.evidence.some((evidence) => uniqueStrings(evidence.captureAudienceSubjectKeys).length === 0)
    ) {
      throw new MemoryRuntimeError('extract', 'validation', 'memory_assertion_invalid', 'Memory assertions require content, retrieval text, and evidence.');
    }
    if (
      input.subjectType === 'user'
      && input.evidence.some((evidence) => evidence.speakerId !== input.subjectKey.split(':').at(-1))
    ) {
      throw new MemoryRuntimeError('extract', 'validation', 'memory_assertion_speaker_conflict', 'Evidence speaker conflicts with the assertion subject.');
    }
    const streamId = input.streamId ?? randomUUID();
    const existingHead = await database.get(MEMORY_LEDGER_TABLES.head, { streamId }) as MemoryV2HeadRecord[];
    if (existingHead.length) {
      throw new MemoryRuntimeError('extract', 'validation', 'memory_stream_exists', 'Memory stream already exists.');
    }
    const now = input.createdAt ?? Date.now();
    const eventId = randomUUID();
    const payloadId = randomUUID();
    const content = input.content.trim();
    const retrievalText = input.retrievalText.trim();
    const contentHash = sha256(serialize([content, retrievalText]));
    const generation = await this.streamGeneration(database, input.subjectKey, streamId);
    const audienceContextKeys = uniqueStrings(input.audienceContextKeys);
    let audienceSnapshots: Record<string, string[]>;
    try {
      audienceSnapshots = parseAudienceSnapshots(serialize(input.audienceSnapshots));
    } catch (error) {
      throw new MemoryRuntimeError(
        'extract',
        'validation',
        'memory_capture_audience_missing',
        'Memory assertions require valid per-context capture audiences.',
        { cause: error },
      );
    }
    if (
      input.audiencePolicy !== 'subjectAllContexts'
      && audienceContextKeys.some((contextKey) => !audienceSnapshots[contextKey]?.length)
    ) {
      throw new MemoryRuntimeError(
        'extract',
        'validation',
        'memory_capture_audience_missing',
        'Every memory audience context requires an immutable capture snapshot.',
      );
    }
    const event: Omit<MemoryV2EventRecord, 'id'> = {
      eventId,
      streamId,
      revision: 1,
      eventType: 'asserted',
      assertionType: input.assertionType,
      subjectType: input.subjectType,
      subjectKey: input.subjectKey,
      actorKey: input.actorKey,
      sourceContextKey: input.sourceContextKey,
      audiencePolicy: input.audiencePolicy,
      audienceContextKeys: serialize(audienceContextKeys),
      audienceSnapshots: serialize(audienceSnapshots),
      sensitivity: input.sensitivity,
      payloadId,
      causationId: input.causationId ?? null,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    };
    await database.create(MEMORY_LEDGER_TABLES.event, event);
    await database.create(MEMORY_LEDGER_TABLES.payload, {
      payloadId,
      eventId,
      payloadKind: 'assertion',
      content,
      retrievalText,
      contentHash,
      createdAt: now,
    });
    for (const evidence of input.evidence) {
      let excerptPayloadId: string | null = null;
      if (evidence.excerpt?.trim()) {
        excerptPayloadId = randomUUID();
        const excerpt = evidence.excerpt.trim();
        await database.create(MEMORY_LEDGER_TABLES.payload, {
          payloadId: excerptPayloadId,
          eventId,
          payloadKind: 'evidenceExcerpt',
          content: excerpt,
          retrievalText: null,
          contentHash: sha256(excerpt),
          createdAt: now,
        });
      }
      await database.create(MEMORY_LEDGER_TABLES.evidence, {
        evidenceId: randomUUID(),
        eventId,
        messageId: evidence.messageId,
        speakerId: evidence.speakerId,
        contextKey: evidence.contextKey,
        threadId: evidence.threadId ?? null,
        captureAudienceSubjectKeys: serialize(uniqueStrings(evidence.captureAudienceSubjectKeys)),
        replyToMessageId: evidence.replyToMessageId ?? null,
        excerptPayloadId,
        occurredAt: evidence.occurredAt,
      });
    }
    const head = await database.create(MEMORY_LEDGER_TABLES.head, {
      streamId,
      eventId,
      revision: 1,
      state: input.state,
      assertionType: input.assertionType,
      subjectType: input.subjectType,
      subjectKey: input.subjectKey,
      sourceContextKey: input.sourceContextKey,
      audiencePolicy: input.audiencePolicy,
      audienceContextKeys: serialize(audienceContextKeys),
      audienceSnapshots: serialize(audienceSnapshots),
      sensitivity: input.sensitivity,
      payloadId,
      contentHash,
      importance: clamp01(input.importance),
      confidence: clamp01(input.confidence),
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
      expiresAt: input.expiresAt ?? null,
      deletionGeneration: generation,
      createdAt: now,
      updatedAt: now,
    }) as unknown as MemoryV2HeadRecord;
    if (input.state === 'active') {
      await this.searchIndex.insert(database, {
        streamId,
        eventId,
        revision: 1,
        contentHash,
        canonicalText: retrievalText,
      });
      if (input.embeddingIdentity) {
        const embedPayload: EmbeddingWorkPayload = {
          streamId,
          eventId,
          revision: 1,
          canonicalModel: input.embeddingIdentity.canonicalModel,
          modelRevision: input.embeddingIdentity.modelRevision,
          contentHash,
        };
        await this.queueWork(database, {
          workKey: embeddingWorkKey('embed', embedPayload),
          workType: 'embed',
          subjectKey: input.subjectKey,
          contextKey: input.sourceContextKey,
          streamId,
          payload: embedPayload,
          inputHash: sha256(embeddingTuple(embedPayload)),
          targetRevision: 1,
          deletionGeneration: generation,
        });
      }
    }
    await this.writeAudit(database, {
      idempotencyKey: `asserted:${input.idempotencyKey}`,
      subjectKey: input.subjectKey,
      contextKey: input.sourceContextKey,
      eventType: input.state === 'active' ? 'assertion_activated' : 'assertion_pending_review',
      streamId,
      eventId,
      workKey: input.auditWorkKey ?? null,
      detail: {
        assertionType: input.assertionType,
        state: input.state,
        evidenceCount: input.evidence.length,
      },
      createdAt: now,
    });
    return head;
  }

  async appendAssertion(input: AppendAssertionInput): Promise<MemoryV2HeadRecord> {
    if (
      input.subjectType !== 'user'
      || (input.assertionType !== 'userAssertion' && input.assertionType !== 'episode')
    ) {
      throw new MemoryRuntimeError(
        'extract',
        'validation',
        'memory_user_assertion_domain_invalid',
        'Automatic assertion ingestion only accepts user assertions and episodes.',
      );
    }
    return this.unitOfWork.run('extract', (database) => this.appendAssertionTx(database, input));
  }

  private deterministicDomainEvidence(
    input: DeterministicDomainMemoryInput,
    domain: 'groupArtifact' | 'assistantCommitment',
  ): {
      evidence: MemoryEvidenceInput[];
      audience: string[];
      subjectKey: string;
      laneKey: string;
    } {
    if (input.sensitivity !== 'low') {
      throw new MemoryRuntimeError(
        'extract',
        'validation',
        'memory_domain_ingest_sensitivity_invalid',
        'Deterministic domain ingestion only accepts low-sensitivity content.',
      );
    }
    const evidenceMessageIds = uniqueStrings(input.evidenceMessageIds);
    if (!evidenceMessageIds.length) {
      throw new MemoryRuntimeError(
        'extract',
        'validation',
        'memory_domain_ingest_evidence_missing',
        'Deterministic domain ingestion requires evidence.',
      );
    }
    const byId = new Map(input.turns.map((turn) => [turn.id, turn]));
    if (byId.size !== input.turns.length) {
      throw new MemoryRuntimeError(
        'extract',
        'validation',
        'memory_domain_ingest_evidence_duplicate',
        'Deterministic domain evidence message IDs must be unique.',
      );
    }
    const selected = evidenceMessageIds.map((messageId) => byId.get(messageId));
    if (selected.some((turn) => !turn)) {
      throw new MemoryRuntimeError(
        'extract',
        'validation',
        'memory_domain_ingest_evidence_outside_window',
        'Deterministic domain evidence must exist in the supplied window.',
      );
    }
    const captureByMessageId = new Map(
      (input.capturedAudiences ?? []).map((capture) => [
        capture.messageId,
        uniqueStrings(capture.audienceSubjectKeys),
      ]),
    );
    if (!captureByMessageId.size) {
      throw new MemoryRuntimeError(
        'extract',
        'validation',
        'memory_domain_ingest_audience_missing',
        'Deterministic domain ingestion requires immutable per-message audience captures.',
      );
    }

    let subjectKey: string;
    const evidence: MemoryEvidenceInput[] = [];
    if (domain === 'groupArtifact') {
      const groupId = normalizeText(
        input.address.groupId
        ?? input.address.channelId
        ?? input.address.rawContextId,
      );
      if (input.address.channelType !== 'group' || !groupId) {
        throw new MemoryRuntimeError(
          'extract',
          'validation',
          'memory_group_artifact_context_invalid',
          'Group artifacts require an immutable group context.',
        );
      }
      subjectKey = `${input.address.platform}:group:${groupId}`;
      for (const turn of selected as MemoryConversationTurn[]) {
        const speakerId = normalizeText(turn.speakerId);
        const speakerKey = speakerId
          ? `${input.address.platform}:user:${speakerId}`
          : null;
        const capturedAudience = captureByMessageId.get(turn.id) ?? [];
        if (
          turn.role !== 'human'
          || !speakerId
          || !speakerKey
          || turn.ownerUserKey !== speakerKey
          || turn.attributionSource !== 'additional_kwargs'
          || !capturedAudience.includes(speakerKey)
        ) {
          throw new MemoryRuntimeError(
            'extract',
            'validation',
            'memory_group_artifact_evidence_untrusted',
            'Every group artifact evidence message requires trusted speaker attribution.',
          );
        }
        evidence.push({
          messageId: turn.id,
          speakerId,
          contextKey: input.address.contextKey,
          threadId: input.address.conversationId,
          captureAudienceSubjectKeys: capturedAudience,
          replyToMessageId: turn.parentId ?? null,
          excerpt: turn.text,
          occurredAt: turn.occurredAt ?? input.address.observedAt,
        });
      }
    } else {
      subjectKey = `${input.address.platform}:bot:${input.address.botSelfId}`;
      for (const turn of selected as MemoryConversationTurn[]) {
        const parent = turn.parentId ? byId.get(turn.parentId) : null;
        const actorSpeakerId = normalizeText(parent?.speakerId);
        const actorKey = `${input.address.platform}:user:${actorSpeakerId}`;
        const capturedAudience = parent
          ? captureByMessageId.get(parent.id) ?? []
          : [];
        if (
          turn.role !== 'ai'
          || turn.attributionSource !== 'assistant'
          || !parent
          || parent.role !== 'human'
          || !actorSpeakerId
          || parent.ownerUserKey !== actorKey
          || !TRUSTED_ATTRIBUTION_SOURCES.has(parent.attributionSource)
          || !capturedAudience.includes(actorKey)
        ) {
          throw new MemoryRuntimeError(
            'extract',
            'validation',
            'memory_assistant_commitment_evidence_untrusted',
            'Assistant commitments require assistant message evidence.',
          );
        }
        evidence.push({
          messageId: turn.id,
          speakerId: input.address.botSelfId,
          contextKey: input.address.contextKey,
          threadId: input.address.conversationId,
          captureAudienceSubjectKeys: capturedAudience,
          replyToMessageId: parent.id,
          excerpt: turn.text,
          occurredAt: turn.occurredAt ?? input.address.observedAt,
        });
      }
    }
    const audience = intersectStringSets(
      evidence.map((item) => item.captureAudienceSubjectKeys),
    );
    if (!audience.length) {
      throw new MemoryRuntimeError(
        'extract',
        'validation',
        'memory_domain_ingest_audience_missing',
        'Deterministic domain evidence audiences have no safe intersection.',
      );
    }

    const guard = runDeterministicCaptureGuard({
      candidateType: 'fact',
      subject: domain === 'groupArtifact' ? 'group_shared' : 'assistant',
      ownerSpeakerId: domain === 'groupArtifact' ? 'group' : input.address.botSelfId,
      kind: 'plan',
      topicKey: domain,
      content: input.content,
      keywords: [],
      importance: input.importance,
      confidence: input.confidence,
      sensitivity: input.sensitivity,
      evidenceMessageIds,
      evidenceSpeakerIds: selected.map((turn) => (
        domain === 'assistantCommitment'
          ? input.address.botSelfId
          : (turn as MemoryConversationTurn).speakerId!
      )),
    }, {
      ...input.address,
      currentAudienceSubjectKeys: audience,
    }, this.policy);
    if (guard.state !== 'active' || guard.sensitivity !== 'low') {
      throw new MemoryRuntimeError(
        'extract',
        'validation',
        'memory_domain_ingest_safety_rejected',
        'Deterministic domain content did not pass the capture safety policy.',
      );
    }

    const laneKey = `domain:${domain}:${subjectKey}:${input.address.contextKey}`;
    return {
      subjectKey,
      audience,
      laneKey,
      evidence,
    };
  }

  private async ingestDeterministicDomain(
    domain: 'groupArtifact' | 'assistantCommitment',
    input: DeterministicDomainMemoryInput,
  ): Promise<DeterministicDomainMemoryResult> {
    const resolved = this.deterministicDomainEvidence(input, domain);
    const evidenceMessageIds = uniqueStrings(input.evidenceMessageIds);
    const inputHash = sha256(serialize([
      input.content.trim(),
      input.retrievalText.trim(),
      evidenceMessageIds,
    ]));
    const workKey = `domain-ingest:${sha256(serialize([
      resolved.laneKey,
      inputHash,
    ]))}`;
    const idempotencyKey = `domain:${domain}:${sha256(serialize([
      resolved.laneKey,
      evidenceMessageIds,
      inputHash,
    ]))}`;
    const head = await this.unitOfWork.run('extract', async (database) => {
      await this.assertEvidenceSourcesAvailable(database, resolved.evidence);
      return this.appendAssertionTx(database, {
        idempotencyKey,
        assertionType: domain,
        subjectType: domain === 'groupArtifact' ? 'group' : 'assistant',
        subjectKey: resolved.subjectKey,
        actorKey: `memory.domain.${domain}`,
        sourceContextKey: input.address.contextKey,
        audiencePolicy: input.address.channelType === 'group'
          ? 'captureAudience'
          : 'sourceContext',
        audienceContextKeys: [input.address.contextKey],
        audienceSnapshots: {
          [input.address.contextKey]: resolved.audience,
        },
        sensitivity: input.sensitivity,
        state: 'active',
        content: input.content,
        retrievalText: input.retrievalText,
        importance: input.importance,
        confidence: input.confidence,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        expiresAt: input.expiresAt,
        evidence: resolved.evidence,
        embeddingIdentity: input.embeddingIdentity,
        causationId: workKey,
        auditWorkKey: workKey,
        createdAt: input.createdAt,
      });
    });
    return {
      head,
      laneKey: resolved.laneKey,
      workKey,
      idempotencyKey,
    };
  }

  async ingestGroupArtifact(
    input: DeterministicDomainMemoryInput,
  ): Promise<DeterministicDomainMemoryResult> {
    return this.ingestDeterministicDomain('groupArtifact', input);
  }

  async ingestAssistantCommitment(
    input: DeterministicDomainMemoryInput,
  ): Promise<DeterministicDomainMemoryResult> {
    return this.ingestDeterministicDomain('assistantCommitment', input);
  }

  async finalizeExtraction(input: {
    work: MemoryV2WorkRecord;
    leaseToken: string;
    payload: ExtractWorkPayload;
    turns: MemoryConversationTurn[];
    candidates: ExtractedMemoryCandidate[];
    providerRoute: MemoryOutputProtocolId;
    rawTextHash: string | null;
    embeddingIdentity: MemoryEmbeddingIdentity | null;
    maxLeaseRetries?: number;
  }): Promise<{ active: number; pendingReview: number; rejected: number }> {
    return this.runLeaseTransaction('extract', input.work, input.leaseToken, async (database, current) => {
      const counts = { active: 0, pendingReview: 0, rejected: 0 };
      const [cursor] = await database.get(MEMORY_LEDGER_TABLES.cursor, {
        laneKey: current.laneKey,
      }) as MemoryV2CursorRecord[];
      const anchorCapture = input.payload.capturedAudiences.find(
        (capture) => capture.messageId === input.payload.latestAnchorMessageId,
      );
      if (!anchorCapture) {
        throw new MemoryRuntimeError(
          'extract',
          'validation',
          'memory_extract_anchor_audience_missing',
          'Extraction anchor has no immutable audience capture.',
        );
      }
      if (
        cursor?.lastMessageAt != null
        && cursor.lastMessageAt >= anchorCapture.observedAt
        && cursor.lastMessageId !== input.payload.latestAnchorMessageId
      ) {
        await this.cancelWorkTx(
          database,
          current,
          'memory_extract_anchor_superseded',
        );
        return counts;
      }
      const turns = await this.filterSuppressedTurnsTx(
        database,
        input.payload.address.userKey,
        input.payload.address.contextKey,
        input.turns,
      );
      for (const [index, candidate] of input.candidates.entries()) {
        const normalized = candidateContent(candidate);
        if (
          candidate.candidateType === 'fact'
          && (candidate.subject === 'group_shared' || candidate.subject === 'assistant')
        ) {
          const attribution = this.evaluateDomainAttribution(
            candidate,
            turns,
            input.payload,
          );
          const domainCapture = attribution.ok
            ? runDeterministicCaptureGuard(candidate, {
                ...input.payload.address,
                currentAudienceSubjectKeys: attribution.safeAudience,
              }, this.policy)
            : null;
          if (
            !attribution.ok
            || !normalized
            || !domainCapture
            || domainCapture.state !== 'active'
            || domainCapture.sensitivity !== 'low'
          ) {
            counts.rejected += 1;
            await this.writeAudit(database, {
              idempotencyKey: `extract-rejected:${current.workKey}:${index}`,
              subjectKey: input.payload.address.userKey,
              contextKey: input.payload.address.contextKey,
              eventType: 'candidate_rejected',
              workKey: current.workKey,
              detail: {
                candidateIndex: index,
                reasonCode: attribution.ok
                  ? domainCapture?.reasonCode ?? 'quality'
                  : attribution.reasonCode,
              },
            });
            continue;
          }
          const evidenceMessageIds = attribution.evidence
            .map((item) => item.messageId)
            .sort();
          await this.appendAssertionTx(database, {
            idempotencyKey: `extract-domain:${sha256(serialize([
              attribution.assertionType,
              attribution.subjectKey,
              input.payload.address.contextKey,
              evidenceMessageIds,
              normalized.content,
              normalized.retrievalText,
            ]))}`,
            assertionType: attribution.assertionType,
            subjectType: attribution.subjectType,
            subjectKey: attribution.subjectKey,
            actorKey: 'memory.extract',
            sourceContextKey: input.payload.address.contextKey,
            audiencePolicy: input.payload.address.channelType === 'group'
              ? 'captureAudience'
              : 'sourceContext',
            audienceContextKeys: [input.payload.address.contextKey],
            audienceSnapshots: {
              [input.payload.address.contextKey]: attribution.safeAudience,
            },
            sensitivity: 'low',
            state: 'active',
            content: normalized.content,
            retrievalText: normalized.retrievalText,
            importance: candidate.importance,
            confidence: candidate.confidence,
            validFrom: toTimestamp(candidate.validFrom),
            validUntil: toTimestamp(candidate.validUntil),
            expiresAt: toTimestamp(candidate.expiresAt),
            evidence: attribution.evidence,
            embeddingIdentity: input.embeddingIdentity,
            causationId: current.workKey,
          });
          counts.active += 1;
          continue;
        }
        const attribution = this.evaluateAttribution(
          candidate,
          turns,
          input.payload,
        );
        const safeAudience = attribution.ok
          ? intersectStringSets(
              attribution.evidence.map(
                (evidence) => evidence.captureAudienceSubjectKeys,
              ),
            )
          : [];
        const userCapture = attribution.ok
          ? runDeterministicCaptureGuard(candidate, {
              ...input.payload.address,
              currentAudienceSubjectKeys: safeAudience,
            }, this.policy)
          : null;
        if (
          !attribution.ok
          || !userCapture
          || userCapture.state === 'rejected'
          || !normalized
          || !safeAudience.includes(input.payload.address.userKey)
        ) {
          counts.rejected += 1;
          await this.writeAudit(database, {
            idempotencyKey: `extract-rejected:${current.workKey}:${index}`,
            subjectKey: input.payload.address.userKey,
            contextKey: input.payload.address.contextKey,
            eventType: 'candidate_rejected',
            workKey: current.workKey,
            detail: {
              candidateIndex: index,
              reasonCode: attribution.ok
                ? userCapture?.reasonCode ?? 'candidate_invalid'
                : attribution.reasonCode,
            },
          });
          continue;
        }
        const evidence: MemoryEvidenceInput[] = attribution.evidence.map((item) => ({
          messageId: item.turn.id,
          speakerId: item.turn.speakerId!,
          contextKey: input.payload.address.contextKey,
          threadId: input.payload.address.conversationId,
          captureAudienceSubjectKeys: item.captureAudienceSubjectKeys,
          replyToMessageId: item.turn.parentId ?? null,
          excerpt: item.turn.text,
          occurredAt: item.turn.occurredAt ?? input.payload.address.observedAt,
        }));
        const state = userCapture.state === 'pendingReview' ? 'pendingReview' : 'active';
        const evidenceMessageIds = evidence
          .map((item) => item.messageId)
          .sort();
        await this.appendAssertionTx(database, {
          idempotencyKey: `extract:${sha256(serialize([
            current.laneKey,
            normalized.assertionType,
            evidenceMessageIds,
            normalized.content,
          ]))}`,
          assertionType: normalized.assertionType,
          subjectType: 'user',
          subjectKey: input.payload.address.userKey,
          actorKey: 'memory.extract',
          sourceContextKey: input.payload.address.contextKey,
          audiencePolicy: userCapture.audiencePolicy,
          audienceContextKeys: userCapture.audienceContextKeys,
          audienceSnapshots: userCapture.audienceSnapshots,
          sensitivity: userCapture.sensitivity,
          state,
          content: normalized.content,
          retrievalText: normalized.retrievalText,
          importance: candidate.importance,
          confidence: candidate.confidence,
          validFrom: toTimestamp(candidate.validFrom),
          validUntil: toTimestamp(candidate.validUntil),
          expiresAt: toTimestamp(candidate.expiresAt),
          evidence,
          embeddingIdentity: state === 'active' ? input.embeddingIdentity : null,
          causationId: current.workKey,
        });
        counts[state] += 1;
      }
      const now = Date.now();
      const cursorPatch = {
        subjectKey: input.payload.address.userKey,
        contextKey: input.payload.address.contextKey,
        conversationId: input.payload.address.conversationId,
        lastMessageId: input.payload.latestAnchorMessageId,
        lastMessageAt: input.payload.address.observedAt,
        lastWindowHash: input.rawTextHash,
        discardBeforeMessageId: null,
        updatedAt: now,
      };
      const previousCursorMessageId = cursor?.discardBeforeMessageId
        ?? cursor?.lastMessageId
        ?? null;
      const canAdvanceCursor = !cursor
        || previousCursorMessageId == null
        || previousCursorMessageId === input.payload.latestAnchorMessageId
        || await this.messageDescendsFrom(
          database,
          input.payload.address.conversationId,
          input.payload.latestAnchorMessageId,
          previousCursorMessageId,
        );
      if (
        cursor
        && canAdvanceCursor
      ) {
        await database.set(MEMORY_LEDGER_TABLES.cursor, {
          id: cursor.id,
          lastMessageId: cursor.lastMessageId,
          lastMessageAt: cursor.lastMessageAt,
        }, cursorPatch);
      } else {
        if (!cursor && canAdvanceCursor) {
          await database.create(MEMORY_LEDGER_TABLES.cursor, {
            laneKey: current.laneKey,
            ...cursorPatch,
            firstSeenAt: now,
          });
        }
      }
      await database.set(MEMORY_LEDGER_TABLES.work, { id: current.id }, {
        status: 'succeeded',
        leaseToken: null,
        leaseExpiresAt: null,
        payload: '{}',
        updatedAt: now,
        completedAt: now,
      });
      await this.writeAudit(database, {
        idempotencyKey: `extract-finalized:${current.workKey}`,
        subjectKey: current.subjectKey,
        contextKey: current.contextKey,
        eventType: 'extract_finalized',
        workKey: current.workKey,
        detail: {
          providerRoute: input.providerRoute,
          activeCount: counts.active,
          pendingReviewCount: counts.pendingReview,
          rejectedCount: counts.rejected,
        },
      });
      return counts;
    }, {
      maxLeaseRetries: input.maxLeaseRetries,
    });
  }

  async completeEmptyExtraction(
    work: MemoryV2WorkRecord,
    leaseToken: string,
    payload: ExtractWorkPayload,
    rawTextHash: string | null,
    maxLeaseRetries?: number,
  ): Promise<void> {
    await this.finalizeExtraction({
      work,
      leaseToken,
      payload,
      turns: [],
      candidates: [],
      providerRoute: 'native_chat_json_schema',
      rawTextHash,
      embeddingIdentity: null,
      maxLeaseRetries,
    });
  }

  private async cancelWorkTx(
    database: MemoryDatabaseLike,
    work: MemoryV2WorkRecord,
    reasonCode: string,
    now = Date.now(),
  ): Promise<void> {
    await database.set(MEMORY_LEDGER_TABLES.work, { id: work.id }, {
      status: 'cancelled',
      leaseToken: null,
      leaseExpiresAt: null,
      payload: '{}',
      lastErrorCode: reasonCode,
      lastErrorStage: 'finalize',
      upstreamStatus: null,
      providerCode: null,
      updatedAt: now,
      completedAt: now,
    });
  }

  private async cancelEmbeddingWorkForStream(
    database: MemoryDatabaseLike,
    streamId: string,
    reasonCode: string,
    now = Date.now(),
  ): Promise<void> {
    const work = await database.get(MEMORY_LEDGER_TABLES.work, {
      streamId,
    }) as MemoryV2WorkRecord[];
    for (const row of work) {
      if (
        (row.workType === 'embed' || row.workType === 'backfill')
        && (
          row.status === 'pending'
          || row.status === 'leased'
          || row.status === 'failed'
          || row.status === 'deadLetter'
        )
      ) {
        await this.cancelWorkTx(database, row, reasonCode, now);
      }
    }
  }

  private async cancelObsoleteEmbeddingWork(
    database: MemoryDatabaseLike,
    activeByStream: ReadonlyMap<string, MemoryV2HeadRecord>,
    identity: MemoryEmbeddingIdentity,
    now = Date.now(),
  ): Promise<void> {
    const work = await database.get(MEMORY_LEDGER_TABLES.work, {}) as MemoryV2WorkRecord[];
    for (const row of work) {
      if (
        (row.workType !== 'embed' && row.workType !== 'backfill')
        || (
          row.status !== 'pending'
          && row.status !== 'leased'
          && row.status !== 'failed'
          && row.status !== 'deadLetter'
        )
      ) {
        continue;
      }
      const payload = workPayload<EmbeddingWorkPayload>(row);
      const head = activeByStream.get(payload.streamId);
      const current = head
        && payload.eventId === head.eventId
        && payload.revision === head.revision
        && payload.contentHash === head.contentHash
        && payload.canonicalModel === identity.canonicalModel
        && payload.modelRevision === identity.modelRevision
        && row.deletionGeneration === head.deletionGeneration;
      if (!current) {
        await this.cancelWorkTx(
          database,
          row,
          'memory_embedding_superseded',
          now,
        );
      }
    }
  }

  async resolveEmbeddingWork(
    work: MemoryV2WorkRecord,
    identity: MemoryEmbeddingIdentity,
  ): Promise<EmbeddingWorkResolution> {
    const payload = workPayload<EmbeddingWorkPayload>(work);
    if (
      payload.canonicalModel !== identity.canonicalModel
      || payload.modelRevision !== identity.modelRevision
    ) {
      return {
        state: 'obsolete',
        reasonCode: 'memory_embedding_identity_superseded',
      };
    }
    const [head] = await this.database.get(MEMORY_LEDGER_TABLES.head, {
      streamId: payload.streamId,
    }) as MemoryV2HeadRecord[];
    if (
      !head
      || head.state !== 'active'
      || head.eventId !== payload.eventId
      || head.revision !== payload.revision
      || head.contentHash !== payload.contentHash
      || !head.payloadId
    ) {
      return {
        state: 'obsolete',
        reasonCode: 'memory_embedding_target_superseded',
      };
    }
    const [storedPayload] = await this.database.get(MEMORY_LEDGER_TABLES.payload, {
      payloadId: head.payloadId,
    }) as MemoryV2PayloadRecord[];
    if (!storedPayload || storedPayload.contentHash !== payload.contentHash || !storedPayload.retrievalText?.trim()) {
      return {
        state: 'obsolete',
        reasonCode: 'memory_embedding_target_superseded',
      };
    }
    return {
      state: 'ready',
      payload,
      text: storedPayload.retrievalText,
    };
  }

  async finalizeEmbedding(input: {
    work: MemoryV2WorkRecord;
    leaseToken: string;
    payload: EmbeddingWorkPayload;
    vector: number[];
    maxLeaseRetries?: number;
  }): Promise<void> {
    await this.runLeaseTransaction('embed', input.work, input.leaseToken, async (database, current) => {
      const [head] = await database.get(MEMORY_LEDGER_TABLES.head, {
        streamId: input.payload.streamId,
      }) as MemoryV2HeadRecord[];
      if (
        !head
        || head.state !== 'active'
        || head.eventId !== input.payload.eventId
        || head.revision !== input.payload.revision
        || head.contentHash !== input.payload.contentHash
        || head.deletionGeneration !== current.deletionGeneration
      ) {
        const now = Date.now();
        await this.cancelWorkTx(
          database,
          current,
          'memory_embedding_target_superseded',
          now,
        );
        await this.writeAudit(database, {
          idempotencyKey: `embedding-superseded:${current.workKey}`,
          subjectKey: current.subjectKey,
          contextKey: current.contextKey,
          eventType: 'embedding_work_superseded',
          streamId: current.streamId,
          workKey: current.workKey,
          detail: {
            reasonCode: 'memory_embedding_target_superseded',
          },
          createdAt: now,
        });
        return;
      }
      const embeddingKey = sha256(embeddingTuple(input.payload));
      const existing = await database.get(MEMORY_LEDGER_TABLES.embedding, { embeddingKey }) as MemoryV2EmbeddingRecord[];
      if (!existing.length) {
        await database.create(MEMORY_LEDGER_TABLES.embedding, {
          embeddingKey,
          ...input.payload,
          dimensions: input.vector.length,
          vector: serialize(input.vector),
          createdAt: Date.now(),
        });
      }
      await database.set(MEMORY_LEDGER_TABLES.work, { id: current.id }, {
        status: 'succeeded',
        leaseToken: null,
        leaseExpiresAt: null,
        payload: '{}',
        updatedAt: Date.now(),
        completedAt: Date.now(),
      });
      await this.writeAudit(database, {
        idempotencyKey: `embedding-finalized:${current.workKey}`,
        subjectKey: current.subjectKey,
        contextKey: current.contextKey,
        eventType: 'embedding_finalized',
        streamId: current.streamId,
        workKey: current.workKey,
        detail: {
          canonicalModel: input.payload.canonicalModel,
          modelRevision: input.payload.modelRevision,
          dimensions: input.vector.length,
        },
      });
    }, {
      maxLeaseRetries: input.maxLeaseRetries,
    });
  }

  async cancelWork(
    work: MemoryV2WorkRecord,
    leaseToken: string,
    reasonCode: string,
  ): Promise<void> {
    await this.runLeaseTransaction(work.workType === 'extract' ? 'extract' : 'embed', work, leaseToken, async (database, current) => {
      await this.cancelWorkTx(database, current, reasonCode);
    }, {
      allowExpired: true,
    });
  }

  async queueBackfill(identity: MemoryEmbeddingIdentity): Promise<number> {
    return this.unitOfWork.run('backfill', async (database) => {
      const heads = await database.get(MEMORY_LEDGER_TABLES.head, {}) as MemoryV2HeadRecord[];
      const activeByStream = new Map(
        heads.filter((head) => head.state === 'active').map((head) => [head.streamId, head]),
      );
      await this.cancelObsoleteEmbeddingWork(
        database,
        activeByStream,
        identity,
      );
      const projections = await this.searchIndex.list(database);
      for (const projection of projections) {
        if (!activeByStream.has(projection.streamId)) {
          await this.searchIndex.remove(database, projection.streamId);
        }
      }
      const embeddings = await database.get(
        MEMORY_LEDGER_TABLES.embedding,
        {},
      ) as MemoryV2EmbeddingRecord[];
      for (const embedding of embeddings) {
        const head = activeByStream.get(embedding.streamId);
        if (
          !head
          || embedding.eventId !== head.eventId
          || embedding.revision !== head.revision
          || embedding.contentHash !== head.contentHash
          || embedding.canonicalModel !== identity.canonicalModel
          || embedding.modelRevision !== identity.modelRevision
        ) {
          await database.remove(MEMORY_LEDGER_TABLES.embedding, { id: embedding.id });
        }
      }

      let queued = 0;
      for (const head of activeByStream.values()) {
        if (!head.payloadId || !head.contentHash) continue;
        const [assertionPayload] = await database.get(MEMORY_LEDGER_TABLES.payload, {
          payloadId: head.payloadId,
          payloadKind: 'assertion',
        }) as MemoryV2PayloadRecord[];
        const canonicalText = assertionPayload?.retrievalText ?? assertionPayload?.content ?? '';
        const currentProjection = await this.searchIndex.get(database, head.streamId);
        if (
          !assertionPayload
          || assertionPayload.contentHash !== head.contentHash
          || !canonicalText.trim()
        ) {
          if (currentProjection.length) {
            await this.searchIndex.remove(database, head.streamId);
          }
          await database.remove(MEMORY_LEDGER_TABLES.embedding, { streamId: head.streamId });
          continue;
        }
        if (
          currentProjection.length !== 1
          || !memoryLexicalProjectionMatches(currentProjection[0]!, {
            streamId: head.streamId,
            eventId: head.eventId,
            revision: head.revision,
            contentHash: head.contentHash,
            canonicalText,
          })
        ) {
          await this.searchIndex.remove(database, head.streamId);
          await this.searchIndex.insert(database, {
            streamId: head.streamId,
            eventId: head.eventId,
            revision: head.revision,
            contentHash: head.contentHash,
            canonicalText,
          });
        }

        const currentEmbedding = await database.get(MEMORY_LEDGER_TABLES.embedding, {
          streamId: head.streamId,
          eventId: head.eventId,
          revision: head.revision,
          canonicalModel: identity.canonicalModel,
          modelRevision: identity.modelRevision,
          contentHash: head.contentHash,
        });
        if (currentEmbedding.length) continue;
        const payload: EmbeddingWorkPayload = {
          streamId: head.streamId,
          eventId: head.eventId,
          revision: head.revision,
          canonicalModel: identity.canonicalModel,
          modelRevision: identity.modelRevision,
          contentHash: head.contentHash,
        };
        const liveTargetWork = (
          await database.get(MEMORY_LEDGER_TABLES.work, {
            streamId: head.streamId,
          }) as MemoryV2WorkRecord[]
        ).some((row) => {
          if (
            (row.workType !== 'embed' && row.workType !== 'backfill')
            || (row.status !== 'pending' && row.status !== 'leased')
          ) {
            return false;
          }
          const workTarget = workPayload<EmbeddingWorkPayload>(row);
          return embeddingTuple(workTarget) === embeddingTuple(payload);
        });
        if (liveTargetWork) continue;
        const inserted = await this.queueWork(database, {
          workKey: embeddingWorkKey('backfill', payload),
          workType: 'backfill',
          subjectKey: head.subjectKey,
          contextKey: head.sourceContextKey,
          streamId: head.streamId,
          payload,
          inputHash: sha256(embeddingTuple(payload)),
          targetRevision: head.revision,
          deletionGeneration: head.deletionGeneration,
        });
        if (inserted) {
          queued += 1;
          continue;
        }
        const [existing] = await database.get(MEMORY_LEDGER_TABLES.work, {
          workKey: embeddingWorkKey('backfill', payload),
        }) as MemoryV2WorkRecord[];
        if (existing && existing.status !== 'pending' && existing.status !== 'leased') {
          const now = Date.now();
          await database.set(MEMORY_LEDGER_TABLES.work, { id: existing.id }, {
            workType: 'backfill',
            status: 'pending',
            subjectKey: head.subjectKey,
            contextKey: head.sourceContextKey,
            streamId: head.streamId,
            laneKey: null,
            payload: serialize(payload),
            inputHash: sha256(embeddingTuple(payload)),
            targetRevision: head.revision,
            deletionGeneration: head.deletionGeneration,
            retryCount: 0,
            nextRunAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
            lastErrorCode: null,
            lastErrorStage: null,
            upstreamStatus: null,
            providerCode: null,
            updatedAt: now,
            completedAt: null,
          });
          queued += 1;
        }
      }
      return queued;
    });
  }

  async listForContext(
    address: MemoryAddress,
    identity: MemoryEmbeddingIdentity | null,
    now = Date.now(),
    query = '',
  ): Promise<MemoryLedgerItem[]> {
    const heads = await this.database.get(MEMORY_LEDGER_TABLES.head, { state: 'active' }) as MemoryV2HeadRecord[];
    const visible = heads.filter((head) => this.policy.canRecall({
      ...head,
      audienceContextKeys: parseAudienceContextKeys(head.audienceContextKeys),
      audienceSnapshots: parseAudienceSnapshots(head.audienceSnapshots),
    }, address, now));
    const items: MemoryLedgerItem[] = [];
    for (const head of visible) {
      if (!head.payloadId || !head.contentHash) continue;
      const [payload] = await this.database.get(MEMORY_LEDGER_TABLES.payload, { payloadId: head.payloadId }) as MemoryV2PayloadRecord[];
      const evidence = payload
        ? await this.database.get(MEMORY_LEDGER_TABLES.evidence, { eventId: payload.eventId }) as MemoryV2EvidenceRecord[]
        : [];
      const projections = await this.searchIndex.get(this.database, head.streamId);
      const canonicalText = payload?.retrievalText ?? payload?.content ?? '';
      if (
        !payload
        || payload.contentHash !== head.contentHash
        || !evidence.length
        || projections.length !== 1
        || !memoryLexicalProjectionMatches(projections[0]!, {
          streamId: head.streamId,
          eventId: head.eventId,
          revision: head.revision,
          contentHash: head.contentHash,
          canonicalText,
        })
      ) {
        continue;
      }
      let embedding: MemoryV2EmbeddingRecord | null = null;
      if (identity) {
        [embedding] = await this.database.get(MEMORY_LEDGER_TABLES.embedding, {
          streamId: head.streamId,
          revision: head.revision,
          canonicalModel: identity.canonicalModel,
          modelRevision: identity.modelRevision,
          contentHash: head.contentHash,
        }) as MemoryV2EmbeddingRecord[];
      }
      items.push({
        streamId: head.streamId,
        revision: head.revision,
        assertionType: head.assertionType,
        subjectType: head.subjectType,
        subjectKey: head.subjectKey,
        sourceContextKey: head.sourceContextKey,
        audiencePolicy: head.audiencePolicy,
        audienceContextKeys: parseAudienceContextKeys(head.audienceContextKeys),
        audienceSnapshots: parseAudienceSnapshots(head.audienceSnapshots),
        sensitivity: head.sensitivity,
        state: head.state,
        content: payload.content,
        retrievalText: payload.retrievalText ?? payload.content,
        contentHash: payload.contentHash,
        importance: head.importance,
        confidence: head.confidence,
        validFrom: head.validFrom,
        validUntil: head.validUntil,
        expiresAt: head.expiresAt,
        embeddingModel: embedding?.canonicalModel ?? null,
        embeddingModelRevision: embedding?.modelRevision ?? null,
        embedding: embedding ? parseVector(embedding.vector) : null,
        ftsScore: null,
        evidence,
        updatedAt: head.updatedAt,
      });
    }
    const ftsScores = query.trim()
      ? await this.searchIndex.search(
          this.database,
          query,
          items.map((item) => item.streamId),
          Math.max(100, items.length),
        )
      : new Map<string, number>();
    for (const item of items) item.ftsScore = ftsScores.get(item.streamId) ?? null;
    return items.sort((left, right) => right.updatedAt - left.updatedAt || left.streamId.localeCompare(right.streamId));
  }

  async listForOwner(
    address: MemoryAddress,
    privateExport = false,
    now = Date.now(),
  ): Promise<MemoryLedgerItem[]> {
    const heads = await this.database.get(MEMORY_LEDGER_TABLES.head, { subjectKey: address.userKey }) as MemoryV2HeadRecord[];
    const items: MemoryLedgerItem[] = [];
    for (const head of heads) {
      const audienceContextKeys = parseAudienceContextKeys(head.audienceContextKeys);
      const audienceSnapshots = parseAudienceSnapshots(head.audienceSnapshots);
      if (!this.policy.canList({
        ...head,
        audienceContextKeys,
        audienceSnapshots,
      }, address, privateExport, now)) continue;
      if (!head.payloadId || !head.contentHash) continue;
      const [payload] = await this.database.get(MEMORY_LEDGER_TABLES.payload, { payloadId: head.payloadId }) as MemoryV2PayloadRecord[];
      if (!payload) continue;
      const evidence = await this.database.get(MEMORY_LEDGER_TABLES.evidence, { eventId: payload.eventId }) as MemoryV2EvidenceRecord[];
      items.push({
        streamId: head.streamId,
        revision: head.revision,
        assertionType: head.assertionType,
        subjectType: head.subjectType,
        subjectKey: head.subjectKey,
        sourceContextKey: head.sourceContextKey,
        audiencePolicy: head.audiencePolicy,
        audienceContextKeys,
        audienceSnapshots,
        sensitivity: head.sensitivity,
        state: head.state,
        content: payload.content,
        retrievalText: payload.retrievalText ?? payload.content,
        contentHash: payload.contentHash,
        importance: head.importance,
        confidence: head.confidence,
        validFrom: head.validFrom,
        validUntil: head.validUntil,
        expiresAt: head.expiresAt,
        embeddingModel: null,
        embeddingModelRevision: null,
        embedding: null,
        ftsScore: null,
        evidence,
        updatedAt: head.updatedAt,
      });
    }
    return items.sort((left, right) => right.updatedAt - left.updatedAt || left.streamId.localeCompare(right.streamId));
  }

  async review(input: {
    streamId: string;
    actor: { userKey: string; isDirect: boolean; isAdmin?: boolean };
    decision: 'approve' | 'reject';
    embeddingIdentity?: MemoryEmbeddingIdentity | null;
  }): Promise<void> {
    await this.unitOfWork.run('review', async (database) => {
      const [head] = await database.get(MEMORY_LEDGER_TABLES.head, { streamId: input.streamId }) as MemoryV2HeadRecord[];
      if (!head) {
        throw new MemoryRuntimeError('review', 'validation', 'memory_stream_not_found', 'Memory stream does not exist.');
      }
      this.policy.assertCanReview({
        state: head.state,
        subjectType: head.subjectType,
        subjectKey: head.subjectKey,
      }, input.actor);
      const now = Date.now();
      const revision = head.revision + 1;
      const eventId = randomUUID();
      const state = input.decision === 'approve' ? 'active' : 'archived';
      await database.create(MEMORY_LEDGER_TABLES.event, {
        eventId,
        streamId: head.streamId,
        revision,
        eventType: input.decision === 'approve' ? 'reviewed' : 'archived',
        assertionType: head.assertionType,
        subjectType: head.subjectType,
        subjectKey: head.subjectKey,
        actorKey: input.actor.isAdmin ? 'admin' : input.actor.userKey,
        sourceContextKey: head.sourceContextKey,
        audiencePolicy: head.audiencePolicy,
        audienceContextKeys: head.audienceContextKeys,
        audienceSnapshots: head.audienceSnapshots,
        sensitivity: head.sensitivity,
        payloadId: input.decision === 'approve' ? head.payloadId : null,
        causationId: head.eventId,
        idempotencyKey: `review:${head.streamId}:${revision}:${input.decision}`,
        createdAt: now,
      });
      if (input.decision === 'approve') {
        const [payload] = await database.get(MEMORY_LEDGER_TABLES.payload, { payloadId: head.payloadId }) as MemoryV2PayloadRecord[];
        if (!payload?.retrievalText || payload.contentHash !== head.contentHash) {
          throw new MemoryRuntimeError('review', 'validation', 'memory_review_payload_missing', 'Pending memory payload is unavailable.');
        }
        await this.searchIndex.insert(database, {
          streamId: head.streamId,
          eventId,
          revision,
          contentHash: payload.contentHash,
          canonicalText: payload.retrievalText,
        });
        if (input.embeddingIdentity) {
          const embedPayload: EmbeddingWorkPayload = {
            streamId: head.streamId,
            eventId,
            revision,
            canonicalModel: input.embeddingIdentity.canonicalModel,
            modelRevision: input.embeddingIdentity.modelRevision,
            contentHash: payload.contentHash,
          };
          await this.queueWork(database, {
            workKey: embeddingWorkKey('embed', embedPayload),
            workType: 'embed',
            subjectKey: head.subjectKey,
            contextKey: head.sourceContextKey,
            streamId: head.streamId,
            payload: embedPayload,
            inputHash: sha256(embeddingTuple(embedPayload)),
            targetRevision: revision,
            deletionGeneration: head.deletionGeneration,
          });
        }
      } else {
        await this.clearStreamContent(database, head.streamId);
      }
      await database.set(MEMORY_LEDGER_TABLES.head, { id: head.id }, {
        eventId,
        revision,
        state,
        payloadId: input.decision === 'approve' ? head.payloadId : null,
        contentHash: input.decision === 'approve' ? head.contentHash : null,
        updatedAt: now,
      });
      await this.writeAudit(database, {
        idempotencyKey: `review-audit:${head.streamId}:${revision}`,
        subjectKey: head.subjectKey,
        contextKey: head.sourceContextKey,
        eventType: input.decision === 'approve' ? 'review_approved' : 'review_rejected',
        streamId: head.streamId,
        eventId,
        detail: { reviewer: input.actor.isAdmin ? 'admin' : 'subject' },
      });
    });
  }

  async promoteAudience(input: {
    streamId: string;
    actor: { userKey: string; isDirect: boolean; isAdmin?: boolean };
    audiencePolicy: 'subjectAllContexts' | 'explicitContexts';
    audienceContextKeys: string[];
    audienceSnapshots: Record<string, string[]>;
    embeddingIdentity: MemoryEmbeddingIdentity;
  }): Promise<void> {
    await this.unitOfWork.run('review', async (database) => {
      const [head] = await database.get(MEMORY_LEDGER_TABLES.head, {
        streamId: input.streamId,
      }) as MemoryV2HeadRecord[];
      if (!head) {
        throw new MemoryRuntimeError('review', 'validation', 'memory_stream_not_found', 'Memory stream does not exist.');
      }
      if (
        input.actor.isAdmin
        || !input.actor.isDirect
        || head.subjectType !== 'user'
        || head.subjectKey !== input.actor.userKey
      ) {
        throw new MemoryRuntimeError(
          'review',
          'authorization',
          'memory_promotion_requires_subject_consent',
          'Cross-context memory promotion requires the subject in a direct chat.',
        );
      }
      if (head.state !== 'active') {
        throw new MemoryRuntimeError('review', 'validation', 'memory_promotion_state_invalid', 'Only active memory can be promoted.');
      }
      const audienceContextKeys = input.audiencePolicy === 'explicitContexts'
        ? uniqueStrings(input.audienceContextKeys)
        : [];
      if (input.audiencePolicy === 'explicitContexts' && !audienceContextKeys.length) {
        throw new MemoryRuntimeError('review', 'validation', 'memory_promotion_audience_empty', 'Explicit audience contexts are required.');
      }
      const audienceSnapshots = input.audiencePolicy === 'explicitContexts'
        ? parseAudienceSnapshots(serialize(input.audienceSnapshots))
        : parseAudienceSnapshots(head.audienceSnapshots);
      if (
        input.audiencePolicy === 'explicitContexts'
        && (
          Object.keys(audienceSnapshots).length !== audienceContextKeys.length
          || audienceContextKeys.some((contextKey) => !audienceSnapshots[contextKey]?.length)
        )
      ) {
        throw new MemoryRuntimeError(
          'review',
          'validation',
          'memory_promotion_audience_invalid',
          'Every explicit context requires its own authoritative audience snapshot.',
        );
      }
      const revision = head.revision + 1;
      const eventId = randomUUID();
      const now = Date.now();
      await database.create(MEMORY_LEDGER_TABLES.event, {
        eventId,
        streamId: head.streamId,
        revision,
        eventType: 'visibilityChanged',
        assertionType: head.assertionType,
        subjectType: head.subjectType,
        subjectKey: head.subjectKey,
        actorKey: input.actor.userKey,
        sourceContextKey: head.sourceContextKey,
        audiencePolicy: input.audiencePolicy,
        audienceContextKeys: serialize(audienceContextKeys),
        audienceSnapshots: serialize(audienceSnapshots),
        sensitivity: head.sensitivity,
        payloadId: head.payloadId,
        causationId: head.eventId,
        idempotencyKey: `visibility:${head.streamId}:${revision}:${input.audiencePolicy}:${sha256(serialize([
          audienceContextKeys,
          audienceSnapshots,
        ]))}`,
        createdAt: now,
      });
      await database.set(MEMORY_LEDGER_TABLES.head, { id: head.id }, {
        eventId,
        revision,
        audiencePolicy: input.audiencePolicy,
        audienceContextKeys: serialize(audienceContextKeys),
        audienceSnapshots: serialize(audienceSnapshots),
        updatedAt: now,
      });
      if (!head.contentHash) {
        throw new MemoryRuntimeError('review', 'validation', 'memory_promotion_payload_missing', 'Active memory content is unavailable.');
      }
      await this.searchIndex.updateIdentity(database, {
        streamId: head.streamId,
        eventId,
        revision,
        contentHash: head.contentHash,
      });
      const previousEmbedding = await database.get(MEMORY_LEDGER_TABLES.embedding, {
        streamId: head.streamId,
        revision: head.revision,
        canonicalModel: input.embeddingIdentity.canonicalModel,
        modelRevision: input.embeddingIdentity.modelRevision,
        contentHash: head.contentHash,
      }) as MemoryV2EmbeddingRecord[];
      const embedPayload: EmbeddingWorkPayload = {
        streamId: head.streamId,
        eventId,
        revision,
        canonicalModel: input.embeddingIdentity.canonicalModel,
        modelRevision: input.embeddingIdentity.modelRevision,
        contentHash: head.contentHash,
      };
      await this.cancelEmbeddingWorkForStream(
        database,
        head.streamId,
        'memory_embedding_target_superseded',
        now,
      );
      await database.remove(MEMORY_LEDGER_TABLES.embedding, { streamId: head.streamId });
      if (previousEmbedding.length === 1) {
        await database.create(MEMORY_LEDGER_TABLES.embedding, {
          embeddingKey: sha256(embeddingTuple(embedPayload)),
          ...embedPayload,
          dimensions: previousEmbedding[0]!.dimensions,
          vector: previousEmbedding[0]!.vector,
          createdAt: now,
        });
      } else {
        await this.queueWork(database, {
          workKey: embeddingWorkKey('embed', embedPayload),
          workType: 'embed',
          subjectKey: head.subjectKey,
          contextKey: head.sourceContextKey,
          streamId: head.streamId,
          payload: embedPayload,
          inputHash: sha256(embeddingTuple(embedPayload)),
          targetRevision: revision,
          deletionGeneration: head.deletionGeneration,
        });
      }
      await this.writeAudit(database, {
        idempotencyKey: `visibility-audit:${head.streamId}:${revision}`,
        subjectKey: head.subjectKey,
        contextKey: head.sourceContextKey,
        eventType: 'audience_promoted_by_subject',
        streamId: head.streamId,
        eventId,
        detail: {
          audiencePolicy: input.audiencePolicy,
          audienceContextCount: audienceContextKeys.length,
        },
      });
    });
  }

  private async resolveForgetDependencyClosure(
    database: MemoryDatabaseLike,
    initialHeads: readonly MemoryV2HeadRecord[],
  ): Promise<ForgetDependencyClosure> {
    if (!initialHeads.length) {
      return {
        heads: [],
        sources: [],
      };
    }
    const [heads, events, evidence] = await Promise.all([
      database.get(MEMORY_LEDGER_TABLES.head, {}) as Promise<MemoryV2HeadRecord[]>,
      database.get(MEMORY_LEDGER_TABLES.event, {}) as Promise<MemoryV2EventRecord[]>,
      database.get(MEMORY_LEDGER_TABLES.evidence, {}) as Promise<MemoryV2EvidenceRecord[]>,
    ]);
    const streamByEventId = new Map(
      events.map((event) => [event.eventId, event.streamId]),
    );
    const sourceIdentitiesByKey = new Map<string, ForgottenSourceIdentity>();
    const sourceKeysByStream = new Map<string, Set<string>>();
    for (const row of evidence) {
      const streamId = streamByEventId.get(row.eventId);
      if (!streamId) continue;
      const identity: ForgottenSourceIdentity = {
        contextKey: row.contextKey,
        sourceMessageDigest: messageSuppressionDigest(row.messageId),
      };
      const sourceKey = sourceSuppressionKey(identity);
      sourceIdentitiesByKey.set(sourceKey, identity);
      const sourceKeys = sourceKeysByStream.get(streamId) ?? new Set<string>();
      sourceKeys.add(sourceKey);
      sourceKeysByStream.set(streamId, sourceKeys);
    }

    const selectedStreamIds = new Set(
      initialHeads
        .filter((head) => head.state !== 'forgotten')
        .map((head) => head.streamId),
    );
    const forgottenSourceKeys = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const streamId of selectedStreamIds) {
        for (const sourceKey of sourceKeysByStream.get(streamId) ?? []) {
          if (!forgottenSourceKeys.has(sourceKey)) {
            forgottenSourceKeys.add(sourceKey);
            changed = true;
          }
        }
      }
      for (const head of heads) {
        if (
          head.state === 'forgotten'
          || selectedStreamIds.has(head.streamId)
        ) {
          continue;
        }
        const sourceKeys = sourceKeysByStream.get(head.streamId);
        if (
          sourceKeys
          && [...sourceKeys].some((sourceKey) => forgottenSourceKeys.has(sourceKey))
        ) {
          selectedStreamIds.add(head.streamId);
          changed = true;
        }
      }
    }
    const byStreamId = new Map(heads.map((head) => [head.streamId, head]));
    const selectedHeads = [...selectedStreamIds]
      .map((streamId) => byStreamId.get(streamId))
      .filter((head): head is MemoryV2HeadRecord => (
        Boolean(head)
        && head!.state !== 'forgotten'
      ))
      .sort((left, right) => left.id - right.id);
    return {
      heads: selectedHeads,
      sources: [...forgottenSourceKeys]
        .map((sourceKey) => sourceIdentitiesByKey.get(sourceKey))
        .filter((source): source is ForgottenSourceIdentity => Boolean(source))
        .sort((left, right) => (
          left.contextKey.localeCompare(right.contextKey)
          || left.sourceMessageDigest.localeCompare(right.sourceMessageDigest)
        )),
    };
  }

  private async clearStreamContent(
    database: MemoryDatabaseLike,
    streamId: string,
  ): Promise<ForgottenSourceIdentity[]> {
    const events = await database.get(MEMORY_LEDGER_TABLES.event, { streamId }) as MemoryV2EventRecord[];
    const eventIds = new Set(events.map((event) => event.eventId));
    const evidence: MemoryV2EvidenceRecord[] = [];
    for (const eventId of eventIds) {
      evidence.push(...await database.get(MEMORY_LEDGER_TABLES.evidence, { eventId }) as MemoryV2EvidenceRecord[]);
    }
    const sources = new Map<string, ForgottenSourceIdentity>();
    for (const row of evidence) {
      const identity = {
        contextKey: row.contextKey,
        sourceMessageDigest: messageSuppressionDigest(row.messageId),
      };
      const sourceKey = sourceSuppressionKey(identity);
      sources.set(sourceKey, identity);
      const existing = await database.get(MEMORY_LEDGER_TABLES.suppression, {
        suppressionKey: sourceKey,
      });
      if (!existing.length) {
        await database.create(MEMORY_LEDGER_TABLES.suppression, {
          suppressionKey: sourceKey,
          subjectKey: null,
          contextKey: row.contextKey,
          streamId: null,
          sourceMessageDigest: identity.sourceMessageDigest,
          cutoffAt: null,
          generation: 1,
          reasonCode: 'forgotten-source',
          createdAt: Date.now(),
        });
      }
    }
    for (const eventId of eventIds) {
      await database.remove(MEMORY_LEDGER_TABLES.payload, { eventId });
      await database.remove(MEMORY_LEDGER_TABLES.evidence, { eventId });
    }
    await database.remove(MEMORY_LEDGER_TABLES.embedding, { streamId });
    await this.searchIndex.remove(database, streamId);
    return [...sources.values()];
  }

  private async cancelStreamWork(
    database: MemoryDatabaseLike,
    streamId: string,
    reasonCode: string,
    now: number,
  ): Promise<void> {
    const work = await database.get(MEMORY_LEDGER_TABLES.work, {
      streamId,
    }) as MemoryV2WorkRecord[];
    for (const row of work.filter((item) => (
      item.status === 'pending'
      || item.status === 'leased'
      || item.status === 'failed'
      || item.status === 'deadLetter'
    ))) {
      await database.set(MEMORY_LEDGER_TABLES.work, { id: row.id }, {
        status: 'cancelled',
        payload: '{}',
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: reasonCode,
        lastErrorStage: 'finalize',
        upstreamStatus: null,
        providerCode: null,
        updatedAt: now,
        completedAt: now,
      });
    }
  }

  private async cancelExtractionWorkForForget(
    database: MemoryDatabaseLike,
    input: {
      laneSubjectKey: string | null;
      laneContextKey: string | null;
      sourceIdentities: readonly ForgottenSourceIdentity[];
      advanceLaneCursors: boolean;
      now: number;
    },
  ): Promise<number> {
    const work = await database.get(MEMORY_LEDGER_TABLES.work, {
      workType: 'extract',
    }) as MemoryV2WorkRecord[];
    const activeWork = work.filter((item) => (
      item.streamId == null
      && (item.status === 'pending' || item.status === 'leased')
    ));
    const forgottenSourceKeys = new Set(
      input.sourceIdentities.map((identity) => sourceSuppressionKey(identity)),
    );
    const forgottenSourceContexts = new Set(
      input.sourceIdentities.map((identity) => identity.contextKey),
    );
    const watermarks = new Map<string, {
      row: MemoryV2WorkRecord;
      payload: ExtractWorkPayload;
    }>();
    const selectedWork: MemoryV2WorkRecord[] = [];
    for (const row of activeWork) {
      const subjectDependent = input.laneSubjectKey != null
        && row.subjectKey === input.laneSubjectKey
        && (input.laneContextKey == null || row.contextKey === input.laneContextKey);
      const mayDependOnSource = row.contextKey != null
        && forgottenSourceContexts.has(row.contextKey);
      let payload: ExtractWorkPayload | null = null;
      if (
        (subjectDependent && input.advanceLaneCursors)
        || mayDependOnSource
      ) {
        payload = workPayload<ExtractWorkPayload>(row);
        if (
          !payload.latestAnchorMessageId
          || !payload.address?.userKey
          || payload.address.userKey !== row.subjectKey
          || payload.address.contextKey !== row.contextKey
          || !Array.isArray(payload.capturedAudiences)
        ) {
          throw new MemoryRuntimeError(
            'forget',
            'validation',
            'memory_extract_payload_invalid',
            'Active extraction work payload is invalid.',
          );
        }
      }
      const sourceDependent = payload != null && [
        payload.latestAnchorMessageId,
        ...payload.capturedAudiences.map((capture) => capture.messageId),
      ].some((messageId) => forgottenSourceKeys.has(sourceSuppressionKey({
        contextKey: payload!.address.contextKey,
        sourceMessageDigest: messageSuppressionDigest(messageId),
      })));
      if (!subjectDependent && !sourceDependent) continue;
      selectedWork.push(row);
      if (!subjectDependent || !input.advanceLaneCursors || !payload) continue;
      const key = row.laneKey ?? createMemoryExtractLaneKey(
        payload.address.userKey,
        payload.address.contextKey,
      );
      const current = watermarks.get(key);
      if (
        !current
        || payload.address.observedAt > current.payload.address.observedAt
        || (
          payload.address.observedAt === current.payload.address.observedAt
          && (row.createdAt > current.row.createdAt
            || (row.createdAt === current.row.createdAt && row.id > current.row.id))
        )
      ) {
        watermarks.set(key, { row, payload });
      }
    }
    for (const row of selectedWork) {
      await database.set(MEMORY_LEDGER_TABLES.work, { id: row.id }, {
        status: 'cancelled',
        payload: '{}',
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: 'memory_forgotten',
        lastErrorStage: 'finalize',
        upstreamStatus: null,
        providerCode: null,
        updatedAt: input.now,
        completedAt: input.now,
      });
    }
    for (const [laneKey, watermark] of watermarks) {
      const payload = watermark.payload;
      const [cursor] = await database.get(MEMORY_LEDGER_TABLES.cursor, {
        laneKey,
      }) as MemoryV2CursorRecord[];
      const observedAt = payload.address.observedAt;
      if (!cursor) {
        await database.create(MEMORY_LEDGER_TABLES.cursor, {
          laneKey,
          subjectKey: payload.address.userKey,
          contextKey: payload.address.contextKey,
          conversationId: payload.address.conversationId,
          lastMessageId: payload.latestAnchorMessageId,
          lastMessageAt: observedAt,
          lastWindowHash: null,
          discardBeforeMessageId: payload.latestAnchorMessageId,
          firstSeenAt: input.now,
          updatedAt: input.now,
        });
      } else if (cursor.lastMessageAt == null || cursor.lastMessageAt < observedAt) {
        await database.set(MEMORY_LEDGER_TABLES.cursor, { id: cursor.id }, {
          conversationId: payload.address.conversationId,
          lastMessageId: payload.latestAnchorMessageId,
          lastMessageAt: observedAt,
          lastWindowHash: null,
          discardBeforeMessageId: payload.latestAnchorMessageId,
          updatedAt: input.now,
        });
      }
    }
    return selectedWork.length;
  }

  private async archiveHeadTx(
    database: MemoryDatabaseLike,
    input: {
      head: MemoryV2HeadRecord;
      actorKey: string;
      reasonCode: string;
      now: number;
    },
  ): Promise<void> {
    const revision = input.head.revision + 1;
    const eventId = randomUUID();
    await database.create(MEMORY_LEDGER_TABLES.event, {
      eventId,
      streamId: input.head.streamId,
      revision,
      eventType: 'archived',
      assertionType: input.head.assertionType,
      subjectType: input.head.subjectType,
      subjectKey: input.head.subjectKey,
      actorKey: input.actorKey,
      sourceContextKey: input.head.sourceContextKey,
      audiencePolicy: input.head.audiencePolicy,
      audienceContextKeys: input.head.audienceContextKeys,
      audienceSnapshots: input.head.audienceSnapshots,
      sensitivity: input.head.sensitivity,
      payloadId: input.head.payloadId,
      causationId: input.head.eventId,
      idempotencyKey: `archived:${input.head.streamId}:${revision}`,
      createdAt: input.now,
    });
    await database.set(MEMORY_LEDGER_TABLES.head, { id: input.head.id }, {
      eventId,
      revision,
      state: 'archived',
      updatedAt: input.now,
    });
    await database.remove(MEMORY_LEDGER_TABLES.embedding, {
      streamId: input.head.streamId,
    });
    await this.searchIndex.remove(database, input.head.streamId);
    await this.cancelStreamWork(
      database,
      input.head.streamId,
      'memory_archived',
      input.now,
    );
    await this.writeAudit(database, {
      idempotencyKey: `archived-audit:${input.head.streamId}:${revision}`,
      subjectKey: input.head.subjectKey,
      contextKey: input.head.sourceContextKey,
      eventType: 'memory_archived',
      streamId: input.head.streamId,
      eventId,
      detail: {
        reasonCode: input.reasonCode,
        previousState: input.head.state,
      },
      createdAt: input.now,
    });
  }

  async archive(input: {
    streamId: string;
    actor: { userKey: string; isDirect: boolean; isAdmin?: boolean };
    reasonCode?: string;
  }): Promise<void> {
    const reasonCode = assertCanonicalMemoryReasonCode(
      input.reasonCode ?? 'operator-archive',
      'archive',
    );
    await this.unitOfWork.run('archive', async (database) => {
      if (!input.actor.isAdmin) {
        throw new MemoryRuntimeError(
          'archive',
          'authorization',
          'memory_archive_admin_required',
          'Memory archival requires an administrator.',
        );
      }
      const [head] = await database.get(MEMORY_LEDGER_TABLES.head, {
        streamId: input.streamId,
      }) as MemoryV2HeadRecord[];
      if (!head) {
        throw new MemoryRuntimeError(
          'archive',
          'validation',
          'memory_stream_not_found',
          'Memory stream does not exist.',
        );
      }
      if (head.state !== 'active' && head.state !== 'pendingReview') {
        throw new MemoryRuntimeError(
          'archive',
          'validation',
          'memory_archive_state_invalid',
          'Only active or pending memory can be archived.',
        );
      }
      await this.archiveHeadTx(database, {
        head,
        actorKey: 'admin',
        reasonCode,
        now: Date.now(),
      });
    });
  }

  async forget(input: {
    actor: { userKey: string; isDirect: boolean; isAdmin?: boolean };
    streamId?: string;
    contextKey?: string;
    all?: boolean;
    reasonCode?: string;
  }): Promise<number> {
    const reasonCode = assertCanonicalMemoryReasonCode(
      input.reasonCode ?? 'subject-forget',
      'forget',
    );
    return this.unitOfWork.run('forget', async (database) => {
      const scopedHeads = await database.get(MEMORY_LEDGER_TABLES.head, input.streamId
        ? { streamId: input.streamId }
        : { subjectKey: input.actor.userKey }) as MemoryV2HeadRecord[];
      const initialTargets = scopedHeads.filter((head) => {
        if (input.streamId && head.streamId !== input.streamId) return false;
        if (input.contextKey && head.sourceContextKey !== input.contextKey) return false;
        return input.all || Boolean(input.streamId) || Boolean(input.contextKey);
      });
      for (const head of initialTargets) {
        this.policy.assertCanForget({
          subjectType: head.subjectType,
          subjectKey: head.subjectKey,
        }, input.actor);
      }
      if (input.streamId && initialTargets[0]?.state === 'forgotten') return 0;
      if (!initialTargets.length && input.streamId) return 0;
      if (!initialTargets.length && !input.contextKey && !input.all) {
        throw new MemoryRuntimeError(
          'forget',
          'validation',
          'memory_forget_target_missing',
          'Forget requires a stream, context, or all-subject target.',
        );
      }
      const closure = await this.resolveForgetDependencyClosure(
        database,
        initialTargets,
      );
      const laneSubjectKey = input.streamId
        ? initialTargets[0]?.subjectType === 'user'
          ? initialTargets[0].subjectKey
          : null
        : input.actor.userKey;
      const laneContextKey = input.all
        ? null
        : input.contextKey ?? initialTargets[0]?.sourceContextKey ?? null;
      const now = Date.now();
      if (laneSubjectKey) {
        const laneGeneration = await this.laneGeneration(
          database,
          laneSubjectKey,
          laneContextKey,
        ) + 1;
        const barrierKey = `barrier:${sha256(serialize([
          'lane',
          laneSubjectKey,
          laneContextKey,
          laneGeneration,
        ]))}`;
        await database.create(MEMORY_LEDGER_TABLES.suppression, {
          suppressionKey: barrierKey,
          subjectKey: laneSubjectKey,
          contextKey: laneContextKey,
          streamId: null,
          sourceMessageDigest: null,
          cutoffAt: input.streamId ? null : now,
          generation: laneGeneration,
          reasonCode,
          createdAt: now,
        });
      }

      for (const head of closure.heads) {
        const generation = await this.streamGeneration(
          database,
          head.subjectKey,
          head.streamId,
        ) + 1;
        await database.create(MEMORY_LEDGER_TABLES.suppression, {
          suppressionKey: `barrier:${sha256(serialize([
            'stream',
            head.subjectKey,
            head.streamId,
            generation,
          ]))}`,
          subjectKey: head.subjectKey,
          contextKey: head.sourceContextKey,
          streamId: head.streamId,
          sourceMessageDigest: null,
          cutoffAt: null,
          generation,
          reasonCode,
          createdAt: now,
        });
        const revision = head.revision + 1;
        const eventId = randomUUID();
        await database.create(MEMORY_LEDGER_TABLES.event, {
          eventId,
          streamId: head.streamId,
          revision,
          eventType: 'forgotten',
          assertionType: head.assertionType,
          subjectType: head.subjectType,
          subjectKey: head.subjectKey,
          actorKey: input.actor.isAdmin ? 'admin' : input.actor.userKey,
          sourceContextKey: head.sourceContextKey,
          audiencePolicy: 'subjectPrivate',
          audienceContextKeys: '[]',
          audienceSnapshots: '{}',
          sensitivity: head.sensitivity,
          payloadId: null,
          causationId: head.eventId,
          idempotencyKey: `forgotten:${head.streamId}:${revision}`,
          createdAt: now,
        });
        await this.clearStreamContent(
          database,
          head.streamId,
        );
        await database.set(MEMORY_LEDGER_TABLES.head, { id: head.id }, {
          eventId,
          revision,
          state: 'forgotten',
          audiencePolicy: 'subjectPrivate',
          audienceContextKeys: '[]',
          audienceSnapshots: '{}',
          payloadId: null,
          contentHash: null,
          deletionGeneration: generation,
          updatedAt: now,
        });
        await this.cancelStreamWork(
          database,
          head.streamId,
          'memory_forgotten',
          now,
        );
        await this.writeAudit(database, {
          idempotencyKey: `forgotten-audit:${head.streamId}:${revision}`,
          subjectKey: head.subjectKey,
          contextKey: head.sourceContextKey,
          eventType: 'memory_forgotten',
          streamId: head.streamId,
          eventId,
          detail: { reasonCode },
        });
      }
      await this.cancelExtractionWorkForForget(database, {
        laneSubjectKey,
        laneContextKey,
        sourceIdentities: closure.sources,
        advanceLaneCursors: !input.streamId,
        now,
      });
      return closure.heads.length;
    });
  }

  async archiveExpired(now = Date.now()): Promise<number> {
    return this.unitOfWork.run('maintenance', async (database) => {
      const heads = await database.get(MEMORY_LEDGER_TABLES.head, { state: 'active' }) as MemoryV2HeadRecord[];
      const expired = heads.filter((head) => (
        (head.validUntil != null && head.validUntil < now)
        || (head.expiresAt != null && head.expiresAt < now)
      ));
      for (const head of expired) {
        await this.archiveHeadTx(database, {
          head,
          actorKey: 'memory.maintenance',
          reasonCode: 'retention-policy',
          now,
        });
      }
      return expired.length;
    });
  }

  async archiveLowRiskOldEpisodes(
    archiveDays: number,
    now = Date.now(),
  ): Promise<number> {
    if (!Number.isInteger(archiveDays) || archiveDays < 1) {
      throw new MemoryRuntimeError(
        'maintenance',
        'validation',
        'memory_archive_days_invalid',
        'Memory archiveDays must be a positive integer.',
      );
    }
    const threshold = now - archiveDays * 86_400_000;
    return this.unitOfWork.run('maintenance', async (database) => {
      const heads = await database.get(MEMORY_LEDGER_TABLES.head, {
        state: 'active',
        assertionType: 'episode',
      }) as MemoryV2HeadRecord[];
      const targets = heads.filter((head) => (
        head.sensitivity === 'low'
        && head.importance < 0.85
        && head.updatedAt <= threshold
      ));
      for (const head of targets) {
        await this.archiveHeadTx(database, {
          head,
          actorKey: 'memory.maintenance',
          reasonCode: 'retention-policy',
          now,
        });
      }
      return targets.length;
    });
  }

  async getQueueSummary(): Promise<MemoryQueueSummary> {
    const rows = await this.database.get(MEMORY_LEDGER_TABLES.work, {}) as MemoryV2WorkRecord[];
    const active = rows.filter((row) => row.status === 'pending' || row.status === 'leased');
    const byType: Record<MemoryWorkType, number> = {
      extract: 0,
      embed: 0,
      backfill: 0,
      maintenance: 0,
    };
    for (const row of active) byType[row.workType] += 1;
    return {
      pending: rows.filter((row) => row.status === 'pending').length,
      leased: rows.filter((row) => row.status === 'leased').length,
      failed: rows.filter((row) => row.status === 'failed').length,
      deadLetter: rows.filter((row) => row.status === 'deadLetter').length,
      byType,
    };
  }

  async getLedgerCounts(identity: MemoryEmbeddingIdentity | null): Promise<MemoryLedgerCounts> {
    const heads = await this.database.get(MEMORY_LEDGER_TABLES.head, {}) as MemoryV2HeadRecord[];
    const [allEvents, allPayloads, allEvidence, allEmbeddings, allProjections] = await Promise.all([
      this.database.get(MEMORY_LEDGER_TABLES.event, {}) as Promise<MemoryV2EventRecord[]>,
      this.database.get(MEMORY_LEDGER_TABLES.payload, {}) as Promise<MemoryV2PayloadRecord[]>,
      this.database.get(MEMORY_LEDGER_TABLES.evidence, {}) as Promise<MemoryV2EvidenceRecord[]>,
      this.database.get(MEMORY_LEDGER_TABLES.embedding, {}) as Promise<MemoryV2EmbeddingRecord[]>,
      this.searchIndex.list(this.database),
    ]);
    const eventIds = new Set(allEvents.map((event) => event.eventId));
    const activeByStream = new Map(
      heads.filter((head) => head.state === 'active').map((head) => [head.streamId, head]),
    );
    const payloadById = new Map(allPayloads.map((payload) => [payload.payloadId, payload]));
    const evidenceByEvent = new Map<string, MemoryV2EvidenceRecord[]>();
    for (const evidence of allEvidence) {
      const entries = evidenceByEvent.get(evidence.eventId) ?? [];
      entries.push(evidence);
      evidenceByEvent.set(evidence.eventId, entries);
    }
    const projectionByStream = new Map<string, MemoryLexicalProjectionRow[]>();
    for (const projection of allProjections) {
      const entries = projectionByStream.get(projection.streamId) ?? [];
      entries.push(projection);
      projectionByStream.set(projection.streamId, entries);
    }
    const inactiveFts = allProjections.filter(
      (projection) => !activeByStream.has(projection.streamId),
    ).length;
    const staleFts = allProjections.filter((projection) => {
      const head = activeByStream.get(projection.streamId);
      const payload = head?.payloadId ? payloadById.get(head.payloadId) : null;
      if (!head) return false;
      if (!payload || !head.contentHash || payload.contentHash !== head.contentHash) return true;
      return !memoryLexicalProjectionMatches(projection, {
        streamId: head.streamId,
        eventId: head.eventId,
        revision: head.revision,
        contentHash: head.contentHash,
        canonicalText: payload.retrievalText ?? payload.content,
      });
    }).length;
    const inactiveEmbedding = allEmbeddings.filter((embedding) => !activeByStream.has(embedding.streamId)).length;
    const staleEmbedding = allEmbeddings.filter((embedding) => {
      const head = activeByStream.get(embedding.streamId);
      if (!head) return false;
      return embedding.eventId !== head.eventId
        || embedding.revision !== head.revision
        || embedding.contentHash !== head.contentHash
        || (identity != null && (
          embedding.canonicalModel !== identity.canonicalModel
          || embedding.modelRevision !== identity.modelRevision
        ));
    }).length;
    const orphanEvidence = allEvidence.filter((evidence) => !eventIds.has(evidence.eventId)).length;
    let stranded = 0;
    const strandedByReason = {
      payload: 0,
      evidence: 0,
      audience: 0,
      embedding: 0,
      fts: 0,
    };
    for (const head of heads.filter((row) => row.state === 'active')) {
      if (!head.payloadId || !head.contentHash) {
        stranded += 1;
        strandedByReason.payload += 1;
        continue;
      }
      let audienceValid = true;
      try {
        parseAudienceContextKeys(head.audienceContextKeys);
        parseAudienceSnapshots(head.audienceSnapshots);
      } catch {
        audienceValid = false;
      }
      const payload = payloadById.get(head.payloadId);
      const evidence = payload ? evidenceByEvent.get(payload.eventId) ?? [] : [];
      const projections = projectionByStream.get(head.streamId) ?? [];
      try {
        if (
          evidence.some((row) => (
            !parseCaptureAudienceSubjectKeys(String(row.captureAudienceSubjectKeys)).length
          ))
        ) {
          audienceValid = false;
        }
      } catch {
        audienceValid = false;
      }
      const embeddings = identity
        ? await this.database.get(MEMORY_LEDGER_TABLES.embedding, {
            streamId: head.streamId,
            eventId: head.eventId,
            revision: head.revision,
            canonicalModel: identity.canonicalModel,
            modelRevision: identity.modelRevision,
            contentHash: head.contentHash,
          })
        : [];
      let rowStranded = false;
      if (!audienceValid) {
        strandedByReason.audience += 1;
        rowStranded = true;
      }
      if (!payload || payload.contentHash !== head.contentHash) {
        strandedByReason.payload += 1;
        rowStranded = true;
      }
      if (evidence.length === 0) {
        strandedByReason.evidence += 1;
        rowStranded = true;
      }
      if (
        !payload
        || projections.length !== 1
        || !memoryLexicalProjectionMatches(projections[0]!, {
          streamId: head.streamId,
          eventId: head.eventId,
          revision: head.revision,
          contentHash: head.contentHash,
          canonicalText: payload.retrievalText ?? payload.content,
        })
      ) {
        strandedByReason.fts += 1;
        rowStranded = true;
      }
      if (embeddings.length !== 1) {
        strandedByReason.embedding += 1;
        rowStranded = true;
      }
      if (rowStranded) stranded += 1;
    }
    return {
      active: heads.filter((row) => row.state === 'active').length,
      pendingReview: heads.filter((row) => row.state === 'pendingReview').length,
      archived: heads.filter((row) => row.state === 'archived').length,
      retracted: heads.filter((row) => row.state === 'retracted').length,
      forgotten: heads.filter((row) => row.state === 'forgotten').length,
      stranded,
      ftsRows: allProjections.length,
      embeddingRows: allEmbeddings.length,
      orphanEvidence,
      staleFts,
      inactiveFts,
      staleEmbedding,
      inactiveEmbedding,
      strandedByReason,
    };
  }

  async getLatestRecallAudit(subjectKey: string, contextKey: string): Promise<MemoryV2AuditRecord | null> {
    const rows = await this.database.get(MEMORY_LEDGER_TABLES.audit, {
      subjectKey,
      contextKey,
      eventType: 'recall_selected',
    }) as MemoryV2AuditRecord[];
    return rows.sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
  }

  async listDeadLetterWork(): Promise<MemoryV2WorkRecord[]> {
    return this.database.get(MEMORY_LEDGER_TABLES.work, { status: 'deadLetter' }) as Promise<MemoryV2WorkRecord[]>;
  }

  async discardDeadLetterWork(id: number): Promise<void> {
    await this.unitOfWork.run('maintenance', async (database) => {
      const [work] = await database.get(MEMORY_LEDGER_TABLES.work, { id, status: 'deadLetter' }) as MemoryV2WorkRecord[];
      if (!work) {
        throw new MemoryRuntimeError('maintenance', 'validation', 'memory_dead_letter_not_found', 'Dead-letter work does not exist.');
      }
      await database.set(MEMORY_LEDGER_TABLES.work, { id: work.id }, {
        status: 'cancelled',
        payload: '{}',
        updatedAt: Date.now(),
        completedAt: Date.now(),
      });
      await this.writeAudit(database, {
        idempotencyKey: `dead-letter-discarded:${work.workKey}`,
        subjectKey: work.subjectKey,
        contextKey: work.contextKey,
        eventType: 'dead_letter_discarded',
        workKey: work.workKey,
        detail: {
          errorCode: work.lastErrorCode,
          errorStage: work.lastErrorStage,
        },
      });
    });
  }
}

export function isWorkStatus(value: unknown): value is MemoryWorkStatus {
  return value === 'pending'
    || value === 'leased'
    || value === 'succeeded'
    || value === 'failed'
    || value === 'deadLetter'
    || value === 'cancelled';
}
