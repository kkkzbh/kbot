import { randomUUID } from 'node:crypto';
import { Logger } from 'koishi';
import type { MemoryJobRecord, MemoryJobType } from '../../types/memory.js';
import type { ModelRuntimeClient } from '../model-config/index.js';
import type { MemoryRuntimeConfig } from './config.js';
import { runDeterministicPrivacyGuard } from './gates.js';
import {
  embedTexts,
} from './providers/embedding-client.js';
import { isNonRetryableMemoryProviderError } from './providers/http-error.js';
import {
  extractMemoryCandidates,
  isMemoryExtractWorkloadEnabled,
} from './providers/router.js';
import type { MemoryStatusService } from './status.js';
import type {
  ConsolidateJobPayload,
  EmbedJobPayload,
  ExtractJobPayload,
  MemoryStore,
  PrivacyReviewJobPayload,
} from './store.js';

const logger = new Logger('memory');

export async function processExtractJob(
  store: MemoryStore,
  runtime: MemoryRuntimeConfig,
  modelRuntime: ModelRuntimeClient,
  status: MemoryStatusService,
  job: MemoryJobRecord,
): Promise<void> {
  const payload = store.parseJobPayload<ExtractJobPayload>(job);
  if (!payload?.address?.conversationId) {
    await store.completeJob(job);
    return;
  }
  if (!isMemoryExtractWorkloadEnabled(modelRuntime)) {
    await store.audit({
      userKey: payload.address.userKey,
      contextKey: payload.address.contextKey,
      eventType: 'extract_skipped',
      turnId: payload.address.conversationId,
      detail: { reason: 'provider_unconfigured' },
    });
    await store.completeJob(job);
    return;
  }

  const turns = await store.filterTombstonedTurns(
    payload.ownerUserKey,
    await store.readConversationWindow(payload),
  );
  if (!turns.some((turn) => turn.role === 'human' && turn.isTarget)) {
    await store.updateExtractCursor(payload);
    await store.completeJob(job);
    return;
  }

  const output = await extractMemoryCandidates({
    address: payload.address,
    target: {
      speakerId: payload.targetSpeakerId,
      speakerName: payload.targetSpeakerName,
    },
    turns,
    modelRuntime,
    maxFacts: runtime.maxFacts,
    maxEpisodes: runtime.maxEpisodes,
  });
  status.recordRoute(output.route, output.ok, output.error);
  if (!output.ok) {
    throw new Error(output.error ?? 'memory_extract_failed');
  }
  if (!output.candidates.length) {
    await store.updateExtractCursor(payload);
    await store.completeJob(job);
    return;
  }

  const batchId = randomUUID();
  const pendingCount = await store.writeCandidateBatch({
    address: payload.address,
    payload,
    batchId,
    candidates: output.candidates,
    turns,
    messageIds: turns.map((turn) => turn.id),
    providerRoute: output.route,
    rawTextHash: output.rawTextHash,
  });
  if (pendingCount > 0) {
    await store.queueJob('privacy_review', { batchId, address: payload.address });
  }
  await store.updateExtractCursor(payload);
  await store.completeJob(job);
}

export async function processPrivacyReviewJob(
  store: MemoryStore,
  job: MemoryJobRecord,
): Promise<void> {
  const payload = store.parseJobPayload<PrivacyReviewJobPayload>(job);
  if (!payload?.batchId || !payload.address) {
    await store.completeJob(job);
    return;
  }
  const rows = await store.listBatchCandidates(payload.batchId);
  for (const row of rows) {
    if (row.reviewStatus !== 'pending') continue;
    const candidate = JSON.parse(row.payload);
    const decision = runDeterministicPrivacyGuard(candidate, payload.address);
    await store.applyPrivacyDecision(row, decision);
    if (decision.status === 'approved') {
      await store.queueJob('consolidate', { candidateId: row.id, address: payload.address });
    }
  }
  await store.completeJob(job);
}

export async function processConsolidateJob(
  store: MemoryStore,
  job: MemoryJobRecord,
): Promise<void> {
  const payload = store.parseJobPayload<ConsolidateJobPayload>(job);
  if (!payload?.candidateId || !payload.address) {
    await store.completeJob(job);
    return;
  }
  const row = await store.getCandidateById(payload.candidateId);
  if (!row?.id) {
    await store.completeJob(job);
    return;
  }
  await store.consolidateCandidate(row, payload.address);
  await store.completeJob(job);
}

export async function processEmbedJobs(
  store: MemoryStore,
  runtime: MemoryRuntimeConfig,
  modelRuntime: ModelRuntimeClient,
  jobs: MemoryJobRecord[],
): Promise<void> {
  if (!jobs.length) return;
  const binding = modelRuntime.resolve('memory.embedding');
  if (!binding.target) {
    for (const job of jobs) await store.completeJob(job);
    return;
  }
  const embeddingModel = binding.target.canonicalModel;

  const resolved: Array<{ job: MemoryJobRecord; payload: EmbedJobPayload; text: string }> = [];
  for (const job of jobs) {
    const item = await store.resolveEmbedJob(job);
    if (!item || !item.text.trim()) {
      await store.completeJob(job);
      continue;
    }
    resolved.push({ job, payload: item.payload, text: item.text });
  }
  if (!resolved.length) return;

  const vectors = await embedTexts(modelRuntime, resolved.map((item) => item.text));
  for (const [index, item] of resolved.entries()) {
    const vector = vectors[index];
    if (!vector) {
      throw new Error('empty_embedding_vector');
    }
    await store.applyEmbedding(item.payload, embeddingModel, vector);
    await store.completeJob(item.job);
  }
}

export async function processMaintenanceJob(
  store: MemoryStore,
  runtime: MemoryRuntimeConfig,
  status: MemoryStatusService,
  job?: MemoryJobRecord,
): Promise<void> {
  await store.requeueStaleProcessingJobs(runtime.jobLockTimeoutMs);
  await store.archiveExpired();
  await store.archiveLowRiskOldEpisodes(runtime.archiveDays);
  status.recordMaintenance(Date.now());
  if (job) await store.completeJob(job);
}

export async function runMemoryJobTick(
  store: MemoryStore,
  runtime: MemoryRuntimeConfig,
  modelRuntime: ModelRuntimeClient,
  status: MemoryStatusService,
): Promise<void> {
  const now = Date.now();
  const jobTypes: MemoryJobType[] = ['extract', 'privacy_review', 'consolidate', 'embed', 'reembed', 'maintenance'];
  for (const jobType of jobTypes) {
    const jobs = await store.listDueJobs(jobType, now);
    if (!jobs.length) continue;
    if (jobType === 'embed' || jobType === 'reembed') {
      const batch = jobs.slice(0, runtime.embedBatchSize);
      for (const job of batch) await store.markJobProcessing(job);
      const startedAt = Date.now();
      status.recordAttempt('embed', 'runtime', startedAt);
      try {
        await processEmbedJobs(store, runtime, modelRuntime, batch);
        status.recordSuccess('embed', 'runtime', Math.max(0, Date.now() - startedAt), Date.now());
      } catch (error) {
        status.recordFailure('embed', 'runtime', error, Math.max(0, Date.now() - startedAt), Date.now());
        if (isNonRetryableMemoryProviderError(error)) {
          for (const job of batch) await store.deadLetterJob(job, error);
        } else {
          for (const job of batch) await store.retryJob(job, error, 60_000, runtime.maxJobRetries);
        }
      }
      continue;
    }

    const job = jobs[0];
    await store.markJobProcessing(job);
    const startedAt = Date.now();
    try {
      if (jobType === 'extract') {
        status.recordAttempt('extract', 'runtime', startedAt);
        await processExtractJob(store, runtime, modelRuntime, status, job);
        status.recordSuccess('extract', 'runtime', Math.max(0, Date.now() - startedAt), Date.now());
      } else if (jobType === 'privacy_review') {
        await processPrivacyReviewJob(store, job);
      } else if (jobType === 'consolidate') {
        await processConsolidateJob(store, job);
      } else if (jobType === 'maintenance') {
        await processMaintenanceJob(store, runtime, status, job);
      }
    } catch (error) {
      if (jobType === 'extract') {
        status.recordFailure('extract', 'runtime', error, Math.max(0, Date.now() - startedAt), Date.now());
      }
      logger.warn('memory %s job failed: %s', jobType, error instanceof Error ? error.message : String(error));
      if (isNonRetryableMemoryProviderError(error)) {
        await store.deadLetterJob(job, error);
      } else {
        await store.retryJob(job, error, 60_000, runtime.maxJobRetries);
      }
    }
  }
}
