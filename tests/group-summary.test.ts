import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => {
  class MockLogger { info(): void {} warn(): void {} }
  const schemaChain = new Proxy(() => schemaChain, { get: () => schemaChain, apply: () => schemaChain }) as any;
  return { Context: class {}, Logger: MockLogger, Schema: new Proxy({}, { get: () => schemaChain }) };
});

import { GroupSummaryService } from '../src/plugins/group-summary/service.js';
import { TABLES } from '../src/plugins/group-summary/schema.js';

interface DatabaseStub {
  get(table: string, query: Record<string, unknown>): Promise<Record<string, any>[]>;
  create(table: string, input: Record<string, unknown>): Promise<Record<string, any>>;
  set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<void>;
  remove(table: string, query: Record<string, unknown>): Promise<void>;
  withTransaction<T>(operation: (database: DatabaseStub) => Promise<T>): Promise<T>;
}

function createDatabase() {
  const tables = new Map<string, Record<string, any>[]>();
  const counters = new Map<string, number>();
  const database: DatabaseStub = {
    async get(table: string, query: Record<string, unknown>) {
      return (tables.get(table) ?? []).filter((row) => Object.entries(query).every(([key, value]) => row[key] === value)).map((row) => structuredClone(row));
    },
    async create(table: string, input: Record<string, unknown>) {
      const row = structuredClone(input) as Record<string, any>;
      if ([TABLES.message, TABLES.task, TABLES.batch].includes(table as any) && row.id == null) {
        row.id = (counters.get(table) ?? 0) + 1;
        counters.set(table, row.id);
      }
      const rows = tables.get(table) ?? [];
      rows.push(row);
      tables.set(table, rows);
      return structuredClone(row);
    },
    async set(table: string, query: Record<string, unknown>, data: Record<string, unknown>) {
      for (const row of tables.get(table) ?? []) {
        if (Object.entries(query).every(([key, value]) => row[key] === value)) Object.assign(row, structuredClone(data));
      }
    },
    async remove(table: string, query: Record<string, unknown>) {
      tables.set(table, (tables.get(table) ?? []).filter((row) => !Object.entries(query).every(([key, value]) => row[key] === value)));
    },
    async withTransaction<T>(operation: (db: DatabaseStub) => Promise<T>) { return operation(database); },
  };
  return database;
}

function emptyDocument(ids: number[]) {
  return {
    headline: '本批保研信息',
    institutions: ids.length ? [{ name: '测试大学', program: '计算机夏令营', details: ['开放报名'], deadlines: [], requirements: [], evidenceMessageIds: ids }] : [],
    materials: [], experiences: [], actionItems: [], openQuestions: [], conflicts: [], otherTopicsBrief: '讨论了日常安排。',
  };
}

function createRuntime(overrides: { fail?: boolean } = {}) {
  const executeChat = vi.fn(async (input: any) => {
    if (overrides.fail) throw new Error('provider unavailable');
    const content = String(input.request.messages[1].content);
    const ids = [...content.matchAll(/\[消息ID=(\d+)/gu)].map((match) => Number(match[1]));
    const document = emptyDocument(ids);
    return { text: JSON.stringify({ batchSummary: document, currentOverview: document }) };
  });
  return {
    runtime: {
      resolve: vi.fn(() => ({ model: 'provider/chat' })),
      executeChat,
    } as any,
    executeChat,
  };
}

function session(messageId: string, content = '某大学计算机夏令营开始报名') {
  return {
    platform: 'onebot', bot: { selfId: 'bot-1' }, channelId: 'group:100', guildId: '100',
    isDirect: false, messageId, userId: '200', username: '小明', content,
    stripped: { content }, elements: [{ type: 'text', attrs: { content } }],
    event: { timestamp: Date.now() }, state: {}, author: undefined,
  } as any;
}

async function waitForTask(service: GroupSummaryService, taskId: number, status: 'succeeded' | 'failed') {
  await vi.waitFor(async () => {
    await expect(service.getTask(taskId)).resolves.toMatchObject({ status });
  });
}

describe('group summary service', () => {
  it('captures only enabled group member messages and deduplicates OneBot IDs', async () => {
    const database = createDatabase();
    const { runtime } = createRuntime();
    const service = new GroupSummaryService(database, runtime);
    await service.initialize();
    expect(await service.capture(session('m1'))).toBe(false);
    await service.updateGroup('100', { enabled: true, roomName: '保研群', promptOverride: null });
    expect(await service.capture(session('m1'))).toBe(true);
    expect(await service.capture(session('m1'))).toBe(false);
    expect(await service.capture({ ...session('m2'), isDirect: true })).toBe(false);
    expect(await service.capture({ ...session('m3'), userId: 'bot-1' })).toBe(false);
    await expect(service.listMessages('100', 1, 20)).resolves.toMatchObject({ total: 1 });
  });

  it('excludes successful coverage from automatic runs and keeps overlapping manual batches', async () => {
    const database = createDatabase();
    const { runtime, executeChat } = createRuntime();
    const service = new GroupSummaryService(database, runtime);
    await service.initialize();
    await service.updateGlobalPrompt('全局保研提示');
    await service.updateGroup('100', { enabled: true, roomName: '保研群', promptOverride: '只关注计算机推免' });
    await service.capture(session('m1'));
    await service.capture(session('m2', '第二条报名信息'));
    const task = await service.createTask('100', { mode: 'automatic' }) as any;
    await waitForTask(service, task.id, 'succeeded');
    await expect(service.preview('100', { mode: 'automatic' })).resolves.toMatchObject({ messageCount: 0 });

    const messages = await service.listMessages('100', 1, 20) as any;
    const times = messages.items.map((row: any) => row.capturedAt);
    const manual = await service.createTask('100', { mode: 'manual', startAt: Math.min(...times) - 1, endAt: Math.max(...times) + 1 }) as any;
    await waitForTask(service, manual.id, 'succeeded');
    const detail = await service.getGroupDetail('100') as any;
    expect(detail.batches).toHaveLength(2);
    expect(detail.batches[0].overlapsPrevious).toBe(true);
    expect(executeChat.mock.calls[0][0].request.messages[0].content).toContain('只关注计算机推免');
  });

  it('does not advance coverage when model execution fails and clears dependent data', async () => {
    const database = createDatabase();
    const { runtime } = createRuntime({ fail: true });
    const service = new GroupSummaryService(database, runtime);
    await service.initialize();
    await service.updateGroup('100', { enabled: true, roomName: null, promptOverride: null });
    await service.capture(session('m1'));
    const task = await service.createTask('100', { mode: 'automatic' }) as any;
    await waitForTask(service, task.id, 'failed');
    await expect(service.preview('100', { mode: 'automatic' })).resolves.toMatchObject({ messageCount: 1 });
    await expect(service.clearGroup('100')).resolves.toEqual({ ok: true, groupId: '100' });
    await expect(service.listMessages('100', 1, 20)).resolves.toMatchObject({ total: 0 });
  });
});
