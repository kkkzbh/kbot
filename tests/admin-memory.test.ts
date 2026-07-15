import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => ({
  $: { count: (value: unknown) => value },
}));
import {
  getMemoryRecordsPage,
  getMemorySummary,
  getMemoryUsersPage,
} from '../src/plugins/memory/admin.js';

function createDatabase() {
  const tables: Record<string, any[]> = {
    memory_user: [
      { id: 1, userKey: 'onebot:user:10001', platform: 'onebot', userId: '10001', qqNick: '小嘉', avatarUrl: null, firstSeenAt: 1, lastSeenAt: 20, readEnabled: 1, writeEnabled: 1 },
      { id: 2, userKey: 'onebot:user:10002', platform: 'onebot', userId: '10002', qqNick: null, avatarUrl: null, firstSeenAt: 1, lastSeenAt: 10, readEnabled: 1, writeEnabled: 0 },
    ],
    memory_fact: [
      { id: 2, ownerUserKey: 'onebot:user:10001', sourceContextKey: 'dm:1', kind: 'preference', topicKey: 'answer-style', content: '用户喜欢简洁回答。', keywords: '["回答"]', importance: .8, confidence: .9, sensitivity: 'low', visibility: 'global', firstSeenAt: 1, lastSeenAt: 20, lastAccessedAt: null, embedding: null, archived: 0, conflictSetId: null },
      { id: 3, ownerUserKey: 'onebot:user:10002', sourceContextKey: 'dm:2', kind: 'trait', topicKey: 'major', content: '计算机专业。', keywords: '[]', importance: .7, confidence: .8, sensitivity: 'low', visibility: 'private_only', firstSeenAt: 1, lastSeenAt: 10, lastAccessedAt: null, embedding: null, archived: 0, conflictSetId: null },
    ],
    memory_episode: [],
    memory_candidate: [{ id: 4, ownerUserKey: 'onebot:user:10001', reviewStatus: 'pending_review' }],
    memory_job: [
      { id: 5, status: 'pending' },
      { id: 6, status: 'dead_letter' },
    ],
    memory_provenance: [{ id: 7 }],
    memory_audit_event: [],
  };
  const matches = (row: any, query: Record<string, any>): boolean => Object.entries(query).every(([key, value]): boolean => {
    if (key === '$or') return (value as any[]).some((part) => matches(row, part));
    if (value && typeof value === 'object' && '$regex' in value) return (value.$regex as RegExp).test(String(row[key] ?? ''));
    return row[key] === value;
  });
  const get = vi.fn(async (table: string, query: Record<string, any>, cursor?: any) => {
    const rows = (tables[table] ?? []).filter((row) => matches(row, query));
    const sort = cursor?.sort ? Object.entries(cursor.sort)[0] : null;
    if (sort) rows.sort((left, right) => (Number(right[sort[0]]) - Number(left[sort[0]])) * (sort[1] === 'desc' ? 1 : -1));
    return rows.slice(cursor?.offset ?? 0, (cursor?.offset ?? 0) + (cursor?.limit ?? rows.length));
  });
  const evalRows = vi.fn(async (table: string, _evaluator: unknown, query: Record<string, any> = {}) => (tables[table] ?? []).filter((row) => matches(row, query)).length);
  return { get, eval: evalRows };
}

describe('admin memory pagination', () => {
  it('aggregates summary counts in the database boundary', async () => {
    const database = createDatabase();
    await expect(getMemorySummary(database)).resolves.toEqual({
      userCount: 2,
      factCount: 2,
      episodeCount: 0,
      pendingReviewCount: 1,
      pendingJobs: 1,
      processingJobs: 0,
      deadLetterJobs: 1,
      provenanceCount: 1,
    });
    expect(database.eval).toHaveBeenCalledTimes(8);
  });

  it('uses limit, offset and sort for user pages', async () => {
    const database = createDatabase();
    const page = await getMemoryUsersPage(database, { page: 2, pageSize: 1 });
    expect(page).toMatchObject({ page: 2, pageSize: 1, total: 2 });
    expect(page.items[0]).toMatchObject({ userKey: 'onebot:user:10002', label: '用户 10002', factCount: 1 });
    expect(database.get).toHaveBeenCalledWith('memory_user', {}, { limit: 1, offset: 1, sort: { lastSeenAt: 'desc' } });
  });

  it('filters and paginates record rows on the server', async () => {
    const database = createDatabase();
    const page = await getMemoryRecordsPage(database, 'facts', { page: 1, pageSize: 20, userKey: 'onebot:user:10001' });
    expect(page.total).toBe(1);
    expect(page.items).toEqual([expect.objectContaining({ id: 2, content: '用户喜欢简洁回答。' })]);
    expect(database.get).toHaveBeenCalledWith(
      'memory_fact',
      { ownerUserKey: 'onebot:user:10001' },
      { limit: 20, offset: 0, sort: { lastSeenAt: 'desc' } },
    );
  });
});
