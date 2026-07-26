import { describe, expect, it, vi } from 'vitest';
import { MemoryStatusService } from '../src/plugins/memory/status.js';
import { createMemoryModelRuntime } from './memory-model-runtime.js';

const jobs = {
  extractPending: 0,
  extractProcessing: 0,
  privacyReviewPending: 0,
  consolidatePending: 0,
  embedPending: 0,
  embedProcessing: 0,
  deadLetter: 0,
};

const runtime = {
  enabled: true,
  readEnabled: true,
  writeEnabled: true,
};

describe('memory runtime status', () => {
  it('reports canonical bindings and records successful probes', async () => {
    const { client } = createMemoryModelRuntime();
    const embedProbe = vi.fn(async () => {});
    const extractionProbe = vi.fn(async () => {});
    const service = new MemoryStatusService(
      runtime,
      client,
      { getJobSummary: async () => jobs },
      embedProbe,
      extractionProbe,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      available: true,
      extractConfigured: true,
      embedConfigured: true,
      extractModel: 'qqbot-memory/memory-extract',
      embedModel: 'qqbot-memory/memory-embedding',
      extract: { configured: true, state: 'never' },
      embed: { configured: true, state: 'never' },
    });
    await expect(service.probeExtraction()).resolves.toMatchObject({
      target: 'extraction',
      ok: true,
      error: null,
      snapshot: {
        extract: {
          state: 'success',
          lastSource: 'probe',
        },
      },
    });
    await expect(service.probeEmbedding()).resolves.toMatchObject({
      target: 'embedding',
      ok: true,
      error: null,
      snapshot: {
        embed: {
          state: 'success',
          lastSource: 'probe',
        },
      },
    });
    expect(extractionProbe).toHaveBeenCalledOnce();
    expect(embedProbe).toHaveBeenCalledOnce();
  });

  it('exposes disabled bindings without invoking their probes', async () => {
    const { client } = createMemoryModelRuntime({
      extractMode: 'disabled',
      embeddingMode: 'disabled',
    });
    const embedProbe = vi.fn(async () => {});
    const extractionProbe = vi.fn(async () => {});
    const service = new MemoryStatusService(
      runtime,
      client,
      { getJobSummary: async () => jobs },
      embedProbe,
      extractionProbe,
    );

    await expect(service.probeExtraction()).resolves.toMatchObject({
      target: 'extraction',
      ok: false,
      error: 'extraction runtime is not configured',
      snapshot: {
        extractConfigured: false,
        extractModel: '',
      },
    });
    await expect(service.probeEmbedding()).resolves.toMatchObject({
      target: 'embedding',
      ok: false,
      error: 'embedding runtime is not configured',
      snapshot: {
        embedConfigured: false,
        embedModel: '',
      },
    });
    expect(extractionProbe).not.toHaveBeenCalled();
    expect(embedProbe).not.toHaveBeenCalled();
  });
});
