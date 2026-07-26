import { Context, Logger, type Session } from 'koishi';
import type { ModelRuntimeClient } from '../model-config/index.js';
import { resolveChatLunaRoomLike } from '../shared/chatluna-conversation.js';
import { consumePromptEnvelope, registerPromptFragment } from '../shared/prompt-context/index.js';
import { resolveSessionAvatarUrl, resolveSessionDisplayName, resolveSessionQqNick } from '../shared/session/index.js';
import { buildMemoryAddress, type MemoryMiddlewareContextLike } from './address.js';
import {
  Config as ConfigSchema,
  toRuntimeConfig,
  type Config as MemoryPluginConfig,
  type MemoryRuntimeConfig,
} from './config.js';
import { registerMemoryCommands } from './commands.js';
import { retrieveMemoryForContext } from './recall.js';
import { ensureMemoryTables } from './schema.js';
import { runLegacyMemoryMigration } from './migration.js';
import { MemoryStatusService } from './status.js';
export { MemoryStatusService, createUnavailableMemoryStatusSnapshot } from './status.js';
import { embedTexts } from './providers/embedding-client.js';
import { extractMemoryCandidates } from './providers/router.js';
import { runMemoryJobTick, processMaintenanceJob } from './pipeline.js';
import { extractPlainText, MemoryStore } from './store.js';
export { MemoryStore } from './store.js';
import { MemoryAdminService } from './admin.js';
export { MemoryAdminService } from './admin.js';
export type { MemoryOperationalAttentionItem } from './admin.js';

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
  database?: {
    get: (table: string, query: Record<string, unknown>) => Promise<any[]>;
    set: (table: string, query: Record<string, unknown>, data: Record<string, unknown>) => Promise<unknown>;
    upsert?: (table: string, rows: Record<string, unknown>[], keys?: string[]) => Promise<unknown>;
    create: (table: string, row: Record<string, unknown>) => Promise<Record<string, unknown>>;
    remove: (table: string, query: Record<string, unknown>) => Promise<unknown>;
  };
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

async function injectMemoryContext(
  store: MemoryStore,
  runtime: MemoryRuntimeConfig,
  modelRuntime: ModelRuntimeClient,
  address: ReturnType<typeof buildMemoryAddress> extends infer T ? NonNullable<T> : never,
  query: string,
): Promise<void> {
  let queryEmbedding: number[] | null = null;
  if (query.trim()) {
    const [vector] = await embedTexts(modelRuntime, [query]);
    queryEmbedding = vector;
  }
  const result = await retrieveMemoryForContext(store, address, query, {
    topK: runtime.queryTopK,
    promptBudgetTokens: runtime.promptBudgetTokens,
    queryEmbedding,
  });
  if (!result.prompt) return;
  registerPromptFragment(address.conversationId, {
    source: 'qqbot_memory',
    title: 'Long-Term Memory Reference',
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
  if (!runtime.enabled || !database) return;
  if (!modelRuntime) {
    throw new Error('memory requires modelRuntime service.');
  }

  ensureMemoryTables(ctx);
  const store = new MemoryStore(database);
  const adminService = new MemoryAdminService(database, store);
  const statusService = new MemoryStatusService(
    runtime,
    modelRuntime,
    store,
    async () => {
      const [vector] = await embedTexts(modelRuntime, ['healthcheck']);
      if (!vector) throw new Error('empty_embedding_vector');
    },
    async () => {
      const output = await extractMemoryCandidates({
        address: {
          userKey: 'probe:memory',
          contextKey: 'probe:memory',
          channelType: 'direct',
          platform: 'probe',
          botSelfId: 'probe-bot',
          userId: 'probe-user',
          conversationId: 'probe-memory-extract',
          observedAt: Date.now(),
        },
        target: {
          speakerId: 'probe-user',
          speakerName: 'probe',
        },
        turns: [
          {
            id: 'probe-message',
            role: 'human',
            text: '记忆提炼健康检查，不需要写入任何长期记忆。',
            speakerId: 'probe-user',
            speakerName: 'probe',
            ownerUserKey: 'probe:memory',
            isTarget: true,
            attributionSource: 'direct_session',
          },
        ],
        modelRuntime,
        maxFacts: 1,
        maxEpisodes: 1,
      });
      statusService.recordRoute(output.route, output.ok, output.error);
      if (!output.ok) throw new Error(output.error ?? 'memory_extract_failed');
    },
  );
  ctx.provide('memoryStatus');
  ctx.set('memoryStatus', statusService);
  ctx.provide('memoryAdmin');
  ctx.set('memoryAdmin', adminService);
  registerMemoryCommands(ctx, store, statusService);

  let processing = false;
  let lastMaintenanceAt = 0;
  const tick = async (): Promise<void> => {
    if (processing) return;
    processing = true;
    try {
      await runMemoryJobTick(store, runtime, modelRuntime, statusService);
      const now = Date.now();
      if (!lastMaintenanceAt || now - lastMaintenanceAt >= 6 * 60 * 60 * 1000) {
        await processMaintenanceJob(store, runtime, statusService);
        lastMaintenanceAt = now;
      }
    } finally {
      processing = false;
    }
  };

  let memoryRuntimeRegistered = false;
  let startupTasksStarted = false;

  const startMemoryStartupTasks = (): void => {
    if (startupTasksStarted) return;
    startupTasksStarted = true;
    void (async () => {
      const migrated = await runLegacyMemoryMigration(database);
      const migratedCount = migrated.factsMigrated + migrated.episodesMigrated + migrated.profilesMigrated;
      if (
        migratedCount > 0 ||
        migrated.groupRowsDiscarded > 0 ||
        migrated.legacyRowsRemoved > 0 ||
        migrated.legacyJobsRemoved > 0
      ) {
        logger.info(
          'memory migration imported %d direct rows, discarded %d legacy group rows, removed %d legacy rows and %d legacy jobs',
          migratedCount,
          migrated.groupRowsDiscarded,
          migrated.legacyRowsRemoved,
          migrated.legacyJobsRemoved,
        );
      }
      const recovered = await store.requeueStaleProcessingJobs(runtime.jobLockTimeoutMs);
      if (recovered > 0) {
        logger.warn('memory recovered %d stale processing jobs after startup', recovered);
      }
      ctx.setInterval(() => void tick(), 10_000);
      await tick();
    })().catch((error) => {
      logger.warn('memory startup recovery failed: %s', error instanceof Error ? error.message : String(error));
      ctx.setInterval(() => void tick(), 10_000);
      void tick();
    });
  };

  const ensureMemoryRuntimeRegistered = (): boolean => {
    if (memoryRuntimeRegistered) return true;
    const chatluna = resolveChatLunaService(services);
    const chain = chatluna?.chatChain;
    const contextManager = chatluna?.contextManager;
    if (!chain) return false;
    if (!contextManager) {
      throw new Error('memory requires chatluna.contextManager.');
    }

    chain
      .middleware('qqbot_memory', async (rawSession, rawContext) => {
        const session = rawSession as Session;
        const context = rawContext as MemoryMiddlewareContextLike;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const address = buildMemoryAddress(session, context);
        const inputText = resolveInputText(session, context);
        if (!address || !inputText) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        await store.upsertAddress(address, {
          qqNick: resolveSessionQqNick(session),
          avatarUrl: resolveSessionAvatarUrl(session),
          profileUpdatedAt: address.observedAt,
        });
        const flags = await store.getUserFlags(address.userKey);
        if (runtime.writeEnabled && flags.writeEnabled) {
          await store.queueExtractJob({
            address,
            targetSpeakerId: address.userId,
            targetSpeakerName: resolveSessionDisplayName(session),
            maxMessages: runtime.extractMessageBatch,
            nextRunAt: Date.now() + runtime.extractIdleMs,
          });
        }

        if (runtime.readEnabled && flags.readEnabled) {
          try {
            await injectMemoryContext(
              store,
              runtime,
              modelRuntime,
              address,
              inputText,
            );
          } catch (error) {
            logger.warn('memory recall skipped: %s', error instanceof Error ? error.message : String(error));
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
        if (!envelope?.messages.length) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        contextManager.inject({
          name: 'qqbot_prompt_envelope',
          value: envelope.messages,
          once: true,
          conversationId,
          stage: 'after_scratchpad',
        });
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('qqbot_memory')
      .after('qqbot_sticker_policy')
      .after('qqbot_reply_transport_policy')
      .after('qqbot_turn_context')
      .before('lifecycle-handle_command');

    memoryRuntimeRegistered = true;
    startMemoryStartupTasks();
    return true;
  };

  ctx.on('ready', () => {
    ensureMemoryRuntimeRegistered();
  });

  ctx.on('chatluna/chat-chain-added', () => {
    ensureMemoryRuntimeRegistered();
  });
}
