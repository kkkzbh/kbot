import 'koishi';

export type AffinityCharacterId = 'sakiko';
export type AffinityScopeKind = 'group' | 'private';
export type AffinityStage = 'stranger' | 'polite' | 'remembered' | 'trusted' | 'special';
export type AffinityMood = 'neutral' | 'calm' | 'focused' | 'pleased' | 'guarded' | 'tired' | 'embarrassed';
export type AffinityEffectTier = 'ignore' | 'flavor' | 'mood' | 'progress';
export type AffinityPanelLineKind = AffinityStage | 'overheated';
export type AffinityAnalysisRoute =
  | 'ignore'
  | 'normal_chat'
  | 'affinity_flavor'
  | 'affinity_candidate'
  | 'random_event_reply'
  | 'group_event_progress'
  | 'boundary_risk';
export type AffinityEventType =
  | 'none'
  | 'greeting_contextual'
  | 'offer_tea'
  | 'music_help'
  | 'care_subtle'
  | 'keep_promise'
  | 'boundary_respect'
  | 'light_tease'
  | 'contest_discussion'
  | 'computer_knowledge'
  | 'answer_random_prompt'
  | 'over_interaction'
  | 'pressure_or_spam'
  | 'promise_broken';
export type AffinityRandomDirection =
  | 'local_thread'
  | 'daily_greeting'
  | 'music_rehearsal'
  | 'contest_discussion'
  | 'computer_knowledge'
  | 'web_hot_topic'
  | 'relationship_scene';
export type AffinityRandomPlanStatus = 'pending' | 'sent' | 'skipped' | 'failed' | 'expired';
export type AffinityRandomPlanTriggerKind = 'scheduled' | 'manual';
export type AffinityAuditEventType =
  | 'message_seen'
  | 'event_analysis'
  | 'state_update'
  | 'random_message_generated'
  | 'random_message_generation_skipped'
  | 'random_memory_updated'
  | 'random_plan_created'
  | 'random_plan_requeued'
  | 'random_plan_sent'
  | 'random_plan_skipped'
  | 'random_history_synced'
  | 'random_history_sync_skipped'
  | 'panel_history_synced'
  | 'panel_history_sync_skipped'
  | 'admin_update';
export interface AffinityConfigRecord {
  id: number;
  key: string;
  value: string;
  updatedAt: number;
}

export interface AffinityScopeConfigRecord {
  id: number;
  characterId: AffinityCharacterId;
  scopeKind: AffinityScopeKind;
  scopeId: string;
  enabled: number;
  proactiveEnabled: number;
  label: string | null;
  platform: string | null;
  botSelfId: string | null;
  channelId: string | null;
  guildId: string | null;
  conversationId: string | null;
  updatedAt: number;
}

export interface AffinityUserStateRecord {
  id: number;
  characterId: AffinityCharacterId;
  userKey: string;
  platform: string;
  userId: string;
  displayName: string | null;
  trust: number;
  familiarity: number;
  comfort: number;
  tension: number;
  mood: AffinityMood;
  attentionHeat: number;
  energy: number;
  stage: AffinityStage;
  flags: string | null;
  unlockedScenes: string | null;
  dailyState: string | null;
  weeklyState: string | null;
  lastSeenAt: number;
  lastUpdatedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface AffinityEventRecord {
  id: number;
  characterId: AffinityCharacterId;
  userKey: string | null;
  scopeKind: AffinityScopeKind;
  scopeId: string;
  platform: string;
  botSelfId: string | null;
  channelId: string | null;
  guildId: string | null;
  conversationId: string | null;
  messageId: string | null;
  eventType: AffinityEventType;
  effectTier: AffinityEffectTier;
  route: AffinityAnalysisRoute;
  confidence: number;
  reasonCode: string;
  deltaJson: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  evidence: string | null;
  createdAt: number;
}

export interface AffinityRandomPlanRecord {
  id: number;
  planKey: string;
  characterId: AffinityCharacterId;
  triggerKind: AffinityRandomPlanTriggerKind;
  scopeKind: AffinityScopeKind;
  scopeId: string;
  platform: string | null;
  botSelfId: string | null;
  channelId: string | null;
  guildId: string | null;
  conversationId: string | null;
  dayKey: string;
  slotIndex: number;
  direction: AffinityRandomDirection;
  scheduledAt: number;
  status: AffinityRandomPlanStatus;
  messageText: string | null;
  skipReason: string | null;
  sentAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AffinityOpenThreadRecord {
  id: number;
  characterId: AffinityCharacterId;
  scopeKind: AffinityScopeKind;
  scopeId: string;
  userKey: string | null;
  threadType: string;
  title: string;
  summary: string;
  status: 'open' | 'resolved' | 'expired';
  payloadJson: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface AffinityRandomMemoryRecord {
  id: number;
  characterId: AffinityCharacterId;
  scopeKind: AffinityScopeKind;
  scopeId: string;
  direction: AffinityRandomDirection;
  sourcePlanId: number | null;
  messageText: string;
  contextSummary: string | null;
  materialJson: string | null;
  responseSummary: string | null;
  responderNames: string | null;
  createdAt: number;
  lastResponseAt: number | null;
  expiresAt: number;
  updatedAt: number;
}

export interface AffinityAuditRecord {
  id: number;
  eventType: AffinityAuditEventType;
  characterId: AffinityCharacterId;
  userKey: string | null;
  scopeKind: AffinityScopeKind | null;
  scopeId: string | null;
  detail: string | null;
  createdAt: number;
}

export interface AffinityWhitelistInput {
  characterId?: AffinityCharacterId;
  scopeKind: AffinityScopeKind;
  scopeId: string;
  enabled: boolean;
  proactiveEnabled: boolean;
  label?: string | null;
  platform?: string | null;
  botSelfId?: string | null;
  channelId?: string | null;
  guildId?: string | null;
  conversationId?: string | null;
}

export interface AffinitySettings {
  enabled: boolean;
  proactiveEnabled: boolean;
  randomWindowStartHour: number;
  randomWindowEndHour: number;
  randomCountWeights: [number, number, number, number];
  enabledDirections: AffinityRandomDirection[];
  webSourceEnabled: boolean;
}

export interface AffinityStateSummary {
  available: boolean;
  settings: AffinitySettings;
  scopes: AffinityScopeConfigRecord[];
  users: AffinityUserStateRecord[];
  recentEvents: AffinityEventRecord[];
  randomPlans: AffinityRandomPlanRecord[];
  audit: AffinityAuditRecord[];
}

export type AffinityPanelAxisTone = 'wine' | 'teal' | 'blue' | 'gold';
export type AffinityPanelEffectSign = '+' | '-';

export interface AffinityPanelAxis {
  name: string;
  value: number;
  tone: AffinityPanelAxisTone;
  icon: string;
}

export interface AffinityPanelRhythmItem {
  label: string;
  value: string;
  icon: string;
}

export interface AffinityPanelEffectToken {
  name: string;
  sign: AffinityPanelEffectSign;
}

export interface AffinityPanelRecentEvent {
  time: string;
  title: string;
  icon: string;
  effects: AffinityPanelEffectToken[];
}

export interface AffinityPanelView {
  characterId: AffinityCharacterId;
  userKey: string;
  stage: AffinityStage;
  stageName: string;
  stageIcon: string;
  lastRelationChange: string;
  axes: AffinityPanelAxis[];
  rhythm: AffinityPanelRhythmItem[];
  recentEvents: AffinityPanelRecentEvent[];
  adviceIcon: string;
  advice: string;
  lineKind: AffinityPanelLineKind;
  fixedLine: string;
}

export interface AffinityPanelHistorySyncResult {
  synced: boolean;
  reason?: string;
  conversationId?: string;
}

export interface AffinityMutationResponse {
  ok: boolean;
  affinity: AffinityStateSummary;
}

export interface AffinityManualRandomPlanInput {
  scopeKind: AffinityScopeKind;
  scopeId: string;
  delayMs?: number;
  platform?: string | null;
  botSelfId?: string | null;
  channelId?: string | null;
  guildId?: string | null;
  conversationId?: string | null;
}

export interface AffinityManualRandomPlanResponse {
  ok: true;
  planId: number;
  scheduledAt: number;
  triggerKind: 'manual';
}

export interface AffinityServiceLike {
  getAdminState(): Promise<AffinityStateSummary>;
  buildPanelView(session: import('koishi').Session, now?: number): Promise<AffinityPanelView>;
  syncPanelCommandToChatHistory(
    session: import('koishi').Session,
    view: AffinityPanelView,
  ): Promise<AffinityPanelHistorySyncResult>;
  saveSettings(settings: Partial<AffinitySettings>): Promise<AffinityStateSummary>;
  saveWhitelist(scopes: AffinityWhitelistInput[]): Promise<AffinityStateSummary>;
  createManualRandomPlan(input: AffinityManualRandomPlanInput, now?: number): Promise<AffinityManualRandomPlanResponse>;
  getNextPendingRandomPlanAt(now?: number): Promise<number | null>;
  adjustUserState(input: {
    userKey: string;
    reason: string;
    trust?: number;
    familiarity?: number;
    comfort?: number;
    tension?: number;
  }): Promise<AffinityStateSummary>;
}

declare module 'koishi' {
  interface Tables {
    affinity_config: AffinityConfigRecord;
    affinity_scope_config: AffinityScopeConfigRecord;
    affinity_user_state: AffinityUserStateRecord;
    affinity_event: AffinityEventRecord;
    affinity_random_plan: AffinityRandomPlanRecord;
    affinity_open_thread: AffinityOpenThreadRecord;
    affinity_random_memory: AffinityRandomMemoryRecord;
    affinity_audit: AffinityAuditRecord;
  }

  interface Context {
    affinity?: AffinityServiceLike;
  }
}
