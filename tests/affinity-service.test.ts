import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AffinityService, type AffinityDatabaseLike } from '../src/plugins/affinity/service.js';
import { CHARACTER_ID, getShanghaiDayKey, getShanghaiDayStartMs } from '../src/plugins/affinity/rules.js';
import {
  beginPromptAssemblyTurn,
  clearPromptAssemblyTurn,
  consumePromptEnvelope,
} from '../src/plugins/shared/prompt-context/index.js';
import { decodeStoredMessageJson, decodeStoredMessageText } from '../src/plugins/shared/stored-message.js';
import { createVoiceRuntimeConfig } from '../src/plugins/reply/index.js';
import type { AffinityEventRecord, AffinityRandomPlanRecord, AffinityScopeConfigRecord } from '../src/types/affinity.js';

vi.mock('koishi', () => {
  class MockLogger {
    info(): void {}
    warn(): void {}
  }

  const schemaChain = new Proxy(() => schemaChain, {
    get: () => schemaChain,
    apply: () => schemaChain,
  }) as any;
  const Schema = new Proxy({}, {
    get: () => schemaChain,
  }) as any;

  return {
    Context: class {},
    Logger: MockLogger,
    Schema,
    h: {
      text: (content: string) => ({
        type: 'text',
        attrs: { content },
        toString: () => content,
      }),
    },
  };
});

vi.mock('koishi-plugin-chatluna/llm-core/memory/message', async () => {
  const { gzipSync } = await import('node:zlib');
  let fallbackId = 0;

  function toArrayBuffer(buffer: Buffer): ArrayBuffer {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  }

  function encodeJson(value: unknown): ArrayBuffer {
    return toArrayBuffer(gzipSync(JSON.stringify(value)));
  }

  return {
    KoishiChatMessageHistory: class {
      constructor(
        private readonly ctx: { database: MemoryDatabase },
        private readonly conversationId: string,
      ) {}

      async addMessages(messages: any[]): Promise<void> {
        const [conversation] = await this.ctx.database.get('chatluna_conversation', { id: this.conversationId });
        let parentId = conversation?.latestMessageId ?? null;
        const rows: Row[] = [];
        for (const message of messages) {
          const recordId = message.response_metadata?.chatluna?.recordId ?? `mock-chatluna-message-${++fallbackId}`;
          const additional = Object.keys(message.additional_kwargs ?? {}).length
            ? encodeJson(message.additional_kwargs)
            : null;
          rows.push({
            id: recordId,
            conversationId: this.conversationId,
            parentId,
            role: typeof message.getType === 'function' ? message.getType() : 'ai',
            text: null,
            content: encodeJson(message.content),
            name: message.name ?? null,
            tool_call_id: message.tool_call_id ?? null,
            tool_calls: message.tool_calls ?? null,
            additional_kwargs_binary: additional,
            response_metadata_binary: encodeJson({
              ...(message.response_metadata ?? {}),
              chatluna: {
                ...(message.response_metadata?.chatluna ?? {}),
                recordId,
              },
            }),
            rawId: message.id ?? null,
            createdAt: new Date(),
          });
          parentId = recordId;
        }
        await this.ctx.database.upsert('chatluna_message', rows);
        await this.ctx.database.upsert('chatluna_conversation', [{
          id: this.conversationId,
          latestMessageId: parentId,
          updatedAt: new Date(),
        }]);
      }
    },
  };
});

vi.mock('../src/plugins/realtime-message/index.js', () => ({
  buildGroupScopeKey: vi.fn((session: any) => {
    const platform = typeof session.platform === 'string' ? session.platform.trim() : '';
    const botSelfId = typeof session.bot?.selfId === 'string' ? session.bot.selfId.trim() : '';
    const groupId = typeof session.guildId === 'string' && session.guildId.trim()
      ? session.guildId.trim()
      : typeof session.channelId === 'string'
        ? session.channelId.trim()
        : '';
    if (!platform || !botSelfId || !groupId || session.isDirect) return null;
    return `${platform}:${botSelfId}:group:${groupId}`;
  }),
  realtimeMessageCache: {
    get: vi.fn(() => []),
  },
}));

type Row = Record<string, any>;

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function encodeStoredMessageContent(value: unknown): ArrayBuffer {
  return toArrayBuffer(gzipSync(JSON.stringify(value)));
}

class MemoryDatabase implements AffinityDatabaseLike {
  readonly tables: Record<string, Row[]>;
  private nextId = 1000;

  constructor(seed: Record<string, Row[]>) {
    this.tables = Object.fromEntries(Object.entries(seed).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]));
  }

  async get(table: string, query: Record<string, unknown>): Promise<Row[]> {
    return (this.tables[table] ?? []).filter((row) => {
      for (const [key, value] of Object.entries(query)) {
        if (row[key] !== value) return false;
      }
      return true;
    });
  }

  async set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<void> {
    for (const row of await this.get(table, query)) {
      Object.assign(row, data);
    }
  }

  async create(table: string, row: Record<string, unknown>): Promise<Row> {
    const record = { ...row };
    if (record.id == null) {
      record.id = this.nextId++;
    }
    const rows = this.tables[table] ?? [];
    rows.push(record);
    this.tables[table] = rows;
    return record;
  }

  async upsert(table: string, rows: Record<string, unknown>[], keys?: string[]): Promise<void> {
    const primaryKeys = keys?.length ? keys : ['id'];
    const tableRows = this.tables[table] ?? [];
    for (const row of rows) {
      const existing = tableRows.find((candidate) => primaryKeys.every((key) => candidate[key] === row[key]));
      if (existing) {
        Object.assign(existing, row);
      } else {
        tableRows.push({ ...row });
      }
    }
    this.tables[table] = tableRows;
  }

  async remove(table: string, query: Record<string, unknown>): Promise<void> {
    this.tables[table] = (this.tables[table] ?? []).filter((row) => {
      for (const [key, value] of Object.entries(query)) {
        if (row[key] !== value) return true;
      }
      return false;
    });
  }
}

const NOW = Date.UTC(2026, 5, 17, 1, 0, 0);
const RANDOM_MESSAGE = '前面你们提到的图论题，我还有一点没想明白。缩点以后，为什么路径关系就能直接看 DAG 呢？';

function createScope(overrides: Partial<AffinityScopeConfigRecord> = {}): AffinityScopeConfigRecord {
  return {
    id: 1,
    characterId: CHARACTER_ID,
    scopeKind: 'group',
    scopeId: '829573670',
    enabled: 1,
    proactiveEnabled: 1,
    label: 'test group',
    platform: 'onebot',
    botSelfId: 'bot-1',
    channelId: '829573670',
    guildId: '829573670',
    conversationId: 'conv-affinity',
    updatedAt: NOW,
    ...overrides,
  };
}

function createPlan(overrides: Partial<AffinityRandomPlanRecord> = {}): AffinityRandomPlanRecord {
  return {
    id: 2,
    planKey: `${CHARACTER_ID}:group:829573670:${getShanghaiDayKey(NOW)}:0`,
    characterId: CHARACTER_ID,
    scopeKind: 'group',
    scopeId: '829573670',
    platform: 'onebot',
    botSelfId: 'bot-1',
    channelId: '829573670',
    guildId: '829573670',
    conversationId: 'conv-affinity',
    triggerKind: 'scheduled',
    dayKey: getShanghaiDayKey(NOW),
    slotIndex: 0,
    direction: 'daily_greeting',
    scheduledAt: NOW - 1,
    status: 'pending',
    messageText: null,
    skipReason: null,
    sentAt: null,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    ...overrides,
  };
}

function createConversation(conversationId = 'conv-affinity'): Row {
  return {
    id: conversationId,
    bindingKey: `shared:onebot:bot-1:${conversationId}`,
    title: 'affinity-test-conversation',
    preset: 'sakiko',
    model: 'openai/gpt-test',
    chatMode: 'plugin',
    createdBy: 'owner-1',
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    lastChatAt: new Date(NOW),
    status: 'active',
    latestMessageId: null,
    additional_kwargs: null,
    compression: null,
    archivedAt: null,
    archiveId: null,
    autoTitle: false,
  };
}

function createAffinityTestVoiceRuntime() {
  return createVoiceRuntimeConfig({
    inputEnabled: false,
    outputEnabled: false,
    asrBaseUrl: '',
    asrApiKey: '',
    ttsBaseUrl: '',
    ttsApiKey: '',
    inputMaxSeconds: 60,
    outputMaxWords: 1000,
    outputMaxSeconds: 600,
    voiceOutputLanguage: 'auto',
    transcribeTimeoutMs: 1000,
    synthTimeoutMs: 1000,
    replyInterruptCollectWindowMs: 1000,
    replyInterruptMaxPendingInputs: 1,
    naturalTriggerEnabled: false,
    naturalTriggerGroups: '',
  });
}

function createHarness(options: {
  scope?: Partial<AffinityScopeConfigRecord>;
  plan?: Partial<AffinityRandomPlanRecord>;
  randomMemories?: Row[];
  conversations?: Row[];
  messages?: Row[];
  includeConversation?: boolean;
  chat?: ReturnType<typeof vi.fn>;
  chatResponse?: { content?: unknown; additional_kwargs?: Record<string, unknown> };
  config?: Row[];
  proactiveVoiceRuntime?: () => ReturnType<typeof createAffinityTestVoiceRuntime>;
} = {}) {
  const scope = createScope(options.scope);
  const plan = createPlan({
    scopeKind: scope.scopeKind,
    scopeId: scope.scopeId,
    platform: scope.platform,
    botSelfId: scope.botSelfId,
    channelId: scope.channelId,
    guildId: scope.guildId,
    conversationId: scope.conversationId,
    ...options.plan,
  });
  const db = new MemoryDatabase({
    affinity_config: options.config ?? [],
    affinity_scope_config: [scope],
    affinity_user_state: [],
    affinity_event: [],
    affinity_random_plan: [plan],
    affinity_open_thread: [],
    affinity_random_memory: options.randomMemories ?? [],
    affinity_audit: [],
    chatluna_conversation: options.includeConversation === false || !scope.conversationId
      ? []
      : options.conversations ?? [createConversation(scope.conversationId)],
    chatluna_message: options.messages ?? [],
  });
  const bot = {
    selfId: 'bot-1',
    platform: 'onebot',
    sendMessage: vi.fn(async () => undefined),
  };
  const chat = options.chat ?? vi.fn(async () => options.chatResponse ?? ({
    content: JSON.stringify({
      decision: 'reply',
      outbound_messages: [{ type: 'message', content: RANDOM_MESSAGE }],
    }),
    additional_kwargs: {},
  }));
  const contextManager = {
    inject: vi.fn(),
  };
  const chatluna = {
    chat,
    contextManager,
  };
  const service = new AffinityService(
    db,
    () => [bot],
    () => 0.5,
    () => chatluna as any,
    options.proactiveVoiceRuntime ?? createAffinityTestVoiceRuntime,
  );
  return { db, service, bot, chatluna, chat, contextManager };
}

function parseAuditDetail(row: Row | undefined): Record<string, unknown> {
  return JSON.parse(String(row?.detail ?? '{}')) as Record<string, unknown>;
}

describe('affinity service settings', () => {
  it('uses defaults only when stored config rows are absent', async () => {
    const { service } = createHarness({ config: [] });

    await expect(service.getSettings()).resolves.toEqual(expect.objectContaining({
      enabled: true,
      proactiveEnabled: true,
      randomWindowStartHour: 8,
      randomWindowEndHour: 22,
      randomCountWeights: [0.25, 0.6, 0.1, 0.05],
      enabledDirections: ['local_thread', 'daily_greeting', 'music_rehearsal', 'contest_discussion', 'computer_knowledge', 'relationship_scene'],
      webSourceEnabled: false,
      analysisModel: expect.objectContaining({
        baseUrl: '',
        apiKey: '',
        model: '',
        requestMode: 'chat_completions',
        structuredOutputProtocol: 'chat_reply_v1',
        timeoutMs: 5000,
      }),
    }));
  });

  it.each([
    {
      key: 'enabled',
      value: 'yes',
      message: 'affinity_config.enabled must be "true" or "false".',
    },
    {
      key: 'randomWindowStartHour',
      value: 'early',
      message: 'affinity_config.randomWindowStartHour must be a finite number.',
    },
    {
      key: 'randomWindowEndHour',
      value: '25',
      message: 'affinity_config.randomWindowEndHour must be between 1 and 24.',
    },
    {
      key: 'randomCountWeights',
      value: '[0.2,',
      message: 'affinity_config.randomCountWeights must contain valid JSON.',
    },
    {
      key: 'randomCountWeights',
      value: JSON.stringify([0.25, 0.6, 0.1]),
      message: 'affinity_config.randomCountWeights must be an array of four numbers.',
    },
    {
      key: 'randomCountWeights',
      value: JSON.stringify([0.25, 0.6, 0.1, 2]),
      message: 'affinity_config.randomCountWeights[3] must be between 0 and 1.',
    },
    {
      key: 'enabledDirections',
      value: JSON.stringify(['local_thread', 'unknown_direction']),
      message: 'affinity_config.enabledDirections[1] is invalid.',
    },
    {
      key: 'analysisModel',
      value: JSON.stringify({ baseUrl: 1 }),
      message: 'affinity_config.analysisModel.baseUrl must be a string.',
    },
    {
      key: 'analysisModel',
      value: JSON.stringify({
        baseUrl: '',
        apiKey: '',
        model: '',
        requestMode: 'legacy_chat',
        structuredOutputProtocol: 'chat_reply_v1',
        timeoutMs: 5000,
      }),
      message: 'affinity_config.analysisModel.requestMode must be chat_completions or responses.',
    },
  ])('rejects corrupted persisted affinity config row $key=$value', async ({ key, value, message }) => {
    const { service } = createHarness({
      config: [{
        id: 1,
        key,
        value,
        updatedAt: NOW,
      }],
    });

    await expect(service.getSettings()).rejects.toThrow(message);
  });
});

describe('affinity service panel view', () => {
  it('builds an initial panel for a new user without writing relationship state or events', async () => {
    const { db, service } = createHarness();
    db.tables.affinity_user_state = [];
    db.tables.affinity_event = [];
    const session = {
      platform: 'onebot',
      userId: 'new-user',
      bot: { selfId: 'bot-1' },
    } as any;

    const view = await service.buildPanelView(session, NOW);

    expect(view.userKey).toBe('onebot:new-user');
    expect(view.stage).toBe('stranger');
    expect(view.recentEvents[0]).toEqual(expect.objectContaining({
      title: '尚未留下有效变化',
    }));
    expect(db.tables.affinity_user_state).toHaveLength(0);
    expect(db.tables.affinity_event).toHaveLength(0);
  });

  it('rejects sessions without a platform instead of creating unknown relationship keys', async () => {
    const { db, service } = createHarness();
    const session = {
      platform: '',
      userId: 'new-user',
      bot: { selfId: 'bot-1' },
    } as any;

    await expect(service.buildPanelView(session)).rejects.toThrow('无法识别当前用户。');
    await expect(service.processIncomingSession({
      ...session,
      isDirect: false,
      guildId: '829573670',
      channelId: '829573670',
      messageId: 'msg-missing-platform',
      content: '这个算法是不是缩点以后再拓扑排序？',
      stripped: { content: '这个算法是不是缩点以后再拓扑排序？' },
    })).resolves.toBeNull();

    expect(db.tables.affinity_user_state.some((row) => String(row.userKey ?? '').startsWith('unknown:'))).toBe(false);
    expect(db.tables.affinity_event.some((row) => String(row.userKey ?? '').startsWith('unknown:'))).toBe(false);
  });

  it('writes a successful panel command into the matching ChatLuna history as an AI message', async () => {
    const { db, service } = createHarness();
    const userKey = 'onebot:u-1';
    db.tables.affinity_user_state.push({
      id: 10,
      characterId: CHARACTER_ID,
      userKey,
      platform: 'onebot',
      userId: 'u-1',
      displayName: 'Alice',
      trust: 43,
      familiarity: 58,
      comfort: 36,
      tension: 18,
      mood: 'focused',
      attentionHeat: 30,
      energy: 72,
      stage: 'remembered',
      flags: null,
      unlockedScenes: null,
      dailyState: null,
      weeklyState: null,
      lastSeenAt: NOW,
      lastUpdatedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.tables.affinity_event.push({
      id: 20,
      characterId: CHARACTER_ID,
      userKey,
      scopeKind: 'group',
      scopeId: '829573670',
      platform: 'onebot',
      botSelfId: 'bot-1',
      channelId: '829573670',
      guildId: '829573670',
      conversationId: 'conv-affinity',
      messageId: 'msg-event',
      eventType: 'contest_discussion',
      effectTier: 'progress',
      route: 'affinity_candidate',
      confidence: 0.9,
      reasonCode: 'accepted',
      deltaJson: JSON.stringify({ trust: 1, familiarity: 1 }),
      beforeJson: null,
      afterJson: null,
      evidence: '不应进入面板 history 的原文',
      createdAt: NOW - 12 * 60_000,
    } satisfies AffinityEventRecord);
    const session = {
      platform: 'onebot',
      userId: 'u-1',
      guildId: '829573670',
      channelId: '829573670',
      messageId: 'msg-panel-1',
      bot: { selfId: 'bot-1' },
    } as any;

    const view = await service.buildPanelView(session, NOW);
    const result = await service.syncPanelCommandToChatHistory(session, view);

    expect(result).toEqual({ synced: true, conversationId: 'conv-affinity' });
    const message = db.tables.chatluna_message.find((row) => row.id === 'affinity-panel-command:msg-panel-1');
    expect(message).toEqual(expect.objectContaining({
      conversationId: 'conv-affinity',
      parentId: null,
      role: 'ai',
    }));
    const content = await decodeStoredMessageText(message?.content);
    expect(content).toContain('发送了一张好感面板');
    expect(content).toContain('阶段「被记住的人」');
    expect(content).toContain(view.fixedLine);
    expect(content).not.toContain('不应进入面板 history 的原文');
    const additional = await decodeStoredMessageJson<Record<string, any>>(message?.additional_kwargs_binary);
    expect(additional?.qqbot_affinity_panel_command).toEqual(expect.objectContaining({
      version: 'v1',
      characterId: CHARACTER_ID,
      userKey,
      scopeKind: 'group',
      scopeId: '829573670',
      conversationId: 'conv-affinity',
      triggerMessageId: 'msg-panel-1',
      fixedLine: view.fixedLine,
      imageAlt: '好感面板',
    }));
    expect(db.tables.chatluna_conversation[0]).toEqual(expect.objectContaining({
      id: 'conv-affinity',
      latestMessageId: 'affinity-panel-command:msg-panel-1',
    }));
    const syncAudit = db.tables.affinity_audit.find((row) => row.eventType === 'panel_history_synced');
    expect(parseAuditDetail(syncAudit)).toEqual(expect.objectContaining({
      conversationId: 'conv-affinity',
      userKey,
      fixedLine: view.fixedLine,
    }));
  });

  it('records why a panel command cannot be synced when the current scope has no conversation id', async () => {
    const { db, service } = createHarness({
      scope: { conversationId: null },
      includeConversation: false,
    });
    const session = {
      platform: 'onebot',
      userId: 'u-1',
      guildId: '829573670',
      channelId: '829573670',
      messageId: 'msg-panel-missing-conv',
      bot: { selfId: 'bot-1' },
    } as any;
    const view = await service.buildPanelView(session, NOW);

    const result = await service.syncPanelCommandToChatHistory(session, view);

    expect(result).toEqual({ synced: false, reason: 'missing_conversation_id' });
    expect(db.tables.chatluna_message).toHaveLength(0);
    const skippedAudit = db.tables.affinity_audit.find((row) => row.eventType === 'panel_history_sync_skipped');
    expect(parseAuditDetail(skippedAudit)).toEqual(expect.objectContaining({
      reason: 'missing_conversation_id',
      fixedLine: view.fixedLine,
      triggerMessageId: 'msg-panel-missing-conv',
    }));
  });

  it('builds panel recent changes from abstract event records without evidence text', async () => {
    const { db, service } = createHarness();
    const userKey = 'onebot:u-1';
    db.tables.affinity_user_state.push({
      id: 10,
      characterId: CHARACTER_ID,
      userKey,
      platform: 'onebot',
      userId: 'u-1',
      displayName: 'Alice',
      trust: 43,
      familiarity: 58,
      comfort: 36,
      tension: 18,
      mood: 'focused',
      attentionHeat: 30,
      energy: 72,
      stage: 'remembered',
      flags: null,
      unlockedScenes: null,
      dailyState: null,
      weeklyState: null,
      lastSeenAt: NOW,
      lastUpdatedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.tables.affinity_event.push({
      id: 20,
      characterId: CHARACTER_ID,
      userKey,
      scopeKind: 'private',
      scopeId: 'u-1',
      platform: 'onebot',
      botSelfId: 'bot-1',
      channelId: 'u-1',
      guildId: null,
      conversationId: 'private-conv',
      messageId: 'msg-private',
      eventType: 'boundary_respect',
      effectTier: 'progress',
      route: 'affinity_candidate',
      confidence: 0.9,
      reasonCode: 'accepted',
      deltaJson: JSON.stringify({ comfort: 1, tension: -1 }),
      beforeJson: null,
      afterJson: null,
      evidence: '私聊原文不能出现在面板',
      createdAt: NOW - 12 * 60_000,
    } satisfies AffinityEventRecord);

    const view = await service.buildPanelView({
      platform: 'onebot',
      userId: 'u-1',
      bot: { selfId: 'bot-1' },
    } as any, NOW);

    expect(JSON.stringify(view)).not.toContain('私聊原文');
    expect(view.recentEvents[0]).toEqual(expect.objectContaining({
      time: '12分钟前',
      title: '尊重了她没有继续说的部分',
      effects: [
        { name: '安心', sign: '+' },
        { name: '紧张', sign: '-' },
      ],
    }));
  });
});

describe('affinity service random history sync', () => {
  afterEach(() => {
    clearPromptAssemblyTurn('conv-affinity');
  });

  it('sends a manual random plan for a non-whitelisted group through a temporary ChatLuna conversation', async () => {
    const db = new MemoryDatabase({
      affinity_config: [{
        id: 1,
        key: 'enabledDirections',
        value: JSON.stringify(['daily_greeting']),
        updatedAt: NOW,
      }],
      affinity_scope_config: [],
      affinity_user_state: [],
      affinity_event: [],
      affinity_random_plan: [],
      affinity_open_thread: [],
      affinity_random_memory: [],
      affinity_audit: [],
      chatluna_conversation: [createConversation('conv-manual')],
      chatluna_message: [],
    });
    const bot = {
      selfId: 'bot-1',
      platform: 'onebot',
      sendMessage: vi.fn(async () => undefined),
    };
    const chat = vi.fn(async () => ({
      content: JSON.stringify({
        decision: 'reply',
        outbound_messages: [{ type: 'message', content: RANDOM_MESSAGE }],
      }),
      additional_kwargs: {},
    }));
    const contextManager = {
      inject: vi.fn(),
    };
    const chatluna = {
      chat,
      contextManager,
    };
    const service = new AffinityService(
      db,
      () => [bot],
      () => 0.5,
      () => chatluna as any,
      createAffinityTestVoiceRuntime,
    );

    const result = await service.createManualRandomPlan({
      scopeKind: 'group',
      scopeId: '1012912433',
      delayMs: 5000,
      platform: 'onebot',
      botSelfId: 'bot-1',
      channelId: '1012912433',
      guildId: '1012912433',
      conversationId: 'conv-manual',
    }, NOW);

    expect(result).toEqual({
      ok: true,
      planId: expect.any(Number),
      scheduledAt: NOW + 5000,
      triggerKind: 'manual',
    });
    expect(db.tables.affinity_scope_config).toHaveLength(0);
    expect(db.tables.affinity_random_plan[0]).toEqual(expect.objectContaining({
      triggerKind: 'manual',
      scopeKind: 'group',
      scopeId: '1012912433',
      status: 'pending',
      scheduledAt: NOW + 5000,
      conversationId: 'conv-manual',
    }));
    await expect(service.getNextPendingRandomPlanAt(NOW)).resolves.toBe(NOW + 5000);

    await service.runDueRandomPlans(NOW + 5000);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(contextManager.inject).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect((bot.sendMessage as any).mock.calls[0]?.[0]).toBe('1012912433');
    expect(db.tables.affinity_random_plan[0]).toEqual(expect.objectContaining({
      status: 'sent',
      skipReason: null,
      messageText: RANDOM_MESSAGE,
    }));
    expect(db.tables.affinity_random_memory).toHaveLength(1);
    expect(db.tables.chatluna_message.some((row) => row.id === `affinity-random-plan:${result.planId}`)).toBe(true);
    const sentAudit = db.tables.affinity_audit.find((row) => row.eventType === 'random_plan_sent');
    expect(parseAuditDetail(sentAudit)).toEqual(expect.objectContaining({
      planId: result.planId,
      historySynced: true,
      conversationId: 'conv-manual',
    }));
  });

  it('lets manual plans bypass scope proactive off while scheduled plans stay blocked', async () => {
    const { db, service, bot, chat } = createHarness({
      scope: { enabled: 1, proactiveEnabled: 0 },
      config: [{
        id: 1,
        key: 'enabledDirections',
        value: JSON.stringify(['daily_greeting']),
        updatedAt: NOW,
      }],
    });

    const result = await service.createManualRandomPlan({
      scopeKind: 'group',
      scopeId: '829573670',
      delayMs: 0,
    }, NOW);

    await service.runDueRandomPlans(NOW);

    const scheduled = db.tables.affinity_random_plan.find((row) => row.id === 2);
    const manual = db.tables.affinity_random_plan.find((row) => row.id === result.planId);
    expect(scheduled).toEqual(expect.objectContaining({
      triggerKind: 'scheduled',
      status: 'skipped',
      skipReason: 'scope_disabled',
    }));
    expect(manual).toEqual(expect.objectContaining({
      triggerKind: 'manual',
      status: 'sent',
      messageText: RANDOM_MESSAGE,
    }));
    expect(chat).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('writes a sent proactive random event into the matching ChatLuna history as an AI message', async () => {
    const { db, service, bot, chat } = createHarness();

    await service.runDueRandomPlans(NOW);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(db.tables.affinity_random_plan[0].status).toBe('sent');
    expect(db.tables.affinity_random_plan[0].messageText).toBe(RANDOM_MESSAGE);
    expect(db.tables.affinity_random_memory).toHaveLength(1);
    expect(db.tables.affinity_random_memory[0]).toEqual(expect.objectContaining({
      sourcePlanId: 2,
      direction: 'daily_greeting',
      messageText: RANDOM_MESSAGE,
      contextSummary: '最近没有可用群聊上下文。',
    }));
    const message = db.tables.chatluna_message.find((row) => row.id === 'affinity-random-plan:2');
    expect(message).toEqual(expect.objectContaining({
      conversationId: 'conv-affinity',
      parentId: null,
      role: 'ai',
    }));
    const content = await decodeStoredMessageText(message?.content);
    expect(content).toBe(RANDOM_MESSAGE);
    expect(content).not.toContain('"decision"');
    expect(content).not.toContain('outbound_messages');
    expect(content).not.toContain('CHAT_REPLY_V1');
    const additional = await decodeStoredMessageJson<Record<string, any>>(message?.additional_kwargs_binary);
    expect(additional?.qqbot_affinity_random_event).toEqual(expect.objectContaining({
      version: 'v1',
      characterId: CHARACTER_ID,
      planId: 2,
      direction: 'daily_greeting',
      scopeKind: 'group',
      scopeId: '829573670',
      contextSeedSummary: '最近没有可用群聊上下文。',
      eventTypeHint: 'greeting_contextual',
    }));
    expect(db.tables.chatluna_conversation.some((row) => String(row.id).startsWith('affinity-proactive-'))).toBe(false);
    expect(db.tables.chatluna_conversation[0]).toEqual(expect.objectContaining({
      id: 'conv-affinity',
      latestMessageId: 'affinity-random-plan:2',
    }));

    const syncAudit = db.tables.affinity_audit.find((row) => row.eventType === 'random_history_synced');
    expect(parseAuditDetail(syncAudit)).toEqual(expect.objectContaining({
      planId: 2,
      direction: 'daily_greeting',
      conversationId: 'conv-affinity',
    }));
    const sentAudit = db.tables.affinity_audit.find((row) => row.eventType === 'random_plan_sent');
    expect(parseAuditDetail(sentAudit)).toEqual(expect.objectContaining({
      historySynced: true,
      conversationId: 'conv-affinity',
    }));
  });

  it('stores generated random material as structured ChatLuna history metadata', async () => {
    const { db, service } = createHarness({
      plan: { direction: 'computer_knowledge' },
    });

    await service.runDueRandomPlans(NOW);

    const historyMessage = db.tables.chatluna_message.find((row) => row.id === 'affinity-random-plan:2');
    const additional = await decodeStoredMessageJson<Record<string, any>>(historyMessage?.additional_kwargs_binary);
    const material = additional?.qqbot_affinity_random_event?.material;
    expect(material).toEqual(expect.objectContaining({
      kind: 'computer',
      title: expect.any(String),
      summary: expect.any(String),
      sourceLabel: null,
      sourceUrl: null,
      tags: expect.any(Array),
      promptHints: expect.any(Array),
    }));
    expect(material.title).not.toBe('');
    expect(material.summary).not.toBe('');
    expect(material.tags.length).toBeGreaterThan(0);
    expect(material.promptHints.length).toBeGreaterThan(0);
  });

  it('rejects invalid generated random material metadata instead of writing null material', async () => {
    const { db, service } = createHarness({
      plan: { direction: 'computer_knowledge' },
    });

    const result = await (service as any).syncRandomMessageToChatHistory({
      plan: db.tables.affinity_random_plan[0],
      scope: db.tables.affinity_scope_config[0],
      messageText: RANDOM_MESSAGE,
      generation: {
        shouldSend: true,
        message: RANDOM_MESSAGE,
        contextSeedSummary: 'seed',
        eventTypeHint: 'computer_knowledge',
        memorySummary: null,
        reason: 'chatluna_provider_reply',
        risk: 'low',
        skipReason: null,
      },
      materialJson: '{"kind":',
    });

    expect(result).toEqual({ synced: false, reason: 'write_failed', conversationId: 'conv-affinity' });
    expect(db.tables.chatluna_message.some((row) => row.id === 'affinity-random-plan:2')).toBe(false);
    const audit = db.tables.affinity_audit.find((row) => row.eventType === 'random_history_sync_skipped');
    expect(parseAuditDetail(audit)).toEqual(expect.objectContaining({
      reason: 'write_failed',
      conversationId: 'conv-affinity',
      error: 'affinity random materialJson must contain valid JSON.',
    }));
  });

  it('creates and cleans a temporary ChatLuna conversation for scheduled proactive generation', async () => {
    let tempConversationId = '';
    let dbRef: MemoryDatabase | null = null;
    const chat = vi.fn(async (_session: any, conversation: any) => {
      tempConversationId = conversation.id;
      expect(tempConversationId).toMatch(/^affinity-proactive-/u);
      const tempConversation = dbRef?.tables.chatluna_conversation.find((row) => row.id === tempConversationId);
      expect(tempConversation).toBeTruthy();
      expect(tempConversation).not.toHaveProperty('legacyRoomId');
      expect(tempConversation).not.toHaveProperty('legacyMeta');
      return {
        content: JSON.stringify({
          decision: 'reply',
          outbound_messages: [{ type: 'message', content: RANDOM_MESSAGE }],
        }),
        additional_kwargs: {},
      };
    });
    const { db, service, bot } = createHarness({ chat });
    dbRef = db;

    await service.runDueRandomPlans(NOW);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(db.tables.affinity_random_plan[0]).toEqual(expect.objectContaining({
      status: 'sent',
      skipReason: null,
      messageText: RANDOM_MESSAGE,
    }));
    expect(db.tables.chatluna_conversation.some((row) => row.id === tempConversationId)).toBe(false);
    expect(db.tables.chatluna_message.some((row) => row.conversationId === tempConversationId)).toBe(false);
  });

  it('keeps the random plan sent when ChatLuna history writing fails', async () => {
    const { db, service, bot } = createHarness();
    db.upsert = vi.fn(async (table: string, rows: Record<string, unknown>[], keys?: string[]) => {
      if (table === 'chatluna_message') throw new Error('history down');
      return MemoryDatabase.prototype.upsert.call(db, table, rows, keys);
    });

    await service.runDueRandomPlans(NOW);

    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(db.tables.affinity_random_plan[0].status).toBe('sent');
    expect(db.tables.affinity_random_plan[0].skipReason).toBeNull();
    const skippedAudit = db.tables.affinity_audit.find((row) => row.eventType === 'random_history_sync_skipped');
    expect(parseAuditDetail(skippedAudit)).toEqual(expect.objectContaining({
      reason: 'write_failed',
      error: 'history down',
      conversationId: 'conv-affinity',
    }));
    const sentAudit = db.tables.affinity_audit.find((row) => row.eventType === 'random_plan_sent');
    expect(parseAuditDetail(sentAudit)).toEqual(expect.objectContaining({
      historySynced: false,
      historySkipReason: 'write_failed',
    }));
  });

  it('requeues scheduled proactive plans when OneBot transport is temporarily unavailable', async () => {
    const { db, service, bot, chat } = createHarness();
    bot.sendMessage.mockRejectedValueOnce(new Error('bot._request is not a function'));

    await service.runDueRandomPlans(NOW);

    const retryAt = NOW + 10 * 60 * 1000;
    expect(chat).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(db.tables.affinity_random_plan[0]).toEqual(expect.objectContaining({
      status: 'pending',
      scheduledAt: retryAt,
      skipReason: 'transport_unavailable',
      messageText: null,
      sentAt: null,
    }));
    expect(db.tables.affinity_open_thread).toHaveLength(0);
    expect(db.tables.affinity_random_memory).toHaveLength(0);
    expect(db.tables.affinity_audit.some((row) => row.eventType === 'random_message_generation_skipped')).toBe(false);
    const requeueAudit = db.tables.affinity_audit.find((row) => row.eventType === 'random_plan_requeued');
    expect(parseAuditDetail(requeueAudit)).toEqual(expect.objectContaining({
      planId: 2,
      direction: 'daily_greeting',
      reason: 'transport_unavailable',
      retryAt,
      delayMs: 10 * 60 * 1000,
    }));
    await expect(service.getNextPendingRandomPlanAt(NOW)).resolves.toBe(retryAt);
  });

  it('skips a transport-unavailable scheduled plan only after the daily proactive window is exhausted', async () => {
    const exhaustedAt = getShanghaiDayStartMs(NOW) + 22 * 60 * 60 * 1000;
    const { db, service, bot } = createHarness({
      plan: {
        scheduledAt: exhaustedAt - 1,
        updatedAt: exhaustedAt - 1,
      },
    });
    bot.sendMessage.mockRejectedValueOnce(new Error('bot._request is not a function'));

    await service.runDueRandomPlans(exhaustedAt);

    expect(db.tables.affinity_random_plan[0]).toEqual(expect.objectContaining({
      status: 'skipped',
      skipReason: 'transport_unavailable',
      scheduledAt: exhaustedAt - 1,
    }));
    expect(db.tables.affinity_audit.some((row) => row.eventType === 'random_plan_requeued')).toBe(false);
    const skippedAudit = db.tables.affinity_audit.find((row) => row.eventType === 'random_message_generation_skipped');
    expect(parseAuditDetail(skippedAudit)).toEqual(expect.objectContaining({
      planId: 2,
      reason: 'transport_unavailable',
    }));
  });

  it('skips proactive generation instead of text fallback when the scope has no conversation id', async () => {
    const { db, service, bot } = createHarness({
      scope: { conversationId: null },
      plan: { conversationId: null },
      includeConversation: false,
    });

    await service.runDueRandomPlans(NOW);

    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(db.tables.affinity_random_plan[0]).toEqual(expect.objectContaining({
      status: 'skipped',
      skipReason: 'missing_conversation_id',
      messageText: null,
    }));
    expect(db.tables.chatluna_message).toHaveLength(0);
    const skippedAudit = db.tables.affinity_audit.find((row) => row.eventType === 'random_message_generation_skipped');
    expect(parseAuditDetail(skippedAudit)).toEqual(expect.objectContaining({
      reason: 'missing_conversation_id',
      planId: 2,
    }));
  });

  it('skips the proactive plan instead of falling back to a fixed sentence when generation declines', async () => {
    const { db, service, bot, chat } = createHarness({
      chatResponse: {
        content: JSON.stringify({
          decision: 'no_reply',
          outbound_messages: null,
        }),
        additional_kwargs: {},
      },
    });

    await service.runDueRandomPlans(NOW);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(db.tables.chatluna_message).toHaveLength(0);
    expect(db.tables.affinity_random_plan[0]).toEqual(expect.objectContaining({
      status: 'skipped',
      skipReason: 'provider_no_reply',
    }));
    expect(db.tables.affinity_random_memory).toHaveLength(0);
    const audit = db.tables.affinity_audit.find((row) => row.eventType === 'random_message_generation_skipped');
    expect(parseAuditDetail(audit)).toEqual(expect.objectContaining({
      planId: 2,
      reason: 'provider_no_reply',
    }));
  });

  it('passes timestamped local random memories and reply summaries into the proactive task prompt', async () => {
    const memoryCreatedAt = NOW - 24 * 60 * 60 * 1000;
    const replyAt = NOW - 10 * 60 * 1000;
    const { service, contextManager } = createHarness({
      randomMemories: [
        {
          id: 77,
          characterId: CHARACTER_ID,
          scopeKind: 'group',
          scopeId: '829573670',
          direction: 'contest_discussion',
          sourcePlanId: 55,
          messageText: '昨天那道缩点题，我还是有一点在意。',
          contextSummary: 'SCC 缩点讨论',
          materialJson: null,
          responseSummary: JSON.stringify([
            {
              at: replyAt,
              speaker: 'Alice',
              summary: '说可以先画出 SCC 缩点后的 DAG。<at id="2219854433" name="⁢小祥"/>',
            },
          ]),
          responderNames: JSON.stringify(['Alice', '⁢小祥']),
          createdAt: memoryCreatedAt,
          lastResponseAt: replyAt,
          expiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
          updatedAt: replyAt,
        },
      ],
    });

    await service.runDueRandomPlans(NOW);

    const injectedMessages = contextManager.inject.mock.calls[0]?.[0]?.value as Array<{ content: string }>;
    const injectedText = injectedMessages.map((message) => message.content).join('\n\n');
    expect(injectedText).toContain('昨天那道缩点题，我还是有一点在意。');
    expect(injectedText).toContain('2026-06-16 09:00:00 +08:00，1天前');
    expect(injectedText).toContain('2026-06-17 08:50:00 +08:00，10分钟前');
    expect(injectedText).toContain('Alice（2026-06-17 08:50:00 +08:00，10分钟前）：说可以先画出 SCC 缩点后的 DAG。 @小祥');
    expect(injectedText).toContain('回应者：Alice、小祥');
    expect(injectedText).not.toContain('<at id="2219854433"');
    expect(injectedText).not.toContain('⁢');
    expect(injectedText).not.toContain(String(memoryCreatedAt));
    expect(injectedText).not.toContain(String(replyAt));
  });

  it('rejects corrupted random memory response summaries before proactive prompt generation', async () => {
    const { service, contextManager } = createHarness({
      randomMemories: [
        {
          id: 78,
          characterId: CHARACTER_ID,
          scopeKind: 'group',
          scopeId: '829573670',
          direction: 'contest_discussion',
          sourcePlanId: 55,
          messageText: '昨天那道缩点题，我还是有一点在意。',
          contextSummary: 'SCC 缩点讨论',
          materialJson: null,
          responseSummary: '{"broken":',
          responderNames: JSON.stringify([]),
          createdAt: NOW - 24 * 60 * 60 * 1000,
          lastResponseAt: NOW - 10 * 60 * 1000,
          expiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
          updatedAt: NOW - 10 * 60 * 1000,
        },
      ],
    });

    await expect(service.runDueRandomPlans(NOW)).rejects.toThrow('affinity_random_memory.responseSummary must contain valid JSON.');
    expect(contextManager.inject).not.toHaveBeenCalled();
  });

  it('uses real ChatLuna history context through the main reply chain to generate a declarative proactive continuation', async () => {
    const declarativeMessage = '前面那道缩点题，我想了一下。只要缩完以后还能绕回去，那几个点原本就应该属于同一个强连通分量。';
    const { db, service, bot, chat, contextManager } = createHarness({
      plan: { direction: 'local_thread' },
      chatResponse: {
        content: JSON.stringify({
          decision: 'reply',
          outbound_messages: [
            {
              type: 'message',
              content: declarativeMessage,
            },
          ],
        }),
        additional_kwargs: {},
      },
      conversations: [{ ...createConversation('conv-affinity'), latestMessageId: 'msg-bob', updatedAt: new Date(NOW) }],
      messages: [
        {
          id: 'msg-alice',
          role: 'human',
          conversationId: 'conv-affinity',
          parentId: null,
          content: encodeStoredMessageContent('[speaker_id=u1 speaker_name="Alice"] SCC 缩点以后为什么一定没有环？'),
        },
        {
          id: 'msg-bob',
          role: 'human',
          conversationId: 'conv-affinity',
          parentId: 'msg-alice',
          content: encodeStoredMessageContent('[speaker_id=u2 speaker_name="Bob"] 因为有环会被缩在一个点里吧，但我不确定。'),
        },
      ],
    });

    await service.runDueRandomPlans(NOW);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(contextManager.inject).toHaveBeenCalledWith(expect.objectContaining({
      name: 'qqbot_affinity_proactive_prompt_envelope',
      stage: 'after_scratchpad',
      value: expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('Affinity Proactive Task'),
          additional_kwargs: expect.objectContaining({
            qqbot_context: expect.objectContaining({
              source: 'qqbot_affinity_proactive_task',
            }),
          }),
        }),
      ]),
    }));
    const injectedMessages = contextManager.inject.mock.calls[0]?.[0]?.value as Array<{ content: string }>;
    const injectedText = injectedMessages.map((message) => message.content).join('\n\n');
    expect(injectedText).toContain('# 主动发言任务：承接未完话题');
    expect(injectedText).toContain('Alice');
    expect(injectedText).toContain('SCC 缩点以后为什么一定没有环？');
    expect(injectedText).toContain('Bob');
    expect(injectedText).toContain('因为有环会被缩在一个点里吧，但我不确定。');
    expect(injectedText).not.toContain('你是丰川祥子');
    expect(injectedText).not.toContain('"shouldSend"');
    expect(declarativeMessage).not.toMatch(/[?？]/u);
    expect(bot.sendMessage).toHaveBeenCalledWith(
      '829573670',
      expect.objectContaining({ attrs: { content: declarativeMessage } }),
      undefined,
      expect.objectContaining({
        session: expect.objectContaining({
          guildId: '829573670',
          channelId: '829573670',
        }),
      }),
    );
    expect(db.tables.affinity_random_plan[0]).toEqual(expect.objectContaining({
      status: 'sent',
      messageText: declarativeMessage,
    }));
    expect(db.tables.affinity_open_thread[0]).toEqual(expect.objectContaining({
      title: 'random:local_thread',
      summary: declarativeMessage,
    }));
    const historyMessage = db.tables.chatluna_message.find((row) => row.id === 'affinity-random-plan:2');
    expect(historyMessage).toEqual(expect.objectContaining({
      conversationId: 'conv-affinity',
      parentId: 'msg-bob',
      role: 'ai',
    }));
    const historyText = await decodeStoredMessageText(historyMessage?.content);
    expect(historyText).toBe(declarativeMessage);
    expect(historyText).not.toContain('"decision"');
    expect(historyText).not.toContain('outbound_messages');
    expect(historyText).not.toContain('CHAT_REPLY_V1');
    const additional = await decodeStoredMessageJson<Record<string, any>>(historyMessage?.additional_kwargs_binary);
    expect(additional?.qqbot_affinity_random_event).toEqual(expect.objectContaining({
      visibleText: declarativeMessage,
      eventTypeHint: 'answer_random_prompt',
    }));
  });

  it('strips speaker tags without names before injecting proactive history context', async () => {
    const { service, contextManager } = createHarness({
      plan: { direction: 'local_thread' },
      chatResponse: {
        content: JSON.stringify({
          decision: 'no_reply',
          outbound_messages: null,
        }),
        additional_kwargs: {},
      },
      conversations: [{ ...createConversation('conv-affinity'), latestMessageId: 'msg-legacy-tag', updatedAt: new Date(NOW) }],
      messages: [
        {
          id: 'msg-legacy-tag',
          role: 'human',
          conversationId: 'conv-affinity',
          parentId: null,
          content: encodeStoredMessageContent('[speaker_id=u1] 我去吃饭了，晚点再说。'),
        },
      ],
    });

    await service.runDueRandomPlans(NOW);

    const injectedMessages = contextManager.inject.mock.calls[0]?.[0]?.value as Array<{ content: string }>;
    const injectedText = injectedMessages.map((message) => message.content).join('\n\n');
    expect(injectedText).toContain('我去吃饭了，晚点再说。');
    expect(injectedText).not.toContain('[speaker_id=u1]');
  });

  it('marks a proactive plan failed when the explicit voice runtime provider is misconfigured', async () => {
    const { db, service, chat } = createHarness({
      proactiveVoiceRuntime: () => {
        throw new Error('QQ_VOICE_OUTPUT_LANGUAGE 未配置。');
      },
    });

    await service.runDueRandomPlans(NOW);

    expect(chat).not.toHaveBeenCalled();
    expect(db.tables.affinity_random_plan[0]).toEqual(expect.objectContaining({
      status: 'failed',
      skipReason: 'QQ_VOICE_OUTPUT_LANGUAGE 未配置。',
    }));
    const detail = parseAuditDetail(db.tables.affinity_audit.find((row) => row.eventType === 'random_message_generation_skipped'));
    expect(detail).toEqual(expect.objectContaining({
      planId: 2,
      direction: 'daily_greeting',
      reason: 'QQ_VOICE_OUTPUT_LANGUAGE 未配置。',
      status: 'failed',
    }));
  });

  it('skips a local_thread plan when the main reply chain returns no_reply', async () => {
    const { db, service, bot, chat } = createHarness({
      plan: { direction: 'local_thread' },
      chatResponse: {
        content: JSON.stringify({
          decision: 'no_reply',
          outbound_messages: null,
        }),
        additional_kwargs: {},
      },
      conversations: [{ ...createConversation('conv-affinity'), latestMessageId: 'msg-alice', updatedAt: new Date(NOW) }],
      messages: [
        {
          id: 'msg-alice',
          role: 'human',
          conversationId: 'conv-affinity',
          parentId: null,
          content: encodeStoredMessageContent('[speaker_id=u1 speaker_name="Alice"] 我去吃饭了，晚点再说。'),
        },
      ],
    });

    await service.runDueRandomPlans(NOW);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(db.tables.affinity_random_plan[0]).toEqual(expect.objectContaining({
      status: 'skipped',
      skipReason: 'provider_no_reply',
      messageText: null,
    }));
    expect(db.tables.affinity_open_thread).toHaveLength(0);
    expect(db.tables.affinity_random_memory).toHaveLength(0);
    const skipAudit = db.tables.affinity_audit.find((row) => row.eventType === 'random_message_generation_skipped');
    expect(parseAuditDetail(skipAudit)).toEqual(expect.objectContaining({
      direction: 'local_thread',
      reason: 'provider_no_reply',
    }));
  });

  it('records user replies to an open random event into local random memory', async () => {
    const { db, service } = createHarness();
    await service.runDueRandomPlans(NOW);
    db.tables.affinity_open_thread[0].expiresAt = Date.now() + 3_600_000;

    const result = await service.processIncomingSession({
      isDirect: false,
      platform: 'onebot',
      guildId: '829573670',
      channelId: '829573670',
      userId: 'u-1',
      messageId: 'reply-1',
      content: '这个算法是不是缩点以后再拓扑排序？<at id="2219854433" name="⁢小祥"/>',
      stripped: { content: '这个算法是不是缩点以后再拓扑排序？<at id="2219854433" name="⁢小祥"/>' },
      author: { nick: 'Alice' },
      bot: { selfId: 'bot-1' },
    } as any);

    expect(result?.analysis).toEqual(expect.objectContaining({
      route: 'random_event_reply',
      eventType: 'answer_random_prompt',
    }));

    const memory = db.tables.affinity_random_memory[0];
    expect(JSON.parse(memory.responderNames)).toContain('Alice');
    const responses = JSON.parse(memory.responseSummary);
    expect(responses[0]).toEqual(expect.objectContaining({
      at: expect.any(Number),
      speaker: 'Alice',
      summary: expect.stringContaining('缩点'),
    }));
    expect(responses[0].summary).toContain('@小祥');
    expect(responses[0].summary).not.toContain('<at');
    expect(responses[0].summary).not.toContain('⁢');
    expect(memory.lastResponseAt).toEqual(responses[0].at);
    const audit = db.tables.affinity_audit.find((row) => row.eventType === 'random_memory_updated');
    expect(parseAuditDetail(audit)).toEqual(expect.objectContaining({
      planId: 2,
      speaker: 'Alice',
      eventType: 'answer_random_prompt',
    }));
  });

  it('rejects corrupted random memory responder names before relationship writes', async () => {
    const { db, service } = createHarness();
    await service.runDueRandomPlans(NOW);
    db.tables.affinity_open_thread[0].expiresAt = Date.now() + 3_600_000;
    db.tables.affinity_random_memory[0].responderNames = '{"broken":';

    const session = {
      isDirect: false,
      platform: 'onebot',
      guildId: '829573670',
      channelId: '829573670',
      userId: 'u-1',
      messageId: 'reply-corrupt-memory',
      content: '这个算法是不是缩点以后再拓扑排序？',
      stripped: { content: '这个算法是不是缩点以后再拓扑排序？' },
      author: { nick: 'Alice' },
      bot: { selfId: 'bot-1' },
    } as any;

    await expect(service.processIncomingSession(session)).rejects.toThrow('affinity_random_memory.responderNames must contain valid JSON.');
    expect(db.tables.affinity_user_state).toHaveLength(0);
    expect(db.tables.affinity_event).toHaveLength(0);
    expect(db.tables.affinity_audit.some((row) => row.eventType === 'random_memory_updated')).toBe(false);
  });

  it('migrates stored random memory prompt text away from platform control tags', async () => {
    const { db, service } = createHarness({
      randomMemories: [
        {
          id: 88,
          characterId: CHARACTER_ID,
          scopeKind: 'group',
          scopeId: '829573670',
          direction: 'daily_greeting',
          sourcePlanId: 42,
          messageText: '前面那句话，我稍微补一句。',
          contextSummary: null,
          materialJson: null,
          responseSummary: JSON.stringify([
            {
              at: NOW - 1000,
              speaker: '⁢小祥',
              summary: '<at id="2219854433" name="⁢小祥"/> 这个可以继续看。',
            },
          ]),
          responderNames: JSON.stringify(['⁢小祥']),
          createdAt: NOW - 2000,
          lastResponseAt: NOW - 1000,
          expiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
          updatedAt: NOW - 1000,
        },
      ],
    });

    await expect(service.normalizeStoredRandomMemoryPromptText()).resolves.toBe(1);

    const memory = db.tables.affinity_random_memory[0];
    expect(JSON.parse(memory.responseSummary)).toEqual([
      {
        at: NOW - 1000,
        speaker: '小祥',
        summary: '@小祥 这个可以继续看。',
      },
    ]);
    expect(JSON.parse(memory.responderNames)).toEqual(['小祥']);
    expect(memory.updatedAt).toEqual(expect.any(Number));
  });

  it('injects active proactive thread context into the next ChatLuna turn after a user reply', async () => {
    const { db, service } = createHarness();
    await service.runDueRandomPlans(NOW);
    db.tables.affinity_open_thread[0].expiresAt = Date.now() + 3_600_000;
    const session = {
      isDirect: false,
      platform: 'onebot',
      guildId: '829573670',
      channelId: '829573670',
      userId: 'u-1',
      messageId: 'reply-1',
      content: '这个算法是不是缩点以后再拓扑排序？',
      stripped: { content: '这个算法是不是缩点以后再拓扑排序？' },
      author: { nick: 'Alice' },
      bot: { selfId: 'bot-1' },
    } as any;
    await service.processIncomingSession(session);

    beginPromptAssemblyTurn('conv-affinity');
    await service.injectPromptForTurn('conv-affinity', session);
    const envelope = consumePromptEnvelope('conv-affinity');
    const content = envelope?.fragments
      .find((fragment) => fragment.source === 'qqbot_affinity')
      ?.content ?? '';

    expect(content).toContain('activeProactiveThreads');
    expect(content).toContain(RANDOM_MESSAGE);
    expect(content).toContain('"direction": "daily_greeting"');
    expect(content).toContain('contextSummary');
    expect(content).toContain('eventTypeHint');
    expect(content).toContain('answer_random_prompt');
    expect(content).not.toContain('activeRandomThreads');
    expect(content).not.toContain('random:daily_greeting');
    expect(content).not.toContain('"planId"');
    expect(content).not.toContain('chatluna_provider_reply');
    expect(content).not.toContain('"reasonCode"');
    expect(content).toContain('eventResult');
  });

  it('rejects corrupted random thread payload before relationship writes or prompt injection', async () => {
    const { db, service } = createHarness();
    db.tables.affinity_open_thread.push({
      id: 77,
      characterId: CHARACTER_ID,
      scopeKind: 'group',
      scopeId: '829573670',
      userKey: null,
      threadType: 'random:daily_greeting',
      title: 'random:daily_greeting',
      summary: RANDOM_MESSAGE,
      status: 'open',
      payloadJson: '{"planId":',
      expiresAt: Date.now() + 3_600_000,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const session = {
      isDirect: false,
      platform: 'onebot',
      guildId: '829573670',
      channelId: '829573670',
      userId: 'u-1',
      messageId: 'reply-corrupt-thread',
      content: '这个算法是不是缩点以后再拓扑排序？',
      stripped: { content: '这个算法是不是缩点以后再拓扑排序？' },
      author: { nick: 'Alice' },
      bot: { selfId: 'bot-1' },
    } as any;

    await expect(service.processIncomingSession(session)).rejects.toThrow('affinity_open_thread.payloadJson must contain valid JSON.');
    expect(db.tables.affinity_user_state).toHaveLength(0);
    expect(db.tables.affinity_event).toHaveLength(0);

    beginPromptAssemblyTurn('conv-affinity');
    await expect(service.injectPromptForTurn('conv-affinity', session)).rejects.toThrow('affinity_open_thread.payloadJson must contain valid JSON.');
    expect(consumePromptEnvelope('conv-affinity')).toBeNull();
  });
});
