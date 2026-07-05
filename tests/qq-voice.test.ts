import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi-plugin-chatluna/chains', () => ({
  ChainMiddlewareRunStatus: { STOP: 1, CONTINUE: 0 },
}));

const promptAssemblyMocks = vi.hoisted(() => ({
  beginPromptAssemblyTurn: vi.fn(),
  registerPromptFragment: vi.fn(),
  peekPromptFragments: vi.fn(() => []),
  clearPromptAssemblyTurn: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

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

  class MockLogger {
    info(...args: any[]): void {
      loggerMocks.info(...args);
    }
    warn(...args: any[]): void {
      loggerMocks.warn(...args);
    }
    error(...args: any[]): void {
      loggerMocks.error(...args);
    }
    debug(...args: any[]): void {
      loggerMocks.debug(...args);
    }
  }

  const hFactory = ((type: string, attrs: Record<string, unknown> = {}, children: unknown[] = []) => ({
    type,
    attrs,
    children,
  })) as unknown as {
    (type: string, attrs?: Record<string, unknown>, children?: unknown[]): Record<string, unknown>;
    parse: typeof parse;
    text: (content: string) => Record<string, unknown>;
    at: (id: string) => Record<string, unknown>;
    audio: (src: string) => Record<string, unknown>;
    image: (source: string | Buffer, mime?: string) => Record<string, unknown>;
  };
  hFactory.parse = parse;
  hFactory.text = (content: string) => ({
    type: 'text',
    attrs: { content },
    children: [],
    toString: () => content,
  });
  hFactory.audio = (src: string) => ({
    type: 'audio',
    attrs: { src },
    children: [],
    toString: () => `<audio src="${src}"/>`,
  });
  hFactory.image = (source: string | Buffer, mime?: string) => ({
    type: 'img',
    attrs: {
      src:
        typeof source === 'string'
          ? source
          : `data:${mime};base64,${source.toString('base64')}`,
    },
    children: [],
    toString: () =>
      typeof source === 'string'
        ? `<img src="${source}" />`
        : `<img src="data:${mime};base64,${source.toString('base64')}" />`,
  });
  hFactory.at = (id: string) => ({
    type: 'at',
    attrs: { id },
    children: [],
    toString: () => `@${id}`,
  });

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
    h: hFactory,
  };
});

vi.mock('../src/plugins/shared/prompt-context/index.js', async () => {
  const actual = await vi.importActual<typeof import('../src/plugins/shared/prompt-context/index.js')>(
    '../src/plugins/shared/prompt-context/index.js',
  );
  return {
    ...actual,
    beginPromptAssemblyTurn: promptAssemblyMocks.beginPromptAssemblyTurn,
    registerPromptFragment: promptAssemblyMocks.registerPromptFragment,
    peekPromptFragments: promptAssemblyMocks.peekPromptFragments,
    clearPromptAssemblyTurn: promptAssemblyMocks.clearPromptAssemblyTurn,
  };
});

import { sendVoiceByBridge } from '../src/plugins/bot-console/voice-bridge.js';
import { apply, deliverStandaloneReplyPlan, ensureCanSendRecord, inject } from '../src/plugins/reply/index.js';
import { ReplyRuntime } from '../src/plugins/reply/runtime/index.js';
import { resolveMainChatRuntimeProfileFromEnv } from '../src/plugins/shared/llm/index.js';
import { mainChatRuntimeState } from '../src/plugins/shared/llm/main-chat-runtime.js';

type Middleware = (session: Record<string, any>, next: () => Promise<unknown>) => Promise<unknown>;
type EventHandler = (...args: any[]) => Promise<unknown> | unknown;
type ChainMiddleware = (session: Record<string, any>, context: Record<string, any>) => Promise<number>;

function extractVisibleMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => extractVisibleMessageText(part)).join('');
  if (!content || typeof content !== 'object') return String(content ?? '');

  const node = content as {
    type?: string;
    attrs?: { content?: unknown };
    children?: unknown[];
    toString?: () => string;
  };

  if (typeof node.attrs?.content === 'string') {
    return node.attrs.content;
  }

  if (node.type === 'at' && typeof (node as { attrs?: { id?: unknown } }).attrs?.id === 'string') {
    return `@${(node as { attrs?: { id?: string } }).attrs?.id}`;
  }

  if (Array.isArray(node.children) && node.children.length > 0) {
    return node.children.map((child) => extractVisibleMessageText(child)).join('');
  }

  return typeof node.toString === 'function' ? node.toString() : '';
}

function extractSentMessagePayloads(bot: { sendMessage: { mock: { calls: any[][] } } }): string[] {
  return bot.sendMessage.mock.calls.map((call: any[]) => extractVisibleMessageText(call[1]));
}

type ChainConstraint = { name: string; kind: 'after' | 'before'; target: string };

function createChainBuilder(store: Map<string, ChainMiddleware>, constraints: ChainConstraint[]) {
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

function createStoredResearchCompatibilityTail(conversationId: string) {
  return [
    {
      id: 'msg-human-1',
      role: 'human',
      parentId: null,
      conversationId,
      text: '上一轮用户输入',
      content: null,
      name: null,
      tool_calls: null,
      tool_call_id: null,
      additional_kwargs_binary: null,
      rawId: null,
    },
    {
      id: 'msg-ai-1',
      role: 'ai',
      parentId: 'msg-human-1',
      conversationId,
      text: '',
      content: null,
      name: null,
      tool_calls: [{ id: 'tool-submit', name: 'submit_reply_plan', args: { segments: [] } }],
      tool_call_id: null,
      additional_kwargs_binary: null,
      rawId: null,
    },
    {
      id: 'msg-tool-1',
      role: 'tool',
      parentId: 'msg-ai-1',
      conversationId,
      text: '{"segments":[{"kind":"text","content":"旧回复"}]}',
      content: null,
      name: 'submit_reply_plan',
      tool_calls: null,
      tool_call_id: 'tool-submit',
      additional_kwargs_binary: null,
      rawId: null,
    },
  ];
}

function createHarness(overrides: {
  canSendRecord?: boolean;
  canSendRecordImpl?: () => Promise<boolean>;
  includeInternalRequest?: boolean;
  pluginConfig?: Record<string, unknown>;
  replyInterruptEnabled?: boolean;
  createChatModelImpl?: (model: string) => Promise<{ invoke: (input: unknown, options?: Record<string, unknown>) => Promise<{ content?: unknown }> }>;
  databaseGetImpl?: (table: string, query: Record<string, unknown>) => Promise<any[]>;
  databaseSetImpl?: (table: string, query: Record<string, unknown>, data: Record<string, unknown>) => Promise<unknown>;
  databaseUpsertImpl?: (table: string, rows: Record<string, unknown>[]) => Promise<unknown>;
  databaseRemoveImpl?: (table: string, query: Record<string, unknown>) => Promise<unknown>;
  featureResolverImpl?: (session: Record<string, any>, featureKey: string) => Promise<boolean> | boolean;
  normalizeResearchReplyHistory?: boolean;
  normalizeResearchReplyHistoryImpl?: (room: Record<string, unknown>, finalVisibleText: string) => Promise<unknown>;
  chatChainInitially?: boolean;
  contextManager?: boolean;
} = {}) {
  const middlewares: Middleware[] = [];
  const events = new Map<string, EventHandler[]>();
  const chainMiddlewares = new Map<string, ChainMiddleware>();
  const chainConstraints: ChainConstraint[] = [];
  const inject = vi.fn();
  const defaultConversations: Record<string, unknown>[] = [{ id: 'conv-1', latestMessageId: 'msg-tool-1' }];
  const defaultMessages: Record<string, unknown>[] = createStoredResearchCompatibilityTail('conv-1');
  const defaultRows = (table: string, query: Record<string, unknown>) => {
    if (table === 'chatluna_conversation') {
      return defaultConversations.filter((row) =>
        Object.entries(query).every(([key, value]) => row[key] === value),
      );
    }
    if (table === 'chatluna_message') {
      return defaultMessages.filter((row) =>
        Object.entries(query).every(([key, value]) => row[key] === value),
      );
    }
    return [];
  };

  const database = {
    get: vi.fn(async (table: string, query: Record<string, unknown>) => {
      if (overrides.databaseGetImpl) {
        return overrides.databaseGetImpl(table, query);
      }
      return defaultRows(table, query);
    }),
    upsert: vi.fn(async (table: string, rows: Record<string, unknown>[]) => {
      if (overrides.databaseUpsertImpl) {
        return overrides.databaseUpsertImpl(table, rows);
      }
      return undefined;
    }),
    set: vi.fn(async (table: string, query: Record<string, unknown>, data: Record<string, unknown>) => {
      if (overrides.databaseSetImpl) {
        return overrides.databaseSetImpl(table, query, data);
      }
      for (const row of defaultRows(table, query)) {
        Object.assign(row, data);
      }
      return undefined;
    }),
    remove: vi.fn(async (table: string, query: Record<string, unknown>) => {
      if (overrides.databaseRemoveImpl) {
        return overrides.databaseRemoveImpl(table, query);
      }
      const rows = table === 'chatluna_conversation'
        ? defaultConversations
        : table === 'chatluna_message'
          ? defaultMessages
          : [];
      for (let index = rows.length - 1; index >= 0; index--) {
        if (Object.entries(query).every(([key, value]) => rows[index][key] === value)) {
          rows.splice(index, 1);
        }
      }
      return undefined;
    }),
  };

  const internal: Record<string, any> = {
    canSendRecord: vi.fn(async () => {
      if (overrides.canSendRecordImpl) return overrides.canSendRecordImpl();
      return overrides.canSendRecord ?? true;
    }),
    getRecord: vi.fn(async (file: string) => ({ file })),
    getGroupMemberList: vi.fn(async (): Promise<Array<{ user_id: string | number; card?: string; nickname?: string }>> => []),
    sendPrivateMsg: vi.fn(async () => 'msg-id'),
    sendGroupMsg: vi.fn(async () => 'msg-id'),
  };

  const bot = {
    platform: 'onebot',
    selfId: 'bot-1',
    internal,
    sendMessage: vi.fn(async () => ['msg-id']),
  };

  if (overrides.includeInternalRequest !== false) {
    bot.internal._request = vi.fn(async () => ({ retcode: 0, data: { yes: true } }));
  }

  const chatChain = {
    ...createChainBuilder(chainMiddlewares, chainConstraints),
    receiveMessage: vi.fn(async () => false),
  };
  const chatluna: Record<string, any> = {
    createChatModel: vi.fn(async (model: string) => ({
      value: await (overrides.createChatModelImpl?.(model) ??
        Promise.resolve({
          invoke: async () => ({
            content: JSON.stringify({
              decision: 'reply',
              outbound_messages: [{ type: 'message', content: '默认回复' }],
            }),
          }),
        })),
    })),
  };
  if (overrides.normalizeResearchReplyHistory !== false) {
    chatluna.normalizeResearchReplyHistory = vi.fn(async (room: Record<string, unknown>, finalVisibleText: string) => {
      if (overrides.normalizeResearchReplyHistoryImpl) {
        return overrides.normalizeResearchReplyHistoryImpl(room, finalVisibleText);
      }
      return {
        deletedMessageIds: ['msg-tool-1', 'msg-ai-1'],
        latestId: 'msg-ai-normalized',
        normalizedMessageId: 'msg-ai-normalized',
        normalizedText: finalVisibleText,
      };
    });
  }
  if (overrides.contextManager !== false) {
    chatluna.contextManager = { inject };
  }
  if (overrides.chatChainInitially !== false) {
    chatluna.chatChain = chatChain;
  }

  const ctx = {
    bots: [bot],
    chatluna,
    featurePolicy: {
      resolveFeatureEnabled: vi.fn(async (session: Record<string, any>, featureKey: string) => {
        if (overrides.featureResolverImpl) {
          return overrides.featureResolverImpl(session, featureKey);
        }
        if (featureKey === 'QQBOT_REPLY_INTERRUPT_ENABLED') {
          return overrides.replyInterruptEnabled ?? false;
        }
        return true;
      }),
    },
    database,
    get: vi.fn((name: string) => {
      if (name !== 'chatluna') return undefined;
      return chatluna;
    }),
    middleware: vi.fn((handler: Middleware) => {
      middlewares.push(handler);
    }),
    on: vi.fn((name: string, handler: EventHandler) => {
      const existing = events.get(name) ?? [];
      existing.push(handler);
      events.set(name, existing);
    }),
  };

  apply(ctx as never, {
    inputEnabled: true,
    outputEnabled: true,
    asrBaseUrl: 'http://127.0.0.1:8081',
    asrApiKey: 'qqbot-voice-asr-token',
    ttsBaseUrl: 'http://127.0.0.1:8082',
    ttsApiKey: 'qqbot-voice-tts-token',
    inputMaxSeconds: 60,
    outputMaxWords: 80,
    outputMaxSeconds: 45,
    voiceOutputLanguage: 'zh',
    transcribeTimeoutMs: 30_000,
    synthTimeoutMs: 300_000,
    replyInterruptCollectWindowMs: 400,
    replyInterruptMaxPendingInputs: 8,
    naturalTriggerEnabled: true,
    naturalTriggerGroups: 'group-100',
    ...overrides.pluginConfig,
  });

  return {
    inbound: middlewares[0],
    capabilityMiddleware: middlewares[1],
    ready: (events.get('ready') ?? [])[0],
    getPrepare: () => chainMiddlewares.get('qqbot_reply_runtime_prepare'),
    getPolicy: () => chainMiddlewares.get('qqbot_reply_transport_policy'),
    getPromptCompiler: () => chainMiddlewares.get('qqbot_reply_prompt_compiler'),
    getExecutor: () => chainMiddlewares.get('qqbot_reply_plan_executor'),
    getChainConstraints: () => chainConstraints,
    chatChain,
    chatChainAdded: (events.get('chatluna/chat-chain-added') ?? [])[0],
    setChatChainAvailable: () => {
      chatluna.chatChain = chatChain;
    },
    chatluna,
    inject,
    bot,
    database,
  };
}

function createSession(bot: Record<string, any>, overrides: Record<string, unknown> = {}): Record<string, any> {
  const content = overrides.content ?? '';
  return {
    platform: 'onebot',
    channelId: 'group-100',
    guildId: 'group-100',
    userId: 'u1',
    content,
    stripped: { content: String(overrides.strippedContent ?? content) },
    state: {},
    bot,
    send: vi.fn(async () => ['msg-id']),
    ...overrides,
  };
}

function createPluginRoom(conversationId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationId,
    model: 'Pro/moonshotai/Kimi-K2.5',
    preset: 'sakiko',
    chatMode: 'plugin',
    ...overrides,
  };
}

function createPluginConversation(conversationId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return createPluginConversationFromRoom(createPluginRoom(conversationId, overrides));
}

function createPluginConversationFromRoom(room: Record<string, unknown>): Record<string, unknown> {
  const conversationId = String(room.conversationId ?? '').trim();
  if (!conversationId) {
    throw new Error('test conversation requires conversationId');
  }
  return {
    conversationId,
    effectiveModel: room.model,
    effectivePreset: room.preset,
    effectiveChatMode: room.chatMode,
    conversation: {
      id: conversationId,
      model: room.model,
      preset: room.preset,
      chatMode: room.chatMode,
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createReplyV2Response(input: string | Record<string, unknown>) {
  const reply =
    typeof input === 'string'
      ? {
          decision: 'reply',
          outbound_messages: [{ type: 'message', content: input }],
        }
      : input;
  return {
    content: JSON.stringify(reply),
    additional_kwargs: {},
  };
}

function createChatReplyV1Response(content: string, nonce: string) {
  return {
    content: [
      `CHAT_REPLY_V1 ${nonce}`,
      'DECISION reply',
      'BEGIN message',
      'CONTENT',
      ...content.split('\n').map((line) => `|${line}`),
      'END',
      `DONE ${nonce}`,
    ].join('\n'),
    additional_kwargs: {},
  };
}

function createRawChatReplyV1Response(lines: string[]) {
  return {
    content: lines.join('\n'),
    additional_kwargs: {},
  };
}

function expectedVisibleAssistantHistory(input: string): string {
  return input;
}

function extractSchemaMessageTitles(schema: Record<string, any> | undefined): string[] {
  const rawMessageSchemas = schema?.properties?.outbound_messages?.anyOf?.find((item: any) => item.items?.anyOf)?.items?.anyOf ?? [];
  return rawMessageSchemas.flatMap((item: any) => (Array.isArray(item.anyOf) ? item.anyOf : [item])).map((item: any) => item.title).filter(Boolean);
}

function createRawReplyResponse(
  content: unknown,
  providerDiagnostic: Record<string, unknown> | null = null,
) {
  return {
    content,
    additional_kwargs:
      providerDiagnostic == null
        ? {}
        : {
            __chatluna_provider_response_diagnostic_v1: providerDiagnostic,
          },
  };
}

type TestReplyProtocol = 'native_chat_json_schema' | 'native_responses_json_schema' | 'chat_reply_v1';

function createExecutorInputMessage(
  content: unknown = '普通聊聊',
  protocol: TestReplyProtocol = 'native_chat_json_schema',
) {
  return {
    content,
    additional_kwargs: {
      qqbot_final_response_contract: { protocol },
    },
  };
}

function withExecutorInputContract<T extends { additional_kwargs?: Record<string, unknown> }>(
  inputMessage: T,
  protocol: TestReplyProtocol = 'native_chat_json_schema',
): T & { additional_kwargs: Record<string, unknown> } {
  return {
    ...inputMessage,
    additional_kwargs: {
      ...(inputMessage.additional_kwargs ?? {}),
      qqbot_final_response_contract: { protocol },
    },
  };
}

function hasStructuredFailureLog(args: {
  conversationId: string;
  messageId: string;
  failureKind: string;
  requestMode?: string;
  providerOutputTokens?: string;
}): boolean {
  return loggerMocks.error.mock.calls.some((call) => {
    const [
      message,
      runId,
      conversationId,
      messageId,
      queueKey,
      actorKey,
      failureKind,
      requestMode,
      providerOutputTokens,
    ] = call;

    return (
      String(message).includes('reply plan executor suppressed structured model failure') &&
      typeof runId === 'string' &&
      conversationId === args.conversationId &&
      messageId === args.messageId &&
      String(queueKey).includes('group:group-100') &&
      String(actorKey).includes('group:group-100:user:u1') &&
      failureKind === args.failureKind &&
      (args.requestMode == null || requestMode === args.requestMode) &&
      (args.providerOutputTokens == null || providerOutputTokens === args.providerOutputTokens)
    );
  });
}

function createStickerState(availableCount = 1) {
  const entry = {
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
    buffer: Buffer.from('fake-sticker'),
  };

  return {
    catalog: {
      version: 1,
      generatedAt: '2026-03-23T00:00:00.000Z',
      model: 'test-model',
      entries: [entry],
      byId: new Map([[entry.id, entry]]),
    },
    preset: 'sakiko',
    availableCount,
  };
}

describe('qq voice plugin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    promptAssemblyMocks.registerPromptFragment.mockReset();
    promptAssemblyMocks.beginPromptAssemblyTurn.mockReset();
    promptAssemblyMocks.peekPromptFragments.mockReset();
    promptAssemblyMocks.peekPromptFragments.mockReturnValue([]);
    promptAssemblyMocks.clearPromptAssemblyTurn.mockReset();
    loggerMocks.info.mockReset();
    loggerMocks.warn.mockReset();
    loggerMocks.error.mockReset();
    loggerMocks.debug.mockReset();
    vi.stubEnv('ONEBOT_SELF_ID', 'bot-1');
    vi.stubEnv('QQ_VOICE_INPUT_ENABLED', 'true');
    vi.stubEnv('QQ_VOICE_OUTPUT_ENABLED', 'true');
    vi.stubEnv('QQ_VOICE_ASR_BASE_URL', 'http://127.0.0.1:8081');
    vi.stubEnv('QQ_VOICE_ASR_API_KEY', 'qqbot-voice-asr-token');
    vi.stubEnv('QQ_VOICE_TTS_BASE_URL', 'http://127.0.0.1:8082');
    vi.stubEnv('QQ_VOICE_TTS_API_KEY', 'qqbot-voice-tts-token');
    vi.stubEnv('QQ_VOICE_OUTPUT_LANGUAGE', 'zh');
    vi.stubEnv('QQ_VOICE_INPUT_MAX_SECONDS', '60');
    vi.stubEnv('QQ_VOICE_OUTPUT_MAX_WORDS', '80');
    vi.stubEnv('QQ_VOICE_OUTPUT_MAX_SECONDS', '45');
    vi.stubEnv('QQ_VOICE_TRANSCRIBE_TIMEOUT_MS', '30000');
    vi.stubEnv('QQ_VOICE_SYNTH_TIMEOUT_MS', '300000');
    vi.stubEnv('QQBOT_REPLY_COLLECT_WINDOW_MS', '400');
    vi.stubEnv('QQBOT_REPLY_MAX_PENDING_INPUTS', '8');
    vi.stubEnv('QQBOT_REPLY_INTERRUPT_ENABLED', 'false');
    vi.stubEnv('CHAT_NATURAL_TRIGGER_ENABLED', 'true');
    vi.stubEnv('CHAT_NATURAL_TRIGGER_GROUPS', 'group-100');
    mainChatRuntimeState.initialize(resolveMainChatRuntimeProfileFromEnv({}));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    mainChatRuntimeState.initialize(resolveMainChatRuntimeProfileFromEnv({}));
  });

  it('declares required services so reply plan middleware can register on the live chat chain', () => {
    if (Array.isArray(inject)) {
      expect(inject).toEqual(expect.arrayContaining(['chatluna', 'database', 'featurePolicy']));
      return;
    }

    expect(inject).toEqual(
      expect.objectContaining({
        required: expect.arrayContaining(['chatluna', 'database', 'featurePolicy']),
      }),
    );
  });

  it('fails fast without the required feature policy service', () => {
    expect(() =>
      apply({
        bots: [],
        chatluna: {},
        database: {},
        get: vi.fn(),
        middleware: vi.fn(),
        on: vi.fn(),
      } as never, {
        inputEnabled: true,
        outputEnabled: true,
        asrBaseUrl: 'http://127.0.0.1:8081',
        asrApiKey: 'qqbot-voice-asr-token',
        ttsBaseUrl: 'http://127.0.0.1:8082',
        ttsApiKey: 'qqbot-voice-tts-token',
        inputMaxSeconds: 60,
        outputMaxWords: 80,
        outputMaxSeconds: 45,
        voiceOutputLanguage: 'zh',
        transcribeTimeoutMs: 30_000,
        synthTimeoutMs: 300_000,
        replyInterruptCollectWindowMs: 400,
        replyInterruptMaxPendingInputs: 8,
        naturalTriggerEnabled: true,
        naturalTriggerGroups: 'group-100',
      }),
    ).toThrow('qq-voice requires featurePolicy service.');
  });

  it('fails fast when server voice output points at loopback', () => {
    vi.stubEnv('QQBOT_ENV_BASE_FILE', '/opt/qqbot/current/.env.server');

    expect(() =>
      createHarness({
        pluginConfig: {
          inputEnabled: false,
        },
      }),
    ).toThrow(
      'server QQ voice output must point to a laptop Tailnet TTS endpoint, not a loopback address.',
    );
  });

  it('fails fast when voice output is enabled without a TTS endpoint', () => {
    expect(() =>
      createHarness({
        pluginConfig: {
          ttsBaseUrl: '',
          ttsApiKey: 'qqbot-voice-tts-token',
        },
      }),
    ).toThrow('QQ voice output is enabled but QQ_VOICE_TTS_BASE_URL is empty.');
  });

  it('allows server voice output when it uses a non-loopback tailnet endpoint', () => {
    vi.stubEnv('QQBOT_ENV_BASE_FILE', '/opt/qqbot/current/.env.server');

    expect(() =>
      createHarness({
        pluginConfig: {
          inputEnabled: false,
          ttsBaseUrl: 'http://100.119.134.69:5162',
          ttsApiKey: 'qqbot-voice-tts-token',
        },
      }),
    ).not.toThrow();
  });

  it('treats missing onebot rpc transport as record-unavailable without optimistic fallback', async () => {
    const { bot } = createHarness({ includeInternalRequest: false });
    const capabilityCache = new Map<string, boolean>([['onebot:bot-1', true]]);

    await expect(ensureCanSendRecord(bot as never, capabilityCache, true)).resolves.toBe(false);
    expect(capabilityCache.has('onebot:bot-1')).toBe(false);
    expect(bot.internal.canSendRecord).not.toHaveBeenCalled();
    expect(
      loggerMocks.warn.mock.calls.some(([message]) => String(message).includes('fallback to optimistic record support')),
    ).toBe(false);
  });

  it('treats _request probe errors as transport-not-ready without optimistic fallback', async () => {
    const { bot } = createHarness({
      canSendRecordImpl: async () => {
        throw new Error('_request is not a function');
      },
    });
    const capabilityCache = new Map<string, boolean>([['onebot:bot-1', true]]);

    await expect(ensureCanSendRecord(bot as never, capabilityCache, true)).resolves.toBe(false);
    expect(capabilityCache.has('onebot:bot-1')).toBe(false);
    expect(bot.internal.canSendRecord).toHaveBeenCalledTimes(1);
    expect(
      loggerMocks.warn.mock.calls.some(([message]) => String(message).includes('fallback to optimistic record support')),
    ).toBe(false);
  });

  it('rejects standalone reply delivery outside onebot instead of falling back to ChatLuna send', async () => {
    const { bot } = createHarness();
    const session = createSession(bot, { platform: 'discord' });

    await expect(
      deliverStandaloneReplyPlan({
        runtime: {} as never,
        session: session as never,
        plan: {
          segments: [
            {
              kind: 'message',
              parts: [{ kind: 'text', content: '不应该交给 ChatLuna fallback 发送' }],
            },
          ],
        },
      }),
    ).rejects.toThrow('reply plan delivery requires a onebot session with channelId.');
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('does not preheat canSendRecord during ready', async () => {
    const { ready, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    expect(bot.internal.canSendRecord).not.toHaveBeenCalled();
  });

  it('returns bot_unavailable from the voice bridge when onebot rpc transport is not ready', async () => {
    vi.stubEnv('ONEBOT_SELF_ID', 'bot-1');
    vi.stubEnv('QQ_VOICE_OUTPUT_ENABLED', 'true');
    vi.stubEnv('QQ_VOICE_TTS_BASE_URL', 'http://tts.local');
    vi.stubEnv('QQ_VOICE_TTS_API_KEY', 'qqbot-voice-tts-token');
    const { bot } = createHarness({ includeInternalRequest: false });

    await expect(
      sendVoiceByBridge({ bots: [bot] } as never, {
        chatType: 'private',
        targetId: 'u1',
        text: '你好',
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: 'bot_unavailable',
    });
  });

  it('requires ONEBOT_SELF_ID for voice bridge bot resolution instead of selecting the first onebot bot', async () => {
    vi.stubEnv('ONEBOT_SELF_ID', '');
    vi.stubEnv('QQ_VOICE_OUTPUT_ENABLED', 'true');
    vi.stubEnv('QQ_VOICE_TTS_BASE_URL', 'http://tts.local');
    vi.stubEnv('QQ_VOICE_TTS_API_KEY', 'qqbot-voice-tts-token');
    const { bot } = createHarness();

    await expect(
      sendVoiceByBridge({ bots: [bot] } as never, {
        chatType: 'private',
        targetId: 'u1',
        text: '你好',
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: 'bot_unavailable',
      message: 'ONEBOT_SELF_ID is required for voice bridge bot resolution',
    });
    expect(bot.internal.canSendRecord).not.toHaveBeenCalled();
  });

  it('returns record_unavailable from the voice bridge when can_send_record is false', async () => {
    vi.stubEnv('ONEBOT_SELF_ID', 'bot-1');
    vi.stubEnv('QQ_VOICE_OUTPUT_ENABLED', 'true');
    vi.stubEnv('QQ_VOICE_TTS_BASE_URL', 'http://tts.local');
    vi.stubEnv('QQ_VOICE_TTS_API_KEY', 'qqbot-voice-tts-token');
    const { bot } = createHarness({ canSendRecord: false });

    await expect(
      sendVoiceByBridge({ bots: [bot] } as never, {
        chatType: 'group',
        targetId: '100',
        text: '你好',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'record_unavailable',
    });
  });

  it('serializes turns instead of interrupting when reply interrupt is disabled', async () => {
    const { ready, getPrepare, getExecutor, bot } = createHarness({ replyInterruptEnabled: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const executor = getExecutor();
    const session1 = createSession(bot, {
      content: '第一条',
      strippedContent: '第一条',
    });
    const session2 = createSession(bot, {
      content: '第二条',
      strippedContent: '第二条',
    });
    const prepareContext1 = { options: { conversation: createPluginConversation('conv-serial') } };
    const prepareContext2 = { options: { conversation: createPluginConversation('conv-serial') } };

    await prepare?.(session1, prepareContext1);

    let secondPrepared = false;
    const prepareSecondPromise = prepare?.(session2, prepareContext2).then(() => {
      secondPrepared = true;
    });

    await flushMicrotasks();
    expect(secondPrepared).toBe(false);

    await executor?.(session1, {
      options: {
        conversation: createPluginConversation('conv-serial'),
        inputMessage: createExecutorInputMessage('第一条'),
        responseMessage: createReplyV2Response('第一条回复'),
      },
    });

    await prepareSecondPromise;
    expect(secondPrepared).toBe(true);
    expect(extractSentMessagePayloads(bot)).toEqual(['第一条回复']);
  });

  it('requeues self-interruptions to the group tail while keeping one shared group queue', async () => {
    vi.useFakeTimers();
    const { ready, getPrepare, getExecutor, bot } = createHarness({ replyInterruptEnabled: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const executor = getExecutor();
    const room = createPluginRoom('conv-group-tail');
    const sessionA1 = createSession(bot, {
      userId: 'u1',
      content: 'A1',
      strippedContent: 'A1',
      author: { nick: '甲', name: '甲' },
    });
    const sessionB = createSession(bot, {
      userId: 'u2',
      content: 'B1',
      strippedContent: 'B1',
      author: { nick: '乙', name: '乙' },
    });
    const sessionA2 = createSession(bot, {
      userId: 'u1',
      content: 'A2',
      strippedContent: 'A2',
      author: { nick: '甲', name: '甲' },
    });
    const contextA1 = {
      options: {
        conversation: createPluginConversationFromRoom(room),
        inputMessage: { content: 'A1', additional_kwargs: {} },
      },
    };
    const contextB = {
      options: {
        conversation: createPluginConversationFromRoom(room),
        inputMessage: { content: 'B1', additional_kwargs: {} },
      },
    };
    const contextA2 = {
      options: {
        conversation: createPluginConversationFromRoom(room),
        inputMessage: { content: 'A2', additional_kwargs: {} },
      },
    };

    await prepare?.(sessionA1, contextA1);

    let bResolved = false;
    const prepareBPromise = prepare?.(sessionB, contextB).then((result) => {
      bResolved = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(450);
    await flushMicrotasks();
    expect(bResolved).toBe(false);

    let a2Resolved = false;
    const prepareA2Promise = prepare?.(sessionA2, contextA2).then((result) => {
      a2Resolved = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(450);
    await flushMicrotasks();

    expect(bResolved).toBe(true);
    expect(a2Resolved).toBe(false);
    expect(contextB.options.inputMessage.content).toBe('B1');

    await executor?.(sessionB, {
      options: {
        conversation: createPluginConversationFromRoom(room),
        inputMessage: withExecutorInputContract(contextB.options.inputMessage),
        responseMessage: createReplyV2Response('回复B'),
      },
    });

    await prepareA2Promise;
    expect(a2Resolved).toBe(true);
    expect(contextA2.options.inputMessage.content).toBe('A1\nA2');
  });

  it('releases a blocked interrupt queue when request_conversation fails and keeps the failure in koishi logs only', async () => {
    const { ready, getPrepare, bot } = createHarness({ replyInterruptEnabled: true });

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const room = createPluginRoom('conv-request-error');
    const sessionA = createSession(bot, {
      userId: 'u1',
      content: 'A1',
      strippedContent: 'A1',
      author: { nick: '甲', name: '甲' },
    });
    const sessionB = createSession(bot, {
      userId: 'u2',
      content: 'B1',
      strippedContent: 'B1',
      author: { nick: '乙', name: '乙' },
    });
    const contextA = {
      options: {
        conversation: createPluginConversationFromRoom(room),
        inputMessage: { content: 'A1', additional_kwargs: {} },
      },
    };
    const contextB = {
      options: {
        conversation: createPluginConversationFromRoom(room),
        inputMessage: { content: 'B1', additional_kwargs: {} },
      },
    };

    await prepare?.(sessionA, contextA);
    expect(sessionA.state.qqReplyTransport.suppressErrorNotice).toBe(true);
    expect(typeof sessionA.state.qqReplyTransport.handleRequestModelError).toBe('function');

    let secondPrepared = false;
    const prepareBPromise = prepare?.(sessionB, contextB).then((result) => {
      secondPrepared = true;
      return result;
    });

    await flushMicrotasks();
    expect(secondPrepared).toBe(false);

    await sessionA.state.qqReplyTransport.handleRequestModelError(new Error('400 invalid_request_body'));

    await expect(prepareBPromise).resolves.toBeTypeOf('number');
    expect(secondPrepared).toBe(true);
    expect(contextB.options.inputMessage.content).toBe('B1');
    expect(typeof sessionB.state.qqReplyTransport.runId).toBe('string');
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.stringContaining('reply request_conversation failed before executor cleanup: runId=%s conversationId=%s error=%s'),
      expect.any(String),
      'conv-request-error',
      '400 invalid_request_body',
    );
  });

  it('preserves image_url content when prepare rewrites aggregated input text', async () => {
    vi.useFakeTimers();
    const { ready, getPrepare, getExecutor, bot } = createHarness({ replyInterruptEnabled: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const executor = getExecutor();
    const room = createPluginRoom('conv-image-preserve');
    const sessionA1 = createSession(bot, {
      userId: 'u1',
      content: '先看一下',
      strippedContent: '先看一下',
      author: { nick: '甲', name: '甲' },
    });
    const sessionA2 = createSession(bot, {
      userId: 'u1',
      content: '这张图里是什么？',
      strippedContent: '这张图里是什么？',
      author: { nick: '甲', name: '甲' },
    });
    const contextA1 = {
      options: {
        conversation: createPluginConversationFromRoom(room),
        inputMessage: { content: '先看一下', additional_kwargs: {} },
      },
    };
    const contextA2 = {
      options: {
        conversation: createPluginConversationFromRoom(room),
        inputMessage: {
          content: [
            { type: 'text', text: '这张图里是什么？' },
            { type: 'image_url', image_url: { url: 'https://example.com/1.png' } },
          ],
          additional_kwargs: {},
        },
      },
    };

    await prepare?.(sessionA1, contextA1);

    let prepareResolved = false;
    const pendingPrepare = prepare?.(sessionA2, contextA2).then((result) => {
      prepareResolved = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(450);
    await flushMicrotasks();
    expect(prepareResolved).toBe(true);

    await pendingPrepare;
    expect(contextA2.options.inputMessage.content).toEqual([
      { type: 'text', text: '先看一下\n这张图里是什么？' },
      { type: 'image_url', image_url: { url: 'https://example.com/1.png' } },
    ]);
  });

  it('transcribes first incoming audio and merges it into session content', async () => {
    const { inbound, bot } = createHarness();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://example.com/input.amr') {
        return new Response(Uint8Array.from([1, 2, 3]), { status: 200 });
      }
      if (url === 'http://127.0.0.1:8081/transcribe' && init?.method === 'POST') {
        return Response.json({ text: '转写内容', language: 'zh', durationMs: 1_500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = createSession(bot, {
      content: '<audio src="https://example.com/input.amr"/>补充说明',
      strippedContent: '补充说明',
    });

    const result = await inbound(session, async () => session.content);
    expect(result).toBe('补充说明\n转写内容');
    expect(session.content).toBe('补充说明\n转写内容');
    expect(session.state.qqVoice).toEqual({
      transcript: '转写内容',
      durationMs: 1_500,
      source: 'src',
    });
  });

  it('skips ordinary group voice input outside the natural trigger whitelist before ASR', async () => {
    const { inbound, bot } = createHarness({
      pluginConfig: {
        naturalTriggerGroups: 'group-100',
      },
    });
    const fetchMock = vi.fn(async () => {
      throw new Error('ASR should not run');
    });
    vi.stubGlobal('fetch', fetchMock);
    const session = createSession(bot, {
      channelId: 'group-999',
      guildId: 'group-999',
      content: '<audio src="https://example.com/input.amr"/>',
      strippedContent: '',
    });
    const next = vi.fn(async () => 'next-chain');

    await expect(inbound(session, next)).resolves.toBe('next-chain');

    expect(next).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(session.content).toBe('<audio src="https://example.com/input.amr"/>');
    expect(session.state.qqVoice).toBeUndefined();
  });

  it('skips whitelisted group voice input when natural trigger is disabled for that group', async () => {
    const { inbound, bot } = createHarness({
      featureResolverImpl: async (_session, featureKey) => {
        if (featureKey === 'CHAT_NATURAL_TRIGGER_ENABLED') return false;
        return true;
      },
      pluginConfig: {
        naturalTriggerGroups: 'group-100',
      },
    });
    const fetchMock = vi.fn(async () => {
      throw new Error('ASR should not run');
    });
    vi.stubGlobal('fetch', fetchMock);
    const session = createSession(bot, {
      content: '<audio src="https://example.com/input.amr"/>',
      strippedContent: '',
    });

    await expect(inbound(session, async () => 'next-chain')).resolves.toBe('next-chain');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(session.state.qqVoice).toBeUndefined();
  });

  it('handles explicitly addressed group voice input outside the natural trigger whitelist', async () => {
    const { inbound, bot } = createHarness({
      pluginConfig: {
        naturalTriggerGroups: 'group-100',
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://example.com/input.amr') {
        return new Response(Uint8Array.from([1, 2, 3]), { status: 200 });
      }
      if (url === 'http://127.0.0.1:8081/transcribe' && init?.method === 'POST') {
        return Response.json({ text: '转写内容', language: 'zh', durationMs: 1_500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const session = createSession(bot, {
      channelId: 'group-999',
      guildId: 'group-999',
      content: '<at id="bot-1" name="小祥"/><audio src="https://example.com/input.amr"/>',
      strippedContent: '',
      elements: [
        { type: 'at', attrs: { id: 'bot-1', name: '小祥' }, children: [] },
        { type: 'audio', attrs: { src: 'https://example.com/input.amr' }, children: [] },
      ],
    });

    await expect(inbound(session, async () => session.content)).resolves.toBe('@小祥\n转写内容');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(session.state.qqVoice).toEqual({
      transcript: '转写内容',
      durationMs: 1_500,
      source: 'src',
    });
  });

  it('registers policy, prompt compiler, and executor middlewares on ready', async () => {
    const { ready, getPrepare, getPolicy, getPromptCompiler, getExecutor, getChainConstraints } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    expect(getPrepare()).toBeTypeOf('function');
    expect(getPolicy()).toBeTypeOf('function');
    expect(getPromptCompiler()).toBeTypeOf('function');
    expect(getExecutor()).toBeTypeOf('function');
    expect(getChainConstraints().some((item) => item.name === 'qqbot_reply_tool_memory_state')).toBe(false);
    expect(getChainConstraints()).toContainEqual({
      name: 'qqbot_reply_runtime_prepare',
      kind: 'after',
      target: 'resolve_conversation',
    });
    expect(getChainConstraints()).toContainEqual({
      name: 'qqbot_reply_runtime_prepare',
      kind: 'after',
      target: 'chatluna_model_guard',
    });
    expect(getChainConstraints()).not.toContainEqual({
      name: 'qqbot_reply_runtime_prepare',
      kind: 'after',
      target: 'resolve_room',
    });
  });

  it('registers reply runtime middlewares after ChatLuna adds the chat chain', async () => {
    const {
      ready,
      chatChainAdded,
      setChatChainAvailable,
      getPrepare,
      getPolicy,
      getPromptCompiler,
      getExecutor,
      chatChain,
    } = createHarness({ chatChainInitially: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    expect(getPrepare()).toBeUndefined();
    expect(getPolicy()).toBeUndefined();
    expect(getPromptCompiler()).toBeUndefined();
    expect(getExecutor()).toBeUndefined();

    setChatChainAvailable();
    await chatChainAdded?.();

    expect(getPrepare()).toBeTypeOf('function');
    expect(getPolicy()).toBeTypeOf('function');
    expect(getPromptCompiler()).toBeTypeOf('function');
    expect(getExecutor()).toBeTypeOf('function');
    expect(chatChain.middleware).toHaveBeenCalledTimes(4);

    await chatChainAdded?.();
    expect(chatChain.middleware).toHaveBeenCalledTimes(4);
  });

  it('fails fast when ChatLuna exposes a chain without contextManager', async () => {
    const { ready } = createHarness({ contextManager: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await expect(ready()).rejects.toThrow('reply runtime requires chatluna.contextManager.');
  });

  it('fails fast when ChatLuna exposes a chain without reply history normalization', async () => {
    const { ready } = createHarness({ normalizeResearchReplyHistory: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await expect(ready()).rejects.toThrow('reply runtime requires chatluna.normalizeResearchReplyHistory.');
  });

  it('delays the initial tts health probe until after startup grace period', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { ready } = createHarness();

    await ready();
    expect(fetchMock.mock.calls.some((call: any[]) => String(call[0]).includes('/healthz'))).toBe(false);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetchMock.mock.calls.some((call: any[]) => String(call[0]).includes('/healthz'))).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock.mock.calls.some((call: any[]) => String(call[0]).includes('http://127.0.0.1:8082/healthz'))).toBe(true);
  });

  it('compiles QQ reply turns into explicit agent prompt envelopes and requests structured output', async () => {
    const { ready, getPrepare, getPolicy, getPromptCompiler, bot, inject } = createHarness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:8082/healthz') {
          throw new Error('connect timeout');
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const policy = getPolicy();
    const promptCompiler = getPromptCompiler();
    const session = createSession(bot, {
      content: '请发一条语音给我听',
      strippedContent: '请发一条语音给我听',
    });
    const context = {
      options: {
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
          content: '请发一条语音给我听',
          additional_kwargs: {},
        },
      },
    };

    await prepare?.(session, context);
    const preparedOptions = context.options as typeof context.options & { messageId?: string };
    expect(promptAssemblyMocks.beginPromptAssemblyTurn).toHaveBeenCalledWith(
      'conv-1',
      { turnId: preparedOptions.messageId },
    );
    await policy?.(session, context);
    await promptCompiler?.(session, context);
    expect((context.options.conversation.conversation as any).chatMode).toBe('plugin');
    expect(promptAssemblyMocks.registerPromptFragment).not.toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ source: 'qqbot_reply_transport_capability' }),
    );
    expect(promptAssemblyMocks.registerPromptFragment).not.toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ source: 'qqbot_reply_transport_execution_rules' }),
    );
    expect(promptAssemblyMocks.registerPromptFragment).not.toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ source: 'qqbot_reply_delivery_safety' }),
    );
    expect(promptAssemblyMocks.clearPromptAssemblyTurn).toHaveBeenCalledWith('conv-1');
    expect(inject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'qqbot_reply_prompt_envelope',
        conversationId: 'conv-1',
        stage: 'after_scratchpad',
        value: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('Context Interpretation Protocol'),
            additional_kwargs: expect.objectContaining({
              qqbot_context: expect.objectContaining({
                source: 'qqbot_context_interpretation_protocol',
              }),
            }),
          }),
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('Structured Reply Contract'),
            additional_kwargs: expect.objectContaining({
              qqbot_context: expect.objectContaining({
                source: 'qqbot_structured_reply_contract',
              }),
            }),
          }),
        ]),
      }),
    );
    expect(context.options.inputMessage.additional_kwargs).toEqual(
      expect.objectContaining({
        qqbot_reply_mode: 'agent',
        qqbot_final_response_contract: expect.objectContaining({
          protocol: 'native_chat_json_schema',
          schema: expect.objectContaining({
            title: 'StructuredReply',
            properties: expect.objectContaining({
              decision: expect.objectContaining({
                description: expect.any(String),
              }),
            }),
          }),
          instruction: null,
        }),
      }),
    );
    const groupAdditionalKwargs = context.options.inputMessage.additional_kwargs as Record<string, any>;
    expect(groupAdditionalKwargs.qqbot_final_response_schema).toEqual(
      expect.objectContaining({
        title: 'StructuredReply',
      }),
    );
    const groupContract = groupAdditionalKwargs.qqbot_final_response_contract;
    const groupSchema = groupContract?.schema;
    expect(extractSchemaMessageTitles(groupSchema)).toContain('MessageItem');
  });

  it('keeps CHAT_REPLY_V1 rules in the agent system envelope and final response contract', async () => {
    vi.stubEnv('QQ_VOICE_OUTPUT_LANGUAGE', 'ja');
    const profile = resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'deepseek',
      CHATLUNA_DEEPSEEK_DEFAULT_MODEL: 'deepseek-v4-pro',
    });
    mainChatRuntimeState.initialize(profile);
    const { ready, getPrepare, getPolicy, getPromptCompiler, bot, inject } = createHarness({
      pluginConfig: { voiceOutputLanguage: 'ja' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const policy = getPolicy();
    const promptCompiler = getPromptCompiler();
    const session = createSession(bot, {
      content: '我的性格是怎样的？',
      strippedContent: '我的性格是怎样的？',
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-chat-reply-v1', { model: 'deepseek/deepseek-v4-pro' }),
        inputMessage: {
          content: '我的性格是怎样的？',
          additional_kwargs: {},
        },
      },
    };

    await prepare?.(session, context);
    await policy?.(session, context);
    await promptCompiler?.(session, context);

    const injectedEnvelope = inject.mock.calls.find((call) => {
      const payload = call[0] as Record<string, any> | undefined;
      return payload?.name === 'qqbot_reply_prompt_envelope';
    })?.[0];
    const envelopeText = (injectedEnvelope?.value ?? [])
      .map((message: { content?: unknown }) => String(message?.content ?? ''))
      .join('\n\n');

    expect(inject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'qqbot_reply_prompt_envelope',
        conversationId: 'conv-chat-reply-v1',
        value: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('CHAT_REPLY_V1 <nonce>'),
          }),
        ]),
      }),
    );
    expect(envelopeText).toContain('当前语音输出目标语言：日语');
    expect(context.options.inputMessage.additional_kwargs).toEqual(
      expect.objectContaining({
        qqbot_reply_mode: 'agent',
        qqbot_final_response_contract: expect.objectContaining({
          protocol: 'chat_reply_v1',
          schema: null,
          instruction: expect.stringContaining('CHAT_REPLY_V1 <nonce>'),
        }),
      }),
    );
    const chatReplyAdditionalKwargs = context.options.inputMessage.additional_kwargs as Record<string, any>;
    expect(chatReplyAdditionalKwargs.qqbot_final_response_instruction).toContain('CHAT_REPLY_V1 <nonce>');
    const finalContract = chatReplyAdditionalKwargs.qqbot_final_response_contract;
    expect(finalContract.instruction).toContain('当前语音输出目标语言：日语');
  });

  it('removes mention modality from the injected schema for private chats', async () => {
    const { ready, getPrepare, getPolicy, getPromptCompiler, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const policy = getPolicy();
    const promptCompiler = getPromptCompiler();
    const session = createSession(bot, {
      isDirect: true,
      channelId: 'private:u1',
      guildId: undefined,
      content: '请@我一下',
      strippedContent: '请@我一下',
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-private'),
        inputMessage: {
          content: '请@我一下',
          additional_kwargs: {},
        },
      },
    };

    await prepare?.(session, context);
    await policy?.(session, context);
    await promptCompiler?.(session, context);

    expect(promptAssemblyMocks.registerPromptFragment).not.toHaveBeenCalledWith(
      'conv-private',
      expect.objectContaining({ source: 'qqbot_reply_delivery_safety' }),
    );
    const contract = (context.options.inputMessage.additional_kwargs as Record<string, any>).qqbot_final_response_contract as Record<string, any> | undefined;
    const schema = contract?.schema as Record<string, any> | undefined;
    const messageSchema = (schema?.properties?.outbound_messages?.anyOf?.find((item: any) => item.items?.anyOf)?.items?.anyOf ?? [])
      .flatMap((item: any) => (Array.isArray(item.anyOf) ? item.anyOf : [item]))
      .find((item: any) => item.title === 'MessageItem');
    expect(messageSchema?.properties?.mentions).toBeUndefined();
  });

  it('injects explicit group speaker identity rules and current speaker identity into the reply prompt envelope', async () => {
    const { ready, getPrepare, getPolicy, getPromptCompiler, bot, inject } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const policy = getPolicy();
    const promptCompiler = getPromptCompiler();
    const session = createSession(bot, {
      content: '交个朋友怎么样？',
      strippedContent: '交个朋友怎么样？',
      userId: 'u2',
      author: {
        nick: '小祥',
        name: '小祥QQ昵称',
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-group'),
        inputMessage: {
          content: '交个朋友怎么样？',
          additional_kwargs: {},
        },
      },
    };

    await prepare?.(session, context);
    await policy?.(session, context);
    await promptCompiler?.(session, context);

    const injectedEnvelope = inject.mock.calls.find((call) => {
      const payload = call[0] as Record<string, any> | undefined;
      return payload?.name === 'qqbot_reply_prompt_envelope';
    })?.[0];
    expect(injectedEnvelope).toBeDefined();

    const envelopeText = (injectedEnvelope?.value ?? []).map((message: { content?: unknown }) => String(message?.content ?? '')).join('\n');
    expect(envelopeText).toContain('speaker_id=<id>');
    expect(envelopeText).toContain('不同 speaker_id 的消息当成同一个人');
    expect(envelopeText).toContain('最新一条真实用户消息对应本轮直接回应对象');
    expect(envelopeText).toContain('直接在 `message.content` 里写 `@群名片 `');
    expect(envelopeText).toContain('"type": "voice"');
    expect(envelopeText).not.toContain('"displayName": "小祥"');
    expect(envelopeText).not.toContain('"userId": "u2"');
    expect(context.options.inputMessage.additional_kwargs).toEqual(
      expect.objectContaining({
        qqbot_speaker_format: {
          version: 'speaker_id_v1',
          speakerId: 'u2',
          speakerName: '小祥',
          isDirect: false,
        },
      }),
    );
  });

  it('rejects non-plugin rooms during prepare before the model runs', async () => {
    const { ready, getPrepare, getPolicy, getPromptCompiler, bot, inject } = createHarness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:8082/healthz') {
          throw new Error('connect timeout');
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const policy = getPolicy();
    const promptCompiler = getPromptCompiler();
    const session = createSession(bot, {
      content: '查一下苹果说的液态玻璃是什么',
      strippedContent: '查一下苹果说的液态玻璃是什么',
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-chat', {
          model: 'Pro/moonshotai/Kimi-K2.5',
          preset: 'sakiko',
          chatMode: 'chat',
        }),
        inputMessage: {
          content: '查一下苹果说的液态玻璃是什么',
          additional_kwargs: {},
        },
      },
    };

    await expect(prepare?.(session, context)).rejects.toThrow('room.chatMode=plugin');
    expect(policy).toBeDefined();
    expect(promptCompiler).toBeDefined();
    expect(inject).not.toHaveBeenCalled();
  });

  it('stops the prepare stage early when the turn input is empty', async () => {
    const { ready, getPrepare, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const session = createSession(bot, {
      content: '   ',
      strippedContent: '   ',
    });
    const result = await prepare?.(session, {
      options: {
        conversation: createPluginConversation('conv-empty'),
      },
    });

    expect(result).toBe(1);
  });

  it('amortizes tts probing across turns and refreshes again on the 12th turn', async () => {
    vi.useFakeTimers();
    const { ready, capabilityMiddleware, bot } = createHarness();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:8082/healthz') {
        return new Response('ok', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await ready();
    await vi.advanceTimersByTimeAsync(15_000);
    await flushMicrotasks();

    const session = createSession(bot, {
      content: '普通聊天',
      strippedContent: '普通聊天',
    });

    for (let index = 0; index < 11; index += 1) {
      await capabilityMiddleware?.(session, async () => undefined);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await capabilityMiddleware?.(session, async () => undefined);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('executes a text structured reply through the executor and normalizes the tail to visible history', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '普通聊聊',
      strippedContent: '普通聊聊',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-text'),
        inputMessage: createExecutorInputMessage('普通聊聊'),
        responseMessage: createReplyV2Response('今晚先这样吧'),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(extractSentMessagePayloads(bot)).toEqual(['今晚先这样吧']);
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-text' }),
      expectedVisibleAssistantHistory('今晚先这样吧'),
    );
  });

  it('rejects executor contexts without the prompt compiler output contract', async () => {
    const { ready, getExecutor, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '普通聊聊',
      strippedContent: '普通聊聊',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-missing-contract'),
        inputMessage: { content: '普通聊聊', additional_kwargs: {} },
        responseMessage: createReplyV2Response('今晚先这样吧'),
      },
    };

    await expect(executor?.(session, context)).rejects.toThrow(
      'reply executor requires inputMessage with qqbot_final_response_contract.protocol.',
    );
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('stores CHAT_REPLY_V1 assistant history as visible text after executor delivery', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '普通聊聊',
      strippedContent: '普通聊聊',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-chat-reply-v1'),
        inputMessage: {
          content: '普通聊聊',
          additional_kwargs: {
            qqbot_final_response_contract: {
              protocol: 'chat_reply_v1',
            },
          },
        },
        responseMessage: {
          content: [
            'CHAT_REPLY_V1 abc12345',
            'DECISION reply',
            'BEGIN message',
            'CONTENT',
            '|今晚先这样吧',
            'END',
            'DONE abc12345',
          ].join('\n'),
          additional_kwargs: {},
        },
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(extractSentMessagePayloads(bot)).toEqual(['今晚先这样吧']);
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-chat-reply-v1' }),
      '今晚先这样吧',
    );
  });

  it('stores CHAT_REPLY_V1 assistant history as visible text across five consecutive executor turns', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    vi.useFakeTimers();

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const turnResponses = [
      {
        visible: '第 1 轮回复',
        response: createChatReplyV1Response('第 1 轮回复', 'abc12341'),
      },
      {
        visible: '第 2 轮回复',
        response: createChatReplyV1Response('第 2 轮回复', 'abc12342'),
      },
      {
        visible: [
          '篮球……国一？',
          '',
          '这问题问得没头没脑的。我对篮球没什么兴趣，也不清楚你指的是哪个所谓"国一"。',
          '',
          '如果你是想讨论体育话题，建议你找别人。不过如果是和音乐或演出相关的事，我倒可以听听。',
        ].join('\n'),
        response: createRawChatReplyV1Response([
          'CHAT_REPLY_V1 history',
          'DECISION reply',
          'BEGIN message',
          'CONTENT',
          '|篮球……国一？',
          '',
          '这问题问得没头没脑的。我对篮球没什么兴趣，也不清楚你指的是哪个所谓"国一"。',
          '',
          '如果你是想讨论体育话题，建议你找别人。不过如果是和音乐或演出相关的事，我倒可以听听。',
          'END',
          'DONE history',
        ]),
      },
      {
        visible: '第 4 轮回复',
        response: createChatReplyV1Response('第 4 轮回复', 'abc12344'),
      },
      {
        visible: '第 5 轮回复',
        response: createChatReplyV1Response('第 5 轮回复', 'abc12345'),
      },
    ];

    for (let turn = 1; turn <= 5; turn += 1) {
      const current = turnResponses[turn - 1]!;
      const session = createSession(bot, {
        content: `第 ${turn} 轮用户消息`,
        strippedContent: `第 ${turn} 轮用户消息`,
        messageId: `msg-${turn}`,
        state: {
          qqReplyTransport: {
            capabilitySnapshot: {
              canMultiline: true,
              canVoice: false,
              source: 'cached',
              refreshedAt: Date.now(),
            },
          },
        },
      });
      const context = {
        options: {
          conversation: createPluginConversation('conv-five-executor-chat-reply-v1-turns'),
          inputMessage: {
            content: `第 ${turn} 轮用户消息`,
            additional_kwargs: {
              qqbot_final_response_contract: {
                protocol: 'chat_reply_v1',
              },
            },
          },
          responseMessage: current.response,
        },
      };

      const pending = executor?.(session, context);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(typeof result).toBe('number');
      expect(context.options.responseMessage).toBeNull();
    }

    expect(extractSentMessagePayloads(bot)).toEqual([
      '第 1 轮回复',
      '第 2 轮回复',
      '篮球……国一？',
      '这问题问得没头没脑的。我对篮球没什么兴趣，也不清楚你指的是哪个所谓"国一"。',
      '如果你是想讨论体育话题，建议你找别人。不过如果是和音乐或演出相关的事，我倒可以听听。',
      '第 4 轮回复',
      '第 5 轮回复',
    ]);
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledTimes(5);
    for (let turn = 1; turn <= 5; turn += 1) {
      expect(chatluna.normalizeResearchReplyHistory).toHaveBeenNthCalledWith(
        turn,
        expect.objectContaining({ conversationId: 'conv-five-executor-chat-reply-v1-turns' }),
        turnResponses[turn - 1]!.visible,
      );
    }
    expect(loggerMocks.error.mock.calls.some(([message]) => String(message).includes('reply plan executor suppressed structured model failure'))).toBe(false);
  });

  it('stops chatluna fallback when onebot rpc transport is unavailable during executor send', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    bot.sendMessage.mockRejectedValueOnce(new TypeError('this._request is not a function'));
    const session = createSession(bot, {
      content: '普通聊聊',
      strippedContent: '普通聊聊',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-transport-down'),
        inputMessage: createExecutorInputMessage('普通聊聊'),
        responseMessage: createReplyV2Response('今晚先这样吧'),
      },
    };

    const result = await executor?.(session, context);
    expect(result).toBe(1);
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeResearchReplyHistory).not.toHaveBeenCalled();
    expect(
      loggerMocks.warn.mock.calls.some(([message]) =>
        String(message).includes('reply plan delivery skipped because onebot rpc transport is unavailable'),
      ),
    ).toBe(true);
  });

  it('stops chatluna fallback when the first onebot send fails before delivery', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    bot.sendMessage.mockRejectedValueOnce(new Error('ordinary onebot send failure'));
    const session = createSession(bot, {
      content: '普通聊聊',
      strippedContent: '普通聊聊',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-send-failed-before-delivery'),
        inputMessage: createExecutorInputMessage('普通聊聊'),
        responseMessage: createReplyV2Response('今晚先这样吧'),
      },
    };

    const result = await executor?.(session, context);
    expect(result).toBe(1);
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-send-failed-before-delivery' }),
      '',
    );
    expect(
      loggerMocks.warn.mock.calls.some(([message]) =>
        String(message).includes('reply plan delivery failed'),
      ),
    ).toBe(true);
  });

  it('executes an inline mention structured reply through the executor as one atomic mention message', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    bot.internal.getGroupMemberList.mockResolvedValueOnce([
      { user_id: 123456, card: '小祥', nickname: '小祥' },
    ]);
    const session = createSession(bot, {
      content: '普通聊聊',
      strippedContent: '普通聊聊',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-mention'),
        inputMessage: createExecutorInputMessage('普通聊聊'),
        responseMessage: createReplyV2Response({
            decision: 'reply',
            outbound_messages: [
              {
                type: 'message',
                content: '@小祥 先问下这件事。',
              },
            ],
          }),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    const calls = bot.sendMessage.mock.calls as any[][];
    expect(calls[0]?.[1]).toEqual([
      expect.objectContaining({ type: 'at', attrs: expect.objectContaining({ id: '123456' }) }),
      expect.objectContaining({ type: 'text', attrs: expect.objectContaining({ content: ' 先问下这件事。' }) }),
    ]);
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-mention' }),
      expectedVisibleAssistantHistory('先问下这件事。'),
    );
  });

  it('keeps unresolved inline mention text instead of fabricating an at segment', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '普通聊聊',
      strippedContent: '普通聊聊',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-handwritten-mention'),
        inputMessage: createExecutorInputMessage('普通聊聊'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          outbound_messages: [
            {
              type: 'message',
              content: '@小祥 先问下这件事。',
            },
          ],
        }),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    const calls = bot.sendMessage.mock.calls as any[][];
    expect(extractVisibleMessageText(calls[0]?.[1])).toBe('@小祥 先问下这件事。');
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-handwritten-mention' }),
      expectedVisibleAssistantHistory('@小祥 先问下这件事。'),
    );
  });

  it('strips platform mention control tags without creating at segments', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '普通聊聊',
      strippedContent: '普通聊聊',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-mention-only'),
        inputMessage: createExecutorInputMessage('普通聊聊'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          outbound_messages: [
            {
              type: 'message',
              content: '[CQ:at,qq=123456] <at id="123456"/>先问下这件事。',
            },
          ],
        }),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    const calls = bot.sendMessage.mock.calls as any[][];
    expect(extractVisibleMessageText(calls[0]?.[1])).toBe('先问下这件事。');
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-mention-only' }),
      expectedVisibleAssistantHistory('先问下这件事。'),
    );
  });

  it('treats empty text structured replies as no_reply and dispatches nothing', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '先别说了',
      strippedContent: '先别说了',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-empty-reply'),
        inputMessage: createExecutorInputMessage('先别说了'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          outbound_messages: [{ type: 'message', content: '' }],
        }),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeResearchReplyHistory).not.toHaveBeenCalled();
  });

  it('quotes only the first dispatched text segment when the runtime exposes a first-reply quote target', async () => {
    const { ready, getPrepare, getExecutor, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const quoteSpy = vi.spyOn(ReplyRuntime.prototype, 'consumeFirstReplyQuote');
    quoteSpy.mockImplementationOnce(() => 'msg-b').mockImplementationOnce(() => null);

    try {
      const session = createSession(bot, {
        userId: 'u2',
        content: 'B1',
        strippedContent: 'B1',
        messageId: 'msg-b',
      });
      const context = {
        options: {
          conversation: createPluginConversation('conv-quote-text'),
          inputMessage: createExecutorInputMessage('B1'),
          responseMessage: createReplyV2Response({
            decision: 'reply',
            outbound_messages: [
              { type: 'message', content: '第一句' },
              { type: 'message', content: '第二句' },
            ],
          }),
        },
      };

      await executor?.(session, context);

      const calls = bot.sendMessage.mock.calls as any[][];
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[1]).toEqual([
        expect.objectContaining({ type: 'quote', attrs: expect.objectContaining({ id: 'msg-b' }) }),
        expect.objectContaining({ type: 'text', attrs: expect.objectContaining({ content: '第一句' }) }),
      ]);
      expect(extractVisibleMessageText(calls[1]?.[1])).toBe('第二句');
    } finally {
      quoteSpy.mockRestore();
    }
  });

  it('quotes a mention reply as one atomic message when the runtime exposes a first-reply quote target', async () => {
    const { ready, getExecutor, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    bot.internal.getGroupMemberList.mockResolvedValueOnce([
      { user_id: 123456, card: '小祥', nickname: '小祥' },
    ]);
    const quoteSpy = vi.spyOn(ReplyRuntime.prototype, 'consumeFirstReplyQuote').mockReturnValueOnce('msg-b');

    try {
      const session = createSession(bot, {
        userId: 'u2',
        content: 'B1',
        strippedContent: 'B1',
        messageId: 'msg-b',
      });
      const context = {
        options: {
          conversation: createPluginConversation('conv-quote-mention'),
          inputMessage: createExecutorInputMessage('B1'),
          responseMessage: createReplyV2Response({
            decision: 'reply',
            outbound_messages: [
	              {
	                type: 'message',
	                content: '@小祥 先问下这件事。',
	              },
            ],
          }),
        },
      };

      await executor?.(session, context);

      const calls = bot.sendMessage.mock.calls as any[][];
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toEqual([
        expect.objectContaining({ type: 'quote', attrs: expect.objectContaining({ id: 'msg-b' }) }),
        expect.objectContaining({ type: 'at', attrs: expect.objectContaining({ id: '123456' }) }),
        expect.objectContaining({ type: 'text', attrs: expect.objectContaining({ content: ' 先问下这件事。' }) }),
      ]);
    } finally {
      quoteSpy.mockRestore();
    }
  });

  it('sends a safe refusal itself when onebot rejects the first group send with retcode 1200', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    bot.sendMessage.mockRejectedValueOnce(Object.assign(
      new Error('Error with request send_group_msg, args: {"group_id":100}, retcode: 1200'),
      { code: 1200 },
    ));

    const context = {
      options: {
        conversation: createPluginConversation('conv-sensitive'),
        inputMessage: createExecutorInputMessage('中国的'),
        responseMessage: createReplyV2Response('如果您问的是中国大陆近年公开报道里、规模较大且最有代表性的群众性抗议，我会先提 2022 年 11 月的“白纸运动”。'),
      },
    };
    const session = createSession(bot, {
      content: '中国的',
      strippedContent: '中国的',
    });

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage).toHaveBeenCalledTimes(2);
    const sendCalls = bot.sendMessage.mock.calls as unknown[][];
    expect(extractVisibleMessageText(sendCalls[1]?.[1])).toBe('这个话题我不方便在群里展开，换个别的吧。');
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-sensitive' }),
      expectedVisibleAssistantHistory('这个话题我不方便在群里展开，换个别的吧。'),
    );
  });

  it('executes a voice structured reply through the executor', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:8082/healthz') {
          return new Response('ok', { status: 200 });
        }
        if (url === 'http://127.0.0.1:8082/synthesize') {
          return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '请只发一句语音',
      strippedContent: '请只发一句语音',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: true,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-voice'),
        inputMessage: createExecutorInputMessage('请只发一句语音'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          outbound_messages: [{ type: 'voice', content: '收到。' }],
        }),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    const voiceCalls = bot.sendMessage.mock.calls as any[][];
    expect(String(voiceCalls[0]?.[1] ?? '')).toContain('<audio src="data:audio/wav;base64,');
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-voice' }),
      expectedVisibleAssistantHistory('（发送语音：收到。）'),
    );
  });

  it('does not backfill quote after a first voice segment even when the runtime exposes a quote target', async () => {
    const { ready, getPrepare, getExecutor, bot } = createHarness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:8082/healthz') {
          return new Response('ok', { status: 200 });
        }
        if (url === 'http://127.0.0.1:8082/synthesize') {
          return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
        }
        return new Response('ok', { status: 200 });
      }),
    );

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const quoteSpy = vi.spyOn(ReplyRuntime.prototype, 'consumeFirstReplyQuote');
    quoteSpy.mockImplementationOnce(() => 'msg-b').mockImplementationOnce(() => null);

    try {
      const session = createSession(bot, {
        userId: 'u2',
        content: 'B1',
        strippedContent: 'B1',
        messageId: 'msg-b',
        state: {
          qqReplyTransport: {
            capabilitySnapshot: {
              canMultiline: true,
              canVoice: true,
              source: 'cached',
              refreshedAt: Date.now(),
            },
          },
        },
      });
      const context = {
        options: {
          conversation: createPluginConversation('conv-quote-voice'),
          inputMessage: createExecutorInputMessage('B1'),
          responseMessage: createReplyV2Response({
            decision: 'reply',
            outbound_messages: [
              { type: 'voice', content: '收到。' },
              { type: 'message', content: '第二句' },
            ],
          }),
        },
      };

      await executor?.(session, context);

      const calls = bot.sendMessage.mock.calls as any[][];
      expect(calls).toHaveLength(2);
      expect(Array.isArray(calls[0]?.[1])).toBe(false);
      expect(String(calls[0]?.[1] ?? '')).toContain('audio');
      expect(extractVisibleMessageText(calls[1]?.[1])).toBe('第二句');
    } finally {
      quoteSpy.mockRestore();
    }
  });

  it('rejects voice structured replies when voice capability is unavailable', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '请只发一句语音',
      strippedContent: '请只发一句语音',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-voice-fallback'),
        inputMessage: createExecutorInputMessage('请只发一句语音'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          outbound_messages: [{ type: 'voice', content: '收到。' }],
        }),
      },
    };

    await expect(executor?.(session, context)).rejects.toThrow('voice capability is unavailable');
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(chatluna.normalizeResearchReplyHistory).not.toHaveBeenCalled();
  });

  it('executes sticker actions and preserves sticker history text', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '配一个表情包',
      strippedContent: '配一个表情包',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
        qqSticker: createStickerState(),
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-sticker'),
        inputMessage: createExecutorInputMessage('配一个表情包'),
        responseMessage: createReplyV2Response({
            decision: 'reply',
            outbound_messages: [
            { type: 'message', content: '……随你' },
            { type: 'meme', content: '无语地看对方一眼' },
          ],
        }),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage).toHaveBeenCalledTimes(2);
    const stickerCalls = bot.sendMessage.mock.calls as any[][];
    expect(extractVisibleMessageText(stickerCalls[0]?.[1])).toBe('……随你');
    expect(String(stickerCalls[1]?.[1] ?? '')).toContain('<img src="data:image/png;base64,');
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-sticker' }),
      expectedVisibleAssistantHistory('……随你\n（发送表情包：无语少女）'),
    );
  });

  it('quotes the first sticker segment when the runtime exposes a first-reply quote target', async () => {
    const { ready, getPrepare, getExecutor, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const quoteSpy = vi.spyOn(ReplyRuntime.prototype, 'consumeFirstReplyQuote').mockReturnValueOnce('msg-b');

    try {
      const session = createSession(bot, {
        userId: 'u2',
        content: 'B1',
        strippedContent: 'B1',
        messageId: 'msg-b',
        state: {
          qqReplyTransport: {
            capabilitySnapshot: {
              canMultiline: true,
              canVoice: false,
              source: 'cached',
              refreshedAt: Date.now(),
            },
          },
          qqSticker: createStickerState(),
        },
      });
      const context = {
        options: {
          conversation: createPluginConversation('conv-quote-sticker'),
          inputMessage: createExecutorInputMessage('B1'),
          responseMessage: createReplyV2Response({
            decision: 'reply',
            outbound_messages: [{ type: 'meme', content: '无语地看对方一眼' }],
          }),
        },
      };

      await executor?.(session, context);

      const calls = bot.sendMessage.mock.calls as any[][];
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toEqual([
        expect.objectContaining({ type: 'quote', attrs: expect.objectContaining({ id: 'msg-b' }) }),
        expect.objectContaining({ type: 'img' }),
      ]);
    } finally {
      quoteSpy.mockRestore();
    }
  });

  it('rejects meme structured replies when sticker capability is unavailable', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '配一个表情包',
      strippedContent: '配一个表情包',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-sticker-drop'),
        inputMessage: createExecutorInputMessage('配一个表情包'),
        responseMessage: createReplyV2Response({
            decision: 'reply',
            outbound_messages: [
            { type: 'message', content: '还是先说正事。' },
            { type: 'meme', content: '无语地看对方一眼' },
          ],
        }),
      },
    };

    await expect(executor?.(session, context)).rejects.toThrow('meme output but sticker capability is unavailable');
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(chatluna.normalizeResearchReplyHistory).not.toHaveBeenCalled();
  });

  it('splits ordinary multi-line messages into separate sends', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    vi.useFakeTimers();

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '给我两行命令',
      strippedContent: '给我两行命令',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-1'),
        inputMessage: createExecutorInputMessage('给我两行命令'),
        responseMessage: createReplyV2Response('echo hi\npwd'),
      },
    };

    const pending = executor?.(session, context);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(typeof result).toBe('number');
    expect(extractSentMessagePayloads(bot)).toEqual(['echo hi', 'pwd']);
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
      expectedVisibleAssistantHistory('echo hi\npwd'),
    );
  });

  it('keeps structured blocks atomic while preserving surrounding text order', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    vi.useFakeTimers();

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '先说一句再给清单',
      strippedContent: '先说一句再给清单',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-structured-multiline'),
        inputMessage: createExecutorInputMessage('先说一句再给清单'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          outbound_messages: [
            { type: 'message', content: '先看这个清单。' },
            { type: 'structured_block', content: '- 牛奶\n- 面包' },
            { type: 'message', content: '照着买。' },
          ],
        }),
      },
    };

    const pending = executor?.(session, context);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(typeof result).toBe('number');
    expect(extractSentMessagePayloads(bot)).toEqual([
      '先看这个清单。',
      '- 牛奶\n- 面包',
      '照着买。',
    ]);
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-structured-multiline' }),
      expectedVisibleAssistantHistory('先看这个清单。\n- 牛奶\n- 面包\n照着买。'),
    );
  });

  it('logs history normalization failures after send instead of surfacing a second user-visible error', async () => {
    const { ready, getExecutor, bot } = createHarness({
      normalizeResearchReplyHistoryImpl: async () => {
        throw new Error('research reply history normalization failed: latest message missing (conv-broken)');
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '普通聊聊',
      strippedContent: '普通聊聊',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-broken'),
        inputMessage: createExecutorInputMessage('普通聊聊'),
        responseMessage: createReplyV2Response('收到'),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(extractSentMessagePayloads(bot)).toEqual(['收到']);
    expect(context.options.responseMessage).toBeNull();
    expect(
      loggerMocks.warn.mock.calls.some(
        ([message, detail]) =>
          String(message).includes('research reply history normalization failed') &&
          String(detail).includes('latest message missing'),
      ),
    ).toBe(true);
  });

  it('rejects plugin rooms when the runtime model does not support structured json schema', async () => {
    const { ready, getPrepare, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const unsupportedProfile = resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'openai',
      CHATLUNA_OPENAI_BASE_URL: 'https://shell.wyzai.top/v1',
      CHATLUNA_OPENAI_API_KEY: 'sk-openai',
      CHATLUNA_OPENAI_DEFAULT_MODEL: 'openai/gpt-5.4-medium-thinking',
    });
    mainChatRuntimeState.initialize({
      ...unsupportedProfile,
      defaultModel: 'openai/gpt-5.2',
      canonicalModel: 'openai/gpt-5.2',
      transportModel: 'gpt-5.2',
    });

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const session = createSession(bot, {
      content: '查一下液态玻璃是什么',
      strippedContent: '查一下液态玻璃是什么',
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-research', {
          model: 'openai/gpt-5.4-medium-thinking',
        }),
        inputMessage: {
          content: '查一下液态玻璃是什么',
          additional_kwargs: {},
        },
      },
    };

    await expect(prepare?.(session, context)).rejects.toThrow('requires a supported main chat model');
    expect(chatluna.createChatModel).not.toHaveBeenCalled();
  });

  it('silently suppresses plain-text outputs and logs the invalid JSON classification', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '发个表情包',
      strippedContent: '发个表情包',
      messageId: 'msg-invalid-json',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-rerun'),
        inputMessage: createExecutorInputMessage('发个表情包'),
        responseMessage: createRawReplyResponse('模型直接说了一句普通文本'),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-rerun' }),
      '',
    );
    expect(loggerMocks.warn.mock.calls.some(([message]) => String(message).includes('reply-plan-debug'))).toBe(false);
    expect(
      hasStructuredFailureLog({
        conversationId: 'conv-rerun',
        messageId: 'msg-invalid-json',
        failureKind: 'invalid_structured_json',
      }),
    ).toBe(true);
  });

  it('cleans the saved raw AI tail when CHAT_REPLY_V1 models answer in plain text', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '祥 评价一下刘若希',
      strippedContent: '祥 评价一下刘若希',
      messageId: 'msg-chat-reply-v1-plain-text',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-chat-reply-v1-plain-text'),
        inputMessage: {
          content: '祥 评价一下刘若希',
          additional_kwargs: {
            qqbot_final_response_contract: {
              protocol: 'chat_reply_v1',
            },
          },
        },
        responseMessage: createRawReplyResponse('我印象里没见过这个人。附件记录里倒是有她的几张图片，但没跟她说过话，无从评价。'),
      },
    };

    const result = await executor?.(session, context);

    expect(typeof result).toBe('number');
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-chat-reply-v1-plain-text' }),
      '',
    );
    expect(
      hasStructuredFailureLog({
        conversationId: 'conv-chat-reply-v1-plain-text',
        messageId: 'msg-chat-reply-v1-plain-text',
        failureKind: 'invalid_text_protocol',
      }),
    ).toBe(true);
  });

  it('silently stops when the model output is empty and only logs to koishi', async () => {
    const { ready, getExecutor, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '发个表情包',
      strippedContent: '发个表情包',
      messageId: 'msg-empty-output',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-empty-model-output'),
        inputMessage: createExecutorInputMessage('发个表情包'),
        responseMessage: createRawReplyResponse('   ', {
          requestMode: 'chat_completions',
          providerOutputTokens: 46,
        }),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(context.options.responseMessage).toBeNull();
    expect(
      hasStructuredFailureLog({
        conversationId: 'conv-empty-model-output',
        messageId: 'msg-empty-output',
        failureKind: 'provider_empty_finish',
        requestMode: 'chat_completions',
        providerOutputTokens: '46',
      }),
    ).toBe(true);
  });

  it('silently suppresses fenced json outputs and logs the invalid JSON classification', async () => {
    const { ready, getExecutor, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '发个表情包',
      strippedContent: '发个表情包',
      messageId: 'msg-fenced-json',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-fenced-json'),
        inputMessage: createExecutorInputMessage('发个表情包'),
        responseMessage: createRawReplyResponse(
          ['```json', '{"decision":"reply","outbound_messages":[{"type":"message","content":"收到"}]}', '```'].join('\n'),
        ),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(context.options.responseMessage).toBeNull();
    expect(
      hasStructuredFailureLog({
        conversationId: 'conv-fenced-json',
        messageId: 'msg-fenced-json',
        failureKind: 'invalid_structured_json',
      }),
    ).toBe(true);
  });

  it('silently suppresses schema-invalid JSON outputs and logs the schema classification', async () => {
    const { ready, getExecutor, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '发个表情包',
      strippedContent: '发个表情包',
      messageId: 'msg-invalid-schema',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-invalid-schema'),
        inputMessage: createExecutorInputMessage('发个表情包'),
        responseMessage: createRawReplyResponse(
          JSON.stringify({
            decision: 'reply',
            outbound_messages: [{ type: 'message', content: '收到', mentions: ['u1'] }],
          }),
        ),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(context.options.responseMessage).toBeNull();
    expect(
      hasStructuredFailureLog({
        conversationId: 'conv-invalid-schema',
        messageId: 'msg-invalid-schema',
        failureKind: 'invalid_structured_schema',
      }),
    ).toBe(true);
  });
});
