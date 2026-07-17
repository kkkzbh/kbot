import type {
  MemoryAddress,
  MemoryAuditEventRecord,
  MemoryChannelType,
  MemoryCandidateReviewStatus,
  MemoryCandidateRecord,
  MemoryEpisodeRecord,
  MemoryFactRecord,
  MemoryJobRecord,
  MemoryJobStatus,
  MemoryJobType,
  MemoryOutputProtocolId,
  MemoryProfileRecord,
  MemoryRecordType,
  MemoryScopeType,
  MemorySensitivity,
  MemoryTombstoneRecord,
  MemoryQueueSummary,
  MemoryVisibility,
} from '../../types/memory.js';
import { isMemoryVisibleInContext, type ExtractedMemoryCandidate, type PrivacyDecision } from './gates.js';
import {
  buildRetrievalText,
  deriveTopicKey,
  parseJsonArray,
  slugify,
  stringifyEmbedding,
  stringifyStringArray,
  toTimestamp,
  uniqueKeywords,
} from './format.js';
import {
  buildMemoryKey,
  buildSourceId,
  buildStoredMemoryKey,
  episodeTopicKey,
  isMemoryScopeType,
  resolveRecordScopeKey,
  resolveRecordScopeType,
  scopeKeyForType,
  scopeTypeFromVisibility,
  sourceKindFromContextKey,
  visibilityFromScopeType,
} from './scope.js';
import type { MemoryConversationTurn } from './providers/schemas.js';

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
}

export interface ExtractJobPayload {
  address: MemoryAddress;
  ownerUserKey: string;
  targetSpeakerId: string;
  targetSpeakerName: string | null;
  contextKey: string;
  conversationId: string;
  rangeStartAfterMessageId: string | null;
  latestAnchorMessageId: string;
  maxMessages: number;
}

export interface PrivacyReviewJobPayload {
  batchId: string;
  address: MemoryAddress;
}

export interface ConsolidateJobPayload {
  candidateId: number;
  address: MemoryAddress;
}

export interface EmbedJobPayload {
  recordType: MemoryRecordType;
  recordId: number;
}

export type MemoryJobPayload =
  | ExtractJobPayload
  | PrivacyReviewJobPayload
  | ConsolidateJobPayload
  | EmbedJobPayload
  | Record<string, unknown>;

export interface MemoryDatabaseLike {
  get(table: string, query: Record<string, unknown>): Promise<any[]>;
  set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<unknown>;
  upsert?: (table: string, rows: Record<string, unknown>[], keys?: string[]) => Promise<unknown>;
  create(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>>;
  remove(table: string, query: Record<string, unknown>): Promise<unknown>;
}

export interface MemoryUserProfilePatch {
  qqNick?: string | null;
  avatarUrl?: string | null;
  profileUpdatedAt?: number | null;
}

const logger = {
  warn: (...args: unknown[]) => {
    void args;
  },
};
const DAY_MS = 86_400_000;

export function extractPlainText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object' && 'text' in raw) {
    const text = (raw as { text?: unknown }).text;
    return typeof text === 'string' ? text.trim() : '';
  }
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
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

async function decodeStoredAdditionalKwargs(row: StoredMessageRecord): Promise<Record<string, unknown> | null> {
  if (hasStoredBinary(row.additional_kwargs_binary)) {
    try {
      const { decodeStoredMessageJson } = await import('../shared/stored-message.js');
      return parsePlainRecord(await decodeStoredMessageJson(row.additional_kwargs_binary));
    } catch (error) {
      logger.warn('failed to decode stored message additional kwargs for %s: %s', row.id, (error as Error).message);
      return null;
    }
  }
  return parsePlainRecord(row.additional_kwargs);
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function parsePayload<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parsePlainRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function parseAccessContextKeyList(raw: unknown): string[] | null {
  if (raw == null) return [];
  if (typeof raw !== 'string') return null;
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const values: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string') return null;
      const normalized = item.trim();
      if (normalized) values.push(normalized);
    }
    return values;
  } catch {
    return null;
  }
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

type ParsedSpeakerTag = {
  speakerId: string;
  speakerName: string | null;
  end: number;
};

const SPEAKER_TAG_PREFIX = /^\[speaker_id=([^\]\s]+)(?:\s+speaker_name=("(?:\\.|[^"\\])*"|[^\]\s]+))?\][ \t]*/;

function parseSpeakerNameToken(raw: string | undefined): string | null {
  const value = normalizeText(raw);
  if (!value) return null;
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return normalizeText(parsed) || null;
    } catch {
      return value.slice(1, -1).trim() || null;
    }
  }
  return value;
}

function parseSpeakerTag(text: string): ParsedSpeakerTag | null {
  const match = text.match(SPEAKER_TAG_PREFIX);
  const speakerId = normalizeText(match?.[1]);
  if (!speakerId) return null;
  return {
    speakerId,
    speakerName: parseSpeakerNameToken(match?.[2]),
    end: match?.[0]?.length ?? 0,
  };
}

function parseSpeakerFormat(additionalKwargs: unknown): { speakerId: string; speakerName: string | null } | null {
  const record = parsePlainRecord(additionalKwargs);
  const speakerFormat = parsePlainRecord(record?.qqbot_speaker_format);
  if (normalizeText(speakerFormat?.version) !== 'speaker_id_v1') return null;
  if (speakerFormat?.isDirect === true || speakerFormat?.preformatted === true) return null;
  const speakerId = normalizeText(speakerFormat?.speakerId);
  if (!speakerId) return null;
  return {
    speakerId,
    speakerName: normalizeText(speakerFormat?.speakerName) || null,
  };
}

function stripMatchingSpeakerTag(text: string, speakerId: string): string {
  const tag = parseSpeakerTag(text);
  if (!tag || tag.speakerId !== speakerId) return text;
  return text.slice(tag.end).trim();
}

function isJobStatus(value: unknown): value is MemoryJobStatus {
  return value === 'pending' || value === 'processing' || value === 'done' || value === 'failed' || value === 'dead_letter';
}

function toCandidatePayload(row: MemoryCandidateRecord): ExtractedMemoryCandidate | null {
  return parsePayload<ExtractedMemoryCandidate>(row.payload);
}

function candidateTopic(candidate: ExtractedMemoryCandidate): string | null {
  if (candidate.candidateType !== 'fact') return null;
  return deriveTopicKey({
    topicKey: candidate.topicKey,
    content: candidate.content ?? '',
    keywords: candidate.keywords,
  });
}

function buildEpisodeFingerprint(candidate: ExtractedMemoryCandidate): string {
  return slugify([candidate.title ?? '', ...(candidate.keywords ?? []).slice(0, 3)].join('-')) || 'episode';
}

function resolveCandidateVisibility(row: MemoryCandidateRecord): MemoryVisibility {
  return (row.finalVisibility ?? row.suggestedVisibility) as MemoryVisibility;
}

function resolveCandidateScope(row: MemoryCandidateRecord, candidate: ExtractedMemoryCandidate): {
  visibility: MemoryVisibility;
  scopeType: MemoryScopeType;
  scopeKey: string | null;
  sourceKind: MemoryChannelType;
} {
  const visibility = resolveCandidateVisibility(row);
  const scopeType = isMemoryScopeType(candidate.scopeType) ? candidate.scopeType : scopeTypeFromVisibility(visibility);
  return {
    visibility,
    scopeType,
    scopeKey: scopeKeyForType(scopeType, row.contextKey),
    sourceKind: sourceKindFromContextKey(row.contextKey),
  };
}

function isActiveTemporalRow(row: {
  archived?: number | null;
  validUntil?: number | null;
  expiresAt?: number | null;
  invalidatedAt?: number | null;
}, now = Date.now()): boolean {
  if (Number(row.archived ?? 0) === 1) return false;
  if (row.invalidatedAt != null && Number(row.invalidatedAt) <= now) return false;
  if (row.validUntil != null && Number(row.validUntil) < now) return false;
  if (row.expiresAt != null && Number(row.expiresAt) < now) return false;
  return true;
}

function keywordOverlap(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  let hits = 0;
  for (const item of new Set(left)) {
    if (rightSet.has(item)) hits += 1;
  }
  return hits / Math.max(new Set(left).size, rightSet.size, 1);
}

function evidenceIds(candidate: ExtractedMemoryCandidate): string[] {
  return uniqueKeywords(candidate.evidenceMessageIds ?? []);
}

function evidenceSpeakers(candidate: ExtractedMemoryCandidate): string[] {
  return uniqueKeywords(candidate.evidenceSpeakerIds ?? []);
}

function evaluateCandidateAttribution(
  candidate: ExtractedMemoryCandidate,
  turns: readonly MemoryConversationTurn[],
  targetSpeakerId: string,
): {
  status: 'verified' | 'rejected';
  reason: string | null;
  evidenceMessageIds: string[];
  evidenceSpeakerIds: string[];
} {
  if (candidate.candidateType === 'drop') {
    return {
      status: 'rejected',
      reason: candidate.dropReason ?? 'model_drop',
      evidenceMessageIds: evidenceIds(candidate),
      evidenceSpeakerIds: evidenceSpeakers(candidate),
    };
  }

  if (candidate.subject !== 'target_user') {
    return {
      status: 'rejected',
      reason: `ownership_subject_${candidate.subject}`,
      evidenceMessageIds: evidenceIds(candidate),
      evidenceSpeakerIds: evidenceSpeakers(candidate),
    };
  }

  if (normalizeText(candidate.ownerSpeakerId) !== targetSpeakerId) {
    return {
      status: 'rejected',
      reason: 'ownership_owner_mismatch',
      evidenceMessageIds: evidenceIds(candidate),
      evidenceSpeakerIds: evidenceSpeakers(candidate),
    };
  }

  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const ids = evidenceIds(candidate);
  if (!ids.length) {
    return {
      status: 'rejected',
      reason: 'ownership_missing_evidence',
      evidenceMessageIds: [],
      evidenceSpeakerIds: evidenceSpeakers(candidate),
    };
  }

  const actualSpeakerIds: string[] = [];
  for (const id of ids) {
    const turn = byId.get(id);
    if (!turn) {
      return {
        status: 'rejected',
        reason: 'ownership_evidence_not_in_window',
        evidenceMessageIds: ids,
        evidenceSpeakerIds: evidenceSpeakers(candidate),
      };
    }
    if (turn.role !== 'human' || !turn.isTarget || turn.speakerId !== targetSpeakerId) {
      return {
        status: 'rejected',
        reason: 'ownership_evidence_not_target',
        evidenceMessageIds: ids,
        evidenceSpeakerIds: uniqueKeywords(actualSpeakerIds),
      };
    }
    if (turn.attributionSource !== 'additional_kwargs' && turn.attributionSource !== 'direct_session') {
      return {
        status: 'rejected',
        reason: 'ownership_evidence_untrusted_speaker',
        evidenceMessageIds: ids,
        evidenceSpeakerIds: [turn.speakerId],
      };
    }
    actualSpeakerIds.push(turn.speakerId);
  }

  const declaredSpeakers = evidenceSpeakers(candidate);
  if (!declaredSpeakers.length || declaredSpeakers.some((speakerId) => speakerId !== targetSpeakerId)) {
    return {
      status: 'rejected',
      reason: 'ownership_evidence_speaker_mismatch',
      evidenceMessageIds: ids,
      evidenceSpeakerIds: declaredSpeakers,
    };
  }

  return {
    status: 'verified',
    reason: null,
    evidenceMessageIds: ids,
    evidenceSpeakerIds: uniqueKeywords(actualSpeakerIds),
  };
}

function jobKey(jobType: MemoryJobType, payload: MemoryJobPayload): string {
  if (jobType === 'extract') {
    const input = payload as ExtractJobPayload;
    return `extract:${input.contextKey}:${input.ownerUserKey}`;
  }
  if (jobType === 'privacy_review') {
    return `privacy_review:${(payload as PrivacyReviewJobPayload).batchId}`;
  }
  if (jobType === 'consolidate') {
    return `consolidate:${(payload as ConsolidateJobPayload).candidateId}`;
  }
  if (jobType === 'embed' || jobType === 'reembed') {
    const input = payload as EmbedJobPayload;
    return `${jobType}:${input.recordType}:${input.recordId}`;
  }
  return `${jobType}:${JSON.stringify(payload)}`;
}

export class MemoryStore {
  constructor(private readonly database: MemoryDatabaseLike) {}

  async upsertAddress(address: MemoryAddress, profile: MemoryUserProfilePatch | null = null): Promise<void> {
    const [user] = await this.database.get('memory_user', { userKey: address.userKey });
    const profilePatch: Record<string, unknown> = {};
    if (profile?.qqNick != null) profilePatch.qqNick = profile.qqNick;
    if (profile?.avatarUrl != null) profilePatch.avatarUrl = profile.avatarUrl;
    if (profile?.profileUpdatedAt != null) profilePatch.profileUpdatedAt = profile.profileUpdatedAt;
    if (user?.id) {
      await this.database.set('memory_user', { id: user.id }, { lastSeenAt: address.observedAt, ...profilePatch });
    } else {
      await this.database.create('memory_user', {
        userKey: address.userKey,
        platform: address.platform,
        userId: address.userId,
        qqNick: profile?.qqNick ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        profileUpdatedAt: profile?.profileUpdatedAt ?? null,
        firstSeenAt: address.observedAt,
        lastSeenAt: address.observedAt,
        readEnabled: 1,
        writeEnabled: 1,
      });
    }

    const [context] = await this.database.get('memory_context', { contextKey: address.contextKey });
    const contextRecord = {
      platform: address.platform,
      botSelfId: address.botSelfId,
      channelType: address.channelType,
      groupId: address.groupId ?? null,
      channelId: address.channelId ?? null,
      rawContextId: address.rawContextId ?? null,
      lastSeenAt: address.observedAt,
    };
    if (context?.id) {
      await this.database.set('memory_context', { id: context.id }, contextRecord);
    } else {
      await this.database.create('memory_context', {
        contextKey: address.contextKey,
        ...contextRecord,
        firstSeenAt: address.observedAt,
      });
    }
  }

  async getUserFlags(userKey: string): Promise<{ readEnabled: boolean; writeEnabled: boolean }> {
    const [row] = await this.database.get('memory_user', { userKey });
    return {
      readEnabled: row?.readEnabled == null ? true : Number(row.readEnabled) === 1,
      writeEnabled: row?.writeEnabled == null ? true : Number(row.writeEnabled) === 1,
    };
  }

  async setUserFlags(userKey: string, flags: {
    readEnabled?: boolean;
    writeEnabled?: boolean;
  }): Promise<void> {
    const patch: Record<string, number> = {};
    if (flags.readEnabled != null) patch.readEnabled = flags.readEnabled ? 1 : 0;
    if (flags.writeEnabled != null) patch.writeEnabled = flags.writeEnabled ? 1 : 0;
    if (!Object.keys(patch).length) return;

    const [row] = await this.database.get('memory_user', { userKey });
    if (row?.id) {
      await this.database.set('memory_user', { id: row.id }, { ...patch, lastSeenAt: Date.now() });
      return;
    }

    const [platform = 'unknown', , userId = userKey] = userKey.split(':');
    await this.database.create('memory_user', {
      userKey,
      platform,
      userId,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      readEnabled: flags.readEnabled == null ? 1 : patch.readEnabled,
      writeEnabled: flags.writeEnabled == null ? 1 : patch.writeEnabled,
    });
  }

  async getConversationLatestMessageId(conversationId: string): Promise<string | null> {
    const [conversation] = await this.database.get('chatluna_conversation', { id: conversationId }) as StoredConversationRecord[];
    return normalizeText(conversation?.latestMessageId) || null;
  }

  private async getExtractCursor(ownerUserKey: string, contextKey: string): Promise<string | null> {
    const [row] = await this.database.get('memory_extract_cursor', { ownerUserKey, contextKey });
    return normalizeText(row?.lastExtractedMessageId) || null;
  }

  async updateExtractCursor(payload: ExtractJobPayload): Promise<void> {
    const now = Date.now();
    const [row] = await this.database.get('memory_extract_cursor', {
      ownerUserKey: payload.ownerUserKey,
      contextKey: payload.contextKey,
    });
    const patch = {
      conversationId: payload.conversationId,
      lastExtractedMessageId: payload.latestAnchorMessageId,
      lastExtractedAt: now,
      updatedAt: now,
    };
    if (row?.id) {
      await this.database.set('memory_extract_cursor', { id: row.id }, patch);
      return;
    }
    await this.database.create('memory_extract_cursor', {
      ownerUserKey: payload.ownerUserKey,
      contextKey: payload.contextKey,
      firstSeenAt: now,
      ...patch,
    });
  }

  async queueExtractJob(input: {
    address: MemoryAddress;
    targetSpeakerId: string;
    targetSpeakerName: string | null;
    maxMessages: number;
    nextRunAt: number;
  }): Promise<boolean> {
    const latestAnchorMessageId = await this.getConversationLatestMessageId(input.address.conversationId);
    if (!latestAnchorMessageId) return false;
    const rangeStartAfterMessageId = await this.getExtractCursor(input.address.userKey, input.address.contextKey);
    if (rangeStartAfterMessageId === latestAnchorMessageId) return false;
    await this.queueJob(
      'extract',
      {
        address: input.address,
        ownerUserKey: input.address.userKey,
        targetSpeakerId: input.targetSpeakerId,
        targetSpeakerName: input.targetSpeakerName,
        contextKey: input.address.contextKey,
        conversationId: input.address.conversationId,
        rangeStartAfterMessageId,
        latestAnchorMessageId,
        maxMessages: input.maxMessages,
      },
      input.nextRunAt,
    );
    return true;
  }

  async queueJob(jobType: MemoryJobType, payload: MemoryJobPayload, nextRunAt = Date.now()): Promise<void> {
    const now = Date.now();
    const key = jobKey(jobType, payload);
    const [existing] = await this.database.get('memory_job', { jobKey: key, status: 'pending' });
    let nextPayload = payload;
    if (jobType === 'extract' && existing?.payload) {
      const previous = parsePayload<ExtractJobPayload>(String(existing.payload));
      const incoming = payload as ExtractJobPayload;
      nextPayload = {
        ...incoming,
        rangeStartAfterMessageId: previous?.rangeStartAfterMessageId ?? incoming.rangeStartAfterMessageId,
      };
    }
    const row = {
      jobType,
      status: 'pending',
      payload: serialize(nextPayload),
      nextRunAt,
      lockedAt: null,
      lastError: null,
      updatedAt: now,
    };
    if (existing?.id) {
      await this.database.set('memory_job', { id: existing.id }, row);
      return;
    }
    await this.database.create('memory_job', {
      jobKey: key,
      retryCount: 0,
      createdAt: now,
      ...row,
    });
  }

  async listDueJobs(jobType: MemoryJobType, now: number): Promise<MemoryJobRecord[]> {
    const rows = await this.database.get('memory_job', { jobType, status: 'pending' }) as MemoryJobRecord[];
    return rows.filter((row) => Number(row.nextRunAt ?? 0) <= now).sort((left, right) => left.nextRunAt - right.nextRunAt);
  }

  async markJobProcessing(job: MemoryJobRecord): Promise<void> {
    await this.database.set('memory_job', { id: job.id }, {
      status: 'processing',
      lockedAt: Date.now(),
      updatedAt: Date.now(),
      lastError: null,
    });
  }

  async completeJob(job: MemoryJobRecord): Promise<void> {
    await this.database.remove('memory_job', { id: job.id });
  }

  async retryJob(job: MemoryJobRecord, error: unknown, delayMs: number, maxRetries: number): Promise<void> {
    const retryCount = Number(job.retryCount ?? 0) + 1;
    const status: MemoryJobStatus = retryCount > maxRetries ? 'dead_letter' : 'pending';
    await this.database.set('memory_job', { id: job.id }, {
      status,
      retryCount,
      nextRunAt: Date.now() + delayMs * Math.max(1, retryCount),
      lockedAt: null,
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    });
  }

  async deadLetterJob(job: MemoryJobRecord, error: unknown): Promise<void> {
    await this.database.set('memory_job', { id: job.id }, {
      status: 'dead_letter',
      retryCount: Number(job.retryCount ?? 0) + 1,
      nextRunAt: Date.now(),
      lockedAt: null,
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    });
  }

  async requeueDeadLetterJob(id: number): Promise<boolean> {
    const [job] = await this.database.get('memory_job', { id, status: 'dead_letter' }) as MemoryJobRecord[];
    if (!job) return false;
    await this.database.set('memory_job', { id, status: 'dead_letter' }, {
      status: 'pending',
      retryCount: 0,
      nextRunAt: Date.now(),
      lockedAt: null,
      lastError: null,
      updatedAt: Date.now(),
    });
    return true;
  }

  async discardDeadLetterJob(id: number): Promise<boolean> {
    const [job] = await this.database.get('memory_job', { id, status: 'dead_letter' }) as MemoryJobRecord[];
    if (!job) return false;
    await this.database.remove('memory_job', { id, status: 'dead_letter' });
    return true;
  }

  async requeueStaleProcessingJobs(lockTimeoutMs: number): Promise<number> {
    const rows = await this.database.get('memory_job', { status: 'processing' }) as MemoryJobRecord[];
    const threshold = Date.now() - lockTimeoutMs;
    let count = 0;
    for (const row of rows) {
      if (Number(row.lockedAt ?? 0) > threshold) continue;
      await this.database.set('memory_job', { id: row.id }, {
        status: 'pending',
        lockedAt: null,
        nextRunAt: Date.now(),
        updatedAt: Date.now(),
      });
      count += 1;
    }
    return count;
  }

  async getJobSummary(): Promise<MemoryQueueSummary> {
    const rows = await this.database.get('memory_job', {} as Record<string, never>) as MemoryJobRecord[];
    return rows.reduce<MemoryQueueSummary>(
      (summary, row) => {
        if (row.status === 'dead_letter') summary.deadLetter += 1;
        if (row.jobType === 'extract' && row.status === 'pending') summary.extractPending += 1;
        if (row.jobType === 'extract' && row.status === 'processing') summary.extractProcessing += 1;
        if (row.jobType === 'privacy_review' && row.status === 'pending') summary.privacyReviewPending += 1;
        if (row.jobType === 'consolidate' && row.status === 'pending') summary.consolidatePending += 1;
        if ((row.jobType === 'embed' || row.jobType === 'reembed') && row.status === 'pending') summary.embedPending += 1;
        if ((row.jobType === 'embed' || row.jobType === 'reembed') && row.status === 'processing') summary.embedProcessing += 1;
        return summary;
      },
      {
        extractPending: 0,
        extractProcessing: 0,
        privacyReviewPending: 0,
        consolidatePending: 0,
        embedPending: 0,
        embedProcessing: 0,
        deadLetter: 0,
      },
    );
  }

  parseJobPayload<T>(job: MemoryJobRecord): T | null {
    if (!isJobStatus(job.status)) return null;
    return parsePayload<T>(job.payload);
  }

  private buildTurnSpeaker(
    row: StoredMessageRecord,
    text: string,
    additionalKwargs: Record<string, unknown> | null,
    payload: ExtractJobPayload,
  ): {
    text: string;
    speakerId: string | null;
    speakerName: string | null;
    ownerUserKey: string | null;
    isTarget: boolean;
    attributionSource: MemoryConversationTurn['attributionSource'];
  } {
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
        ownerUserKey: payload.ownerUserKey,
        isTarget: true,
        attributionSource: 'direct_session',
      };
    }

    const speakerFormat = parseSpeakerFormat(additionalKwargs);
    if (speakerFormat) {
      const ownerUserKey = `${payload.address.platform}:user:${speakerFormat.speakerId}`;
      return {
        text: stripMatchingSpeakerTag(text, speakerFormat.speakerId),
        speakerId: speakerFormat.speakerId,
        speakerName: speakerFormat.speakerName ?? (normalizeText(row.name) || null),
        ownerUserKey,
        isTarget: ownerUserKey === payload.ownerUserKey && speakerFormat.speakerId === payload.targetSpeakerId,
        attributionSource: 'additional_kwargs',
      };
    }

    const speakerTag = parseSpeakerTag(text);
    const speakerId = speakerTag?.speakerId ?? null;
    if (!speakerId) {
      return {
        text,
        speakerId: null,
        speakerName: null,
        ownerUserKey: null,
        isTarget: false,
        attributionSource: 'unknown',
      };
    }

    const ownerUserKey = `${payload.address.platform}:user:${speakerId}`;
    return {
      text: speakerTag ? text.slice(speakerTag.end).trim() : text,
      speakerId,
      speakerName: speakerTag?.speakerName ?? (normalizeText(row.name) || null),
      ownerUserKey,
      isTarget: ownerUserKey === payload.ownerUserKey && speakerId === payload.targetSpeakerId,
      attributionSource: 'speaker_tag',
    };
  }

  async readConversationWindow(payload: ExtractJobPayload): Promise<MemoryConversationTurn[]> {
    if (!payload.conversationId || !payload.latestAnchorMessageId) return [];
    const rows = await this.database.get('chatluna_message', { conversationId: payload.conversationId }) as StoredMessageRecord[];
    const messageMap = new Map(rows.map((row) => [row.id, row]));
    const window: MemoryConversationTurn[] = [];
    const maxMessages = Math.max(1, Number(payload.maxMessages ?? 1));
    const maxScan = Math.max(maxMessages * 4, maxMessages);
    let scanned = 0;
    let cursor: string | null | undefined = payload.latestAnchorMessageId;
    while (cursor && scanned < maxScan) {
      if (cursor === payload.rangeStartAfterMessageId) break;
      scanned += 1;
      const row = messageMap.get(cursor);
      if (!row) break;
      if (row.role === 'human' || row.role === 'ai') {
        try {
          const text = await decodeStoredMessageText(row.content);
          if (text) {
            const additionalKwargs = await decodeStoredAdditionalKwargs(row);
            const speaker = this.buildTurnSpeaker(row, text, additionalKwargs, payload);
            window.push({
              id: row.id,
              role: row.role,
              text: speaker.text,
              speakerId: speaker.speakerId,
              speakerName: speaker.speakerName,
              ownerUserKey: speaker.ownerUserKey,
              isTarget: speaker.isTarget,
              attributionSource: speaker.attributionSource,
            });
          }
        } catch (error) {
          logger.warn('failed to decode stored message content for %s: %s', row.id, (error as Error).message);
        }
      }
      cursor = row.parentId ?? null;
    }
    return window.reverse().slice(-maxMessages);
  }

  async filterTombstonedTurns(userKey: string, turns: MemoryConversationTurn[]): Promise<MemoryConversationTurn[]> {
    const tombstones = await this.database.get('memory_tombstone', { userKey }) as MemoryTombstoneRecord[];
    const sourceIds = new Set(
      tombstones
        .filter((row) => row.memoryType === 'source' && row.sourceMessageId)
        .map((row) => row.sourceMessageId as string),
    );
    return turns.filter((turn) => !sourceIds.has(turn.id));
  }

  async writeCandidateBatch(input: {
    address: MemoryAddress;
    payload: ExtractJobPayload;
    batchId: string;
    candidates: ExtractedMemoryCandidate[];
    turns: MemoryConversationTurn[];
    messageIds: string[];
    providerRoute: MemoryOutputProtocolId;
    rawTextHash: string | null;
  }): Promise<number> {
    const messageIds = stringifyStringArray(input.messageIds);
    const attributionByCandidate = input.candidates.map((candidate) => evaluateCandidateAttribution(
      candidate,
      input.turns,
      input.payload.targetSpeakerId,
    ));
    const allEvidenceMessageIds = uniqueKeywords(attributionByCandidate.flatMap((item) => item.evidenceMessageIds));
    const allEvidenceSpeakerIds = uniqueKeywords(attributionByCandidate.flatMap((item) => item.evidenceSpeakerIds));
    await this.upsertMemorySource({
      address: input.address,
      payload: input.payload,
      messageIds: input.messageIds,
      evidenceMessageIds: allEvidenceMessageIds,
      evidenceSpeakerIds: allEvidenceSpeakerIds,
      rawTextHash: input.rawTextHash,
    });
    let pendingCount = 0;
    for (let index = 0; index < input.candidates.length; index += 1) {
      const candidate = input.candidates[index]!;
      const attribution = attributionByCandidate[index]!;
      const reviewStatus: MemoryCandidateReviewStatus = attribution.status === 'verified' ? 'pending' : 'rejected';
      if (reviewStatus === 'pending') pendingCount += 1;
      await this.database.create('memory_candidate', {
        batchId: input.batchId,
        candidateType: candidate.candidateType,
        ownerUserKey: input.payload.ownerUserKey,
        contextKey: input.address.contextKey,
        conversationId: input.address.conversationId,
        targetSpeakerId: input.payload.targetSpeakerId,
        targetSpeakerName: input.payload.targetSpeakerName,
        messageIds,
        evidenceMessageIds: stringifyStringArray(attribution.evidenceMessageIds),
        evidenceSpeakerIds: stringifyStringArray(attribution.evidenceSpeakerIds),
        attributionStatus: attribution.status,
        payload: serialize(candidate),
        reviewStatus,
        sensitivity: candidate.sensitivity,
        suggestedVisibility: candidate.suggestedVisibility,
        finalVisibility: null,
        dropReason: attribution.reason ?? candidate.dropReason ?? null,
        providerRoute: input.providerRoute,
        rawTextHash: input.rawTextHash,
        createdAt: Date.now(),
        reviewedAt: reviewStatus === 'rejected' ? Date.now() : null,
        consolidatedAt: reviewStatus === 'rejected' ? Date.now() : null,
      });
    }
    await this.audit({
      userKey: input.address.userKey,
      contextKey: input.address.contextKey,
      eventType: 'extract_candidates_written',
      turnId: input.address.conversationId,
      detail: {
        batchId: input.batchId,
        count: input.candidates.length,
        providerRoute: input.providerRoute,
        pendingCount,
      },
    });
    return pendingCount;
  }

  private async upsertMemorySource(input: {
    address: MemoryAddress;
    payload: ExtractJobPayload;
    messageIds: string[];
    evidenceMessageIds: string[];
    evidenceSpeakerIds: string[];
    rawTextHash: string | null;
  }): Promise<void> {
    const sourceId = buildSourceId({
      userKey: input.payload.ownerUserKey,
      contextKey: input.address.contextKey,
      conversationId: input.address.conversationId,
      messageIds: input.messageIds,
    });
    const [existing] = await this.database.get('memory_source', { sourceId });
    if (existing?.id) return;
    await this.database.create('memory_source', {
      sourceId,
      ownerUserKey: input.payload.ownerUserKey,
      contextKey: input.address.contextKey,
      conversationId: input.address.conversationId,
      targetSpeakerId: input.payload.targetSpeakerId,
      targetSpeakerName: input.payload.targetSpeakerName,
      messageIds: stringifyStringArray(input.messageIds) ?? '[]',
      evidenceMessageIds: stringifyStringArray(input.evidenceMessageIds) ?? '[]',
      evidenceSpeakerIds: stringifyStringArray(input.evidenceSpeakerIds) ?? '[]',
      attributionStatus: input.evidenceMessageIds.length ? 'verified' : 'unknown',
      roleWindowHash: input.rawTextHash ?? sourceId,
      excerpt: null,
      redactedExcerpt: null,
      createdAt: Date.now(),
    });
  }

  async listBatchCandidates(batchId: string): Promise<MemoryCandidateRecord[]> {
    return await this.database.get('memory_candidate', { batchId }) as MemoryCandidateRecord[];
  }

  async getCandidateById(candidateId: number): Promise<MemoryCandidateRecord | null> {
    const [row] = await this.database.get('memory_candidate', { id: candidateId }) as MemoryCandidateRecord[];
    return row ?? null;
  }

  async applyPrivacyDecision(row: MemoryCandidateRecord, decision: PrivacyDecision): Promise<void> {
    await this.database.set('memory_candidate', { id: row.id }, {
      reviewStatus: decision.status,
      sensitivity: decision.sensitivity,
      finalVisibility: decision.visibility,
      dropReason: decision.reason,
      reviewedAt: Date.now(),
    });
    await this.audit({
      userKey: row.ownerUserKey,
      contextKey: row.contextKey,
      eventType: 'privacy_review',
      candidateId: row.id,
      detail: decision,
    });
  }

  async queueApprovedConsolidation(row: MemoryCandidateRecord, address: MemoryAddress): Promise<void> {
    if (row.reviewStatus !== 'approved') return;
    await this.queueJob('consolidate', { candidateId: row.id, address });
  }

  private async isTopicTombstoned(userKey: string, contextKey: string, topicKey: string | null): Promise<boolean> {
    if (!topicKey) return false;
    const rows = await this.database.get('memory_tombstone', { userKey }) as MemoryTombstoneRecord[];
    return rows.some((row) => {
      if (row.memoryType !== 'topic' && row.memoryType !== 'fact') return false;
      if (row.topicKey !== topicKey) return false;
      return !row.contextKey || row.contextKey === contextKey;
    });
  }

  private async isCandidateSourceTombstoned(row: MemoryCandidateRecord): Promise<boolean> {
    const tombstones = await this.database.get('memory_tombstone', { userKey: row.ownerUserKey }) as MemoryTombstoneRecord[];
    const tombstonedSources = new Set(
      tombstones
        .filter((item) => item.memoryType === 'source' && item.sourceMessageId)
        .map((item) => item.sourceMessageId as string),
    );
    return parseJsonArray(row.messageIds).some((id) => tombstonedSources.has(id));
  }

  async consolidateCandidate(row: MemoryCandidateRecord, address: MemoryAddress): Promise<{ type: MemoryRecordType; id: number } | null> {
    if (row.reviewStatus !== 'approved' || row.consolidatedAt != null) return null;
    if (row.attributionStatus !== 'verified') {
      await this.database.set('memory_candidate', { id: row.id }, {
        reviewStatus: 'rejected',
        dropReason: row.dropReason ?? 'ownership_guard',
        consolidatedAt: Date.now(),
      });
      return null;
    }
    if (await this.isCandidateSourceTombstoned(row)) {
      await this.database.set('memory_candidate', { id: row.id }, {
        reviewStatus: 'rejected',
        dropReason: 'source_tombstoned',
        consolidatedAt: Date.now(),
      });
      return null;
    }
    const candidate = toCandidatePayload(row);
    if (!candidate || candidate.candidateType === 'drop') {
      await this.database.set('memory_candidate', { id: row.id }, { consolidatedAt: Date.now() });
      return null;
    }

    if (candidate.candidateType === 'fact') {
      const topicKey = candidateTopic(candidate);
      if (!topicKey || await this.isTopicTombstoned(row.ownerUserKey, row.contextKey, topicKey)) {
        await this.database.set('memory_candidate', { id: row.id }, {
          reviewStatus: 'rejected',
          dropReason: 'topic_tombstoned',
          consolidatedAt: Date.now(),
        });
        return null;
      }
      const result = await this.upsertFact(row, candidate, topicKey);
      await this.database.set('memory_candidate', { id: row.id }, { consolidatedAt: Date.now() });
      await this.createProvenance(row, 'fact', result.id);
      await this.upsertProfileFromFactId(result.id);
      await this.queueJob('embed', { recordType: 'fact', recordId: result.id });
      await this.audit({
        userKey: row.ownerUserKey,
        contextKey: row.contextKey,
        eventType: result.created ? 'fact_created' : 'fact_updated',
        memoryType: 'fact',
        memoryId: result.id,
        candidateId: row.id,
        turnId: address.conversationId,
      });
      return { type: 'fact', id: result.id };
    }

    const result = await this.upsertEpisode(row, candidate);
    await this.database.set('memory_candidate', { id: row.id }, { consolidatedAt: Date.now() });
    await this.createProvenance(row, 'episode', result.id);
    await this.queueJob('embed', { recordType: 'episode', recordId: result.id });
    await this.audit({
      userKey: row.ownerUserKey,
      contextKey: row.contextKey,
      eventType: result.created ? 'episode_created' : 'episode_updated',
      memoryType: 'episode',
      memoryId: result.id,
      candidateId: row.id,
      turnId: address.conversationId,
    });
    return { type: 'episode', id: result.id };
  }

  private async upsertFact(
    row: MemoryCandidateRecord,
    candidate: ExtractedMemoryCandidate,
    topicKey: string,
  ): Promise<{ id: number; created: boolean }> {
    const now = Date.now();
    const kind = candidate.kind ?? 'preference';
    const scope = resolveCandidateScope(row, candidate);
    const memoryKey = buildMemoryKey({
      userKey: row.ownerUserKey,
      layer: 'fact',
      kind,
      topicKey,
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
    });
    const [exactExisting] = await this.database.get('memory_fact', { memoryKey, archived: 0 }) as MemoryFactRecord[];
    const legacyRows = exactExisting?.id
      ? []
      : await this.database.get('memory_fact', { ownerUserKey: row.ownerUserKey, kind, topicKey, archived: 0 }) as MemoryFactRecord[];
    const existing = exactExisting?.id
      ? exactExisting
      : legacyRows.find((item) => {
        if (!isActiveTemporalRow(item, now)) return false;
        const key = item.memoryKey || buildStoredMemoryKey('fact', item);
        return key === memoryKey;
      }) ?? null;
    const keywords = uniqueKeywords([
      ...parseJsonArray(existing?.keywords),
      ...candidate.keywords,
    ]);
    const patch = {
      kind,
      topicKey,
      content: candidate.content?.trim() ?? '',
      keywords: stringifyStringArray(keywords),
      importance: Math.max(Number(existing?.importance ?? 0), Number(candidate.importance ?? 0.6)),
      confidence: Math.max(Number(existing?.confidence ?? 0), Number(candidate.confidence ?? 0.8)),
      sensitivity: row.sensitivity,
      visibility: scope.visibility,
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
      memoryKey,
      sourceKind: scope.sourceKind,
      sourceContextKey: row.contextKey,
      targetSpeakerId: row.targetSpeakerId,
      targetSpeakerName: row.targetSpeakerName,
      evidenceMessageIds: row.evidenceMessageIds,
      evidenceSpeakerIds: row.evidenceSpeakerIds,
      attributionStatus: row.attributionStatus,
      allowedContextKeys: null,
      deniedContextKeys: null,
      applicability: candidate.applicability ?? null,
      validFrom: toTimestamp(candidate.validFrom),
      validUntil: toTimestamp(candidate.validUntil),
      expiresAt: toTimestamp(candidate.expiresAt),
      invalidatedAt: null,
      retrievalText: `${kind}:${topicKey}\n${candidate.content?.trim() ?? ''}`.trim(),
      lastUsedReason: null,
      lastSeenAt: now,
      lastAccessedAt: existing?.lastAccessedAt ?? null,
      embeddingModel: null,
      embedding: null,
      version: Number(existing?.version ?? 0) + 1,
      archived: 0,
      supersedesId: existing?.supersedesId ?? null,
      conflictSetId: candidate.conflictHint ? slugify(candidate.conflictHint) : existing?.conflictSetId ?? null,
    };
    if (existing?.id) {
      await this.database.set('memory_fact', { id: existing.id }, patch);
      return { id: existing.id, created: false };
    }
    const created = await this.database.create('memory_fact', {
      ownerUserKey: row.ownerUserKey,
      firstSeenAt: now,
      ...patch,
    }) as unknown as MemoryFactRecord;
    return { id: Number(created.id), created: true };
  }

  private async upsertEpisode(
    row: MemoryCandidateRecord,
    candidate: ExtractedMemoryCandidate,
  ): Promise<{ id: number; created: boolean }> {
    const now = Date.now();
    const scope = resolveCandidateScope(row, candidate);
    const incomingKeywords = uniqueKeywords(candidate.keywords);
    const incomingFingerprint = buildEpisodeFingerprint(candidate);
    const memoryKey = buildMemoryKey({
      userKey: row.ownerUserKey,
      layer: 'episode',
      kind: 'episode',
      topicKey: incomingFingerprint,
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
    });
    const [exactExisting] = await this.database.get('memory_episode', { memoryKey, archived: 0 }) as MemoryEpisodeRecord[];
    const existingRows = exactExisting?.id
      ? []
      : await this.database.get('memory_episode', { ownerUserKey: row.ownerUserKey, archived: 0 }) as MemoryEpisodeRecord[];
    const existing = exactExisting?.id ? exactExisting : existingRows.find((episode) => {
      if (!isActiveTemporalRow(episode, now)) return false;
      const existingScopeType = resolveRecordScopeType(episode);
      const existingScopeKey = resolveRecordScopeKey(episode);
      if (existingScopeType !== scope.scopeType || existingScopeKey !== scope.scopeKey) return false;
      const existingFingerprint = slugify([episode.title, ...parseJsonArray(episode.keywords).slice(0, 3)].join('-')) || 'episode';
      return existingFingerprint === incomingFingerprint || keywordOverlap(parseJsonArray(episode.keywords), incomingKeywords) >= 0.6;
    }) ?? null;
    const keywords = uniqueKeywords([
      ...parseJsonArray(existing?.keywords),
      ...incomingKeywords,
    ]);
    const patch = {
      title: candidate.title?.trim() ?? '',
      summary: candidate.summary?.trim() ?? '',
      keywords: stringifyStringArray(keywords),
      importance: Math.max(Number(existing?.importance ?? 0), Number(candidate.importance ?? 0.62)),
      confidence: Math.max(Number(existing?.confidence ?? 0), Number(candidate.confidence ?? 0.8)),
      sensitivity: row.sensitivity,
      visibility: scope.visibility,
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
      memoryKey,
      sourceKind: scope.sourceKind,
      sourceContextKey: row.contextKey,
      targetSpeakerId: row.targetSpeakerId,
      targetSpeakerName: row.targetSpeakerName,
      evidenceMessageIds: row.evidenceMessageIds,
      evidenceSpeakerIds: row.evidenceSpeakerIds,
      attributionStatus: row.attributionStatus,
      allowedContextKeys: null,
      deniedContextKeys: null,
      applicability: candidate.applicability ?? null,
      periodStart: toTimestamp(candidate.periodStart) ?? existing?.periodStart ?? null,
      periodEnd: toTimestamp(candidate.periodEnd) ?? existing?.periodEnd ?? null,
      validFrom: toTimestamp(candidate.validFrom),
      validUntil: toTimestamp(candidate.validUntil),
      expiresAt: toTimestamp(candidate.expiresAt),
      invalidatedAt: null,
      retrievalText: `${candidate.title?.trim() ?? ''}\n${candidate.summary?.trim() ?? ''}`.trim(),
      lastUsedReason: null,
      lastSeenAt: now,
      lastAccessedAt: existing?.lastAccessedAt ?? null,
      embeddingModel: null,
      embedding: null,
      version: Number(existing?.version ?? 0) + 1,
      archived: 0,
      supersedesId: existing?.supersedesId ?? null,
      conflictSetId: candidate.conflictHint ? slugify(candidate.conflictHint) : existing?.conflictSetId ?? null,
    };
    if (existing?.id) {
      await this.database.set('memory_episode', { id: existing.id }, patch);
      return { id: existing.id, created: false };
    }
    const created = await this.database.create('memory_episode', {
      ownerUserKey: row.ownerUserKey,
      firstSeenAt: now,
      ...patch,
    }) as unknown as MemoryEpisodeRecord;
    return { id: Number(created.id), created: true };
  }

  private async createProvenance(row: MemoryCandidateRecord, memoryType: MemoryRecordType, memoryId: number): Promise<void> {
    await this.database.create('memory_provenance', {
      ownerUserKey: row.ownerUserKey,
      contextKey: row.contextKey,
      memoryType,
      memoryId,
      candidateId: row.id,
      conversationId: row.conversationId,
      messageIds: row.messageIds,
      evidenceMessageIds: row.evidenceMessageIds,
      evidenceSpeakerIds: row.evidenceSpeakerIds,
      attributionStatus: row.attributionStatus,
      source: 'qqbot_memory',
      createdAt: Date.now(),
    });
  }

  private async upsertProfileFromFactId(factId: number): Promise<void> {
    const [fact] = await this.database.get('memory_fact', { id: factId }) as MemoryFactRecord[];
    if (!fact?.id || !isActiveTemporalRow(fact)) return;
    if (Number(fact.importance ?? 0) < 0.72 || Number(fact.confidence ?? 0) < 0.72) return;
    if (!fact.content?.trim()) return;

    const scopeType = resolveRecordScopeType(fact);
    if (scopeType === 'pending_review' || scopeType === 'archived') return;
    const scopeKey = resolveRecordScopeKey(fact);
    const profileKey = fact.topicKey;
    const [existing] = await this.database.get('memory_profile', {
      ownerUserKey: fact.ownerUserKey,
      kind: fact.kind,
      profileKey,
      scopeType,
      scopeKey,
      archived: 0,
    }) as MemoryProfileRecord[];
    const now = Date.now();
    const patch = {
      profileKey,
      kind: fact.kind,
      content: fact.content.trim(),
      valueJson: serialize({ sourceMemoryType: 'fact', sourceMemoryId: fact.id }),
      importance: Number(fact.importance ?? 0),
      confidence: Number(fact.confidence ?? 0),
      sensitivity: fact.sensitivity,
      scopeType,
      scopeKey,
      sourceContextKey: fact.sourceContextKey,
      targetSpeakerId: fact.targetSpeakerId,
      targetSpeakerName: fact.targetSpeakerName,
      evidenceMessageIds: fact.evidenceMessageIds,
      evidenceSpeakerIds: fact.evidenceSpeakerIds,
      attributionStatus: fact.attributionStatus,
      allowedContextKeys: fact.allowedContextKeys,
      deniedContextKeys: fact.deniedContextKeys,
      validFrom: fact.validFrom,
      validUntil: fact.validUntil,
      expiresAt: fact.expiresAt,
      lastSeenAt: now,
      lastAccessedAt: existing?.lastAccessedAt ?? null,
      version: Number(existing?.version ?? 0) + 1,
      archived: 0,
      supersedesId: existing?.supersedesId ?? null,
      conflictSetId: fact.conflictSetId ?? existing?.conflictSetId ?? null,
    };
    if (existing?.id) {
      await this.database.set('memory_profile', { id: existing.id }, patch);
      return;
    }
    await this.database.create('memory_profile', {
      ownerUserKey: fact.ownerUserKey,
      firstSeenAt: now,
      ...patch,
    });
  }

  async resolveEmbedJob(job: MemoryJobRecord): Promise<{ payload: EmbedJobPayload; text: string } | null> {
    const payload = this.parseJobPayload<EmbedJobPayload>(job);
    if (!payload || (payload.recordType !== 'fact' && payload.recordType !== 'episode') || !payload.recordId) return null;
    if (payload.recordType === 'fact') {
      const [row] = await this.database.get('memory_fact', { id: payload.recordId }) as MemoryFactRecord[];
      if (!row?.id || row.archived === 1) return null;
      return { payload, text: row.retrievalText?.trim() || buildRetrievalText('fact', row) };
    }
    const [row] = await this.database.get('memory_episode', { id: payload.recordId }) as MemoryEpisodeRecord[];
    if (!row?.id || row.archived === 1) return null;
    return { payload, text: row.retrievalText?.trim() || buildRetrievalText('episode', row) };
  }

  async applyEmbedding(payload: EmbedJobPayload, model: string, embedding: number[]): Promise<void> {
    const table = payload.recordType === 'fact' ? 'memory_fact' : 'memory_episode';
    await this.database.set(table, { id: payload.recordId }, {
      embeddingModel: model,
      embedding: stringifyEmbedding(embedding),
    });
  }

  async listFactsForUser(userKey: string): Promise<MemoryFactRecord[]> {
    return await this.database.get('memory_fact', { ownerUserKey: userKey, archived: 0 }) as MemoryFactRecord[];
  }

  async listEpisodesForUser(userKey: string): Promise<MemoryEpisodeRecord[]> {
    return await this.database.get('memory_episode', { ownerUserKey: userKey, archived: 0 }) as MemoryEpisodeRecord[];
  }

  async listProfilesForUser(userKey: string): Promise<MemoryProfileRecord[]> {
    return await this.database.get('memory_profile', { ownerUserKey: userKey, archived: 0 }) as MemoryProfileRecord[];
  }

  private dedupeRowsById<T extends { id: number }>(rows: T[]): T[] {
    const byId = new Map<number, T>();
    for (const row of rows) byId.set(row.id, row);
    return [...byId.values()];
  }

  private async listScopedRows<T extends {
    id: number;
    ownerUserKey: string;
    visibility: MemoryVisibility;
    scopeType?: MemoryScopeType | string | null;
    scopeKey?: string | null;
    sensitivity: MemorySensitivity;
    archived: number;
    sourceContextKey: string;
    allowedContextKeys: string | null;
    deniedContextKeys: string | null;
    validUntil?: number | null;
    expiresAt?: number | null;
    invalidatedAt?: number | null;
  }>(
    table: string,
    address: MemoryAddress,
    now: number,
  ): Promise<T[]> {
    const scopedQueries: Record<string, unknown>[] = [
      { ownerUserKey: address.userKey, archived: 0, scopeType: 'owner_all_contexts' },
      { ownerUserKey: address.userKey, archived: 0, scopeType: 'source_context_only', scopeKey: address.contextKey },
      { ownerUserKey: address.userKey, archived: 0, scopeType: 'allowed_contexts' },
      { ownerUserKey: address.userKey, archived: 0, scopeType: 'denied_contexts' },
    ];
    if (address.channelType === 'direct') {
      scopedQueries.push({ ownerUserKey: address.userKey, archived: 0, scopeType: 'dm_only' });
    }

    const scopedRows = (await Promise.all(scopedQueries.map((query) => this.database.get(table, query) as Promise<T[]>))).flat();
    return this.dedupeRowsById(scopedRows).filter((row) => {
      const scopeType = resolveRecordScopeType(row);
      const allowedContextKeys = parseAccessContextKeyList(row.allowedContextKeys);
      const deniedContextKeys = parseAccessContextKeyList(row.deniedContextKeys);
      if (scopeType === 'allowed_contexts' && allowedContextKeys == null) return false;
      if (scopeType === 'denied_contexts' && deniedContextKeys == null) return false;

      return isMemoryVisibleInContext({
        visibility: row.visibility,
        scopeType: row.scopeType,
        scopeKey: row.scopeKey ?? null,
        sensitivity: row.sensitivity,
        archived: row.archived,
        sourceContextKey: row.sourceContextKey,
        allowedContextKeys: allowedContextKeys ?? [],
        deniedContextKeys: deniedContextKeys ?? [],
        address,
        now,
        validUntil: row.validUntil ?? null,
        expiresAt: row.expiresAt ?? null,
        invalidatedAt: row.invalidatedAt ?? null,
      });
    });
  }

  async listFactsForContext(address: MemoryAddress, now = Date.now()): Promise<MemoryFactRecord[]> {
    return this.listScopedRows<MemoryFactRecord>('memory_fact', address, now);
  }

  async listEpisodesForContext(address: MemoryAddress, now = Date.now()): Promise<MemoryEpisodeRecord[]> {
    return this.listScopedRows<MemoryEpisodeRecord>('memory_episode', address, now);
  }

  async listProfilesForContext(address: MemoryAddress, now = Date.now()): Promise<MemoryProfileRecord[]> {
    const scopedQueries: Record<string, unknown>[] = [
      { ownerUserKey: address.userKey, archived: 0, scopeType: 'owner_all_contexts' },
      { ownerUserKey: address.userKey, archived: 0, scopeType: 'source_context_only', scopeKey: address.contextKey },
      { ownerUserKey: address.userKey, archived: 0, scopeType: 'allowed_contexts' },
      { ownerUserKey: address.userKey, archived: 0, scopeType: 'denied_contexts' },
    ];
    if (address.channelType === 'direct') {
      scopedQueries.push({ ownerUserKey: address.userKey, archived: 0, scopeType: 'dm_only' });
    }
    const rows = (await Promise.all(scopedQueries.map((query) => this.database.get('memory_profile', query) as Promise<MemoryProfileRecord[]>))).flat();
    return this.dedupeRowsById(rows).filter((row) => {
      if (Number(row.importance ?? 0) < 0.72 || Number(row.confidence ?? 0) < 0.72) return false;
      const scopeType = isMemoryScopeType(row.scopeType) ? row.scopeType : 'pending_review';
      const allowedContextKeys = parseAccessContextKeyList(row.allowedContextKeys);
      const deniedContextKeys = parseAccessContextKeyList(row.deniedContextKeys);
      if (scopeType === 'allowed_contexts' && allowedContextKeys == null) return false;
      if (scopeType === 'denied_contexts' && deniedContextKeys == null) return false;

      return isMemoryVisibleInContext({
        visibility: visibilityFromScopeType(scopeType),
        scopeType,
        scopeKey: row.scopeKey,
        sensitivity: row.sensitivity,
        archived: row.archived,
        sourceContextKey: row.sourceContextKey,
        allowedContextKeys: allowedContextKeys ?? [],
        deniedContextKeys: deniedContextKeys ?? [],
        address,
        now,
        validUntil: row.validUntil,
        expiresAt: row.expiresAt,
      });
    });
  }

  async touchMemory(type: MemoryRecordType, ids: readonly number[]): Promise<void> {
    const table = type === 'fact' ? 'memory_fact' : 'memory_episode';
    for (const id of ids) {
      await this.database.set(table, { id }, { lastAccessedAt: Date.now() });
    }
  }

  async touchProfiles(ids: readonly number[]): Promise<void> {
    for (const id of ids) {
      await this.database.set('memory_profile', { id }, { lastAccessedAt: Date.now() });
    }
  }

  async archiveExpired(now = Date.now()): Promise<number> {
    let archived = 0;
    const facts = await this.database.get('memory_fact', { archived: 0 }) as MemoryFactRecord[];
    for (const fact of facts) {
      if (fact.expiresAt == null || fact.expiresAt > now) continue;
      await this.database.set('memory_fact', { id: fact.id }, { archived: 1, lastSeenAt: now });
      archived += 1;
    }
    const episodes = await this.database.get('memory_episode', { archived: 0 }) as MemoryEpisodeRecord[];
    for (const episode of episodes) {
      if (episode.expiresAt == null || episode.expiresAt > now) continue;
      await this.database.set('memory_episode', { id: episode.id }, { archived: 1, lastSeenAt: now });
      archived += 1;
    }
    return archived;
  }

  async archiveLowRiskOldEpisodes(archiveDays: number, now = Date.now()): Promise<number> {
    const threshold = now - archiveDays * DAY_MS;
    const episodes = await this.database.get('memory_episode', { archived: 0 }) as MemoryEpisodeRecord[];
    let count = 0;
    for (const episode of episodes) {
      const lastTouched = Number(episode.lastAccessedAt ?? episode.lastSeenAt ?? episode.firstSeenAt ?? 0);
      if (episode.importance >= 0.85 || episode.sensitivity !== 'low' || lastTouched > threshold) continue;
      await this.database.set('memory_episode', { id: episode.id }, { archived: 1, lastSeenAt: now });
      count += 1;
    }
    return count;
  }

  async forgetMemory(input: { userKey: string; type: MemoryRecordType; id: number; reason?: string | null }): Promise<boolean> {
    const table = input.type === 'fact' ? 'memory_fact' : 'memory_episode';
    const [row] = await this.database.get(table, { id: input.id });
    if (!row?.id || row.ownerUserKey !== input.userKey) return false;
    const provenanceRows = await this.database.get('memory_provenance', {
      memoryType: input.type,
      memoryId: input.id,
    });
    await this.database.remove(table, { id: input.id });
    await this.database.remove('memory_provenance', { memoryType: input.type, memoryId: input.id });
    await this.removeJobsReferencing(input.type, input.id);
    for (const provenance of provenanceRows) {
      for (const sourceMessageId of parseJsonArray(provenance.messageIds)) {
        await this.database.create('memory_tombstone', {
          userKey: input.userKey,
          contextKey: provenance.contextKey ?? row.sourceContextKey ?? null,
          memoryType: 'source',
          memoryId: null,
          topicKey: null,
          sourceMessageId,
          reason: input.reason ?? 'forget',
          createdAt: Date.now(),
        });
      }
    }
    await this.database.create('memory_tombstone', {
      userKey: input.userKey,
      contextKey: row.sourceContextKey ?? null,
      memoryType: input.type,
      memoryId: input.id,
      topicKey: input.type === 'fact' ? row.topicKey ?? null : null,
      sourceMessageId: null,
      reason: input.reason ?? 'forget',
      createdAt: Date.now(),
    });
    if (input.type === 'fact' && row.topicKey) {
      await this.database.remove('memory_profile', {
        ownerUserKey: input.userKey,
        kind: row.kind,
        profileKey: row.topicKey,
      });
      await this.database.create('memory_tombstone', {
        userKey: input.userKey,
        contextKey: row.sourceContextKey ?? null,
        memoryType: 'topic',
        memoryId: null,
        topicKey: row.topicKey,
        sourceMessageId: null,
        reason: input.reason ?? 'forget',
        createdAt: Date.now(),
      });
    }
    await this.audit({
      userKey: input.userKey,
      contextKey: row.sourceContextKey ?? null,
      eventType: 'forget',
      memoryType: input.type,
      memoryId: input.id,
      detail: { reason: input.reason ?? 'forget' },
    });
    return true;
  }

  async forgetTopic(userKey: string, topicKey: string, contextKey: string | null = null): Promise<number> {
    const rows = await this.database.get('memory_fact', { ownerUserKey: userKey, topicKey }) as MemoryFactRecord[];
    let count = 0;
    for (const row of rows) {
      if (contextKey && row.sourceContextKey !== contextKey) continue;
      if (await this.forgetMemory({ userKey, type: 'fact', id: row.id, reason: 'forget_topic' })) count += 1;
    }
    await this.database.create('memory_tombstone', {
      userKey,
      contextKey,
      memoryType: 'topic',
      memoryId: null,
      topicKey,
      sourceMessageId: null,
      reason: 'forget_topic',
      createdAt: Date.now(),
    });
    await this.database.remove('memory_profile', { ownerUserKey: userKey, profileKey: topicKey });
    return count;
  }

  async forgetContext(userKey: string, contextKey: string): Promise<number> {
    const [facts, episodes] = await Promise.all([
      this.database.get('memory_fact', { ownerUserKey: userKey, sourceContextKey: contextKey }) as Promise<MemoryFactRecord[]>,
      this.database.get('memory_episode', { ownerUserKey: userKey, sourceContextKey: contextKey }) as Promise<MemoryEpisodeRecord[]>,
    ]);
    let count = 0;
    for (const row of facts) {
      if (await this.forgetMemory({ userKey, type: 'fact', id: row.id, reason: 'forget_context' })) count += 1;
    }
    for (const row of episodes) {
      if (await this.forgetMemory({ userKey, type: 'episode', id: row.id, reason: 'forget_context' })) count += 1;
    }
    await this.database.create('memory_tombstone', {
      userKey,
      contextKey,
      memoryType: 'source',
      memoryId: null,
      topicKey: null,
      sourceMessageId: null,
      reason: 'forget_context',
      createdAt: Date.now(),
    });
    return count;
  }

  async forgetAll(userKey: string): Promise<number> {
    const [facts, episodes] = await Promise.all([
      this.database.get('memory_fact', { ownerUserKey: userKey }) as Promise<MemoryFactRecord[]>,
      this.database.get('memory_episode', { ownerUserKey: userKey }) as Promise<MemoryEpisodeRecord[]>,
    ]);
    let count = 0;
    for (const row of facts) {
      if (await this.forgetMemory({ userKey, type: 'fact', id: row.id, reason: 'forget_all' })) count += 1;
    }
    for (const row of episodes) {
      if (await this.forgetMemory({ userKey, type: 'episode', id: row.id, reason: 'forget_all' })) count += 1;
    }
    await this.database.remove('memory_profile', { ownerUserKey: userKey });
    return count;
  }

  async updateVisibility(input: {
    userKey: string;
    type: MemoryRecordType;
    id: number;
    visibility: MemoryVisibility;
  }): Promise<boolean> {
    const table = input.type === 'fact' ? 'memory_fact' : 'memory_episode';
    const [row] = await this.database.get(table, { id: input.id });
    if (!row?.id || row.ownerUserKey !== input.userKey) return false;
    const scopeType = scopeTypeFromVisibility(input.visibility);
    const scopeKey = scopeKeyForType(scopeType, row.sourceContextKey);
    const memoryKey = input.type === 'fact'
      ? buildMemoryKey({
        userKey: row.ownerUserKey,
        layer: 'fact',
        kind: row.kind,
        topicKey: row.topicKey,
        scopeType,
        scopeKey,
      })
      : buildMemoryKey({
        userKey: row.ownerUserKey,
        layer: 'episode',
        kind: 'episode',
        topicKey: episodeTopicKey(row),
        scopeType,
        scopeKey,
      });
    await this.database.set(table, { id: input.id }, {
      visibility: input.visibility,
      scopeType,
      scopeKey,
      memoryKey,
      version: Number(row.version ?? 0) + 1,
    });
    if (input.type === 'fact') {
      await this.upsertProfileFromFactId(input.id);
    }
    await this.audit({
      userKey: input.userKey,
      contextKey: row.sourceContextKey ?? null,
      eventType: 'visibility_updated',
      memoryType: input.type,
      memoryId: input.id,
      detail: { visibility: input.visibility },
    });
    return true;
  }

  async editMemory(input: {
    userKey: string;
    type: MemoryRecordType;
    id: number;
    content: string;
  }): Promise<boolean> {
    const table = input.type === 'fact' ? 'memory_fact' : 'memory_episode';
    const [row] = await this.database.get(table, { id: input.id });
    if (!row?.id || row.ownerUserKey !== input.userKey) return false;
    const patch = input.type === 'fact'
      ? {
          content: input.content.trim(),
          retrievalText: `${row.kind}:${row.topicKey}\n${input.content.trim()}`.trim(),
          version: Number(row.version ?? 0) + 1,
          embedding: null,
          embeddingModel: null,
        }
      : {
          summary: input.content.trim(),
          retrievalText: `${row.title}\n${input.content.trim()}`.trim(),
          version: Number(row.version ?? 0) + 1,
          embedding: null,
          embeddingModel: null,
        };
    await this.database.set(table, { id: input.id }, patch);
    if (input.type === 'fact') {
      await this.upsertProfileFromFactId(input.id);
    }
    await this.queueJob('embed', { recordType: input.type, recordId: input.id });
    await this.audit({
      userKey: input.userKey,
      contextKey: row.sourceContextKey ?? null,
      eventType: 'memory_edited',
      memoryType: input.type,
      memoryId: input.id,
    });
    return true;
  }

  async reviewCandidate(input: {
    candidateId: number;
    action: 'approve' | 'reject' | 'private';
  }): Promise<boolean> {
    const [row] = await this.database.get('memory_candidate', { id: input.candidateId }) as MemoryCandidateRecord[];
    if (!row?.id) return false;
    const reviewStatus: MemoryCandidateReviewStatus = input.action === 'reject' ? 'rejected' : 'approved';
    const finalVisibility: MemoryVisibility | null = input.action === 'private' ? 'private_only' : row.finalVisibility ?? row.suggestedVisibility;
    await this.database.set('memory_candidate', { id: row.id }, {
      reviewStatus,
      finalVisibility,
      reviewedAt: Date.now(),
      dropReason: input.action === 'reject' ? 'manual_reject' : row.dropReason,
    });
    await this.audit({
      userKey: row.ownerUserKey,
      contextKey: row.contextKey,
      eventType: 'candidate_manual_review',
      candidateId: row.id,
      detail: { action: input.action },
    });
    return true;
  }

  async listPendingCandidates(userKey: string): Promise<MemoryCandidateRecord[]> {
    const rows = await this.database.get('memory_candidate', { ownerUserKey: userKey, reviewStatus: 'pending_review' }) as MemoryCandidateRecord[];
    return rows.sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0));
  }

  async getLatestRecallAudit(userKey: string, contextKey: string): Promise<MemoryAuditEventRecord | null> {
    const rows = await this.database.get('memory_audit_event', {
      userKey,
      contextKey,
      eventType: 'recall_selected',
    }) as MemoryAuditEventRecord[];
    return rows.sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0))[0] ?? null;
  }

  private async removeJobsReferencing(recordType: MemoryRecordType, recordId: number): Promise<void> {
    const rows = await this.database.get('memory_job', {} as Record<string, never>) as MemoryJobRecord[];
    for (const row of rows) {
      const payload = parsePayload<Record<string, unknown>>(row.payload);
      if (payload?.recordType === recordType && Number(payload.recordId) === recordId) {
        await this.database.remove('memory_job', { id: row.id });
      }
    }
  }

  async audit(input: {
    userKey?: string | null;
    contextKey?: string | null;
    eventType: string;
    memoryType?: MemoryRecordType | null;
    memoryId?: number | null;
    candidateId?: number | null;
    turnId?: string | null;
    detail?: unknown;
  }): Promise<void> {
    await this.database.create('memory_audit_event', {
      userKey: input.userKey ?? null,
      contextKey: input.contextKey ?? null,
      eventType: input.eventType,
      memoryType: input.memoryType ?? null,
      memoryId: input.memoryId ?? null,
      candidateId: input.candidateId ?? null,
      turnId: input.turnId ?? null,
      detail: input.detail == null ? null : serialize(input.detail),
      createdAt: Date.now(),
    } satisfies Omit<MemoryAuditEventRecord, 'id'>);
  }
}
