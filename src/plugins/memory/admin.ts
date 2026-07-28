import type {
  MemoryAssertionType,
  MemoryAudiencePolicy,
  MemoryFactKind,
  MemoryHeadState,
  MemorySensitivity,
  MemoryV3EvidenceRecord,
  MemoryV3HeadRecord,
  MemoryV3PayloadRecord,
  MemoryV3WorkRecord,
} from '../../types/memory.js';
import { MEMORY_LEDGER_TABLES } from './schema.js';
import type { MemoryDatabaseLike, MemoryStore } from './store.js';
import type { MemoryRuntimeConfig } from './config.js';
import { MemoryRuntimeError, type MemoryOperation } from './errors.js';
import { parseAudienceSnapshots } from './policy.js';

export interface MemoryAdminPageQuery {
  page: number;
  pageSize: number;
  subjectKey?: string;
  contextKey?: string;
  state?: MemoryHeadState;
  assertionType?: MemoryAssertionType;
}

export interface MemoryAdminPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface MemoryAdminAssertionItem {
  streamId: string;
  revision: number;
  state: MemoryHeadState;
  assertionType: MemoryAssertionType;
  kind: MemoryFactKind | null;
  topicKey: string;
  subjectKey: string;
  sourceContextKey: string;
  audiencePolicy: MemoryAudiencePolicy;
  audienceContextKeys: string[];
  audienceSnapshots: Record<string, string[]>;
  sensitivity: MemorySensitivity;
  content: string | null;
  evidenceMessageIds: string[];
  importance: number;
  confidence: number;
  updatedAt: number;
}

export interface MemoryAdminReviewItem extends MemoryAdminAssertionItem {
  state: 'pendingReview';
}

export interface MemoryOperationalAttentionItem {
  key: string;
  type: 'memory_work_dead_letter' | 'memory_review_pending';
  title: string;
  detail: string;
  occurredAt: number;
  memoryWorkId?: number;
  streamId?: string;
}

function parseStringArray(raw: string): string[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('memory audience context list is invalid');
  }
  return value;
}

function normalizePage(query: MemoryAdminPageQuery): { page: number; pageSize: number } {
  return {
    page: Math.max(1, Math.floor(query.page)),
    pageSize: Math.min(100, Math.max(1, Math.floor(query.pageSize))),
  };
}

export class MemoryAdminService {
  constructor(
    private readonly database: MemoryDatabaseLike,
    private readonly store: MemoryStore,
    private readonly runtime: Pick<MemoryRuntimeConfig, 'maintenance'>,
  ) {}

  private assertOperational(operation: MemoryOperation): void {
    if (this.runtime.maintenance) {
      throw new MemoryRuntimeError(
        operation,
        'validation',
        'memory_maintenance_mode',
        'Memory content and mutation APIs are unavailable during maintenance.',
      );
    }
  }

  private async toItem(head: MemoryV3HeadRecord): Promise<MemoryAdminAssertionItem> {
    const [payload] = head.payloadId
      ? await this.database.get(MEMORY_LEDGER_TABLES.payload, { payloadId: head.payloadId }) as MemoryV3PayloadRecord[]
      : [];
    const evidence = payload
      ? await this.database.get(
          MEMORY_LEDGER_TABLES.evidence,
          { eventId: payload.eventId },
        ) as MemoryV3EvidenceRecord[]
      : [];
    return {
      streamId: head.streamId,
      revision: head.revision,
      state: head.state,
      assertionType: head.assertionType,
      kind: head.kind,
      topicKey: head.topicKey,
      subjectKey: head.subjectKey,
      sourceContextKey: head.sourceContextKey,
      audiencePolicy: head.audiencePolicy,
      audienceContextKeys: parseStringArray(head.audienceContextKeys),
      audienceSnapshots: parseAudienceSnapshots(head.audienceSnapshots),
      sensitivity: head.sensitivity,
      content: payload?.content ?? null,
      evidenceMessageIds: evidence.map((item) => item.messageId),
      importance: head.importance,
      confidence: head.confidence,
      updatedAt: head.updatedAt,
    };
  }

  async getAssertionsPage(
    query: MemoryAdminPageQuery,
  ): Promise<MemoryAdminPage<MemoryAdminAssertionItem>> {
    this.assertOperational('recall');
    const { page, pageSize } = normalizePage(query);
    const rows = await this.database.get(MEMORY_LEDGER_TABLES.head, {}) as MemoryV3HeadRecord[];
    const filtered = rows.filter((row) => {
      if (query.subjectKey && row.subjectKey !== query.subjectKey) return false;
      if (query.contextKey && row.sourceContextKey !== query.contextKey) return false;
      if (query.state && row.state !== query.state) return false;
      if (query.assertionType && row.assertionType !== query.assertionType) return false;
      return true;
    }).sort((left, right) => right.updatedAt - left.updatedAt || left.streamId.localeCompare(right.streamId));
    const offset = (page - 1) * pageSize;
    return {
      items: await Promise.all(filtered.slice(offset, offset + pageSize).map((row) => this.toItem(row))),
      page,
      pageSize,
      total: filtered.length,
    };
  }

  async getReviewsPage(
    query: Omit<MemoryAdminPageQuery, 'state'>,
  ): Promise<MemoryAdminPage<MemoryAdminReviewItem>> {
    const page = await this.getAssertionsPage({ ...query, state: 'pendingReview' });
    return page as MemoryAdminPage<MemoryAdminReviewItem>;
  }

  async review(input: {
    streamId: string;
    decision: 'approve' | 'reject';
  }): Promise<void> {
    this.assertOperational('review');
    await this.store.review({
      streamId: input.streamId,
      actor: { userKey: 'admin', isDirect: false, isAdmin: true },
      decision: input.decision,
    });
  }

  async archive(input: {
    streamId: string;
    reasonCode?: string;
  }): Promise<void> {
    this.assertOperational('archive');
    await this.store.archive({
      streamId: input.streamId,
      actor: { userKey: 'admin', isDirect: false, isAdmin: true },
      reasonCode: input.reasonCode,
    });
  }

  async forget(input: {
    streamId?: string;
    subjectKey?: string;
    contextKey?: string;
    all?: boolean;
    reasonCode: string;
  }): Promise<number> {
    this.assertOperational('forget');
    if (!input.streamId && !input.subjectKey) {
      throw new Error('admin memory forget requires streamId or subjectKey');
    }
    return this.store.forget({
      actor: {
        userKey: input.subjectKey ?? 'admin',
        isDirect: false,
        isAdmin: true,
      },
      streamId: input.streamId,
      contextKey: input.contextKey,
      all: input.all ?? Boolean(input.subjectKey && !input.contextKey && !input.streamId),
      reasonCode: input.reasonCode,
    });
  }

  async getOperationalAttentionItems(): Promise<MemoryOperationalAttentionItem[]> {
    const [deadLetters, reviews] = await Promise.all([
      this.database.get(MEMORY_LEDGER_TABLES.work, { status: 'deadLetter' }) as Promise<MemoryV3WorkRecord[]>,
      this.database.get(MEMORY_LEDGER_TABLES.head, { state: 'pendingReview' }) as Promise<MemoryV3HeadRecord[]>,
    ]);
    return [
      ...deadLetters.map((row) => ({
        key: `memory-work:${row.id}`,
        type: 'memory_work_dead_letter' as const,
        title: `${row.workType} 记忆任务失败`,
        detail: `${row.lastErrorStage ?? 'unknown'}/${row.lastErrorCode ?? 'unknown'}`,
        occurredAt: row.completedAt ?? row.updatedAt,
        memoryWorkId: row.id,
      })),
      ...reviews.map((row) => ({
        key: `memory-review:${row.streamId}`,
        type: 'memory_review_pending' as const,
        title: '记忆等待主体审核',
        detail: `${row.assertionType} · ${row.sensitivity}`,
        occurredAt: row.updatedAt,
        streamId: row.streamId,
      })),
    ].sort((left, right) => right.occurredAt - left.occurredAt);
  }
}
