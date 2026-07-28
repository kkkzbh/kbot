import { Logger } from 'koishi';
import type { ModelRuntimeClient } from '../model-config/index.js';
import type { MemoryRuntimeConfig } from './config.js';
import {
  asMemoryRuntimeError,
  memorySafeErrorMessage,
  MemoryRuntimeError,
} from './errors.js';
import { isNonRetryableMemoryProviderError } from './providers/http-error.js';
import {
  extractMemoryCandidates,
  isMemoryExtractWorkloadEnabled,
} from './providers/router.js';
import type { MemoryStatusService } from './status.js';
import type {
  ClaimedMemoryWork,
  ExtractWorkPayload,
  MemoryStore,
} from './store.js';

const logger = new Logger('memory');

export async function processExtractWork(
  store: MemoryStore,
  runtime: MemoryRuntimeConfig,
  modelRuntime: ModelRuntimeClient,
  status: MemoryStatusService,
  claimed: ClaimedMemoryWork,
): Promise<void> {
  const payload = store.parseWorkPayload<ExtractWorkPayload>(claimed.work);
  if (!payload.address?.conversationId || !payload.targetSpeakerId) {
    throw new MemoryRuntimeError(
      'extract',
      'validation',
      'memory_extract_payload_invalid',
      'Extraction work payload is invalid.',
    );
  }
  if (!isMemoryExtractWorkloadEnabled(modelRuntime)) {
    await store.cancelWork(
      claimed.work,
      claimed.leaseToken,
      'memory_extract_disabled',
    );
    return;
  }
  const turns = await store.filterSuppressedTurns(
    payload.address.userKey,
    payload.address.contextKey,
    await store.readConversationWindow(payload),
  );
  if (!turns.some((turn) => (
    turn.role === 'human'
    && turn.isTarget
    && turn.speakerId === payload.targetSpeakerId
    && (
      turn.attributionSource === 'direct_session'
      || turn.attributionSource === 'additional_kwargs'
    )
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
    maxLeaseRetries: runtime.maxJobRetries,
  });
}

async function handleFailure(
  store: MemoryStore,
  runtime: MemoryRuntimeConfig,
  claimed: ClaimedMemoryWork,
  error: unknown,
): Promise<void> {
  const typed = asMemoryRuntimeError(
    error,
    'extract',
    error instanceof MemoryRuntimeError ? error.stage : 'provider',
    error instanceof MemoryRuntimeError ? error.code : 'memory_extract_failed',
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
  await store.failWork(claimed.work, claimed.leaseToken, typed, {
    maxRetries: runtime.maxJobRetries,
    retryDelayMs: 60_000,
  });
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
  const claimed = await store.claimDueWork(
    'extract',
    Date.now(),
    runtime.jobLockTimeoutMs,
  );
  if (!claimed) return;
  const startedAt = Date.now();
  status.recordAttempt('runtime', startedAt);
  try {
    await processExtractWork(store, runtime, modelRuntime, status, claimed);
    status.recordSuccess('runtime', Date.now() - startedAt, Date.now());
  } catch (error) {
    status.recordFailure('runtime', error, Date.now() - startedAt, Date.now());
    logger.warn(
      'memory extract work failed at %s/%s: %s',
      error instanceof MemoryRuntimeError ? error.operation : 'unknown',
      error instanceof MemoryRuntimeError ? error.stage : 'unknown',
      memorySafeErrorMessage(error),
    );
    await handleFailure(store, runtime, claimed, error);
  }
}
