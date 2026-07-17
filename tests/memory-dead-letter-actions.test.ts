import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/plugins/memory/store.js';

function createDatabase() {
  const jobs = [{
    id: 7,
    jobKey: 'extract:room:user',
    jobType: 'extract',
    status: 'dead_letter',
    payload: '{}',
    retryCount: 4,
    nextRunAt: 0,
    lockedAt: null,
    lastError: 'provider failed',
    createdAt: 1,
    updatedAt: 2,
  }];
  return {
    jobs,
    get: vi.fn(async (_table: string, query: Record<string, unknown>) => jobs.filter((row) => (
      Object.entries(query).every(([key, value]) => row[key as keyof typeof row] === value)
    ))),
    set: vi.fn(async (_table: string, query: Record<string, unknown>, patch: Record<string, unknown>) => {
      for (const row of jobs) {
        if (Object.entries(query).every(([key, value]) => row[key as keyof typeof row] === value)) Object.assign(row, patch);
      }
    }),
    remove: vi.fn(async (_table: string, query: Record<string, unknown>) => {
      const index = jobs.findIndex((row) => Object.entries(query).every(([key, value]) => row[key as keyof typeof row] === value));
      if (index >= 0) jobs.splice(index, 1);
    }),
  };
}

describe('memory dead-letter actions', () => {
  it('requeues a dead-letter job with a fresh retry budget', async () => {
    const database = createDatabase();
    const store = new MemoryStore(database as any);

    await expect(store.requeueDeadLetterJob(7)).resolves.toBe(true);

    expect(database.jobs[0]).toMatchObject({ status: 'pending', retryCount: 0, lastError: null, lockedAt: null });
  });

  it('discards only a dead-letter job', async () => {
    const database = createDatabase();
    const store = new MemoryStore(database as any);

    await expect(store.discardDeadLetterJob(7)).resolves.toBe(true);

    expect(database.jobs).toHaveLength(0);
    expect(database.remove).toHaveBeenCalledWith('memory_job', { id: 7, status: 'dead_letter' });
  });
});
