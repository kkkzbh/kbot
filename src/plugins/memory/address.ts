import type { Session } from 'koishi';
import type { MemoryAddress } from '../../types/memory.js';
import {
  resolveChatLunaRoomLike,
  type QqbotChatLunaContextOptionsLike,
} from '../shared/chatluna-conversation.js';
import { MemoryRuntimeError } from './errors.js';

export type MemoryMiddlewareContextLike = {
  options?: QqbotChatLunaContextOptionsLike & {
    inputMessage?: {
      content?: unknown;
    };
  };
};

export function buildMemoryAddress(
  session: Session,
  context: MemoryMiddlewareContextLike,
  observedAt = Date.now(),
): MemoryAddress | null {
  const userId = session.userId?.trim();
  const botSelfId = session.bot?.selfId?.trim() || session.selfId?.trim();
  const platform = session.platform?.trim() || 'unknown';
  const conversationId = resolveChatLunaRoomLike(context.options)?.conversationId?.trim();
  if (!userId || !botSelfId || !conversationId) return null;

  if (session.isDirect) {
    return {
      userKey: `${platform}:user:${userId}`,
      contextKey: `${platform}:bot:${botSelfId}:dm:${userId}`,
      channelType: 'direct',
      platform,
      botSelfId,
      userId,
      groupId: null,
      channelId: session.channelId?.trim() || null,
      rawContextId: session.channelId?.trim() || userId,
      conversationId,
      requestId: session.messageId?.trim() || null,
      currentAudienceSubjectKeys: [`${platform}:user:${userId}`],
      observedAt,
    };
  }

  const groupKey = session.guildId?.trim() || session.channelId?.trim();
  if (!groupKey) return null;
  return {
    userKey: `${platform}:user:${userId}`,
    contextKey: `${platform}:bot:${botSelfId}:group:${groupKey}`,
    channelType: 'group',
    platform,
    botSelfId,
    userId,
    groupId: session.guildId?.trim() || null,
    channelId: session.channelId?.trim() || null,
    rawContextId: groupKey,
    conversationId,
    requestId: session.messageId?.trim() || null,
    currentAudienceSubjectKeys: null,
    observedAt,
  };
}

async function loadGroupAudience(
  session: Session,
  platform: string,
  subjectKey: string,
  groupId: string,
): Promise<string[]> {
  let members: Record<string, string>;
  try {
    members = await session.bot.getGuildMemberMap(groupId);
  } catch (error) {
    throw new MemoryRuntimeError(
      'address',
      'provider',
      'memory_group_audience_unavailable',
      'The current group audience could not be verified.',
      { retryable: true, cause: error },
    );
  }
  const audience = [...new Set(
    Object.keys(members)
      .map((userId) => userId.trim())
      .filter(Boolean)
      .map((userId) => `${platform}:user:${userId}`),
  )].sort();
  if (!audience.length || !audience.includes(subjectKey)) {
    throw new MemoryRuntimeError(
      'address',
      'validation',
      'memory_group_audience_invalid',
      'The authoritative group audience does not contain the memory subject.',
    );
  }
  return audience;
}

export async function resolveCurrentMemoryAudience(
  session: Session,
  address: MemoryAddress,
): Promise<MemoryAddress> {
  if (address.channelType === 'direct') return address;
  const groupId = address.groupId ?? address.channelId ?? address.rawContextId;
  if (!groupId) {
    throw new MemoryRuntimeError(
      'address',
      'validation',
      'memory_group_identity_missing',
      'Group memory requires a canonical group identity.',
    );
  }
  const currentAudienceSubjectKeys = await loadGroupAudience(
    session,
    address.platform,
    address.userKey,
    groupId,
  );
  return {
    ...address,
    currentAudienceSubjectKeys,
  };
}

export async function resolveExplicitMemoryAudiences(
  session: Session,
  actorAddress: MemoryAddress,
  contextKeys: readonly string[],
): Promise<Record<string, string[]>> {
  if (actorAddress.channelType !== 'direct') {
    throw new MemoryRuntimeError(
      'review',
      'authorization',
      'memory_promotion_requires_direct',
      'Explicit memory audiences can only be authorized in a direct chat.',
    );
  }
  const snapshots: Record<string, string[]> = {};
  const groupPrefix = `${actorAddress.platform}:bot:${actorAddress.botSelfId}:group:`;
  for (const contextKey of [...new Set(contextKeys)].sort()) {
    if (!contextKey.startsWith(groupPrefix)) {
      throw new MemoryRuntimeError(
        'review',
        'validation',
        'memory_promotion_context_invalid',
        'Explicit memory audiences require canonical group context keys.',
      );
    }
    const groupId = contextKey.slice(groupPrefix.length).trim();
    if (!groupId) {
      throw new MemoryRuntimeError(
        'review',
        'validation',
        'memory_promotion_context_invalid',
        'Explicit memory audience group identity is missing.',
      );
    }
    snapshots[contextKey] = await loadGroupAudience(
      session,
      actorAddress.platform,
      actorAddress.userKey,
      groupId,
    );
  }
  return snapshots;
}
