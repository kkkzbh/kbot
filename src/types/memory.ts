import 'koishi';

export type MemoryChannelType = 'direct' | 'group';

export type MemoryVisibility =
  | 'global'
  | 'private_only'
  | 'source_context_only'
  | 'allowed_contexts'
  | 'denied_contexts'
  | 'pending_review'
  | 'archived';

export type MemoryScopeType =
  | 'owner_all_contexts'
  | 'dm_only'
  | 'source_context_only'
  | 'allowed_contexts'
  | 'denied_contexts'
  | 'pending_review'
  | 'archived';

export type MemorySensitivity = 'low' | 'personal' | 'sensitive' | 'secret';

export type MemoryProfileKind =
  | 'identity'
  | 'preference'
  | 'trait'
  | 'boundary'
  | 'plan'
  | 'relationship'
  | 'response_policy';

export type MemoryCandidateType = 'fact' | 'episode' | 'drop';
export type MemoryCandidateReviewStatus = 'pending' | 'approved' | 'rejected' | 'pending_review';
export type MemoryRecordType = 'fact' | 'episode';
export type MemoryCandidateSubject = 'target_user' | 'other_speaker' | 'group_shared' | 'assistant' | 'unknown';
export type MemoryAttributionStatus = 'verified' | 'rejected' | 'unknown';

export type MemoryJobType =
  | 'extract'
  | 'privacy_review'
  | 'consolidate'
  | 'embed'
  | 'reembed'
  | 'maintenance'
  | 'forget'
  | 'migration_backfill'
  | 'eval_probe';

export type MemoryJobStatus = 'pending' | 'processing' | 'done' | 'failed' | 'dead_letter';
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
  observedAt: number;
}

export interface MemoryUserRecord {
  id: number;
  userKey: string;
  platform: string;
  userId: string;
  qqNick?: string | null;
  avatarUrl?: string | null;
  profileUpdatedAt?: number | null;
  firstSeenAt: number;
  lastSeenAt: number;
  readEnabled: number;
  writeEnabled: number;
}

export interface MemoryContextRecord {
  id: number;
  contextKey: string;
  platform: string;
  botSelfId: string;
  channelType: MemoryChannelType;
  groupId: string | null;
  channelId: string | null;
  rawContextId: string | null;
  lastExtractedMessageId: string | null;
  lastExtractedAt: number | null;
  lastExtractedHash: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface MemoryExtractCursorRecord {
  id: number;
  ownerUserKey: string;
  contextKey: string;
  conversationId: string;
  lastExtractedMessageId: string | null;
  lastExtractedAt: number | null;
  firstSeenAt: number;
  updatedAt: number;
}

export interface MemoryCandidateRecord {
  id: number;
  batchId: string;
  candidateType: MemoryCandidateType;
  ownerUserKey: string;
  contextKey: string;
  conversationId: string;
  targetSpeakerId: string;
  targetSpeakerName: string | null;
  messageIds: string | null;
  evidenceMessageIds: string | null;
  evidenceSpeakerIds: string | null;
  attributionStatus: MemoryAttributionStatus;
  payload: string;
  reviewStatus: MemoryCandidateReviewStatus;
  sensitivity: MemorySensitivity;
  suggestedVisibility: MemoryVisibility;
  finalVisibility: MemoryVisibility | null;
  dropReason: string | null;
  providerRoute: MemoryOutputProtocolId;
  rawTextHash: string | null;
  createdAt: number;
  reviewedAt: number | null;
  consolidatedAt: number | null;
}

export interface MemoryFactRecord {
  id: number;
  ownerUserKey: string;
  kind: MemoryProfileKind;
  topicKey: string;
  content: string;
  keywords: string | null;
  importance: number;
  confidence: number;
  sensitivity: MemorySensitivity;
  visibility: MemoryVisibility;
  scopeType: MemoryScopeType | null;
  scopeKey: string | null;
  memoryKey: string | null;
  sourceKind: MemoryChannelType | null;
  sourceContextKey: string;
  targetSpeakerId: string | null;
  targetSpeakerName: string | null;
  evidenceMessageIds: string | null;
  evidenceSpeakerIds: string | null;
  attributionStatus: MemoryAttributionStatus;
  allowedContextKeys: string | null;
  deniedContextKeys: string | null;
  applicability: string | null;
  validFrom: number | null;
  validUntil: number | null;
  expiresAt: number | null;
  invalidatedAt: number | null;
  retrievalText: string | null;
  lastUsedReason: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  lastAccessedAt: number | null;
  embeddingModel: string | null;
  embedding: string | null;
  version: number;
  archived: number;
  supersedesId: number | null;
  conflictSetId: string | null;
}

export interface MemoryEpisodeRecord {
  id: number;
  ownerUserKey: string;
  title: string;
  summary: string;
  keywords: string | null;
  importance: number;
  confidence: number;
  sensitivity: MemorySensitivity;
  visibility: MemoryVisibility;
  scopeType: MemoryScopeType | null;
  scopeKey: string | null;
  memoryKey: string | null;
  sourceKind: MemoryChannelType | null;
  sourceContextKey: string;
  targetSpeakerId: string | null;
  targetSpeakerName: string | null;
  evidenceMessageIds: string | null;
  evidenceSpeakerIds: string | null;
  attributionStatus: MemoryAttributionStatus;
  allowedContextKeys: string | null;
  deniedContextKeys: string | null;
  applicability: string | null;
  periodStart: number | null;
  periodEnd: number | null;
  validFrom: number | null;
  validUntil: number | null;
  expiresAt: number | null;
  invalidatedAt: number | null;
  retrievalText: string | null;
  lastUsedReason: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  lastAccessedAt: number | null;
  embeddingModel: string | null;
  embedding: string | null;
  version: number;
  archived: number;
  supersedesId: number | null;
  conflictSetId: string | null;
}

export interface MemoryProfileRecord {
  id: number;
  ownerUserKey: string;
  profileKey: string;
  kind: MemoryProfileKind;
  content: string;
  valueJson: string | null;
  importance: number;
  confidence: number;
  sensitivity: MemorySensitivity;
  scopeType: MemoryScopeType;
  scopeKey: string | null;
  sourceContextKey: string;
  targetSpeakerId: string | null;
  targetSpeakerName: string | null;
  evidenceMessageIds: string | null;
  evidenceSpeakerIds: string | null;
  attributionStatus: MemoryAttributionStatus;
  allowedContextKeys: string | null;
  deniedContextKeys: string | null;
  validFrom: number | null;
  validUntil: number | null;
  expiresAt: number | null;
  firstSeenAt: number;
  lastSeenAt: number;
  lastAccessedAt: number | null;
  version: number;
  archived: number;
  supersedesId: number | null;
  conflictSetId: string | null;
}

export interface MemorySessionRecord {
  id: number;
  sessionKey: string;
  ownerUserKey: string;
  contextKey: string;
  channelType: MemoryChannelType;
  summary: string;
  workingStateJson: string | null;
  startedAt: number;
  updatedAt: number;
  expiresAt: number;
  archived: number;
}

export interface MemorySourceRecord {
  id: number;
  sourceId: string;
  ownerUserKey: string;
  contextKey: string;
  conversationId: string;
  targetSpeakerId: string;
  targetSpeakerName: string | null;
  messageIds: string;
  evidenceMessageIds: string;
  evidenceSpeakerIds: string;
  attributionStatus: MemoryAttributionStatus;
  roleWindowHash: string;
  excerpt: string | null;
  redactedExcerpt: string | null;
  createdAt: number;
}

export interface MemoryProvenanceRecord {
  id: number;
  ownerUserKey: string;
  contextKey: string;
  memoryType: MemoryRecordType;
  memoryId: number;
  candidateId: number | null;
  conversationId: string | null;
  messageIds: string | null;
  evidenceMessageIds: string | null;
  evidenceSpeakerIds: string | null;
  attributionStatus: MemoryAttributionStatus;
  source: string;
  createdAt: number;
}

export interface MemoryJobRecord {
  id: number;
  jobKey: string;
  jobType: MemoryJobType;
  status: MemoryJobStatus;
  payload: string;
  retryCount: number;
  nextRunAt: number;
  lockedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryAuditEventRecord {
  id: number;
  userKey: string | null;
  contextKey: string | null;
  eventType: string;
  memoryType: MemoryRecordType | null;
  memoryId: number | null;
  candidateId: number | null;
  turnId: string | null;
  detail: string | null;
  createdAt: number;
}

export interface MemoryTombstoneRecord {
  id: number;
  userKey: string;
  contextKey: string | null;
  memoryType: MemoryRecordType | 'candidate' | 'source' | 'topic';
  memoryId: number | null;
  topicKey: string | null;
  sourceMessageId: string | null;
  reason: string | null;
  createdAt: number;
}

export interface MemoryQueueSummary {
  extractPending: number;
  extractProcessing: number;
  privacyReviewPending: number;
  consolidatePending: number;
  embedPending: number;
  embedProcessing: number;
  deadLetter: number;
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

export interface MemoryStatusSnapshot {
  available: boolean;
  enabled: boolean;
  readEnabled: boolean;
  writeEnabled: boolean;
  extractConfigured: boolean;
  embedConfigured: boolean;
  extractModel: string;
  embedModel: string;
  jobs: MemoryQueueSummary;
  providerRoutes: MemoryProviderRouteStats[];
  lastMaintenanceAt: number | null;
  extract: MemoryOperationSnapshot;
  embed: MemoryOperationSnapshot;
}

export interface MemoryProbeResult {
  target: 'embedding' | 'extraction';
  ok: boolean;
  checkedAt: number;
  latencyMs: number | null;
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
    memory_user: MemoryUserRecord;
    memory_context: MemoryContextRecord;
    memory_extract_cursor: MemoryExtractCursorRecord;
    memory_candidate: MemoryCandidateRecord;
    memory_fact: MemoryFactRecord;
    memory_episode: MemoryEpisodeRecord;
    memory_profile: MemoryProfileRecord;
    memory_session: MemorySessionRecord;
    memory_source: MemorySourceRecord;
    memory_provenance: MemoryProvenanceRecord;
    memory_job: MemoryJobRecord;
    memory_audit_event: MemoryAuditEventRecord;
    memory_tombstone: MemoryTombstoneRecord;
  }

  interface Context {
    memoryStatus?: MemoryStatusServiceLike;
  }
}
