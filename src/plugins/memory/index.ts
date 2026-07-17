import { Context, Logger, Schema, type Session } from 'koishi';
import { mainChatRuntimeState } from '../shared/llm/main-chat-runtime.js';
import { resolveChatLunaRoomLike } from '../shared/chatluna-conversation.js';
import { consumePromptEnvelope, registerPromptFragment } from '../shared/prompt-context/index.js';
import { resolveSessionAvatarUrl, resolveSessionDisplayName, resolveSessionQqNick } from '../shared/session/index.js';
import { buildMemoryAddress, type MemoryMiddlewareContextLike } from './address.js';
import type { MemoryRuntimeConfig } from './config.js';
import { registerMemoryCommands } from './commands.js';
import { retrieveMemoryForContext } from './recall.js';
import { ensureMemoryTables } from './schema.js';
import { runLegacyMemoryMigration } from './migration.js';
import { MemoryStatusService } from './status.js';
export { MemoryStatusService, createUnavailableMemoryStatusSnapshot } from './status.js';
import { embedTexts, isEmbedRuntimeConfigured } from './providers/embedding-client.js';
import { buildMemoryExtractProviderProfile, extractMemoryCandidates, isMemoryProviderConfigured } from './providers/router.js';
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
export const inject = ['chatluna', 'database'];

const logger = new Logger(name);

export interface Config {
  enabled?: boolean;
  readEnabled?: boolean;
  writeEnabled?: boolean;
  extractBaseUrl?: string;
  extractApiKey?: string;
  extractModel?: string;
  extractTimeoutMs?: number;
  extractRequestMode?: string;
  extractStructuredOutputProtocol?: string;
  extractSupportsJsonMode?: boolean;
  embedBaseUrl?: string;
  embedApiKey?: string;
  embedModel?: string;
  embedTimeoutMs?: number;
  queryTopK?: number;
  promptBudgetTokens?: number;
  embedBatchSize?: number;
  extractIdleMs?: number;
  extractMessageBatch?: number;
  archiveDays?: number;
  maxJobRetries?: number;
  jobLockTimeoutMs?: number;
  maxFacts?: number;
  maxEpisodes?: number;
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().description('是否启用本地长期记忆。'),
  readEnabled: Schema.boolean().description('是否启用长期记忆召回。'),
  writeEnabled: Schema.boolean().description('是否启用长期记忆提炼写入。'),
  extractBaseUrl: Schema.string().description('长期记忆提炼用 OpenAI 兼容 Base URL；必须和 API Key、模型一起显式配置。'),
  extractApiKey: Schema.string().role('secret').description('长期记忆提炼用 API Key；缺失时不会写入长期记忆。'),
  extractModel: Schema.string().description('长期记忆提炼模型；缺失时不会写入长期记忆。'),
  extractTimeoutMs: Schema.natural().role('time').description('长期记忆提炼请求超时（毫秒）。'),
  extractRequestMode: Schema.string().description('提炼请求模式：chat_completions / responses。'),
  extractStructuredOutputProtocol: Schema.string().description('提炼输出协议。'),
  extractSupportsJsonMode: Schema.boolean().description('提炼 provider 是否支持 JSON mode + repair。'),
  embedBaseUrl: Schema.string().role('link').description('embedding 服务 Base URL。'),
  embedApiKey: Schema.string().role('secret').description('embedding 服务 API Key。'),
  embedModel: Schema.string().description('embedding 模型。'),
  embedTimeoutMs: Schema.natural().role('time').description('embedding 请求超时（毫秒）。'),
  queryTopK: Schema.natural().description('长期记忆召回条数上限。'),
  promptBudgetTokens: Schema.natural().description('长期记忆注入 prompt 预算。'),
  embedBatchSize: Schema.natural().description('单批 embedding 条数。'),
  extractIdleMs: Schema.natural().role('time').description('会话静默多久后触发记忆提炼。'),
  extractMessageBatch: Schema.natural().description('提炼时读取的最近消息条数。'),
  archiveDays: Schema.natural().description('低风险 episode 归档天数。'),
  maxJobRetries: Schema.natural().description('job 最大重试次数。'),
  jobLockTimeoutMs: Schema.natural().role('time').description('processing job 锁超时。'),
  maxFacts: Schema.natural().description('单批最多写入 fact 候选数。'),
  maxEpisodes: Schema.natural().description('单批最多写入 episode 候选数。'),
});

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
  database?: {
    get: (table: string, query: Record<string, unknown>) => Promise<any[]>;
    set: (table: string, query: Record<string, unknown>, data: Record<string, unknown>) => Promise<unknown>;
    upsert?: (table: string, rows: Record<string, unknown>[], keys?: string[]) => Promise<unknown>;
    create: (table: string, row: Record<string, unknown>) => Promise<Record<string, unknown>>;
    remove: (table: string, query: Record<string, unknown>) => Promise<unknown>;
  };
};

function requireNaturalConfig(config: Config, key: keyof Config, min = 1): number {
  const parsed = Number(config[key]);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`长期记忆配置缺失或非法：${String(key)}。默认值必须由 koishi.yml 显式传入。`);
  }
  return Math.max(min, Math.floor(parsed));
}

function requireBooleanConfig(config: Config, key: keyof Config): boolean {
  const value = config[key];
  if (typeof value !== 'boolean') {
    throw new Error(`长期记忆配置缺失或非法：${String(key)}。默认值必须由 koishi.yml 显式传入。`);
  }
  return value;
}

function requireStringConfig(config: Config, key: keyof Config): string {
  const value = config[key];
  if (value == null) {
    throw new Error(`长期记忆配置缺失：${String(key)}。默认值必须由 koishi.yml 显式传入。`);
  }
  return String(value).trim();
}

function requireExtractRequestMode(config: Config): 'chat_completions' | 'responses' {
  const value = requireStringConfig(config, 'extractRequestMode');
  if (value !== 'chat_completions' && value !== 'responses') {
    throw new Error('长期记忆配置 extractRequestMode 必须是 chat_completions 或 responses。');
  }
  return value;
}

function requireExtractProtocol(config: Config): 'native_chat_json_schema' | 'native_responses_json_schema' | 'chat_reply_v1' | 'json_mode' {
  const value = requireStringConfig(config, 'extractStructuredOutputProtocol');
  if (
    value !== 'native_chat_json_schema' &&
    value !== 'native_responses_json_schema' &&
    value !== 'chat_reply_v1' &&
    value !== 'json_mode'
  ) {
    throw new Error('长期记忆配置 extractStructuredOutputProtocol 不受支持。');
  }
  return value;
}

function resolveChatLunaService(ctx: ContextServiceView): ChatLunaLike | undefined {
  const getter = ctx.get;
  if (typeof getter === 'function') {
    const service = getter.call(ctx, 'chatluna');
    if (service) return service as ChatLunaLike;
  }
  return ctx.chatluna;
}

export function toRuntimeConfig(config: Config): MemoryRuntimeConfig {
  const mainProfile = mainChatRuntimeState.getProfile();
  return {
    enabled: requireBooleanConfig(config, 'enabled'),
    readEnabled: requireBooleanConfig(config, 'readEnabled'),
    writeEnabled: requireBooleanConfig(config, 'writeEnabled'),
    extract: buildMemoryExtractProviderProfile(mainProfile, {
      routeId: 'memory-extract',
      baseUrl: requireStringConfig(config, 'extractBaseUrl'),
      apiKey: requireStringConfig(config, 'extractApiKey'),
      model: requireStringConfig(config, 'extractModel'),
      timeoutMs: requireNaturalConfig(config, 'extractTimeoutMs', 3000),
      requestMode: requireExtractRequestMode(config),
      structuredOutputProtocol: requireExtractProtocol(config),
      supportsJsonMode: requireBooleanConfig(config, 'extractSupportsJsonMode'),
    }),
    embed: {
      baseUrl: requireStringConfig(config, 'embedBaseUrl'),
      apiKey: requireStringConfig(config, 'embedApiKey'),
      model: requireStringConfig(config, 'embedModel'),
      timeoutMs: requireNaturalConfig(config, 'embedTimeoutMs', 3000),
    },
    queryTopK: requireNaturalConfig(config, 'queryTopK', 1),
    promptBudgetTokens: requireNaturalConfig(config, 'promptBudgetTokens', 200),
    embedBatchSize: requireNaturalConfig(config, 'embedBatchSize', 1),
    extractIdleMs: requireNaturalConfig(config, 'extractIdleMs', 10_000),
    extractMessageBatch: requireNaturalConfig(config, 'extractMessageBatch', 4),
    archiveDays: requireNaturalConfig(config, 'archiveDays', 7),
    maxJobRetries: requireNaturalConfig(config, 'maxJobRetries', 0),
    jobLockTimeoutMs: requireNaturalConfig(config, 'jobLockTimeoutMs', 30_000),
    maxFacts: requireNaturalConfig(config, 'maxFacts', 1),
    maxEpisodes: requireNaturalConfig(config, 'maxEpisodes', 1),
  };
}

function resolveInputText(session: Session, context: MemoryMiddlewareContextLike): string {
  return extractPlainText(session.stripped?.content ?? session.content ?? context.options?.inputMessage?.content);
}

async function injectMemoryContext(
  store: MemoryStore,
  runtime: MemoryRuntimeConfig,
  address: ReturnType<typeof buildMemoryAddress> extends infer T ? NonNullable<T> : never,
  query: string,
): Promise<void> {
  let queryEmbedding: number[] | null = null;
  if (query.trim() && isEmbedRuntimeConfigured(runtime.embed)) {
    const [vector] = await embedTexts(runtime.embed, [query]);
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
  const runtime = toRuntimeConfig(config);
  if (!runtime.enabled || !database) return;

  ensureMemoryTables(ctx);
  const store = new MemoryStore(database);
  const adminService = new MemoryAdminService(database, store);
  const statusService = new MemoryStatusService(
    runtime,
    store,
    async () => {
      const [vector] = await embedTexts(runtime.embed, ['healthcheck']);
      if (!vector) throw new Error('empty_embedding_vector');
    },
    async () => {
      if (!isMemoryProviderConfigured(runtime.extract)) throw new Error('memory_provider_unconfigured');
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
        providerProfile: runtime.extract,
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
      await runMemoryJobTick(store, runtime, statusService);
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
            await injectMemoryContext(store, runtime, address, inputText);
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
