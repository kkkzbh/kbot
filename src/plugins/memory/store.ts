import { createHash, randomUUID } from 'node:crypto';
import type {
  MemoryAddress,
  MemoryAssertionType,
  MemoryAudiencePolicy,
  MemoryFactKind,
  MemoryLedgerCounts,
  MemoryLedgerItem,
  MemoryOutputProtocolId,
  MemoryQueueSummary,
  MemorySensitivity,
  MemorySubjectType,
  MemoryV3AuditRecord,
  MemoryV3CursorRecord,
  MemoryV3EventRecord,
  MemoryV3EvidenceRecord,
  MemoryV3HeadRecord,
  MemoryV3PayloadRecord,
  MemoryV3PrincipalRecord,
  MemoryV3SuppressionRecord,
  MemoryV3WorkRecord,
  MemoryWorkStatus,
  MemoryWorkType,
} from '../../types/memory.js';
import { decodeStoredMessageJson, decodeStoredMessageText } from '../shared/stored-message.js';
import {
  MEMORY_LEDGER_SCHEMA_VERSION,
  MEMORY_LEDGER_TABLES,
  assertMemoryLedgerSqliteSchema,
} from './schema.js';
import {
  asMemoryRuntimeError,
  MemoryRuntimeError,
  memoryErrorDetail,
  type MemoryOperation,
} from './errors.js';
import {
  runDeterministicCaptureGuard,
  type ExtractedMemoryCandidate,
} from './gates.js';
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

export type MemoryWorkPayload = ExtractWorkPayload | Record<string, unknown>;

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
  getDriver?(table: string): unknown;
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
  kind?: MemoryFactKind | null;
  topicKey: string;
  memoryKey?: string;
  subjectType: MemorySubjectType;
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
  causationId?: string | null;
  auditWorkKey?: string | null;
  createdAt?: number;
}

export interface DeterministicDomainMemoryInput {
  address: MemoryAddress;
  kind: MemoryFactKind;
  topicKey: string;
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
  createdAt?: number;
}

export interface DeterministicDomainMemoryResult {
  head: MemoryV3HeadRecord;
  laneKey: string;
  workKey: string;
  idempotencyKey: string;
}

export interface ClaimedMemoryWork {
  work: MemoryV3WorkRecord;
  leaseToken: string;
}

export interface FinalizeExtractionInput {
  work: MemoryV3WorkRecord;
  leaseToken: string;
  payload: ExtractWorkPayload;
  turns: readonly MemoryConversationTurn[];
  candidates: readonly ExtractedMemoryCandidate[];
  providerRoute: MemoryOutputProtocolId;
  rawTextHash: string | null;
  maxLeaseRetries: number;
}

const FORBIDDEN_AUDIT_KEY =
  /(?:content|payload|excerpt|summary|title|providerbody|response|token|cookie|secret|password)/iu;
const CANONICAL_REASON_CODES = new Set([
  'attribution_evidence_outside_window',
  'attribution_evidence_audience_missing',
  'attribution_evidence_untrusted',
  'attribution_missing_evidence',
  'attribution_owner_mismatch',
  'attribution_speaker_mismatch',
  'candidate_invalid',
  'duplicate',
  'empty_candidate',
  'forgotten-source',
  'group_joke_guard',
  'incorrect-memory',
  'low_confidence',
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
  'subject-forget',
  'superseded',
  'third_party_privacy_guard',
]);
const REASON_CODE_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u;
const TRUSTED_TARGET_ATTRIBUTION = new Set<MemoryConversationTurn['attributionSource']>([
  'additional_kwargs',
  'direct_session',
]);

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseJson<T>(raw: string, operation: MemoryOperation, stage: 'validation' | 'read' | 'decode'): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new MemoryRuntimeError(
      operation,
      stage,
      'memory_json_invalid',
      'Stored memory JSON is invalid.',
      { cause: error },
    );
  }
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))].sort();
}

function clamp01(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function timestamp(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedTopicKey(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/gu, '-')
    .replace(/[^\p{L}\p{N}._:-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 160);
  if (!normalized) {
    throw new MemoryRuntimeError(
      'extract',
      'validation',
      'memory_topic_key_invalid',
      'Memory topicKey must contain a canonical topic identity.',
    );
  }
  return normalized;
}

function audienceDomain(input: Pick<
  AppendAssertionInput,
  'audiencePolicy' | 'subjectKey' | 'sourceContextKey' | 'audienceContextKeys' | 'audienceSnapshots'
>): string {
  switch (input.audiencePolicy) {
    case 'subjectPrivate':
      return `private:${input.subjectKey}`;
    case 'sourceContext':
      return `context:${input.sourceContextKey}`;
    case 'subjectAllContexts':
      return `subject:${input.subjectKey}`;
    case 'explicitContexts':
      return `contexts:${sha256(serialize(uniqueStrings(input.audienceContextKeys)))}`;
    case 'captureAudience': {
      const audience = uniqueStrings(Object.values(input.audienceSnapshots).flat());
      return `audience:${sha256(serialize(audience))}`;
    }
  }
}

export function createMemoryKey(input: Pick<
  AppendAssertionInput,
  | 'assertionType'
  | 'kind'
  | 'topicKey'
  | 'subjectType'
  | 'subjectKey'
  | 'audiencePolicy'
  | 'sourceContextKey'
  | 'audienceContextKeys'
  | 'audienceSnapshots'
>): string {
  const kind = input.assertionType === 'episode' ? 'episode' : input.kind;
  if (input.assertionType !== 'episode' && !kind) {
    throw new MemoryRuntimeError(
      'extract',
      'validation',
      'memory_kind_missing',
      'Fact memory requires a canonical kind.',
    );
  }
  return sha256(serialize([
    'memory-v3',
    input.subjectType,
    input.subjectKey,
    input.assertionType,
    audienceDomain(input),
    kind,
    normalizedTopicKey(input.topicKey),
  ]));
}

function safeAuditDetail(detail: Record<string, unknown> | null): string | null {
  if (!detail) return null;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_AUDIT_KEY.test(key)) {
        throw new MemoryRuntimeError(
          'audit',
          'validation',
          'memory_audit_contains_content',
          `Audit key is not content-safe: ${key}`,
        );
      }
      visit(child);
    }
  };
  visit(detail);
  return serialize(detail);
}

function canonicalReasonCode(value: unknown, operation: MemoryOperation): string {
  if (
    typeof value !== 'string'
    || !REASON_CODE_PATTERN.test(value)
    || !CANONICAL_REASON_CODES.has(value)
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

function workPayload<T>(work: MemoryV3WorkRecord): T {
  return parseJson<T>(work.payload, 'extract', 'validation');
}

function dueSort(left: MemoryV3WorkRecord, right: MemoryV3WorkRecord): number {
  return left.nextRunAt - right.nextRunAt || left.id - right.id;
}

function messageSuppressionDigest(messageId: string): string {
  return sha256(serialize(['memory-source-message-v3', messageId]));
}

function sourceSuppressionKey(contextKey: string, messageId: string): string {
  return `source:${sha256(serialize([
    'memory-source-evidence-v3',
    contextKey,
    messageSuppressionDigest(messageId),
  ]))}`;
}

type ParsedSpeaker = {
  speakerId: string | null;
  speakerName: string | null;
  text: string;
  ownerUserKey: string | null;
  isTarget: boolean;
  attributionSource: MemoryConversationTurn['attributionSource'];
};

const SPEAKER_TAG_PREFIX =
  /^\[speaker_id=([^\]\s]+)(?:\s+speaker_name=("(?:\\.|[^"\\])*"|[^\]\s]+))?\][ \t]*/;

function parseSpeakerTag(text: string): { speakerId: string; speakerName: string | null; end: number } | null {
  const match = text.match(SPEAKER_TAG_PREFIX);
  const speakerId = normalizeText(match?.[1]);
  if (!speakerId) return null;
  const rawName = normalizeText(match?.[2]);
  let speakerName = rawName || null;
  if (rawName.startsWith('"')) {
    const parsed = parseJson<unknown>(rawName, 'extract', 'decode');
    speakerName = normalizeText(parsed) || null;
  }
  return { speakerId, speakerName, end: match?.[0]?.length ?? 0 };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = parseJson<unknown>(value, 'extract', 'decode');
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

async function storedAdditionalKwargs(row: StoredMessageRecord): Promise<Record<string, unknown> | null> {
  if (
    row.additional_kwargs_binary instanceof ArrayBuffer
    || ArrayBuffer.isView(row.additional_kwargs_binary)
  ) {
    return plainRecord(await decodeStoredMessageJson(row.additional_kwargs_binary));
  }
  return plainRecord(row.additional_kwargs);
}

function parseSpeakerFormat(raw: unknown): { speakerId: string; speakerName: string | null } | null {
  const record = plainRecord(raw);
  const format = plainRecord(record?.qqbot_speaker_format);
  if (
    normalizeText(format?.version) !== 'speaker_id_v1'
    || format?.isDirect === true
    || format?.preformatted === true
  ) {
    return null;
  }
  const speakerId = normalizeText(format?.speakerId);
  return speakerId
    ? { speakerId, speakerName: normalizeText(format?.speakerName) || null }
    : null;
}

function candidateFields(candidate: ExtractedMemoryCandidate): {
  assertionType: MemoryAssertionType;
  kind: MemoryFactKind | null;
  topicKey: string;
  content: string;
  retrievalText: string;
} | null {
  if (candidate.candidateType === 'fact') {
    const content = normalizeText(candidate.content);
    const kind = candidate.kind ?? null;
    const topicKey = normalizeText(candidate.topicKey);
    if (!content || !kind || !topicKey) return null;
    return {
      assertionType: candidate.subject === 'group_shared'
        ? 'groupArtifact'
        : candidate.subject === 'assistant'
          ? 'assistantCommitment'
          : 'userAssertion',
      kind,
      topicKey: normalizedTopicKey(topicKey),
      content,
      retrievalText: [kind, topicKey, content, ...uniqueStrings(candidate.keywords)]
        .filter(Boolean)
        .join('\n'),
    };
  }
  if (candidate.candidateType === 'episode') {
    const title = normalizeText(candidate.title);
    const summary = normalizeText(candidate.summary);
    const evidenceIds = uniqueStrings(candidate.evidenceMessageIds ?? []);
    if (!title || !summary || !evidenceIds.length) return null;
    return {
      assertionType: 'episode',
      kind: null,
      topicKey: sha256(serialize(evidenceIds)),
      content: `${title}\n${summary}`,
      retrievalText: [title, summary, ...uniqueStrings(candidate.keywords)].join('\n'),
    };
  }
  return null;
}

export function extractPlainText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object' && 'text' in raw) {
    return normalizeText((raw as { text?: unknown }).text);
  }
  if (!Array.isArray(raw)) return '';
  return raw.map((item) => {
    if (typeof item === 'string') return item;
    return item && typeof item === 'object' && 'text' in item
      ? normalizeText((item as { text?: unknown }).text)
      : '';
  }).join('').trim();
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
    const rows = await this.database.get(MEMORY_LEDGER_TABLES.meta, {
      key: 'schemaVersion',
    });
    if (
      rows.length !== 1
      || String(rows[0]?.value) !== String(MEMORY_LEDGER_SCHEMA_VERSION)
    ) {
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
      const now = address.observedAt;
      const [principal] = await database.get(MEMORY_LEDGER_TABLES.principal, {
        userKey: address.userKey,
      }) as MemoryV3PrincipalRecord[];
      if (principal) {
        await database.set(MEMORY_LEDGER_TABLES.principal, { id: principal.id }, {
          displayName: patch?.displayName ?? principal.displayName,
          avatarUrl: patch?.avatarUrl ?? principal.avatarUrl,
          lastSeenAt: now,
        });
      } else {
        await database.create(MEMORY_LEDGER_TABLES.principal, {
          userKey: address.userKey,
          platform: address.platform,
          userId: address.userId,
          displayName: patch?.displayName ?? null,
          avatarUrl: patch?.avatarUrl ?? null,
          readEnabled: 1,
          writeEnabled: 1,
          firstSeenAt: now,
          lastSeenAt: now,
        });
      }
      const [context] = await database.get(MEMORY_LEDGER_TABLES.context, {
        contextKey: address.contextKey,
      });
      if (context) {
        await database.set(MEMORY_LEDGER_TABLES.context, { id: context.id }, {
          lastSeenAt: now,
        });
      } else {
        await database.create(MEMORY_LEDGER_TABLES.context, {
          contextKey: address.contextKey,
          platform: address.platform,
          botSelfId: address.botSelfId,
          channelType: address.channelType,
          groupId: address.groupId ?? null,
          channelId: address.channelId ?? null,
          rawContextId: address.rawContextId ?? null,
          firstSeenAt: now,
          lastSeenAt: now,
        });
      }
    });
  }

  async getUserFlags(userKey: string): Promise<{ readEnabled: boolean; writeEnabled: boolean }> {
    const [principal] = await this.database.get(MEMORY_LEDGER_TABLES.principal, {
      userKey,
    }) as MemoryV3PrincipalRecord[];
    return {
      readEnabled: principal ? principal.readEnabled === 1 : true,
      writeEnabled: principal ? principal.writeEnabled === 1 : true,
    };
  }

  async setUserFlags(
    userKey: string,
    flags: { readEnabled?: boolean; writeEnabled?: boolean },
  ): Promise<void> {
    await this.unitOfWork.run('address', async (database) => {
      const [principal] = await database.get(MEMORY_LEDGER_TABLES.principal, {
        userKey,
      }) as MemoryV3PrincipalRecord[];
      if (!principal) {
        throw new MemoryRuntimeError(
          'address',
          'validation',
          'memory_principal_missing',
          'Memory principal does not exist.',
        );
      }
      await database.set(MEMORY_LEDGER_TABLES.principal, { id: principal.id }, {
        ...(flags.readEnabled === undefined
          ? {}
          : { readEnabled: flags.readEnabled ? 1 : 0 }),
        ...(flags.writeEnabled === undefined
          ? {}
          : { writeEnabled: flags.writeEnabled ? 1 : 0 }),
        lastSeenAt: Date.now(),
      });
    });
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
    const existing = await database.get(MEMORY_LEDGER_TABLES.audit, {
      idempotencyKey: input.idempotencyKey,
    });
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
    idempotencyKey: string;
    subjectKey?: string | null;
    contextKey?: string | null;
    eventType: string;
    streamId?: string | null;
    eventId?: string | null;
    workKey?: string | null;
    detail?: Record<string, unknown> | null;
    createdAt?: number;
  }): Promise<void> {
    await this.unitOfWork.run('audit', async (database) => {
      await this.writeAudit(database, input);
    });
  }

  private async laneGeneration(
    database: MemoryDatabaseLike,
    subjectKey: string,
    contextKey: string,
  ): Promise<number> {
    const rows = await database.get(MEMORY_LEDGER_TABLES.suppression, {
      subjectKey,
    }) as MemoryV3SuppressionRecord[];
    return rows
      .filter((row) => row.contextKey === null || row.contextKey === contextKey)
      .reduce((maximum, row) => Math.max(maximum, row.generation), 0);
  }

  private async streamGeneration(
    database: MemoryDatabaseLike,
    subjectKey: string,
    streamId: string,
  ): Promise<number> {
    const rows = await database.get(MEMORY_LEDGER_TABLES.suppression, {
      subjectKey,
    }) as MemoryV3SuppressionRecord[];
    return rows
      .filter((row) => row.streamId === null || row.streamId === streamId)
      .reduce((maximum, row) => Math.max(maximum, row.generation), 0);
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
    const existing = await database.get(MEMORY_LEDGER_TABLES.work, {
      workKey: input.workKey,
    });
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
      !audienceSubjectKeys.length
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
      const laneKey = createMemoryExtractLaneKey(
        input.address.userKey,
        input.address.contextKey,
      );
      const [cursor] = await database.get(MEMORY_LEDGER_TABLES.cursor, {
        laneKey,
      }) as MemoryV3CursorRecord[];
      const lastHandled = cursor?.discardBeforeMessageId ?? cursor?.lastMessageId;
      if (
        lastHandled === latestAnchorMessageId
        || (cursor?.lastMessageAt != null && cursor.lastMessageAt >= input.address.observedAt)
      ) {
        return false;
      }
      const pendingRows = (
        await database.get(MEMORY_LEDGER_TABLES.work, {
          laneKey,
          workType: 'extract',
          status: 'pending',
        }) as MemoryV3WorkRecord[]
      ).sort(dueSort);
      const capture = {
        messageId: latestAnchorMessageId,
        observedAt: input.address.observedAt,
        audienceSubjectKeys,
      };
      if (pendingRows.length) {
        const [primary, ...duplicates] = pendingRows;
        const payloads = pendingRows.map((row) => workPayload<ExtractWorkPayload>(row));
        if (payloads.some((payload) => (
          payload.address.conversationId !== input.address.conversationId
          || payload.targetSpeakerId !== input.targetSpeakerId
        ))) {
          throw new MemoryRuntimeError(
            'enqueue',
            'validation',
            'memory_extract_lane_conflict',
            'A pending extraction lane targets another conversation or speaker.',
          );
        }
        const captures = new Map(
          payloads.flatMap((payload) => payload.capturedAudiences)
            .map((item) => [item.messageId, item]),
        );
        if (captures.has(capture.messageId) && duplicates.length === 0) return false;
        captures.set(capture.messageId, capture);
        const maxMessages = Math.max(
          input.maxMessages,
          ...payloads.map((payload) => payload.maxMessages),
        );
        const payload: ExtractWorkPayload = {
          address: input.address,
          targetSpeakerId: input.targetSpeakerId,
          targetSpeakerName: input.targetSpeakerName,
          latestAnchorMessageId,
          maxMessages,
          capturedAudiences: [...captures.values()]
            .sort((left, right) => left.observedAt - right.observedAt)
            .slice(-maxMessages),
        };
        const inputHash = sha256(serialize(payload));
        await database.set(MEMORY_LEDGER_TABLES.work, {
          id: primary!.id,
          status: 'pending',
          inputHash: primary!.inputHash,
        }, {
          payload: serialize(payload),
          inputHash,
          retryCount: 0,
          nextRunAt: input.nextRunAt,
          updatedAt: Date.now(),
          completedAt: null,
          lastErrorCode: null,
          lastErrorStage: null,
          upstreamStatus: null,
          providerCode: null,
        });
        for (const duplicate of duplicates) {
          await database.set(MEMORY_LEDGER_TABLES.work, { id: duplicate.id }, {
            status: 'cancelled',
            payload: '{}',
            leaseToken: null,
            leaseExpiresAt: null,
            lastErrorCode: 'memory_extract_lane_coalesced',
            lastErrorStage: 'finalize',
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
        maxMessages: Math.max(1, Math.floor(input.maxMessages)),
        capturedAudiences: [capture],
      };
      return this.queueWork(database, {
        workKey: `extract:${laneKey}:${randomUUID()}`,
        workType: 'extract',
        subjectKey: input.address.userKey,
        contextKey: input.address.contextKey,
        laneKey,
        payload,
        inputHash: sha256(serialize(payload)),
        deletionGeneration: await this.laneGeneration(
          database,
          input.address.userKey,
          input.address.contextKey,
        ),
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
      const [pending, leased] = await Promise.all([
        database.get(MEMORY_LEDGER_TABLES.work, {
          workType,
          status: 'pending',
        }) as Promise<MemoryV3WorkRecord[]>,
        database.get(MEMORY_LEDGER_TABLES.work, {
          workType,
          status: 'leased',
        }) as Promise<MemoryV3WorkRecord[]>,
      ]);
      const leasedLanes = new Set(leased.flatMap((row) => row.laneKey ? [row.laneKey] : []));
      const work = pending
        .filter((row) => row.nextRunAt <= now && (!row.laneKey || !leasedLanes.has(row.laneKey)))
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
      const [claimed] = await database.get(MEMORY_LEDGER_TABLES.work, {
        id: work.id,
      }) as MemoryV3WorkRecord[];
      return claimed?.status === 'leased' && claimed.leaseToken === leaseToken
        ? { work: claimed, leaseToken }
        : null;
    });
  }

  parseWorkPayload<T extends MemoryWorkPayload>(work: MemoryV3WorkRecord): T {
    return workPayload<T>(work);
  }

  private async assertLease(
    database: MemoryDatabaseLike,
    work: MemoryV3WorkRecord,
    leaseToken: string,
  ): Promise<MemoryV3WorkRecord> {
    const [current] = await database.get(MEMORY_LEDGER_TABLES.work, {
      id: work.id,
    }) as MemoryV3WorkRecord[];
    if (
      !current
      || current.status !== 'leased'
      || current.leaseToken !== leaseToken
      || current.inputHash !== work.inputHash
    ) {
      throw new MemoryRuntimeError(
        'extract',
        'finalize',
        'memory_lease_lost',
        'Memory work lease is no longer owned by this worker.',
      );
    }
    if (current.leaseExpiresAt == null || current.leaseExpiresAt <= Date.now()) {
      throw new MemoryRuntimeError(
        'extract',
        'finalize',
        'memory_lease_expired',
        'Memory work lease expired before finalization.',
      );
    }
    if (current.subjectKey && current.contextKey) {
      const generation = await this.laneGeneration(
        database,
        current.subjectKey,
        current.contextKey,
      );
      if (generation !== current.deletionGeneration) {
        throw new MemoryRuntimeError(
          'extract',
          'finalize',
          'memory_deletion_generation_changed',
          'Memory deletion generation changed while work was in flight.',
        );
      }
    }
    return current;
  }

  async requeueExpiredLeases(now = Date.now(), maxRetries = 1): Promise<number> {
    return this.unitOfWork.run('maintenance', async (database) => {
      const rows = await database.get(MEMORY_LEDGER_TABLES.work, {
        status: 'leased',
      }) as MemoryV3WorkRecord[];
      let count = 0;
      for (const row of rows) {
        if (row.leaseExpiresAt == null || row.leaseExpiresAt > now) continue;
        const retryCount = row.retryCount + 1;
        const retry = retryCount <= maxRetries;
        await database.set(MEMORY_LEDGER_TABLES.work, { id: row.id }, {
          status: retry ? 'pending' : 'deadLetter',
          retryCount,
          nextRunAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
          payload: retry ? row.payload : '{}',
          lastErrorCode: 'memory_lease_expired',
          lastErrorStage: 'finalize',
          updatedAt: now,
          completedAt: retry ? null : now,
        });
        count += 1;
      }
      return count;
    });
  }

  async failWork(
    work: MemoryV3WorkRecord,
    leaseToken: string,
    error: unknown,
    options: { maxRetries: number; retryDelayMs: number },
  ): Promise<void> {
    await this.unitOfWork.run('extract', async (database) => {
      const current = await this.assertLease(database, work, leaseToken);
      const detail = memoryErrorDetail(error);
      const retryCount = current.retryCount + 1;
      const retry = detail.retryable && retryCount <= options.maxRetries;
      await database.set(MEMORY_LEDGER_TABLES.work, { id: current.id }, {
        status: retry ? 'pending' : 'deadLetter',
        retryCount,
        nextRunAt: retry ? Date.now() + options.retryDelayMs : current.nextRunAt,
        leaseToken: null,
        leaseExpiresAt: null,
        payload: retry ? current.payload : '{}',
        lastErrorCode: detail.code,
        lastErrorStage: detail.stage,
        upstreamStatus: detail.upstreamStatus,
        providerCode: detail.providerCode,
        updatedAt: Date.now(),
        completedAt: retry ? null : Date.now(),
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
    });
  }

  async cancelWork(
    work: MemoryV3WorkRecord,
    leaseToken: string,
    reasonCode: string,
  ): Promise<void> {
    await this.unitOfWork.run('extract', async (database) => {
      const current = await this.assertLease(database, work, leaseToken);
      await database.set(MEMORY_LEDGER_TABLES.work, { id: current.id }, {
        status: 'cancelled',
        payload: '{}',
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: reasonCode,
        lastErrorStage: 'finalize',
        updatedAt: Date.now(),
        completedAt: Date.now(),
      });
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
        isTarget: ownerUserKey === payload.address.userKey
          && formatted.speakerId === payload.targetSpeakerId,
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
      isTarget: ownerUserKey === payload.address.userKey
        && tag.speakerId === payload.targetSpeakerId,
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
    }) as MemoryV3CursorRecord[];
    const stopId = laneCursor?.discardBeforeMessageId ?? laneCursor?.lastMessageId ?? null;
    if (stopId === payload.latestAnchorMessageId) return [];
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
    const output: MemoryConversationTurn[] = [];
    const maxMessages = Math.max(1, Math.floor(payload.maxMessages));
    let cursor: string | null = payload.latestAnchorMessageId;
    let scanned = 0;
    while (cursor && cursor !== stopId && scanned < maxMessages * 4) {
      const row = byId.get(cursor);
      if (!row) {
        throw new MemoryRuntimeError(
          'extract',
          'read',
          'memory_message_chain_broken',
          'Stored memory message chain is incomplete.',
        );
      }
      scanned += 1;
      const occurredAt = Number.isFinite(Number(row.createdAt))
        ? Number(row.createdAt)
        : payload.address.observedAt;
      if (
        laneCursor?.lastMessageAt != null
        && occurredAt <= laneCursor.lastMessageAt
      ) {
        break;
      }
      if (row.role === 'human' || row.role === 'ai') {
        let text = extractPlainText(row.content);
        if (!text) text = await decodeStoredMessageText(row.content);
        if (text) {
          const speaker = this.buildTurnSpeaker(
            row,
            text,
            await storedAdditionalKwargs(row),
            payload,
          );
          output.push({
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
    return output.reverse().slice(-maxMessages);
  }

  async filterSuppressedTurns(
    subjectKey: string,
    contextKey: string,
    turns: MemoryConversationTurn[],
  ): Promise<MemoryConversationTurn[]> {
    const rows = await this.database.get(MEMORY_LEDGER_TABLES.suppression, {
      contextKey,
    }) as MemoryV3SuppressionRecord[];
    const suppressed = new Set(rows
      .filter((row) => row.subjectKey === null || row.subjectKey === subjectKey)
      .flatMap((row) => row.sourceMessageDigest ? [row.sourceMessageDigest] : []));
    return turns.filter((turn) => !suppressed.has(messageSuppressionDigest(turn.id)));
  }

  private capturedAudience(
    payload: ExtractWorkPayload,
    messageId: string,
  ): string[] | null {
    const capture = payload.capturedAudiences.find((item) => item.messageId === messageId);
    if (!capture) return null;
    const audience = uniqueStrings(capture.audienceSubjectKeys);
    return audience.length ? audience : null;
  }

  private userEvidence(
    candidate: ExtractedMemoryCandidate,
    turns: readonly MemoryConversationTurn[],
    payload: ExtractWorkPayload,
  ): MemoryEvidenceInput[] | null {
    if (
      candidate.subject !== 'target_user'
      || normalizeText(candidate.ownerSpeakerId) !== payload.targetSpeakerId
    ) {
      return null;
    }
    const evidenceIds = uniqueStrings(candidate.evidenceMessageIds ?? []);
    const speakers = uniqueStrings(candidate.evidenceSpeakerIds ?? []);
    if (!evidenceIds.length || speakers.length !== 1 || speakers[0] !== payload.targetSpeakerId) {
      return null;
    }
    const byId = new Map(turns.map((turn) => [turn.id, turn]));
    const evidence: MemoryEvidenceInput[] = [];
    for (const messageId of evidenceIds) {
      const turn = byId.get(messageId);
      const audience = this.capturedAudience(payload, messageId);
      if (
        !turn
        || turn.role !== 'human'
        || !turn.isTarget
        || turn.speakerId !== payload.targetSpeakerId
        || !TRUSTED_TARGET_ATTRIBUTION.has(turn.attributionSource)
        || !audience?.includes(payload.address.userKey)
      ) {
        return null;
      }
      evidence.push({
        messageId,
        speakerId: payload.targetSpeakerId,
        contextKey: payload.address.contextKey,
        threadId: payload.address.conversationId,
        captureAudienceSubjectKeys: audience,
        replyToMessageId: turn.parentId ?? null,
        excerpt: turn.text,
        occurredAt: turn.occurredAt ?? payload.address.observedAt,
      });
    }
    return evidence;
  }

  private domainEvidence(
    candidate: ExtractedMemoryCandidate,
    turns: readonly MemoryConversationTurn[],
    payload: ExtractWorkPayload,
  ): {
    assertionType: 'groupArtifact' | 'assistantCommitment';
    subjectType: 'group' | 'assistant';
    subjectKey: string;
    evidence: MemoryEvidenceInput[];
    safeAudience: string[];
  } | null {
    if (candidate.candidateType !== 'fact' || candidate.sensitivity !== 'low') return null;
    const evidenceIds = uniqueStrings(candidate.evidenceMessageIds ?? []);
    const declaredSpeakers = uniqueStrings(candidate.evidenceSpeakerIds ?? []);
    if (!evidenceIds.length) return null;
    const byId = new Map(turns.map((turn) => [turn.id, turn]));
    const evidence: MemoryEvidenceInput[] = [];

    if (candidate.subject === 'group_shared') {
      const groupId = normalizeText(
        payload.address.groupId ?? payload.address.channelId ?? payload.address.rawContextId,
      );
      if (
        payload.address.channelType !== 'group'
        || !groupId
        || normalizeText(candidate.ownerSpeakerId) !== 'group'
      ) {
        return null;
      }
      const speakers: string[] = [];
      for (const messageId of evidenceIds) {
        const turn = byId.get(messageId);
        const speakerId = normalizeText(turn?.speakerId);
        const audience = this.capturedAudience(payload, messageId);
        if (
          !turn
          || turn.role !== 'human'
          || turn.attributionSource !== 'additional_kwargs'
          || !speakerId
          || turn.ownerUserKey !== `${payload.address.platform}:user:${speakerId}`
          || !audience?.includes(`${payload.address.platform}:user:${speakerId}`)
        ) {
          return null;
        }
        speakers.push(speakerId);
        evidence.push({
          messageId,
          speakerId,
          contextKey: payload.address.contextKey,
          threadId: payload.address.conversationId,
          captureAudienceSubjectKeys: audience,
          replyToMessageId: turn.parentId ?? null,
          excerpt: turn.text,
          occurredAt: turn.occurredAt ?? payload.address.observedAt,
        });
      }
      if (serialize(uniqueStrings(speakers)) !== serialize(declaredSpeakers)) return null;
      const safeAudience = evidence
        .map((row) => new Set(row.captureAudienceSubjectKeys))
        .reduce<string[]>((current, next, index) => (
          index === 0
            ? [...next]
            : current.filter((subjectKey) => next.has(subjectKey))
        ), [])
        .sort();
      return safeAudience.length
        ? {
            assertionType: 'groupArtifact',
            subjectType: 'group',
            subjectKey: `${payload.address.platform}:group:${groupId}`,
            evidence,
            safeAudience,
          }
        : null;
    }

    if (
      candidate.subject !== 'assistant'
      || normalizeText(candidate.ownerSpeakerId) !== payload.address.botSelfId
      || serialize(declaredSpeakers) !== serialize([payload.address.botSelfId])
    ) {
      return null;
    }
    for (const messageId of evidenceIds) {
      const turn = byId.get(messageId);
      const parent = turn?.parentId ? byId.get(turn.parentId) : null;
      const actorKey = parent?.speakerId
        ? `${payload.address.platform}:user:${parent.speakerId}`
        : '';
      const audience = parent ? this.capturedAudience(payload, parent.id) : null;
      if (
        !turn
        || turn.role !== 'ai'
        || turn.attributionSource !== 'assistant'
        || turn.speakerId !== payload.address.botSelfId
        || !parent
        || parent.role !== 'human'
        || !TRUSTED_TARGET_ATTRIBUTION.has(parent.attributionSource)
        || !actorKey
        || parent.ownerUserKey !== actorKey
        || !audience?.includes(actorKey)
      ) {
        return null;
      }
      evidence.push({
        messageId,
        speakerId: payload.address.botSelfId,
        contextKey: payload.address.contextKey,
        threadId: payload.address.conversationId,
        captureAudienceSubjectKeys: audience,
        replyToMessageId: parent.id,
        excerpt: turn.text,
        occurredAt: turn.occurredAt ?? payload.address.observedAt,
      });
    }
    const safeAudience = evidence
      .map((row) => new Set(row.captureAudienceSubjectKeys))
      .reduce<string[]>((current, next, index) => (
        index === 0 ? [...next] : current.filter((subjectKey) => next.has(subjectKey))
      ), [])
      .sort();
    return safeAudience.length
      ? {
          assertionType: 'assistantCommitment',
          subjectType: 'assistant',
          subjectKey: `${payload.address.platform}:bot:${payload.address.botSelfId}`,
          evidence,
          safeAudience,
        }
      : null;
  }

  private async persistPayloadAndEvidence(
    database: MemoryDatabaseLike,
    input: {
      eventId: string;
      payloadId: string;
      content: string;
      retrievalText: string;
      contentHash: string;
      evidence: MemoryEvidenceInput[];
      createdAt: number;
    },
  ): Promise<void> {
    await database.create(MEMORY_LEDGER_TABLES.payload, {
      payloadId: input.payloadId,
      eventId: input.eventId,
      payloadKind: 'assertion',
      content: input.content,
      retrievalText: input.retrievalText,
      contentHash: input.contentHash,
      createdAt: input.createdAt,
    });
    for (const evidence of input.evidence) {
      let excerptPayloadId: string | null = null;
      const excerpt = normalizeText(evidence.excerpt);
      if (excerpt) {
        excerptPayloadId = randomUUID();
        await database.create(MEMORY_LEDGER_TABLES.payload, {
          payloadId: excerptPayloadId,
          eventId: input.eventId,
          payloadKind: 'evidenceExcerpt',
          content: excerpt,
          retrievalText: null,
          contentHash: sha256(excerpt),
          createdAt: input.createdAt,
        });
      }
      await database.create(MEMORY_LEDGER_TABLES.evidence, {
        evidenceId: randomUUID(),
        eventId: input.eventId,
        messageId: evidence.messageId,
        speakerId: evidence.speakerId,
        contextKey: evidence.contextKey,
        threadId: evidence.threadId ?? null,
        captureAudienceSubjectKeys: serialize(
          uniqueStrings(evidence.captureAudienceSubjectKeys),
        ),
        replyToMessageId: evidence.replyToMessageId ?? null,
        excerptPayloadId,
        occurredAt: evidence.occurredAt,
      });
    }
  }

  private async appendAssertionTx(
    database: MemoryDatabaseLike,
    input: AppendAssertionInput,
  ): Promise<MemoryV3HeadRecord> {
    const duplicate = await database.get(MEMORY_LEDGER_TABLES.event, {
      idempotencyKey: input.idempotencyKey,
    }) as MemoryV3EventRecord[];
    if (duplicate.length) {
      const [head] = await database.get(MEMORY_LEDGER_TABLES.head, {
        streamId: duplicate[0]!.streamId,
      }) as MemoryV3HeadRecord[];
      if (!head) {
        throw new MemoryRuntimeError(
          'extract',
          'write',
          'memory_idempotency_projection_missing',
          'Existing memory event has no head projection.',
        );
      }
      return head;
    }

    const content = input.content.trim();
    const retrievalText = input.retrievalText.trim();
    const topicKey = normalizedTopicKey(input.topicKey);
    const kind = input.assertionType === 'episode' ? null : input.kind ?? null;
    if (
      !content
      || !retrievalText
      || !topicKey
      || (!kind && input.assertionType !== 'episode')
      || !input.evidence.length
      || input.evidence.some((row) => !uniqueStrings(row.captureAudienceSubjectKeys).length)
    ) {
      throw new MemoryRuntimeError(
        'extract',
        'validation',
        'memory_assertion_invalid',
        'Memory assertions require structured identity, content, and complete evidence.',
      );
    }
    if (
      input.subjectType === 'user'
      && input.evidence.some((row) => row.speakerId !== input.subjectKey.split(':').at(-1))
    ) {
      throw new MemoryRuntimeError(
        'extract',
        'validation',
        'memory_assertion_speaker_conflict',
        'Evidence speaker conflicts with the assertion subject.',
      );
    }
    const audienceContextKeys = uniqueStrings(input.audienceContextKeys);
    const audienceSnapshots = parseAudienceSnapshots(serialize(input.audienceSnapshots));
    if (
      input.audiencePolicy !== 'subjectAllContexts'
      && audienceContextKeys.some((key) => !audienceSnapshots[key]?.length)
    ) {
      throw new MemoryRuntimeError(
        'extract',
        'validation',
        'memory_capture_audience_missing',
        'Every memory audience context requires an immutable capture snapshot.',
      );
    }
    const memoryKey = input.memoryKey ?? createMemoryKey({
      ...input,
      kind,
      topicKey,
    });
    const [existing] = await database.get(MEMORY_LEDGER_TABLES.head, {
      memoryKey,
    }) as MemoryV3HeadRecord[];
    const contentHash = sha256(serialize([content, retrievalText]));
    if (
      existing
      && existing.state !== 'forgotten'
      && existing.contentHash === contentHash
    ) {
      return existing;
    }

    const now = input.createdAt ?? Date.now();
    const streamId = input.streamId ?? existing?.streamId ?? randomUUID();
    if (input.streamId && existing && existing.streamId !== input.streamId) {
      throw new MemoryRuntimeError(
        'extract',
        'validation',
        'memory_identity_stream_conflict',
        'Memory identity is already owned by another stream.',
      );
    }
    const revision = (existing?.revision ?? 0) + 1;
    const eventId = randomUUID();
    const payloadId = randomUUID();
    const eventType = existing ? 'superseded' : 'asserted';
    const event = {
      eventId,
      streamId,
      revision,
      eventType,
      assertionType: input.assertionType,
      kind,
      topicKey,
      memoryKey,
      subjectType: input.subjectType,
      subjectKey: input.subjectKey,
      actorKey: input.actorKey,
      sourceContextKey: input.sourceContextKey,
      audiencePolicy: input.audiencePolicy,
      audienceContextKeys: serialize(audienceContextKeys),
      audienceSnapshots: serialize(audienceSnapshots),
      sensitivity: input.sensitivity,
      payloadId,
      causationId: input.causationId ?? existing?.eventId ?? null,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    } satisfies Omit<MemoryV3EventRecord, 'id'>;
    await database.create(MEMORY_LEDGER_TABLES.event, event);
    await this.persistPayloadAndEvidence(database, {
      eventId,
      payloadId,
      content,
      retrievalText,
      contentHash,
      evidence: input.evidence,
      createdAt: now,
    });
    const generation = existing?.deletionGeneration
      ?? await this.streamGeneration(database, input.subjectKey, streamId);
    if (existing) {
      await database.set(MEMORY_LEDGER_TABLES.head, { id: existing.id }, {
        eventId,
        revision,
        state: input.state,
        assertionType: input.assertionType,
        kind,
        topicKey,
        memoryKey,
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
        updatedAt: now,
      });
    } else {
      await database.create(MEMORY_LEDGER_TABLES.head, {
        streamId,
        eventId,
        revision,
        state: input.state,
        assertionType: input.assertionType,
        kind,
        topicKey,
        memoryKey,
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
      });
    }
    if (input.state === 'active') {
      await this.searchIndex.insert(database, {
        streamId,
        eventId,
        revision,
        contentHash,
        canonicalText: retrievalText,
      });
    } else {
      await this.searchIndex.remove(database, streamId);
    }
    await this.writeAudit(database, {
      idempotencyKey: `assertion:${input.idempotencyKey}`,
      subjectKey: input.subjectKey,
      contextKey: input.sourceContextKey,
      eventType: input.state === 'active'
        ? existing ? 'assertion_superseded' : 'assertion_activated'
        : 'assertion_pending_review',
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
    const [head] = await database.get(MEMORY_LEDGER_TABLES.head, {
      streamId,
    }) as MemoryV3HeadRecord[];
    if (!head) {
      throw new MemoryRuntimeError(
        'extract',
        'write',
        'memory_head_projection_missing',
        'Memory head projection was not created.',
      );
    }
    return head;
  }

  async appendAssertion(input: AppendAssertionInput): Promise<MemoryV3HeadRecord> {
    return this.unitOfWork.run('extract', async (database) => (
      this.appendAssertionTx(database, input)
    ));
  }

  async ingestGroupArtifact(
    input: DeterministicDomainMemoryInput,
  ): Promise<DeterministicDomainMemoryResult> {
    return this.ingestDomainMemory('groupArtifact', input);
  }

  async ingestAssistantCommitment(
    input: DeterministicDomainMemoryInput,
  ): Promise<DeterministicDomainMemoryResult> {
    return this.ingestDomainMemory('assistantCommitment', input);
  }

  private async ingestDomainMemory(
    type: 'groupArtifact' | 'assistantCommitment',
    input: DeterministicDomainMemoryInput,
  ): Promise<DeterministicDomainMemoryResult> {
    const payload: ExtractWorkPayload = {
      address: input.address,
      targetSpeakerId: input.address.userId,
      targetSpeakerName: null,
      latestAnchorMessageId: input.evidenceMessageIds.at(-1) ?? '',
      maxMessages: input.turns.length,
      capturedAudiences: input.capturedAudiences ?? input.evidenceMessageIds.map((messageId) => ({
        messageId,
        observedAt: input.address.observedAt,
        audienceSubjectKeys: input.address.currentAudienceSubjectKeys ?? [],
      })),
    };
    const candidate: ExtractedMemoryCandidate = {
      candidateType: 'fact',
      subject: type === 'groupArtifact' ? 'group_shared' : 'assistant',
      ownerSpeakerId: type === 'groupArtifact' ? 'group' : input.address.botSelfId,
      kind: input.kind,
      topicKey: input.topicKey,
      content: input.content,
      keywords: [],
      importance: input.importance,
      confidence: input.confidence,
      sensitivity: input.sensitivity,
      evidenceMessageIds: input.evidenceMessageIds,
      evidenceSpeakerIds: type === 'groupArtifact'
        ? uniqueStrings(input.turns
            .filter((turn) => input.evidenceMessageIds.includes(turn.id))
            .map((turn) => turn.speakerId))
        : [input.address.botSelfId],
    };
    const domain = this.domainEvidence(candidate, input.turns, payload);
    if (!domain || domain.assertionType !== type) {
      throw new MemoryRuntimeError(
        'extract',
        'validation',
        'memory_domain_attribution_invalid',
        'Domain memory evidence does not satisfy attribution policy.',
      );
    }
    const idempotencyKey = `domain:${sha256(serialize([
      type,
      input.topicKey,
      domain.evidence.map((row) => row.messageId),
      input.content,
    ]))}`;
    const head = await this.appendAssertion({
      idempotencyKey,
      assertionType: type,
      kind: input.kind,
      topicKey: input.topicKey,
      subjectType: domain.subjectType,
      subjectKey: domain.subjectKey,
      actorKey: input.address.userKey,
      sourceContextKey: input.address.contextKey,
      audiencePolicy: 'sourceContext',
      audienceContextKeys: [input.address.contextKey],
      audienceSnapshots: {
        [input.address.contextKey]: domain.safeAudience,
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
      evidence: domain.evidence,
      createdAt: input.createdAt,
    });
    return {
      head,
      laneKey: createMemoryExtractLaneKey(input.address.userKey, input.address.contextKey),
      workKey: idempotencyKey,
      idempotencyKey,
    };
  }

  async finalizeExtraction(input: FinalizeExtractionInput): Promise<void> {
    await this.unitOfWork.run('extract', async (database) => {
      const current = await this.assertLease(database, input.work, input.leaseToken);
      const byId = new Map(input.turns.map((turn) => [turn.id, turn]));
      let accepted = 0;
      let pending = 0;
      let rejected = 0;
      for (const [index, candidate] of input.candidates.entries()) {
        const fields = candidateFields(candidate);
        if (!fields) {
          rejected += 1;
          continue;
        }
        let subjectType: MemorySubjectType;
        let subjectKey: string;
        let evidence: MemoryEvidenceInput[];
        let audiencePolicy: MemoryAudiencePolicy;
        let audienceContextKeys: string[];
        let audienceSnapshots: Record<string, string[]>;

        if (candidate.subject === 'target_user') {
          const userEvidence = this.userEvidence(candidate, input.turns, input.payload);
          if (!userEvidence) {
            rejected += 1;
            continue;
          }
          subjectType = 'user';
          subjectKey = input.payload.address.userKey;
          evidence = userEvidence;
          const safeAudience = userEvidence
            .map((row) => new Set(row.captureAudienceSubjectKeys))
            .reduce<string[]>((currentAudience, next, evidenceIndex) => (
              evidenceIndex === 0
                ? [...next]
                : currentAudience.filter((key) => next.has(key))
            ), [])
            .sort();
          audiencePolicy = input.payload.address.channelType === 'group'
            && candidate.sensitivity === 'low'
            ? 'captureAudience'
            : 'subjectPrivate';
          audienceContextKeys = [input.payload.address.contextKey];
          audienceSnapshots = {
            [input.payload.address.contextKey]: audiencePolicy === 'captureAudience'
              ? safeAudience
              : [subjectKey],
          };
        } else {
          const domain = this.domainEvidence(candidate, input.turns, input.payload);
          if (!domain) {
            rejected += 1;
            continue;
          }
          subjectType = domain.subjectType;
          subjectKey = domain.subjectKey;
          evidence = domain.evidence;
          audiencePolicy = 'sourceContext';
          audienceContextKeys = [input.payload.address.contextKey];
          audienceSnapshots = {
            [input.payload.address.contextKey]: domain.safeAudience,
          };
        }
        if (!evidence.every((row) => byId.has(row.messageId))) {
          rejected += 1;
          continue;
        }
        const guard = runDeterministicCaptureGuard(
          candidate,
          input.payload.address,
          this.policy,
        );
        if (guard.state === 'rejected') {
          rejected += 1;
          continue;
        }
        const state: 'active' | 'pendingReview' = candidate.conflictHint?.trim()
          || candidate.confidence < 0.78
          ? 'pendingReview'
          : guard.state === 'active'
            ? 'active'
            : 'pendingReview';
        const idempotencyKey = `extract:${sha256(serialize([
          current.workKey,
          fields.assertionType,
          fields.kind,
          fields.topicKey,
          fields.content,
          evidence.map((row) => row.messageId),
        ]))}`;
        await this.appendAssertionTx(database, {
          idempotencyKey,
          assertionType: fields.assertionType,
          kind: fields.kind,
          topicKey: fields.topicKey,
          subjectType,
          subjectKey,
          actorKey: input.payload.address.userKey,
          sourceContextKey: input.payload.address.contextKey,
          audiencePolicy,
          audienceContextKeys,
          audienceSnapshots,
          sensitivity: guard.sensitivity,
          state,
          content: fields.content,
          retrievalText: fields.retrievalText,
          importance: candidate.importance,
          confidence: candidate.confidence,
          validFrom: timestamp(candidate.validFrom ?? candidate.periodStart),
          validUntil: timestamp(candidate.validUntil ?? candidate.periodEnd),
          expiresAt: timestamp(candidate.expiresAt),
          evidence,
          auditWorkKey: current.workKey,
          createdAt: input.payload.address.observedAt,
        });
        if (state === 'active') accepted += 1;
        else pending += 1;
      }
      await this.finishExtractionWork(database, current, input.payload, {
        accepted,
        pending,
        rejected,
        providerRoute: input.providerRoute,
        rawTextHash: input.rawTextHash,
      });
    });
  }

  private async finishExtractionWork(
    database: MemoryDatabaseLike,
    work: MemoryV3WorkRecord,
    payload: ExtractWorkPayload,
    detail: {
      accepted: number;
      pending: number;
      rejected: number;
      providerRoute: MemoryOutputProtocolId | null;
      rawTextHash: string | null;
    },
  ): Promise<void> {
    const laneKey = work.laneKey ?? createMemoryExtractLaneKey(
      payload.address.userKey,
      payload.address.contextKey,
    );
    const [cursor] = await database.get(MEMORY_LEDGER_TABLES.cursor, {
      laneKey,
    }) as MemoryV3CursorRecord[];
    const now = Date.now();
    if (cursor) {
      await database.set(MEMORY_LEDGER_TABLES.cursor, { id: cursor.id }, {
        conversationId: payload.address.conversationId,
        lastMessageId: payload.latestAnchorMessageId,
        lastMessageAt: payload.address.observedAt,
        lastWindowHash: work.inputHash,
        updatedAt: now,
      });
    } else {
      await database.create(MEMORY_LEDGER_TABLES.cursor, {
        laneKey,
        subjectKey: payload.address.userKey,
        contextKey: payload.address.contextKey,
        conversationId: payload.address.conversationId,
        lastMessageId: payload.latestAnchorMessageId,
        lastMessageAt: payload.address.observedAt,
        lastWindowHash: work.inputHash,
        discardBeforeMessageId: null,
        firstSeenAt: now,
        updatedAt: now,
      });
    }
    await database.set(MEMORY_LEDGER_TABLES.work, { id: work.id }, {
      status: 'succeeded',
      payload: '{}',
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
      completedAt: now,
    });
    await this.writeAudit(database, {
      idempotencyKey: `extraction-finalized:${work.workKey}`,
      subjectKey: work.subjectKey,
      contextKey: work.contextKey,
      eventType: 'extraction_finalized',
      workKey: work.workKey,
      detail,
      createdAt: now,
    });
  }

  async completeEmptyExtraction(
    work: MemoryV3WorkRecord,
    leaseToken: string,
    payload: ExtractWorkPayload,
    providerRoute: MemoryOutputProtocolId | null,
    _maxLeaseRetries: number,
  ): Promise<void> {
    await this.unitOfWork.run('extract', async (database) => {
      const current = await this.assertLease(database, work, leaseToken);
      await this.finishExtractionWork(database, current, payload, {
        accepted: 0,
        pending: 0,
        rejected: 0,
        providerRoute,
        rawTextHash: null,
      });
    });
  }

  private async toLedgerItem(
    head: MemoryV3HeadRecord,
    lexicalScore: number | null,
  ): Promise<MemoryLedgerItem | null> {
    if (!head.payloadId || !head.contentHash) return null;
    const [payload] = await this.database.get(MEMORY_LEDGER_TABLES.payload, {
      payloadId: head.payloadId,
    }) as MemoryV3PayloadRecord[];
    if (!payload || payload.contentHash !== head.contentHash) return null;
    const evidence = await this.database.get(MEMORY_LEDGER_TABLES.evidence, {
      eventId: payload.eventId,
    }) as MemoryV3EvidenceRecord[];
    if (!evidence.length) return null;
    const [principal] = head.subjectType === 'user'
      ? await this.database.get(MEMORY_LEDGER_TABLES.principal, {
          userKey: head.subjectKey,
        }) as MemoryV3PrincipalRecord[]
      : [];
    return {
      streamId: head.streamId,
      revision: head.revision,
      assertionType: head.assertionType,
      kind: head.kind,
      topicKey: head.topicKey,
      subjectType: head.subjectType,
      subjectKey: head.subjectKey,
      subjectDisplayName: principal?.displayName ?? null,
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
      lexicalScore,
      evidence,
      updatedAt: head.updatedAt,
    };
  }

  async listForContext(
    address: MemoryAddress,
    now = address.observedAt,
    query = '',
    limit = 64,
    filters: {
      assertionTypes?: readonly MemoryAssertionType[];
      from?: number | null;
      to?: number | null;
    } = {},
  ): Promise<MemoryLedgerItem[]> {
    const maximumCandidates = Math.min(512, Math.max(limit * 16, 64));
    const scores = query.trim()
      ? await this.searchIndex.search(
          this.database,
          query,
          maximumCandidates,
          filters,
        )
      : new Map<string, number>();
    const candidateIds = query.trim()
      ? [...scores.keys()]
      : await this.searchIndex.recent(
          this.database,
          maximumCandidates,
          filters,
        );
    const heads = (await Promise.all(candidateIds.map(async (streamId) => {
      const [head] = await this.database.get(MEMORY_LEDGER_TABLES.head, {
        streamId,
        state: 'active',
      }) as MemoryV3HeadRecord[];
      return head ?? null;
    }))).filter((head): head is MemoryV3HeadRecord => head !== null);
    const allowed = heads.filter((head) => this.policy.canRecall({
      ...head,
      audienceContextKeys: parseAudienceContextKeys(head.audienceContextKeys),
      audienceSnapshots: parseAudienceSnapshots(head.audienceSnapshots),
    }, address, now));
    const rankByStream = new Map(
      candidateIds.map((streamId, index) => [streamId, index]),
    );
    const selected = query.trim()
      ? allowed.sort((left, right) => (
          (scores.get(right.streamId) ?? 0) - (scores.get(left.streamId) ?? 0)
          || right.updatedAt - left.updatedAt
        ))
      : allowed.sort((left, right) => (
          (rankByStream.get(left.streamId) ?? Number.MAX_SAFE_INTEGER)
          - (rankByStream.get(right.streamId) ?? Number.MAX_SAFE_INTEGER)
        ));
    const items = await Promise.all(selected.slice(0, limit).map((head) => (
      this.toLedgerItem(head, scores.get(head.streamId) ?? null)
    )));
    return items.filter((item): item is MemoryLedgerItem => item !== null);
  }

  async listForOwner(
    address: MemoryAddress,
    privateExport = false,
  ): Promise<MemoryLedgerItem[]> {
    const heads = await this.database.get(MEMORY_LEDGER_TABLES.head, {
      subjectKey: address.userKey,
    }) as MemoryV3HeadRecord[];
    const allowed = heads.filter((head) => this.policy.canList({
      ...head,
      audienceContextKeys: parseAudienceContextKeys(head.audienceContextKeys),
      audienceSnapshots: parseAudienceSnapshots(head.audienceSnapshots),
    }, address, privateExport, address.observedAt));
    const items = await Promise.all(
      allowed.sort((left, right) => right.updatedAt - left.updatedAt)
        .map((head) => this.toLedgerItem(head, null)),
    );
    return items.filter((item): item is MemoryLedgerItem => item !== null);
  }

  async review(input: {
    streamId: string;
    actor: { userKey: string; isDirect: boolean; isAdmin?: boolean };
    decision: 'approve' | 'reject';
  }): Promise<void> {
    await this.unitOfWork.run('review', async (database) => {
      const [head] = await database.get(MEMORY_LEDGER_TABLES.head, {
        streamId: input.streamId,
      }) as MemoryV3HeadRecord[];
      if (!head) {
        throw new MemoryRuntimeError(
          'review',
          'validation',
          'memory_stream_not_found',
          'Memory stream does not exist.',
        );
      }
      this.policy.assertCanReview(head, input.actor);
      const revision = head.revision + 1;
      const eventId = randomUUID();
      if (input.decision === 'approve') {
        await database.create(MEMORY_LEDGER_TABLES.event, {
          eventId,
          streamId: head.streamId,
          revision,
          eventType: 'reviewed',
          assertionType: head.assertionType,
          kind: head.kind,
          topicKey: head.topicKey,
          memoryKey: head.memoryKey,
          subjectType: head.subjectType,
          subjectKey: head.subjectKey,
          actorKey: input.actor.isAdmin ? 'admin' : input.actor.userKey,
          sourceContextKey: head.sourceContextKey,
          audiencePolicy: head.audiencePolicy,
          audienceContextKeys: head.audienceContextKeys,
          audienceSnapshots: head.audienceSnapshots,
          sensitivity: head.sensitivity,
          payloadId: head.payloadId,
          causationId: head.eventId,
          idempotencyKey: `review:approve:${head.streamId}:${revision}`,
          createdAt: Date.now(),
        });
        await database.set(MEMORY_LEDGER_TABLES.head, { id: head.id }, {
          eventId,
          revision,
          state: 'active',
          updatedAt: Date.now(),
        });
        const [payload] = await database.get(MEMORY_LEDGER_TABLES.payload, {
          payloadId: head.payloadId,
        }) as MemoryV3PayloadRecord[];
        if (!payload || !head.contentHash) {
          throw new MemoryRuntimeError(
            'review',
            'validation',
            'memory_review_payload_missing',
            'Pending memory payload is incomplete.',
          );
        }
        await this.searchIndex.insert(database, {
          streamId: head.streamId,
          eventId,
          revision,
          contentHash: head.contentHash,
          canonicalText: payload.retrievalText ?? payload.content,
        });
      } else {
        const [pendingEvent] = await database.get(MEMORY_LEDGER_TABLES.event, {
          eventId: head.eventId,
        }) as MemoryV3EventRecord[];
        const [previousEvent] = pendingEvent?.causationId
          ? await database.get(MEMORY_LEDGER_TABLES.event, {
              eventId: pendingEvent.causationId,
            }) as MemoryV3EventRecord[]
          : [];
        const [previousPayload] = previousEvent?.payloadId
          ? await database.get(MEMORY_LEDGER_TABLES.payload, {
              payloadId: previousEvent.payloadId,
            }) as MemoryV3PayloadRecord[]
          : [];
        const restore = Boolean(previousEvent && previousPayload);
        await database.create(MEMORY_LEDGER_TABLES.event, {
          eventId,
          streamId: head.streamId,
          revision,
          eventType: 'reviewed',
          assertionType: restore ? previousEvent!.assertionType : head.assertionType,
          kind: restore ? previousEvent!.kind : head.kind,
          topicKey: restore ? previousEvent!.topicKey : head.topicKey,
          memoryKey: head.memoryKey,
          subjectType: restore ? previousEvent!.subjectType : head.subjectType,
          subjectKey: restore ? previousEvent!.subjectKey : head.subjectKey,
          actorKey: input.actor.isAdmin ? 'admin' : input.actor.userKey,
          sourceContextKey: restore ? previousEvent!.sourceContextKey : head.sourceContextKey,
          audiencePolicy: restore ? previousEvent!.audiencePolicy : head.audiencePolicy,
          audienceContextKeys: restore ? previousEvent!.audienceContextKeys : head.audienceContextKeys,
          audienceSnapshots: restore ? previousEvent!.audienceSnapshots : head.audienceSnapshots,
          sensitivity: restore ? previousEvent!.sensitivity : head.sensitivity,
          payloadId: restore ? previousEvent!.payloadId : null,
          causationId: head.eventId,
          idempotencyKey: `review:reject:${head.streamId}:${revision}`,
          createdAt: Date.now(),
        });
        await database.set(MEMORY_LEDGER_TABLES.head, { id: head.id }, {
          eventId,
          revision,
          state: restore ? 'active' : 'retracted',
          ...(restore ? {
            assertionType: previousEvent!.assertionType,
            kind: previousEvent!.kind,
            topicKey: previousEvent!.topicKey,
            subjectType: previousEvent!.subjectType,
            subjectKey: previousEvent!.subjectKey,
            sourceContextKey: previousEvent!.sourceContextKey,
            audiencePolicy: previousEvent!.audiencePolicy,
            audienceContextKeys: previousEvent!.audienceContextKeys,
            audienceSnapshots: previousEvent!.audienceSnapshots,
            sensitivity: previousEvent!.sensitivity,
            payloadId: previousEvent!.payloadId,
            contentHash: previousPayload!.contentHash,
          } : {
            payloadId: null,
            contentHash: null,
          }),
          updatedAt: Date.now(),
        });
        if (restore) {
          await this.searchIndex.insert(database, {
            streamId: head.streamId,
            eventId,
            revision,
            contentHash: previousPayload!.contentHash,
            canonicalText: previousPayload!.retrievalText ?? previousPayload!.content,
          });
        } else {
          await this.searchIndex.remove(database, head.streamId);
        }
        if (head.payloadId) {
          const pendingPayloads = await database.get(MEMORY_LEDGER_TABLES.payload, {
            eventId: head.eventId,
          }) as MemoryV3PayloadRecord[];
          await database.remove(MEMORY_LEDGER_TABLES.evidence, {
            eventId: head.eventId,
          });
          for (const payload of pendingPayloads) {
            await database.remove(MEMORY_LEDGER_TABLES.payload, { id: payload.id });
          }
        }
      }
      await this.writeAudit(database, {
        idempotencyKey: `review-audit:${head.streamId}:${revision}`,
        subjectKey: head.subjectKey,
        contextKey: head.sourceContextKey,
        eventType: input.decision === 'approve' ? 'review_approved' : 'review_rejected',
        streamId: head.streamId,
        eventId,
        detail: { decision: input.decision },
      });
    });
  }

  async promoteAudience(input: {
    streamId: string;
    actor: { userKey: string; isDirect: boolean; isAdmin?: boolean };
    audiencePolicy: 'subjectAllContexts' | 'explicitContexts';
    audienceContextKeys: string[];
    audienceSnapshots: Record<string, string[]>;
  }): Promise<void> {
    await this.unitOfWork.run('review', async (database) => {
      const [head] = await database.get(MEMORY_LEDGER_TABLES.head, {
        streamId: input.streamId,
      }) as MemoryV3HeadRecord[];
      if (!head || head.subjectType !== 'user' || head.subjectKey !== input.actor.userKey) {
        throw new MemoryRuntimeError(
          'review',
          'authorization',
          'memory_promotion_owner_mismatch',
          'Only the user memory subject can expand its audience.',
        );
      }
      if (!input.actor.isDirect) {
        throw new MemoryRuntimeError(
          'review',
          'authorization',
          'memory_promotion_requires_direct',
          'Memory audience promotion requires a direct chat.',
        );
      }
      const audienceContextKeys = uniqueStrings(input.audienceContextKeys);
      const audienceSnapshots = input.audiencePolicy === 'explicitContexts'
        ? parseAudienceSnapshots(serialize(input.audienceSnapshots))
        : {};
      if (
        input.audiencePolicy === 'explicitContexts'
        && audienceContextKeys.some((key) => !audienceSnapshots[key]?.includes(head.subjectKey))
      ) {
        throw new MemoryRuntimeError(
          'review',
          'validation',
          'memory_promotion_audience_invalid',
          'Explicit audience snapshots must contain the memory subject.',
        );
      }
      const memoryKey = createMemoryKey({
        assertionType: head.assertionType,
        kind: head.kind,
        topicKey: head.topicKey,
        subjectType: head.subjectType,
        subjectKey: head.subjectKey,
        audiencePolicy: input.audiencePolicy,
        sourceContextKey: head.sourceContextKey,
        audienceContextKeys,
        audienceSnapshots,
      });
      const conflictingHeads = await database.get(MEMORY_LEDGER_TABLES.head, {
        memoryKey,
      }) as MemoryV3HeadRecord[];
      if (conflictingHeads.some((candidate) => candidate.streamId !== head.streamId)) {
        throw new MemoryRuntimeError(
          'review',
          'validation',
          'memory_promotion_identity_conflict',
          'The promoted audience would collide with an existing memory identity.',
        );
      }
      const revision = head.revision + 1;
      const eventId = randomUUID();
      await database.create(MEMORY_LEDGER_TABLES.event, {
        eventId,
        streamId: head.streamId,
        revision,
        eventType: 'visibilityChanged',
        assertionType: head.assertionType,
        kind: head.kind,
        topicKey: head.topicKey,
        memoryKey,
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
        idempotencyKey: `visibility:${head.streamId}:${revision}`,
        createdAt: Date.now(),
      });
      await database.set(MEMORY_LEDGER_TABLES.head, { id: head.id }, {
        eventId,
        revision,
        memoryKey,
        audiencePolicy: input.audiencePolicy,
        audienceContextKeys: serialize(audienceContextKeys),
        audienceSnapshots: serialize(audienceSnapshots),
        updatedAt: Date.now(),
      });
      if (head.state === 'active' && head.contentHash) {
        await this.searchIndex.updateIdentity(database, {
          streamId: head.streamId,
          eventId,
          revision,
          contentHash: head.contentHash,
        });
      }
    });
  }

  private async archiveHeadTx(
    database: MemoryDatabaseLike,
    head: MemoryV3HeadRecord,
    actorKey: string,
    reasonCode: string,
    now: number,
  ): Promise<void> {
    const revision = head.revision + 1;
    const eventId = randomUUID();
    await database.create(MEMORY_LEDGER_TABLES.event, {
      eventId,
      streamId: head.streamId,
      revision,
      eventType: 'archived',
      assertionType: head.assertionType,
      kind: head.kind,
      topicKey: head.topicKey,
      memoryKey: head.memoryKey,
      subjectType: head.subjectType,
      subjectKey: head.subjectKey,
      actorKey,
      sourceContextKey: head.sourceContextKey,
      audiencePolicy: head.audiencePolicy,
      audienceContextKeys: head.audienceContextKeys,
      audienceSnapshots: head.audienceSnapshots,
      sensitivity: head.sensitivity,
      payloadId: head.payloadId,
      causationId: head.eventId,
      idempotencyKey: `archive:${head.streamId}:${revision}`,
      createdAt: now,
    });
    await database.set(MEMORY_LEDGER_TABLES.head, { id: head.id }, {
      eventId,
      revision,
      state: 'archived',
      updatedAt: now,
    });
    await this.searchIndex.remove(database, head.streamId);
    await this.writeAudit(database, {
      idempotencyKey: `archive-audit:${head.streamId}:${revision}`,
      subjectKey: head.subjectKey,
      contextKey: head.sourceContextKey,
      eventType: 'memory_archived',
      streamId: head.streamId,
      eventId,
      detail: { reasonCode },
      createdAt: now,
    });
  }

  async archive(input: {
    streamId: string;
    actor: { userKey: string; isDirect: boolean; isAdmin?: boolean };
    reasonCode?: string;
  }): Promise<void> {
    const reasonCode = canonicalReasonCode(
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
      }) as MemoryV3HeadRecord[];
      if (!head || (head.state !== 'active' && head.state !== 'pendingReview')) {
        throw new MemoryRuntimeError(
          'archive',
          'validation',
          'memory_archive_state_invalid',
          'Only active or pending memory can be archived.',
        );
      }
      await this.archiveHeadTx(database, head, 'admin', reasonCode, Date.now());
    });
  }

  async forget(input: {
    actor: { userKey: string; isDirect: boolean; isAdmin?: boolean };
    streamId?: string;
    contextKey?: string;
    all?: boolean;
    reasonCode?: string;
  }): Promise<number> {
    const reasonCode = canonicalReasonCode(
      input.reasonCode ?? 'subject-forget',
      'forget',
    );
    return this.unitOfWork.run('forget', async (database) => {
      const heads = await database.get(MEMORY_LEDGER_TABLES.head, input.streamId
        ? { streamId: input.streamId }
        : { subjectKey: input.actor.userKey }) as MemoryV3HeadRecord[];
      const targets = heads.filter((head) => (
        (!input.streamId || head.streamId === input.streamId)
        && (!input.contextKey || head.sourceContextKey === input.contextKey)
        && (Boolean(input.streamId) || Boolean(input.contextKey) || input.all === true)
        && head.state !== 'forgotten'
      ));
      if (!targets.length) return 0;
      for (const head of targets) this.policy.assertCanForget(head, input.actor);
      const now = Date.now();
      for (const head of targets) {
        const eventRows = await database.get(MEMORY_LEDGER_TABLES.event, {
          streamId: head.streamId,
        }) as MemoryV3EventRecord[];
        const evidenceRows = (await Promise.all(eventRows.map((event) => (
          database.get(MEMORY_LEDGER_TABLES.evidence, { eventId: event.eventId })
        )))).flat() as MemoryV3EvidenceRecord[];
        const nextGeneration = Math.max(
          head.deletionGeneration,
          await this.streamGeneration(database, head.subjectKey, head.streamId),
        ) + 1;
        await database.create(MEMORY_LEDGER_TABLES.suppression, {
          suppressionKey: `stream:${head.streamId}:${nextGeneration}`,
          subjectKey: head.subjectKey,
          contextKey: head.sourceContextKey,
          streamId: head.streamId,
          sourceMessageDigest: null,
          cutoffAt: now,
          generation: nextGeneration,
          reasonCode,
          createdAt: now,
        });
        for (const evidence of evidenceRows) {
          const suppressionKey = sourceSuppressionKey(
            evidence.contextKey,
            evidence.messageId,
          );
          const existing = await database.get(MEMORY_LEDGER_TABLES.suppression, {
            suppressionKey,
          });
          if (!existing.length) {
            await database.create(MEMORY_LEDGER_TABLES.suppression, {
              suppressionKey,
              subjectKey: head.subjectType === 'user' ? head.subjectKey : null,
              contextKey: evidence.contextKey,
              streamId: head.streamId,
              sourceMessageDigest: messageSuppressionDigest(evidence.messageId),
              cutoffAt: evidence.occurredAt,
              generation: nextGeneration,
              reasonCode: 'forgotten-source',
              createdAt: now,
            });
          }
        }
        const revision = head.revision + 1;
        const eventId = randomUUID();
        await database.create(MEMORY_LEDGER_TABLES.event, {
          eventId,
          streamId: head.streamId,
          revision,
          eventType: 'forgotten',
          assertionType: head.assertionType,
          kind: head.kind,
          topicKey: head.topicKey,
          memoryKey: head.memoryKey,
          subjectType: head.subjectType,
          subjectKey: head.subjectKey,
          actorKey: input.actor.isAdmin ? 'admin' : input.actor.userKey,
          sourceContextKey: head.sourceContextKey,
          audiencePolicy: head.audiencePolicy,
          audienceContextKeys: head.audienceContextKeys,
          audienceSnapshots: head.audienceSnapshots,
          sensitivity: head.sensitivity,
          payloadId: null,
          causationId: head.eventId,
          idempotencyKey: `forget:${head.streamId}:${revision}`,
          createdAt: now,
        });
        for (const event of eventRows) {
          const payloads = await database.get(MEMORY_LEDGER_TABLES.payload, {
            eventId: event.eventId,
          }) as MemoryV3PayloadRecord[];
          await database.remove(MEMORY_LEDGER_TABLES.evidence, {
            eventId: event.eventId,
          });
          for (const payload of payloads) {
            await database.remove(MEMORY_LEDGER_TABLES.payload, { id: payload.id });
          }
        }
        await database.set(MEMORY_LEDGER_TABLES.head, { id: head.id }, {
          eventId,
          revision,
          state: 'forgotten',
          payloadId: null,
          contentHash: null,
          deletionGeneration: nextGeneration,
          updatedAt: now,
        });
        await this.searchIndex.remove(database, head.streamId);
        const works = await database.get(MEMORY_LEDGER_TABLES.work, {
          subjectKey: head.subjectKey,
        }) as MemoryV3WorkRecord[];
        for (const work of works.filter((row) => (
          (row.status === 'pending' || row.status === 'leased')
          && (row.contextKey === head.sourceContextKey || row.streamId === head.streamId)
        ))) {
          await database.set(MEMORY_LEDGER_TABLES.work, { id: work.id }, {
            status: 'cancelled',
            payload: '{}',
            leaseToken: null,
            leaseExpiresAt: null,
            lastErrorCode: 'memory_forgotten',
            lastErrorStage: 'finalize',
            updatedAt: now,
            completedAt: now,
          });
        }
        await this.writeAudit(database, {
          idempotencyKey: `forget-audit:${head.streamId}:${revision}`,
          subjectKey: head.subjectKey,
          contextKey: head.sourceContextKey,
          eventType: 'memory_forgotten',
          streamId: head.streamId,
          eventId,
          detail: { reasonCode },
          createdAt: now,
        });
      }
      return targets.length;
    });
  }

  async archiveExpired(now = Date.now()): Promise<number> {
    return this.unitOfWork.run('maintenance', async (database) => {
      const heads = await database.get(MEMORY_LEDGER_TABLES.head, {
        state: 'active',
      }) as MemoryV3HeadRecord[];
      const targets = heads.filter((head) => (
        (head.validUntil != null && head.validUntil < now)
        || (head.expiresAt != null && head.expiresAt < now)
      ));
      for (const head of targets) {
        await this.archiveHeadTx(
          database,
          head,
          'memory.maintenance',
          'retention-policy',
          now,
        );
      }
      return targets.length;
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
      }) as MemoryV3HeadRecord[];
      const targets = heads.filter((head) => (
        head.sensitivity === 'low'
        && head.importance < 0.85
        && head.updatedAt <= threshold
      ));
      for (const head of targets) {
        await this.archiveHeadTx(
          database,
          head,
          'memory.maintenance',
          'retention-policy',
          now,
        );
      }
      return targets.length;
    });
  }

  async getQueueSummary(): Promise<MemoryQueueSummary> {
    const rows = await this.database.get(MEMORY_LEDGER_TABLES.work, {}) as MemoryV3WorkRecord[];
    const byType: Record<MemoryWorkType, number> = { extract: 0, maintenance: 0 };
    for (const row of rows) {
      if (row.status === 'pending' || row.status === 'leased') byType[row.workType] += 1;
    }
    return {
      pending: rows.filter((row) => row.status === 'pending').length,
      leased: rows.filter((row) => row.status === 'leased').length,
      failed: rows.filter((row) => row.status === 'failed').length,
      deadLetter: rows.filter((row) => row.status === 'deadLetter').length,
      byType,
    };
  }

  async getLedgerCounts(): Promise<MemoryLedgerCounts> {
    const heads = await this.database.get(MEMORY_LEDGER_TABLES.head, {}) as MemoryV3HeadRecord[];
    const [events, payloads, evidence, projections, lexicalTerms] = await Promise.all([
      this.database.get(MEMORY_LEDGER_TABLES.event, {}) as Promise<MemoryV3EventRecord[]>,
      this.database.get(MEMORY_LEDGER_TABLES.payload, {}) as Promise<MemoryV3PayloadRecord[]>,
      this.database.get(MEMORY_LEDGER_TABLES.evidence, {}) as Promise<MemoryV3EvidenceRecord[]>,
      this.searchIndex.list(this.database),
      this.searchIndex.countTerms(this.database),
    ]);
    const eventIds = new Set(events.map((event) => event.eventId));
    const payloadById = new Map(payloads.map((payload) => [payload.payloadId, payload]));
    const activeByStream = new Map(heads
      .filter((head) => head.state === 'active')
      .map((head) => [head.streamId, head]));
    const evidenceByEvent = new Map<string, MemoryV3EvidenceRecord[]>();
    for (const row of evidence) {
      evidenceByEvent.set(row.eventId, [...(evidenceByEvent.get(row.eventId) ?? []), row]);
    }
    const projectionByStream = new Map<string, MemoryLexicalProjectionRow[]>();
    for (const row of projections) {
      projectionByStream.set(row.streamId, [
        ...(projectionByStream.get(row.streamId) ?? []),
        row,
      ]);
    }
    const strandedByReason = { payload: 0, evidence: 0, audience: 0, lexical: 0 };
    let stranded = 0;
    for (const head of activeByStream.values()) {
      let rowStranded = false;
      const payload = head.payloadId ? payloadById.get(head.payloadId) : null;
      if (!payload || !head.contentHash || payload.contentHash !== head.contentHash) {
        strandedByReason.payload += 1;
        rowStranded = true;
      }
      const currentEvidence = payload
        ? evidenceByEvent.get(payload.eventId) ?? []
        : [];
      if (!currentEvidence.length) {
        strandedByReason.evidence += 1;
        rowStranded = true;
      }
      try {
        parseAudienceContextKeys(head.audienceContextKeys);
        parseAudienceSnapshots(head.audienceSnapshots);
        for (const row of currentEvidence) {
          if (!parseCaptureAudienceSubjectKeys(row.captureAudienceSubjectKeys).length) {
            throw new Error('empty audience');
          }
        }
      } catch {
        strandedByReason.audience += 1;
        rowStranded = true;
      }
      const currentProjection = projectionByStream.get(head.streamId) ?? [];
      if (
        !payload
        || currentProjection.length !== 1
        || !memoryLexicalProjectionMatches(currentProjection[0]!, {
          streamId: head.streamId,
          eventId: head.eventId,
          revision: head.revision,
          contentHash: head.contentHash ?? '',
          canonicalText: payload.retrievalText ?? payload.content,
        })
      ) {
        strandedByReason.lexical += 1;
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
      lexicalDocuments: projections.length,
      lexicalTerms,
      orphanEvidence: evidence.filter((row) => !eventIds.has(row.eventId)).length,
      staleLexicalDocuments: projections.filter((projection) => {
        const head = activeByStream.get(projection.streamId);
        const payload = head?.payloadId ? payloadById.get(head.payloadId) : null;
        return Boolean(head && (
          !payload
          || !memoryLexicalProjectionMatches(projection, {
            streamId: head.streamId,
            eventId: head.eventId,
            revision: head.revision,
            contentHash: head.contentHash ?? '',
            canonicalText: payload.retrievalText ?? payload.content,
          })
        ));
      }).length,
      inactiveLexicalDocuments: projections.filter(
        (projection) => !activeByStream.has(projection.streamId),
      ).length,
      strandedByReason,
    };
  }

  async getLatestRecallAudit(
    subjectKey: string,
    contextKey: string,
  ): Promise<MemoryV3AuditRecord | null> {
    const rows = await this.database.get(MEMORY_LEDGER_TABLES.audit, {
      subjectKey,
      contextKey,
      eventType: 'recall_selected',
    }) as MemoryV3AuditRecord[];
    return rows.sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
  }

  async listDeadLetterWork(): Promise<MemoryV3WorkRecord[]> {
    return this.database.get(MEMORY_LEDGER_TABLES.work, {
      status: 'deadLetter',
    }) as Promise<MemoryV3WorkRecord[]>;
  }

  async discardDeadLetterWork(id: number): Promise<void> {
    await this.unitOfWork.run('maintenance', async (database) => {
      const [work] = await database.get(MEMORY_LEDGER_TABLES.work, {
        id,
        status: 'deadLetter',
      }) as MemoryV3WorkRecord[];
      if (!work) {
        throw new MemoryRuntimeError(
          'maintenance',
          'validation',
          'memory_dead_letter_not_found',
          'Dead-letter work does not exist.',
        );
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
  return typeof value === 'string' && [
    'pending',
    'leased',
    'succeeded',
    'failed',
    'deadLetter',
    'cancelled',
  ].includes(value);
}
