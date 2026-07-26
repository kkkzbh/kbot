import type { ResolvedModelTarget } from '../model-config/index.js';

export type MainChatRoomModelLike = {
  model?: string;
  conversationId?: string;
  [key: string]: unknown;
};

export type MainChatRoomModelSyncResult = {
  changed: boolean;
  originalModel: string | null;
  revision: number;
  canonicalModel: string;
  transportModel: string;
  connectionId: string;
  modelId: string;
  adapter: string;
  requestMode: string;
  outputProtocol: string;
};

function trimOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

export async function syncRoomModelToMainBinding(args: {
  room: MainChatRoomModelLike;
  target: ResolvedModelTarget;
  revision: number;
  clearCache?: (room: MainChatRoomModelLike) => Promise<unknown>;
  updateConversationModel?: (
    conversationId: string,
    model: string,
  ) => Promise<unknown>;
}): Promise<MainChatRoomModelSyncResult> {
  const originalModel = trimOptionalText(args.room.model);
  const changed = args.target.canonicalModel !== originalModel;

  if (changed) {
    const conversationId = trimOptionalText(args.room.conversationId);
    if (!conversationId) {
      throw new Error(
        'conversationId is required before syncing the active chat model.',
      );
    }
    if (args.clearCache) {
      await args.clearCache(args.room);
    }
    if (args.updateConversationModel) {
      await args.updateConversationModel(
        conversationId,
        args.target.canonicalModel,
      );
    }
    args.room.model = args.target.canonicalModel;
  }

  const requestMode = args.target.model.requestMode;
  const outputProtocol = args.target.model.structuredOutputProtocol;
  if (!requestMode || !outputProtocol) {
    throw new Error(
      `main.chat model ${args.target.model.id} has no request/output contract.`,
    );
  }

  return {
    changed,
    originalModel,
    revision: args.revision,
    canonicalModel: args.target.canonicalModel,
    transportModel: args.target.model.transportModel,
    connectionId: args.target.connection.id,
    modelId: args.target.model.id,
    adapter: args.target.connection.adapter,
    requestMode,
    outputProtocol,
  };
}
