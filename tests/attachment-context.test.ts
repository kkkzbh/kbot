import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import type { QqbotAttachmentRecord } from '../src/types/attachment.js';
import { resolveReferencedAttachmentsFromCatalog } from '../src/plugins/attachment/resolution.js';

const promptContextMocks = vi.hoisted(() => ({
  registerPromptFragment: vi.fn(),
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

  class MockLogger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
  }

  return {
    Context: class {},
    Logger: MockLogger,
    Schema: {
      object: () => createSchemaNode(),
      natural: () => createSchemaNode(),
      number: () => createSchemaNode(),
      string: () => createSchemaNode(),
    },
  };
});

vi.mock('koishi-plugin-chatluna/utils/string', () => ({
  getMessageContent(content: unknown) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  },
  getMimeTypeFromSource(source: string) {
    if (source.endsWith('.pdf')) return 'application/pdf';
    if (source.endsWith('.mp3')) return 'audio/mpeg';
    if (source.endsWith('.png')) return 'image/png';
    return 'application/octet-stream';
  },
}));

vi.mock('koishi-plugin-chatluna/llm-core/platform/types', () => ({
  ModelCapabilities: {
    ToolCall: 'tool_call',
    ImageInput: 'image_input',
    Thinking: 'thinking',
    ImageGeneration: 'image_generation',
    AudioInput: 'audio_input',
    VideoInput: 'video_input',
    FileInput: 'file_input',
  },
}));

vi.mock('../src/plugins/shared/prompt-context/index.js', () => ({
  registerPromptFragment: promptContextMocks.registerPromptFragment,
}));

vi.mock('../src/plugins/shared/voice/input.js', () => ({
  transcribeAudio: vi.fn(),
}));

import { AttachmentService, apply } from '../src/plugins/attachment/index.js';

beforeEach(() => {
  promptContextMocks.registerPromptFragment.mockClear();
});

function createRecord(input: Partial<QqbotAttachmentRecord> & Pick<QqbotAttachmentRecord, 'refId' | 'conversationId' | 'kind'>): QqbotAttachmentRecord {
  return {
    id: Number(input.id ?? 1),
    refId: input.refId,
    conversationId: input.conversationId,
    messageRole: input.messageRole ?? 'human',
    messageId: input.messageId ?? null,
    senderId: input.senderId ?? null,
    senderName: input.senderName ?? '小祥',
    kind: input.kind,
    filename: input.filename ?? `${input.refId}.${input.kind === 'pdf' ? 'pdf' : 'png'}`,
    mimeType: input.mimeType ?? (input.kind === 'pdf' ? 'application/pdf' : 'image/png'),
    storageFileId: input.storageFileId ?? `${input.refId}-storage`,
    storageUrl: input.storageUrl ?? `http://127.0.0.1:5140/chatluna-storage/temp/${input.refId}`,
    byteSize: input.byteSize ?? 1024,
    hash: input.hash ?? null,
    metadata: input.metadata ?? null,
    createdAt: input.createdAt ?? Date.now(),
    updatedAt: input.updatedAt ?? Date.now(),
  };
}

describe('attachment context resolution', () => {
  it('resolves explicit attachment refs from the structured store', async () => {
    const target = createRecord({
      refId: 'att_demo1234',
      conversationId: 'conv-1',
      kind: 'image',
    });
    const result = await resolveReferencedAttachmentsFromCatalog({
      userText: '请继续分析 att_demo1234',
      recent: [],
      limit: 5,
      resolveByRefs: async (refIds) => (refIds.includes(target.refId) ? [target] : []),
    });

    expect(result.reason).toBe('explicit_ref');
    expect(result.selected.map((item) => item.refId)).toEqual(['att_demo1234']);
    expect(result.ambiguous).toEqual([]);
  });

  it('selects up to five recent images for plural relative references', async () => {
    const recent = Array.from({ length: 6 }, (_, index) =>
      createRecord({
        id: index + 1,
        refId: `att_img${index + 1}`,
        conversationId: 'conv-2',
        kind: 'image',
        createdAt: Date.now() - index * 1000,
      }),
    );
    const result = await resolveReferencedAttachmentsFromCatalog({
      userText: '把这五张图对比一下',
      limit: 5,
      recent,
    });

    expect(result.reason).toBe('relative_batch');
    expect(result.selected).toHaveLength(5);
    expect(result.selected[0].refId).toBe('att_img1');
    expect(result.selected[4].refId).toBe('att_img5');
  });

  it('marks ambiguous pdf references instead of auto-injecting all candidates', async () => {
    const recent = [
      createRecord({
        refId: 'att_pdf1',
        conversationId: 'conv-3',
        kind: 'pdf',
        filename: 'rules.pdf',
      }),
      createRecord({
        refId: 'att_pdf2',
        conversationId: 'conv-3',
        kind: 'pdf',
        filename: 'spec.pdf',
        createdAt: Date.now() - 1000,
      }),
    ];
    const result = await resolveReferencedAttachmentsFromCatalog({
      userText: '那个 pdf 里写了什么？',
      limit: 5,
      recent,
    });

    expect(result.selected).toEqual([]);
    expect(result.ambiguous.map((item) => item.refId)).toEqual(['att_pdf1', 'att_pdf2']);
  });

});

function createMockDatabase(seed?: {
  attachments?: QqbotAttachmentRecord[];
  derivatives?: Array<Record<string, unknown>>;
  providerCache?: Array<Record<string, unknown>>;
}) {
  const tables = {
    qqbot_attachment: [...(seed?.attachments ?? [])],
    qqbot_attachment_derivative: [...(seed?.derivatives ?? [])],
    qqbot_attachment_provider_cache: [...(seed?.providerCache ?? [])],
  } as unknown as Record<string, Array<Record<string, unknown>>>;
  let nextId = 10_000;

  return {
    tables,
    async get(table: string, query: Record<string, unknown>) {
      return (tables[table] ?? []).filter((row) =>
        Object.entries(query).every(([key, value]) => row[key] === value),
      );
    },
    async create(table: string, row: Record<string, unknown>) {
      const created = {
        id: Number(row.id ?? nextId++),
        ...row,
      };
      tables[table] = [...(tables[table] ?? []), created];
      return created;
    },
    async set(table: string, query: Record<string, unknown>, patch: Record<string, unknown>) {
      tables[table] = (tables[table] ?? []).map((row) =>
        Object.entries(query).every(([key, value]) => row[key] === value)
          ? { ...row, ...patch }
          : row,
      );
    },
  };
}

function createAttachmentService(records: QqbotAttachmentRecord[], options?: {
  derivatives?: Array<Record<string, unknown>>;
  providerCache?: Array<Record<string, unknown>>;
}) {
  const database = createMockDatabase({
    attachments: records,
    derivatives: options?.derivatives,
    providerCache: options?.providerCache,
  });
  const ctx = {
    database,
    chatluna_storage: {
      async getTempFile() {
        return null;
      },
    },
    chatluna: {},
  };

  const runtime = {
    maxInjectCount: 5,
    maxTextCharsPerFile: 24_000,
    recentCatalogSize: 12,
    projectionTextChars: 1200,
    replayTextChars: 4000,
    replayMaxRefs: 5,
    voiceAsrBaseUrl: '',
    voiceAsrApiKey: '',
    voiceTranscribeTimeoutMs: 45_000,
  };

  return {
    service: new AttachmentService(ctx as any, runtime),
    database,
  };
}

describe('attachment multimodal projection', () => {
  it('projects referenced attachments into text-only context instead of rehydrating file blocks', async () => {
    const image = createRecord({
      refId: 'att_image01',
      conversationId: 'conv-projection',
      kind: 'image',
      filename: 'screen.png',
    });
    const pdf = createRecord({
      refId: 'att_pdf01',
      conversationId: 'conv-projection',
      kind: 'pdf',
      filename: 'spec.pdf',
      mimeType: 'application/pdf',
    });
    const { service } = createAttachmentService([image, pdf], {
      derivatives: [
        {
          id: 1,
          attachmentRefId: pdf.refId,
          kind: 'pdf_text',
          orderIndex: 0,
          mimeType: 'text/plain',
          storageFileId: null,
          storageUrl: null,
          textContent: '这是 PDF 的摘录内容。',
          metadata: null,
          byteSize: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    const result = await service.buildAttachmentProjectionMessages({
      attachments: [image, pdf],
    });

    expect(result.projections).toHaveLength(2);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.getType()).toBe('system');
    expect(typeof result.messages[0]?.content).toBe('string');
    expect(String(result.messages[0]?.content)).toContain('历史附件引用上下文');
    expect(String(result.messages[0]?.content)).toContain('qqbot_attachment_replay');
    expect(String(result.messages[0]?.content)).toContain('att_pdf01');
    expect(String(result.messages[0]?.content)).toContain('这是 PDF 的摘录内容');
    expect(String(result.messages[0]?.content)).not.toContain(image.storageUrl);
    expect(String(result.messages[0]?.content)).toContain('不要假定已经看到原件');
    expect(String(result.messages[0]?.content)).not.toContain('并回灌到上下文');
    expect(Array.isArray(result.messages[0]?.content)).toBe(false);
  });

  it('rewrites archived audio input into transcript text for the current turn', async () => {
    const audio = createRecord({
      refId: 'att_audio01',
      conversationId: 'conv-audio',
      kind: 'audio',
      filename: 'voice.mp3',
      mimeType: 'audio/mpeg',
    });
    const { service } = createAttachmentService([audio], {
      derivatives: [
        {
          id: 2,
          attachmentRefId: audio.refId,
          kind: 'audio_transcript',
          orderIndex: 0,
          mimeType: 'text/plain',
          storageFileId: null,
          storageUrl: null,
          textContent: '你好，这是一段转写。',
          metadata: null,
          byteSize: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
    const message = new HumanMessage({
      content: [
        {
          type: 'audio_url',
          audio_url: {
            url: 'http://127.0.0.1:5140/audio/voice.mp3',
            mimeType: 'audio/mpeg',
          },
        } as any,
      ],
    }) as HumanMessage & { additional_kwargs?: Record<string, unknown> };

    await service.rewriteArchivedInputMessage(message, [
      {
        refId: audio.refId,
        kind: 'audio',
        filename: audio.filename,
        mimeType: audio.mimeType,
        storageFileId: audio.storageFileId,
        storageUrl: audio.storageUrl,
        byteSize: audio.byteSize,
        hash: audio.hash,
        createdAt: audio.createdAt,
      },
    ]);

    expect(Array.isArray(message.content)).toBe(true);
    expect((message.content as any[])[0]?.type).toBe('text');
    expect(JSON.stringify(message.content)).toContain('音频附件 att_audio01 转写');
    expect(JSON.stringify(message.content)).toContain('你好，这是一段转写');
  });

  it('reuses provider cache on repeated attachment replay', async () => {
    const pdf = createRecord({
      refId: 'att_pdf_cache',
      conversationId: 'conv-cache',
      kind: 'pdf',
      filename: 'cached.pdf',
      mimeType: 'application/pdf',
    });
    const { service, database } = createAttachmentService([pdf], {
      derivatives: [
        {
          id: 3,
          attachmentRefId: pdf.refId,
          kind: 'pdf_text',
          orderIndex: 0,
          mimeType: 'text/plain',
          storageFileId: null,
          storageUrl: null,
          textContent: '缓存测试 PDF 摘录。',
          metadata: null,
          byteSize: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    const first = await service.replayAttachments({
      conversationId: pdf.conversationId,
      refs: [pdf.refId],
      purpose: '重新查看这个 PDF',
      provider: 'openai',
    });
    const second = await service.replayAttachments({
      conversationId: pdf.conversationId,
      refs: [pdf.refId],
      purpose: '重新查看这个 PDF',
      provider: 'openai',
    });

    expect(first.cacheHits).toBe(0);
    expect(second.cacheHits).toBe(1);
    expect(second.resolved[0]?.representationKind).toBe('file_url');
    expect((database.tables.qqbot_attachment_provider_cache ?? []).length).toBe(1);
  });
});

type AttachmentEventHandler = () => Promise<unknown> | unknown;
type AttachmentChainMiddleware = (session: unknown, context: unknown) => Promise<number>;
type AttachmentChainConstraint = {
  name: string;
  kind: 'after' | 'before';
  target: string;
};

function attachmentConfig() {
  return {
    maxInjectCount: 5,
    maxTextCharsPerFile: 24_000,
    recentCatalogSize: 12,
    projectionTextChars: 1200,
    replayTextChars: 4000,
    replayMaxRefs: 5,
    voiceAsrBaseUrl: '',
    voiceAsrApiKey: '',
    voiceTranscribeTimeoutMs: 45_000,
  };
}

function createAttachmentLifecycleHarness(options: {
  chatChainInitially?: boolean;
  contextManager?: boolean;
  attachments?: QqbotAttachmentRecord[];
} = {}) {
  const events = new Map<string, AttachmentEventHandler[]>();
  const chainMiddlewares = new Map<string, AttachmentChainMiddleware>();
  const constraints: AttachmentChainConstraint[] = [];
  const disposeTool = vi.fn();
  const chatChain = {
    middleware: vi.fn((name: string, middleware: AttachmentChainMiddleware) => {
      chainMiddlewares.set(name, middleware);
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
    platform: {
      registerTool: vi.fn(() => disposeTool),
      findModel: vi.fn(() => ({ value: { capabilities: [] } })),
    },
  };
  if (options.contextManager !== false) {
    chatluna.contextManager = { inject: vi.fn() };
  }
  if (options.chatChainInitially !== false) {
    chatluna.chatChain = chatChain;
  }

  const ctx = {
    model: { extend: vi.fn() },
    database: createMockDatabase({
      attachments: options.attachments,
    }),
    chatluna,
    chatluna_storage: {
      createTempFile: vi.fn(),
      getTempFile: vi.fn(),
    },
    provide: vi.fn(),
    set: vi.fn(),
    on: vi.fn((name: string, handler: AttachmentEventHandler) => {
      const bucket = events.get(name) ?? [];
      bucket.push(handler);
      events.set(name, bucket);
    }),
  };

  apply(ctx as never, attachmentConfig());

  const runHook = async (name: string) => {
    for (const handler of events.get(name) ?? []) {
      await handler();
    }
  };

  return {
    chainMiddlewares,
    chatChain,
    chatluna,
    constraints,
    ctx,
    disposeTool,
    runHook,
    setChatChainAvailable: () => {
      chatluna.chatChain = chatChain;
    },
  };
}

describe('attachment ChatLuna lifecycle', () => {
  it('registers archive/context middlewares when ChatLuna adds the chat chain', async () => {
    const harness = createAttachmentLifecycleHarness({ chatChainInitially: false });

    await harness.runHook('ready');

    expect(harness.chainMiddlewares.size).toBe(0);
    expect((harness.chatluna.platform as { registerTool: ReturnType<typeof vi.fn> }).registerTool).not.toHaveBeenCalled();

    harness.setChatChainAvailable();
    await harness.runHook('chatluna/chat-chain-added');

    expect(harness.chainMiddlewares.get('qqbot_attachment_archive')).toBeTypeOf('function');
    expect(harness.chainMiddlewares.get('qqbot_attachment_context')).toBeTypeOf('function');
    expect(harness.chatChain.middleware).toHaveBeenCalledTimes(2);
    expect((harness.chatluna.platform as { registerTool: ReturnType<typeof vi.fn> }).registerTool).toHaveBeenCalledTimes(1);

    await harness.runHook('chatluna/chat-chain-added');

    expect(harness.chatChain.middleware).toHaveBeenCalledTimes(2);
    expect((harness.chatluna.platform as { registerTool: ReturnType<typeof vi.fn> }).registerTool).toHaveBeenCalledTimes(1);

    await harness.runHook('dispose');
    expect(harness.disposeTool).toHaveBeenCalledTimes(1);
  });

  it('does not attach request metadata when the current turn has no attachments', async () => {
    const harness = createAttachmentLifecycleHarness();
    await harness.runHook('ready');

    const archive = harness.chainMiddlewares.get('qqbot_attachment_archive');
    const message = new HumanMessage({ content: '没有附件时不写额外请求元数据' }) as HumanMessage & {
      additional_kwargs?: Record<string, unknown>;
    };

    await archive?.({}, {
      options: {
        conversation: {
          conversationId: 'conv-attachment-resolution',
          conversation: {
            id: 'conv-attachment-resolution',
          },
        },
        inputMessage: message,
      },
    });

    expect(message.additional_kwargs ?? {}).toEqual({});
    expect(harness.constraints).toContainEqual({
      name: 'qqbot_attachment_archive',
      kind: 'after',
      target: 'transform_chat_message',
    });
  });

  it('injects referenced attachment context from ChatLuna conversation resolution without legacy room data', async () => {
    const attachment = createRecord({
      refId: 'att_conv1234',
      conversationId: 'conv-attachment-context',
      kind: 'image',
      filename: 'conv-only.png',
    });
    const harness = createAttachmentLifecycleHarness({ attachments: [attachment] });
    await harness.runHook('ready');

    const contextMiddleware = harness.chainMiddlewares.get('qqbot_attachment_context');
    const inputMessage = new HumanMessage({ content: '继续看 att_conv1234' });

    await contextMiddleware?.({}, {
      options: {
        conversation: {
          conversationId: 'conv-attachment-context',
          effectiveModel: 'openai/gpt-4.1',
          conversation: {
            id: 'conv-attachment-context',
            model: 'stale-model',
          },
        },
        inputMessage,
      },
    });

    expect((harness.chatluna.contextManager as { inject: ReturnType<typeof vi.fn> }).inject).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-attachment-context',
        name: 'read_files_context',
        stage: 'after_scratchpad',
      }),
    );
    expect(promptContextMocks.registerPromptFragment).not.toHaveBeenCalledWith(
      'conv-attachment-context',
      expect.objectContaining({ source: 'qqbot_attachment_resolution' }),
    );
    expect(promptContextMocks.registerPromptFragment).not.toHaveBeenCalledWith(
      'conv-attachment-context',
      expect.objectContaining({ source: 'qqbot_recent_attachments' }),
    );
    expect(harness.constraints).toContainEqual({
      name: 'qqbot_attachment_context',
      kind: 'after',
      target: 'qqbot_attachment_archive',
    });
  });

  it('keeps recent attachment catalog for ambiguous references that need clarification', async () => {
    const attachments = [
      createRecord({
        refId: 'att_rules',
        conversationId: 'conv-attachment-ambiguous',
        kind: 'pdf',
        filename: 'rules.pdf',
      }),
      createRecord({
        refId: 'att_specs',
        conversationId: 'conv-attachment-ambiguous',
        kind: 'pdf',
        filename: 'specs.pdf',
        createdAt: Date.now() - 1000,
      }),
    ];
    const harness = createAttachmentLifecycleHarness({ attachments });
    await harness.runHook('ready');

    const contextMiddleware = harness.chainMiddlewares.get('qqbot_attachment_context');
    const inputMessage = new HumanMessage({ content: '那个 pdf 里写了什么？' });

    await contextMiddleware?.({}, {
      options: {
        conversation: {
          conversationId: 'conv-attachment-ambiguous',
          conversation: {
            id: 'conv-attachment-ambiguous',
          },
        },
        inputMessage,
      },
    });

    expect(promptContextMocks.registerPromptFragment).toHaveBeenCalledWith(
      'conv-attachment-ambiguous',
      expect.objectContaining({ source: 'qqbot_recent_attachments' }),
    );
    expect(promptContextMocks.registerPromptFragment).toHaveBeenCalledWith(
      'conv-attachment-ambiguous',
      expect.objectContaining({ source: 'qqbot_attachment_resolution' }),
    );
    expect((harness.chatluna.contextManager as { inject: ReturnType<typeof vi.fn> }).inject).not.toHaveBeenCalled();
  });

  it('does not inject recent attachment catalog into turns that do not mention attachments', async () => {
    const attachment = createRecord({
      refId: 'att_unmentioned',
      conversationId: 'conv-attachment-noise',
      kind: 'image',
      filename: 'old-screen.png',
    });
    const harness = createAttachmentLifecycleHarness({ attachments: [attachment] });
    await harness.runHook('ready');

    const contextMiddleware = harness.chainMiddlewares.get('qqbot_attachment_context');
    const inputMessage = new HumanMessage({ content: '今天晚上吃什么？' });

    await contextMiddleware?.({}, {
      options: {
        conversation: {
          conversationId: 'conv-attachment-noise',
          conversation: {
            id: 'conv-attachment-noise',
          },
        },
        inputMessage,
      },
    });

    expect(promptContextMocks.registerPromptFragment).not.toHaveBeenCalled();
    expect((harness.chatluna.contextManager as { inject: ReturnType<typeof vi.fn> }).inject).not.toHaveBeenCalled();
  });

  it('fails fast when ChatLuna exposes a chain without contextManager', async () => {
    const harness = createAttachmentLifecycleHarness({ contextManager: false });

    await expect(harness.runHook('ready')).rejects.toThrow('attachment requires chatluna.contextManager.');
  });
});
