import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  return {
    Context: class {},
    Logger: class {
      info(): void {}
      warn(): void {}
    },
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
  registerMemoryLedgerModels: vi.fn(),
  extractMemoryCandidates: vi.fn(async () => ({
    ok: true,
    route: 'native_chat_json_schema',
    candidates: [],
    drops: [],
    rawTextHash: null,
    error: null,
  })),
  processMaintenance: vi.fn(async () => undefined),
  registerMemoryCommands: vi.fn(),
  runMemoryJobTick: vi.fn(async () => undefined),
  MemoryAdminService: vi.fn(),
  MemoryStatusService: vi.fn(function MemoryStatusService(
    this: { recordRoute: ReturnType<typeof vi.fn> },
  ) {
    this.recordRoute = vi.fn();
  }),
}));

const storeMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    assertSchemaVersion: ReturnType<typeof vi.fn>;
    upsertAddress: ReturnType<typeof vi.fn>;
    getUserFlags: ReturnType<typeof vi.fn>;
    queueExtractWork: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('../src/plugins/memory/admin.js', () => ({
  MemoryAdminService: memoryMocks.MemoryAdminService,
}));

vi.mock('../src/plugins/memory/commands.js', () => ({
  registerMemoryCommands: memoryMocks.registerMemoryCommands,
}));

vi.mock('../src/plugins/memory/pipeline.js', () => ({
  processMaintenance: memoryMocks.processMaintenance,
  runMemoryJobTick: memoryMocks.runMemoryJobTick,
}));

vi.mock('../src/plugins/memory/providers/embedding-client.js', () => ({
  embedTexts: memoryMocks.embedTexts,
}));

vi.mock('../src/plugins/memory/providers/router.js', () => ({
  extractMemoryCandidates: memoryMocks.extractMemoryCandidates,
}));

vi.mock('../src/plugins/memory/schema.js', () => ({
  MEMORY_LEDGER_SCHEMA_VERSION: 2,
  registerMemoryLedgerModels: memoryMocks.registerMemoryLedgerModels,
}));

vi.mock('../src/plugins/memory/status.js', () => ({
  MemoryStatusService: memoryMocks.MemoryStatusService,
  createUnavailableMemoryStatusSnapshot: vi.fn(),
}));

vi.mock('../src/plugins/memory/store.js', () => ({
  MemoryStore: class {
    assertSchemaVersion = vi.fn(async () => undefined);
    upsertAddress = vi.fn(async () => undefined);
    getUserFlags = vi.fn(async () => ({ readEnabled: true, writeEnabled: true }));
    queueExtractWork = vi.fn(async () => false);

    constructor() {
      storeMocks.instances.push(this);
    }
  },
}));

import { apply } from '../src/plugins/memory/index.js';
import {
  clearPromptAssemblyTurn,
  registerPromptFragment,
} from '../src/plugins/shared/prompt-context/index.js';

type EventHandler = () => Promise<unknown> | unknown;
type ChainMiddleware = (
  session: Record<string, any>,
  context: Record<string, any>,
) => Promise<number>;
type ChainConstraint = {
  name: string;
  kind: 'after' | 'before';
  target: string;
};

function config(maintenance = false) {
  return {
    enabled: true,
    maintenance,
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

function createChainHarness(
  store: Map<string, ChainMiddleware>,
  constraints: ChainConstraint[],
) {
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

function createHarness(options: {
  chatChainInitially?: boolean;
  contextManager?: boolean;
  maintenance?: boolean;
} = {}) {
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
    modelRuntime: {
      resolve: vi.fn((workload: string) => ({
        revision: 4,
        target: {
          canonicalModel: workload === 'memory.embedding'
            ? 'qqbot-siliconflow/qwen3-embedding-8b'
            : 'qqbot-codex/gpt-5.6-luna',
        },
      })),
    },
    chatluna,
    get: vi.fn((name: string) => (
      name === 'chatluna' ? chatluna : undefined
    )),
    on: vi.fn((name: string, handler: EventHandler) => {
      const bucket = events.get(name) ?? [];
      bucket.push(handler);
      events.set(name, bucket);
    }),
    provide: vi.fn(),
    set: vi.fn(),
    setInterval: vi.fn(),
  };

  apply(ctx as never, config(options.maintenance));

  return {
    chainMiddlewares,
    chainConstraints,
    chatChain,
    chatluna,
    ctx,
    runHook: async (name: string) => {
      for (const handler of events.get(name) ?? []) await handler();
    },
    setChatChainAvailable: () => {
      chatluna.chatChain = chatChain;
    },
  };
}

describe('Memory Ledger V2 ChatLuna lifecycle', () => {
  const originalReadinessPath = process.env.QQBOT_MEMORY_READY_FILE;

  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.instances.length = 0;
  });

  afterEach(() => {
    if (originalReadinessPath === undefined) {
      delete process.env.QQBOT_MEMORY_READY_FILE;
    } else {
      process.env.QQBOT_MEMORY_READY_FILE = originalReadinessPath;
    }
  });

  it('gates runtime registration on schemaVersion=2 without running migration code', async () => {
    const harness = createHarness({ chatChainInitially: false });
    const store = storeMocks.instances.at(-1)!;

    expect(memoryMocks.registerMemoryLedgerModels).toHaveBeenCalledTimes(1);

    await harness.runHook('ready');

    expect(store.assertSchemaVersion).toHaveBeenCalledTimes(1);
    expect(harness.chainMiddlewares.size).toBe(0);
    expect(harness.ctx.setInterval).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(memoryMocks.runMemoryJobTick).toHaveBeenCalledTimes(1);
      expect(memoryMocks.processMaintenance).toHaveBeenCalledTimes(1);
    });

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

    await harness.runHook('chatluna/chat-chain-added');
    expect(harness.chatChain.middleware).toHaveBeenCalledTimes(2);
    expect(store.assertSchemaVersion).toHaveBeenCalledTimes(1);
  });

  it('keeps workers stopped during explicit maintenance', async () => {
    const harness = createHarness({ maintenance: true });
    const store = storeMocks.instances.at(-1)!;

    await harness.runHook('ready');

    expect(store.assertSchemaVersion).toHaveBeenCalledTimes(1);
    expect(harness.chainMiddlewares.get('qqbot_memory')).toBeTypeOf('function');
    expect(harness.ctx.setInterval).not.toHaveBeenCalled();
    expect(memoryMocks.runMemoryJobTick).not.toHaveBeenCalled();
    expect(memoryMocks.processMaintenance).not.toHaveBeenCalled();
  });

  it('fails fast when ChatLuna exposes a chain without contextManager', async () => {
    const harness = createHarness({ contextManager: false });
    await expect(harness.runHook('ready')).rejects.toThrow(
      'memory requires chatluna.contextManager.',
    );
  });

  it('injects a low-authority prompt envelope after memory assembly', async () => {
    const harness = createHarness();
    const conversationId = 'conv-resolution-only-memory';
    await harness.runHook('ready');
    registerPromptFragment(conversationId, {
      source: 'qqbot_memory',
      title: 'Memory Context',
      authority: 'reference',
      trust: 'untrusted',
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
            conversation: { id: conversationId },
          },
        },
      },
    );

    expect(
      (harness.chatluna.contextManager as {
        inject: ReturnType<typeof vi.fn>;
      }).inject,
    ).toHaveBeenCalledWith(expect.objectContaining({
      name: 'qqbot_prompt_envelope_reference',
      conversationId,
      stage: 'injections',
      value: [
        expect.objectContaining({
          role: 'human',
          additional_kwargs: {
            qqbot_context: expect.objectContaining({
              authority: 'reference',
              source: 'qqbot_memory',
              trust: 'untrusted',
            }),
          },
        }),
      ],
    }));
    clearPromptAssemblyTurn(conversationId);
  });

  it('publishes process-bound readiness only after schema and model startup validation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-ready-'));
    const marker = join(dir, 'memory-v2-ready.json');
    process.env.QQBOT_MEMORY_READY_FILE = marker;
    try {
      const failed = createHarness();
      storeMocks.instances.at(-1)!.assertSchemaVersion.mockRejectedValueOnce(
        new Error('schema startup failed'),
      );
      await expect(failed.runHook('ready')).rejects.toThrow('schema startup failed');
      expect(() => readFileSync(marker, 'utf8')).toThrow();

      const ready = createHarness();
      await ready.runHook('ready');
      const document = JSON.parse(readFileSync(marker, 'utf8'));
      expect(document).toMatchObject({
        pid: process.pid,
        schemaVersion: 2,
        appliedModelRevision: 4,
        extractionModel: 'qqbot-codex/gpt-5.6-luna',
        embeddingModel: 'qqbot-siliconflow/qwen3-embedding-8b',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
