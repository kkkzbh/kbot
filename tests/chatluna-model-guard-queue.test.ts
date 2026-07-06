import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi-plugin-chatluna/chains', () => ({
  ChainMiddlewareRunStatus: { STOP: 1, CONTINUE: 0 },
}));

const promptAssemblyMocks = vi.hoisted(() => ({
  beginPromptAssemblyTurn: vi.fn(),
  registerPromptFragment: vi.fn(),
}));

vi.mock('koishi', () => {
  type MockSchemaNode = {
    default: () => MockSchemaNode;
    description: () => MockSchemaNode;
    role: () => MockSchemaNode;
    min: () => MockSchemaNode;
    max: () => MockSchemaNode;
  };

  const createSchemaNode = (): MockSchemaNode => ({
    default: () => createSchemaNode(),
    description: () => createSchemaNode(),
    role: () => createSchemaNode(),
    min: () => createSchemaNode(),
    max: () => createSchemaNode(),
  });

  class MockLogger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
  }

  return {
    Logger: MockLogger,
    Schema: {
      object: () => createSchemaNode(),
      boolean: () => createSchemaNode(),
      string: () => createSchemaNode(),
      natural: () => createSchemaNode(),
      number: () => createSchemaNode(),
      array: () => createSchemaNode(),
      union: () => createSchemaNode(),
      const: () => createSchemaNode(),
    },
  };
});

vi.mock('../src/plugins/shared/prompt-context/index.js', () => ({
  beginPromptAssemblyTurn: promptAssemblyMocks.beginPromptAssemblyTurn,
  registerPromptFragment: promptAssemblyMocks.registerPromptFragment,
}));

import { apply } from '../src/plugins/model-guard/index.js';
import { resolveMainChatRuntimeProfileFromEnv } from '../src/plugins/shared/llm/index.js';
import { mainChatRuntimeState } from '../src/plugins/shared/llm/main-chat-runtime.js';

afterEach(() => {
  mainChatRuntimeState.initialize(resolveMainChatRuntimeProfileFromEnv({}));
  promptAssemblyMocks.beginPromptAssemblyTurn.mockReset();
  promptAssemblyMocks.registerPromptFragment.mockReset();
});

type ChainMiddleware = (session: Record<string, any>, context: Record<string, any>) => Promise<number>;

function createChainBuilder(store: Map<string, ChainMiddleware>) {
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

const constraints: Array<{ name: string; kind: 'after' | 'before'; target: string }> = [];

function createHarness(options: { chatChainAvailableInitially?: boolean } = {}) {
  constraints.length = 0;
  const middlewares: Array<(session: Record<string, any>, next: () => Promise<unknown>) => Promise<unknown>> = [];
  const events = new Map<string, Array<(...args: any[]) => unknown>>();
  const chainMiddlewares = new Map<string, ChainMiddleware>();
  const chatChain = createChainBuilder(chainMiddlewares);
  const chatluna = {
    platform: {
      findModel: vi.fn(() => ({ value: true })),
      listAllModels: vi.fn(() => ({
        value: [{ toModelName: () => 'Pro/moonshotai/Kimi-K2.5' }],
      })),
    },
    conversation: {
      createConversation: vi.fn(async (_session: unknown, options: Record<string, unknown>) => ({
        id: 'conv-created',
        bindingKey: options.bindingKey,
        model: options.model,
        preset: options.preset,
        chatMode: options.chatMode,
      })),
    },
    awaitLoadPlatform: vi.fn(async () => undefined),
    chatChain: options.chatChainAvailableInitially === false ? undefined : chatChain,
  };

  const ctx = {
    chatluna,
    database: {
      set: vi.fn(async () => undefined),
    },
    get: vi.fn((name: string) => (name === 'chatluna' ? chatluna : undefined)),
    middleware: vi.fn((handler: any) => {
      middlewares.push(handler);
    }),
    on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
      const existing = events.get(name) ?? [];
      existing.push(handler);
      events.set(name, existing);
    }),
  };

  apply(ctx as never, {});

  return {
    ctx,
    middlewares,
    events,
    chainMiddlewares,
    chatluna,
    database: ctx.database,
    ready: (events.get('ready') ?? [])[0],
    chatChainAdded: (events.get('chatluna/chat-chain-added') ?? [])[0],
    setChatChainAvailable: () => {
      chatluna.chatChain = chatChain;
    },
  };
}

describe('chatluna model guard runtime shape', () => {
  it('does not register legacy before-send transport interception', () => {
    const harness = createHarness();
    expect(harness.events.get('before-send') ?? []).toHaveLength(0);
    expect(harness.middlewares).toHaveLength(0);
  });

  it('registers only turn-context and model-guard chain middlewares on ready', () => {
    const harness = createHarness();
    harness.ready?.();

    expect(harness.chainMiddlewares.has('qqbot_turn_context')).toBe(true);
    expect(harness.chainMiddlewares.has('chatluna_model_guard')).toBe(true);
    expect(harness.chainMiddlewares.has('qqbot_live_replan_gate')).toBe(false);
    expect(constraints).toContainEqual({
      name: 'chatluna_model_guard',
      kind: 'after',
      target: 'resolve_conversation',
    });
    expect(constraints).not.toContainEqual({
      name: 'chatluna_model_guard',
      kind: 'after',
      target: 'resolve_room',
    });
  });

  it('registers model guard middlewares after ChatLuna adds the chat chain', () => {
    const harness = createHarness({ chatChainAvailableInitially: false });
    harness.ready?.();

    expect(harness.chainMiddlewares.has('qqbot_turn_context')).toBe(false);
    expect(harness.chainMiddlewares.has('chatluna_model_guard')).toBe(false);

    harness.setChatChainAvailable();
    harness.chatChainAdded?.();

    expect(harness.chainMiddlewares.has('qqbot_turn_context')).toBe(true);
    expect(harness.chainMiddlewares.has('chatluna_model_guard')).toBe(true);
  });

  it('starts prompt assembly with the resolved message id as the turn id', async () => {
    const harness = createHarness();
    harness.ready?.();

    const turnContext = harness.chainMiddlewares.get('qqbot_turn_context');
    await turnContext?.(
      {
        stripped: { content: '今天呢' },
        userId: 'u1',
        bot: { selfId: 'bot' },
      },
      {
        options: {
          messageId: 'qqreply:run-1',
          conversation: {
            conversationId: 'conv-1',
            conversation: {
              id: 'conv-1',
              model: 'Pro/moonshotai/Kimi-K2.5',
              preset: 'sakiko',
              chatMode: 'plugin',
            },
          },
          inputMessage: {
            content: '今天呢',
          },
        },
      },
    );

    expect(promptAssemblyMocks.beginPromptAssemblyTurn).toHaveBeenCalledWith(
      'conv-1',
      { turnId: 'qqreply:run-1' },
    );
  });

  it('updates the live ChatLuna 1.4 conversation model before resolve_model reads it', async () => {
    mainChatRuntimeState.initialize(resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'copilot',
      CHATLUNA_COPILOT_BASE_URL: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      CHATLUNA_COPILOT_API_KEY: 'bridge-secret',
      CHATLUNA_COPILOT_DEFAULT_MODEL: 'openai/gpt-4o',
    }));
    const harness = createHarness();
    harness.ready?.();

    const guard = harness.chainMiddlewares.get('chatluna_model_guard');
    const conversation = {
      id: 'conv-1',
      model: '',
      preset: 'sakiko',
      chatMode: 'plugin',
    };
    const context = {
      options: {
        conversation: {
          conversationId: 'conv-1',
          conversation,
        },
      },
      send: vi.fn(),
    };

    await expect(guard?.({ stripped: { content: 'hi' } }, context)).resolves.not.toBe(1);
    expect(conversation.model).toBe('openai/gpt-4o');
    expect(harness.database.set).toHaveBeenCalledWith(
      'chatluna_conversation',
      { id: 'conv-1' },
      { model: 'openai/gpt-4o' },
    );
  });

  it('stops instead of continuing with a partially synced room model when persistence fails', async () => {
    mainChatRuntimeState.initialize(resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'copilot',
      CHATLUNA_COPILOT_BASE_URL: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      CHATLUNA_COPILOT_API_KEY: 'bridge-secret',
      CHATLUNA_COPILOT_DEFAULT_MODEL: 'openai/gpt-4o',
    }));
    const harness = createHarness();
    harness.database.set.mockRejectedValueOnce(new Error('database write failed'));
    harness.ready?.();

    const guard = harness.chainMiddlewares.get('chatluna_model_guard');
    const conversation = {
      id: 'conv-1',
      model: 'openai/gpt-4.1',
      preset: 'sakiko',
      chatMode: 'plugin',
    };
    const context = {
      options: {
        conversation: {
          conversationId: 'conv-1',
          conversation,
        },
      },
      send: vi.fn(),
    };

    await expect(guard?.({ stripped: { content: 'hi' } }, context)).resolves.toBe(1);
    expect(conversation.model).toBe('openai/gpt-4.1');
    expect(context.send).toHaveBeenCalledWith('主聊天模型同步失败，请稍后重试。');
  });

  it('creates an active QQ reply conversation before resolve_model when resolve_conversation only returned context', async () => {
    mainChatRuntimeState.initialize(resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'copilot',
      CHATLUNA_COPILOT_BASE_URL: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      CHATLUNA_COPILOT_API_KEY: 'bridge-secret',
      CHATLUNA_COPILOT_DEFAULT_MODEL: 'openai/gpt-4o',
    }));
    const harness = createHarness();
    harness.ready?.();

    const guard = harness.chainMiddlewares.get('chatluna_model_guard');
    const session = {
      platform: 'onebot',
      channelId: '829573670',
      userId: '9177543201',
      bot: { selfId: '2219854433' },
      stripped: { content: 'saki 找个话题聊聊吧' },
    };
    const context: {
      options: {
        conversation: {
          mode: string;
          conversationId: string | null;
          bindingKey: string;
          presetLane: string | null;
          effectivePreset: string;
          effectiveChatMode: string;
          conversation: null | { model?: unknown };
        };
      };
      send: ReturnType<typeof vi.fn>;
    } = {
      options: {
        conversation: {
          mode: 'context',
          conversationId: null,
          bindingKey: 'shared:onebot:guild:829573670',
          presetLane: null,
          effectivePreset: 'saki',
          effectiveChatMode: 'plugin',
          conversation: null,
        },
      },
      send: vi.fn(),
    };

    await expect(guard?.(session, context as Record<string, any>)).resolves.not.toBe(1);
    expect(harness.chatluna.conversation.createConversation.mock.contexts[0]).toBe(harness.chatluna.conversation);
    expect(harness.chatluna.conversation.createConversation).toHaveBeenCalledWith(session, {
      bindingKey: 'shared:onebot:guild:829573670',
      title: 'New Conversation',
      model: 'openai/gpt-4o',
      preset: 'saki',
      chatMode: 'plugin',
    });
    expect(context.options.conversation.conversation?.model).toBe('openai/gpt-4o');
    expect(harness.database.set).not.toHaveBeenCalled();
  });
});
