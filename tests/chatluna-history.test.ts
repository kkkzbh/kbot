import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { createChatLunaHistoryWriter } from '../src/plugins/shared/chatluna-history.js';
import { resolveChatlunaCoreRoot } from './helpers/chatluna-paths.js';

const require = createRequire(resolve(process.cwd(), 'tests/chatluna-history.test.ts'));

describe('ChatLuna history writer runtime boundary', () => {
  it('loads ChatLuna message history through the runtime CommonJS export', async () => {
    const clearConversationCache = vi.fn(async () => true);
    const writer = await createChatLunaHistoryWriter({
      database: {
        get: vi.fn(),
        create: vi.fn(),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
      logger: {
        warn: vi.fn(),
      },
      conversationId: 'conv-runtime-boundary',
      lockMode: 'acquire',
      chatluna: {
        conversationRuntime: {
          clearConversationCache,
          withConversationLock: async (_conversationId, callback) => callback(),
        },
      },
    });

    expect(writer.addMessages).toBeTypeOf('function');
  });

  it('loads ChatLuna prompt modules through CommonJS package exports', () => {
    const promptModule = require('koishi-plugin-chatluna/llm-core/prompt');
    const chainPromptModule = require('koishi-plugin-chatluna/llm-core/chain/prompt');

    expect(promptModule.ChatLunaContextManagerService).toBeTypeOf('function');
    expect(chainPromptModule.ChatLunaChatPrompt).toBeTypeOf('function');
  });

  it('keeps the context trace registry in one CommonJS export', () => {
    const coreRoot = resolveChatlunaCoreRoot();
    const modelArtifact = readFileSync(join(coreRoot, 'lib/llm-core/platform/model.cjs'), 'utf8');
    const chainPromptArtifact = readFileSync(join(coreRoot, 'lib/llm-core/chain/prompt.cjs'), 'utf8');

    expect(modelArtifact).toContain('require("koishi-plugin-chatluna/context-trace")');
    expect(chainPromptArtifact).toContain('require("koishi-plugin-chatluna/context-trace")');
    expect(modelArtifact).not.toContain('function takeContextTrace');
    expect(chainPromptArtifact).not.toContain('function registerContextTrace');
  });

  it('invalidates the cached ChatInterface after direct history writes', async () => {
    const conversations: Array<Record<string, unknown>> = [{
      id: 'conv-cache-invalidation',
      latestMessageId: null,
      updatedAt: new Date(0),
      additional_kwargs: null,
    }];
    const messages: Array<Record<string, unknown>> = [];
    const database = {
      get: vi.fn(async (table: string, query: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        return rows.filter((row) => Object.entries(query).every(([key, value]) => row[key] === value));
      }),
      create: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === 'chatluna_conversation') conversations.push({ ...row });
      }),
      remove: vi.fn(async () => undefined),
      upsert: vi.fn(async (table: string, rows: Array<Record<string, unknown>>) => {
        const target = table === 'chatluna_conversation' ? conversations : messages;
        for (const row of rows) {
          const index = target.findIndex((item) => item.id === row.id);
          if (index >= 0) {
            target[index] = { ...target[index], ...row };
          } else {
            target.push({ ...row });
          }
        }
      }),
    };
    const clearConversationCache = vi.fn(async () => true);
    const writer = await createChatLunaHistoryWriter({
      database,
      logger: { warn: vi.fn() },
      conversationId: 'conv-cache-invalidation',
      lockMode: 'acquire',
      chatluna: {
        config: {
          defaultModel: 'openai/auto',
          defaultPreset: 'sakiko',
          defaultChatMode: 'plugin',
        },
        conversationRuntime: {
          clearConversationCache,
          withConversationLock: async (_conversationId, callback) => callback(),
        },
      },
    });

    await writer.addMessages([new HumanMessage('注入一条实时历史')]);

    expect(messages).toHaveLength(1);
    expect(conversations[0]?.latestMessageId).toBe(messages[0]?.id);
    expect(clearConversationCache).toHaveBeenCalledOnce();
    expect(clearConversationCache).toHaveBeenCalledWith('conv-cache-invalidation');
  });

  it('serializes reconciliation with live chat and preserves one latest-message parent chain', async () => {
    const conversations: Array<Record<string, any>> = [{
      id: 'conv-serialized-history',
      latestMessageId: null,
      updatedAt: new Date(0),
      additional_kwargs: null,
    }];
    const messages: Array<Record<string, any>> = [];
    const database = {
      get: vi.fn(async (table: string, query: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        return rows.filter((row) => Object.entries(query).every(([key, value]) => row[key] === value));
      }),
      create: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      upsert: vi.fn(async (table: string, rows: Array<Record<string, unknown>>) => {
        const target = table === 'chatluna_conversation' ? conversations : messages;
        for (const row of rows) {
          const index = target.findIndex((item) => item.id === row.id);
          if (index >= 0) target[index] = { ...target[index], ...row };
          else target.push({ ...row });
        }
      }),
    };
    let tail = Promise.resolve();
    const withConversationLock = async <T>(_conversationId: string, callback: () => Promise<T>): Promise<T> => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback();
      } finally {
        release();
      }
    };
    let releaseLiveWrite!: () => void;
    const liveWriteGate = new Promise<void>((resolve) => {
      releaseLiveWrite = resolve;
    });
    let notifyLiveLock!: () => void;
    const liveLockEntered = new Promise<void>((resolve) => {
      notifyLiveLock = resolve;
    });
    const clearConversationCache = vi.fn(async () => true);
    const chatluna = {
      config: {
        defaultModel: 'openai/auto',
        defaultPreset: 'sakiko',
        defaultChatMode: 'plugin',
      },
      conversationRuntime: {
        clearConversationCache,
        withConversationLock,
      },
    };
    const writer = await createChatLunaHistoryWriter({
      database,
      logger: { warn: vi.fn() },
      conversationId: 'conv-serialized-history',
      lockMode: 'acquire',
      chatluna,
    });

    const liveWrite = withConversationLock('conv-serialized-history', async () => {
      notifyLiveLock();
      await liveWriteGate;
      messages.push({
        id: 'live-message',
        conversationId: 'conv-serialized-history',
        parentId: null,
        role: 'ai',
      });
      conversations[0]!.latestMessageId = 'live-message';
    });
    await liveLockEntered;
    const reconciliation = writer.addMessages([
      new AIMessage({
        id: 'reconciliation-message',
        content: '已确认送达的恢复消息',
        response_metadata: {
          chatluna: { recordId: 'reconciliation-message' },
        },
      }),
    ]);
    await Promise.resolve();

    expect(database.upsert).not.toHaveBeenCalled();
    expect(clearConversationCache).not.toHaveBeenCalled();

    releaseLiveWrite();
    await Promise.all([liveWrite, reconciliation]);

    const recovered = messages.find((row) => row.id === 'reconciliation-message');
    expect(recovered).toEqual(expect.objectContaining({
      conversationId: 'conv-serialized-history',
      parentId: 'live-message',
      role: 'ai',
    }));
    expect(conversations[0]?.latestMessageId).toBe('reconciliation-message');
    expect(messages.filter((row) => row.parentId == null)).toHaveLength(1);
    expect(clearConversationCache).toHaveBeenCalledOnce();
  });

  it('deduplicates deterministic reconciliation records inside the conversation lock', async () => {
    const conversations: Array<Record<string, any>> = [{
      id: 'conv-idempotent-history',
      latestMessageId: null,
      updatedAt: new Date(0),
      additional_kwargs: null,
    }];
    const messages: Array<Record<string, any>> = [];
    const database = {
      get: vi.fn(async (table: string, query: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        return rows.filter((row) => Object.entries(query).every(([key, value]) => row[key] === value));
      }),
      create: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      upsert: vi.fn(async (table: string, rows: Array<Record<string, unknown>>) => {
        const target = table === 'chatluna_conversation' ? conversations : messages;
        for (const row of rows) {
          const index = target.findIndex((item) => item.id === row.id);
          if (index >= 0) target[index] = { ...target[index], ...row };
          else target.push({ ...row });
        }
      }),
    };
    const clearConversationCache = vi.fn(async () => true);
    const writer = await createChatLunaHistoryWriter({
      database,
      logger: { warn: vi.fn() },
      conversationId: 'conv-idempotent-history',
      lockMode: 'acquire',
      chatluna: {
        config: {
          defaultModel: 'openai/auto',
          defaultPreset: 'sakiko',
          defaultChatMode: 'plugin',
        },
        conversationRuntime: {
          clearConversationCache,
          withConversationLock: async (_conversationId, callback) => callback(),
        },
      },
    });
    const reconciliationMessage = new AIMessage({
      id: 'fixed-reconciliation-id',
      content: '只应出现一次',
      response_metadata: {
        chatluna: { recordId: 'fixed-reconciliation-id' },
      },
    });

    await writer.addMessages([reconciliationMessage]);
    await writer.addMessages([reconciliationMessage]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({
      id: 'fixed-reconciliation-id',
      parentId: null,
    }));
    expect(conversations[0]?.latestMessageId).toBe('fixed-reconciliation-id');
    expect(clearConversationCache).toHaveBeenCalledOnce();
  });
});
