import type { BaseMessage } from '@langchain/core/messages';
import type { Logger } from 'koishi';

export type ChatLunaHistoryDatabaseLike = {
  get: (table: string, query: Record<string, unknown>, fields?: string[]) => Promise<Array<Record<string, unknown>>>;
  create: (table: string, row: Record<string, unknown>) => Promise<unknown>;
  remove: (table: string, query: Record<string, unknown>) => Promise<unknown>;
  upsert: (table: string, rows: Record<string, unknown>[], keys?: string[]) => Promise<unknown>;
};

export type ChatLunaHistoryServiceLike = {
  config?: {
    defaultModel?: unknown;
    defaultPreset?: unknown;
    defaultChatMode?: unknown;
  };
  conversationRuntime?: {
    clearConversationCache: (conversationId: string) => Promise<unknown>;
  };
};

export type ChatLunaHistoryWriter = {
  addMessages: (messages: BaseMessage[]) => Promise<void>;
};

type ChatLunaHistoryContextLike = {
  database: ChatLunaHistoryDatabaseLike;
  logger: Pick<Logger, 'warn'>;
};

type ChatLunaHistoryModule = {
  KoishiChatMessageHistory: new (
    ctx: ChatLunaHistoryContextLike,
    conversationId: string,
    maxMessagesCount: number,
    chatluna: ChatLunaHistoryServiceLike,
  ) => ChatLunaHistoryWriter;
};

const ChatLunaHistory = require('koishi-plugin-chatluna/llm-core/memory/message') as ChatLunaHistoryModule;

export async function createChatLunaHistoryWriter(args: {
  database: ChatLunaHistoryDatabaseLike;
  logger: Pick<Logger, 'warn'>;
  conversationId: string;
  chatluna: ChatLunaHistoryServiceLike;
  maxMessagesCount?: number;
}): Promise<ChatLunaHistoryWriter> {
  const { KoishiChatMessageHistory } = ChatLunaHistory;
  const clearConversationCache = args.chatluna.conversationRuntime?.clearConversationCache;
  if (typeof clearConversationCache !== 'function') {
    throw new Error('ChatLuna history writer requires conversationRuntime.clearConversationCache.');
  }
  const history = new KoishiChatMessageHistory(
    { database: args.database, logger: args.logger },
    args.conversationId,
    args.maxMessagesCount ?? 10_000,
    args.chatluna,
  );

  return {
    addMessages: async (messages) => {
      await history.addMessages(messages);
      await clearConversationCache.call(args.chatluna.conversationRuntime, args.conversationId);
    },
  };
}
