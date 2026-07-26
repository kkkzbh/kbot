import { describe, expect, it, vi } from 'vitest';
import {
  ModelConfigError,
  type ModelConnectionExecutor,
} from '../src/plugins/model-config/index.js';
import type { MemoryRuntimeConfig } from '../src/plugins/memory/config.js';
import { runMemoryJobTick } from '../src/plugins/memory/pipeline.js';
import type { ExtractJobPayload } from '../src/plugins/memory/store.js';
import type { MemoryJobRecord } from '../src/types/memory.js';
import { createMemoryModelRuntime } from './memory-model-runtime.js';

vi.mock('koishi', () => ({
  Logger: class {
    warn(): void {}
  },
}));

const runtime: MemoryRuntimeConfig = {
  enabled: true,
  readEnabled: true,
  writeEnabled: true,
  queryTopK: 8,
  promptBudgetTokens: 1_200,
  embedBatchSize: 16,
  extractIdleMs: 90_000,
  extractMessageBatch: 12,
  archiveDays: 90,
  maxJobRetries: 5,
  jobLockTimeoutMs: 300_000,
  maxFacts: 8,
  maxEpisodes: 8,
};

const address = {
  userKey: 'onebot:user:10001',
  contextKey: 'onebot:bot:20001:group:20001',
  channelType: 'group' as const,
  platform: 'onebot',
  botSelfId: '20001',
  userId: '10001',
  groupId: '20001',
  conversationId: 'conv-1',
  observedAt: 1,
};

const payload: ExtractJobPayload = {
  address,
  ownerUserKey: address.userKey,
  targetSpeakerId: address.userId,
  targetSpeakerName: 'Alice',
  contextKey: address.contextKey,
  conversationId: address.conversationId,
  rangeStartAfterMessageId: null,
  latestAnchorMessageId: 'm-1',
  maxMessages: 4,
};

const job: MemoryJobRecord = {
  id: 1,
  jobKey: 'extract:onebot:user:10001',
  jobType: 'extract',
  status: 'pending',
  payload: JSON.stringify(payload),
  retryCount: 0,
  nextRunAt: 1,
  lockedAt: null,
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
};

function createStore() {
  return {
    listDueJobs: vi.fn(async (jobType: string) => (
      jobType === 'extract' ? [job] : []
    )),
    markJobProcessing: vi.fn(async () => {}),
    parseJobPayload: vi.fn(() => payload),
    readConversationWindow: vi.fn(async () => [{
      id: 'm-1',
      role: 'human' as const,
      text: '我喜欢简洁回答',
      speakerId: '10001',
      speakerName: 'Alice',
      ownerUserKey: address.userKey,
      isTarget: true,
      attributionSource: 'direct_session' as const,
    }]),
    filterTombstonedTurns: vi.fn(async (_ownerUserKey: string, turns: unknown[]) => turns),
    audit: vi.fn(async () => {}),
    writeCandidateBatch: vi.fn(async () => 1),
    queueJob: vi.fn(async () => {}),
    updateExtractCursor: vi.fn(async () => {}),
    completeJob: vi.fn(async () => {}),
    retryJob: vi.fn(async () => {}),
    deadLetterJob: vi.fn(async () => {}),
  };
}

function createStatus() {
  return {
    recordRoute: vi.fn(),
    recordAttempt: vi.fn(),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    recordMaintenance: vi.fn(),
  };
}

function validExtraction(): string {
  return JSON.stringify({
    facts: [{
      subject: 'target_user',
      ownerSpeakerId: '10001',
      kind: 'preference',
      topicKey: 'answer-style',
      content: '用户喜欢简洁回答',
      keywords: ['简洁'],
      importance: 0.8,
      confidence: 0.9,
      sensitivity: 'low',
      suggestedVisibility: 'source_context_only',
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

describe('memory pipeline', () => {
  it('processes an extract job through native structured output and queues review', async () => {
    const execute = vi.fn<ModelConnectionExecutor['execute']>(async () => ({
      text: validExtraction(),
    }));
    const { client } = createMemoryModelRuntime({ executor: { execute } });
    const store = createStore();
    const status = createStatus();

    await runMemoryJobTick(
      store as never,
      runtime,
      client,
      status as never,
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(store.writeCandidateBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        providerRoute: 'native_chat_json_schema',
        candidates: [
          expect.objectContaining({
            candidateType: 'fact',
            topicKey: 'answer-style',
          }),
        ],
      }),
    );
    expect(store.queueJob).toHaveBeenCalledWith(
      'privacy_review',
      expect.objectContaining({ address }),
    );
    expect(store.updateExtractCursor).toHaveBeenCalledWith(payload);
    expect(store.completeJob).toHaveBeenCalledWith(job);
    expect(status.recordSuccess).toHaveBeenCalledWith(
      'extract',
      'runtime',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('dead-letters a typed non-retryable managed-provider failure', async () => {
    const upstreamError = new ModelConfigError({
      code: 'upstream_failed',
      operation: 'execute',
      stage: 'transport',
      workload: 'memory.extract',
      connectionId: 'memory',
      modelId: 'memory-extract',
      upstreamStatus: 403,
      providerCode: 'insufficient_balance',
      message: 'memory extraction provider rejected the request',
    });
    const execute = vi.fn<ModelConnectionExecutor['execute']>(async () => {
      throw upstreamError;
    });
    const { client } = createMemoryModelRuntime({ executor: { execute } });
    const store = createStore();
    const status = createStatus();

    await runMemoryJobTick(
      store as never,
      runtime,
      client,
      status as never,
    );

    expect(store.deadLetterJob).toHaveBeenCalledWith(job, upstreamError);
    expect(store.retryJob).not.toHaveBeenCalled();
    expect(status.recordFailure).toHaveBeenCalledWith(
      'extract',
      'runtime',
      upstreamError,
      expect.any(Number),
      expect.any(Number),
    );
  });
});
