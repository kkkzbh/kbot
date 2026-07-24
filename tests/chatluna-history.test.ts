import { describe, expect, it, vi } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { createChatLunaHistoryWriter } from '../src/plugins/shared/chatluna-history.js';

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
      chatluna: {
        conversationRuntime: { clearConversationCache },
      },
    });

    expect(writer.addMessages).toBeTypeOf('function');
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
      chatluna: {
        config: {
          defaultModel: 'openai/auto',
          defaultPreset: 'sakiko',
          defaultChatMode: 'plugin',
        },
        conversationRuntime: { clearConversationCache },
      },
    });

    await writer.addMessages([new HumanMessage('注入一条实时历史')]);

    expect(messages).toHaveLength(1);
    expect(conversations[0]?.latestMessageId).toBe(messages[0]?.id);
    expect(clearConversationCache).toHaveBeenCalledOnce();
    expect(clearConversationCache).toHaveBeenCalledWith('conv-cache-invalidation');
  });
});
