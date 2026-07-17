import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => ({
  Context: class {},
  Logger: class {
    static DEBUG = 3;
    static INFO = 2;
    static targets: unknown[] = [];
  },
}));

import type { BotServiceStatus } from '../src/types/admin.js';
import { OperationalEventService } from '../src/plugins/admin-api/operational-events.js';

function createDatabase() {
  const tables = new Map<string, any[]>();
  const rows = (table: string) => {
    const current = tables.get(table) ?? [];
    tables.set(table, current);
    return current;
  };
  return {
    tables,
    get: vi.fn(async (table: string, query: Record<string, unknown>) => rows(table).filter((row) => (
      Object.entries(query).every(([key, value]) => row[key] === value)
    ))),
    create: vi.fn(async (table: string, row: Record<string, unknown>) => {
      const record = { id: rows(table).length + 1, ...row };
      rows(table).push(record);
      return record;
    }),
    set: vi.fn(async (table: string, query: Record<string, unknown>, patch: Record<string, unknown>) => {
      for (const row of rows(table)) {
        if (Object.entries(query).every(([key, value]) => row[key] === value)) Object.assign(row, patch);
      }
    }),
  };
}

function serviceStatus(runtimeState: BotServiceStatus['runtimeState']): BotServiceStatus {
  const active = runtimeState === 'healthy';
  return {
    unit: 'qqbot-pmhq.service',
    description: 'QQBot PMHQ Service',
    runtimeState,
    controllerState: {
      loadState: 'loaded',
      activeState: active ? 'active' : 'failed',
      subState: active ? 'running' : 'failed',
      unitFileState: 'generated',
      result: active ? 'success' : 'exit-code',
      invocationId: 'a030b1fd7f4c49d2b54c3e7c339eb284',
    },
    checkedAt: 1_800_000_000_000,
    healthDetail: active ? 'PMHQ health endpoint 正常' : 'PMHQ 工作负载健康，systemd 控制状态为 failed/failed',
    canStart: !active,
    canStop: active,
    canRestart: active,
    canEnable: false,
  };
}

function createLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any;
}

describe('operational event service', () => {
  it('deduplicates a structured systemd failure and resolves it after recovery', async () => {
    const database = createDatabase();
    const manager = {
      readServiceFailureJournal: vi.fn()
        .mockResolvedValueOnce({
          entries: [{
            cursor: 'cursor-1',
            bootId: 'boot-1',
            invocationId: 'a030b1fd7f4c49d2b54c3e7c339eb284',
            unit: 'qqbot-pmhq.service',
            result: 'failed',
            message: 'Failed to start QQBot PMHQ Service.',
            occurredAt: 1_800_000_000_000,
          }],
          cursor: 'cursor-1',
        })
        .mockResolvedValueOnce({ entries: [], cursor: 'cursor-1' }),
      getServiceStatuses: vi.fn()
        .mockResolvedValueOnce([serviceStatus('degraded')])
        .mockResolvedValueOnce([serviceStatus('healthy')]),
      readServiceInvocationJournal: vi.fn(async () => ['journal line']),
    };
    const service = new OperationalEventService(database as any, manager as any, () => undefined, createLogger());

    await service.sync();
    const pending = await service.list({ view: 'pending', page: 1, pageSize: 20 });
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]).toMatchObject({ type: 'service_start_failed', status: 'open' });

    await service.sync();
    const history = await service.list({ view: 'history', page: 1, pageSize: 20 });
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({ status: 'resolved', resolution: 'recovered' });
  });

  it('routes dead-letter retry to MemoryAdminService and records the resolution', async () => {
    const database = createDatabase();
    const manager = {
      readServiceFailureJournal: vi.fn(async () => ({ entries: [], cursor: 'cursor-1' })),
      getServiceStatuses: vi.fn(async () => []),
    };
    const memoryAdmin = {
      getOperationalAttentionItems: vi.fn(async () => [{
        sourceKey: 'memory-job:7:dead-letter:1800000000000',
        type: 'memory_job_dead_letter',
        severity: 'error',
        title: 'extract 记忆任务进入 dead letter',
        summary: 'provider failed',
        memoryJobId: 7,
        memoryCandidateId: null,
        occurredAt: 1_800_000_000_000,
      }]),
      retryDeadLetterJob: vi.fn(async () => undefined),
      discardDeadLetterJob: vi.fn(async () => undefined),
    };
    const service = new OperationalEventService(database as any, manager as any, () => memoryAdmin as any, createLogger());

    await service.sync();
    const [event] = (await service.list({ view: 'pending', page: 1, pageSize: 20 })).items;
    const updated = await service.runAction(event.id, 'retry');

    expect(memoryAdmin.retryDeadLetterJob).toHaveBeenCalledWith(7);
    expect(updated).toMatchObject({ status: 'resolved', resolution: 'retried' });
  });

  it('moves acknowledged events from pending into history', async () => {
    const database = createDatabase();
    const manager = {
      readServiceFailureJournal: vi.fn(async () => ({ entries: [], cursor: 'cursor-1' })),
      getServiceStatuses: vi.fn(async () => [serviceStatus('degraded')]),
      readServiceInvocationJournal: vi.fn(async () => []),
    };
    const service = new OperationalEventService(database as any, manager as any, () => undefined, createLogger());

    await service.sync();
    const [event] = (await service.list({ view: 'pending', page: 1, pageSize: 20 })).items;
    const acknowledged = await service.runAction(event.id, 'acknowledge');

    expect(acknowledged).toMatchObject({ status: 'acknowledged', availableActions: ['retry'] });
    expect((await service.list({ view: 'pending', page: 1, pageSize: 20 })).items).toHaveLength(0);
    expect((await service.list({ view: 'history', page: 1, pageSize: 20 })).items).toMatchObject([
      { id: event.id, status: 'acknowledged' },
    ]);
    expect(await service.summary()).toMatchObject({ openCount: 0, pending: [] });
  });
});
