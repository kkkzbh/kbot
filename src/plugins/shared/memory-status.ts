import type { MemoryStatusSnapshot } from '../../types/memory.js';

export function createUnavailableMemoryStatusSnapshot(
  overrides: Partial<MemoryStatusSnapshot> = {},
): MemoryStatusSnapshot {
  return {
    available: false,
    enabled: false,
    readEnabled: false,
    writeEnabled: false,
    extractConfigured: false,
    embedConfigured: false,
    extractModel: '',
    embedModel: '',
    jobs: {
      extractPending: 0,
      extractProcessing: 0,
      privacyReviewPending: 0,
      consolidatePending: 0,
      embedPending: 0,
      embedProcessing: 0,
      deadLetter: 0,
    },
    providerRoutes: [],
    lastMaintenanceAt: null,
    extract: {
      configured: false,
      state: 'never',
      lastSource: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastLatencyMs: null,
      lastError: null,
      consecutiveFailures: 0,
    },
    embed: {
      configured: false,
      state: 'never',
      lastSource: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastLatencyMs: null,
      lastError: null,
      consecutiveFailures: 0,
    },
    ...overrides,
  };
}
