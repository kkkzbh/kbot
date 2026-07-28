import type {
  MemoryOperationSnapshot,
  MemoryOutputProtocolId,
  MemoryProbeResult,
  MemoryProviderRouteStats,
  MemorySearchMetrics,
  MemoryStatusServiceLike,
  MemoryStatusSnapshot,
  MemoryStatusSource,
} from '../../types/memory.js';
import type { ModelRuntimeClient } from '../model-config/index.js';
import { createUnavailableMemoryStatusSnapshot } from '../shared/memory-status.js';
import { memorySafeErrorMessage } from './errors.js';
import { isMemoryExtractWorkloadEnabled } from './providers/router.js';
import type { MemoryStore } from './store.js';

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
  maintenance: boolean;
  readEnabled: boolean;
  writeEnabled: boolean;
}

export interface MemoryProbeSemanticResult {
  canonicalModel: string;
  schemaValid: true;
}

function emptyOperation(): OperationStatusDraft {
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

function operationSnapshot(
  draft: OperationStatusDraft,
  configured: boolean,
): MemoryOperationSnapshot {
  return { ...draft, configured };
}

export class MemoryStatusService implements MemoryStatusServiceLike {
  private readonly extract = emptyOperation();
  private lastMaintenanceAt: number | null = null;
  private readonly routeStats = new Map<MemoryOutputProtocolId, MemoryProviderRouteStats>();
  private readonly searchMetrics: MemorySearchMetrics = {
    searches: 0,
    recentReads: 0,
    returnedItems: 0,
    rejectedCalls: 0,
    lastSearchAt: null,
  };

  constructor(
    private readonly runtime: MemoryStatusRuntimeLike,
    private readonly modelRuntime: ModelRuntimeClient,
    private readonly store: MemoryStore,
    private readonly extractionProbe: () => Promise<MemoryProbeSemanticResult>,
  ) {}

  recordAttempt(
    source: Exclude<MemoryStatusSource, null>,
    at = Date.now(),
  ): void {
    this.extract.lastSource = source;
    this.extract.lastAttemptAt = at;
  }

  recordSuccess(
    source: Exclude<MemoryStatusSource, null>,
    latencyMs: number,
    at = Date.now(),
  ): void {
    this.extract.state = 'success';
    this.extract.lastSource = source;
    this.extract.lastAttemptAt = at;
    this.extract.lastSuccessAt = at;
    this.extract.lastLatencyMs = latencyMs;
    this.extract.lastError = null;
    this.extract.consecutiveFailures = 0;
  }

  recordFailure(
    source: Exclude<MemoryStatusSource, null>,
    error: unknown,
    latencyMs: number | null = null,
    at = Date.now(),
  ): void {
    this.extract.state = 'failed';
    this.extract.lastSource = source;
    this.extract.lastAttemptAt = at;
    this.extract.lastFailureAt = at;
    this.extract.lastLatencyMs = latencyMs;
    this.extract.lastError = memorySafeErrorMessage(error);
    this.extract.consecutiveFailures += 1;
  }

  recordRoute(route: MemoryOutputProtocolId, ok: boolean, error: string | null = null): void {
    const current = this.routeStats.get(route) ?? {
      route,
      success: 0,
      failure: 0,
      lastError: null,
    };
    if (ok) {
      current.success += 1;
      current.lastError = null;
    } else {
      current.failure += 1;
      current.lastError = error ? 'Memory extraction response validation failed.' : null;
    }
    this.routeStats.set(route, current);
  }

  recordSearch(mode: 'search' | 'recent', returnedItems: number): void {
    if (mode === 'search') this.searchMetrics.searches += 1;
    else this.searchMetrics.recentReads += 1;
    this.searchMetrics.returnedItems += returnedItems;
    this.searchMetrics.lastSearchAt = Date.now();
  }

  recordRejectedSearch(): void {
    this.searchMetrics.rejectedCalls += 1;
  }

  recordMaintenance(at = Date.now()): void {
    this.lastMaintenanceAt = at;
  }

  async getSnapshot(): Promise<MemoryStatusSnapshot> {
    const extractBinding = this.modelRuntime.resolve('memory.extract');
    const extractConfigured = isMemoryExtractWorkloadEnabled(this.modelRuntime);
    const [jobs, counts] = await Promise.all([
      this.store.getQueueSummary(),
      this.store.getLedgerCounts(),
    ]);
    return {
      schemaVersion: 3,
      available: true,
      enabled: this.runtime.enabled,
      maintenance: this.runtime.maintenance,
      readEnabled: this.runtime.readEnabled && !this.runtime.maintenance,
      writeEnabled: this.runtime.writeEnabled && !this.runtime.maintenance,
      extractConfigured,
      extractModel: extractBinding.model ?? '',
      toolReady: this.runtime.enabled
        && this.runtime.readEnabled
        && !this.runtime.maintenance,
      jobs,
      counts,
      searchMetrics: { ...this.searchMetrics },
      providerRoutes: [...this.routeStats.values()],
      lastMaintenanceAt: this.lastMaintenanceAt,
      extract: operationSnapshot(this.extract, extractConfigured),
    };
  }

  async probeExtraction(): Promise<MemoryProbeResult> {
    const checkedAt = Date.now();
    const canonicalModel = this.modelRuntime.resolve('memory.extract').target?.canonicalModel ?? null;
    const configured = isMemoryExtractWorkloadEnabled(this.modelRuntime);
    if (!this.runtime.enabled || this.runtime.maintenance || !configured) {
      return {
        target: 'memory.extract',
        ok: false,
        checkedAt,
        latencyMs: null,
        canonicalModel,
        schemaValid: false,
        error: !this.runtime.enabled
          ? 'memory disabled'
          : this.runtime.maintenance
            ? 'memory maintenance mode'
            : 'memory.extract runtime is not configured',
        snapshot: await this.getSnapshot(),
      };
    }
    this.recordAttempt('probe', checkedAt);
    const startedAt = Date.now();
    try {
      const semantic = await this.extractionProbe();
      if (
        semantic.canonicalModel !== canonicalModel
        || !semantic.schemaValid
      ) {
        throw new Error('memory.extract semantic probe did not match the live model binding');
      }
      const latencyMs = Date.now() - startedAt;
      this.recordSuccess('probe', latencyMs, Date.now());
      return {
        target: 'memory.extract',
        ok: true,
        checkedAt: Date.now(),
        latencyMs,
        canonicalModel,
        schemaValid: true,
        error: null,
        snapshot: await this.getSnapshot(),
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      this.recordFailure('probe', error, latencyMs, Date.now());
      return {
        target: 'memory.extract',
        ok: false,
        checkedAt: Date.now(),
        latencyMs,
        canonicalModel,
        schemaValid: false,
        error: memorySafeErrorMessage(error),
        snapshot: await this.getSnapshot(),
      };
    }
  }
}
