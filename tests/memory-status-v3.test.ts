import { describe, expect, it, vi } from 'vitest';
import { MemoryStatusService } from '../src/plugins/memory/status.js';
import { createMemoryModelRuntime } from './memory-model-runtime.js';

const emptyQueue = {
  pending: 0,
  leased: 0,
  failed: 0,
  deadLetter: 0,
  byType: { extract: 0, maintenance: 0 },
};
const emptyCounts = {
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
  strandedByReason: { payload: 0, evidence: 0, audience: 0, lexical: 0 },
};

describe('MemoryStatusService V3', () => {
  it('reports extraction, Tool and lexical state without embedding fields', async () => {
    const { client } = createMemoryModelRuntime();
    const service = new MemoryStatusService(
      {
        enabled: true,
        maintenance: false,
        readEnabled: true,
        writeEnabled: true,
      },
      client,
      {
        getQueueSummary: vi.fn(async () => emptyQueue),
        getLedgerCounts: vi.fn(async () => ({
          ...emptyCounts,
          active: 4,
          lexicalDocuments: 4,
          lexicalTerms: 18,
        })),
      } as never,
      async () => ({
        canonicalModel: 'qqbot-memory/memory-extract',
        schemaValid: true,
      }),
    );
    const snapshot = await service.getSnapshot();
    expect(snapshot).toMatchObject({
      schemaVersion: 3,
      extractConfigured: true,
      extractModel: 'qqbot-memory/memory-extract',
      toolReady: true,
      counts: {
        active: 4,
        lexicalDocuments: 4,
        lexicalTerms: 18,
      },
    });
    expect(snapshot).not.toHaveProperty('embed');
    expect(snapshot).not.toHaveProperty('embedModel');
  });

  it('requires semantic probe identity and records search metrics', async () => {
    const { client } = createMemoryModelRuntime();
    const service = new MemoryStatusService(
      {
        enabled: true,
        maintenance: false,
        readEnabled: true,
        writeEnabled: true,
      },
      client,
      {
        getQueueSummary: vi.fn(async () => emptyQueue),
        getLedgerCounts: vi.fn(async () => emptyCounts),
      } as never,
      async () => ({
        canonicalModel: 'qqbot-memory/wrong-model',
        schemaValid: true,
      }),
    );
    service.recordSearch('search', 3);
    service.recordRejectedSearch();
    await expect(service.probeExtraction()).resolves.toMatchObject({
      target: 'memory.extract',
      ok: false,
      schemaValid: false,
    });
    await expect(service.getSnapshot()).resolves.toMatchObject({
      searchMetrics: {
        searches: 1,
        recentReads: 0,
        returnedItems: 3,
        rejectedCalls: 1,
      },
    });
  });
});
