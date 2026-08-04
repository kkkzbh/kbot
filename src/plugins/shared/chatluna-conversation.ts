export type QqbotChatLunaRoomLike = {
  conversationId?: string;
  model?: string;
  preset?: string;
  chatMode?: string;
  [key: string]: unknown;
};

type ChatLunaConversationRecordLike = {
  id?: unknown;
  model?: unknown;
  preset?: unknown;
  chatMode?: unknown;
};

type ChatLunaConversationResolutionLike = {
  mode?: unknown;
  conversationId?: unknown;
  conversation?: ChatLunaConversationRecordLike | null;
  bindingKey?: unknown;
  presetLane?: unknown;
  effectiveModel?: unknown;
  effectivePreset?: unknown;
  effectiveChatMode?: unknown;
  constraint?: unknown;
};

export type QqbotChatLunaContextOptionsLike = {
  conversation?: ChatLunaConversationResolutionLike | null;
  requestSignal?: AbortSignal;
};

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function resolveChatLunaRoomLike(
  options: QqbotChatLunaContextOptionsLike | undefined,
): QqbotChatLunaRoomLike | undefined {
  const conversation = options?.conversation?.conversation;
  const conversationId =
    normalizeString(conversation?.id) ??
    normalizeString(options?.conversation?.conversationId);

  if (conversationId) {
    return {
      conversationId,
      model: normalizeString(options?.conversation?.effectiveModel) ?? normalizeString(conversation?.model),
      preset: normalizeString(options?.conversation?.effectivePreset) ?? normalizeString(conversation?.preset),
      chatMode: normalizeString(options?.conversation?.effectiveChatMode) ?? normalizeString(conversation?.chatMode),
    };
  }

  return undefined;
}
