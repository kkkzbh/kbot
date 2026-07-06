import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cron-parser', () => ({
  parseExpression: vi.fn(() => ({
    next: () => ({
      getTime: () => Date.now() + 60_000,
    }),
  })),
}));

vi.mock('koishi-plugin-chatluna/utils/string', () => ({
  getMessageContent: (content: unknown) => (typeof content === 'string' ? content : ''),
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
      boolean: () => createSchemaNode(),
      string: () => createSchemaNode(),
      natural: () => createSchemaNode(),
      number: () => createSchemaNode(),
      array: () => createSchemaNode(),
      union: () => createSchemaNode(),
      const: () => createSchemaNode(),
      enum: () => createSchemaNode(),
    },
    Session: class {},
    h: Object.assign(
      ((type: string, attrs: Record<string, unknown>) => ({ type, attrs, children: [] })) as any,
      {
      at: (id: string) => ({ type: 'at', attrs: { id }, children: [] }),
      text: (content: string) => ({
        type: 'text',
        attrs: { content },
        children: [],
      }),
        image: (src: unknown, mime?: string) => ({
          type: 'image',
          attrs: { src, mime },
          children: [],
        }),
        audio: (src: unknown) => ({
          type: 'audio',
          attrs: { src },
          children: [],
        }),
      },
    ),
  };
});

import { apply, inject as automationInject } from '../src/plugins/automation/index.js';
import { apply as applySticker } from '../src/plugins/sticker/index.js';
import { mainChatRuntimeState } from '../src/plugins/shared/llm/main-chat-runtime.js';
import { resolveMainChatRuntimeProfileFromEnv } from '../src/plugins/shared/llm/main-chat-tabs.js';
import { TOOL_CATALOG } from '../src/plugins/tool-policy/catalog.js';

type ListenerMap = Record<string, Array<() => Promise<void> | void>>;
type ToolRegistry = Record<string, any>;

function createDatabase(seed: Record<string, Record<string, any>[]> = {}) {
  const tables = new Map<string, Record<string, any>[]>(Object.entries(seed).map(([key, value]) => [key, [...value]]));
  const autoIds = new Map<string, number>();

  const getRows = (table: string) => tables.get(table) ?? [];
  const setRows = (table: string, rows: Record<string, any>[]) => {
    tables.set(table, rows);
  };

  const matches = (row: Record<string, any>, query: Record<string, any>) =>
    Object.entries(query).every(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if ('$lte' in value) return Number(row[key]) <= Number((value as any).$lte);
        if ('$in' in value) return Array.isArray((value as any).$in) && (value as any).$in.includes(row[key]);
        return true;
      }
      return row[key] === value;
    });

  return {
    tables,
    get: vi.fn(async (table: string, query: Record<string, any>) => getRows(table).filter((row) => matches(row, query))),
    create: vi.fn(async (table: string, row: Record<string, any>) => {
      const nextId = (autoIds.get(table) ?? 0) + 1;
      autoIds.set(table, nextId);
      const created = row.id == null ? { id: nextId, ...row } : { ...row };
      setRows(table, [...getRows(table), created]);
      return created;
    }),
    set: vi.fn(async (table: string, query: Record<string, any>, patch: Record<string, any>) => {
      setRows(
        table,
        getRows(table).map((row) => (matches(row, query) ? { ...row, ...patch } : row)),
      );
    }),
    remove: vi.fn(async (table: string, query: Record<string, any>) => {
      setRows(
        table,
        getRows(table).filter((row) => !matches(row, query)),
      );
    }),
    upsert: vi.fn(async (table: string, rows: Record<string, any>[]) => {
      const current = [...getRows(table)];
      for (const row of rows) {
        const keys = Object.keys(row).filter((key) => ['id', 'roomId', 'userId', 'groupId', 'defaultRoomId'].includes(key));
        const index = current.findIndex((candidate) =>
          keys.length > 0 && keys.every((key) => candidate[key] === row[key]),
        );
        if (index >= 0) current[index] = { ...current[index], ...row };
        else current.push({ ...row });
      }
      setRows(table, current);
    }),
  };
}

function createHarness(seed: Record<string, Record<string, any>[]> = {}) {
  const listeners: ListenerMap = {};
  const tools: ToolRegistry = {};
  const database = createDatabase(seed);
  const bot = {
    selfId: 'bot-1',
    platform: 'onebot',
    internal: {
      _request: vi.fn(async () => ({ retcode: 0, data: { yes: true } })),
      getGroupMemberList: vi.fn(async (): Promise<Array<{ user_id: string | number; card?: string; nickname?: string }>> => []),
      canSendRecord: vi.fn(async () => true),
      sendGroupMsg: vi.fn(async () => ['msg-id']),
    },
    sendMessage: vi.fn(async () => ['msg-id']),
    session(event: Record<string, any> = {}) {
      return {
        event,
        platform: 'onebot',
        userId: event.user?.id ?? event.userId ?? 'u1',
        channelId: event.channel?.id ?? event.channelId ?? 'group:100',
        guildId: event.guild?.id ?? event.guildId ?? '100',
        isDirect: false,
        bot: bot,
      };
    },
  };

  const ctx = {
    bots: [bot],
    database,
    model: { extend: vi.fn() },
    middleware: vi.fn(),
    command: vi.fn(),
    chatluna: {
      contextManager: {
        inject: vi.fn(),
      },
      platform: {
        registerTool: vi.fn((name: string, tool: any) => {
          tools[name] = tool;
          return () => {
            delete tools[name];
          };
        }),
      },
      chat: vi.fn(async (_session: any, _room: any, _message: any, _events: any, _stream: boolean, _vars: any, _post: any, _req: string, _toolMask: any) => ({
        content: JSON.stringify({
          decision: 'reply',
          outbound_messages: [
            {
              type: 'message',
              content: '自动化执行结果',
            },
          ],
        }),
        additional_kwargs: {},
      })),
    },
    toolPolicy: {
      resolveToolMask: vi.fn(async () => ({
        mode: 'allow',
        allow: ['web_search'],
        deny: [],
        toolCallMask: { mode: 'allow', allow: ['web_search'], deny: [] },
      })),
    },
    on: vi.fn((event: string, listener: () => Promise<void> | void) => {
      (listeners[event] ||= []).push(listener);
    }),
  };

  applySticker(ctx as never, {
    stickerDir: './data/chathub/stickers',
  });
  apply(ctx as never, {
    pollIntervalMs: 1000,
    maxJobsPerUser: 20,
  });

  return {
    ctx,
    bot,
    database,
    tools,
    async runReady() {
      for (const listener of listeners.ready ?? []) {
        await listener();
      }
    },
  };
}

async function callTool(toolEntry: any, input: Record<string, any>, config: Record<string, any>) {
  const tool = toolEntry.createTool({ embeddings: {} });
  return (tool as any)._call(input, null, config);
}

function createRoom(overrides: Record<string, any> = {}) {
  return {
    roomId: 7,
    roomName: '当前房间',
    roomMasterId: 'u1',
    conversationId: 'conv-1',
    preset: 'sakiko',
    model: 'openai/gpt-5.4-medium-thinking',
    chatMode: 'plugin',
    visibility: 'template_clone',
    updatedTime: new Date(),
    ...overrides,
  };
}

function createToolConfig(overrides: Record<string, any> = {}) {
  const session = {
    userId: 'u1',
    platform: 'onebot',
    guildId: '100',
    channelId: 'group:100',
    isDirect: false,
    bot: { selfId: 'bot-1' },
    event: { userId: 'u1', guildId: '100', channelId: 'group:100' },
    ...overrides,
  };

  return {
    configurable: {
      session,
      conversationId: 'conv-1',
    },
  };
}

function createJob(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    creatorId: 'u1',
    scope: 'group',
    channelId: 'group:100',
    guildId: '100',
    platform: 'onebot',
    botSelfId: 'bot-1',
    sourceRoomId: 7,
    sourceConversationId: 'conv-1',
    kind: 'once',
    runAt: Date.now() + 3600_000,
    cronExpr: null,
    goal: '默认任务',
    timezone: 'Asia/Shanghai',
    mentionCreator: 1,
    event: { userId: 'u1', guildId: '100', channelId: 'group:100' },
    status: 'active',
    createdAt: Date.now() - 2000,
    updatedAt: Date.now() - 2000,
    ...overrides,
  };
}

describe('task automation tools and execution', () => {
  const originalActiveTab = process.env.CHATLUNA_ACTIVE_TAB;

  it('requires tool policy instead of running automation with unrestricted tools', () => {
    expect(automationInject.required).toContain('toolPolicy');
    expect('optional' in automationInject ? automationInject.optional : []).not.toContain('toolPolicy');
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-03T10:00:00+08:00'));
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
    vi.stubEnv('QQ_VOICE_TRANSCRIBE_TIMEOUT_MS', '45000');
    vi.stubEnv('QQ_VOICE_SYNTH_TIMEOUT_MS', '300000');
    vi.stubEnv('QQBOT_REPLY_COLLECT_WINDOW_MS', '400');
    vi.stubEnv('QQBOT_REPLY_MAX_PENDING_INPUTS', '8');
    vi.stubEnv('QQBOT_REPLY_INTERRUPT_ENABLED', 'false');
    vi.stubEnv('CHAT_NATURAL_TRIGGER_ENABLED', 'true');
    vi.stubEnv('CHAT_NATURAL_TRIGGER_GROUPS', 'group-100');
    process.env.CHATLUNA_ACTIVE_TAB = 'openai';
    mainChatRuntimeState.initialize(resolveMainChatRuntimeProfileFromEnv(process.env));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.env.CHATLUNA_ACTIVE_TAB = originalActiveTab;
  });

  it('creates a once automation job from same-day natural schedule text', async () => {
    const harness = createHarness({
      chathub_room: [createRoom({ roomName: '当前群房间' })],
    });
    await harness.runReady();

    const result = await callTool(
      harness.tools.automation_create,
      {
        scheduleText: '今天23:45',
        goal: '到点后搜索今天的天气并简短回复',
      },
      createToolConfig(),
    );

    expect(result).toContain('23:45');
    expect(result).toContain('2026-04-03 23:45, Asia/Shanghai');
    expect(await harness.database.get('automation_job', { id: 1 })).toEqual([
      expect.objectContaining({
        id: 1,
        sourceRoomId: 7,
        goal: '到点后搜索今天的天气并简短回复',
        kind: 'once',
        runAt: Date.parse('2026-04-03T23:45:00+08:00'),
        status: 'active',
      }),
    ]);
  });

  it('creates a once automation job from relative-day natural schedule text', async () => {
    const harness = createHarness({
      chathub_room: [createRoom({ roomName: '当前群房间' })],
    });
    await harness.runReady();

    const result = await callTool(
      harness.tools.automation_create,
      {
        scheduleText: '明天早上8点',
        goal: '提醒我打扫卫生',
      },
      createToolConfig(),
    );

    expect(result).toContain('明天08:00');
    expect(result).toContain('2026-04-04 08:00, Asia/Shanghai');
    expect(await harness.database.get('automation_job', { id: 1 })).toEqual([
      expect.objectContaining({
        kind: 'once',
        runAt: Date.parse('2026-04-04T08:00:00+08:00'),
        goal: '提醒我打扫卫生',
      }),
    ]);
  });

  it('creates a once automation job from relative-offset natural schedule text', async () => {
    const harness = createHarness({
      chathub_room: [createRoom({ roomName: '当前群房间' })],
    });
    await harness.runReady();

    const result = await callTool(
      harness.tools.automation_create,
      {
        scheduleText: '半小时后',
        goal: '提醒我站起来活动',
      },
      createToolConfig(),
    );

    expect(result).toContain('10:30');
    expect(result).toContain('2026-04-03 10:30, Asia/Shanghai');
    expect(await harness.database.get('automation_job', { id: 1 })).toEqual([
      expect.objectContaining({
        kind: 'once',
        runAt: Date.parse('2026-04-03T10:30:00+08:00'),
        goal: '提醒我站起来活动',
      }),
    ]);
  });

  it('creates a cron automation job via natural schedule text in the current private plugin room', async () => {
    const harness = createHarness({
      chathub_room: [
        createRoom({
          roomId: 8,
          roomName: '当前私聊房间',
          roomMasterId: 'u1',
          conversationId: 'conv-private-1',
          visibility: 'private',
        }),
      ],
    });
    await harness.runReady();

    const result = await callTool(
      harness.tools.automation_create,
      {
        scheduleText: '每周一早上9点',
        goal: '每周一早上总结本周安排',
      },
      {
        configurable: {
          session: createToolConfig({
            guildId: '',
            channelId: 'private:u1',
            isDirect: true,
            event: { userId: 'u1', channelId: 'private:u1' },
          }).configurable.session,
          conversationId: 'conv-private-1',
        },
      },
    );

    expect(result).toContain('每周一早上9点（cron: 0 9 * * 1, Asia/Shanghai）');
    expect(await harness.database.get('automation_job', { id: 1 })).toEqual([
      expect.objectContaining({
        id: 1,
        scope: 'private',
        channelId: 'private:u1',
        sourceRoomId: 8,
        kind: 'cron',
        cronExpr: '0 9 * * 1',
        mentionCreator: 0,
        status: 'active',
      }),
    ]);
  });

  it('executes due once jobs via independent agent run and uses shared structured reply schema', async () => {
    const automationMask = {
      mode: 'allow',
      allow: ['web_search'],
      deny: [],
      toolCallMask: { mode: 'allow', allow: ['web_search'], deny: [] },
    };
    const harness = createHarness({
      chathub_room: [createRoom({ roomName: '当前群房间' })],
      automation_job: [
        {
          id: 1,
          creatorId: 'u1',
          scope: 'group',
          channelId: 'group:100',
          guildId: '100',
          platform: 'onebot',
          botSelfId: 'bot-1',
          sourceRoomId: 7,
          sourceConversationId: 'conv-1',
          kind: 'once',
          runAt: Date.now() - 1,
          cronExpr: null,
          goal: '总结今天的天气',
          timezone: 'Asia/Shanghai',
          mentionCreator: 1,
          event: { userId: 'u1', guildId: '100', channelId: 'group:100' },
          status: 'active',
          createdAt: Date.now() - 2000,
          updatedAt: Date.now() - 2000,
        },
      ],
    });
    harness.ctx.toolPolicy.resolveToolMask.mockResolvedValue(automationMask);
    await harness.runReady();

    await vi.advanceTimersByTimeAsync(5000);

    expect(harness.ctx.chatluna.chat).toHaveBeenCalledTimes(1);
    expect(harness.ctx.toolPolicy.resolveToolMask).toHaveBeenCalledWith(
      expect.anything(),
      'automation',
      expect.objectContaining({ roomId: 7, conversationId: 'conv-1' }),
    );
    const modelMessage = harness.ctx.chatluna.chat.mock.calls[0]?.[2] as { additional_kwargs?: Record<string, unknown> } | undefined;
    expect(modelMessage?.additional_kwargs).toEqual(
      expect.objectContaining({
        qqbot_reply_mode: 'automation',
        qqbot_final_response_contract: expect.objectContaining({
          protocol: 'native_chat_json_schema',
          schema: expect.objectContaining({
            title: 'StructuredReply',
          }),
          instruction: null,
        }),
      }),
    );
    expect(harness.ctx.chatluna.chat.mock.calls[0]?.[8]).toEqual(automationMask);
    expect(harness.bot.sendMessage).toHaveBeenCalled();
    expect(await harness.database.get('automation_job', { id: 1 })).toEqual([
      expect.objectContaining({ status: 'done' }),
    ]);
    expect(await harness.database.get('automation_job_run', { jobId: 1 })).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        outputText: '自动化执行结果',
        outputPayload: expect.objectContaining({
          decision: 'reply',
        }),
      }),
    ]);
    const removedTempConversation = harness.database.remove.mock.calls.find(([table, query]) => {
      return table === 'chatluna_conversation' && typeof query?.id === 'string' && query.id !== 'conv-1';
    });
    expect(removedTempConversation).toBeDefined();
    const tempConversationId = removedTempConversation?.[1].id;
    expect(harness.database.remove).toHaveBeenCalledWith('chatluna_message', { conversationId: tempConversationId });
    expect(harness.database.remove).not.toHaveBeenCalledWith('chathub_message', expect.anything());
    expect(harness.database.remove).not.toHaveBeenCalledWith('chathub_conversation', expect.anything());
  });

  it('keeps the CHAT_REPLY_V1 contract in automation metadata for tool continuations', async () => {
    const originalActiveTab = process.env.CHATLUNA_ACTIVE_TAB;
    const originalDeepSeekBaseUrl = process.env.CHATLUNA_DEEPSEEK_BASE_URL;
    const originalDeepSeekApiKey = process.env.CHATLUNA_DEEPSEEK_API_KEY;
    const originalDeepSeekModel = process.env.CHATLUNA_DEEPSEEK_DEFAULT_MODEL;
    process.env.CHATLUNA_ACTIVE_TAB = 'deepseek';
    process.env.CHATLUNA_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
    process.env.CHATLUNA_DEEPSEEK_API_KEY = 'sk-deepseek';
    process.env.CHATLUNA_DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
    mainChatRuntimeState.initialize(resolveMainChatRuntimeProfileFromEnv(process.env));

    try {
      const harness = createHarness({
        chathub_room: [createRoom({ roomName: '当前群房间' })],
        automation_job: [createJob({ runAt: Date.now() - 1 })],
      });
      harness.ctx.chatluna.chat.mockResolvedValueOnce({
        content: [
	          'CHAT_REPLY_V1 abc12345',
	          'DECISION reply',
	          'BEGIN message',
	          'CONTENT',
          '|自动化执行结果',
          'END',
          'DONE abc12345',
        ].join('\n'),
        additional_kwargs: {},
      });
      await harness.runReady();

      await vi.advanceTimersByTimeAsync(5000);

      const modelMessage = harness.ctx.chatluna.chat.mock.calls[0]?.[2] as {
        content?: unknown;
        additional_kwargs?: Record<string, unknown>;
      } | undefined;
      expect(modelMessage?.additional_kwargs).toEqual(
        expect.objectContaining({
          qqbot_reply_mode: 'automation',
          qqbot_final_response_contract: expect.objectContaining({
            protocol: 'chat_reply_v1',
            schema: null,
            instruction: expect.stringContaining('CHAT_REPLY_V1 <nonce>'),
          }),
        }),
      );
      expect(String(modelMessage?.additional_kwargs?.qqbot_after_user_message ?? '')).not.toContain('CHAT_REPLY_V1 <nonce>');
      expect(String(modelMessage?.content ?? '')).not.toContain('CHAT_REPLY_V1 <nonce>');
      expect(String(modelMessage?.content ?? '')).not.toContain('payload 内容行必须以 `|` 开头');
      expect(await harness.database.get('automation_job_run', { jobId: 1 })).toEqual([
        expect.objectContaining({
          status: 'succeeded',
          outputText: '自动化执行结果',
        }),
      ]);
    } finally {
      process.env.CHATLUNA_ACTIVE_TAB = originalActiveTab;
      if (originalDeepSeekBaseUrl === undefined) {
        delete process.env.CHATLUNA_DEEPSEEK_BASE_URL;
      } else {
        process.env.CHATLUNA_DEEPSEEK_BASE_URL = originalDeepSeekBaseUrl;
      }
      if (originalDeepSeekApiKey === undefined) {
        delete process.env.CHATLUNA_DEEPSEEK_API_KEY;
      } else {
        process.env.CHATLUNA_DEEPSEEK_API_KEY = originalDeepSeekApiKey;
      }
      if (originalDeepSeekModel === undefined) {
        delete process.env.CHATLUNA_DEEPSEEK_DEFAULT_MODEL;
      } else {
        process.env.CHATLUNA_DEEPSEEK_DEFAULT_MODEL = originalDeepSeekModel;
      }
      mainChatRuntimeState.initialize(resolveMainChatRuntimeProfileFromEnv(process.env));
    }
  });

  it('executes due once jobs in private chat without mention wrapper', async () => {
    const harness = createHarness({
      chathub_room: [
        createRoom({
          roomId: 8,
          roomName: '当前私聊房间',
          roomMasterId: 'u1',
          conversationId: 'conv-private-1',
          visibility: 'private',
        }),
      ],
      automation_job: [
        {
          id: 1,
          creatorId: 'u1',
          scope: 'private',
          channelId: 'private:u1',
          guildId: '',
          platform: 'onebot',
          botSelfId: 'bot-1',
          sourceRoomId: 8,
          sourceConversationId: 'conv-private-1',
          kind: 'once',
          runAt: Date.now() - 1,
          cronExpr: null,
          goal: '私聊执行一次',
          timezone: 'Asia/Shanghai',
          mentionCreator: 0,
          event: { userId: 'u1', channelId: 'private:u1' },
          status: 'active',
          createdAt: Date.now() - 2000,
          updatedAt: Date.now() - 2000,
        },
      ],
    });
    await harness.runReady();

    await vi.advanceTimersByTimeAsync(5000);

    expect(harness.bot.sendMessage).toHaveBeenCalledTimes(1);
    const firstSendCall = harness.bot.sendMessage.mock.calls[0] as unknown[] | undefined;
    expect(firstSendCall).toBeDefined();
    expect(firstSendCall?.at(0)).toBe('private:u1');
    expect(firstSendCall?.at(1)).toEqual(
      expect.objectContaining({
        attrs: expect.objectContaining({ content: '自动化执行结果' }),
      }),
    );
    expect(await harness.database.get('automation_job_run', { jobId: 1 })).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        outputText: '自动化执行结果',
        outputPayload: expect.objectContaining({
          decision: 'reply',
        }),
      }),
    ]);
  });

  it('injects shared chat style guidance and recent source conversation context before execution', async () => {
    const harness = createHarness({
      chathub_room: [createRoom({ roomName: '当前群房间', conversationId: 'conv-ctx' })],
      chatluna_conversation: [
        {
          id: 'conv-ctx',
          latestMessageId: 'm3',
        },
      ],
      chatluna_message: [
        {
          id: 'm1',
          conversationId: 'conv-ctx',
          role: 'human',
          parentId: null,
          content: '第一句用户消息',
        },
        {
          id: 'm2',
          conversationId: 'conv-ctx',
          role: 'ai',
          parentId: 'm1',
          content: '上一轮助手回复',
        },
        {
          id: 'm3',
          conversationId: 'conv-ctx',
          role: 'human',
          parentId: 'm2',
          content: '第二句用户消息',
        },
      ],
      automation_job: [createJob({ runAt: Date.now() - 1, sourceConversationId: 'conv-ctx' })],
    });
    await harness.runReady();

    await vi.advanceTimersByTimeAsync(5000);

    expect(harness.ctx.chatluna.contextManager.inject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'qqbot_automation_prompt_envelope',
        conversationId: expect.any(String),
        stage: 'after_scratchpad',
        value: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('Automation Recent Conversation Window'),
            additional_kwargs: expect.objectContaining({
              qqbot_context: expect.objectContaining({
                source: 'qqbot_automation_recent_context',
              }),
            }),
          }),
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('第一句用户消息'),
          }),
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('上一轮助手回复'),
          }),
        ]),
      }),
    );
  });

  it('fails scheduled automation when recent-context prompt injection is unavailable', async () => {
    const harness = createHarness({
      chathub_room: [createRoom({ roomName: '当前群房间', conversationId: 'conv-ctx' })],
      chatluna_conversation: [
        {
          id: 'conv-ctx',
          latestMessageId: 'm1',
        },
      ],
      chatluna_message: [
        {
          id: 'm1',
          conversationId: 'conv-ctx',
          role: 'human',
          parentId: null,
          content: '第一句用户消息',
        },
      ],
      automation_job: [createJob({ runAt: Date.now() - 1, sourceConversationId: 'conv-ctx' })],
    });
    delete (harness.ctx.chatluna as { contextManager?: unknown }).contextManager;
    await harness.runReady();

    await vi.advanceTimersByTimeAsync(5000);

    expect(harness.ctx.chatluna.chat).not.toHaveBeenCalled();
    expect(await harness.database.get('automation_job_run', { jobId: 1 })).toEqual([
      expect.objectContaining({
        status: 'failed',
        error: 'automation prompt injection requires chatluna.contextManager.',
      }),
    ]);
  });

  it('sends real mention messages from inline mention content without mentionCreator wrapper', async () => {
    const harness = createHarness({
      chathub_room: [createRoom({ roomName: '当前群房间' })],
      automation_job: [createJob({ runAt: Date.now() - 1, mentionCreator: 0 })],
    });
    harness.bot.internal.getGroupMemberList.mockResolvedValueOnce([
      { user_id: 3623807220, card: '刘若希', nickname: '希娃儿' },
    ]);
    harness.ctx.chatluna.chat.mockResolvedValueOnce({
      content: JSON.stringify({
        decision: 'reply',
        outbound_messages: [
          {
            type: 'message',
            content: '@刘若希 继续看《Ave Mujica》。',
          },
        ],
      }),
      additional_kwargs: {},
    });
    await harness.runReady();

    await vi.advanceTimersByTimeAsync(5000);

    expect(harness.bot.sendMessage).toHaveBeenCalledTimes(1);
    const mentionSendCall = harness.bot.sendMessage.mock.calls[0] as unknown[] | undefined;
    expect(mentionSendCall?.[1]).toEqual([
      { type: 'at', attrs: { id: '3623807220' }, children: [] },
      { type: 'text', attrs: { content: ' 继续看《Ave Mujica》。' }, children: [] },
    ]);
    expect(await harness.database.get('automation_job_run', { jobId: 1 })).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        outputText: '继续看《Ave Mujica》。',
      }),
    ]);
  });

  it('accepts decision=no_reply as a successful automation run', async () => {
    const harness = createHarness({
      chathub_room: [createRoom({ roomName: '当前群房间' })],
      automation_job: [createJob({ runAt: Date.now() - 1 })],
    });
    harness.ctx.chatluna.chat.mockResolvedValueOnce({
      content: JSON.stringify({
        decision: 'no_reply',
      }),
      additional_kwargs: {},
    });
    await harness.runReady();

    await vi.advanceTimersByTimeAsync(5000);

    expect(harness.bot.sendMessage).not.toHaveBeenCalled();
    expect(await harness.database.get('automation_job_run', { jobId: 1 })).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        outputText: null,
        outputPayload: { decision: 'no_reply', outbound_messages: null },
      }),
    ]);
  });

  it('delivers voice replies through the shared reply transport executor', async () => {
    const originalTtsBaseUrl = process.env.QQ_VOICE_TTS_BASE_URL;
    const originalVoiceOutputEnabled = process.env.QQ_VOICE_OUTPUT_ENABLED;
    try {
      process.env.QQ_VOICE_TTS_BASE_URL = 'http://tts.local';
      process.env.QQ_VOICE_OUTPUT_ENABLED = 'true';
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/healthz')) {
          return new Response('ok', { status: 200 });
        }
        if (url.endsWith('/synthesize')) {
          return new Response(Uint8Array.from([82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69, 102, 109, 116, 32, 16, 0, 0, 0, 1, 0, 1, 0, 64, 31, 0, 0, 128, 62, 0, 0, 2, 0, 16, 0, 100, 97, 116, 97, 0, 0, 0, 0]), { status: 200 });
        }
        return new Response('not-found', { status: 404 });
      }));
      const harness = createHarness({
        chathub_room: [createRoom({ roomName: '当前群房间' })],
        automation_job: [createJob({ runAt: Date.now() - 1 })],
      });
      harness.ctx.chatluna.chat.mockResolvedValueOnce({
        content: JSON.stringify({
          decision: 'reply',
          outbound_messages: [
            {
              type: 'voice',
              content: '这是语音回复。',
            },
          ],
        }),
        additional_kwargs: {},
      });
      await harness.runReady();

      await vi.advanceTimersByTimeAsync(5000);

      expect(await harness.database.get('automation_job_run', { jobId: 1 })).toEqual([
        expect.objectContaining({
          status: 'succeeded',
        }),
      ]);
      expect(harness.bot.sendMessage).toHaveBeenCalledTimes(1);
      const voiceSendCall = harness.bot.sendMessage.mock.calls[0] as unknown[] | undefined;
      expect(voiceSendCall?.[1]).toEqual(
        expect.objectContaining({
          type: 'audio',
        }),
      );
    } finally {
      process.env.QQ_VOICE_TTS_BASE_URL = originalTtsBaseUrl;
      process.env.QQ_VOICE_OUTPUT_ENABLED = originalVoiceOutputEnabled;
    }
  });

  it('delivers meme replies through the shared reply transport executor', async () => {
    const harness = createHarness({
      chathub_room: [createRoom({ roomName: '当前群房间' })],
      automation_job: [createJob({ runAt: Date.now() - 1 })],
    });
    harness.ctx.chatluna.chat.mockResolvedValueOnce({
      content: JSON.stringify({
        decision: 'reply',
        outbound_messages: [
          {
            type: 'meme',
            content: '无语地看对方一眼',
          },
        ],
      }),
      additional_kwargs: {},
    });
    await harness.runReady();

    await vi.advanceTimersByTimeAsync(5000);

    expect(harness.bot.sendMessage).toHaveBeenCalledTimes(1);
    const memeSendCall = harness.bot.sendMessage.mock.calls[0] as unknown[] | undefined;
    expect(memeSendCall?.[1]).toEqual(
      expect.objectContaining({
        type: 'image',
      }),
    );
  });

  it('follows the latest source room model at execution time', async () => {
    const harness = createHarness({
      chathub_room: [createRoom({ roomName: '当前群房间' })],
      automation_job: [
        {
          id: 1,
          creatorId: 'u1',
          scope: 'group',
          channelId: 'group:100',
          guildId: '100',
          platform: 'onebot',
          botSelfId: 'bot-1',
          sourceRoomId: 7,
          sourceConversationId: 'conv-1',
          kind: 'once',
          runAt: Date.now() - 1,
          cronExpr: null,
          goal: '执行时跟随最新房间配置',
          timezone: 'Asia/Shanghai',
          mentionCreator: 1,
          event: { userId: 'u1', guildId: '100', channelId: 'group:100' },
          status: 'active',
          createdAt: Date.now() - 2000,
          updatedAt: Date.now() - 2000,
        },
      ],
    });
    await harness.runReady();

    await harness.database.set('chathub_room', { roomId: 7 }, { model: 'openai/gpt-5.4', preset: 'new-preset' });
    await vi.advanceTimersByTimeAsync(5000);

    const [, tempRoom] = harness.ctx.chatluna.chat.mock.calls[0]!;
    expect(tempRoom).toEqual(
      expect.objectContaining({
        model: 'openai/gpt-5.4',
        preset: 'new-preset',
      }),
    );
  });

  it('manages scoped jobs via list pause resume and delete tools', async () => {
    const harness = createHarness({
      chathub_room: [createRoom({ roomName: '当前群房间' })],
      automation_job: [
        createJob({ id: 1, goal: '一次性任务' }),
        createJob({ id: 2, kind: 'cron', runAt: null, cronExpr: '0 9 * * 1', goal: '周期任务' }),
        createJob({ id: 3, creatorId: 'u2', goal: '别人的任务', runAt: Date.now() + 7200_000 }),
      ],
    });
    await harness.runReady();

    const config = createToolConfig();
    const listBefore = await callTool(harness.tools.automation_list, {}, config);
    expect(listBefore).toContain('#1 [active]');
    expect(listBefore).toContain('#2 [active]');
    expect(listBefore).not.toContain('#3');

    await expect(callTool(harness.tools.automation_pause, { taskId: 2 }, config)).resolves.toContain('已暂停自动化任务 #2');
    expect(await harness.database.get('automation_job', { id: 2 })).toEqual([
      expect.objectContaining({ status: 'paused' }),
    ]);

    await expect(callTool(harness.tools.automation_resume, { taskId: 2 }, config)).resolves.toContain('已恢复自动化任务 #2');
    expect(await harness.database.get('automation_job', { id: 2 })).toEqual([
      expect.objectContaining({ status: 'active' }),
    ]);

    await expect(callTool(harness.tools.automation_delete, { taskId: 1 }, config)).resolves.toContain('已删除自动化任务 #1');
    expect(await harness.database.get('automation_job', { id: 1 })).toEqual([
      expect.objectContaining({ status: 'deleted' }),
    ]);

    const listAfter = await callTool(harness.tools.automation_list, {}, config);
    expect(listAfter).not.toContain('#1');
    expect(listAfter).toContain('#2 [active]');
  });

  it('updates a once job from natural schedule text and goal in place', async () => {
    const harness = createHarness({
      chathub_room: [createRoom()],
      automation_job: [
        createJob({
          id: 1,
          kind: 'once',
          runAt: Date.parse('2026-04-03T11:00:00+08:00'),
          goal: '旧目标',
        }),
      ],
    });
    await harness.runReady();

    const result = await callTool(
      harness.tools.automation_update,
      {
        taskId: 1,
        scheduleText: '明天8点',
        goal: '新目标',
      },
      createToolConfig(),
    );

    expect(result).toContain('明天08:00');
    expect(result).toContain('2026-04-04 08:00, Asia/Shanghai');
    expect(await harness.database.get('automation_job', { id: 1 })).toEqual([
      expect.objectContaining({
        id: 1,
        runAt: Date.parse('2026-04-04T08:00:00+08:00'),
        goal: '新目标',
        status: 'active',
      }),
    ]);
  });

  it('updates mentionCreator for group jobs and keeps private jobs unmentioned', async () => {
    const harness = createHarness({
      chathub_room: [
        createRoom(),
        createRoom({
          roomId: 8,
          roomName: '当前私聊房间',
          roomMasterId: 'u1',
          conversationId: 'conv-private-1',
          visibility: 'private',
        }),
      ],
      automation_job: [
        createJob({ id: 1, mentionCreator: 1 }),
        createJob({
          id: 2,
          scope: 'private',
          channelId: 'private:u1',
          guildId: '',
          sourceRoomId: 8,
          sourceConversationId: 'conv-private-1',
          mentionCreator: 0,
        }),
      ],
    });
    await harness.runReady();

    await expect(
      callTool(harness.tools.automation_update, { taskId: 1, mentionCreator: false }, createToolConfig()),
    ).resolves.toContain('已更新自动化任务 #1');
    await expect(
      callTool(
        harness.tools.automation_update,
        { taskId: 2, mentionCreator: true },
        {
          configurable: {
            session: createToolConfig({
              guildId: '',
              channelId: 'private:u1',
              isDirect: true,
              event: { userId: 'u1', channelId: 'private:u1' },
            }).configurable.session,
            conversationId: 'conv-private-1',
          },
        },
      ),
    ).resolves.toContain('已更新自动化任务 #2');

    expect(await harness.database.get('automation_job', { id: 1 })).toEqual([
      expect.objectContaining({ mentionCreator: 0 }),
    ]);
    expect(await harness.database.get('automation_job', { id: 2 })).toEqual([
      expect.objectContaining({ mentionCreator: 0 }),
    ]);
  });

  it('updates an active cron job and re-registers the new in-memory schedule payload', async () => {
    const harness = createHarness({
      chathub_room: [createRoom()],
      automation_job: [
        createJob({
          id: 1,
          kind: 'cron',
          runAt: null,
          cronExpr: '0 9 * * 1',
          goal: '旧周期目标',
        }),
      ],
    });
    await harness.runReady();

    await expect(
      callTool(
        harness.tools.automation_update,
        { taskId: 1, scheduleText: '每周二晚上7点', goal: '新周期目标' },
        createToolConfig(),
      ),
    ).resolves.toContain('每周二晚上7点（cron: 0 19 * * 2, Asia/Shanghai）');

    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.ctx.chatluna.chat).toHaveBeenCalledTimes(1);
    expect(harness.ctx.chatluna.chat.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        content: expect.stringContaining('任务目标：新周期目标'),
      }),
    );
    expect(await harness.database.get('automation_job', { id: 1 })).toEqual([
      expect.objectContaining({
        cronExpr: '0 19 * * 2',
        goal: '新周期目标',
        status: 'active',
      }),
    ]);
  });

  it('updates a paused cron job without resuming it', async () => {
    const harness = createHarness({
      chathub_room: [createRoom()],
      automation_job: [
        createJob({
          id: 1,
          kind: 'cron',
          runAt: null,
          cronExpr: '0 9 * * 1',
          goal: '旧周期目标',
          status: 'paused',
        }),
      ],
    });
    await harness.runReady();

    await expect(
      callTool(
        harness.tools.automation_update,
        { taskId: 1, scheduleText: '每周二晚上7点', goal: '暂停中的新目标' },
        createToolConfig(),
      ),
    ).resolves.toContain('每周二晚上7点（cron: 0 19 * * 2, Asia/Shanghai）');

    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.ctx.chatluna.chat).not.toHaveBeenCalled();
    expect(await harness.database.get('automation_job', { id: 1 })).toEqual([
      expect.objectContaining({
        cronExpr: '0 19 * * 2',
        goal: '暂停中的新目标',
        status: 'paused',
      }),
    ]);
  });

  it('rejects invalid update shapes and immutable job states', async () => {
    const harness = createHarness({
      chathub_room: [createRoom()],
      automation_job: [
        createJob({ id: 1, kind: 'once' }),
        createJob({ id: 2, kind: 'cron', runAt: null, cronExpr: '0 9 * * 1' }),
        createJob({ id: 3, status: 'done' }),
        createJob({ id: 4, status: 'deleted' }),
      ],
    });
    await harness.runReady();

    await expect(callTool(harness.tools.automation_update, { taskId: 1 }, createToolConfig())).rejects.toThrow(
      '更新失败：至少提供一个可更新字段。',
    );
    await expect(
      callTool(harness.tools.automation_update, { taskId: 1, scheduleText: '每周一早上9点' }, createToolConfig()),
    ).rejects.toThrow('更新失败：一次性任务 #1 不能改成周期任务。');
    await expect(
      callTool(harness.tools.automation_update, { taskId: 2, scheduleText: '明天8点' }, createToolConfig()),
    ).rejects.toThrow('更新失败：周期任务 #2 不能改成一次性任务。');
    await expect(
      callTool(harness.tools.automation_update, { taskId: 1, scheduleText: '有空的时候' }, createToolConfig()),
    ).rejects.toThrow('无法解析时间表达：有空的时候。');
    await expect(
      callTool(harness.tools.automation_update, { taskId: 3, goal: '改一下' }, createToolConfig()),
    ).rejects.toThrow('自动化任务 #3 已完成，不能更新。');
    await expect(
      callTool(harness.tools.automation_update, { taskId: 4, goal: '改一下' }, createToolConfig()),
    ).rejects.toThrow('自动化任务 #4 已删除，不能更新。');
  });

  it('records a failed run when the source room no longer exists', async () => {
    const harness = createHarness({
      automation_job: [
        {
          id: 1,
          creatorId: 'u1',
          scope: 'group',
          channelId: 'group:100',
          guildId: '100',
          platform: 'onebot',
          botSelfId: 'bot-1',
          sourceRoomId: 999,
          sourceConversationId: 'conv-missing',
          kind: 'once',
          runAt: Date.now() - 1,
          cronExpr: null,
          goal: '执行会失败',
          timezone: 'Asia/Shanghai',
          mentionCreator: 1,
          event: { userId: 'u1', guildId: '100', channelId: 'group:100' },
          status: 'active',
          createdAt: Date.now() - 2000,
          updatedAt: Date.now() - 2000,
        },
      ],
    });
    await harness.runReady();

    await vi.advanceTimersByTimeAsync(5000);

    expect(harness.ctx.chatluna.chat).not.toHaveBeenCalled();
    expect(await harness.database.get('automation_job_run', { jobId: 1 })).toEqual([
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('source room #999 no longer exists'),
      }),
    ]);
  });

  it('does not register legacy task commands or automation middleware interception', async () => {
    const harness = createHarness({
      chathub_room: [createRoom({ roomName: '当前群房间' })],
    });
    await harness.runReady();

    expect(harness.ctx.command).not.toHaveBeenCalled();
    expect(harness.ctx.middleware).not.toHaveBeenCalled();
  });

  it('exposes automation_update only on the agent tool route', () => {
    const entry = TOOL_CATALOG.find((item) => item.toolName === 'automation_update');
    expect(entry).toEqual(
      expect.objectContaining({
        toolName: 'automation_update',
        availableRoutes: ['agent'],
        defaultEnabledByRoute: {
          agent: true,
          automation: false,
        },
      }),
    );
  });
});
