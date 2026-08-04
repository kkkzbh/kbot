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
    withConversationLock: <T>(
      conversationId: string,
      callback: () => Promise<T>,
    ) => Promise<T>;
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
  lockMode: 'acquire' | 'already_held';
  maxMessagesCount?: number;
}): Promise<ChatLunaHistoryWriter> {
  const { KoishiChatMessageHistory } = ChatLunaHistory;
  const conversationRuntime = args.chatluna.conversationRuntime;
  const clearConversationCache = conversationRuntime?.clearConversationCache;
  if (typeof clearConversationCache !== 'function') {
    throw new Error('ChatLuna history writer requires conversationRuntime.clearConversationCache.');
  }
  const withConversationLock = conversationRuntime?.withConversationLock;
  if (typeof withConversationLock !== 'function') {
    throw new Error('ChatLuna history writer requires conversationRuntime.withConversationLock.');
  }

  const addMessagesInsideLock = async (messages: BaseMessage[]): Promise<void> => {
    const [conversation] = await args.database.get(
      'chatluna_conversation',
      { id: args.conversationId },
      ['id'],
    );
    if (!conversation?.id) {
      throw new Error(`ChatLuna history conversation is unavailable: ${args.conversationId}`);
    }
    const pendingMessages: BaseMessage[] = [];
    for (const message of messages) {
      const chatlunaMetadata = message.response_metadata?.chatluna;
      const recordId = chatlunaMetadata && typeof chatlunaMetadata === 'object'
        && 'recordId' in chatlunaMetadata
        ? String((chatlunaMetadata as { recordId?: unknown }).recordId ?? '').trim()
        : '';
      if (recordId) {
        const [existing] = await args.database.get('chatluna_message', { id: recordId }, ['id']);
        if (existing?.id) continue;
      }
      pendingMessages.push(message);
    }
    if (!pendingMessages.length) return;
    const history = new KoishiChatMessageHistory(
      { database: args.database, logger: args.logger },
      args.conversationId,
      args.maxMessagesCount ?? 10_000,
      args.chatluna,
    );
    await history.addMessages(pendingMessages);
    await clearConversationCache.call(conversationRuntime, args.conversationId);
  };

  return {
    addMessages: async (messages) => {
      if (args.lockMode === 'already_held') {
        await addMessagesInsideLock(messages);
        return;
      }
      await withConversationLock.call(conversationRuntime, args.conversationId, () => (
        addMessagesInsideLock(messages)
      ));
    },
  };
}
