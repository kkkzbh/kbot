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
      readRuntimeIssueJournal: vi.fn(async () => ({ entries: [], cursor: 'runtime-cursor-1' })),
      getServiceStatuses: vi.fn()
        .mockResolvedValueOnce([serviceStatus('degraded')])
        .mockResolvedValueOnce([serviceStatus('healthy')]),
      readServiceInvocationJournal: vi.fn(async () => ['journal line']),
    };
    const service = new OperationalEventService(database as any, manager as any, () => undefined, createLogger());

    await service.sync();
    const pending = await service.list({ view: 'pending', page: 1, pageSize: 20 });
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]).toMatchObject({
      type: 'service_start_failed',
      status: 'open',
      targetPath: '/?service=qqbot-pmhq.service',
    });

    await service.sync();
    const history = await service.list({ view: 'history', page: 1, pageSize: 20 });
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({ status: 'resolved', resolution: 'recovered' });
  });

  it('routes dead-letter retry to MemoryAdminService and records the resolution', async () => {
    const database = createDatabase();
    const manager = {
      readServiceFailureJournal: vi.fn(async () => ({ entries: [], cursor: 'cursor-1' })),
      readRuntimeIssueJournal: vi.fn(async () => ({ entries: [], cursor: 'runtime-cursor-1' })),
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
      readRuntimeIssueJournal: vi.fn(async () => ({ entries: [], cursor: 'runtime-cursor-1' })),
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

  it('acknowledges every open event across pagination in one operation', async () => {
    const database = createDatabase();
    const manager = {
      readServiceFailureJournal: vi.fn(async () => ({ entries: [], cursor: 'cursor-1' })),
      readRuntimeIssueJournal: vi.fn(async () => ({ entries: [], cursor: 'runtime-cursor-1' })),
      getServiceStatuses: vi.fn(async () => []),
    };
    const service = new OperationalEventService(database as any, manager as any, () => undefined, createLogger());
    const now = Date.now();
    for (let index = 0; index < 25; index += 1) {
      await database.create('admin_operational_event', {
        sourceKey: `event:${index}`,
        source: 'systemd',
        type: 'service_start_failed',
        severity: 'error',
        status: 'open',
        resolution: null,
        title: `事件 ${index}`,
        summary: '测试事件',
        unit: 'qqbot-pmhq.service',
        invocationId: null,
        memoryJobId: null,
        memoryCandidateId: null,
        occurredAt: now + index,
        acknowledgedAt: null,
        resolvedAt: null,
        updatedAt: now,
      });
    }

    await expect(service.acknowledgeAll()).resolves.toEqual({ acknowledgedCount: 25 });
    expect((await service.list({ view: 'pending', page: 1, pageSize: 20 })).items).toHaveLength(0);
    expect((await service.list({ view: 'history', page: 1, pageSize: 20 })).total).toBe(25);
    await expect(service.acknowledgeAll()).resolves.toEqual({ acknowledgedCount: 0 });
  });

  it('persists and aggregates live runtime errors with their redacted cause', async () => {
    const database = createDatabase();
    const manager = {
      readServiceFailureJournal: vi.fn(async () => ({ entries: [], cursor: 'cursor-1' })),
      readRuntimeIssueJournal: vi.fn(async () => ({ entries: [], cursor: 'runtime-cursor-1' })),
      getServiceStatuses: vi.fn(async () => []),
    };
    const service = new OperationalEventService(database as any, manager as any, () => undefined, createLogger());
    service.captureRuntimeLog({
      id: 101,
      timestamp: 1_800_000_000_000,
      level: 'error',
      namespace: 'chatluna',
      content: 'Call Embedding Error: code=30001 Authorization: Bearer secret-token',
    });
    service.captureRuntimeLog({
      id: 102,
      timestamp: 1_800_000_001_000,
      level: 'error',
      namespace: 'chatluna',
      content: 'Call Embedding Error: code=30001 Authorization: Bearer secret-token',
    });

    await service.sync();
    const [event] = (await service.list({ view: 'pending', page: 1, pageSize: 20 })).items;

    expect(event).toMatchObject({
      source: 'runtime',
      type: 'runtime_exception',
      component: 'chatluna',
      occurrenceCount: 2,
      occurredAt: 1_800_000_000_000,
      lastOccurredAt: 1_800_000_001_000,
    });
    expect(event.details).toContain('code=30001');
    expect(event.details).not.toContain('secret-token');
  });

  it('groups different contents under one runtime title and preserves every cause in detail', async () => {
    const database = createDatabase();
    const manager = {
      readServiceFailureJournal: vi.fn(async () => ({ entries: [], cursor: 'cursor-1' })),
      readRuntimeIssueJournal: vi.fn(async () => ({ entries: [], cursor: 'runtime-cursor-1' })),
      getServiceStatuses: vi.fn(async () => []),
    };
    const service = new OperationalEventService(database as any, manager as any, () => undefined, createLogger());
    service.captureRuntimeLog({
      id: 111,
      timestamp: 1_800_000_000_000,
      level: 'error',
      namespace: 'chatluna',
      content: 'Call Embedding Error: code=30001 account balance is insufficient',
    });
    service.captureRuntimeLog({
      id: 112,
      timestamp: 1_800_000_002_000,
      level: 'error',
      namespace: 'chatluna',
      content: 'ChatLunaError: request failed with code 103',
    });

    await service.sync();
    const pending = await service.list({ view: 'pending', page: 1, pageSize: 20 });
    const detail = await service.detail(pending.items[0].id);

    expect(pending.items).toMatchObject([{
      title: 'chatluna 运行异常',
      occurrenceCount: 2,
    }]);
    expect(detail.occurrences).toHaveLength(2);
    expect(detail.occurrences.map((item) => item.summary)).toEqual(expect.arrayContaining([
      expect.stringContaining('code=30001'),
      expect.stringContaining('code 103'),
    ]));
  });

  it('migrates existing same-title runtime records into one auditable event cluster', async () => {
    const database = createDatabase();
    const now = 1_800_000_000_000;
    for (const [index, details, occurrenceCount] of [
      [1, 'tunnel connection failed: context canceled', 12],
      [2, 'tunnel connection failed: application error 0x0 (remote)', 7],
    ] as const) {
      await database.create('admin_operational_event', {
        sourceKey: `runtime:legacy:${index}`,
        source: 'runtime',
        type: 'runtime_warning',
        severity: 'warning',
        status: 'open',
        resolution: null,
        title: 'cloudflared 运行警告',
        summary: details,
        component: 'cloudflared',
        fingerprint: `legacy-${index}`,
        details,
        occurrenceCount,
        unit: 'cloudflared-qqbot-hbu-jw.service',
        invocationId: `invocation-${index}`,
        memoryJobId: null,
        memoryCandidateId: null,
        occurredAt: now + index,
        lastOccurredAt: now + index,
        acknowledgedAt: null,
        resolvedAt: null,
        updatedAt: now,
      });
    }
    const manager = {
      readServiceFailureJournal: vi.fn(async () => ({ entries: [], cursor: 'cursor-1' })),
      readRuntimeIssueJournal: vi.fn(async () => ({ entries: [], cursor: 'runtime-cursor-1' })),
      getServiceStatuses: vi.fn(async () => []),
      readServiceInvocationJournal: vi.fn(async () => []),
    };
    const service = new OperationalEventService(database as any, manager as any, () => undefined, createLogger());

    await service.sync();
    const pending = await service.list({ view: 'pending', page: 1, pageSize: 20 });
    const history = await service.list({ view: 'history', page: 1, pageSize: 20 });
    const detail = await service.detail(pending.items[0].id);

    expect(pending.items).toMatchObject([{
      title: 'cloudflared 运行警告',
      occurrenceCount: 19,
    }]);
    expect(history.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ resolution: 'deduplicated' }),
    ]));
    expect(detail.occurrences).toHaveLength(2);
    expect(detail.occurrences.reduce((total, item) => total + item.occurrenceCount, 0)).toBe(19);
  });

  it('normalizes volatile journal metadata inside an occurrence variant', async () => {
    const database = createDatabase();
    const manager = {
      readServiceFailureJournal: vi.fn(async () => ({ entries: [], cursor: 'cursor-1' })),
      readRuntimeIssueJournal: vi.fn(async () => ({
        entries: [
          {
            cursor: 'runtime-cloudflare-1',
            unit: 'cloudflared-qqbot-hbu-jw.service',
            invocationId: 'invocation-1',
            priority: 4,
            syslogIdentifier: 'cloudflared',
            messageId: null,
            message: '2026-07-27T03:30:07Z ERR failed to serve tunnel connection error="context canceled" connIndex=0 event=0 ip=2606:4700:a0::10',
            occurredAt: 1_800_000_000_000,
          },
          {
            cursor: 'runtime-cloudflare-2',
            unit: 'cloudflared-qqbot-hbu-jw.service',
            invocationId: 'invocation-1',
            priority: 4,
            syslogIdentifier: 'cloudflared',
            messageId: null,
            message: '2026-07-27T03:31:08Z ERR failed to serve tunnel connection error="context canceled" connIndex=3 event=1 ip=2606:4700:a8::4',
            occurredAt: 1_800_000_001_000,
          },
        ],
        cursor: 'runtime-cloudflare-2',
      })),
      getServiceStatuses: vi.fn(async () => []),
      readServiceInvocationJournal: vi.fn(async () => []),
    };
    const service = new OperationalEventService(database as any, manager as any, () => undefined, createLogger());

    await service.sync();
    const [event] = (await service.list({ view: 'pending', page: 1, pageSize: 20 })).items;
    const detail = await service.detail(event.id);

    expect(event).toMatchObject({ title: 'cloudflared 运行警告', occurrenceCount: 2 });
    expect(detail.occurrences).toMatchObject([{ occurrenceCount: 2 }]);
  });

  it('opens a new pending incident when an acknowledged runtime error recurs', async () => {
    const database = createDatabase();
    const manager = {
      readServiceFailureJournal: vi.fn(async () => ({ entries: [], cursor: 'cursor-1' })),
      readRuntimeIssueJournal: vi.fn(async () => ({ entries: [], cursor: 'runtime-cursor-1' })),
      getServiceStatuses: vi.fn(async () => []),
    };
    const service = new OperationalEventService(database as any, manager as any, () => undefined, createLogger());
    service.captureRuntimeLog({
      id: 201,
      timestamp: 1_800_000_000_000,
      level: 'warn',
      namespace: 'automation',
      content: 'automation job #7 failed: upstream timeout',
    });
    await service.sync();
    const [first] = (await service.list({ view: 'pending', page: 1, pageSize: 20 })).items;
    await service.runAction(first.id, 'acknowledge');

    service.captureRuntimeLog({
      id: 202,
      timestamp: 1_800_000_005_000,
      level: 'warn',
      namespace: 'automation',
      content: 'automation job #7 failed: upstream timeout',
    });
    await service.sync();

    expect((await service.list({ view: 'pending', page: 1, pageSize: 20 })).items).toMatchObject([
      { source: 'runtime', status: 'open', occurrenceCount: 1 },
    ]);
    expect((await service.list({ view: 'history', page: 1, pageSize: 20 })).items).toMatchObject([
      { id: first.id, status: 'acknowledged' },
    ]);
  });

  it('backfills third-party runtime errors from the service journal', async () => {
    const database = createDatabase();
    const manager = {
      readServiceFailureJournal: vi.fn(async () => ({ entries: [], cursor: 'cursor-1' })),
      readRuntimeIssueJournal: vi.fn(async () => ({
        entries: [{
          cursor: 'runtime-entry-1',
          unit: 'qqbot-koishi.service',
          invocationId: 'a030b1fd7f4c49d2b54c3e7c339eb284',
          priority: 6,
          syslogIdentifier: 'env',
          messageId: null,
          message: '2026-07-26 20:26:09 [E] chatluna Error: Call Embedding Error: {"code":30001,"message":"account balance is insufficient"}',
          occurredAt: 1_700_000_000_000,
        }],
        cursor: 'runtime-entry-1',
      })),
      getServiceStatuses: vi.fn(async () => []),
      readServiceInvocationJournal: vi.fn(async () => ['stack line']),
    };
    const service = new OperationalEventService(database as any, manager as any, () => undefined, createLogger());

    await service.sync();
    const [event] = (await service.list({ view: 'pending', page: 1, pageSize: 20 })).items;
    const detail = await service.detail(event.id);

    expect(event).toMatchObject({
      source: 'runtime',
      type: 'runtime_exception',
      component: 'chatluna',
      summary: expect.stringContaining('account balance is insufficient'),
      unit: 'qqbot-koishi.service',
    });
    expect(detail.journal).toEqual(['stack line']);
  });

  it('merges the live logger record with its journal copy without losing the stack', async () => {
    const database = createDatabase();
    const manager = {
      readServiceFailureJournal: vi.fn(async () => ({ entries: [], cursor: 'cursor-1' })),
      readRuntimeIssueJournal: vi.fn(async () => ({
        entries: [{
          cursor: 'runtime-entry-2',
          unit: 'qqbot-koishi.service',
          invocationId: 'a030b1fd7f4c49d2b54c3e7c339eb284',
          priority: 6,
          syslogIdentifier: 'env',
          messageId: null,
          message: '2026-07-27 11:29:49 [E] chatluna Error: Call Embedding Error',
          occurredAt: 1_800_000_000_100,
        }],
        cursor: 'runtime-entry-2',
      })),
      getServiceStatuses: vi.fn(async () => []),
    };
    const service = new OperationalEventService(database as any, manager as any, () => undefined, createLogger());
    service.captureRuntimeLog({
      id: 301,
      timestamp: 1_800_000_000_000,
      level: 'error',
      namespace: 'chatluna',
      content: 'Error: Call Embedding Error\n    at createEmbeddings (adapter.js:10:2)',
    });

    await service.sync();
    const [event] = (await service.list({ view: 'pending', page: 1, pageSize: 20 })).items;

    expect(event).toMatchObject({
      occurrenceCount: 1,
      unit: 'qqbot-koishi.service',
      invocationId: 'a030b1fd7f4c49d2b54c3e7c339eb284',
    });
    expect(event.details).toContain('at createEmbeddings');
  });

  it('collects structured errors emitted by other managed services', async () => {
    const database = createDatabase();
    const manager = {
      readServiceFailureJournal: vi.fn(async () => ({ entries: [], cursor: 'cursor-1' })),
      readRuntimeIssueJournal: vi.fn(async () => ({
        entries: [{
          cursor: 'runtime-entry-3',
          unit: 'qqbot-llbot.service',
          invocationId: 'a030b1fd7f4c49d2b54c3e7c339eb284',
          priority: 6,
          syslogIdentifier: 'env',
          messageId: null,
          message: '{"level":"error","component":"onebot11-adapter","message":"websocket disconnected","token":"must-not-surface"}',
          occurredAt: 1_700_000_000_000,
        }],
        cursor: 'runtime-entry-3',
      })),
      getServiceStatuses: vi.fn(async () => []),
    };
    const service = new OperationalEventService(database as any, manager as any, () => undefined, createLogger());

    await service.sync();
    const [event] = (await service.list({ view: 'pending', page: 1, pageSize: 20 })).items;

    expect(event).toMatchObject({
      source: 'runtime',
      component: 'onebot11-adapter',
      unit: 'qqbot-llbot.service',
    });
    expect(event.details).toContain('websocket disconnected');
    expect(event.details).not.toContain('must-not-surface');
  });

  it('keeps other collectors running when one source fails', async () => {
    const database = createDatabase();
    const manager = {
      readServiceFailureJournal: vi.fn(async () => ({ entries: [], cursor: 'cursor-1' })),
      readRuntimeIssueJournal: vi.fn(async () => {
        throw new Error('journal access denied');
      }),
      getServiceStatuses: vi.fn(async () => []),
    };
    const memoryAdmin = {
      getOperationalAttentionItems: vi.fn(async () => [{
        sourceKey: 'memory-job:8:dead-letter:1800000000000',
        type: 'memory_job_dead_letter',
        severity: 'error',
        title: 'extract 记忆任务进入 dead letter',
        summary: 'provider failed',
        memoryJobId: 8,
        memoryCandidateId: null,
        occurredAt: 1_800_000_000_000,
      }]),
    };
    const service = new OperationalEventService(
      database as any,
      manager as any,
      () => memoryAdmin as any,
      createLogger(),
    );

    await service.sync();
    const pending = await service.list({ view: 'pending', page: 1, pageSize: 20 });

    expect(pending.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'runtime',
        component: 'operational-events',
        summary: expect.stringContaining('runtime journal collection failed'),
      }),
      expect.objectContaining({
        source: 'memory',
        type: 'memory_job_dead_letter',
      }),
    ]));
  });
});
