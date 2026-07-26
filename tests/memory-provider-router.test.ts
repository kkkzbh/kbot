import { describe, expect, it, vi } from 'vitest';
import type { ModelConnectionExecutor } from '../src/plugins/model-config/index.js';
import {
  extractMemoryCandidates,
  isMemoryExtractWorkloadEnabled,
  resolveMemoryOutputProtocol,
} from '../src/plugins/memory/providers/router.js';
import { embedTexts } from '../src/plugins/memory/providers/embedding-client.js';
import { parseMemoryExtractionJson } from '../src/plugins/memory/providers/schemas.js';
import { createMemoryModelRuntime } from './memory-model-runtime.js';

const address = {
  userKey: 'onebot:user:10001',
  contextKey: 'onebot:bot:20001:dm:10001',
  channelType: 'direct' as const,
  platform: 'onebot',
  botSelfId: '20001',
  userId: '10001',
  conversationId: 'conv-1',
  observedAt: 1,
};

const turn = {
  id: 'm-1',
  role: 'human' as const,
  text: '我喜欢简洁回答',
  speakerId: '10001',
  speakerName: 'Alice',
  ownerUserKey: address.userKey,
  isTarget: true,
  attributionSource: 'direct_session' as const,
};

function validExtraction(): string {
  return JSON.stringify({
    facts: [{
      subject: 'target_user',
      ownerSpeakerId: '10001',
      kind: 'preference',
      topicKey: 'answer-style',
      content: '用户喜欢简洁回答',
      keywords: ['简洁'],
      importance: 0.7,
      confidence: 0.9,
      sensitivity: 'low',
      suggestedVisibility: 'global',
      applicability: null,
      evidence: null,
      evidenceMessageIds: ['m-1'],
      evidenceSpeakerIds: ['10001'],
      conflictHint: null,
      validFrom: null,
      validUntil: null,
      expiresAt: null,
    }],
    episodes: [],
    drops: [],
  });
}

describe('memory extract runtime routing', () => {
  it('uses the dedicated managed client with native structured output', async () => {
    const execute = vi.fn<ModelConnectionExecutor['execute']>(async () => ({
      text: validExtraction(),
    }));
    const { client } = createMemoryModelRuntime({
      extractProtocol: 'native_responses_json_schema',
      executor: { execute },
    });

    const result = await extractMemoryCandidates({
      address,
      target: { speakerId: '10001', speakerName: 'Alice' },
      turns: [turn],
      modelRuntime: client,
      maxFacts: 4,
      maxEpisodes: 2,
    });

    expect(result).toMatchObject({
      ok: true,
      route: 'native_responses_json_schema',
      candidates: [
        expect.objectContaining({
          candidateType: 'fact',
          kind: 'preference',
          topicKey: 'answer-style',
        }),
      ],
      error: null,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      operation: 'chat',
      target: {
        canonicalModel: 'qqbot-memory/memory-extract',
        model: {
          transportModel: 'provider-memory-extract',
          structuredOutputProtocol: 'native_responses_json_schema',
        },
      },
      payload: {
        structuredOutput: {
          name: 'memory_extraction',
          strict: true,
        },
      },
    });
  });

  it('reports an explicitly disabled extract binding without transport access', async () => {
    const execute = vi.fn<ModelConnectionExecutor['execute']>();
    const { client } = createMemoryModelRuntime({
      extractMode: 'disabled',
      executor: { execute },
    });

    expect(isMemoryExtractWorkloadEnabled(client)).toBe(false);
    expect(resolveMemoryOutputProtocol(client)).toBe('unsupported_protocol');
    await expect(extractMemoryCandidates({
      address,
      target: { speakerId: '10001', speakerName: 'Alice' },
      turns: [turn],
      modelRuntime: client,
      maxFacts: 4,
      maxEpisodes: 2,
    })).resolves.toMatchObject({
      ok: false,
      route: 'unsupported_protocol',
      candidates: [],
      error: 'memory_extract_disabled',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('normalizes supported fact kind aliases at the typed response boundary', () => {
    const [candidate] = parseMemoryExtractionJson(JSON.stringify({
      facts: [{
        subject: 'target_user',
        ownerSpeakerId: '10001',
        kind: 'interest',
        topicKey: 'music',
        content: '用户喜欢钢琴曲',
        keywords: ['钢琴'],
        importance: 0.7,
        confidence: 0.82,
        sensitivity: 'low',
        suggestedVisibility: 'global',
        evidenceMessageIds: ['m-1'],
        evidenceSpeakerIds: ['10001'],
      }],
      episodes: [],
      drops: [],
    }));

    expect(candidate).toMatchObject({
      candidateType: 'fact',
      kind: 'preference',
      topicKey: 'music',
    });
  });
});

describe('memory embedding runtime routing', () => {
  it('uses the dedicated managed embedding client and preserves vector order', async () => {
    const execute = vi.fn<ModelConnectionExecutor['execute']>(async (request) => {
      if (request.operation === 'chat') {
        return { text: JSON.stringify({ facts: [], episodes: [], drops: [] }) };
      }
      return {
        vectors: request.payload.inputs.map((_, index) => [index, index + 0.5]),
      };
    });
    const { client } = createMemoryModelRuntime({ executor: { execute } });

    await expect(embedTexts(client, ['first', 'second'])).resolves.toEqual([
      [0, 0.5],
      [1, 1.5],
    ]);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'embedding',
      target: expect.objectContaining({
        canonicalModel: 'qqbot-memory/memory-embedding',
        model: expect.objectContaining({
          transportModel: 'provider-memory-embedding',
        }),
      }),
      payload: {
        inputs: ['first', 'second'],
      },
    }));
  });

  it('returns unavailable vectors for an explicitly disabled embedding binding', async () => {
    const execute = vi.fn<ModelConnectionExecutor['execute']>();
    const { client } = createMemoryModelRuntime({
      embeddingMode: 'disabled',
      executor: { execute },
    });

    await expect(embedTexts(client, ['first', 'second'])).resolves.toEqual([
      null,
      null,
    ]);
    expect(execute).not.toHaveBeenCalled();
  });
});
