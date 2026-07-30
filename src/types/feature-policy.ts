import 'koishi';
import type { Session } from 'koishi';

export type RuntimeFeatureKey =
  | 'QQBOT_REALTIME_MESSAGE_ENABLED'
  | 'QQ_VOICE_INPUT_ENABLED'
  | 'QQ_VOICE_OUTPUT_ENABLED'
  | 'QQBOT_REPLY_INTERRUPT_ENABLED';

export type ConversationTargetScopeKind = 'private' | 'group';

export interface AdminGroupScope {
  groupId: string;
  roomId: number;
  roomName: string;
  conversationId: string | null;
  visibility: string | null;
  updatedAt: number | null;
}

export interface ConversationTarget {
  roomId: number;
  roomName: string;
  scopeKind: ConversationTargetScopeKind;
  scopeId: string;
  groupId: string | null;
  conversationId: string;
  updatedAt: number | null;
}

export interface ClearConversationHistoryTarget {
  roomId: number;
  conversationId: string;
}

export interface ClearConversationHistoryResult {
  ok: true;
  roomId: number;
  conversationId: string;
  deletedMessages: number;
  updatedAt: number;
}

export interface DeleteConversationRoomTarget {
  roomId: number;
  conversationId: string;
}

export interface DeleteConversationRoomResult {
  ok: true;
  roomId: number;
  conversationId: string;
  deletedMessages: number;
  deletedConversation: boolean;
  deletedRoom: boolean;
  clearedDefaultUsers: number;
  updatedAt: number;
}

export interface FeaturePolicyServiceLike {
  resolveFeatureEnabled(session: Session, featureKey: RuntimeFeatureKey): Promise<boolean>;
  listAdminGroupScopes(): Promise<AdminGroupScope[]>;
  listConversationTargets(): Promise<ConversationTarget[]>;
  clearConversationHistory(target: ClearConversationHistoryTarget): Promise<ClearConversationHistoryResult>;
  deleteConversationRoom(target: DeleteConversationRoomTarget): Promise<DeleteConversationRoomResult>;
  resolvePrivateConversationTarget(session: Session): Promise<ConversationTarget | null>;
}

declare module 'koishi' {
  interface Context {
    featurePolicy?: FeaturePolicyServiceLike;
  }
}
