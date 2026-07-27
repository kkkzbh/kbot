import type {
  MemoryOperationSnapshot,
  MemoryOutputProtocolId,
  MemoryProbeResult,
  MemoryProviderRouteStats,
  MemoryStatusServiceLike,
  MemoryStatusSnapshot,
  MemoryStatusSource,
} from '../../types/memory.js';
import type { ModelRuntimeClient } from '../model-config/index.js';
import { createUnavailableMemoryStatusSnapshot } from '../shared/memory-status.js';
import { memorySafeErrorMessage } from './errors.js';
import { isEmbeddingWorkloadEnabled } from './providers/embedding-client.js';
import { isMemoryExtractWorkloadEnabled } from './providers/router.js';
import type { MemoryEmbeddingIdentity, MemoryStore } from './store.js';

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
  dimensions: number | null;
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
  return memorySafeErrorMessage(error);
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

function resolveEmbeddingIdentity(modelRuntime: ModelRuntimeClient): MemoryEmbeddingIdentity | null {
  const binding = modelRuntime.resolve('memory.embedding');
  if (!binding.target) return null;
  return {
    canonicalModel: binding.target.canonicalModel,
    modelRevision: binding.revision,
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
    private readonly store: MemoryStore,
    private readonly embedProbe: () => Promise<MemoryProbeSemanticResult>,
    private readonly extractionProbe: () => Promise<MemoryProbeSemanticResult>,
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
      current.lastError = error ? 'Memory extraction response validation failed.' : null;
    }
    this.routeStats.set(route, current);
  }

  recordMaintenance(at = Date.now()): void {
    this.lastMaintenanceAt = at;
  }

  async getSnapshot(): Promise<MemoryStatusSnapshot> {
    const extractBinding = this.modelRuntime.resolve('memory.extract');
    const embedBinding = this.modelRuntime.resolve('memory.embedding');
    const extractConfigured = isMemoryExtractWorkloadEnabled(this.modelRuntime);
    const embedConfigured = isEmbeddingWorkloadEnabled(this.modelRuntime);
    const identity = resolveEmbeddingIdentity(this.modelRuntime);
    const [jobs, counts] = await Promise.all([
      this.store.getQueueSummary(),
      this.store.getLedgerCounts(identity),
    ]);
    return {
      schemaVersion: 2,
      available: true,
      enabled: this.runtime.enabled,
      maintenance: this.runtime.maintenance,
      readEnabled: this.runtime.readEnabled && !this.runtime.maintenance,
      writeEnabled: this.runtime.writeEnabled && !this.runtime.maintenance,
      extractConfigured,
      embedConfigured,
      extractModel: extractBinding.model ?? '',
      embedModel: embedBinding.model ?? '',
      jobs,
      counts,
      providerRoutes: [...this.routeStats.values()],
      lastMaintenanceAt: this.lastMaintenanceAt,
      extract: toOperationSnapshot(this.extract, extractConfigured),
      embed: toOperationSnapshot(this.embed, embedConfigured),
    };
  }

  async probeEmbedding(): Promise<MemoryProbeResult> {
    return this.runProbe(
      'memory.embedding',
      'embed',
      this.embedProbe,
      isEmbeddingWorkloadEnabled(this.modelRuntime),
    );
  }

  async probeExtraction(): Promise<MemoryProbeResult> {
    return this.runProbe(
      'memory.extract',
      'extract',
      this.extractionProbe,
      isMemoryExtractWorkloadEnabled(this.modelRuntime),
    );
  }

  private async runProbe(
    target: MemoryProbeResult['target'],
    kind: 'extract' | 'embed',
    probe: () => Promise<MemoryProbeSemanticResult>,
    configured: boolean,
  ): Promise<MemoryProbeResult> {
    const checkedAt = Date.now();
    const canonicalModel = this.modelRuntime.resolve(target).target?.canonicalModel ?? null;
    if (!this.runtime.enabled) {
      return {
        target,
        ok: false,
        checkedAt,
        latencyMs: null,
        canonicalModel,
        schemaValid: false,
        dimensions: null,
        error: 'memory disabled',
        snapshot: await this.getSnapshot(),
      };
    }
    if (this.runtime.maintenance) {
      return {
        target,
        ok: false,
        checkedAt,
        latencyMs: null,
        canonicalModel,
        schemaValid: false,
        dimensions: null,
        error: 'memory maintenance mode',
        snapshot: await this.getSnapshot(),
      };
    }
    if (!configured) {
      return {
        target,
        ok: false,
        checkedAt,
        latencyMs: null,
        canonicalModel,
        schemaValid: false,
        dimensions: null,
        error: `${target} runtime is not configured`,
        snapshot: await this.getSnapshot(),
      };
    }
    this.recordAttempt(kind, 'probe', checkedAt);
    const startedAt = Date.now();
    try {
      const semantic = await probe();
      if (semantic.canonicalModel !== canonicalModel || !semantic.schemaValid) {
        throw new Error(`${target} semantic probe did not match the live model binding`);
      }
      if (
        (kind === 'embed' && (!Number.isInteger(semantic.dimensions) || Number(semantic.dimensions) <= 0))
        || (kind === 'extract' && semantic.dimensions !== null)
      ) {
        throw new Error(`${target} semantic probe returned an invalid dimensions contract`);
      }
      const latencyMs = Date.now() - startedAt;
      this.recordSuccess(kind, 'probe', latencyMs, Date.now());
      return {
        target,
        ok: true,
        checkedAt: Date.now(),
        latencyMs,
        canonicalModel: semantic.canonicalModel,
        schemaValid: semantic.schemaValid,
        dimensions: semantic.dimensions,
        error: null,
        snapshot: await this.getSnapshot(),
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      this.recordFailure(kind, 'probe', error, latencyMs, Date.now());
      return {
        target,
        ok: false,
        checkedAt: Date.now(),
        latencyMs,
        canonicalModel,
        schemaValid: false,
        dimensions: null,
        error: toErrorSummary(error),
        snapshot: await this.getSnapshot(),
      };
    }
  }
}
