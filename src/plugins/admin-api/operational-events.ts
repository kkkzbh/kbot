import { createHash } from 'node:crypto';
import type { Context, Logger } from 'koishi';
import type { AdminLogEntry } from '../../admin/contracts/index.js';
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
  component: string | null;
  fingerprint: string | null;
  details: string | null;
  occurrenceCount: number | null;
  unit: BotServiceUnit | null;
  invocationId: string | null;
  memoryJobId: number | null;
  memoryCandidateId: number | null;
  occurredAt: number;
  lastOccurredAt: number | null;
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

type EventDefaults =
  | 'component'
  | 'fingerprint'
  | 'details'
  | 'occurrenceCount'
  | 'lastOccurredAt';
type CreateOperationalEvent = Omit<
  OperationalEventRecord,
  'id' | 'status' | 'resolution' | 'acknowledgedAt' | 'resolvedAt' | 'updatedAt' | EventDefaults
> & Partial<Pick<OperationalEventRecord, EventDefaults>>;

type RuntimeIssue = {
  severity: OperationalEventSeverity;
  component: string;
  content: string;
  occurredAt: number;
  occurrenceId: string;
  unit: BotServiceUnit | null;
  invocationId: string | null;
};

const EVENT_TABLE = 'admin_operational_event';
const CURSOR_TABLE = 'admin_operational_event_cursor';
const SYSTEMD_FAILURE_CURSOR_SOURCE = 'systemd-failure-journal';
const RUNTIME_ISSUE_CURSOR_SOURCE = 'runtime-issue-journal';
const SYSTEMD_JOB_FAILED_MESSAGE_ID = 'be02cf6855d2428ba40df7e9d022f03d';
const MAX_PENDING_RUNTIME_LOGS = 5_000;
const MAX_RUNTIME_EVENT_DETAILS = 64_000;
const LIVE_JOURNAL_DUPLICATE_WINDOW_MS = 500;
const KOISHI_LOG_PATTERN = /^(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+)?\[([EW])\]\s+(\S+)\s+([\s\S]+)$/u;
const EXTERNAL_LOG_LEVEL_PATTERN = /\[(ERROR|WARN(?:ING)?|FATAL|CRITICAL)\]/iu;
const RUNTIME_FAILURE_PATTERN = /\b(?:uncaught|unhandled rejection|fatal|panic|traceback|exception|error:|failed(?:\s|:)|failure(?:\s|:))\b/iu;
const DECORATIVE_ERROR_PATTERN = /^=+[^=].*=+$/u;

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
    component: { type: 'string', nullable: true },
    fingerprint: { type: 'string', nullable: true },
    details: { type: 'text', nullable: true },
    occurrenceCount: { type: 'unsigned', nullable: true },
    unit: { type: 'string', nullable: true },
    invocationId: { type: 'string', nullable: true },
    memoryJobId: { type: 'unsigned', nullable: true },
    memoryCandidateId: { type: 'unsigned', nullable: true },
    occurredAt: 'double',
    lastOccurredAt: { type: 'double', nullable: true },
    acknowledgedAt: { type: 'double', nullable: true },
    resolvedAt: { type: 'double', nullable: true },
    updatedAt: 'double',
  }, {
    autoInc: true,
    unique: ['sourceKey'],
    indexes: [
      ['status', 'lastOccurredAt'],
      ['source', 'unit'],
      ['source', 'memoryJobId'],
      ['source', 'fingerprint'],
    ],
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

function normalizeRuntimeFingerprintContent(content: string): string {
  return content
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, '<uuid>')
    .replace(/\b(?:request|message|conversation|room|job|owner|user)(?:Id)?[=:#]\s*[^\s,;]+/giu, '$1=<id>')
    .replace(/#\d+\b/gu, '#<id>')
    .replace(/\b\d{10,}\b/gu, '<number>')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 2_000);
}

function runtimeFingerprint(issue: RuntimeIssue): string {
  return createHash('sha256')
    .update(`${issue.component}\0${issue.severity}\0${normalizeRuntimeFingerprintContent(runtimeSummary(issue.content))}`)
    .digest('hex')
    .slice(0, 24);
}

function runtimeSummary(content: string): string {
  const firstMeaningfulLine = content
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .find((line) => line && !DECORATIVE_ERROR_PATTERN.test(line));
  return (firstMeaningfulLine || content.trim() || '运行时报告了未说明原因的异常。').slice(0, 1_000);
}

function runtimeTitle(issue: RuntimeIssue): string {
  return `${issue.component} ${issue.severity === 'error' ? '运行异常' : '运行警告'}`;
}

function runtimeIssueFromLog(entry: AdminLogEntry): RuntimeIssue | null {
  if (entry.level !== 'error' && entry.level !== 'warn') return null;
  if (entry.namespace === 'admin-api' && entry.content.startsWith('operational event ')) return null;
  if (DECORATIVE_ERROR_PATTERN.test(entry.content.trim())) return null;
  return {
    severity: entry.level === 'error' ? 'error' : 'warning',
    component: entry.namespace,
    content: entry.content,
    occurredAt: entry.timestamp,
    occurrenceId: `logger-${entry.id}`,
    unit: null,
    invocationId: null,
  };
}

function runtimeIssueFromJournal(
  entry: Awaited<ReturnType<AdminRuntimeManager['readRuntimeIssueJournal']>>['entries'][number],
): RuntimeIssue | null {
  if (!entry.message || entry.messageId === SYSTEMD_JOB_FAILED_MESSAGE_ID) return null;
  const koishiLog = entry.message.match(KOISHI_LOG_PATTERN);
  if (koishiLog) {
    const [, level, component, content] = koishiLog;
    if (DECORATIVE_ERROR_PATTERN.test(content.trim())) return null;
    return {
      severity: level === 'E' ? 'error' : 'warning',
      component,
      content,
      occurredAt: entry.occurredAt,
      occurrenceId: entry.cursor,
      unit: entry.unit,
      invocationId: entry.invocationId,
    };
  }
  if (entry.message.startsWith('{')) {
    try {
      const payload = JSON.parse(entry.message) as Record<string, unknown>;
      const level = String(payload.level ?? payload.severity ?? '').toLowerCase();
      if (['error', 'fatal', 'critical', 'warn', 'warning'].includes(level)) {
        return {
          severity: ['error', 'fatal', 'critical'].includes(level) ? 'error' : 'warning',
          component: String(payload.component ?? payload.logger ?? entry.syslogIdentifier ?? entry.unit),
          content: entry.message,
          occurredAt: entry.occurredAt,
          occurrenceId: entry.cursor,
          unit: entry.unit,
          invocationId: entry.invocationId,
        };
      }
    } catch {
      // Non-JSON service output continues through the plain-text classifiers below.
    }
  }
  const externalLevel = entry.message.match(EXTERNAL_LOG_LEVEL_PATTERN)?.[1]?.toUpperCase();
  if (externalLevel) {
    return {
      severity: externalLevel === 'WARN' || externalLevel === 'WARNING' ? 'warning' : 'error',
      component: entry.syslogIdentifier || entry.unit,
      content: entry.message,
      occurredAt: entry.occurredAt,
      occurrenceId: entry.cursor,
      unit: entry.unit,
      invocationId: entry.invocationId,
    };
  }
  if (!RUNTIME_FAILURE_PATTERN.test(entry.message) && (entry.priority == null || entry.priority > 4)) return null;
  return {
    severity: entry.priority != null && entry.priority <= 3 ? 'error' : 'warning',
    component: entry.syslogIdentifier || entry.unit,
    content: entry.message,
    occurredAt: entry.occurredAt,
    occurrenceId: entry.cursor,
    unit: entry.unit,
    invocationId: entry.invocationId,
  };
}

function targetPath(record: OperationalEventRecord): string {
  if (record.source === 'systemd') return `/?service=${encodeURIComponent(record.unit ?? '')}`;
  if (record.source === 'runtime') return '/runtime/logs';
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
    component: record.component ?? (record.unit || null),
    fingerprint: record.fingerprint ?? null,
    details: record.details ?? record.summary,
    occurrenceCount: Math.max(1, record.occurrenceCount ?? 1),
    lastOccurredAt: record.lastOccurredAt ?? record.occurredAt,
    availableActions: availableActions(record),
    targetPath: targetPath(record),
  };
}

export class OperationalEventService {
  private syncPromise: Promise<void> | null = null;
  private readonly pendingRuntimeLogs: AdminLogEntry[] = [];
  private droppedRuntimeLogs = 0;

  constructor(
    private readonly database: DatabaseLike,
    private readonly manager: AdminRuntimeManager,
    private readonly getMemoryAdmin: () => MemoryAdminService | undefined,
    private readonly logger: Logger,
  ) {}

  captureRuntimeLog(entry: AdminLogEntry): void {
    if (entry.level !== 'error' && entry.level !== 'warn') return;
    this.pendingRuntimeLogs.push(entry);
    if (this.pendingRuntimeLogs.length <= MAX_PENDING_RUNTIME_LOGS) return;
    const overflow = this.pendingRuntimeLogs.length - MAX_PENDING_RUNTIME_LOGS;
    this.pendingRuntimeLogs.splice(0, overflow);
    this.droppedRuntimeLogs += overflow;
  }

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
    await this.collectLiveRuntimeIssues();
    await this.runCollector('runtime journal collection', () => this.collectJournalRuntimeIssues());
    await this.runCollector('systemd failure collection', () => this.collectSystemdFailures());
    await this.runCollector('service health reconciliation', async () => {
      const statuses = await this.manager.getServiceStatuses();
      await this.reconcileServiceEvents(statuses);
    });
    await this.runCollector('memory event reconciliation', () => this.reconcileMemoryEvents());
  }

  private async runCollector(stage: string, collect: () => Promise<void>): Promise<void> {
    try {
      await collect();
    } catch (error) {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      await this.openRuntimeEvent({
        severity: 'error',
        component: 'operational-events',
        content: `${stage} failed: ${detail}`,
        occurredAt: Date.now(),
        occurrenceId: `collector-${stage}-${Date.now()}`,
        unit: null,
        invocationId: null,
      });
    }
  }

  private async readJournalCursor(source: string): Promise<string | null> {
    const [record] = await this.database.get(CURSOR_TABLE, { source });
    return record?.cursor ? String(record.cursor) : null;
  }

  private async writeJournalCursor(source: string, cursor: string): Promise<void> {
    const [record] = await this.database.get(CURSOR_TABLE, { source });
    const now = Date.now();
    if (record?.id) {
      await this.database.set(CURSOR_TABLE, { id: record.id }, { cursor, updatedAt: now });
      return;
    }
    await this.database.create(CURSOR_TABLE, { source, cursor, updatedAt: now });
  }

  private async collectLiveRuntimeIssues(): Promise<void> {
    if (this.droppedRuntimeLogs > 0) {
      const dropped = this.droppedRuntimeLogs;
      await this.openRuntimeEvent({
        severity: 'error',
        component: 'operational-events',
        content: `运行异常采集队列溢出，${dropped} 条日志记录未能持久化。`,
        occurredAt: Date.now(),
        occurrenceId: `overflow-${Date.now()}`,
        unit: null,
        invocationId: null,
      });
      this.droppedRuntimeLogs -= dropped;
    }
    while (this.pendingRuntimeLogs.length > 0) {
      const entry = this.pendingRuntimeLogs[0];
      const issue = runtimeIssueFromLog(entry);
      if (issue) await this.openRuntimeEvent(issue);
      this.pendingRuntimeLogs.shift();
    }
  }

  private async collectJournalRuntimeIssues(): Promise<void> {
    const currentCursor = await this.readJournalCursor(RUNTIME_ISSUE_CURSOR_SOURCE);
    const result = await this.manager.readRuntimeIssueJournal(currentCursor);
    for (const entry of result.entries) {
      const issue = runtimeIssueFromJournal(entry);
      if (issue) await this.openRuntimeEvent(issue);
    }
    if (result.cursor && result.cursor !== currentCursor) {
      await this.writeJournalCursor(RUNTIME_ISSUE_CURSOR_SOURCE, result.cursor);
    }
  }

  private async openRuntimeEvent(issue: RuntimeIssue): Promise<OperationalEventRecord> {
    const redacted = redactAdminLogContent(issue.content);
    const redactedContent = redacted.length > MAX_RUNTIME_EVENT_DETAILS
      ? `${redacted.slice(0, MAX_RUNTIME_EVENT_DETAILS)}\n[TRUNCATED]`
      : redacted;
    const normalizedIssue = { ...issue, content: redactedContent };
    const fingerprint = runtimeFingerprint(normalizedIssue);
    const records = await this.database.get(EVENT_TABLE, {
      source: 'runtime',
      fingerprint,
    }) as OperationalEventRecord[];
    const existing = records
      .filter((record) => record.status === 'open')
      .sort((left, right) => (
        (right.lastOccurredAt ?? right.occurredAt) - (left.lastOccurredAt ?? left.occurredAt)
      ))[0];
    const summary = runtimeSummary(redactedContent);
    if (existing) {
      const existingLastOccurredAt = existing.lastOccurredAt ?? existing.occurredAt;
      const duplicateLiveJournalRecord = existing.unit == null
        && issue.unit != null
        && Math.abs(existingLastOccurredAt - issue.occurredAt) <= LIVE_JOURNAL_DUPLICATE_WINDOW_MS;
      await this.database.set(EVENT_TABLE, { id: existing.id }, {
        severity: existing.severity === 'error' ? 'error' : issue.severity,
        summary,
        details: duplicateLiveJournalRecord ? existing.details ?? redactedContent : redactedContent,
        occurrenceCount: Math.max(1, existing.occurrenceCount ?? 1) + (duplicateLiveJournalRecord ? 0 : 1),
        lastOccurredAt: Math.max(existingLastOccurredAt, issue.occurredAt),
        unit: existing.unit ?? issue.unit,
        invocationId: existing.invocationId ?? issue.invocationId,
        updatedAt: Date.now(),
      });
      const [updated] = await this.database.get(EVENT_TABLE, { id: existing.id }) as OperationalEventRecord[];
      return updated;
    }
    return this.openEvent({
      sourceKey: `runtime:${fingerprint}:${issue.occurrenceId}`,
      source: 'runtime',
      type: issue.severity === 'error' ? 'runtime_exception' : 'runtime_warning',
      severity: issue.severity,
      title: runtimeTitle(issue),
      summary,
      component: issue.component,
      fingerprint,
      details: redactedContent,
      occurrenceCount: 1,
      unit: issue.unit,
      invocationId: issue.invocationId,
      memoryJobId: null,
      memoryCandidateId: null,
      occurredAt: issue.occurredAt,
      lastOccurredAt: issue.occurredAt,
    });
  }

  private async collectSystemdFailures(): Promise<void> {
    const currentCursor = await this.readJournalCursor(SYSTEMD_FAILURE_CURSOR_SOURCE);
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
    if (result.cursor && result.cursor !== currentCursor) {
      await this.writeJournalCursor(SYSTEMD_FAILURE_CURSOR_SOURCE, result.cursor);
    }
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
      component: input.component ?? input.unit ?? null,
      fingerprint: input.fingerprint ?? null,
      details: input.details ?? input.summary,
      occurrenceCount: input.occurrenceCount ?? 1,
      lastOccurredAt: input.lastOccurredAt ?? input.occurredAt,
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
      .sort((left, right) => (
        (right.lastOccurredAt ?? right.occurredAt) - (left.lastOccurredAt ?? left.occurredAt)
      ));
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
      .sort((left, right) => (
        (right.lastOccurredAt ?? right.occurredAt) - (left.lastOccurredAt ?? left.occurredAt)
      ));
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
