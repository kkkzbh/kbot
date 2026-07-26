import type {
  MemoryOutputProtocolId,
  MemoryStatusSource,
  MemoryOperationSnapshot,
  MemoryProbeResult,
  MemoryProviderRouteStats,
  MemoryQueueSummary,
  MemoryStatusServiceLike,
  MemoryStatusSnapshot,
} from '../../types/memory.js';
import type { ModelRuntimeClient } from '../model-config/index.js';
import { createUnavailableMemoryStatusSnapshot } from '../shared/memory-status.js';
import {
  isEmbeddingWorkloadEnabled,
} from './providers/embedding-client.js';
import {
  isMemoryExtractWorkloadEnabled,
} from './providers/router.js';

export { createUnavailableMemoryStatusSnapshot };

interface OperationStatusDraft {
  state: 'never' | 'success' | 'failed';
  lastSource: MemoryStatusSource;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface MemoryStatusRuntimeLike {
  enabled: boolean;
  readEnabled: boolean;
  writeEnabled: boolean;
}

function createEmptyOperationStatus(): OperationStatusDraft {
  return {
    state: 'never',
    lastSource: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastLatencyMs: null,
    lastError: null,
    consecutiveFailures: 0,
  };
}

function toErrorSummary(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function toOperationSnapshot(draft: OperationStatusDraft, configured: boolean): MemoryOperationSnapshot {
  return {
    configured,
    state: draft.state,
    lastSource: draft.lastSource,
    lastAttemptAt: draft.lastAttemptAt,
    lastSuccessAt: draft.lastSuccessAt,
    lastFailureAt: draft.lastFailureAt,
    lastLatencyMs: draft.lastLatencyMs,
    lastError: draft.lastError,
    consecutiveFailures: draft.consecutiveFailures,
  };
}

export class MemoryStatusService implements MemoryStatusServiceLike {
  private readonly extract = createEmptyOperationStatus();
  private readonly embed = createEmptyOperationStatus();
  private lastMaintenanceAt: number | null = null;
  private readonly routeStats = new Map<MemoryOutputProtocolId, MemoryProviderRouteStats>();

  constructor(
    private readonly runtime: MemoryStatusRuntimeLike,
    private readonly modelRuntime: ModelRuntimeClient,
    private readonly store: { getJobSummary: () => Promise<MemoryQueueSummary> },
    private readonly embedProbe: () => Promise<void>,
    private readonly extractionProbe: () => Promise<void>,
  ) {}

  recordAttempt(kind: 'extract' | 'embed', source: Exclude<MemoryStatusSource, null>, at = Date.now()): void {
    const target = kind === 'extract' ? this.extract : this.embed;
    target.lastSource = source;
    target.lastAttemptAt = at;
  }

  recordSuccess(kind: 'extract' | 'embed', source: Exclude<MemoryStatusSource, null>, latencyMs: number, at = Date.now()): void {
    const target = kind === 'extract' ? this.extract : this.embed;
    target.state = 'success';
    target.lastSource = source;
    target.lastAttemptAt = at;
    target.lastSuccessAt = at;
    target.lastLatencyMs = latencyMs;
    target.lastError = null;
    target.consecutiveFailures = 0;
  }

  recordFailure(kind: 'extract' | 'embed', source: Exclude<MemoryStatusSource, null>, error: unknown, latencyMs: number | null = null, at = Date.now()): void {
    const target = kind === 'extract' ? this.extract : this.embed;
    target.state = 'failed';
    target.lastSource = source;
    target.lastAttemptAt = at;
    target.lastFailureAt = at;
    target.lastLatencyMs = latencyMs;
    target.lastError = toErrorSummary(error);
    target.consecutiveFailures += 1;
  }

  recordRoute(route: MemoryOutputProtocolId, ok: boolean, error: string | null = null): void {
    const current = this.routeStats.get(route) ?? { route, success: 0, failure: 0, lastError: null };
    if (ok) {
      current.success += 1;
      current.lastError = null;
    } else {
      current.failure += 1;
      current.lastError = error;
    }
    this.routeStats.set(route, current);
  }

  recordMaintenance(at = Date.now()): void {
    this.lastMaintenanceAt = at;
  }

  async getSnapshot(): Promise<MemoryStatusSnapshot> {
    const jobs = await this.store.getJobSummary();
    const extractBinding = this.modelRuntime.resolve('memory.extract');
    const embedBinding = this.modelRuntime.resolve('memory.embedding');
    const extractConfigured = isMemoryExtractWorkloadEnabled(this.modelRuntime);
    const embedConfigured = isEmbeddingWorkloadEnabled(this.modelRuntime);
    return {
      available: true,
      enabled: this.runtime.enabled,
      readEnabled: this.runtime.readEnabled,
      writeEnabled: this.runtime.writeEnabled,
      extractConfigured,
      embedConfigured,
      extractModel: extractBinding.model ?? '',
      embedModel: embedBinding.model ?? '',
      jobs,
      providerRoutes: [...this.routeStats.values()],
      lastMaintenanceAt: this.lastMaintenanceAt,
      extract: toOperationSnapshot(this.extract, extractConfigured),
      embed: toOperationSnapshot(this.embed, embedConfigured),
    };
  }

  async probeEmbedding(): Promise<MemoryProbeResult> {
    return this.runProbe(
      'embedding',
      'embed',
      this.embedProbe,
      isEmbeddingWorkloadEnabled(this.modelRuntime),
    );
  }

  async probeExtraction(): Promise<MemoryProbeResult> {
    return this.runProbe(
      'extraction',
      'extract',
      this.extractionProbe,
      isMemoryExtractWorkloadEnabled(this.modelRuntime),
    );
  }

  private async runProbe(
    target: MemoryProbeResult['target'],
    kind: 'extract' | 'embed',
    probe: () => Promise<void>,
    configured: boolean,
  ): Promise<MemoryProbeResult> {
    const checkedAt = Date.now();
    if (!this.runtime.enabled) {
      return {
        target,
        ok: false,
        checkedAt,
        latencyMs: null,
        error: 'memory disabled',
        snapshot: await this.getSnapshot(),
      };
    }
    if (!configured) {
      return {
        target,
        ok: false,
        checkedAt,
        latencyMs: null,
        error: `${target} runtime is not configured`,
        snapshot: await this.getSnapshot(),
      };
    }

    this.recordAttempt(kind, 'probe', checkedAt);
    const startedAt = Date.now();
    try {
      await probe();
      const latencyMs = Math.max(0, Date.now() - startedAt);
      this.recordSuccess(kind, 'probe', latencyMs, Date.now());
      return {
        target,
        ok: true,
        checkedAt: Date.now(),
        latencyMs,
        error: null,
        snapshot: await this.getSnapshot(),
      };
    } catch (error) {
      const latencyMs = Math.max(0, Date.now() - startedAt);
      this.recordFailure(kind, 'probe', error, latencyMs, Date.now());
      return {
        target,
        ok: false,
        checkedAt: Date.now(),
        latencyMs,
        error: toErrorSummary(error),
        snapshot: await this.getSnapshot(),
      };
    }
  }
}
