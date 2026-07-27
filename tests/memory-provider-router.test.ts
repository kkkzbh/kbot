import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => ({
  Logger: class {
    warn(): void {}
  },
}));

import type { ModelConnectionExecutor } from '../src/plugins/model-config/index.js';
import {
  extractMemoryCandidates,
  isMemoryExtractWorkloadEnabled,
  resolveMemoryOutputProtocol,
} from '../src/plugins/memory/providers/router.js';
import { embedTexts } from '../src/plugins/memory/providers/embedding-client.js';
import {
  processEmbeddingWork,
  processExtractWork,
} from '../src/plugins/memory/pipeline.js';
import {
  buildMemoryExtractionPrompt,
  parseMemoryExtractionJson,
} from '../src/plugins/memory/providers/schemas.js';
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

  it('rejects non-canonical kinds and subjects at the provider boundary', () => {
    const alias = JSON.parse(validExtraction()) as { facts: Array<Record<string, unknown>> };
    alias.facts[0]!.kind = 'interest';
    expect(() => parseMemoryExtractionJson(JSON.stringify(alias))).toThrow(
      'memory_extract_response_invalid:facts[0].kind',
    );

    const invalidSubject = JSON.parse(validExtraction()) as { facts: Array<Record<string, unknown>> };
    invalidSubject.facts[0]!.subject = 'someone';
    expect(() => parseMemoryExtractionJson(JSON.stringify(invalidSubject))).toThrow(
      'memory_extract_response_invalid:facts[0].subject',
    );
  });

  it('defines canonical production domains and keeps episodes user-owned', () => {
    const prompt = buildMemoryExtractionPrompt(
      [turn, {
        id: 'a-1',
        role: 'ai',
        text: '我会提醒你。',
        speakerId: '20001',
        speakerName: 'QQBot',
        ownerUserKey: null,
        isTarget: false,
        attributionSource: 'assistant',
        parentId: 'm-1',
      }],
      'native_chat_json_schema',
      { speakerId: '10001', speakerName: 'Alice' },
      address,
    );
    expect(prompt).toContain('canonical ownerSpeakerId=group');
    expect(prompt).toContain('canonical ownerSpeakerId=20001');
    expect(prompt).toContain('attribution_source=additional_kwargs');
    expect(prompt).toContain('因果父请求的消息时 audience');
    expect(prompt).toContain(
      '[assistant speaker_id=20001 message_id=a-1 reply_to_message_id="m-1" attribution_source=assistant',
    );

    const groupFact = JSON.parse(validExtraction()) as {
      facts: Array<Record<string, unknown>>;
    };
    groupFact.facts[0]!.subject = 'group_shared';
    groupFact.facts[0]!.ownerSpeakerId = 'group';
    expect(parseMemoryExtractionJson(JSON.stringify(groupFact))[0]).toMatchObject({
      subject: 'group_shared',
      ownerSpeakerId: 'group',
    });

    const invalidEpisode = JSON.parse(validExtraction()) as {
      facts: Array<Record<string, unknown>>;
      episodes: Array<Record<string, unknown>>;
    };
    invalidEpisode.episodes = [{
      subject: 'assistant',
      ownerSpeakerId: '20001',
      title: '提醒',
      summary: '助手会提醒用户。',
      keywords: ['提醒'],
      importance: 0.7,
      confidence: 1,
      periodStart: null,
      periodEnd: null,
      sensitivity: 'low',
      applicability: null,
      evidence: null,
      evidenceMessageIds: ['a-1'],
      evidenceSpeakerIds: ['20001'],
      validFrom: null,
      validUntil: null,
      expiresAt: null,
    }];
    expect(() => parseMemoryExtractionJson(JSON.stringify(invalidEpisode))).toThrow(
      'memory_extract_response_invalid:episodes[0].subject',
    );
  });

  it('passes group and assistant fact candidates into lease finalization', async () => {
    const domainOutput = JSON.parse(validExtraction()) as {
      facts: Array<Record<string, unknown>>;
    };
    domainOutput.facts = [{
      ...domainOutput.facts[0],
      subject: 'group_shared',
      ownerSpeakerId: 'group',
    }, {
      ...domainOutput.facts[0],
      subject: 'assistant',
      ownerSpeakerId: '20001',
      evidenceMessageIds: ['a-1'],
      evidenceSpeakerIds: ['20001'],
    }];
    const execute = vi.fn<ModelConnectionExecutor['execute']>(async () => ({
      text: JSON.stringify(domainOutput),
    }));
    const { client } = createMemoryModelRuntime({ executor: { execute } });
    const payload = {
      address,
      targetSpeakerId: '10001',
      targetSpeakerName: 'Alice',
      latestAnchorMessageId: 'm-1',
      maxMessages: 8,
      capturedAudiences: [{
        messageId: 'm-1',
        observedAt: 1,
        audienceSubjectKeys: [address.userKey],
      }],
    };
    const turns = [turn, {
      id: 'a-1',
      role: 'ai' as const,
      text: '我会提醒你。',
      speakerId: '20001',
      speakerName: 'QQBot',
      ownerUserKey: null,
      isTarget: false,
      attributionSource: 'assistant' as const,
      parentId: 'm-1',
    }];
    const store = {
      parseWorkPayload: vi.fn(() => payload),
      readConversationWindow: vi.fn(async () => turns),
      filterSuppressedTurns: vi.fn(async () => turns),
      cancelWork: vi.fn(),
      completeEmptyExtraction: vi.fn(),
      finalizeExtraction: vi.fn(),
    };
    const status = { recordRoute: vi.fn() };
    await processExtractWork(
      store as never,
      { maxFacts: 4, maxEpisodes: 2 } as never,
      client,
      status as never,
      {
        work: {
          id: 1,
          workKey: 'extract:domains',
          workType: 'extract',
          status: 'leased',
        },
        leaseToken: 'lease',
      } as never,
    );
    expect(store.finalizeExtraction).toHaveBeenCalledWith(expect.objectContaining({
      candidates: expect.arrayContaining([
        expect.objectContaining({ subject: 'group_shared' }),
        expect.objectContaining({ subject: 'assistant' }),
      ]),
    }));
  });

  it('preserves invalid structured output as a non-retryable semantic provider code', async () => {
    const execute = vi.fn<ModelConnectionExecutor['execute']>(async () => ({
      text: '{"facts":[{"kind":"invalid"}]}',
    }));
    const { client } = createMemoryModelRuntime({ executor: { execute } });
    const payload = {
      address,
      targetSpeakerId: '10001',
      targetSpeakerName: 'Alice',
      latestAnchorMessageId: 'm-1',
      maxMessages: 8,
      capturedAudiences: [{
        messageId: 'm-1',
        observedAt: 1,
        audienceSubjectKeys: [address.userKey],
      }],
    };
    const store = {
      parseWorkPayload: vi.fn(() => payload),
      readConversationWindow: vi.fn(async () => [turn]),
      filterSuppressedTurns: vi.fn(async (_subject, _context, turns) => turns),
      cancelWork: vi.fn(),
      completeEmptyExtraction: vi.fn(),
      finalizeExtraction: vi.fn(),
    };
    const status = { recordRoute: vi.fn() };
    const claimed = {
      work: {
        id: 1,
        workKey: 'extract:semantic-error',
        workType: 'extract',
        status: 'leased',
      },
      leaseToken: 'lease',
    };

    await expect(processExtractWork(
      store as never,
      { maxFacts: 4, maxEpisodes: 2 } as never,
      client,
      status as never,
      claimed as never,
    )).rejects.toMatchObject({
      code: 'memory_extract_response_invalid',
      stage: 'provider',
      retryable: false,
    });
    expect(status.recordRoute).toHaveBeenCalledWith(
      'native_chat_json_schema',
      false,
      'memory_extract_response_invalid',
    );
    expect(store.finalizeExtraction).not.toHaveBeenCalled();
  });
});

describe('memory embedding runtime routing', () => {
  it('cancels obsolete model-revision work without calling the provider', async () => {
    const execute = vi.fn<ModelConnectionExecutor['execute']>();
    const { client } = createMemoryModelRuntime({ executor: { execute } });
    const claimed = {
      work: {
        id: 1,
        workKey: 'embed:obsolete',
        workType: 'embed',
        status: 'leased',
      },
      leaseToken: 'lease',
    };
    const store = {
      parseWorkPayload: vi.fn(() => ({
        streamId: 'stream-1',
        eventId: 'event-1',
        revision: 1,
        canonicalModel: 'qqbot-memory/old-embedding',
        modelRevision: 1,
        contentHash: 'content-hash',
      })),
      resolveEmbeddingWork: vi.fn(async () => ({
        state: 'obsolete',
        reasonCode: 'memory_embedding_identity_superseded',
      })),
      cancelWork: vi.fn(),
      finalizeEmbedding: vi.fn(),
    };

    await processEmbeddingWork(
      store as never,
      { maxJobRetries: 3 },
      client,
      claimed as never,
    );

    expect(store.cancelWork).toHaveBeenCalledWith(
      claimed.work,
      claimed.leaseToken,
      'memory_embedding_identity_superseded',
    );
    expect(store.finalizeEmbedding).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

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
