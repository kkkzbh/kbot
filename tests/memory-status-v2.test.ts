import { describe, expect, it } from 'vitest';
import type { ModelRuntimeClient } from '../src/plugins/model-config/index.js';
import { MemoryStatusService } from '../src/plugins/memory/status.js';
import type { MemoryStore } from '../src/plugins/memory/store.js';

function runtimeClient(): ModelRuntimeClient {
  return {
    resolve(workload: 'memory.extract' | 'memory.embedding') {
      const canonicalModel = workload === 'memory.extract'
        ? 'qqbot-codex/gpt-5.6-luna'
        : 'qqbot-siliconflow/Qwen3-Embedding-8B';
      return {
        workload,
        mode: 'dedicated',
        revision: 7,
        model: canonicalModel,
        target: {
          canonicalModel,
          model: {
            structuredOutputProtocol: 'native_chat_json_schema',
          },
        },
      };
    },
  } as unknown as ModelRuntimeClient;
}

function store(): MemoryStore {
  return {
    async getQueueSummary() {
      return {
        pending: 0,
        leased: 0,
        failed: 0,
        deadLetter: 0,
        byType: {
          extract: 0,
          embed: 0,
          backfill: 0,
          maintenance: 0,
        },
      };
    },
    async getLedgerCounts() {
      return {
        active: 0,
        pendingReview: 0,
        archived: 0,
        retracted: 0,
        forgotten: 0,
        stranded: 0,
        ftsRows: 0,
        embeddingRows: 0,
        orphanEvidence: 0,
        staleFts: 0,
        inactiveFts: 0,
        staleEmbedding: 0,
        inactiveEmbedding: 0,
        strandedByReason: {
          payload: 0,
          evidence: 0,
          audience: 0,
          embedding: 0,
          fts: 0,
        },
      };
    },
  } as unknown as MemoryStore;
}

describe('Memory Ledger V2 semantic probes', () => {
  it('reports the canonical model, schema result, and embedding dimensions', async () => {
    const service = new MemoryStatusService(
      {
        enabled: true,
        maintenance: false,
        readEnabled: false,
        writeEnabled: false,
      },
      runtimeClient(),
      store(),
      async () => ({
        canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
        schemaValid: true,
        dimensions: 4096,
      }),
      async () => ({
        canonicalModel: 'qqbot-codex/gpt-5.6-luna',
        schemaValid: true,
        dimensions: null,
      }),
    );

    await expect(service.probeEmbedding()).resolves.toMatchObject({
      target: 'memory.embedding',
      ok: true,
      canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
      schemaValid: true,
      dimensions: 4096,
      error: null,
    });
    await expect(service.probeExtraction()).resolves.toMatchObject({
      target: 'memory.extract',
      ok: true,
      canonicalModel: 'qqbot-codex/gpt-5.6-luna',
      schemaValid: true,
      dimensions: null,
      error: null,
    });
  });

  it('fails closed and redacts probe implementation errors', async () => {
    const service = new MemoryStatusService(
      {
        enabled: true,
        maintenance: false,
        readEnabled: false,
        writeEnabled: false,
      },
      runtimeClient(),
      store(),
      async () => {
        throw new Error('Bearer secret-token provider response body');
      },
      async () => ({
        canonicalModel: 'qqbot-other/model',
        schemaValid: true,
        dimensions: null,
      }),
    );

    const embedding = await service.probeEmbedding();
    expect(embedding).toMatchObject({
      ok: false,
      canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
      schemaValid: false,
      dimensions: null,
      error: 'Unexpected memory runtime failure.',
    });
    expect(embedding.snapshot.embed.lastError).toBe(
      'Unexpected memory runtime failure.',
    );

    await expect(service.probeExtraction()).resolves.toMatchObject({
      ok: false,
      canonicalModel: 'qqbot-codex/gpt-5.6-luna',
      schemaValid: false,
      dimensions: null,
      error: 'Unexpected memory runtime failure.',
    });
  });
});
