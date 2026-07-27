import { Logger } from 'koishi';
import type { MemoryV2WorkRecord, MemoryWorkType } from '../../types/memory.js';
import type { ModelRuntimeClient } from '../model-config/index.js';
import type { MemoryRuntimeConfig } from './config.js';
import {
  asMemoryRuntimeError,
  memorySafeErrorMessage,
  MemoryRuntimeError,
} from './errors.js';
import { embedTexts } from './providers/embedding-client.js';
import { isNonRetryableMemoryProviderError } from './providers/http-error.js';
import {
  extractMemoryCandidates,
  isMemoryExtractWorkloadEnabled,
} from './providers/router.js';
import type { MemoryStatusService } from './status.js';
import type {
  ClaimedMemoryWork,
  EmbeddingWorkPayload,
  ExtractWorkPayload,
  MemoryEmbeddingIdentity,
  MemoryStore,
} from './store.js';

const logger = new Logger('memory');

function embeddingIdentity(modelRuntime: ModelRuntimeClient): MemoryEmbeddingIdentity {
  const binding = modelRuntime.resolve('memory.embedding');
  if (!binding.target) {
    throw new MemoryRuntimeError(
      'embed',
      'validation',
      'memory_embedding_disabled',
      'memory.embedding must resolve to an applied model before memory writes can be enabled.',
    );
  }
  return {
    canonicalModel: binding.target.canonicalModel,
    modelRevision: binding.revision,
  };
}

export async function processExtractWork(
  store: MemoryStore,
  runtime: MemoryRuntimeConfig,
  modelRuntime: ModelRuntimeClient,
  status: MemoryStatusService,
  claimed: ClaimedMemoryWork,
): Promise<void> {
  const payload = store.parseWorkPayload<ExtractWorkPayload>(claimed.work);
  if (!payload.address?.conversationId || !payload.targetSpeakerId) {
    throw new MemoryRuntimeError('extract', 'validation', 'memory_extract_payload_invalid', 'Extraction work payload is invalid.');
  }
  if (!isMemoryExtractWorkloadEnabled(modelRuntime)) {
    await store.cancelWork(claimed.work, claimed.leaseToken, 'memory_extract_disabled');
    return;
  }
  const identity = embeddingIdentity(modelRuntime);
  const turns = await store.filterSuppressedTurns(
    payload.address.userKey,
    payload.address.contextKey,
    await store.readConversationWindow(payload),
  );
  if (!turns.some((turn) => (
    turn.role === 'human'
    && turn.isTarget
    && turn.speakerId === payload.targetSpeakerId
    && (turn.attributionSource === 'direct_session' || turn.attributionSource === 'additional_kwargs')
  ))) {
    await store.completeEmptyExtraction(
      claimed.work,
      claimed.leaseToken,
      payload,
      null,
      runtime.maxJobRetries,
    );
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
    throw new MemoryRuntimeError(
      'extract',
      'provider',
      output.error ?? 'memory_extract_provider_failed',
      'Memory extraction provider failed.',
      {
        retryable: output.error !== 'memory_extract_response_invalid'
          && output.error !== 'memory_extract_protocol_invalid'
          && output.error !== 'memory_extract_disabled',
      },
    );
  }
  await store.finalizeExtraction({
    work: claimed.work,
    leaseToken: claimed.leaseToken,
    payload,
    turns,
    candidates: output.candidates,
    providerRoute: output.route,
    rawTextHash: output.rawTextHash,
    embeddingIdentity: identity,
    maxLeaseRetries: runtime.maxJobRetries,
  });
}

export async function processEmbeddingWork(
  store: MemoryStore,
  runtime: Pick<MemoryRuntimeConfig, 'maxJobRetries'>,
  modelRuntime: ModelRuntimeClient,
  claimed: ClaimedMemoryWork,
): Promise<void> {
  const identity = embeddingIdentity(modelRuntime);
  const resolved = await store.resolveEmbeddingWork(claimed.work, identity);
  if (resolved.state === 'obsolete') {
    await store.cancelWork(
      claimed.work,
      claimed.leaseToken,
      resolved.reasonCode,
    );
    return;
  }
  const [vector] = await embedTexts(modelRuntime, [resolved.text]);
  if (!vector?.length) {
    throw new MemoryRuntimeError(
      'embed',
      'provider',
      'memory_embedding_empty_vector',
      'Memory embedding provider returned an empty vector.',
      { retryable: true },
    );
  }
  await store.finalizeEmbedding({
    work: claimed.work,
    leaseToken: claimed.leaseToken,
    payload: resolved.payload,
    vector,
    maxLeaseRetries: runtime.maxJobRetries,
  });
}

async function handleFailure(
  store: MemoryStore,
  runtime: MemoryRuntimeConfig,
  claimed: ClaimedMemoryWork,
  error: unknown,
): Promise<void> {
  const operation = claimed.work.workType === 'extract' ? 'extract' : 'embed';
  const typed = asMemoryRuntimeError(
    error,
    operation,
    error instanceof MemoryRuntimeError ? error.stage : 'provider',
    error instanceof MemoryRuntimeError ? error.code : `memory_${claimed.work.workType}_failed`,
    error instanceof MemoryRuntimeError
      ? error.retryable
      : !isNonRetryableMemoryProviderError(error),
  );
  if (
    typed.code === 'memory_deletion_generation_changed'
    || typed.code === 'memory_lease_expired'
    || typed.code === 'memory_lease_lost'
  ) {
    return;
  }
  try {
    await store.failWork(claimed.work, claimed.leaseToken, typed, {
      maxRetries: runtime.maxJobRetries,
      retryDelayMs: 60_000,
    });
  } catch (failure) {
    if (
      failure instanceof MemoryRuntimeError
      && (
        failure.code === 'memory_deletion_generation_changed'
        || failure.code === 'memory_lease_expired'
        || failure.code === 'memory_lease_lost'
      )
    ) {
      return;
    }
    throw failure;
  }
}

async function processOne(
  store: MemoryStore,
  runtime: MemoryRuntimeConfig,
  modelRuntime: ModelRuntimeClient,
  status: MemoryStatusService,
  workType: MemoryWorkType,
): Promise<boolean> {
  const claimed = await store.claimDueWork(workType, Date.now(), runtime.jobLockTimeoutMs);
  if (!claimed) return false;
  const startedAt = Date.now();
  if (workType === 'extract') status.recordAttempt('extract', 'runtime', startedAt);
  if (workType === 'embed' || workType === 'backfill') status.recordAttempt('embed', 'runtime', startedAt);
  try {
    if (workType === 'extract') {
      await processExtractWork(store, runtime, modelRuntime, status, claimed);
      status.recordSuccess('extract', 'runtime', Date.now() - startedAt, Date.now());
    } else if (workType === 'embed' || workType === 'backfill') {
      await processEmbeddingWork(store, runtime, modelRuntime, claimed);
      status.recordSuccess('embed', 'runtime', Date.now() - startedAt, Date.now());
    }
  } catch (error) {
    if (workType === 'extract') status.recordFailure('extract', 'runtime', error, Date.now() - startedAt, Date.now());
    if (workType === 'embed' || workType === 'backfill') status.recordFailure('embed', 'runtime', error, Date.now() - startedAt, Date.now());
    logger.warn(
      'memory %s work failed at %s/%s: %s',
      workType,
      error instanceof MemoryRuntimeError ? error.operation : 'unknown',
      error instanceof MemoryRuntimeError ? error.stage : 'unknown',
      memorySafeErrorMessage(error),
    );
    await handleFailure(store, runtime, claimed, error);
  }
  return true;
}

export async function processMaintenance(
  store: MemoryStore,
  runtime: Pick<MemoryRuntimeConfig, 'archiveDays' | 'maxJobRetries'>,
  status: MemoryStatusService,
): Promise<void> {
  await store.requeueExpiredLeases(Date.now(), runtime.maxJobRetries);
  await store.archiveExpired();
  await store.archiveLowRiskOldEpisodes(runtime.archiveDays);
  status.recordMaintenance(Date.now());
}

export async function runMemoryJobTick(
  store: MemoryStore,
  runtime: MemoryRuntimeConfig,
  modelRuntime: ModelRuntimeClient,
  status: MemoryStatusService,
): Promise<void> {
  await processOne(store, runtime, modelRuntime, status, 'extract');
  for (let index = 0; index < runtime.embedBatchSize; index += 1) {
    const processedEmbed = await processOne(store, runtime, modelRuntime, status, 'embed');
    const processedBackfill = await processOne(store, runtime, modelRuntime, status, 'backfill');
    if (!processedEmbed && !processedBackfill) break;
  }
}

export function parseEmbeddingWorkPayload(work: MemoryV2WorkRecord): EmbeddingWorkPayload {
  if (work.workType !== 'embed' && work.workType !== 'backfill') {
    throw new MemoryRuntimeError('embed', 'validation', 'memory_embedding_work_type_invalid', 'Work is not an embedding operation.');
  }
  return JSON.parse(work.payload) as EmbeddingWorkPayload;
}
