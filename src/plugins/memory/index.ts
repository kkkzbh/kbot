import { Context, Logger, type Session } from 'koishi';
import type { MemoryAddress } from '../../types/memory.js';
import type { ModelRuntimeClient } from '../model-config/index.js';
import { resolveChatLunaRoomLike } from '../shared/chatluna-conversation.js';
import {
  consumePromptEnvelope,
  injectPromptEnvelope,
  registerPromptFragment,
} from '../shared/prompt-context/index.js';
import { resolveSessionAvatarUrl, resolveSessionDisplayName } from '../shared/session/index.js';
import {
  buildMemoryAddress,
  resolveCurrentMemoryAudience,
  type MemoryMiddlewareContextLike,
} from './address.js';
import {
  Config as ConfigSchema,
  toRuntimeConfig,
  type Config as MemoryPluginConfig,
  type MemoryRuntimeConfig,
} from './config.js';
import { registerMemoryCommands } from './commands.js';
import { memorySafeErrorMessage, MemoryRuntimeError } from './errors.js';
import { retrieveMemoryForContext } from './recall.js';
import { registerMemoryLedgerModels } from './schema.js';
import { MemoryStatusService } from './status.js';
export { MemoryStatusService, createUnavailableMemoryStatusSnapshot } from './status.js';
import { embedTexts } from './providers/embedding-client.js';
import { extractMemoryCandidates } from './providers/router.js';
import { processMaintenance, runMemoryJobTick } from './pipeline.js';
import {
  clearMemoryReadinessMarker,
  publishMemoryReadinessMarker,
} from './readiness.js';
import { extractPlainText, MemoryStore, type MemoryDatabaseLike } from './store.js';
export { MemoryStore, MemoryUnitOfWork } from './store.js';
export {
  createMemoryExtractLaneKey,
  type MemoryExtractLaneKey,
} from './identity.js';
export { MemoryPolicyService } from './policy.js';
export { MemoryRuntimeError } from './errors.js';
import { MemoryAdminService } from './admin.js';
export { MemoryAdminService } from './admin.js';
export type {
  MemoryAdminAssertionItem,
  MemoryAdminPage,
  MemoryAdminPageQuery,
  MemoryAdminReviewItem,
  MemoryOperationalAttentionItem,
} from './admin.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { STOP: number; CONTINUE: number };
};

export const name = 'memory';
export const inject = {
  required: ['chatluna', 'database', 'modelRuntime'],
} as const;

const logger = new Logger(name);

export const Config = ConfigSchema;
export type Config = MemoryPluginConfig;
export { toRuntimeConfig };

type ChainHookBuilder = {
  after: (name: string) => ChainHookBuilder;
  before: (name: string) => ChainHookBuilder;
};

type ChatLunaLike = {
  contextManager?: {
    inject: (options: {
      name: string;
      value: unknown;
      once?: boolean;
      conversationId?: string;
      stage?: string;
    }) => void;
  };
  chatChain?: {
    middleware: (name: string, middleware: (session: unknown, context: unknown) => Promise<number>) => ChainHookBuilder;
  };
};

type ContextServiceView = {
  get?: (name: string) => unknown;
  chatluna?: ChatLunaLike;
  modelRuntime?: ModelRuntimeClient;
  database?: MemoryDatabaseLike;
};

function resolveChatLunaService(ctx: ContextServiceView): ChatLunaLike | undefined {
  const getter = ctx.get;
  if (typeof getter === 'function') {
    const service = getter.call(ctx, 'chatluna');
    if (service) return service as ChatLunaLike;
  }
  return ctx.chatluna;
}

function resolveInputText(session: Session, context: MemoryMiddlewareContextLike): string {
  return extractPlainText(session.stripped?.content ?? session.content ?? context.options?.inputMessage?.content);
}

function resolveEmbeddingIdentity(modelRuntime: ModelRuntimeClient): {
  canonicalModel: string;
  modelRevision: number;
} | null {
  const binding = modelRuntime.resolve('memory.embedding');
  if (!binding.target) return null;
  return {
    canonicalModel: binding.target.canonicalModel,
    modelRevision: binding.revision,
  };
}

async function injectMemoryContext(
  store: MemoryStore,
  runtime: MemoryRuntimeConfig,
  modelRuntime: ModelRuntimeClient,
  address: NonNullable<ReturnType<typeof buildMemoryAddress>>,
  query: string,
): Promise<void> {
  const identity = resolveEmbeddingIdentity(modelRuntime);
  if (!identity) {
    throw new MemoryRuntimeError(
      'recall',
      'validation',
      'memory_embedding_disabled',
      'memory.embedding must be configured while memory recall is enabled.',
    );
  }
  const [queryEmbedding] = await embedTexts(modelRuntime, [query]);
  if (!queryEmbedding?.length) {
    throw new MemoryRuntimeError(
      'recall',
      'provider',
      'memory_query_embedding_empty',
      'Memory embedding provider returned no query vector.',
      { retryable: true },
    );
  }
  const result = await retrieveMemoryForContext(store, address, query, {
    topK: runtime.queryTopK,
    promptBudgetTokens: runtime.promptBudgetTokens,
    embeddingIdentity: identity,
    queryEmbedding,
  });
  if (!result.prompt) return;
  registerPromptFragment(address.conversationId, {
    source: 'qqbot_memory',
    title: 'QQBot Memory Reference',
    authority: 'reference',
    trust: 'untrusted',
    ttl: 'turn',
    payload: {
      kind: 'text',
      value: result.prompt,
    },
  });
}

export function apply(ctx: Context, config: Config): void {
  const services = ctx as unknown as ContextServiceView;
  const database = services.database;
  const modelRuntime = services.modelRuntime;
  const runtime = toRuntimeConfig(config);
  if (!runtime.enabled) return;
  if (!database) throw new Error('memory requires database service.');
  if (!modelRuntime) throw new Error('memory requires modelRuntime service.');
  clearMemoryReadinessMarker();

  registerMemoryLedgerModels(ctx, database);
  const store = new MemoryStore(database);
  const adminService = new MemoryAdminService(database, store, runtime);
  const statusService = new MemoryStatusService(
    runtime,
    modelRuntime,
    store,
    async () => {
      const binding = modelRuntime.resolve('memory.embedding');
      if (!binding.target) {
        throw new MemoryRuntimeError('embed', 'validation', 'memory_embedding_probe_disabled', 'Embedding probe has no live model target.');
      }
      const [vector] = await embedTexts(modelRuntime, ['memory ledger healthcheck']);
      if (!vector?.length || vector.some((value) => !Number.isFinite(value))) {
        throw new MemoryRuntimeError('embed', 'provider', 'memory_embedding_probe_empty', 'Embedding probe returned no vector.');
      }
      return {
        canonicalModel: binding.target.canonicalModel,
        schemaValid: true as const,
        dimensions: vector.length,
      };
    },
    async () => {
      const binding = modelRuntime.resolve('memory.extract');
      if (!binding.target) {
        throw new MemoryRuntimeError('extract', 'validation', 'memory_extract_probe_disabled', 'Extraction probe has no live model target.');
      }
      const output = await extractMemoryCandidates({
        address: {
          userKey: 'probe:user:memory',
          contextKey: 'probe:bot:memory:dm:memory',
          channelType: 'direct',
          platform: 'probe',
          botSelfId: 'memory',
          userId: 'memory',
          conversationId: 'probe-memory-extract',
          observedAt: Date.now(),
        },
        target: {
          speakerId: 'memory',
          speakerName: 'probe',
        },
        turns: [{
          id: 'probe-message',
          role: 'human',
          text: '记忆提炼健康检查，不写入长期记忆。',
          speakerId: 'memory',
          speakerName: 'probe',
          ownerUserKey: 'probe:user:memory',
          isTarget: true,
          attributionSource: 'direct_session',
          parentId: null,
          occurredAt: Date.now(),
        }],
        modelRuntime,
        maxFacts: 1,
        maxEpisodes: 1,
      });
      statusService.recordRoute(output.route, output.ok, output.error);
      if (!output.ok) {
        throw new MemoryRuntimeError(
          'extract',
          'provider',
          'memory_extract_probe_failed',
          'Memory extraction probe failed.',
        );
      }
      return {
        canonicalModel: binding.target.canonicalModel,
        schemaValid: true as const,
        dimensions: null,
      };
    },
  );
  ctx.provide('memoryStatus');
  ctx.set('memoryStatus', statusService);
  ctx.provide('memoryAdmin');
  ctx.set('memoryAdmin', adminService);
  registerMemoryCommands(ctx, store, statusService, runtime, modelRuntime);

  let processing = false;
  let lastMaintenanceAt = 0;
  const tick = async (): Promise<void> => {
    if (processing || runtime.maintenance) return;
    processing = true;
    try {
      await runMemoryJobTick(store, runtime, modelRuntime, statusService);
      const now = Date.now();
      if (!lastMaintenanceAt || now - lastMaintenanceAt >= 6 * 60 * 60 * 1000) {
        await processMaintenance(store, runtime, statusService);
        lastMaintenanceAt = now;
      }
    } finally {
      processing = false;
    }
  };

  let schemaReady = false;
  let runtimeRegistered = false;
  let workersStarted = false;
  let readinessPublished = false;

  const publishReadiness = (): void => {
    if (readinessPublished || !schemaReady || !runtimeRegistered) return;
    const extraction = modelRuntime.resolve('memory.extract');
    const embedding = modelRuntime.resolve('memory.embedding');
    if (!extraction.target || !embedding.target) {
      throw new MemoryRuntimeError(
        'startup',
        'validation',
        'memory_model_binding_missing',
        'Memory V2 requires live extraction and embedding model bindings.',
      );
    }
    if (
      !Number.isInteger(extraction.revision)
      || extraction.revision < 1
      || extraction.revision !== embedding.revision
    ) {
      throw new MemoryRuntimeError(
        'startup',
        'validation',
        'memory_model_revision_mismatch',
        'Memory V2 model bindings must resolve from one positive applied revision.',
      );
    }
    publishMemoryReadinessMarker({
      appliedModelRevision: extraction.revision,
      extractionModel: extraction.target.canonicalModel,
      embeddingModel: embedding.target.canonicalModel,
    });
    readinessPublished = true;
  };

  const registerRuntime = (): boolean => {
    if (runtimeRegistered) return true;
    const chatluna = resolveChatLunaService(services);
    const chain = chatluna?.chatChain;
    const contextManager = chatluna?.contextManager;
    if (!chain) return false;
    if (!contextManager) throw new Error('memory requires chatluna.contextManager.');

    chain
      .middleware('qqbot_memory', async (rawSession, rawContext) => {
        if (!schemaReady || runtime.maintenance) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }
        const session = rawSession as Session;
        const context = rawContext as MemoryMiddlewareContextLike;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }
        const baseAddress = buildMemoryAddress(session, context);
        const inputText = resolveInputText(session, context);
        if (!baseAddress || !inputText) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        let address: MemoryAddress;
        try {
          address = await resolveCurrentMemoryAudience(session, baseAddress);
        } catch (error) {
          logger.warn(
            'memory audience resolution failed at %s/%s: %s',
            error instanceof MemoryRuntimeError ? error.operation : 'address',
            error instanceof MemoryRuntimeError ? error.stage : 'provider',
            memorySafeErrorMessage(error),
          );
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }
        await store.upsertAddress(address, {
          displayName: resolveSessionDisplayName(session),
          avatarUrl: resolveSessionAvatarUrl(session),
        });
        const flags = await store.getUserFlags(address.userKey);
        if (runtime.writeEnabled && flags.writeEnabled) {
          await store.queueExtractWork({
            address,
            targetSpeakerId: address.userId,
            targetSpeakerName: resolveSessionDisplayName(session),
            maxMessages: runtime.extractMessageBatch,
            nextRunAt: Date.now() + runtime.extractIdleMs,
          });
        }
        if (runtime.readEnabled && flags.readEnabled) {
          try {
            await injectMemoryContext(store, runtime, modelRuntime, address, inputText);
          } catch (error) {
            logger.warn(
              'memory recall failed at %s/%s: %s',
              error instanceof MemoryRuntimeError ? error.operation : 'unknown',
              error instanceof MemoryRuntimeError ? error.stage : 'unknown',
              memorySafeErrorMessage(error),
            );
          }
        }
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('read_chat_message')
      .after('resolve_conversation')
      .before('lifecycle-handle_command');

    chain
      .middleware('qqbot_prompt_envelope', async (rawSession, rawContext) => {
        const session = rawSession as Session;
        const context = rawContext as MemoryMiddlewareContextLike;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }
        const conversationId = resolveChatLunaRoomLike(context.options)?.conversationId?.trim();
        if (!conversationId) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        const envelope = consumePromptEnvelope(conversationId);
        if (!envelope?.messages.length) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        injectPromptEnvelope(contextManager, {
          name: 'qqbot_prompt_envelope',
          envelope,
          once: true,
          conversationId,
        });
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('qqbot_memory')
      .after('qqbot_sticker_policy')
      .after('qqbot_reply_transport_policy')
      .after('qqbot_turn_context')
      .before('lifecycle-handle_command');

    runtimeRegistered = true;
    return true;
  };

  const startWorkers = (): void => {
    if (workersStarted || runtime.maintenance) return;
    workersStarted = true;
    ctx.setInterval(() => void tick(), 10_000);
    void tick();
  };

  ctx.on('ready', async () => {
    await store.assertSchemaVersion();
    schemaReady = true;
    registerRuntime();
    startWorkers();
    publishReadiness();
  });

  ctx.on('chatluna/chat-chain-added', () => {
    if (!schemaReady) return;
    registerRuntime();
    publishReadiness();
  });
}
