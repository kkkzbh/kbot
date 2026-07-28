import type { MemoryStatusSnapshot } from '../../types/memory.js';

export function createUnavailableMemoryStatusSnapshot(
  overrides: Partial<MemoryStatusSnapshot> = {},
): MemoryStatusSnapshot {
  return {
    schemaVersion: 3,
    available: false,
    enabled: false,
    maintenance: false,
    readEnabled: false,
    writeEnabled: false,
    extractConfigured: false,
    extractModel: '',
    toolReady: false,
    jobs: {
      pending: 0,
      leased: 0,
      failed: 0,
      deadLetter: 0,
      byType: { extract: 0, maintenance: 0 },
    },
    counts: {
      active: 0,
      pendingReview: 0,
      archived: 0,
      retracted: 0,
      forgotten: 0,
      stranded: 0,
      lexicalDocuments: 0,
      lexicalTerms: 0,
      orphanEvidence: 0,
      staleLexicalDocuments: 0,
      inactiveLexicalDocuments: 0,
      strandedByReason: {
        payload: 0,
        evidence: 0,
        audience: 0,
        lexical: 0,
      },
    },
    searchMetrics: {
      searches: 0,
      recentReads: 0,
      returnedItems: 0,
      rejectedCalls: 0,
      lastSearchAt: null,
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
    ...overrides,
  };
}
