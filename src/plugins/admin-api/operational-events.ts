import type { Context, Logger } from 'koishi';
import type {
  BotServiceStatus,
  BotServiceUnit,
  OperationalEventAction,
  OperationalEventDetail,
  OperationalEventItem,
  OperationalEventPage,
  OperationalEventResolution,
  OperationalEventSeverity,
  OperationalEventSource,
  OperationalEventStatus,
  OperationalEventType,
} from '../../types/admin.js';
import type { OperationalEventBulkAcknowledgeResult } from '../../admin/contracts/index.js';
import type { MemoryAdminService, MemoryOperationalAttentionItem } from '../memory/index.js';
import { redactAdminLogContent } from './logs.js';
import type { AdminRuntimeManager } from './server.js';

type DatabaseLike = {
  get: (table: string, query: Record<string, unknown>, cursor?: unknown) => Promise<any[]>;
  set: (table: string, query: Record<string, unknown>, data: Record<string, unknown>) => Promise<unknown>;
  create: (table: string, row: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

type OperationalEventRecord = {
  id: number;
  sourceKey: string;
  source: OperationalEventSource;
  type: OperationalEventType;
  severity: OperationalEventSeverity;
  status: OperationalEventStatus;
  resolution: OperationalEventResolution;
  title: string;
  summary: string;
  unit: BotServiceUnit | null;
  invocationId: string | null;
  memoryJobId: number | null;
  memoryCandidateId: number | null;
  occurredAt: number;
  acknowledgedAt: number | null;
  resolvedAt: number | null;
  updatedAt: number;
};

type OperationalEventCursorRecord = {
  id: number;
  source: string;
  cursor: string;
  updatedAt: number;
};

declare module 'koishi' {
  interface Tables {
    admin_operational_event: OperationalEventRecord;
    admin_operational_event_cursor: OperationalEventCursorRecord;
  }
}

type CreateOperationalEvent = Omit<OperationalEventRecord, 'id' | 'status' | 'resolution' | 'acknowledgedAt' | 'resolvedAt' | 'updatedAt'>;

const EVENT_TABLE = 'admin_operational_event';
const CURSOR_TABLE = 'admin_operational_event_cursor';
const JOURNAL_CURSOR_SOURCE = 'systemd-journal';

export function ensureOperationalEventTables(ctx: Context): void {
  ctx.model.extend(EVENT_TABLE, {
    id: 'unsigned',
    sourceKey: 'string',
    source: 'string',
    type: 'string',
    severity: 'string',
    status: 'string',
    resolution: { type: 'string', nullable: true },
    title: 'string',
    summary: 'text',
    unit: { type: 'string', nullable: true },
    invocationId: { type: 'string', nullable: true },
    memoryJobId: { type: 'unsigned', nullable: true },
    memoryCandidateId: { type: 'unsigned', nullable: true },
    occurredAt: 'double',
    acknowledgedAt: { type: 'double', nullable: true },
    resolvedAt: { type: 'double', nullable: true },
    updatedAt: 'double',
  }, {
    autoInc: true,
    unique: ['sourceKey'],
    indexes: [['status', 'occurredAt'], ['source', 'unit'], ['source', 'memoryJobId']],
  });
  ctx.model.extend(CURSOR_TABLE, {
    id: 'unsigned',
    source: 'string',
    cursor: 'text',
    updatedAt: 'double',
  }, {
    autoInc: true,
    unique: ['source'],
  });
}

function targetPath(record: OperationalEventRecord): string {
  if (record.source === 'systemd') return `/runtime/services?unit=${encodeURIComponent(record.unit ?? '')}`;
  if (record.type === 'memory_job_dead_letter') return '/intelligence/memory?tab=jobs';
  return '/intelligence/memory?tab=reviews';
}

function availableActions(record: OperationalEventRecord): OperationalEventAction[] {
  if (record.status === 'resolved') return [];
  const acknowledge: OperationalEventAction[] = record.status === 'open' ? ['acknowledge'] : [];
  if (record.type === 'memory_job_dead_letter') return [...acknowledge, 'retry', 'discard'];
  if (record.source === 'systemd') return [...acknowledge, 'retry'];
  return acknowledge;
}

function toItem(record: OperationalEventRecord): OperationalEventItem {
  return {
    ...record,
    availableActions: availableActions(record),
    targetPath: targetPath(record),
  };
}

export class OperationalEventService {
  private syncPromise: Promise<void> | null = null;

  constructor(
    private readonly database: DatabaseLike,
    private readonly manager: AdminRuntimeManager,
    private readonly getMemoryAdmin: () => MemoryAdminService | undefined,
    private readonly logger: Logger,
  ) {}

  start(ctx: Context): void {
    ctx.on('ready', () => void this.sync().catch((error) => this.logSyncError(error)));
    ctx.setInterval(() => void this.sync().catch((error) => this.logSyncError(error)), 10_000);
  }

  private logSyncError(error: unknown): void {
    this.logger.warn('operational event sync failed: %s', error instanceof Error ? error.message : String(error));
  }

  sync(): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performSync().finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  private async performSync(): Promise<void> {
    await this.collectSystemdFailures();
    const statuses = await this.manager.getServiceStatuses();
    await this.reconcileServiceEvents(statuses);
    await this.reconcileMemoryEvents();
  }

  private async readJournalCursor(): Promise<string | null> {
    const [record] = await this.database.get(CURSOR_TABLE, { source: JOURNAL_CURSOR_SOURCE });
    return record?.cursor ? String(record.cursor) : null;
  }

  private async writeJournalCursor(cursor: string): Promise<void> {
    const [record] = await this.database.get(CURSOR_TABLE, { source: JOURNAL_CURSOR_SOURCE });
    const now = Date.now();
    if (record?.id) {
      await this.database.set(CURSOR_TABLE, { id: record.id }, { cursor, updatedAt: now });
      return;
    }
    await this.database.create(CURSOR_TABLE, { source: JOURNAL_CURSOR_SOURCE, cursor, updatedAt: now });
  }

  private async collectSystemdFailures(): Promise<void> {
    const currentCursor = await this.readJournalCursor();
    const result = await this.manager.readServiceFailureJournal(currentCursor);
    for (const entry of result.entries) {
      await this.openEvent({
        sourceKey: `systemd:${entry.unit}:${entry.invocationId}:start-failed`,
        source: 'systemd',
        type: 'service_start_failed',
        severity: 'error',
        title: `${entry.unit} 启动失败`,
        summary: entry.message,
        unit: entry.unit,
        invocationId: entry.invocationId,
        memoryJobId: null,
        memoryCandidateId: null,
        occurredAt: entry.occurredAt,
      });
    }
    if (result.cursor && result.cursor !== currentCursor) await this.writeJournalCursor(result.cursor);
  }

  private async unresolvedSystemdEvents(unit: BotServiceUnit): Promise<OperationalEventRecord[]> {
    const rows = await this.database.get(EVENT_TABLE, { source: 'systemd', unit });
    return (rows as OperationalEventRecord[]).filter((record) => record.status !== 'resolved');
  }

  private async reconcileServiceEvents(statuses: BotServiceStatus[]): Promise<void> {
    for (const status of statuses) {
      if (status.runtimeState === 'healthy') {
        await this.resolveEvents({ source: 'systemd', unit: status.unit }, 'recovered');
        continue;
      }
      const existing = await this.unresolvedSystemdEvents(status.unit);
      if (status.controllerState.activeState === 'failed' && !existing.length) {
        const invocationId = status.controllerState.invocationId ?? 'unknown';
        await this.openEvent({
          sourceKey: `systemd:${status.unit}:${invocationId}:start-failed`,
          source: 'systemd',
          type: 'service_start_failed',
          severity: 'error',
          title: `${status.description} 启动失败`,
          summary: status.healthDetail,
          unit: status.unit,
          invocationId: status.controllerState.invocationId,
          memoryJobId: null,
          memoryCandidateId: null,
          occurredAt: status.checkedAt,
        });
        continue;
      }
      if (status.runtimeState === 'degraded' && !existing.length) {
        const invocationId = status.controllerState.invocationId ?? 'unknown';
        await this.openEvent({
          sourceKey: `runtime:${status.unit}:${invocationId}:degraded`,
          source: 'systemd',
          type: 'service_controller_mismatch',
          severity: 'warning',
          title: `${status.description} 管理状态异常`,
          summary: status.healthDetail,
          unit: status.unit,
          invocationId: status.controllerState.invocationId,
          memoryJobId: null,
          memoryCandidateId: null,
          occurredAt: status.checkedAt,
        });
      }
    }
  }

  private async reconcileMemoryEvents(): Promise<void> {
    const memoryAdmin = this.getMemoryAdmin();
    if (!memoryAdmin) return;
    const attentionItems = await memoryAdmin.getOperationalAttentionItems();
    const currentKeys = new Set(attentionItems.map((item) => item.sourceKey));
    for (const item of attentionItems) await this.openMemoryEvent(item);
    const existing = await this.database.get(EVENT_TABLE, { source: 'memory' }) as OperationalEventRecord[];
    for (const record of existing) {
      if (record.status === 'resolved' || currentKeys.has(record.sourceKey)) continue;
      await this.resolveEvent(record.id, 'completed');
    }
  }

  private openMemoryEvent(item: MemoryOperationalAttentionItem): Promise<OperationalEventRecord> {
    return this.openEvent({
      sourceKey: item.sourceKey,
      source: 'memory',
      type: item.type,
      severity: item.severity,
      title: item.title,
      summary: redactAdminLogContent(item.summary),
      unit: null,
      invocationId: null,
      memoryJobId: item.memoryJobId,
      memoryCandidateId: item.memoryCandidateId,
      occurredAt: item.occurredAt,
    });
  }

  private async openEvent(input: CreateOperationalEvent): Promise<OperationalEventRecord> {
    const [existing] = await this.database.get(EVENT_TABLE, { sourceKey: input.sourceKey }) as OperationalEventRecord[];
    if (existing) return existing;
    const now = Date.now();
    return this.database.create(EVENT_TABLE, {
      ...input,
      status: 'open',
      resolution: null,
      acknowledgedAt: null,
      resolvedAt: null,
      updatedAt: now,
    }) as Promise<OperationalEventRecord>;
  }

  private async resolveEvents(query: Record<string, unknown>, resolution: Exclude<OperationalEventResolution, null>): Promise<void> {
    const rows = await this.database.get(EVENT_TABLE, query) as OperationalEventRecord[];
    await Promise.all(rows.filter((record) => record.status !== 'resolved').map((record) => this.resolveEvent(record.id, resolution)));
  }

  private async resolveEvent(id: number, resolution: Exclude<OperationalEventResolution, null>): Promise<void> {
    const now = Date.now();
    await this.database.set(EVENT_TABLE, { id }, {
      status: 'resolved',
      resolution,
      resolvedAt: now,
      updatedAt: now,
    });
  }

  async list(input: { view: 'pending' | 'history'; page: number; pageSize: number }): Promise<OperationalEventPage> {
    const records = await this.database.get(EVENT_TABLE, {}) as OperationalEventRecord[];
    const filtered = records
      .filter((record) => input.view === 'pending' ? record.status === 'open' : record.status !== 'open')
      .sort((left, right) => right.occurredAt - left.occurredAt);
    const offset = (input.page - 1) * input.pageSize;
    return {
      items: filtered.slice(offset, offset + input.pageSize).map(toItem),
      total: filtered.length,
      openCount: records.filter((record) => record.status === 'open').length,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  async summary(): Promise<{ openCount: number; pending: OperationalEventItem[] }> {
    const records = await this.database.get(EVENT_TABLE, {}) as OperationalEventRecord[];
    const pending = records
      .filter((record) => record.status === 'open')
      .sort((left, right) => right.occurredAt - left.occurredAt);
    return {
      openCount: pending.length,
      pending: pending.slice(0, 5).map(toItem),
    };
  }

  private async getRecord(id: number): Promise<OperationalEventRecord> {
    const [record] = await this.database.get(EVENT_TABLE, { id }) as OperationalEventRecord[];
    if (!record) throw new Error(`找不到运行事件：${id}`);
    return record;
  }

  async detail(id: number): Promise<OperationalEventDetail> {
    const record = await this.getRecord(id);
    const journal = record.unit && record.invocationId
      ? (await this.manager.readServiceInvocationJournal(record.unit, record.invocationId))
        .map((line) => redactAdminLogContent(line))
      : [];
    return { ...toItem(record), journal };
  }

  async runAction(id: number, action: OperationalEventAction): Promise<OperationalEventItem> {
    const record = await this.getRecord(id);
    if (!availableActions(record).includes(action)) throw new Error(`事件 ${id} 不支持操作 ${action}`);
    if (action === 'acknowledge') {
      const now = Date.now();
      await this.database.set(EVENT_TABLE, { id }, { status: 'acknowledged', acknowledgedAt: now, updatedAt: now });
      return toItem(await this.getRecord(id));
    }
    if (record.source === 'systemd' && record.unit) {
      const status = await this.manager.getServiceStatus(record.unit);
      await this.manager.runServiceAction(record.unit, status.controllerState.activeState === 'active' ? 'restart' : 'start');
      const next = await this.manager.getServiceStatus(record.unit);
      if (next.runtimeState === 'healthy') await this.resolveEvent(id, 'retried');
      return toItem(await this.getRecord(id));
    }
    if (record.type === 'memory_job_dead_letter' && record.memoryJobId) {
      const memoryAdmin = this.getMemoryAdmin();
      if (!memoryAdmin) throw new Error('memory admin 当前不可用');
      if (action === 'retry') await memoryAdmin.retryDeadLetterJob(record.memoryJobId);
      if (action === 'discard') await memoryAdmin.discardDeadLetterJob(record.memoryJobId);
      await this.resolveEvent(id, action === 'retry' ? 'retried' : 'discarded');
      return toItem(await this.getRecord(id));
    }
    throw new Error(`事件 ${id} 无法执行 ${action}`);
  }

  async acknowledgeAll(): Promise<OperationalEventBulkAcknowledgeResult> {
    const records = await this.database.get(EVENT_TABLE, { status: 'open' }) as OperationalEventRecord[];
    if (!records.length) return { acknowledgedCount: 0 };
    const now = Date.now();
    await this.database.set(
      EVENT_TABLE,
      { status: 'open' },
      { status: 'acknowledged', acknowledgedAt: now, updatedAt: now },
    );
    return { acknowledgedCount: records.length };
  }
}
