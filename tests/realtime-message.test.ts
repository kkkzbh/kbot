import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, inject } from '../src/plugins/realtime-message/index.js';
import { realtimeMessageCache, buildGroupScopeKey } from '../src/plugins/realtime-message/cache.js';
import { REALTIME_MESSAGE_HISTORY_TOOL } from '../src/plugins/realtime-message/tool.js';

const mockRealtimeHistoryAddMessages = vi.hoisted(() => vi.fn(async (_messages: unknown[]) => undefined));
const mockRealtimeHistoryInstances = vi.hoisted(
  () => [] as Array<{ ctx: unknown; conversationId: string; maxMessagesCount: number; chatluna: unknown }>,
);

vi.mock('koishi', () => {
  type MockSchemaNode = {
    default: () => MockSchemaNode;
    description: () => MockSchemaNode;
    min: () => MockSchemaNode;
    max: () => MockSchemaNode;
    role: () => MockSchemaNode;
  };

  const createSchemaNode = (): MockSchemaNode => ({
    default: () => createSchemaNode(),
    description: () => createSchemaNode(),
    min: () => createSchemaNode(),
    max: () => createSchemaNode(),
    role: () => createSchemaNode(),
  });

  class MockLogger {
    info(): void {}
    warn(): void {}
  }

  const parseAttrs = (input: string) => {
    const attrs: Record<string, string> = {};
    for (const matched of input.matchAll(/(\w+)="([^"]*)"/g)) {
      attrs[matched[1]] = matched[2];
    }
    return attrs;
  };

  const parse = (content: string) => {
    const elements: Array<{ type: string; attrs: Record<string, string>; children: never[] }> = [];
    const pattern = /<(audio|at)\b([\s\S]*?)\/>/gi;
    let lastIndex = 0;
    let matched: RegExpExecArray | null;

    while ((matched = pattern.exec(content))) {
      const text = content.slice(lastIndex, matched.index);
      if (text) {
        elements.push({ type: 'text', attrs: { content: text }, children: [] });
      }
      elements.push({ type: matched[1], attrs: parseAttrs(matched[2] ?? ''), children: [] });
      lastIndex = pattern.lastIndex;
    }

    const tail = content.slice(lastIndex);
    if (tail) {
      elements.push({ type: 'text', attrs: { content: tail }, children: [] });
    }

    return elements;
  };

  return {
    Context: class {},
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
    h: {
      parse,
      audio: (src: string) => ({
        toString: () => `<audio src="${src}"/>`,
      }),
    },
  };
});

vi.mock('../src/plugins/shared/chatluna-history.js', () => ({
  createChatLunaHistoryWriter: vi.fn(async (args: {
    database: unknown;
    logger: unknown;
    conversationId: string;
    chatluna: unknown;
    maxMessagesCount?: number;
  }) => {
    mockRealtimeHistoryInstances.push({
      ctx: { database: args.database, logger: args.logger },
      conversationId: args.conversationId,
      maxMessagesCount: args.maxMessagesCount ?? 10_000,
      chatluna: args.chatluna,
    });

    return {
      addMessages: mockRealtimeHistoryAddMessages,
    };
  }),
}));

type Middleware = (session: Record<string, any>, next: () => Promise<unknown>) => Promise<unknown>;
type ChatChainMiddleware = (session: Record<string, any>, context: Record<string, any>) => Promise<number>;
type EventListener = (...args: any[]) => unknown;
type ChainConstraint = {
  name: string;
  kind: 'after' | 'before';
  target: string;
};

function createHarness(
  options: {
    maxInjectCount?: number;
    realtimeEnabled?: boolean;
    voiceInputEnabled?: boolean;
    chatChainAvailableInitially?: boolean;
  } = {},
) {
  const middlewares: Middleware[] = [];
  const listeners = new Map<string, EventListener[]>();
  const chatChainMiddlewares = new Map<string, ChatChainMiddleware>();
  const constraints: ChainConstraint[] = [];
  const addMessages = mockRealtimeHistoryAddMessages;
  const database = {
    get: vi.fn(async (table: string, query: Record<string, unknown>) => {
      if (table === 'chatluna_conversation') {
        return [{ id: String(query.id ?? '') }];
      }
      return [];
    }),
  };
  const messageTransformer = {
    transform: vi.fn(async (_session: Record<string, any>, message: unknown[]) => {
      const image = (message as Array<{ type?: string; attrs?: Record<string, unknown> }>).find(
        (element) => element?.type === 'img' || element?.type === 'image',
      );
      const imageUrl = String(image?.attrs?.imageUrl ?? image?.attrs?.url ?? image?.attrs?.src ?? '');
      if (imageUrl) {
        return {
          content: [{ type: 'image_url', image_url: { url: imageUrl } }],
        };
      }
      return {
        content: typeof _session.stripped?.content === 'string' ? _session.stripped.content : String(_session.content ?? ''),
      };
    }),
  };
  const tools = new Map<string, any>();
  const registerTool = vi.fn((name: string, tool: unknown) => {
    tools.set(name, tool);
    return () => {
      tools.delete(name);
    };
  });
  let realtimeEnabled = options.realtimeEnabled ?? true;
  let voiceInputEnabled = options.voiceInputEnabled ?? true;
  const featurePolicy = {
    resolveFeatureEnabled: vi.fn(async (_session: Record<string, any>, featureKey: string) => {
      if (featureKey === 'QQBOT_REALTIME_MESSAGE_ENABLED') return realtimeEnabled;
      if (featureKey === 'QQ_VOICE_INPUT_ENABLED') return voiceInputEnabled;
      return true;
    }),
  };
  const chatChain = {
    middleware: vi.fn((name: string, middleware: ChatChainMiddleware) => {
      chatChainMiddlewares.set(name, middleware);
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
  const chatluna: Record<string, unknown> = {
    platform: { registerTool },
    messageTransformer,
  };
  if (options.chatChainAvailableInitially !== false) {
    chatluna.chatChain = chatChain;
  }

  const ctx: Record<string, unknown> = {
    middleware: vi.fn((handler: Middleware) => {
      middlewares.push(handler);
    }),
    on: vi.fn((name: string, handler: EventListener) => {
      const bucket = listeners.get(name) ?? [];
      bucket.push(handler);
      listeners.set(name, bucket);
    }),
    chatluna,
    featurePolicy,
    database,
  };

  apply(ctx as never, {
    maxInjectCount: options.maxInjectCount ?? 12,
  });

  const runHook = async (name: string): Promise<void> => {
    for (const listener of listeners.get(name) ?? []) {
      await listener();
    }
  };

  return {
    middleware: middlewares[0],
    addMessages,
    database,
    messageTransformer,
    chatluna,
    constraints,
    chatChainMiddlewares,
    tools,
    setChatChainAvailable() {
      chatluna.chatChain = chatChain;
    },
    setRealtimeEnabled(value: boolean) {
      realtimeEnabled = value;
    },
    setVoiceInputEnabled(value: boolean) {
      voiceInputEnabled = value;
    },
    async runReady() {
      await runHook('ready');
    },
    async runChatChainAdded() {
      await runHook('chatluna/chat-chain-added');
    },
    async runDispose() {
      await runHook('dispose');
    },
  };
}

function createSession(overrides: Record<string, unknown> = {}): Record<string, any> {
  const content = String(overrides.content ?? '');
  return {
    platform: 'onebot',
    isDirect: false,
    channelId: '100',
    guildId: '100',
    userId: 'u1',
    messageId: 'msg-1',
    content,
    stripped: { content },
    bot: { selfId: 'bot-1' },
    elements: [],
    state: {},
    ...overrides,
  };
}

function createConversation(conversationId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const model = overrides.model ?? 'openai/gpt-4.1';
  return {
    conversationId,
    effectiveModel: model,
    conversation: {
      id: conversationId,
      model,
    },
  };
}

async function callTool(harness: ReturnType<typeof createHarness>, session: Record<string, any>, input: Record<string, unknown> = {}) {
  const entry = harness.tools.get(REALTIME_MESSAGE_HISTORY_TOOL);
  expect(entry).toBeDefined();
  const tool = entry.createTool();
  const payload = {
    scope: 'current_group',
    limit: 20,
    offset: 0,
    order: 'latest_first',
    modality: 'any',
    includeImages: true,
    includeVoiceTranscripts: true,
    ...input,
  };
  const result = await (tool as any)._call(
    payload,
    undefined,
    {
      configurable: {
        session,
      },
    },
  );
  return JSON.parse(String(result));
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  mockRealtimeHistoryInstances.length = 0;
  realtimeMessageCache.clear();
});

function stubVoiceRuntimeEnv(overrides: Record<string, string> = {}): void {
  const values = {
    QQ_VOICE_INPUT_ENABLED: 'true',
    QQ_VOICE_OUTPUT_ENABLED: 'true',
    QQ_VOICE_ASR_BASE_URL: 'http://127.0.0.1:8081',
    QQ_VOICE_ASR_API_KEY: 'voice-token',
    QQ_VOICE_TTS_BASE_URL: 'http://127.0.0.1:8082',
    QQ_VOICE_TTS_API_KEY: 'tts-token',
    QQ_VOICE_OUTPUT_LANGUAGE: 'zh',
    QQ_VOICE_INPUT_MAX_SECONDS: '60',
    QQ_VOICE_OUTPUT_MAX_WORDS: '80',
    QQ_VOICE_OUTPUT_MAX_SECONDS: '45',
    QQ_VOICE_TRANSCRIBE_TIMEOUT_MS: '45000',
    QQ_VOICE_SYNTH_TIMEOUT_MS: '300000',
    QQBOT_REPLY_COLLECT_WINDOW_MS: '400',
    QQBOT_REPLY_MAX_PENDING_INPUTS: '8',
    CHAT_NATURAL_TRIGGER_ENABLED: 'true',
    CHAT_NATURAL_TRIGGER_GROUPS: 'group-100',
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    vi.stubEnv(key, value);
  }
}

describe('realtime message plugin', () => {
  it('declares runtime services as required injections', () => {
    expect(inject).toEqual({ required: ['chatluna', 'featurePolicy', 'database'] });
  });

  it('fails fast without the required feature policy service', () => {
    const ctx = {
      middleware: vi.fn(),
      on: vi.fn(),
      chatluna: {
        platform: { registerTool: vi.fn() },
      },
      database: {
        get: vi.fn(),
      },
    };

    expect(() => apply(ctx as never, { maxInjectCount: 12 })).toThrow(
      'realtime-message requires featurePolicy service.',
    );
  });

  it('captures group user messages only when the realtime feature is enabled', async () => {
    const { middleware } = createHarness();

    await middleware(
      createSession({
        userId: 'u8',
        messageId: 'msg-text-1',
        content: '普通群消息',
      }),
      async () => undefined,
    );
    await middleware(
      createSession({
        isDirect: true,
        guildId: '',
        channelId: 'private-u8',
        userId: 'u8',
        messageId: 'msg-private-1',
        content: '私聊消息',
      }),
      async () => undefined,
    );
    await middleware(
      createSession({
        userId: 'bot-1',
        messageId: 'msg-bot-1',
        content: '机器人消息',
      }),
      async () => undefined,
    );

    expect(realtimeMessageCache.get('onebot:bot-1:group:100')).toEqual([
      expect.objectContaining({
        messageId: 'msg-text-1',
        userId: 'u8',
        text: '普通群消息',
      }),
    ]);
  });

  it('does not capture the exact 好感 command as realtime chat history', async () => {
    const { middleware } = createHarness();

    await middleware(
      createSession({
        userId: 'u8',
        messageId: 'msg-panel-command',
        content: '<at id="bot"/> 好感',
        stripped: { content: ' 好感 ' },
      }),
      async () => undefined,
    );
    await middleware(
      createSession({
        userId: 'u8',
        messageId: 'msg-normal-affinity-text',
        content: '看看好感这个词会不会被普通聊天记录下来',
      }),
      async () => undefined,
    );

    expect(realtimeMessageCache.get('onebot:bot-1:group:100')).toEqual([
      expect.objectContaining({
        messageId: 'msg-normal-affinity-text',
        userId: 'u8',
        text: '看看好感这个词会不会被普通聊天记录下来',
      }),
    ]);
  });

  it('clears existing group cache as soon as the realtime feature is disabled', async () => {
    const { middleware, setRealtimeEnabled } = createHarness();

    await middleware(
      createSession({
        userId: 'u8',
        messageId: 'msg-cache-1',
        content: '先缓存起来',
      }),
      async () => undefined,
    );

    setRealtimeEnabled(false);
    await middleware(
      createSession({
        userId: 'u9',
        messageId: 'msg-cache-2',
        content: '关闭后收到的新消息',
      }),
      async () => undefined,
    );

    expect(realtimeMessageCache.get('onebot:bot-1:group:100')).toEqual([]);
  });

  it('registers promotion and tools after ChatLuna adds the chat chain', async () => {
    const harness = createHarness({ chatChainAvailableInitially: false });

    await harness.runReady();

    expect(harness.chatChainMiddlewares.get('qqbot_realtime_message_promotion')).toBeUndefined();
    expect(harness.tools.has(REALTIME_MESSAGE_HISTORY_TOOL)).toBe(false);

    harness.setChatChainAvailable();
    await harness.runChatChainAdded();

    expect(harness.chatChainMiddlewares.get('qqbot_realtime_message_promotion')).toBeTypeOf('function');
    expect(harness.tools.has(REALTIME_MESSAGE_HISTORY_TOOL)).toBe(true);
  });

  it('promotes the latest inject window, excludes the trigger message, and clears old cache after each round', async () => {
    const { middleware, runReady, chatChainMiddlewares, addMessages } = createHarness({ maxInjectCount: 2 });
    await runReady();

    for (const [userId, messageId, content] of [
      ['u1', 'msg-1', '第一条'],
      ['u2', 'msg-2', '第二条'],
      ['u3', 'msg-3', '第三条'],
    ] as const) {
      await middleware(createSession({ userId, messageId, content }), async () => undefined);
    }

    const promotion = chatChainMiddlewares.get('qqbot_realtime_message_promotion');
    expect(promotion).toBeTypeOf('function');

    const triggerSession = createSession({
      userId: 'u4',
      messageId: 'msg-trigger-1',
      content: '这轮触发',
    });

    await middleware(triggerSession, async () => {
      await promotion?.(triggerSession, {
        options: {
          conversation: createConversation('conv-1'),
        },
      });
      return undefined;
    });

    const firstRoundCall = addMessages.mock.calls.at(0) as unknown[] | undefined;
    const firstRoundMessages = (firstRoundCall?.[0] ?? []) as Array<{ content?: string; id?: string }>;
    expect(firstRoundMessages.map((message) => message.content)).toEqual([
      '[speaker_id=u2 speaker_name="u2"] 第二条',
      '[speaker_id=u3 speaker_name="u3"] 第三条',
    ]);
    expect(realtimeMessageCache.get(buildGroupScopeKey(triggerSession) ?? '')).toEqual([]);

    await middleware(createSession({ userId: 'u5', messageId: 'msg-5', content: '下一轮新消息' }), async () => undefined);

    const nextTrigger = createSession({
      userId: 'u6',
      messageId: 'msg-trigger-2',
      content: '第二轮触发',
    });
    await middleware(nextTrigger, async () => {
      await promotion?.(nextTrigger, {
        options: {
          conversation: createConversation('conv-2'),
        },
      });
      return undefined;
    });

    const secondRoundCall = addMessages.mock.calls.at(1) as unknown[] | undefined;
    const secondRoundMessages = (secondRoundCall?.[0] ?? []) as Array<{ content?: string }>;
    expect(secondRoundMessages.map((message) => message.content)).toEqual([
      '[speaker_id=u5 speaker_name="u5"] 下一轮新消息',
    ]);
  });

  it('creates the realtime history writer from the active ChatLuna conversation', async () => {
    const { middleware, runReady, chatChainMiddlewares, addMessages, chatluna, database } = createHarness();
    await runReady();

    await middleware(
      createSession({
        userId: 'u1',
        messageId: 'msg-bound-1',
        content: '前置实时消息',
      }),
      async () => undefined,
    );

    const promotion = chatChainMiddlewares.get('qqbot_realtime_message_promotion');
    const triggerSession = createSession({
      userId: 'u2',
      messageId: 'msg-bound-trigger',
      content: '触发一下',
    });

    await expect(
      promotion?.(triggerSession, {
        options: {
          conversation: createConversation('conv-bind-1'),
        },
      }),
    ).resolves.toBe(2);

    expect(database.get).toHaveBeenCalledWith('chatluna_conversation', { id: 'conv-bind-1' }, ['id']);
    expect(mockRealtimeHistoryInstances).toEqual([
      expect.objectContaining({
        conversationId: 'conv-bind-1',
        maxMessagesCount: 10_000,
        chatluna,
      }),
    ]);
    expect(addMessages).toHaveBeenCalledTimes(1);
  });

  it('promotes cached messages from ChatLuna conversation resolution without legacy room data', async () => {
    const { middleware, runReady, chatChainMiddlewares, addMessages, messageTransformer, database, constraints } = createHarness();
    await runReady();

    await middleware(
      createSession({
        userId: 'u8',
        messageId: 'msg-conversation-image',
        content: '这张图',
        stripped: { content: '这张图' },
        elements: [{ type: 'img', attrs: { src: 'https://example.com/conversation-only.png' }, children: [] }],
      }),
      async () => undefined,
    );

    const promotion = chatChainMiddlewares.get('qqbot_realtime_message_promotion');
    const triggerSession = createSession({
      userId: 'u9',
      messageId: 'msg-trigger-conversation-only',
      content: '触发一下',
    });

    await promotion?.(triggerSession, {
      options: {
        conversation: {
          conversationId: 'conv-realtime-resolution',
          effectiveModel: 'openai/gpt-4.1',
          conversation: {
            id: 'conv-realtime-resolution',
            model: 'stale-model',
          },
        },
      },
    });

    expect(database.get).toHaveBeenCalledWith('chatluna_conversation', { id: 'conv-realtime-resolution' }, ['id']);
    expect(messageTransformer.transform).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Array),
      'openai/gpt-4.1',
      undefined,
      expect.objectContaining({
        quote: false,
        includeQuoteReply: false,
      }),
    );
    expect(addMessages).toHaveBeenCalledTimes(1);
    expect(constraints).toContainEqual({
      name: 'qqbot_realtime_message_promotion',
      kind: 'after',
      target: 'resolve_conversation',
    });
  });

  it('promotes image messages through the real multimodal transform path', async () => {
    const { middleware, runReady, chatChainMiddlewares, addMessages, messageTransformer } = createHarness();
    await runReady();

    await middleware(
      createSession({
        userId: 'u8',
        messageId: 'msg-image-1',
        content: '',
        stripped: { content: '' },
        elements: [{ type: 'img', attrs: { src: 'https://example.com/cache.png' }, children: [] }],
      }),
      async () => undefined,
    );

    const promotion = chatChainMiddlewares.get('qqbot_realtime_message_promotion');
    const triggerSession = createSession({
      userId: 'u9',
      messageId: 'msg-trigger-image',
      content: '触发一下',
    });

    await middleware(triggerSession, async () => {
      await promotion?.(triggerSession, {
        options: {
          conversation: createConversation('conv-image-1'),
        },
      });
      return undefined;
    });

    expect(messageTransformer.transform).toHaveBeenCalledTimes(1);
    const promotedCall = addMessages.mock.calls.at(0) as unknown[] | undefined;
    const promotedMessages = (promotedCall?.[0] ?? []) as Array<{ content?: unknown }>;
    expect(promotedMessages[0]?.content).toEqual([
      { type: 'text', text: '[speaker_id=u8 speaker_name="u8"]' },
      { type: 'image_url', image_url: { url: 'https://example.com/cache.png' } },
    ]);
  });

  it('does not duplicate text already preserved by the multimodal transform', async () => {
    const { middleware, runReady, chatChainMiddlewares, addMessages, messageTransformer } = createHarness();
    await runReady();
    messageTransformer.transform.mockResolvedValueOnce({
      content: [
        { type: 'text', text: '帮我看下[image:https://example.com/mixed.png]这个' },
        { type: 'image_url', image_url: { url: 'https://example.com/mixed.png' } },
      ],
    });

    await middleware(
      createSession({
        userId: 'u8',
        messageId: 'msg-image-text-mixed',
        content: '帮我看下这个',
        stripped: { content: '帮我看下这个' },
        elements: [
          { type: 'text', attrs: { content: '帮我看下' }, children: [] },
          { type: 'img', attrs: { src: 'https://example.com/mixed.png' }, children: [] },
          { type: 'text', attrs: { content: '这个' }, children: [] },
        ],
      }),
      async () => undefined,
    );

    const promotion = chatChainMiddlewares.get('qqbot_realtime_message_promotion');
    const triggerSession = createSession({
      userId: 'u9',
      messageId: 'msg-trigger-image-text-mixed',
      content: '触发一下',
    });

    await middleware(triggerSession, async () => {
      await promotion?.(triggerSession, {
        options: {
          conversation: createConversation('conv-image-text-mixed'),
        },
      });
      return undefined;
    });

    const promotedCall = addMessages.mock.calls.at(0) as unknown[] | undefined;
    const promotedMessages = (promotedCall?.[0] ?? []) as Array<{ content?: unknown }>;
    expect(promotedMessages[0]?.content).toEqual([
      { type: 'text', text: '[speaker_id=u8 speaker_name="u8"] 帮我看下[image:https://example.com/mixed.png]这个' },
      { type: 'image_url', image_url: { url: 'https://example.com/mixed.png' } },
    ]);
    expect(JSON.stringify(promotedMessages[0]?.content)).not.toContain('帮我看下这个');
  });

  it('falls back to structured image urls when multimodal transform fails', async () => {
    const { middleware, runReady, chatChainMiddlewares, addMessages, messageTransformer } = createHarness();
    await runReady();
    messageTransformer.transform.mockRejectedValueOnce(new Error('transform failed'));

    await middleware(
      createSession({
        userId: 'u8',
        messageId: 'msg-image-fallback',
        content: '帮我看下',
        stripped: { content: '帮我看下' },
        elements: [{ type: 'img', attrs: { src: 'https://example.com/fallback.png' }, children: [] }],
      }),
      async () => undefined,
    );

    const promotion = chatChainMiddlewares.get('qqbot_realtime_message_promotion');
    const triggerSession = createSession({
      userId: 'u9',
      messageId: 'msg-trigger-fallback',
      content: '触发一下',
    });

    await middleware(triggerSession, async () => {
      await promotion?.(triggerSession, {
        options: {
          conversation: createConversation('conv-image-fallback'),
        },
      });
      return undefined;
    });

    const promotedCall = addMessages.mock.calls.at(0) as unknown[] | undefined;
    const promotedMessages = (promotedCall?.[0] ?? []) as Array<{ content?: unknown }>;
    expect(promotedMessages[0]?.content).toEqual([
      { type: 'text', text: '[speaker_id=u8 speaker_name="u8"] 帮我看下' },
      { type: 'image_url', image_url: { url: 'https://example.com/fallback.png' } },
    ]);
    expect(JSON.stringify(promotedMessages[0]?.content)).not.toContain('[图片]');
  });

  it('captures voice transcript when ASR is available', async () => {
    stubVoiceRuntimeEnv();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://example.com/input.amr') {
        return new Response(Uint8Array.from([1, 2, 3]), { status: 200 });
      }
      if (url === 'http://127.0.0.1:8081/transcribe' && init?.method === 'POST') {
        return Response.json({ text: '转写内容', durationMs: 1_500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    const { middleware } = createHarness();
    const session = createSession({
      userId: 'u11',
      messageId: 'msg-voice-1',
      content: '<audio src="https://example.com/input.amr"/>补充说明',
      stripped: { content: '补充说明' },
    });

    await middleware(session, async () => undefined);

    expect(realtimeMessageCache.get(buildGroupScopeKey(session) ?? '')).toEqual([
      expect.objectContaining({
        messageId: 'msg-voice-1',
        text: '补充说明',
        voiceTranscript: '转写内容',
        modalities: ['text', 'voice'],
      }),
    ]);
  });

  it('skips voice realtime cache entries when the ASR runtime is unavailable', async () => {
    stubVoiceRuntimeEnv({ QQ_VOICE_ASR_BASE_URL: '' });

    const { middleware } = createHarness();
    const session = createSession({
      userId: 'u12',
      messageId: 'msg-voice-skip',
      content: '<audio src="https://example.com/input.amr"/>',
      stripped: { content: '' },
    });

    await middleware(session, async () => undefined);

    expect(realtimeMessageCache.get(buildGroupScopeKey(session) ?? '')).toEqual([]);
  });

  it('exposes pending cache through the realtime_message_history tool with filters', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T10:00:00+08:00'));

    const harness = createHarness();
    const { middleware, runReady, chatChainMiddlewares } = harness;
    await runReady();

    await middleware(createSession({ userId: 'u1', messageId: 'msg-1', content: '今天吃什么' }), async () => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    await middleware(
      createSession({
        userId: 'u2',
        messageId: 'msg-2',
        content: '',
        stripped: { content: '' },
        elements: [{ type: 'img', attrs: { src: 'https://example.com/2.png' }, children: [] }],
      }),
      async () => undefined,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await middleware(createSession({ userId: 'u1', messageId: 'msg-3', content: '今晚吃面' }), async () => undefined);

    const filtered = await callTool(harness, createSession({ userId: 'u9', messageId: 'msg-tool-filter' }), {
      scope: 'current_group',
      order: 'latest_first',
      limit: 5,
      offset: 0,
      speakerIds: ['u1'],
      keyword: '今晚',
      modality: 'text',
      since: '2026-04-05T10:00:00+08:00',
      until: '2026-04-05T10:10:00+08:00',
    });
    expect(filtered.total).toBe(1);
    expect(filtered.items.map((item: { messageId: string }) => item.messageId)).toEqual(['msg-3']);

    const paged = await callTool(harness, createSession({ userId: 'u9', messageId: 'msg-tool-page' }), {
      scope: 'current_group',
      order: 'latest_first',
      limit: 2,
      offset: 1,
    });
    expect(paged.items.map((item: { messageId: string }) => item.messageId)).toEqual(['msg-2', 'msg-1']);

    const promotion = chatChainMiddlewares.get('qqbot_realtime_message_promotion');
    const triggerSession = createSession({
      userId: 'u10',
      messageId: 'msg-trigger-tool',
      content: '这轮触发',
    });
    await middleware(triggerSession, async () => {
      await promotion?.(triggerSession, {
        options: {
          conversation: createConversation('conv-tool-1'),
        },
      });
      return undefined;
    });

    const afterPromotion = await callTool(harness, createSession({ userId: 'u9', messageId: 'msg-tool-after' }));
    expect(afterPromotion.returned).toBe(0);
    expect(afterPromotion.items).toEqual([]);
  });

  it('keeps realtime_message_history schema compatible with Copilot Gemini tool validation', async () => {
    const harness = createHarness();
    await harness.runReady();

    const entry = harness.tools.get(REALTIME_MESSAGE_HISTORY_TOOL);
    expect(entry).toBeDefined();
    const tool = entry.createTool();
    const schema = (tool as any).schema;

    expect(schema.shape.since._def.typeName).toBe('ZodOptional');
    expect(schema.shape.since._def.innerType._def.typeName).toBe('ZodString');
    expect(schema.shape.until._def.typeName).toBe('ZodOptional');
    expect(schema.shape.until._def.innerType._def.typeName).toBe('ZodString');
  });

  it('returns explicit tool results for private chats and disabled groups', async () => {
    const harness = createHarness();
    const { middleware, runReady, setRealtimeEnabled } = harness;
    await runReady();

    const privateResult = await callTool(
      harness,
      createSession({
        isDirect: true,
        guildId: '',
        channelId: 'private-u1',
        userId: 'u1',
      }),
    );
    expect(privateResult.error).toContain('不是群聊');

    await middleware(createSession({ userId: 'u7', messageId: 'msg-disabled-1', content: '先缓存' }), async () => undefined);
    setRealtimeEnabled(false);

    const disabledResult = await callTool(harness, createSession({ userId: 'u7', messageId: 'msg-disabled-tool' }));
    expect(disabledResult.reason).toContain('未开启实时消息功能');
    expect(disabledResult.returned).toBe(0);
    expect(realtimeMessageCache.get('onebot:bot-1:group:100')).toEqual([]);
  });
});
