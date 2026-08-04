import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';

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

import { sendVoiceByBridge } from '../src/plugins/admin-api/voice-bridge.js';
import { apply, deliverStandaloneReplyPlan, ensureCanSendRecord, inject } from '../src/plugins/reply/index.js';
import { ReplyRuntime } from '../src/plugins/reply/runtime/index.js';
import {
  REPLY_DELIVERY_CHECKPOINT_TABLE,
  ReplyDeliveryCheckpointStore,
  type ReplyDeliveryCheckpointRecord,
} from '../src/plugins/reply/delivery/checkpoint-store.js';
import { recoverReplyDeliveryCheckpoints } from '../src/plugins/reply/delivery/recovery.js';
import type { ModelRuntimeSnapshot } from '../src/plugins/model-config/index.js';
import {
  nativeStructuredReplyContent,
  nativeStructuredReplyEnvelope,
  type TestStructuredReply,
} from './structured-reply-fixture.js';
import {
  createTestModelRuntime,
  type TestModelRuntimeOptions,
} from './model-runtime-fixture.js';

type Middleware = (session: Record<string, any>, next: () => Promise<unknown>) => Promise<unknown>;
type EventHandler = (...args: any[]) => Promise<unknown> | unknown;
type ChainMiddleware = (session: Record<string, any>, context: Record<string, any>) => Promise<number>;

function createPersistentCheckpointDatabaseOverrides() {
  const rows = new Map<string, ReplyDeliveryCheckpointRecord>();
  return {
    rows,
    databaseGetImpl: async (table: string, query: Record<string, unknown>) => {
      if (table !== REPLY_DELIVERY_CHECKPOINT_TABLE) return [];
      return [...rows.values()]
        .filter((row) => Object.entries(query).every(([key, value]) => row[key as keyof typeof row] === value))
        .map((row) => ({ ...row }));
    },
    databaseUpsertImpl: async (table: string, records: Record<string, unknown>[]) => {
      if (table !== REPLY_DELIVERY_CHECKPOINT_TABLE) return;
      for (const record of records) {
        const checkpoint = record as unknown as ReplyDeliveryCheckpointRecord;
        rows.set(checkpoint.requestId, { ...checkpoint });
      }
    },
    databaseSetImpl: async (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
      if (table !== REPLY_DELIVERY_CHECKPOINT_TABLE) return;
      const requestId = String(query.requestId ?? '');
      const record = rows.get(requestId);
      if (!record) throw new Error(`missing reply checkpoint ${requestId}`);
      Object.assign(record, update);
    },
    databaseRemoveImpl: async (table: string, query: Record<string, unknown>) => {
      if (table !== REPLY_DELIVERY_CHECKPOINT_TABLE) return;
      rows.delete(String(query.requestId ?? ''));
    },
  };
}

function createTestWav(durationMs = 100): ArrayBuffer {
  const sampleRate = 8_000;
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const dataSize = sampleCount * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

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
  naturalTriggerEnabled?: boolean;
  naturalTriggerVoiceAdmissionEnabled?: boolean;
  naturalTriggerGroups?: string[];
  replyInterruptEnabled?: boolean;
  createChatModelImpl?: (model: string) => Promise<{ invoke: (input: unknown, options?: Record<string, unknown>) => Promise<{ content?: unknown }> }>;
  databaseGetImpl?: (table: string, query: Record<string, unknown>) => Promise<any[]>;
  databaseSetImpl?: (table: string, query: Record<string, unknown>, data: Record<string, unknown>) => Promise<unknown>;
  databaseUpsertImpl?: (table: string, rows: Record<string, unknown>[]) => Promise<unknown>;
  databaseRemoveImpl?: (table: string, query: Record<string, unknown>) => Promise<unknown>;
  featureResolverImpl?: (session: Record<string, any>, featureKey: string) => Promise<boolean> | boolean;
  normalizeResearchReplyHistory?: boolean;
  normalizeResearchReplyHistoryImpl?: (room: Record<string, unknown>, finalVisibleText: string) => Promise<unknown>;
  registerProgressCallbacks?: boolean;
  chatChainInitially?: boolean;
  contextManager?: boolean;
  modelOptions?: TestModelRuntimeOptions;
  mutateModelSnapshot?: (snapshot: ModelRuntimeSnapshot) => void;
} = {}) {
  const middlewares: Middleware[] = [];
  const events = new Map<string, EventHandler[]>();
  const chainMiddlewares = new Map<string, ChainMiddleware>();
  const chainConstraints: ChainConstraint[] = [];
  const progressCallbacksProviders: Array<(input: Record<string, unknown>) => unknown> = [];
  const registeredTools = new Map<string, unknown>();
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
    platform: {
      registerTool: vi.fn((name: string, tool: unknown) => {
        registeredTools.set(name, tool);
        return () => {
          registeredTools.delete(name);
        };
      }),
    },
    createChatModel: vi.fn(async (model: string) => ({
      value: await (overrides.createChatModelImpl?.(model) ??
        Promise.resolve({
          invoke: async () => ({
            content: nativeStructuredReplyContent({
              decision: 'reply',
              outbound_messages: [{ type: 'message', content: '默认回复' }],
            }),
          }),
        })),
    })),
    conversationRuntime: {
      clearConversationCache: vi.fn(async () => true),
    },
  };
  if (overrides.registerProgressCallbacks !== false) {
    chatluna.registerCallbacksProvider = vi.fn((provider: (input: Record<string, unknown>) => unknown) => {
      progressCallbacksProviders.push(provider);
      return () => {
        const index = progressCallbacksProviders.indexOf(provider);
        if (index >= 0) progressCallbacksProviders.splice(index, 1);
      };
    });
  }
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
        requestBoundaryFound: true,
      };
    });
  }
  if (overrides.contextManager !== false) {
    chatluna.contextManager = { inject };
  }
  if (overrides.chatChainInitially !== false) {
    chatluna.chatChain = chatChain;
  }
  const models = createTestModelRuntime(overrides.modelOptions);
  overrides.mutateModelSnapshot?.(models.snapshot);

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
    modelConfig: models.modelConfig,
    naturalTriggerConfig: {
      getRuntimeSnapshot: () => {
        const allowedGroupIds = overrides.naturalTriggerGroups ?? ['group-100'];
        return {
          revision: 1,
          config: {
            enabled: overrides.naturalTriggerEnabled ?? true,
            allowedGroupIds,
            voiceAdmission: {
              enabled: overrides.naturalTriggerVoiceAdmissionEnabled ?? true,
            },
          },
          allowedGroupIds: new Set(allowedGroupIds),
        };
      },
    },
    toolPolicy: {},
    database,
    model: {
      extend: vi.fn(),
    },
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
    getProgressCallbacksProvider: () => progressCallbacksProviders[0],
    registeredTools,
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
    model: 'qqbot-primary/main-chat',
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

function createReplyV2Response(
  input: string | Record<string, unknown>,
  capabilities: { canVoice?: boolean; canMeme?: boolean } = {},
) {
  const reply: TestStructuredReply =
    typeof input === 'string'
      ? {
          decision: 'reply',
          outbound_messages: [{ type: 'message', content: input }],
        }
      : input as TestStructuredReply;
  return {
    content: nativeStructuredReplyContent(reply, capabilities),
    additional_kwargs: {},
  };
}

function createChatReplyV1Response(content: string, nonce: string) {
  return {
    content: [
      `CHAT_REPLY_V1 ${nonce}`,
      'DECISION reply',
      'BEGIN message',
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
  const variants = schema?.properties?.result?.anyOf ?? [];
  const contentItems = variants.flatMap((variant: any) => variant?.properties?.messages?.items?.anyOf ?? []);
  const singletonItems = variants.flatMap((variant: any) => [
    variant?.properties?.voice_message,
    variant?.properties?.meme_message,
  ]).filter((item: any) => item?.type === 'object');
  return [...new Set([...contentItems, ...singletonItems].map((item: any) => item.title).filter(Boolean))];
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('declares required services so reply plan middleware can register on the live chat chain', () => {
    if (Array.isArray(inject)) {
      expect(inject).toEqual(expect.arrayContaining([
        'chatluna',
        'database',
        'featurePolicy',
        'modelConfig',
      ]));
      return;
    }

    expect(inject).toEqual(
      expect.objectContaining({
        required: expect.arrayContaining([
          'chatluna',
          'database',
          'featurePolicy',
          'modelConfig',
          'naturalTriggerConfig',
          'toolPolicy',
        ]),
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

  it('reports missing onebot rpc transport as a typed capability failure', async () => {
    const { bot } = createHarness({ includeInternalRequest: false });
    const capabilityCache = new Map<string, boolean>([['onebot:bot-1', true]]);

    await expect(ensureCanSendRecord(bot as never, capabilityCache, true)).rejects.toMatchObject({
      failure: {
        code: 'platform_capability_rpc',
        stage: 'platform_capability',
        operation: 'onebot.can_send_record',
      },
    });
    expect(capabilityCache.has('onebot:bot-1')).toBe(false);
    expect(bot.internal.canSendRecord).not.toHaveBeenCalled();
    expect(
      loggerMocks.warn.mock.calls.some(([message]) => String(message).includes('fallback to optimistic record support')),
    ).toBe(false);
  });

  it('preserves _request probe errors as typed capability failures', async () => {
    const { bot } = createHarness({
      canSendRecordImpl: async () => {
        throw new Error('_request is not a function');
      },
    });
    const capabilityCache = new Map<string, boolean>([['onebot:bot-1', true]]);

    await expect(ensureCanSendRecord(bot as never, capabilityCache, true)).rejects.toMatchObject({
      failure: {
        code: 'platform_capability_rpc',
        stage: 'platform_capability',
        operation: 'onebot.can_send_record',
      },
    });
    expect(capabilityCache.has('onebot:bot-1')).toBe(false);
    expect(bot.internal.canSendRecord).toHaveBeenCalledTimes(1);
    expect(
      loggerMocks.warn.mock.calls.some(([message]) => String(message).includes('fallback to optimistic record support')),
    ).toBe(false);
  });

  it('does not persist a negative onebot record capability observation', async () => {
    let supported = false;
    const { bot } = createHarness({
      canSendRecordImpl: async () => supported,
    });
    const capabilityCache = new Map<string, boolean>();

    await expect(ensureCanSendRecord(bot as never, capabilityCache)).resolves.toBe(false);
    expect(capabilityCache.has('onebot:bot-1')).toBe(false);

    supported = true;
    await expect(ensureCanSendRecord(bot as never, capabilityCache)).resolves.toBe(true);
    expect(bot.internal.canSendRecord).toHaveBeenCalledTimes(2);
    expect(capabilityCache.get('onebot:bot-1')).toBe(true);
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
        modalityPolicy: null,
      }),
    ).rejects.toThrow('reply plan delivery requires a onebot session with channelId.');
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['empty', []],
  ])('marks standalone delivery outcome unknown when the first transport receipt is %s', async (_label, receipt) => {
    const { bot } = createHarness();
    bot.sendMessage.mockImplementationOnce(async () => receipt as never);
    const session = createSession(bot);

    const delivery = await deliverStandaloneReplyPlan({
      runtime: {} as never,
      session: session as never,
      plan: {
        segments: [
          {
            kind: 'message',
            parts: [{ kind: 'text', content: '这条消息必须有发送回执。' }],
          },
        ],
      },
      modalityPolicy: null,
    });

    expect(delivery).toEqual({
      status: 'outcome_unknown',
      historyText: '',
      receipts: [],
      deliveredModalities: [],
    });
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('marks standalone media delivery outcome unknown when its first receipt is malformed', async () => {
    const { bot } = createHarness();
    bot.sendMessage.mockResolvedValueOnce(['sticker-message-id', '  ']);
    const session = createSession(bot, {
      state: { qqSticker: createStickerState() },
    });

    const delivery = await deliverStandaloneReplyPlan({
      runtime: {} as never,
      session: session as never,
      plan: {
        segments: [{ kind: 'sticker', content: '无语地看对方一眼' }],
      },
      modalityPolicy: {
        canVoice: false,
        canSticker: true,
        voiceReason: 'not_admitted',
        stickerReason: 'explicit_request',
      },
    });

    expect(delivery).toEqual({
      status: 'outcome_unknown',
      historyText: '',
      receipts: [],
      deliveredModalities: [],
    });
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('fails a partially receipted standalone plan and commits only receipted units', async () => {
    vi.useFakeTimers();
    const { bot } = createHarness();
    bot.sendMessage
      .mockResolvedValueOnce(['text-message-id'])
      .mockResolvedValueOnce([]);
    const session = createSession(bot, {
      state: { qqSticker: createStickerState() },
    });

    const pending = deliverStandaloneReplyPlan({
      runtime: {} as never,
      session: session as never,
      plan: {
        segments: [
          {
            kind: 'message',
            parts: [{ kind: 'text', content: '先发出一条文字。' }],
          },
          { kind: 'sticker', content: '无语地看对方一眼' },
        ],
      },
      modalityPolicy: {
        canVoice: false,
        canSticker: true,
        voiceReason: 'not_admitted',
        stickerReason: 'explicit_request',
      },
    });

    await vi.runAllTimersAsync();
    const delivery = await pending;

    expect(delivery).toEqual({
      status: 'outcome_unknown',
      historyText: '先发出一条文字。',
      receipts: [['text-message-id']],
      deliveredModalities: [],
    });
    expect(bot.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps content-blocked replacement semantically failed when an explicit sticker was not delivered', async () => {
    const { bot } = createHarness();
    bot.sendMessage
      .mockRejectedValueOnce(Object.assign(
        new Error('Error with request send_group_msg, retcode: 1200'),
        { code: 1200 },
      ))
      .mockResolvedValueOnce(['replacement-message-id']);
    const session = createSession(bot, {
      state: { qqSticker: createStickerState() },
    });

    const delivery = await deliverStandaloneReplyPlan({
      runtime: {} as never,
      session: session as never,
      plan: {
        segments: [{ kind: 'sticker', content: '无语地看对方一眼' }],
      },
      modalityPolicy: {
        canVoice: false,
        canSticker: true,
        voiceReason: 'not_admitted',
        stickerReason: 'explicit_request',
      },
    });

    expect(delivery).toEqual(expect.objectContaining({
      status: 'failed_semantic',
      historyText: '这个话题我不方便在群里展开，换个别的吧。',
      receipts: [['replacement-message-id']],
      deliveredModalities: [],
      semanticFailure: expect.objectContaining({
        code: 'explicit_modality_delivery_missing',
        stage: 'delivery',
        missingModalities: ['sticker'],
      }),
    }));
    expect(bot.sendMessage).toHaveBeenCalledTimes(2);
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
    const firstRequestSignal = (contextA1.options as Record<string, unknown>).requestSignal as AbortSignal;

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
    await flushMicrotasks();
    expect(firstRequestSignal.aborted).toBe(true);
    await sessionA1.state.qqReplyTransport.handleRequestModelError(
      firstRequestSignal.reason,
      { requestBoundaryPersisted: false },
    );

    await vi.advanceTimersByTimeAsync(450);
    await flushMicrotasks();

    expect(bResolved).toBe(true);
    expect(a2Resolved).toBe(false);
    expect(contextB.options.inputMessage.content).toBe('B1');
    expect((contextB.options as Record<string, unknown>).requestSignal).toBeInstanceOf(AbortSignal);
    expect(((contextB.options as Record<string, unknown>).requestSignal as AbortSignal).aborted).toBe(false);

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

    await sessionA.state.qqReplyTransport.handleRequestModelError(
      new Error('400 invalid_request_body'),
      { requestBoundaryPersisted: false },
    );

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

  it('reports the real Copilot quota error instead of only ChatLuna code 103', async () => {
    const { ready, getPrepare, bot } = createHarness({ replyInterruptEnabled: true });

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const session = createSession(bot, {
      userId: 'u1',
      content: '继续聊',
      strippedContent: '继续聊',
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-copilot-quota', {
          model: 'qqbot-primary/main-chat',
        }),
        inputMessage: { content: '继续聊', additional_kwargs: {} },
      },
    };
    await prepare?.(session, context);

    const origin = Object.assign(new Error(
      'Error when calling responses, Status: 402 Payment Required, Response: {"error":{"message":"You have exceeded your monthly quota","code":"quota_exceeded"}}',
    ), {
      name: 'ChatLunaHttpError',
      operation: 'Error when calling responses',
      status: 402,
      statusText: 'Payment Required',
      responseBody: '{"error":{"message":"You have exceeded your monthly quota","code":"quota_exceeded"}}',
      providerCode: 'quota_exceeded',
      providerMessage: 'Model openai/auto has exceeded its monthly quota',
    });
    const chatlunaError = Object.assign(new Error(
      '使用 ChatLuna 时出现错误，错误码为 103。请联系开发者以解决此问题。',
    ), {
      name: 'ChatLunaError',
      errorCode: 103,
      originError: origin,
      retryable: false,
    });
    const userMessage = await session.state.qqReplyTransport.handleRequestModelError(
      chatlunaError,
      { requestBoundaryPersisted: false },
    );

    expect(userMessage).toBe(
      '主聊天服务请求失败：HTTP 402，error_code=quota_exceeded，当前额度已用完。请等待额度重置、补充额度，或在管理页切换服务。',
    );
    expect(userMessage).not.toContain('GitHub');
    expect(userMessage).not.toContain('Copilot');
    expect(userMessage).not.toContain('openai/auto');
    expect(userMessage).not.toContain('You have exceeded');
    expect(session.send).not.toHaveBeenCalled();
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.stringContaining('reply request_conversation failed before executor cleanup'),
      expect.any(String),
      'conv-copilot-quota',
      expect.stringContaining('103'),
    );
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.stringContaining('reply model upstream failure'),
      expect.any(String),
      'conv-copilot-quota',
      '103',
      'Error when calling responses',
      '402',
      'quota_exceeded',
      'Model openai/auto has exceeded its monthly quota',
      'false',
    );
  });

  it('cleans terminal-contract tool history without persisting transient progress', async () => {
    const {
      ready,
      getPrepare,
      getProgressCallbacksProvider,
      bot,
      chatluna,
    } = createHarness({ replyInterruptEnabled: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    await ready();

    const session = createSession(bot, {
      userId: 'u1',
      content: '帮我查一下',
      strippedContent: '帮我查一下',
    });
    const room = createPluginConversation('conv-terminal-failure');
    await getPrepare()?.(session, {
      options: {
        conversation: room,
        inputMessage: { content: '帮我查一下', additional_kwargs: {} },
      },
    });
    const callbacks = await getProgressCallbacksProvider()?.({
      session,
      conversation: { id: 'conv-terminal-failure' },
      requestId: 'request-terminal-failure',
    }) as { handleCustomEvent?: (...args: unknown[]) => Promise<void> } | undefined;
    await callbacks?.handleCustomEvent?.('chatluna-agent-event', {
      context: { kind: 'main', requestId: 'request-terminal-failure' },
      event: { type: 'tool-call', actions: [{ tool: 'web_search' }] },
    }, 'callback-terminal-failure');
    expect(String(session.send.mock.calls[0]?.[0] ?? '')).not.toBe('');

    const terminalError = Object.assign(new Error('terminal tool missing'), {
      name: 'AgentTerminalContractError',
      code: 'ITERATION_LIMIT',
    });
    const chatlunaError = Object.assign(new Error('ChatLuna error code 103'), {
      name: 'ChatLunaError',
      errorCode: 103,
      originError: terminalError,
    });
    const userMessage = await session.state.qqReplyTransport.handleRequestModelError(
      chatlunaError,
      { requestBoundaryPersisted: false },
    );

    expect(userMessage).toBe('刚才那条没整理好。你再发一次，我重新来。');
    expect(userMessage).not.toMatch(/tool|协议|错误码|103/iu);
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-terminal-failure' }),
      '',
    );
  });

  it('fails request settlement when a persisted history boundary cannot be reconciled', async () => {
    const { ready, getPrepare, bot } = createHarness({
      replyInterruptEnabled: true,
      normalizeResearchReplyHistoryImpl: async () => ({
        requestBoundaryFound: false,
      }),
    });
    await ready();

    const session = createSession(bot, {
      userId: 'u1',
      content: '帮我查一下',
      strippedContent: '帮我查一下',
    });
    await getPrepare()?.(session, {
      options: {
        conversation: createPluginConversation('conv-missing-request-boundary'),
        inputMessage: { content: '帮我查一下', additional_kwargs: {} },
      },
    });

    await expect(
      session.state.qqReplyTransport.handleRequestModelError(
        new Error('provider failed after request persistence'),
        { requestBoundaryPersisted: true },
      ),
    ).rejects.toThrow('reply runtime history normalization did not find request boundary');
  });

  it('preserves image_url content when prepare rewrites aggregated input text', async () => {
    vi.useFakeTimers();
    const { ready, getPrepare, bot } = createHarness({ replyInterruptEnabled: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const room = createPluginRoom('conv-image-preserve');
    const sessionA1 = createSession(bot, {
      userId: 'u1',
      content: '先看这张图',
      strippedContent: '先看这张图',
      author: { nick: '甲', name: '甲' },
    });
    const sessionA2 = createSession(bot, {
      userId: 'u1',
      content: '里面是什么？',
      strippedContent: '里面是什么？',
      author: { nick: '甲', name: '甲' },
    });
    const contextA1 = {
      options: {
        conversation: createPluginConversationFromRoom(room),
        inputMessage: {
          content: [
            { type: 'text', text: '先看这张图' },
            { type: 'image_url', image_url: { url: 'https://example.com/1.png' } },
          ],
          additional_kwargs: {},
        },
      },
    };
    const contextA2 = {
      options: {
        conversation: createPluginConversationFromRoom(room),
        inputMessage: { content: '里面是什么？', additional_kwargs: {} },
      },
    };

    await prepare?.(sessionA1, contextA1);
    const firstRequestSignal = (contextA1.options as Record<string, unknown>).requestSignal as AbortSignal;

    let prepareResolved = false;
    const pendingPrepare = prepare?.(sessionA2, contextA2).then((result) => {
      prepareResolved = true;
      return result;
    });
    await flushMicrotasks();
    expect(firstRequestSignal.aborted).toBe(true);
    await sessionA1.state.qqReplyTransport.handleRequestModelError(
      firstRequestSignal.reason,
      { requestBoundaryPersisted: false },
    );

    await vi.advanceTimersByTimeAsync(450);
    await flushMicrotasks();
    expect(prepareResolved).toBe(true);

    await pendingPrepare;
    expect(contextA2.options.inputMessage.content).toEqual([
      { type: 'text', text: '先看这张图\n里面是什么？' },
      { type: 'image_url', image_url: { url: 'https://example.com/1.png' } },
    ]);

    const sessionA3 = createSession(bot, {
      userId: 'u1',
      content: '还有这张呢？',
      strippedContent: '还有这张呢？',
      author: { nick: '甲', name: '甲' },
    });
    const contextA3 = {
      options: {
        conversation: createPluginConversationFromRoom(room),
        inputMessage: {
          content: [
            { type: 'text', text: '还有这张呢？' },
            { type: 'image_url', image_url: { url: 'https://example.com/2.png', detail: 'high' } },
          ],
          additional_kwargs: {},
        },
      },
    };
    const thirdPrepare = prepare?.(sessionA3, contextA3);
    await flushMicrotasks();
    const secondRequestSignal = (contextA2.options as Record<string, unknown>).requestSignal as AbortSignal;
    expect(secondRequestSignal.aborted).toBe(true);
    await sessionA2.state.qqReplyTransport.handleRequestModelError(
      secondRequestSignal.reason,
      { requestBoundaryPersisted: false },
    );
    await vi.advanceTimersByTimeAsync(450);
    await thirdPrepare;

    expect(contextA3.options.inputMessage.content).toEqual([
      { type: 'text', text: '先看这张图\n里面是什么？\n还有这张呢？' },
      { type: 'image_url', image_url: { url: 'https://example.com/1.png' } },
      { type: 'image_url', image_url: { url: 'https://example.com/2.png', detail: 'high' } },
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
      naturalTriggerGroups: ['group-100'],
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

  it('skips whitelisted group voice input when natural voice admission is disabled', async () => {
    const { inbound, bot } = createHarness({
      naturalTriggerVoiceAdmissionEnabled: false,
      naturalTriggerGroups: ['group-100'],
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
      naturalTriggerGroups: ['group-100'],
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

  it('registers live reply traffic before durable delivery recovery completes', async () => {
    const persistence = createPersistentCheckpointDatabaseOverrides();
    let releaseNormalization: (result: { requestBoundaryFound: true }) => void = () => {};
    const normalizationGate = new Promise<{ requestBoundaryFound: true }>((resolve) => {
      releaseNormalization = resolve;
    });
    const harness = createHarness({
      ...persistence,
      normalizeResearchReplyHistoryImpl: async () => normalizationGate,
    });
    const store = new ReplyDeliveryCheckpointStore(harness.database as never, () => 100);
    const checkpoint = await store.beginRequest('request-startup-recovery', 'conv-startup-recovery');
    const units = [{
      index: 0,
      kind: 'text-line',
      payload: { content: '已送达' },
      historyText: '已送达',
      persistToHistory: true,
    }];
    await store.setPlannedUnits(checkpoint, units);
    await store.beginUnit(checkpoint, 0);
    await store.confirmUnit(checkpoint, units[0], ['message-startup']);

    const readyPromise = harness.ready();
    await flushMicrotasks();
    expect(harness.getPrepare()).toBeTypeOf('function');
    expect(persistence.rows.size).toBe(1);

    releaseNormalization({ requestBoundaryFound: true });
    await readyPromise;
    expect(harness.getPrepare()).toBeTypeOf('function');
    expect(persistence.rows.size).toBe(0);
  });

  it('fails fast when ChatLuna cannot provide agent progress callbacks', async () => {
    const { ready } = createHarness({ registerProgressCallbacks: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await expect(ready()).rejects.toThrow('reply progress requires chatluna.registerCallbacksProvider.');
  });

  it('sends progress from the exact active agent callback without polluting the final transport', async () => {
    const { ready, getPrepare, getProgressCallbacksProvider, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    await ready();

    const session = createSession(bot, {
      content: '帮我搜一下今天的天气',
      strippedContent: '帮我搜一下今天的天气',
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-progress'),
        inputMessage: { content: '帮我搜一下今天的天气', additional_kwargs: {} },
      },
    };
    await getPrepare()?.(session, context);

    const callbacks = await getProgressCallbacksProvider()?.({
      session,
      conversation: { id: 'conv-progress' },
      requestId: 'chatluna-request-1',
    }) as { handleCustomEvent?: (...args: unknown[]) => Promise<void> } | undefined;
    expect(callbacks).toBeDefined();

    await callbacks?.handleCustomEvent?.('chatluna-agent-event', {
      context: { kind: 'main', requestId: 'chatluna-request-1' },
      event: { type: 'tool-call', actions: [{ tool: 'web_search' }] },
    }, 'callback-run');

    expect(session.send).toHaveBeenCalledTimes(1);
    expect(session.send).toHaveBeenCalledWith(expect.stringMatching(/搜|查|翻/u));
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('does not retry progress after QQ returns an ambiguous empty delivery receipt', async () => {
    const { ready, getPrepare, getProgressCallbacksProvider, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    await ready();

    const session = createSession(bot, {
      content: '帮我查一下，再翻翻之前的记录',
      strippedContent: '帮我查一下，再翻翻之前的记录',
    });
    vi.mocked(session.send)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['progress-message-id']);
    const context = {
      options: {
        conversation: createPluginConversation('conv-progress-receipt'),
        inputMessage: { content: '帮我查一下，再翻翻之前的记录', additional_kwargs: {} },
      },
    };
    await getPrepare()?.(session, context);

    const callbacks = await getProgressCallbacksProvider()?.({
      session,
      conversation: { id: 'conv-progress-receipt' },
      requestId: 'chatluna-request-progress-receipt',
    }) as { handleCustomEvent?: (...args: unknown[]) => Promise<void> } | undefined;

    await callbacks?.handleCustomEvent?.('chatluna-agent-event', {
      context: { kind: 'main', requestId: 'chatluna-request-progress-receipt' },
      event: { type: 'tool-call', actions: [{ tool: 'web_search' }] },
    }, 'callback-run');
    await callbacks?.handleCustomEvent?.('chatluna-agent-event', {
      context: { kind: 'main', requestId: 'chatluna-request-progress-receipt' },
      event: { type: 'tool-call', actions: [{ tool: 'memory_search' }] },
    }, 'callback-run');
    await awaitAllCallbacks();

    expect(session.send).toHaveBeenCalledTimes(1);
  });

  it('closes visible progress when the final structured output is invalid', async () => {
    const {
      ready,
      getPrepare,
      getExecutor,
      getProgressCallbacksProvider,
      bot,
      chatluna,
    } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    await ready();

    const session = createSession(bot, {
      content: '帮我搜一下今天的天气',
      strippedContent: '帮我搜一下今天的天气',
      messageId: 'msg-progress-invalid',
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-progress-invalid'),
        inputMessage: createExecutorInputMessage('帮我搜一下今天的天气'),
        responseMessage: createRawReplyResponse('没有遵守结构协议'),
      },
    };
    await getPrepare()?.(session, context);
    const callbacks = await getProgressCallbacksProvider()?.({
      session,
      conversation: { id: 'conv-progress-invalid' },
      requestId: 'chatluna-request-progress-invalid',
    }) as { handleCustomEvent?: (...args: unknown[]) => Promise<void> } | undefined;
    await callbacks?.handleCustomEvent?.('chatluna-agent-event', {
      context: { kind: 'main', requestId: 'chatluna-request-progress-invalid' },
      event: { type: 'tool-call', actions: [{ tool: 'web_search' }] },
    }, 'callback-run');

    await getExecutor()?.(session, context);

    expect(session.send).toHaveBeenCalledTimes(1);
    expect(extractSentMessagePayloads(bot)).toEqual(['刚才没整理好，麻烦你再问我一次。']);
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-progress-invalid' }),
      '刚才没整理好，麻烦你再问我一次。',
    );
  });

  it('recovers a confirmed failure closure when history normalization stops before checkpoint cleanup', async () => {
    const persistence = createPersistentCheckpointDatabaseOverrides();
    const {
      ready,
      getPrepare,
      getExecutor,
      getProgressCallbacksProvider,
      bot,
      database,
    } = createHarness({
      ...persistence,
      normalizeResearchReplyHistoryImpl: async () => {
        throw new Error('history commit interrupted');
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    await ready();

    const session = createSession(bot, {
      content: '帮我查一下',
      strippedContent: '帮我查一下',
      messageId: 'msg-progress-crash',
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-progress-crash'),
        inputMessage: createExecutorInputMessage('帮我查一下'),
        responseMessage: createRawReplyResponse('没有遵守结构协议'),
      },
    };
    await getPrepare()?.(session, context);
    const callbacks = await getProgressCallbacksProvider()?.({
      session,
      conversation: { id: 'conv-progress-crash' },
      requestId: 'chatluna-request-progress-crash',
    }) as { handleCustomEvent?: (...args: unknown[]) => Promise<void> } | undefined;
    await callbacks?.handleCustomEvent?.('chatluna-agent-event', {
      context: { kind: 'main', requestId: 'chatluna-request-progress-crash' },
      event: { type: 'tool-call', actions: [{ tool: 'web_search' }] },
    }, 'callback-run');

    await expect(getExecutor()?.(session, context)).rejects.toThrow('history commit interrupted');
    expect(persistence.rows.size).toBe(1);
    const [checkpoint] = [...persistence.rows.values()];
    const confirmed = JSON.parse(checkpoint.confirmedUnitsJson) as Array<Record<string, unknown>>;
    expect(confirmed).toEqual([
      expect.objectContaining({ persistToHistory: false }),
      expect.objectContaining({
        historyText: '刚才没整理好，麻烦你再问我一次。',
        persistToHistory: true,
        receipt: ['msg-id'],
      }),
    ]);

    const reconcileHistory = vi.fn(async () => ({ requestBoundaryFound: true }));
    await recoverReplyDeliveryCheckpoints({
      store: new ReplyDeliveryCheckpointStore(database as never, () => Date.now()),
      reconcileHistory,
    });
    expect(reconcileHistory).toHaveBeenCalledWith(expect.objectContaining({
      confirmedVisibleText: '刚才没整理好，麻烦你再问我一次。',
    }));
    expect(persistence.rows.size).toBe(0);
  });

  it('blocks a later conversation turn until the prior unreconciled checkpoint is recovered', async () => {
    const persistence = createPersistentCheckpointDatabaseOverrides();
    let normalizationFails = true;
    const harness = createHarness({
      ...persistence,
      normalizeResearchReplyHistoryImpl: async (_room, finalVisibleText) => {
        if (normalizationFails) throw new Error('history database unavailable');
        return {
          requestBoundaryFound: true,
          normalizedText: finalVisibleText,
        };
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    await harness.ready();

    const createTurn = (content: string) => {
      const session = createSession(harness.bot, { content, strippedContent: content });
      return {
        session,
        context: {
          options: {
            conversation: createPluginConversation('conv-reconciliation-gate'),
            inputMessage: createExecutorInputMessage(content),
            responseMessage: createReplyV2Response(`回复：${content}`),
          },
        },
      };
    };

    const first = createTurn('第一条');
    await harness.getPrepare()?.(first.session, first.context);
    await expect(harness.getExecutor()?.(first.session, first.context)).rejects.toThrow(
      'history database unavailable',
    );
    expect(harness.bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(persistence.rows.size).toBe(1);
    const failedRequestId = [...persistence.rows.keys()][0];

    const blocked = createTurn('第二条');
    await expect(harness.getPrepare()?.(blocked.session, blocked.context)).rejects.toThrow(
      'history database unavailable',
    );
    expect(harness.bot.sendMessage).toHaveBeenCalledTimes(1);
    expect([...persistence.rows.keys()]).toEqual([failedRequestId]);

    normalizationFails = false;
    const recovered = createTurn('第三条');
    await harness.getPrepare()?.(recovered.session, recovered.context);
    expect([...persistence.rows.keys()]).not.toContain(failedRequestId);
    await harness.getExecutor()?.(recovered.session, recovered.context);
    expect(harness.bot.sendMessage).toHaveBeenCalledTimes(2);
    expect(persistence.rows.size).toBe(0);
  });

  it('closes visible progress when the model decides there is no final reply', async () => {
    const {
      ready,
      getPrepare,
      getExecutor,
      getProgressCallbacksProvider,
      bot,
      chatluna,
    } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    await ready();

    const session = createSession(bot, {
      content: '帮我找找之前有没有提过这件事',
      strippedContent: '帮我找找之前有没有提过这件事',
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-progress-no-reply'),
        inputMessage: createExecutorInputMessage('帮我找找之前有没有提过这件事'),
        responseMessage: createReplyV2Response({
          decision: 'no_reply',
          outbound_messages: null,
        }),
      },
    };
    await getPrepare()?.(session, context);
    const callbacks = await getProgressCallbacksProvider()?.({
      session,
      conversation: { id: 'conv-progress-no-reply' },
      requestId: 'chatluna-request-progress-no-reply',
    }) as { handleCustomEvent?: (...args: unknown[]) => Promise<void> } | undefined;
    await callbacks?.handleCustomEvent?.('chatluna-agent-event', {
      context: { kind: 'main', requestId: 'chatluna-request-progress-no-reply' },
      event: { type: 'tool-call', actions: [{ tool: 'memory_search' }] },
    }, 'callback-run');

    await getExecutor()?.(session, context);

    expect(session.send).toHaveBeenCalledTimes(1);
    expect(extractSentMessagePayloads(bot)).toEqual(['我看完了，暂时没找到合适的答案。']);
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-progress-no-reply' }),
      '我看完了，暂时没找到合适的答案。',
    );
  });

  it('reconciles an empty no-reply tail immediately when no progress was sent', async () => {
    const persistence = createPersistentCheckpointDatabaseOverrides();
    const { ready, getPrepare, getExecutor, bot, chatluna } = createHarness(persistence);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    await ready();

    const session = createSession(bot, {
      content: '先不用回复',
      strippedContent: '先不用回复',
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-no-progress-no-reply'),
        inputMessage: createExecutorInputMessage('先不用回复'),
        responseMessage: createReplyV2Response({
          decision: 'no_reply',
          outbound_messages: null,
        }),
      },
    };
    await getPrepare()?.(session, context);
    await getExecutor()?.(session, context);

    expect(session.send).not.toHaveBeenCalled();
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-no-progress-no-reply' }),
      '',
    );
    expect(persistence.rows.size).toBe(0);
  });

  it('authorizes a trusted image tool artifact only for the active reply run', async () => {
    const {
      ready,
      getPrepare,
      getExecutor,
      getProgressCallbacksProvider,
      bot,
    } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    await ready();

    const assetRef = 'http://127.0.0.1:5140/chatluna-storage/temp/cf-profile-user-1234.png';
    const session = createSession(bot, {
      content: '查一下这个 CF 用户',
      strippedContent: '查一下这个 CF 用户',
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-trusted-artifact'),
        inputMessage: createExecutorInputMessage('查一下这个 CF 用户'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          outbound_messages: [{ type: 'image', assetRef, alt: 'CF 用户卡片' }],
        }),
      },
    };
    await getPrepare()?.(session, context);
    const callbacks = await getProgressCallbacksProvider()?.({
      session,
      conversation: { id: 'conv-trusted-artifact' },
      requestId: 'chatluna-request-artifact',
    }) as { handleCustomEvent?: (...args: unknown[]) => Promise<void> } | undefined;

    await callbacks?.handleCustomEvent?.('chatluna-agent-event', {
      context: { kind: 'main', requestId: 'chatluna-request-artifact' },
      event: {
        type: 'tool-result',
        steps: [{
          action: { tool: 'cf_user_profile' },
          observation: JSON.stringify({
            tool: 'cf_user_profile',
            image: { assetRef, alt: 'CF 用户卡片' },
          }),
        }],
      },
    }, 'callback-run');

    await getExecutor()?.(session, context);

    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect((bot.sendMessage.mock.calls as any[][])[0]?.[1]).toEqual(
      expect.objectContaining({
        type: 'img',
        attrs: expect.objectContaining({ src: assetRef }),
      }),
    );
  });

  it('cleans the active reply run when prompt compilation fails', async () => {
    const {
      ready,
      getPrepare,
      getPolicy,
      getPromptCompiler,
      getProgressCallbacksProvider,
      bot,
      inject,
    } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    await ready();

    const session = createSession(bot, {
      content: '帮我搜一下今天的天气',
      strippedContent: '帮我搜一下今天的天气',
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-prompt-error'),
        inputMessage: { content: '帮我搜一下今天的天气', additional_kwargs: {} },
      },
    };
    await getPrepare()?.(session, context);
    await getPolicy()?.(session, context);
    const callbacks = await getProgressCallbacksProvider()?.({
      session,
      conversation: { id: 'conv-prompt-error' },
      requestId: 'chatluna-request-error',
    }) as { handleCustomEvent?: (...args: unknown[]) => Promise<void> } | undefined;

    inject.mockImplementationOnce(() => {
      throw new Error('prompt injection failed');
    });
    await expect(getPromptCompiler()?.(session, context)).rejects.toThrow('prompt injection failed');

    await callbacks?.handleCustomEvent?.('chatluna-agent-event', {
      context: { kind: 'main', requestId: 'chatluna-request-error' },
      event: { type: 'tool-call', actions: [{ tool: 'web_search' }] },
    }, 'callback-run');
    expect(session.send).not.toHaveBeenCalled();
    expect(session.state.qqReplyTransport?.runId).toBeUndefined();
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
    expect(chatChain.middleware).toHaveBeenCalledTimes(5);

    await chatChainAdded?.();
    expect(chatChain.middleware).toHaveBeenCalledTimes(5);
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

  it('refreshes platform and tts capability before an explicit voice turn', async () => {
    let canSendRecord = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:8082/healthz') {
        return new Response('ok', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { capabilityMiddleware, bot } = createHarness({
      canSendRecordImpl: async () => canSendRecord,
    });
    bot.selfId = 'bot-explicit-refresh';
    const normal = createSession(bot, {
      content: '晚上好',
      strippedContent: '晚上好',
    });
    await capabilityMiddleware?.(normal, async () => undefined);
    expect(normal.state.qqReplyTransport.capabilitySnapshot.canVoice).toBe(false);

    canSendRecord = true;
    const explicit = createSession(bot, {
      content: '我有点睡不着，给我发一小段语音说晚安。',
      strippedContent: '我有点睡不着，给我发一小段语音说晚安。',
    });
    await capabilityMiddleware?.(explicit, async () => undefined);

    expect(bot.internal.canSendRecord).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8082/healthz',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(explicit.state.qqReplyTransport.capabilitySnapshot).toMatchObject({
      canVoice: true,
      voiceFailure: null,
    });
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
            model: 'qqbot-primary/main-chat',
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
        name: 'qqbot_reply_prompt_envelope_system',
        conversationId: 'conv-1',
        stage: 'after_system_prompts',
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
            title: 'StructuredReplyEnvelope',
            properties: expect.objectContaining({
              result: expect.objectContaining({ anyOf: expect.any(Array) }),
            }),
          }),
          instruction: null,
        }),
      }),
    );
    const groupAdditionalKwargs = context.options.inputMessage.additional_kwargs as Record<string, any>;
    expect(groupAdditionalKwargs.qqbot_final_response_schema).toEqual(
      expect.objectContaining({
        title: 'StructuredReplyEnvelope',
      }),
    );
    const groupContract = groupAdditionalKwargs.qqbot_final_response_contract;
    const groupSchema = groupContract?.schema;
    expect(extractSchemaMessageTitles(groupSchema)).toContain('MessageItem');
  });

  it('keeps terminal reply submission rules in the agent system envelope and final response contract', async () => {
    vi.stubEnv('QQ_VOICE_OUTPUT_LANGUAGE', 'ja');
    const { ready, getPrepare, getPolicy, getPromptCompiler, bot, inject } = createHarness({
      pluginConfig: { voiceOutputLanguage: 'ja' },
      modelOptions: { mainProtocol: 'chat_reply_v1' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const policy = getPolicy();
    const promptCompiler = getPromptCompiler();
    const session = createSession(bot, {
      content: '用语音说说我的性格',
      strippedContent: '用语音说说我的性格',
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-chat-reply-v1'),
        inputMessage: {
          content: '用语音说说我的性格',
          additional_kwargs: {},
        },
      },
    };

    await prepare?.(session, context);
    await policy?.(session, context);
    await promptCompiler?.(session, context);

    const injectedEnvelope = inject.mock.calls.find((call) => {
      const payload = call[0] as Record<string, any> | undefined;
      return payload?.name === 'qqbot_reply_prompt_envelope_system';
    })?.[0];
    const envelopeText = (injectedEnvelope?.value ?? [])
      .map((message: { content?: unknown }) => String(message?.content ?? ''))
      .join('\n\n');

    expect(inject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'qqbot_reply_prompt_envelope_system',
        conversationId: 'conv-chat-reply-v1',
        value: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('qqbot_submit_reply'),
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
          instruction: expect.stringContaining('qqbot_submit_reply'),
          terminalTool: 'qqbot_submit_reply',
        }),
        overrideRequestParams: expect.objectContaining({
          tool_choice: 'required',
          parallel_tool_calls: false,
        }),
      }),
    );
    const chatReplyAdditionalKwargs = context.options.inputMessage.additional_kwargs as Record<string, any>;
    expect(chatReplyAdditionalKwargs.qqbot_final_response_instruction).toContain('qqbot_submit_reply');
    const finalContract = chatReplyAdditionalKwargs.qqbot_final_response_contract;
    expect(finalContract.instruction).toContain('当前语音输出目标语言：日语');
  });

  it('keeps the authorized sticker catalog for the whole reply run', async () => {
    const { ready, getPrepare, getPolicy, getPromptCompiler, getExecutor, bot } = createHarness({
      modelOptions: { mainProtocol: 'chat_reply_v1' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const session = createSession(bot, {
      content: '发一个开心点的表情包庆祝一下。',
      strippedContent: '发一个开心点的表情包庆祝一下。',
      state: { qqSticker: createStickerState() },
    });
    const context: Record<string, any> = {
      options: {
        conversation: createPluginConversation('conv-sticker-run-snapshot'),
        inputMessage: {
          content: '发一个开心点的表情包庆祝一下。',
          additional_kwargs: {},
        },
      },
    };

    await getPrepare()?.(session, context);
    await getPolicy()?.(session, context);
    await getPromptCompiler()?.(session, context);

    delete session.state.qqSticker;
    context.options.responseMessage = createRawChatReplyV1Response([
      'CHAT_REPLY_V1 abc12345',
      'DECISION reply',
      'BEGIN meme',
      '|无语地看对方一眼',
      'END',
      'DONE abc12345',
    ]);

    await expect(getExecutor()?.(session, context)).resolves.toEqual(expect.any(Number));
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    const sends = bot.sendMessage.mock.calls as any[][];
    expect(extractVisibleMessageText(sends[0]?.[1])).toContain('<img src="data:image/png;base64,');
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
    const messageSchema = (schema?.properties?.result?.anyOf ?? [])
      .flatMap((variant: any) => variant?.properties?.messages?.items?.anyOf ?? [])
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
      return payload?.name === 'qqbot_reply_prompt_envelope_system';
    })?.[0];
    expect(injectedEnvelope).toBeDefined();

    const envelopeText = (injectedEnvelope?.value ?? []).map((message: { content?: unknown }) => String(message?.content ?? '')).join('\n');
    expect(envelopeText).toContain('speaker_id=<id>');
    expect(envelopeText).toContain('不同 speaker_id 的消息当成同一个人');
    expect(envelopeText).toContain('最新一条真实用户消息对应本轮直接回应对象');
    expect(envelopeText).toContain('直接在 `message.content` 里写 `@群名片 `');
    expect(envelopeText).not.toContain('当前回合允许使用一条简短 `voice`');
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
          model: 'qqbot-primary/main-chat',
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
          '|篮球……国一？',
          '|',
          '|这问题问得没头没脑的。我对篮球没什么兴趣，也不清楚你指的是哪个所谓"国一"。',
          '|',
          '|如果你是想讨论体育话题，建议你找别人。不过如果是和音乐或演出相关的事，我倒可以听听。',
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
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-transport-down',
        requestId: expect.stringMatching(/^qqreply:/u),
      }),
      '',
    );
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
        String(message).includes('reply plan delivery outcome is unknown'),
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
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-empty-reply' }),
      '',
    );
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
        content: '分两句告诉我',
        strippedContent: '分两句告诉我',
        messageId: 'msg-b',
      });
      const context = {
        options: {
          conversation: createPluginConversation('conv-quote-text'),
          inputMessage: createExecutorInputMessage('分两句告诉我'),
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
        content: '提醒一下小祥',
        strippedContent: '提醒一下小祥',
        messageId: 'msg-b',
      });
      const context = {
        options: {
          conversation: createPluginConversation('conv-quote-mention'),
          inputMessage: createExecutorInputMessage('提醒一下小祥'),
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
          return new Response(createTestWav(), { status: 200 });
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

  it('surfaces a natural failure message when an explicitly requested voice cannot be synthesized', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:8082/healthz') {
          return new Response('ok', { status: 200 });
        }
        if (url === 'http://127.0.0.1:8082/synthesize') {
          return Response.json({ error: { code: 'TTS_BUSY' } }, { status: 503 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await ready();
    await flushMicrotasks();
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
        conversation: createPluginConversation('conv-explicit-voice-failure'),
        inputMessage: createExecutorInputMessage('请只发一句语音'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          outbound_messages: [{ type: 'voice', content: '晚安。' }],
        }),
      },
    };

    await getExecutor()?.(session, context);

    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(extractVisibleMessageText((bot.sendMessage.mock.calls as any[][])[0]?.[1]))
      .toBe('刚才的语音没合成出来（tts.synthesize，HTTP 503，error_code=TTS_BUSY）。');
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-explicit-voice-failure' }),
      '刚才的语音没合成出来（tts.synthesize，HTTP 503，error_code=TTS_BUSY）。',
    );
  });

  it('rejects corrupt synthesis bytes with a typed visible voice failure', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:8082/healthz') {
          return new Response('ok', { status: 200 });
        }
        if (url === 'http://127.0.0.1:8082/synthesize') {
          return new Response(Uint8Array.from([1, 2, 3, 4]), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await ready();
    await flushMicrotasks();
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
        conversation: createPluginConversation('conv-explicit-voice-invalid-wav'),
        inputMessage: createExecutorInputMessage('请只发一句语音'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          outbound_messages: [{ type: 'voice', content: '晚安。' }],
        }),
      },
    };

    await getExecutor()?.(session, context);

    expect(extractSentMessagePayloads(bot)).toEqual([
      '语音服务刚才返回的音频有问题（tts.synthesize_response）。',
    ]);
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-explicit-voice-invalid-wav' }),
      '语音服务刚才返回的音频有问题（tts.synthesize_response）。',
    );
  });

  it('explains the actual capability failure when an explicit voice request is unavailable before generation', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

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
            voiceFailure: {
              code: 'platform_record_unsupported',
              stage: 'platform_capability',
              operation: 'onebot.can_send_record',
            },
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-explicit-voice-unavailable'),
        inputMessage: createExecutorInputMessage('请只发一句语音'),
        responseMessage: createReplyV2Response('我现在发不了语音。', { canVoice: true }),
      },
    };

    await getExecutor()?.(session, context);

    expect(extractSentMessagePayloads(bot)).toEqual([
      'QQ 这边现在不让我发语音（onebot.can_send_record=false）。',
    ]);
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-explicit-voice-unavailable' }),
      'QQ 这边现在不让我发语音（onebot.can_send_record=false）。',
    );
  });

  it.each([
    [
      'text-only',
      {
        decision: 'reply' as const,
        outbound_messages: [{ type: 'message' as const, content: '晚安。' }],
      },
    ],
    [
      'no_reply',
      {
        decision: 'no_reply' as const,
        outbound_messages: null,
      },
    ],
  ])('rejects native chat %s when voice was explicitly requested', async (label, reply) => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();
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
        conversation: createPluginConversation(`conv-explicit-voice-${label}`),
        inputMessage: createExecutorInputMessage('请只发一句语音', 'native_chat_json_schema'),
        responseMessage: createReplyV2Response(reply, { canVoice: true }),
      },
    };

    await getExecutor()?.(session, context);

    expect(extractSentMessagePayloads(bot)).toEqual([
      '我刚才漏了语音。你再叫我一次，我重新发。',
    ]);
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: `conv-explicit-voice-${label}` }),
      '我刚才漏了语音。你再叫我一次，我重新发。',
    );
    expect(context.options.responseMessage).toBeNull();
  });

  it('rejects a CHAT_REPLY_V1 text reply when voice was explicitly requested', async () => {
    const { ready, getExecutor, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();
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
        conversation: createPluginConversation('conv-explicit-voice-chat-reply-v1'),
        inputMessage: createExecutorInputMessage('请只发一句语音', 'chat_reply_v1'),
        responseMessage: createChatReplyV1Response('晚安。', 'abc12345'),
      },
    };

    await getExecutor()?.(session, context);

    expect(extractSentMessagePayloads(bot)).toEqual([
      '我刚才漏了语音。你再叫我一次，我重新发。',
    ]);
    expect(context.options.responseMessage).toBeNull();
  });

  it('preserves independent text when a valid mixed voice plan reaches an unavailable transport', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();
    const session = createSession(bot, {
      content: '用语音总结，链接发文字',
      strippedContent: '用语音总结，链接发文字',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
            voiceFailure: {
              code: 'platform_record_unsupported',
              stage: 'platform_capability',
              operation: 'onebot.can_send_record',
            },
          },
        },
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-mixed-voice-unavailable'),
        inputMessage: createExecutorInputMessage('用语音总结，链接发文字'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          outbound_messages: [
            { type: 'voice', content: '这是语音总结。' },
            { type: 'message', content: '资料链接：https://example.com/result' },
          ],
        }, { canVoice: true }),
      },
    };

    await getExecutor()?.(session, context);

    expect(extractSentMessagePayloads(bot)).toEqual([
      '资料链接：https://example.com/result',
      'QQ 这边现在不让我发语音（onebot.can_send_record=false）。',
    ]);
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-mixed-voice-unavailable' }),
      '资料链接：https://example.com/result\nQQ 这边现在不让我发语音（onebot.can_send_record=false）。',
    );
  });

  it('sends native text before the singleton voice slot and quotes only the first text', async () => {
    const { ready, getPrepare, getExecutor, bot } = createHarness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:8082/healthz') {
          return new Response('ok', { status: 200 });
        }
        if (url === 'http://127.0.0.1:8082/synthesize') {
          return new Response(createTestWav(), { status: 200 });
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
        content: '用语音说收到，再补一句',
        strippedContent: '用语音说收到，再补一句',
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
          inputMessage: createExecutorInputMessage('用语音说收到，再补一句'),
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
      expect(calls[0]?.[1]).toEqual([
        expect.objectContaining({ type: 'quote', attrs: expect.objectContaining({ id: 'msg-b' }) }),
        expect.objectContaining({ type: 'text', attrs: expect.objectContaining({ content: '第二句' }) }),
      ]);
      expect(String(calls[1]?.[1] ?? '')).toContain('audio');
    } finally {
      quoteSpy.mockRestore();
    }
  });

  it('turns an explicit voice intent into a natural capability notice when transport is unavailable', async () => {
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

    await expect(executor?.(session, context)).resolves.toBeTypeOf('number');
    expect(extractSentMessagePayloads(bot)).toEqual([
      '语音服务还没准备好，过一会儿再叫我试试。',
    ]);
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-voice-fallback' }),
      '语音服务还没准备好，过一会儿再叫我试试。',
    );
    expect(loggerMocks.error.mock.calls.some(([message]) =>
      String(message).includes('reply plan executor suppressed structured model failure'))).toBe(false);
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

  it('closes an explicit sticker-only request when no catalog entry matches', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();
    const session = createSession(bot, {
      content: '发个表情包',
      strippedContent: '发个表情包',
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
        conversation: createPluginConversation('conv-sticker-no-match'),
        inputMessage: createExecutorInputMessage('发个表情包'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          outbound_messages: [{ type: 'meme', content: '宇宙飞船起飞庆祝' }],
        }),
      },
    };

    await getExecutor()?.(session, context);

    expect(extractSentMessagePayloads(bot)).toEqual(['这次没找到合适的表情，我先不乱发。']);
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-sticker-no-match' }),
      '这次没找到合适的表情，我先不乱发。',
    );
  });

  it('explains an explicit sticker request when the sticker catalog is unavailable', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();
    const session = createSession(bot, {
      content: '发个表情包',
      strippedContent: '发个表情包',
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
        conversation: createPluginConversation('conv-sticker-unavailable'),
        inputMessage: createExecutorInputMessage('发个表情包'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          outbound_messages: [{ type: 'meme', content: '开心庆祝' }],
        }),
      },
    };

    await getExecutor()?.(session, context);

    expect(extractSentMessagePayloads(bot)).toEqual(['这次没找到合适的表情，我先不乱发。']);
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-sticker-unavailable' }),
      '这次没找到合适的表情，我先不乱发。',
    );
  });

  it('continues to a requested sticker after an explicit voice send is rejected', async () => {
    const { ready, getExecutor, bot, chatluna, database } = createHarness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:8082/healthz') return new Response('ok', { status: 200 });
        if (url === 'http://127.0.0.1:8082/synthesize') return new Response(createTestWav(), { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    let rejectedVoice = false;
    const sendMessage = vi.fn(async (_channelId: string, content: unknown) => {
      if (!rejectedVoice && extractVisibleMessageText(content).includes('<audio')) {
        rejectedVoice = true;
        throw Object.assign(new Error('Error with request send_group_msg, retcode: 1001'), { code: 1001 });
      }
      return ['msg-id'];
    });
    bot.sendMessage = sendMessage as typeof bot.sendMessage;

    await ready();
    await flushMicrotasks();
    const session = createSession(bot, {
      content: '请发一条语音，再发个表情包',
      strippedContent: '请发一条语音，再发个表情包',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: true,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
        qqSticker: createStickerState(),
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-voice-failure-then-sticker'),
        inputMessage: createExecutorInputMessage('请发一条语音，再发个表情包'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          outbound_messages: [
            { type: 'voice', content: '收到。' },
            { type: 'meme', content: '无语' },
          ],
        }),
      },
    };

    await getExecutor()?.(session, context);

    const calls = sendMessage.mock.calls as any[][];
    expect(calls).toHaveLength(3);
    expect(extractVisibleMessageText(calls[1]?.[1])).toBe(
      '语音发出去时被 QQ 拒绝了（onebot.send_record，retcode=1001）。',
    );
    expect(String(calls[2]?.[1] ?? '')).toContain('<img src="data:image/png;base64,');
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-voice-failure-then-sticker' }),
      '语音发出去时被 QQ 拒绝了（onebot.send_record，retcode=1001）。\n（发送表情包：无语少女）',
    );
    expect(database.set).not.toHaveBeenCalledWith(
      'reply_delivery_checkpoint',
      expect.anything(),
      expect.objectContaining({ state: 'outcome_unknown' }),
    );
  });

  it('does not send a fallback when explicit voice delivery times out with an unknown outcome', async () => {
    const { ready, getExecutor, bot, chatluna, database } = createHarness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:8082/healthz') return new Response('ok', { status: 200 });
        if (url === 'http://127.0.0.1:8082/synthesize') return new Response(createTestWav(), { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const sendMessage = vi.fn(async (_channelId: string, content: unknown) => {
      if (extractVisibleMessageText(content).includes('<audio')) {
        throw Object.assign(new Error('send_group_msg timed out after dispatch'), { code: 'ETIMEDOUT' });
      }
      return ['unexpected-message-id'];
    });
    bot.sendMessage = sendMessage as typeof bot.sendMessage;

    await ready();
    await flushMicrotasks();
    const session = createSession(bot, {
      content: '请发一条语音，再发个表情包',
      strippedContent: '请发一条语音，再发个表情包',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: true,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
        qqSticker: createStickerState(),
      },
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-voice-timeout'),
        inputMessage: createExecutorInputMessage('请发一条语音，再发个表情包'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          outbound_messages: [
            { type: 'voice', content: '收到。' },
            { type: 'meme', content: '无语' },
          ],
        }),
      },
    };

    await getExecutor()?.(session, context);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-voice-timeout' }),
      '',
    );
    expect(database.set).toHaveBeenCalledWith(
      'reply_delivery_checkpoint',
      expect.anything(),
      expect.objectContaining({
        state: 'outcome_unknown',
        deliveryOutcomeUnknown: true,
      }),
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
        content: '发个表情包',
        strippedContent: '发个表情包',
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
          inputMessage: createExecutorInputMessage('发个表情包'),
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

  it('preserves text and explains an explicit sticker intent when no sticker transport is available', async () => {
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

    await expect(executor?.(session, context)).resolves.toBeTypeOf('number');
    expect(extractSentMessagePayloads(bot)).toEqual([
      '还是先说正事。',
      '这次没找到合适的表情，我先不乱发。',
    ]);
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-sticker-drop' }),
      '还是先说正事。\n这次没找到合适的表情，我先不乱发。',
    );
    expect(loggerMocks.error.mock.calls.some(([message]) =>
      String(message).includes('reply plan executor suppressed structured model failure'))).toBe(false);
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

  it('surfaces history normalization failures after send without sending a second user-visible reply', async () => {
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

    await expect(executor?.(session, context)).rejects.toThrow(
      'research reply history normalization failed: latest message missing (conv-broken)',
    );
    expect(extractSentMessagePayloads(bot)).toEqual(['收到']);
    expect(context.options.responseMessage).toBeNull();
  });

  it('rejects plugin rooms when the runtime model does not support structured json schema', async () => {
    const { ready, getPrepare, bot, chatluna } = createHarness({
      mutateModelSnapshot(snapshot) {
        const mainModel = snapshot.models.find((model) => model.id === 'main-chat');
        if (!mainModel) throw new Error('test main model is missing.');
        mainModel.capabilities.structuredOutput = false;
        mainModel.structuredOutputProtocol = null;
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const session = createSession(bot, {
      content: '查一下液态玻璃是什么',
      strippedContent: '查一下液态玻璃是什么',
    });
    const context = {
      options: {
        conversation: createPluginConversation('conv-research'),
        inputMessage: {
          content: '查一下液态玻璃是什么',
          additional_kwargs: {},
        },
      },
    };

    await expect(prepare?.(session, context)).rejects.toThrow(
      'main.chat requires structuredOutput capability',
    );
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
          JSON.stringify(nativeStructuredReplyEnvelope({
            decision: 'reply',
            outbound_messages: [{ type: 'message', content: '收到', mentions: ['u1'] }],
          })),
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
