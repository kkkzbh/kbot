import { $ } from 'koishi';
import type {
  AdminMemoryAuditItem,
  AdminMemoryEpisodeItem,
  AdminMemoryFactItem,
  AdminMemoryJobItem,
  AdminMemoryPendingReviewItem,
  AdminMemorySummary,
  AdminMemoryUserItem,
} from '../../types/admin.js';
import type {
  MemoryAuditEventRecord,
  MemoryCandidateRecord,
  MemoryEpisodeRecord,
  MemoryFactRecord,
  MemoryJobRecord,
  MemoryUserRecord,
} from '../../types/memory.js';
import { MemoryStore } from './store.js';

type MemoryDatabaseLike = {
  get(
    table: string,
    query: Record<string, unknown>,
    cursor?: { limit?: number; offset?: number; sort?: Record<string, 'asc' | 'desc'> },
  ): Promise<any[]>;
  eval?: (table: string, evaluator: (row: any) => unknown, query?: Record<string, unknown>) => Promise<unknown>;
};

export type MemoryPageQuery = {
  page: number;
  pageSize: number;
  userKey?: string;
  search?: string;
};

export type MemoryPage<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function userLabel(row: Pick<MemoryUserRecord, 'userKey' | 'userId' | 'qqNick'>): string {
  return normalizeOptionalText(row.qqNick) ?? (row.userId ? `用户 ${row.userId}` : row.userKey || '未知用户');
}

export function toFactItem(row: MemoryFactRecord): AdminMemoryFactItem {
  return {
    id: row.id,
    userKey: row.ownerUserKey,
    sourceContextKey: row.sourceContextKey,
    kind: row.kind,
    topicKey: row.topicKey,
    content: row.content,
    keywords: parseJsonArray(row.keywords),
    importance: Number(row.importance ?? 0),
    confidence: Number(row.confidence ?? 0),
    sensitivity: row.sensitivity,
    visibility: row.visibility,
    firstSeenAt: Number(row.firstSeenAt ?? 0),
    lastSeenAt: Number(row.lastSeenAt ?? row.firstSeenAt ?? 0),
    lastAccessedAt: row.lastAccessedAt == null ? null : Number(row.lastAccessedAt),
    hasEmbedding: Boolean(row.embedding),
    archived: Number(row.archived ?? 0) === 1,
    conflictSetId: row.conflictSetId ?? null,
  };
}

export function toEpisodeItem(row: MemoryEpisodeRecord): AdminMemoryEpisodeItem {
  return {
    id: row.id,
    userKey: row.ownerUserKey,
    sourceContextKey: row.sourceContextKey,
    title: row.title,
    summary: row.summary,
    keywords: parseJsonArray(row.keywords),
    importance: Number(row.importance ?? 0),
    confidence: Number(row.confidence ?? 0),
    sensitivity: row.sensitivity,
    visibility: row.visibility,
    periodStart: row.periodStart == null ? null : Number(row.periodStart),
    periodEnd: row.periodEnd == null ? null : Number(row.periodEnd),
    firstSeenAt: Number(row.firstSeenAt ?? 0),
    lastSeenAt: Number(row.lastSeenAt ?? row.firstSeenAt ?? 0),
    lastAccessedAt: row.lastAccessedAt == null ? null : Number(row.lastAccessedAt),
    hasEmbedding: Boolean(row.embedding),
    archived: Number(row.archived ?? 0) === 1,
    conflictSetId: row.conflictSetId ?? null,
  };
}

export function toPendingReviewItem(row: MemoryCandidateRecord): AdminMemoryPendingReviewItem {
  return {
    id: row.id,
    batchId: row.batchId,
    candidateType: row.candidateType,
    userKey: row.ownerUserKey,
    contextKey: row.contextKey,
    conversationId: row.conversationId,
    payload: row.payload,
    sensitivity: row.sensitivity,
    suggestedVisibility: row.suggestedVisibility,
    finalVisibility: row.finalVisibility,
    dropReason: row.dropReason,
    providerRoute: row.providerRoute,
    createdAt: Number(row.createdAt ?? 0),
  };
}

export function toJobItem(row: MemoryJobRecord): AdminMemoryJobItem {
  let userKey: string | null = null;
  let contextKey: string | null = null;
  let conversationId: string | null = null;
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const address = payload.address && typeof payload.address === 'object'
      ? payload.address as Record<string, unknown>
      : null;
    userKey = typeof address?.userKey === 'string' ? address.userKey : null;
    contextKey = typeof address?.contextKey === 'string' ? address.contextKey : null;
    conversationId = typeof address?.conversationId === 'string' ? address.conversationId : null;
  } catch {
    // Keep nullable metadata empty for malformed payloads.
  }
  return {
    id: row.id,
    jobType: row.jobType,
    status: row.status,
    userKey,
    contextKey,
    conversationId,
    retryCount: Number(row.retryCount ?? 0),
    nextRunAt: Number(row.nextRunAt ?? 0),
    lockedAt: row.lockedAt == null ? null : Number(row.lockedAt),
    createdAt: Number(row.createdAt ?? 0),
    updatedAt: Number(row.updatedAt ?? 0),
    lastError: row.lastError ?? null,
  };
}

export function toAuditItem(row: MemoryAuditEventRecord): AdminMemoryAuditItem {
  return {
    id: row.id,
    userKey: row.userKey,
    contextKey: row.contextKey,
    eventType: row.eventType,
    memoryType: row.memoryType,
    memoryId: row.memoryId,
    candidateId: row.candidateId,
    turnId: row.turnId,
    detail: row.detail,
    createdAt: Number(row.createdAt ?? 0),
  };
}

async function countRows(
  database: MemoryDatabaseLike,
  table: string,
  query: Record<string, unknown> = {},
): Promise<number> {
  if (!database.eval) throw new Error('memory database aggregation is unavailable');
  return Number(await database.eval(table, (row) => $.count(row.id), query) ?? 0);
}

function cursorFor(query: MemoryPageQuery, sort: Record<string, 'asc' | 'desc'>) {
  return {
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
    sort,
  };
}

export async function getMemorySummary(
  database: MemoryDatabaseLike,
): Promise<AdminMemorySummary & { provenanceCount: number }> {
  const [userCount, factCount, episodeCount, pendingReviewCount, pendingJobs, processingJobs, deadLetterJobs, provenanceCount] = await Promise.all([
    countRows(database, 'memory_user'),
    countRows(database, 'memory_fact'),
    countRows(database, 'memory_episode'),
    countRows(database, 'memory_candidate', { reviewStatus: 'pending_review' }),
    countRows(database, 'memory_job', { status: 'pending' }),
    countRows(database, 'memory_job', { status: 'processing' }),
    countRows(database, 'memory_job', { status: 'dead_letter' }),
    countRows(database, 'memory_provenance'),
  ]);
  return { userCount, factCount, episodeCount, pendingReviewCount, pendingJobs, processingJobs, deadLetterJobs, provenanceCount };
}

export async function getMemoryUsersPage(
  database: MemoryDatabaseLike,
  query: MemoryPageQuery,
): Promise<MemoryPage<AdminMemoryUserItem>> {
  const userQuery: Record<string, unknown> = {};
  if (query.search) {
    const pattern = new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    userQuery.$or = [{ userKey: { $regex: pattern } }, { userId: { $regex: pattern } }, { qqNick: { $regex: pattern } }];
  }
  const [rows, total] = await Promise.all([
    database.get('memory_user', userQuery, cursorFor(query, { lastSeenAt: 'desc' })) as Promise<MemoryUserRecord[]>,
    countRows(database, 'memory_user', userQuery),
  ]);
  const items = await Promise.all(rows.map(async (row): Promise<AdminMemoryUserItem> => {
    const [factCount, episodeCount, pendingReviewCount] = await Promise.all([
      countRows(database, 'memory_fact', { ownerUserKey: row.userKey }),
      countRows(database, 'memory_episode', { ownerUserKey: row.userKey }),
      countRows(database, 'memory_candidate', { ownerUserKey: row.userKey, reviewStatus: 'pending_review' }),
    ]);
    return {
      userKey: row.userKey,
      platform: row.platform ?? null,
      userId: row.userId ?? null,
      qqNick: normalizeOptionalText(row.qqNick),
      avatarUrl: normalizeOptionalText(row.avatarUrl),
      label: userLabel(row),
      factCount,
      episodeCount,
      pendingReviewCount,
      readEnabled: Number(row.readEnabled ?? 1) === 1,
      writeEnabled: Number(row.writeEnabled ?? 1) === 1,
      latestSeenAt: Number(row.lastSeenAt ?? row.firstSeenAt ?? 0) || null,
    };
  }));
  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function getMemoryRecordsPage(
  database: MemoryDatabaseLike,
  kind: 'facts' | 'episodes' | 'reviews' | 'jobs' | 'audit',
  query: MemoryPageQuery,
): Promise<MemoryPage<unknown>> {
  const definition = {
    facts: { table: 'memory_fact', ownerKey: 'ownerUserKey', sortKey: 'lastSeenAt', map: toFactItem },
    episodes: { table: 'memory_episode', ownerKey: 'ownerUserKey', sortKey: 'lastSeenAt', map: toEpisodeItem },
    reviews: { table: 'memory_candidate', ownerKey: 'ownerUserKey', sortKey: 'createdAt', map: toPendingReviewItem },
    jobs: { table: 'memory_job', ownerKey: null, sortKey: 'updatedAt', map: toJobItem },
    audit: { table: 'memory_audit_event', ownerKey: 'userKey', sortKey: 'createdAt', map: toAuditItem },
  }[kind];
  const recordQuery: Record<string, unknown> = kind === 'reviews' ? { reviewStatus: 'pending_review' } : {};
  if (query.userKey && definition.ownerKey) recordQuery[definition.ownerKey] = query.userKey;
  const [rows, total] = await Promise.all([
    database.get(definition.table, recordQuery, cursorFor(query, { [definition.sortKey]: 'desc' })),
    countRows(database, definition.table, recordQuery),
  ]);
  return {
    items: rows.map((row) => definition.map(row as never)),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export type MemoryAdminMutation =
  | { action: 'visibility'; userKey: string; type: 'fact' | 'episode'; id: number; visibility: import('../../types/memory.js').MemoryVisibility }
  | { action: 'edit'; userKey: string; type: 'fact' | 'episode'; id: number; content: string }
  | { action: 'review'; candidateId: number; decision: 'approve' | 'reject' | 'private' }
  | { action: 'forget'; userKey: string; type?: 'fact' | 'episode'; id?: number; topicKey?: string; contextKey?: string; all?: boolean };

export class MemoryAdminService {
  constructor(
    private readonly database: MemoryDatabaseLike,
    private readonly store: MemoryStore,
  ) {}

  getSummary(): Promise<AdminMemorySummary & { provenanceCount: number }> {
    return getMemorySummary(this.database);
  }

  getUsersPage(query: MemoryPageQuery): Promise<MemoryPage<AdminMemoryUserItem>> {
    return getMemoryUsersPage(this.database, query);
  }

  getRecordsPage(
    kind: 'facts' | 'episodes' | 'reviews' | 'jobs' | 'audit',
    query: MemoryPageQuery,
  ): Promise<MemoryPage<unknown>> {
    return getMemoryRecordsPage(this.database, kind, query);
  }

  async mutate(input: MemoryAdminMutation): Promise<boolean> {
    if (input.action === 'visibility') return this.store.updateVisibility(input);
    if (input.action === 'edit') return this.store.editMemory(input);
    if (input.action === 'review') return this.store.reviewCandidate({ candidateId: input.candidateId, action: input.decision });
    if (input.all) return (await this.store.forgetAll(input.userKey)) > 0;
    if (input.topicKey) return (await this.store.forgetTopic(input.userKey, input.topicKey, input.contextKey ?? null)) > 0;
    if (input.contextKey) return (await this.store.forgetContext(input.userKey, input.contextKey)) > 0;
    return this.store.forgetMemory({ userKey: input.userKey, type: input.type ?? 'fact', id: Number(input.id) });
  }

  async exportUser(userKey: string): Promise<{ userKey: string; facts: any[]; episodes: any[]; provenance: any[] }> {
    const [facts, episodes, provenance] = await Promise.all([
      this.database.get('memory_fact', { ownerUserKey: userKey }),
      this.database.get('memory_episode', { ownerUserKey: userKey }),
      this.database.get('memory_provenance', { ownerUserKey: userKey }),
    ]);
    return { userKey, facts, episodes, provenance };
  }
}

declare module 'koishi' {
  interface Context {
    memoryAdmin?: MemoryAdminService;
  }
}
