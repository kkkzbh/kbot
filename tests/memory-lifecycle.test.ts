import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi-plugin-chatluna/chains', () => ({
  ChainMiddlewareRunStatus: { STOP: 1, CONTINUE: 0 },
}));

vi.mock('koishi', () => {
  type MockSchemaNode = {
    description: () => MockSchemaNode;
    role: () => MockSchemaNode;
  };

  const createSchemaNode = (): MockSchemaNode => ({
    description: () => createSchemaNode(),
    role: () => createSchemaNode(),
  });

  class MockLogger {
    info(): void {}
    warn(): void {}
  }

  return {
    Context: class {},
    Logger: MockLogger,
    Schema: {
      object: () => createSchemaNode(),
      boolean: () => createSchemaNode(),
      string: () => createSchemaNode(),
      natural: () => createSchemaNode(),
    },
  };
});

const memoryMocks = vi.hoisted(() => ({
  embedTexts: vi.fn(async () => [[0.1, 0.2]]),
  ensureMemoryTables: vi.fn(),
  extractMemoryCandidates: vi.fn(async () => ({ ok: true, route: 'probe' })),
  processMaintenanceJob: vi.fn(async () => undefined),
  registerMemoryCommands: vi.fn(),
  runLegacyMemoryMigration: vi.fn(async () => ({
    factsMigrated: 0,
    episodesMigrated: 0,
    profilesMigrated: 0,
    groupRowsDiscarded: 0,
    skippedRows: 0,
    legacyRowsRemoved: 0,
    legacyJobsRemoved: 0,
  })),
  runMemoryJobTick: vi.fn(async () => undefined),
  MemoryStatusService: vi.fn(function MemoryStatusService(this: { recordRoute: ReturnType<typeof vi.fn> }) {
    this.recordRoute = vi.fn();
  }),
}));

const storeMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    requeueStaleProcessingJobs: ReturnType<typeof vi.fn>;
    upsertAddress: ReturnType<typeof vi.fn>;
    getUserFlags: ReturnType<typeof vi.fn>;
    queueExtractJob: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('../src/plugins/memory/commands.js', () => ({
  registerMemoryCommands: memoryMocks.registerMemoryCommands,
}));

vi.mock('../src/plugins/memory/migration.js', () => ({
  runLegacyMemoryMigration: memoryMocks.runLegacyMemoryMigration,
}));

vi.mock('../src/plugins/memory/pipeline.js', () => ({
  processMaintenanceJob: memoryMocks.processMaintenanceJob,
  runMemoryJobTick: memoryMocks.runMemoryJobTick,
}));

vi.mock('../src/plugins/memory/providers/embedding-client.js', () => ({
  embedTexts: memoryMocks.embedTexts,
}));

vi.mock('../src/plugins/memory/providers/router.js', () => ({
  extractMemoryCandidates: memoryMocks.extractMemoryCandidates,
}));

vi.mock('../src/plugins/memory/schema.js', () => ({
  ensureMemoryTables: memoryMocks.ensureMemoryTables,
}));

vi.mock('../src/plugins/memory/status.js', () => ({
  MemoryStatusService: memoryMocks.MemoryStatusService,
  createUnavailableMemoryStatusSnapshot: vi.fn(),
}));

vi.mock('../src/plugins/memory/store.js', () => ({
  extractPlainText: (input: unknown) => String(input ?? '').trim(),
  MemoryStore: class {
    requeueStaleProcessingJobs = vi.fn(async () => 0);
    upsertAddress = vi.fn(async () => undefined);
    getUserFlags = vi.fn(async () => ({ readEnabled: true, writeEnabled: true }));
    queueExtractJob = vi.fn(async () => undefined);

    constructor() {
      storeMocks.instances.push(this);
    }
  },
}));

import { apply } from '../src/plugins/memory/index.js';
import { clearPromptAssemblyTurn, registerPromptFragment } from '../src/plugins/shared/prompt-context/index.js';

type EventHandler = () => Promise<unknown> | unknown;
type ChainMiddleware = (session: Record<string, any>, context: Record<string, any>) => Promise<number>;
type ChainConstraint = { name: string; kind: 'after' | 'before'; target: string };

function config() {
  return {
    enabled: true,
    readEnabled: true,
    writeEnabled: true,
    queryTopK: 4,
    promptBudgetTokens: 800,
    embedBatchSize: 8,
    extractIdleMs: 10_000,
    extractMessageBatch: 8,
    archiveDays: 30,
    maxJobRetries: 3,
    jobLockTimeoutMs: 300_000,
    maxFacts: 5,
    maxEpisodes: 5,
  };
}

function createChainHarness(store: Map<string, ChainMiddleware>, constraints: ChainConstraint[]) {
  return {
    middleware: vi.fn((name: string, middleware: ChainMiddleware) => {
      store.set(name, middleware);
      const builder = {
        after: (target: string) => {
          constraints.push({ name, kind: 'after', target });
          return builder;
        },
        before: (target: string) => {
          constraints.push({ name, kind: 'before', target });
          return builder;
        },
      };
      return builder;
    }),
  };
}

function createHarness(options: { chatChainInitially?: boolean; contextManager?: boolean } = {}) {
  const events = new Map<string, EventHandler[]>();
  const chainMiddlewares = new Map<string, ChainMiddleware>();
  const chainConstraints: ChainConstraint[] = [];
  const chatChain = createChainHarness(chainMiddlewares, chainConstraints);
  const chatluna: Record<string, unknown> = {};
  if (options.contextManager !== false) {
    chatluna.contextManager = { inject: vi.fn() };
  }
  if (options.chatChainInitially !== false) {
    chatluna.chatChain = chatChain;
  }

  const ctx = {
    database: {},
    modelRuntime: {},
    chatluna,
    get: vi.fn((name: string) => (name === 'chatluna' ? chatluna : undefined)),
    on: vi.fn((name: string, handler: EventHandler) => {
      const bucket = events.get(name) ?? [];
      bucket.push(handler);
      events.set(name, bucket);
    }),
    provide: vi.fn(),
    set: vi.fn(),
    setInterval: vi.fn(),
  };

  apply(ctx as never, config());

  const runHook = async (name: string) => {
    for (const handler of events.get(name) ?? []) {
      await handler();
    }
  };

  return {
    chainMiddlewares,
    chainConstraints,
    chatChain,
    chatluna,
    ctx,
    runHook,
    setChatChainAvailable: () => {
      chatluna.chatChain = chatChain;
    },
  };
}

describe('memory ChatLuna lifecycle', () => {
  it('registers memory middlewares when ChatLuna adds the chat chain', async () => {
    const harness = createHarness({ chatChainInitially: false });

    await harness.runHook('ready');

    expect(harness.chainMiddlewares.size).toBe(0);
    expect(memoryMocks.runLegacyMemoryMigration).not.toHaveBeenCalled();

    harness.setChatChainAvailable();
    await harness.runHook('chatluna/chat-chain-added');

    expect(harness.chainMiddlewares.get('qqbot_memory')).toBeTypeOf('function');
    expect(harness.chainMiddlewares.get('qqbot_prompt_envelope')).toBeTypeOf('function');
    expect(harness.chainConstraints).toContainEqual({
      name: 'qqbot_memory',
      kind: 'after',
      target: 'resolve_conversation',
    });
    expect(harness.chatChain.middleware).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(memoryMocks.runLegacyMemoryMigration).toHaveBeenCalledTimes(1));
    expect(storeMocks.instances[0]?.requeueStaleProcessingJobs).toHaveBeenCalledWith(300_000);
    expect(memoryMocks.runMemoryJobTick).toHaveBeenCalledTimes(1);
    expect(memoryMocks.processMaintenanceJob).toHaveBeenCalledTimes(1);
    expect(harness.ctx.setInterval).toHaveBeenCalledTimes(1);

    await harness.runHook('chatluna/chat-chain-added');

    expect(harness.chatChain.middleware).toHaveBeenCalledTimes(2);
    expect(memoryMocks.runLegacyMemoryMigration).toHaveBeenCalledTimes(1);
    expect(harness.ctx.setInterval).toHaveBeenCalledTimes(1);
  });

  it('fails fast when ChatLuna exposes a chain without contextManager', async () => {
    const harness = createHarness({ contextManager: false });

    await expect(harness.runHook('ready')).rejects.toThrow('memory requires chatluna.contextManager.');
  });

  it('injects prompt envelopes from ChatLuna conversation resolution without legacy room data', async () => {
    const harness = createHarness();
    const conversationId = 'conv-resolution-only-memory';

    await harness.runHook('ready');

    registerPromptFragment(conversationId, {
      source: 'qqbot_memory',
      title: 'Memory Context',
      authority: 'assistant_state',
      trust: 'trusted',
      ttl: 'turn',
      payload: {
        kind: 'text',
        value: '用户喜欢安静的回答。',
      },
    });

    await harness.chainMiddlewares.get('qqbot_prompt_envelope')?.(
      {
        userId: '10001',
        bot: { selfId: '20001' },
      },
      {
        options: {
          conversation: {
            conversationId,
            conversation: {
              id: conversationId,
            },
          },
        },
      },
    );

    expect((harness.chatluna.contextManager as { inject: ReturnType<typeof vi.fn> }).inject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'qqbot_prompt_envelope',
        conversationId,
        stage: 'after_scratchpad',
      }),
    );
    clearPromptAssemblyTurn(conversationId);
  });
});
