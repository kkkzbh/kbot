import type {} from 'koishi';

export const MEMORY_LEDGER_SCHEMA_VERSION = 2 as const;

export type MemoryChannelType = 'direct' | 'group';
export type MemorySubjectType = 'user' | 'group' | 'assistant';
export type MemoryAssertionType =
  | 'userAssertion'
  | 'groupArtifact'
  | 'assistantCommitment'
  | 'episode';
export type MemoryEventType =
  | 'asserted'
  | 'reviewed'
  | 'superseded'
  | 'visibilityChanged'
  | 'retracted'
  | 'forgotten'
  | 'archived';
export type MemoryHeadState =
  | 'active'
  | 'pendingReview'
  | 'archived'
  | 'retracted'
  | 'forgotten';
export type MemoryAudiencePolicy =
  | 'subjectPrivate'
  | 'sourceContext'
  | 'captureAudience'
  | 'subjectAllContexts'
  | 'explicitContexts';
export type MemorySensitivity = 'low' | 'personal' | 'sensitive' | 'secret';
export type MemoryPayloadKind = 'assertion' | 'evidenceExcerpt';
export type MemoryWorkType = 'extract' | 'embed' | 'backfill' | 'maintenance';
export type MemoryWorkStatus =
  | 'pending'
  | 'leased'
  | 'succeeded'
  | 'failed'
  | 'deadLetter'
  | 'cancelled';
export type MemoryStatusSource = 'runtime' | 'probe' | null;
export type MemoryStatusState = 'never' | 'success' | 'failed';

export type MemoryOutputProtocolId =
  | 'native_responses_json_schema'
  | 'native_chat_json_schema'
  | 'unsupported_protocol';

export interface MemoryAddress {
  userKey: string;
  contextKey: string;
  channelType: MemoryChannelType;
  platform: string;
  botSelfId: string;
  userId: string;
  groupId?: string | null;
  channelId?: string | null;
  rawContextId?: string | null;
  conversationId: string;
  requestId?: string | null;
  currentAudienceSubjectKeys?: string[] | null;
  observedAt: number;
}

export interface MemoryV2MetaRecord {
  id: number;
  key: string;
  value: string;
  updatedAt: number;
}

export interface MemoryV2PrincipalRecord {
  id: number;
  userKey: string;
  platform: string;
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  readEnabled: number;
  writeEnabled: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface MemoryV2ContextRecord {
  id: number;
  contextKey: string;
  platform: string;
  botSelfId: string;
  channelType: MemoryChannelType;
  groupId: string | null;
  channelId: string | null;
  rawContextId: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface MemoryV2EventRecord {
  id: number;
  eventId: string;
  streamId: string;
  revision: number;
  eventType: MemoryEventType;
  assertionType: MemoryAssertionType;
  subjectType: MemorySubjectType;
  subjectKey: string;
  actorKey: string;
  sourceContextKey: string;
  audiencePolicy: MemoryAudiencePolicy;
  audienceContextKeys: string;
  audienceSnapshots: string;
  sensitivity: MemorySensitivity;
  payloadId: string | null;
  causationId: string | null;
  idempotencyKey: string;
  createdAt: number;
}

export interface MemoryV2PayloadRecord {
  id: number;
  payloadId: string;
  eventId: string;
  payloadKind: MemoryPayloadKind;
  content: string;
  retrievalText: string | null;
  contentHash: string;
  createdAt: number;
}

export interface MemoryV2EvidenceRecord {
  id: number;
  evidenceId: string;
  eventId: string;
  messageId: string;
  speakerId: string;
  contextKey: string;
  threadId: string | null;
  captureAudienceSubjectKeys: string;
  replyToMessageId: string | null;
  excerptPayloadId: string | null;
  occurredAt: number;
}

export interface MemoryV2HeadRecord {
  id: number;
  streamId: string;
  eventId: string;
  revision: number;
  state: MemoryHeadState;
  assertionType: MemoryAssertionType;
  subjectType: MemorySubjectType;
  subjectKey: string;
  sourceContextKey: string;
  audiencePolicy: MemoryAudiencePolicy;
  audienceContextKeys: string;
  audienceSnapshots: string;
  sensitivity: MemorySensitivity;
  payloadId: string | null;
  contentHash: string | null;
  importance: number;
  confidence: number;
  validFrom: number | null;
  validUntil: number | null;
  expiresAt: number | null;
  deletionGeneration: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryV2EmbeddingRecord {
  id: number;
  embeddingKey: string;
  streamId: string;
  eventId: string;
  revision: number;
  canonicalModel: string;
  modelRevision: number;
  contentHash: string;
  dimensions: number;
  vector: string;
  createdAt: number;
}

export interface MemoryV2FtsRecord {
  streamId: string;
  eventId: string;
  revision: number;
  contentHash: string;
  canonicalText: string;
  tokenCount: number;
  termFrequencies: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryV2WorkRecord {
  id: number;
  workKey: string;
  workType: MemoryWorkType;
  status: MemoryWorkStatus;
  subjectKey: string | null;
  contextKey: string | null;
  streamId: string | null;
  laneKey: string | null;
  payload: string;
  inputHash: string;
  targetRevision: number | null;
  deletionGeneration: number;
  retryCount: number;
  nextRunAt: number;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  lastErrorCode: string | null;
  lastErrorStage: string | null;
  upstreamStatus: number | null;
  providerCode: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface MemoryV2CursorRecord {
  id: number;
  laneKey: string;
  subjectKey: string;
  contextKey: string;
  conversationId: string;
  lastMessageId: string | null;
  lastMessageAt: number | null;
  lastWindowHash: string | null;
  discardBeforeMessageId: string | null;
  firstSeenAt: number;
  updatedAt: number;
}

export interface MemoryV2SuppressionRecord {
  id: number;
  suppressionKey: string;
  subjectKey: string | null;
  contextKey: string | null;
  streamId: string | null;
  sourceMessageDigest: string | null;
  cutoffAt: number | null;
  generation: number;
  reasonCode: string;
  createdAt: number;
}

export interface MemoryV2AuditRecord {
  id: number;
  auditId: string;
  idempotencyKey: string;
  subjectKey: string | null;
  contextKey: string | null;
  eventType: string;
  streamId: string | null;
  eventId: string | null;
  workKey: string | null;
  detailJson: string | null;
  createdAt: number;
}

export interface MemoryLedgerItem {
  streamId: string;
  revision: number;
  assertionType: MemoryAssertionType;
  subjectType: MemorySubjectType;
  subjectKey: string;
  sourceContextKey: string;
  audiencePolicy: MemoryAudiencePolicy;
  audienceContextKeys: string[];
  audienceSnapshots: Record<string, string[]>;
  sensitivity: MemorySensitivity;
  state: MemoryHeadState;
  content: string;
  retrievalText: string;
  contentHash: string;
  importance: number;
  confidence: number;
  validFrom: number | null;
  validUntil: number | null;
  expiresAt: number | null;
  embeddingModel: string | null;
  embeddingModelRevision: number | null;
  embedding: number[] | null;
  ftsScore: number | null;
  evidence: MemoryV2EvidenceRecord[];
  updatedAt: number;
}

export interface MemoryQueueSummary {
  pending: number;
  leased: number;
  failed: number;
  deadLetter: number;
  byType: Record<MemoryWorkType, number>;
}

export interface MemoryOperationSnapshot {
  configured: boolean;
  state: MemoryStatusState;
  lastSource: MemoryStatusSource;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface MemoryProviderRouteStats {
  route: MemoryOutputProtocolId;
  success: number;
  failure: number;
  lastError: string | null;
}

export interface MemoryLedgerCounts {
  active: number;
  pendingReview: number;
  archived: number;
  retracted: number;
  forgotten: number;
  stranded: number;
  ftsRows: number;
  embeddingRows: number;
  orphanEvidence: number;
  staleFts: number;
  inactiveFts: number;
  staleEmbedding: number;
  inactiveEmbedding: number;
  strandedByReason: {
    payload: number;
    evidence: number;
    audience: number;
    embedding: number;
    fts: number;
  };
}

export interface MemoryStatusSnapshot {
  schemaVersion: 2;
  available: boolean;
  enabled: boolean;
  maintenance: boolean;
  readEnabled: boolean;
  writeEnabled: boolean;
  extractConfigured: boolean;
  embedConfigured: boolean;
  extractModel: string;
  embedModel: string;
  jobs: MemoryQueueSummary;
  counts: MemoryLedgerCounts;
  providerRoutes: MemoryProviderRouteStats[];
  lastMaintenanceAt: number | null;
  extract: MemoryOperationSnapshot;
  embed: MemoryOperationSnapshot;
}

export interface MemoryProbeResult {
  target: 'memory.embedding' | 'memory.extract';
  ok: boolean;
  checkedAt: number;
  latencyMs: number | null;
  canonicalModel: string | null;
  schemaValid: boolean;
  dimensions: number | null;
  error: string | null;
  snapshot: MemoryStatusSnapshot;
}

export interface MemoryStatusServiceLike {
  getSnapshot(): Promise<MemoryStatusSnapshot>;
  probeEmbedding(): Promise<MemoryProbeResult>;
  probeExtraction(): Promise<MemoryProbeResult>;
}

declare module 'koishi' {
  interface Tables {
    memory_v2_meta: MemoryV2MetaRecord;
    memory_v2_principal: MemoryV2PrincipalRecord;
    memory_v2_context: MemoryV2ContextRecord;
    memory_v2_event: MemoryV2EventRecord;
    memory_v2_payload: MemoryV2PayloadRecord;
    memory_v2_evidence: MemoryV2EvidenceRecord;
    memory_v2_head: MemoryV2HeadRecord;
    memory_v2_embedding: MemoryV2EmbeddingRecord;
    memory_v2_fts: MemoryV2FtsRecord;
    memory_v2_work: MemoryV2WorkRecord;
    memory_v2_cursor: MemoryV2CursorRecord;
    memory_v2_suppression: MemoryV2SuppressionRecord;
    memory_v2_audit: MemoryV2AuditRecord;
  }

  interface Context {
    memoryStatus?: MemoryStatusServiceLike;
  }
}
