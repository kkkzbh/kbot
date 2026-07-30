import { Context, Logger, type Session } from 'koishi';
import type {
  ClearConversationHistoryResult,
  ClearConversationHistoryTarget,
  AdminGroupScope,
  ConversationTarget,
  DeleteConversationRoomResult,
  DeleteConversationRoomTarget,
  FeaturePolicyServiceLike,
  RuntimeFeatureKey,
} from '../../types/feature-policy.js';

export const name = 'feature-policy';
export const inject = ['database'];

const logger = new Logger(name);

export const RUNTIME_FEATURE_KEYS = [
  'QQBOT_REALTIME_MESSAGE_ENABLED',
  'QQ_VOICE_INPUT_ENABLED',
  'QQ_VOICE_OUTPUT_ENABLED',
  'QQBOT_REPLY_INTERRUPT_ENABLED',
] as const satisfies readonly RuntimeFeatureKey[];

function registerChatLunaRoomTableModels(model: { extend?: (...args: any[]) => unknown } | undefined): void {
  if (typeof model?.extend !== 'function') return;

  model.extend(
    'chathub_room',
    {
      roomId: { type: 'integer' },
      roomName: 'string',
      conversationId: { type: 'char', length: 255, nullable: true },
      roomMasterId: { type: 'char', length: 255 },
      visibility: { type: 'char', length: 20 },
      preset: { type: 'char', length: 255 },
      model: { type: 'char', length: 100 },
      chatMode: { type: 'char', length: 20 },
      password: { type: 'char', length: 100 },
      autoUpdate: { type: 'boolean', initial: false },
      updatedTime: { type: 'timestamp', nullable: false, initial: new Date() },
    },
    {
      autoInc: false,
      primary: 'roomId',
      unique: ['roomId'],
    },
  );

  model.extend(
    'chathub_room_group_member',
    {
      groupId: { type: 'char', length: 255 },
      roomId: { type: 'integer' },
      roomVisibility: { type: 'char', length: 20 },
    },
    {
      autoInc: false,
      primary: ['groupId', 'roomId'],
    },
  );

  model.extend(
    'chathub_user',
    {
      userId: { type: 'char', length: 255 },
      defaultRoomId: { type: 'integer' },
      groupId: { type: 'char', length: 255, nullable: true },
    },
    {
      autoInc: false,
      primary: ['userId', 'groupId'],
    },
  );
}

type RoomRow = {
  roomId?: number | string | null;
  roomName?: string | null;
  conversationId?: string | null;
  visibility?: string | null;
  updatedTime?: number | string | null;
};

type RoomGroupMemberRow = {
  groupId?: string | null;
  roomId?: number | string | null;
};

type ChathubUserRow = {
  userId?: string | null;
  defaultRoomId?: number | string | null;
  groupId?: string | null;
};

type ChatLunaConversationRow = {
  id?: string | null;
  latestMessageId?: string | null;
  updatedAt?: number | string | null;
};

type ChatLunaMessageRow = {
  id?: string | null;
};

type DatabaseLike = {
  get(table: string, query: Record<string, unknown>): Promise<any[]>;
  set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<unknown>;
  remove(table: string, query: Record<string, unknown>): Promise<unknown>;
};

function isRuntimeFeatureKey(value: string): value is RuntimeFeatureKey {
  return (RUNTIME_FEATURE_KEYS as readonly string[]).includes(value);
}

function toNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPositiveInteger(value: unknown): number | null {
  const parsed = toNumber(value);
  if (parsed == null || parsed < 1) return null;
  return Math.floor(parsed);
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function requireBooleanEnv(key: string): boolean {
  const raw = normalizeText(process.env[key]).toLowerCase();
  if (!raw) {
    throw new Error(`${key} 未配置。默认值必须由 env/koishi.yml 显式提供。`);
  }
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(`${key} 必须是 true 或 false。`);
  }
  return raw === 'true';
}

function runtimeFeatureEnabled(featureKey: RuntimeFeatureKey): boolean {
  switch (featureKey) {
    case 'QQBOT_REALTIME_MESSAGE_ENABLED':
      return requireBooleanEnv('QQBOT_REALTIME_MESSAGE_ENABLED');
    case 'QQBOT_REPLY_INTERRUPT_ENABLED':
      return requireBooleanEnv('QQBOT_REPLY_INTERRUPT_ENABLED');
    case 'QQ_VOICE_INPUT_ENABLED':
      return requireBooleanEnv('QQ_VOICE_INPUT_ENABLED');
    case 'QQ_VOICE_OUTPUT_ENABLED':
      return requireBooleanEnv('QQ_VOICE_OUTPUT_ENABLED');
    default:
      return true;
  }
}

function formatRoomName(room: Pick<RoomRow, 'roomName' | 'roomId' | 'visibility'>, fallbackPrefix: string): string {
  const name = normalizeText(room.roomName);
  if (name) return name;
  const roomId = toPositiveInteger(room.roomId);
  return roomId ? `${fallbackPrefix} #${roomId}` : fallbackPrefix;
}

class FeaturePolicyService implements FeaturePolicyServiceLike {
  constructor(private readonly database: DatabaseLike) {}

  async resolveFeatureEnabled(session: Session, featureKey: RuntimeFeatureKey): Promise<boolean> {
    if (!isRuntimeFeatureKey(featureKey)) {
      throw new Error(`不支持这个功能项：${featureKey}`);
    }
    if (session.isDirect && featureKey === 'QQBOT_REALTIME_MESSAGE_ENABLED') return false;
    return runtimeFeatureEnabled(featureKey);
  }

  async listAdminGroupScopes(): Promise<AdminGroupScope[]> {
    const [rooms, groupMembers] = await Promise.all([
      this.database.get('chathub_room', {} as Record<string, never>) as Promise<RoomRow[]>,
      this.database.get('chathub_room_group_member', {} as Record<string, never>) as Promise<RoomGroupMemberRow[]>,
    ]);

    const roomById = new Map<number, RoomRow>();
    for (const room of rooms) {
      const roomId = toPositiveInteger(room.roomId);
      if (roomId == null) continue;
      roomById.set(roomId, room);
    }

    const groupScopes = new Map<string, AdminGroupScope>();
    for (const member of groupMembers) {
      const groupId = normalizeText(member.groupId);
      const roomId = toPositiveInteger(member.roomId);
      if (!groupId || roomId == null) continue;
      const room = roomById.get(roomId);
      if (!room) continue;

      const candidate: AdminGroupScope = {
        groupId,
        roomId,
        roomName: formatRoomName(room, '群房间'),
        conversationId: normalizeText(room.conversationId) || null,
        visibility: normalizeText(room.visibility) || null,
        updatedAt: toNumber(room.updatedTime),
      };
      const existing = groupScopes.get(groupId);
      if (!existing || (candidate.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
        groupScopes.set(groupId, candidate);
      }
    }

    return [...groupScopes.values()].sort((left, right) => {
      const timeDelta = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
      if (timeDelta !== 0) return timeDelta;
      return left.groupId.localeCompare(right.groupId, 'zh-CN');
    });
  }

  async listConversationTargets(): Promise<ConversationTarget[]> {
    const [rooms, groupMembers] = await Promise.all([
      this.database.get('chathub_room', {} as Record<string, never>) as Promise<RoomRow[]>,
      this.database.get('chathub_room_group_member', {} as Record<string, never>) as Promise<RoomGroupMemberRow[]>,
    ]);

    const roomById = new Map<number, RoomRow>();
    for (const room of rooms) {
      const roomId = toPositiveInteger(room.roomId);
      if (roomId == null) continue;
      roomById.set(roomId, room);
    }

    const privateTargets: ConversationTarget[] = [];
    for (const room of rooms) {
      const roomId = toPositiveInteger(room.roomId);
      const conversationId = normalizeText(room.conversationId);
      if (roomId == null || !conversationId || normalizeText(room.visibility) !== 'private') continue;
      privateTargets.push({
        roomId,
        roomName: formatRoomName(room, '私聊房间'),
        scopeKind: 'private',
        scopeId: String(roomId),
        groupId: null,
        conversationId,
        updatedAt: toNumber(room.updatedTime),
      });
    }

    const groupTargets = new Map<string, ConversationTarget>();
    for (const member of groupMembers) {
      const groupId = normalizeText(member.groupId);
      const roomId = toPositiveInteger(member.roomId);
      if (!groupId || roomId == null) continue;
      const room = roomById.get(roomId);
      if (!room) continue;
      const conversationId = normalizeText(room.conversationId);
      if (!conversationId) continue;

      const candidate: ConversationTarget = {
        roomId,
        roomName: formatRoomName(room, '群房间'),
        scopeKind: 'group',
        scopeId: groupId,
        groupId,
        conversationId,
        updatedAt: toNumber(room.updatedTime),
      };
      const existing = groupTargets.get(groupId);
      if (!existing || (candidate.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
        groupTargets.set(groupId, candidate);
      }
    }

    return [
      ...privateTargets.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)),
      ...[...groupTargets.values()].sort((left, right) => {
        const timeDelta = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
        if (timeDelta !== 0) return timeDelta;
        return left.scopeId.localeCompare(right.scopeId, 'zh-CN');
      }),
    ];
  }

  async clearConversationHistory(target: ClearConversationHistoryTarget): Promise<ClearConversationHistoryResult> {
    const roomId = toPositiveInteger(target.roomId);
    const conversationId = normalizeText(target.conversationId);
    if (roomId == null || !conversationId) {
      throw new Error('会话清理目标不完整。');
    }

    const [messages, conversations] = await Promise.all([
      this.database.get('chatluna_message', { conversationId }) as Promise<ChatLunaMessageRow[]>,
      this.database.get('chatluna_conversation', { id: conversationId }) as Promise<ChatLunaConversationRow[]>,
    ]);

    const updatedAt = Date.now();
    await this.database.remove('chatluna_message', { conversationId });
    if (conversations.length > 0) {
      await this.database.set('chatluna_conversation', { id: conversationId }, { latestMessageId: null, updatedAt });
    }

    return {
      ok: true,
      roomId,
      conversationId,
      deletedMessages: messages.length,
      updatedAt,
    };
  }

  async deleteConversationRoom(target: DeleteConversationRoomTarget): Promise<DeleteConversationRoomResult> {
    const roomId = toPositiveInteger(target.roomId);
    const conversationId = normalizeText(target.conversationId);
    if (roomId == null || !conversationId) {
      throw new Error('房间删除目标不完整。');
    }

    const [rooms, messages, conversations, users] = await Promise.all([
      this.database.get('chathub_room', { roomId }) as Promise<RoomRow[]>,
      this.database.get('chatluna_message', { conversationId }) as Promise<ChatLunaMessageRow[]>,
      this.database.get('chatluna_conversation', { id: conversationId }) as Promise<ChatLunaConversationRow[]>,
      this.database.get('chathub_user', { defaultRoomId: roomId }) as Promise<ChathubUserRow[]>,
    ]);

    const room = rooms[0];
    if (!room) {
      throw new Error(`房间 #${roomId} 不存在。`);
    }

    const roomConversationId = normalizeText(room.conversationId);
    if (!roomConversationId || roomConversationId !== conversationId) {
      throw new Error(`房间 #${roomId} 的会话标识不匹配。`);
    }

    const isPrivateRoom = normalizeText(room.visibility) === 'private';
    const updatedAt = Date.now();

    await Promise.all([
      this.database.remove('chathub_room_group_member', { roomId }),
      this.database.remove('chatluna_message', { conversationId }),
      this.database.remove('chatluna_conversation', { id: conversationId }),
      this.database.remove('chathub_room', { roomId }),
      isPrivateRoom && users.length > 0
        ? this.database.set('chathub_user', { defaultRoomId: roomId }, { defaultRoomId: null, updatedAt })
        : Promise.resolve(undefined),
    ]);

    return {
      ok: true,
      roomId,
      conversationId,
      deletedMessages: messages.length,
      deletedConversation: conversations.length > 0,
      deletedRoom: true,
      clearedDefaultUsers: isPrivateRoom ? users.length : 0,
      updatedAt,
    };
  }

  async resolvePrivateConversationTarget(session: Session): Promise<ConversationTarget | null> {
    if (!session.isDirect) return null;
    const userId = normalizeText(session.userId);
    if (!userId) return null;

    const rows = (await this.database.get('chathub_user', {
      userId,
      groupId: '0',
    })) as ChathubUserRow[];
    const defaultRoomId = toPositiveInteger(rows[0]?.defaultRoomId);
    if (defaultRoomId == null) return null;

    const rooms = (await this.database.get('chathub_room', { roomId: defaultRoomId })) as RoomRow[];
    const room = rooms[0];
    if (!room) return null;
    const conversationId = normalizeText(room.conversationId);
    if (!conversationId) return null;

    return {
      roomId: defaultRoomId,
      roomName: formatRoomName(room, '私聊房间'),
      scopeKind: 'private',
      scopeId: String(defaultRoomId),
      groupId: null,
      conversationId,
      updatedAt: toNumber(room.updatedTime),
    };
  }
}

export function apply(ctx: Context): void {
  const database = (ctx as { database?: DatabaseLike }).database;
  if (!database) {
    throw new Error('feature-policy requires database service.');
  }

  const model = (ctx as { model?: { extend?: (...args: any[]) => unknown } }).model;
  if (typeof model?.extend === 'function') {
    registerChatLunaRoomTableModels(model);
  }

  const service = new FeaturePolicyService(database);
  const serviceCtx = ctx as Context & {
    provide?: (name: string) => void;
    set?: (name: string, value: unknown) => void;
    featurePolicy?: FeaturePolicyServiceLike;
  };
  if (typeof serviceCtx.provide === 'function' && typeof serviceCtx.set === 'function') {
    serviceCtx.provide('featurePolicy');
    serviceCtx.set('featurePolicy', service);
  } else {
    serviceCtx.featurePolicy = service;
  }

  ctx.command('clear', '清除当前私聊会话上下文').action(async ({ session }) => {
    if (!session?.isDirect) {
      return '这个命令只能在私聊里使用。';
    }

    const target = await service.resolvePrivateConversationTarget(session);
    if (!target) {
      return '当前没有可清除的私聊会话上下文。';
    }

    const result = await service.clearConversationHistory({
      roomId: target.roomId,
      conversationId: target.conversationId,
    });
    return `已清除当前私聊会话上下文，共删除 ${result.deletedMessages} 条消息。`;
  });

  logger.info('feature policy service registered.');
}
