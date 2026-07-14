import 'koishi';
import type { Fragment, Session } from 'koishi';

export interface NativeFeatureCapability {
  id: string;
  isRelevant(session: Session): boolean;
  buildReference(session: Session): string;
}

export interface NativeFeatureReplyInput {
  featureId: string;
  commandId: string;
  userText: string;
  reply: Fragment;
  summary: string;
  success: boolean;
  includeReplyPayload: boolean;
}

export interface NativeFeatureHistoryResult {
  conversationId: string;
  humanRecordId: string;
  assistantRecordId: string;
}

export interface NativeFeatureChatServiceLike {
  registerCapability(capability: NativeFeatureCapability): () => void;
  sendReply(session: Session, input: NativeFeatureReplyInput): Promise<NativeFeatureHistoryResult | null>;
  recordExchange(session: Session, input: NativeFeatureReplyInput): Promise<NativeFeatureHistoryResult>;
}

declare module 'koishi' {
  interface Context {
    nativeFeatureChat?: NativeFeatureChatServiceLike;
  }
}
