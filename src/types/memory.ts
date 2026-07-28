import type {} from 'koishi';

export const MEMORY_LEDGER_SCHEMA_VERSION = 3 as const;

export type MemoryChannelType = 'direct' | 'group';
export type MemorySubjectType = 'user' | 'group' | 'assistant';
export type MemoryAssertionType =
  | 'userAssertion'
  | 'groupArtifact'
  | 'assistantCommitment'
  | 'episode';
export type MemoryFactKind =
  | 'identity'
  | 'preference'
  | 'trait'
  | 'boundary'
  | 'plan'
  | 'relationship'
  | 'response_policy';
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
export type MemoryWorkType = 'extract' | 'maintenance';
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

export interface MemoryV3MetaRecord {
  id: number;
  key: string;
  value: string;
  updatedAt: number;
}

export interface MemoryV3PrincipalRecord {
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

export interface MemoryV3ContextRecord {
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

interface MemoryIdentityRecord {
  assertionType: MemoryAssertionType;
  kind: MemoryFactKind | null;
  topicKey: string;
  memoryKey: string;
  subjectType: MemorySubjectType;
  subjectKey: string;
  sourceContextKey: string;
  audiencePolicy: MemoryAudiencePolicy;
  audienceContextKeys: string;
  audienceSnapshots: string;
  sensitivity: MemorySensitivity;
}

export interface MemoryV3EventRecord extends MemoryIdentityRecord {
  id: number;
  eventId: string;
  streamId: string;
  revision: number;
  eventType: MemoryEventType;
  actorKey: string;
  payloadId: string | null;
  causationId: string | null;
  idempotencyKey: string;
  createdAt: number;
}

export interface MemoryV3PayloadRecord {
  id: number;
  payloadId: string;
  eventId: string;
  payloadKind: MemoryPayloadKind;
  content: string;
  retrievalText: string | null;
  contentHash: string;
  createdAt: number;
}

export interface MemoryV3EvidenceRecord {
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

export interface MemoryV3HeadRecord extends MemoryIdentityRecord {
  id: number;
  streamId: string;
  eventId: string;
  revision: number;
  state: MemoryHeadState;
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

export interface MemoryV3LexicalDocumentRecord {
  id: number;
  streamId: string;
  eventId: string;
  revision: number;
  contentHash: string;
  canonicalText: string;
  tokenCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryV3LexicalTermRecord {
  id: number;
  term: string;
  streamId: string;
  frequency: number;
}

export interface MemoryV3WorkRecord {
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

export interface MemoryV3CursorRecord {
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

export interface MemoryV3SuppressionRecord {
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

export interface MemoryV3AuditRecord {
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
  kind: MemoryFactKind | null;
  topicKey: string;
  subjectType: MemorySubjectType;
  subjectKey: string;
  subjectDisplayName: string | null;
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
  lexicalScore: number | null;
  evidence: MemoryV3EvidenceRecord[];
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
  lexicalDocuments: number;
  lexicalTerms: number;
  orphanEvidence: number;
  staleLexicalDocuments: number;
  inactiveLexicalDocuments: number;
  strandedByReason: {
    payload: number;
    evidence: number;
    audience: number;
    lexical: number;
  };
}

export interface MemorySearchMetrics {
  searches: number;
  recentReads: number;
  returnedItems: number;
  rejectedCalls: number;
  lastSearchAt: number | null;
}

export interface MemoryStatusSnapshot {
  schemaVersion: 3;
  available: boolean;
  enabled: boolean;
  maintenance: boolean;
  readEnabled: boolean;
  writeEnabled: boolean;
  extractConfigured: boolean;
  extractModel: string;
  toolReady: boolean;
  jobs: MemoryQueueSummary;
  counts: MemoryLedgerCounts;
  searchMetrics: MemorySearchMetrics;
  providerRoutes: MemoryProviderRouteStats[];
  lastMaintenanceAt: number | null;
  extract: MemoryOperationSnapshot;
}

export interface MemoryProbeResult {
  target: 'memory.extract';
  ok: boolean;
  checkedAt: number;
  latencyMs: number | null;
  canonicalModel: string | null;
  schemaValid: boolean;
  error: string | null;
  snapshot: MemoryStatusSnapshot;
}

export interface MemoryStatusServiceLike {
  getSnapshot(): Promise<MemoryStatusSnapshot>;
  probeExtraction(): Promise<MemoryProbeResult>;
}

declare module 'koishi' {
  interface Tables {
    memory_v3_meta: MemoryV3MetaRecord;
    memory_v3_principal: MemoryV3PrincipalRecord;
    memory_v3_context: MemoryV3ContextRecord;
    memory_v3_event: MemoryV3EventRecord;
    memory_v3_payload: MemoryV3PayloadRecord;
    memory_v3_evidence: MemoryV3EvidenceRecord;
    memory_v3_head: MemoryV3HeadRecord;
    memory_v3_lexical_document: MemoryV3LexicalDocumentRecord;
    memory_v3_lexical_term: MemoryV3LexicalTermRecord;
    memory_v3_work: MemoryV3WorkRecord;
    memory_v3_cursor: MemoryV3CursorRecord;
    memory_v3_suppression: MemoryV3SuppressionRecord;
    memory_v3_audit: MemoryV3AuditRecord;
  }

  interface Context {
    memoryStatus?: MemoryStatusServiceLike;
  }
}
