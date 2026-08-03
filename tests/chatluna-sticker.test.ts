import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi-plugin-chatluna/chains', () => ({
  ChainMiddlewareRunStatus: { STOP: 1, CONTINUE: 0 },
}));

vi.mock('koishi', () => {
  type MockSchemaNode = {
    default: () => MockSchemaNode;
    description: () => MockSchemaNode;
  };

  const createSchemaNode = (): MockSchemaNode => ({
    default: () => createSchemaNode(),
    description: () => createSchemaNode(),
  });

  class MockLogger {
    info(): void {}
    warn(): void {}
    debug(): void {}
  }

  return {
    Context: class {},
    Logger: MockLogger,
    Schema: {
      object: () => createSchemaNode(),
      string: () => createSchemaNode(),
    },
  };
});

const stickerCoreMocks = vi.hoisted(() => ({
  loadStickerCatalog: vi.fn(),
}));

vi.mock('../src/plugins/sticker/selection.js', () => ({
  loadStickerCatalog: stickerCoreMocks.loadStickerCatalog,
}));

import { apply, inject } from '../src/plugins/sticker/index.js';

type EventHandler = (...args: any[]) => Promise<unknown> | unknown;
type ChainMiddleware = (session: Record<string, any>, context: Record<string, any>) => Promise<number>;
type ChainConstraint = {
  name: string;
  kind: 'after' | 'before';
  target: string;
};

function createChainBuilder(store: Map<string, ChainMiddleware>, constraints: ChainConstraint[]) {
  return {
    middleware: (name: string, middleware: ChainMiddleware) => {
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
    },
  };
}

function createHarness(options: { chatChainAvailableInitially?: boolean } = {}) {
  const events = new Map<string, EventHandler[]>();
  const chainMiddlewares = new Map<string, ChainMiddleware>();
  const constraints: ChainConstraint[] = [];
  const chatChain = createChainBuilder(chainMiddlewares, constraints);
  const chatluna: Record<string, unknown> = {};
  if (options.chatChainAvailableInitially !== false) {
    chatluna.chatChain = chatChain;
  }

  const ctx = {
    chatluna,
    modelRuntime: {},
    provide: vi.fn(),
    set: vi.fn(),
    get: vi.fn((name: string) => {
      if (name === 'chatluna') return chatluna;
      return undefined;
    }),
    on: vi.fn((name: string, handler: EventHandler) => {
      const existing = events.get(name) ?? [];
      existing.push(handler);
      events.set(name, existing);
    }),
  };

  apply(ctx as never, { stickerDir: './data/chathub/stickers' });

  const runHook = async (name: string) => {
    for (const handler of events.get(name) ?? []) {
      await handler();
    }
  };

  return {
    ready: () => runHook('ready'),
    runChatChainAdded: () => runHook('chatluna/chat-chain-added'),
    setChatChainAvailable: () => {
      chatluna.chatChain = chatChain;
    },
    getPolicy: () => chainMiddlewares.get('qqbot_sticker_policy'),
    getConstraints: () => constraints,
  };
}

function createSession(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    platform: 'onebot',
    channelId: 'group-100',
    guildId: 'group-100',
    userId: 'u1',
    state: {},
    bot: { selfId: 'bot-1' },
    ...overrides,
  };
}

describe('chatluna sticker plugin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stickerCoreMocks.loadStickerCatalog.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('declares the chatluna and unified model runtime dependencies', () => {
    expect(inject).toEqual({
      required: ['chatluna', 'modelRuntime'],
    });
  });

  it('registers sticker policy middleware on ready', async () => {
    stickerCoreMocks.loadStickerCatalog.mockReturnValue({
      entries: [
        {
          id: 'bored',
          scopes: ['persona:sakiko'],
        },
      ],
    });
    const { ready, getPolicy } = createHarness();
    await ready();

    expect(getPolicy()).toBeTypeOf('function');
  });

  it('registers sticker policy after ChatLuna adds the chat chain', async () => {
    stickerCoreMocks.loadStickerCatalog.mockReturnValue({
      entries: [
        {
          id: 'bored',
          scopes: ['persona:sakiko'],
        },
      ],
    });

    const harness = createHarness({ chatChainAvailableInitially: false });
    await harness.ready();

    expect(harness.getPolicy()).toBeUndefined();

    harness.setChatChainAvailable();
    await harness.runChatChainAdded();

    expect(harness.getPolicy()).toBeTypeOf('function');
  });

  it('stores sticker capability state on the session without injecting prompt fragments', async () => {
    const catalog = {
      version: 1,
      generatedAt: '2026-03-16T00:00:00.000Z',
      model: 'doubao-seed-2-0-mini-260215',
      entries: [
        {
          id: 'bored',
          file: 'images/personas/sakiko/bored.png',
          hash: 'hash-1',
          mime: 'image/png',
          scopes: ['persona:sakiko'],
          caption: '无语少女',
          keywords: ['无语'],
          moods: ['无语'],
          scenes: ['吐槽'],
          historyLabel: '无语少女',
          confidence: 0.95,
          buffer: Buffer.from('fake'),
        },
      ],
      byId: new Map(),
    };
    stickerCoreMocks.loadStickerCatalog.mockReturnValue(catalog);
    const { ready, getPolicy } = createHarness();
    await ready();

    const policy = getPolicy();
    const session = createSession();
    const context = {
      options: {
        conversation: {
          conversationId: 'conv-1',
          effectivePreset: 'sakiko',
          conversation: {
            id: 'conv-1',
            preset: 'sakiko',
          },
        },
      },
    };

    const result = await policy?.(session, context);
    expect(typeof result).toBe('number');
    expect(session.state.qqSticker).toEqual({
      catalog,
      preset: 'sakiko',
      availableCount: 1,
    });
  });

  it('resolves sticker persona from ChatLuna conversation resolution without legacy room data', async () => {
    const catalog = {
      version: 1,
      generatedAt: '2026-03-16T00:00:00.000Z',
      model: 'doubao-seed-2-0-mini-260215',
      entries: [
        {
          id: 'bored',
          file: 'images/personas/sakiko/bored.png',
          hash: 'hash-1',
          mime: 'image/png',
          scopes: ['persona:sakiko'],
          caption: '无语少女',
          keywords: ['无语'],
          moods: ['无语'],
          scenes: ['吐槽'],
          historyLabel: '无语少女',
          confidence: 0.95,
          buffer: Buffer.from('fake'),
        },
      ],
      byId: new Map(),
    };
    stickerCoreMocks.loadStickerCatalog.mockReturnValue(catalog);
    const { ready, getPolicy, getConstraints } = createHarness();
    await ready();

    const policy = getPolicy();
    const session = createSession();
    const context = {
      options: {
        conversation: {
          conversationId: 'conv-1',
          effectivePreset: 'sakiko',
          conversation: {
            id: 'conv-1',
            preset: 'stale',
          },
        },
        inputMessage: {
          content: '来个表情',
          additional_kwargs: {},
        },
      },
    };

    await policy?.(session, context);

    expect(session.state.qqSticker).toEqual({
      catalog,
      preset: 'sakiko',
      availableCount: 1,
    });
    expect(getConstraints()).toContainEqual({
      name: 'qqbot_sticker_policy',
      kind: 'after',
      target: 'resolve_conversation',
    });
  });

  it('skips policy injection when no scoped sticker is available', async () => {
    const catalog = {
      version: 1,
      generatedAt: '2026-03-16T00:00:00.000Z',
      model: 'doubao-seed-2-0-mini-260215',
      entries: [
        {
          id: 'bored',
          file: 'images/personas/sakiko/bored.png',
          hash: 'hash-1',
          mime: 'image/png',
          scopes: ['persona:sakiko'],
          caption: '无语少女',
          keywords: ['无语'],
          moods: ['无语'],
          scenes: ['吐槽'],
          historyLabel: '无语少女',
          confidence: 0.95,
          buffer: Buffer.from('fake'),
        },
      ],
      byId: new Map(),
    };
    stickerCoreMocks.loadStickerCatalog.mockReturnValue(catalog);
    const { ready, getPolicy } = createHarness();
    await ready();

    const policy = getPolicy();
    const session = createSession();
    await policy?.(session, {
      options: {
        conversation: {
          conversationId: 'conv-2',
          effectivePreset: 'other',
          conversation: {
            id: 'conv-2',
            preset: 'other',
          },
        },
      },
    });

    expect(session.state.qqSticker).toEqual({
      catalog,
      preset: 'other',
      availableCount: 0,
    });
  });
});
