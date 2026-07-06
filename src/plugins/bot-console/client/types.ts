// Client-side type definitions
// Mirrors src/types/bot-console.ts + src/types/memory.ts without koishi dependency

export type ServiceAction = "start" | "stop" | "restart" | "enable";

export type AffinityCharacterId = "sakiko";
export type AffinityScopeKind = "group" | "private";
export type AffinityStage = "stranger" | "polite" | "remembered" | "trusted" | "special";
export type AffinityMood = "neutral" | "calm" | "focused" | "pleased" | "guarded" | "tired" | "embarrassed";
export type AffinityRandomDirection =
  | "local_thread"
  | "daily_greeting"
  | "music_rehearsal"
  | "contest_discussion"
  | "computer_knowledge"
  | "web_hot_topic"
  | "relationship_scene";

export interface AffinityAnalysisModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  requestMode: "chat_completions" | "responses";
  structuredOutputProtocol: "native_chat_json_schema" | "native_responses_json_schema" | "chat_reply_v1" | "json_mode";
  timeoutMs: number;
}

export interface AffinitySettings {
  enabled: boolean;
  proactiveEnabled: boolean;
  randomWindowStartHour: number;
  randomWindowEndHour: number;
  randomCountWeights: [number, number, number, number];
  enabledDirections: AffinityRandomDirection[];
  webSourceEnabled: boolean;
  analysisModel: Partial<AffinityAnalysisModelConfig>;
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
  userKey: string | null;
  scopeKind: AffinityScopeKind;
  scopeId: string;
  eventType: string;
  effectTier: string;
  route: string;
  confidence: number;
  reasonCode: string;
  deltaJson: string | null;
  evidence: string | null;
  createdAt: number;
}

export interface AffinityRandomPlanRecord {
  id: number;
  scopeKind: AffinityScopeKind;
  scopeId: string;
  dayKey: string;
  slotIndex: number;
  direction: AffinityRandomDirection;
  scheduledAt: number;
  status: "pending" | "sent" | "skipped" | "failed" | "expired";
  messageText: string | null;
  skipReason: string | null;
  sentAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AffinityAuditRecord {
  id: number;
  eventType: string;
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

export interface AffinityStateSummary {
  available: boolean;
  settings: AffinitySettings;
  scopes: AffinityScopeConfigRecord[];
  users: AffinityUserStateRecord[];
  recentEvents: AffinityEventRecord[];
  randomPlans: AffinityRandomPlanRecord[];
  audit: AffinityAuditRecord[];
}

export type BotServiceUnit =
  | "qqbot.target"
  | "qqbot-pmhq.service"
  | "qqbot-llbot.service"
  | "qqbot-koishi.service"
  | "cloudflared-qqbot-hbu-jw.service"
  | "qqbot-voice-tts.service"
  | "qqbot-voice-tts-tailnet.service";

export interface BotServiceStatus {
  unit: BotServiceUnit;
  description: string;
  loadState: string;
  activeState: string;
  subState: string;
  unitFileState: string;
  canStart: boolean;
  canStop: boolean;
  canRestart: boolean;
  canEnable: boolean;
}

export type PresetSource = "runtime" | "bundled";

export interface BotConsoleEnvFilesState {
  mode: "single" | "layered";
  baseFile: string | null;
  overrideFile: string | null;
  editTarget: string;
}

export interface PresetPrompt {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface PresetSummary {
  name: string;
  path: string;
  source: PresetSource;
}

export interface PresetDocument {
  name: string;
  originalName?: string;
  path?: string;
  source?: PresetSource;
  keywords: string[];
  prompts: PresetPrompt[];
  raw?: string;
}

export type BotConsoleModelTabId = "siliconflow" | "openai" | "codex" | "copilot" | "deepseek" | "mimo";
export type BotConsoleAuthKind = "manual" | "oauth_device" | "codex_oauth";
export type BotConsoleAuthStatus = "unauthenticated" | "pending" | "ready" | "expired" | "error";
export type BotConsoleModelListSource = "dynamic" | "static";

export interface CopilotAuthAttempt {
  attemptId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSec: number;
  nextPollAt: number;
  state: "pending" | "authorized" | "expired" | "failed" | "cancelled";
  error: string | null;
}

export interface CodexAuthAttempt {
  attemptId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSec: number;
  nextPollAt: number;
  state: "pending" | "authorized" | "expired" | "failed" | "cancelled";
  error: string | null;
}

export interface BotConsoleBuiltinModelTab {
  id: BotConsoleModelTabId;
  title: string;
  provider: "siliconflow" | "openai" | "deepseek" | "mimo";
  strategyId: "siliconflow-kimi-main-chat" | "openai-gpt54-main-chat" | "codex-chatgpt-oauth-main-chat" | "copilot-github-oauth-main-chat" | "deepseek-official-main-chat" | "mimo-official-main-chat";
  requestMode: "chat_completions" | "responses";
  structuredOutputProtocol: "native_chat_json_schema" | "native_responses_json_schema" | "chat_reply_v1";
  description: string;
  modelHint: string;
  authKind: BotConsoleAuthKind;
  authStatus: BotConsoleAuthStatus;
  accountLabel?: string | null;
  authError?: string | null;
  tokenExpiresAt?: number | null;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | null;
  canonicalModel?: string;
  transportModel?: string;
}

export interface BotConsoleModelTabsState {
  activeTab: BotConsoleModelTabId;
  tabs: BotConsoleBuiltinModelTab[];
}

export interface BotConsoleModelOption {
  modelId: string;
  label: string;
  rateLabel?: string;
  requestMode?: "chat_completions" | "responses";
  structuredOutputProtocol?: "native_chat_json_schema" | "native_responses_json_schema" | "chat_reply_v1";
  metadataTags?: string[];
  deprecated?: boolean;
  deprecationDate?: string;
}

export interface DeepSeekModelListRequest {
  baseUrl?: string;
  apiKey?: string;
}

export interface DeepSeekModelListResponse {
  source: BotConsoleModelListSource;
  models: BotConsoleModelOption[];
  error: string | null;
}

export interface CopilotModelListResponse {
  source: BotConsoleModelListSource;
  models: BotConsoleModelOption[];
  error: string | null;
}

export interface CodexModelListResponse {
  source: BotConsoleModelListSource;
  models: BotConsoleModelOption[];
  error: string | null;
}

export interface MimoModelListRequest {
  baseUrl?: string;
  apiKey?: string;
}

export interface MimoModelListResponse {
  source: BotConsoleModelListSource;
  models: BotConsoleModelOption[];
  error: string | null;
}

export interface ReorderPresetsResponse {
  presets: PresetSummary[];
}

export type BotConsoleTtsHealthStatus = "unknown" | "ok" | "degraded" | "unreachable";
export type BotConsoleTtsStyleId = "white" | "black";

export interface BotConsoleTtsStyleConfig {
  id: BotConsoleTtsStyleId;
  refAudioPath: string;
  promptText: string;
  promptLang: string;
}

export interface BotConsoleTtsLocalGatewayState {
  provider: "gpt-sovits";
  manageable: boolean;
  envFile: string;
  envFileExists: boolean;
  env: Record<string, string>;
  resolved: {
    baseUrl: string;
    upstreamBaseUrl: string;
    host: string;
    port: number;
    internalHost: string;
    internalPort: number;
    device: string;
    isHalf: boolean;
    version: string;
    textLang: string;
    promptLang: string;
    mediaType: string;
    splitMethod: string;
    batchSize: number;
    parallelInfer: boolean;
    maxTextChars: number;
    requestTimeoutSeconds: number;
    launchTimeoutSeconds: number;
    gptWeightsPath: string;
    sovitsWeightsPath: string;
    bertBasePath: string;
    hubertBasePath: string;
    styles: BotConsoleTtsStyleConfig[];
  };
}

export interface BotConsoleTtsHealthSnapshot {
  status: BotConsoleTtsHealthStatus;
  checkedAt: number | null;
  latencyMs: number | null;
  error: string | null;
  targetBaseUrl: string;
  running: boolean | null;
  upstreamHost: string | null;
  upstreamPort: number | null;
  device: string | null;
  isHalf: boolean | null;
  rawStatus: string | null;
}

export interface BotConsoleTtsState {
  localGateway: BotConsoleTtsLocalGatewayState;
  health: BotConsoleTtsHealthSnapshot;
}

// ─── Memory V3 ───────────────────────────────────────────────────────────────

export type MemoryStatusState = "never" | "success" | "failed";
export type MemoryStatusSource = "runtime" | "probe" | null;
export type MemoryVisibility =
  | "global"
  | "private_only"
  | "source_context_only"
  | "allowed_contexts"
  | "denied_contexts"
  | "pending_review"
  | "archived";
export type MemorySensitivity = "low" | "personal" | "sensitive" | "secret";
export type MemoryRecordType = "fact" | "episode";
export type MemoryProfileKind = "identity" | "preference" | "trait" | "boundary" | "plan" | "relationship";
export type MemoryOutputProtocolId =
  | "native_responses_json_schema"
  | "native_chat_json_schema"
  | "json_mode_with_repair"
  | "plain_text_memory_v1"
  | "unsupported_protocol";
export type MemoryJobType =
  | "extract"
  | "privacy_review"
  | "consolidate"
  | "embed"
  | "reembed"
  | "maintenance"
  | "forget"
  | "migration_backfill"
  | "eval_probe";
export type MemoryJobStatus = "pending" | "processing" | "done" | "failed" | "dead_letter";

export interface MemoryQueueSummary {
  extractPending: number;
  extractProcessing: number;
  privacyReviewPending: number;
  consolidatePending: number;
  embedPending: number;
  embedProcessing: number;
  deadLetter: number;
}

export interface MemoryOperationSnapshot {
  configured: boolean;
  state: MemoryStatusState;
  lastSource: MemoryStatusSource;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface MemoryProviderRouteStats {
  route: MemoryOutputProtocolId;
  success: number;
  failure: number;
  lastError: string | null;
}

export interface MemoryStatusSnapshot {
  available: boolean;
  enabled: boolean;
  readEnabled: boolean;
  writeEnabled: boolean;
  extractConfigured: boolean;
  embedConfigured: boolean;
  extractModel: string;
  embedBaseUrl: string;
  embedModel: string;
  jobs: MemoryQueueSummary;
  providerRoutes: MemoryProviderRouteStats[];
  lastMaintenanceAt: number | null;
  extract: MemoryOperationSnapshot;
  embed: MemoryOperationSnapshot;
}

export interface MemoryProbeResult {
  target: "embedding" | "extraction" | "provider";
  ok: boolean;
  checkedAt: number;
  latencyMs: number | null;
  error: string | null;
  snapshot: MemoryStatusSnapshot;
}

// ─── Scoped Feature Policy ────────────────────────────────────────────────────

export type ScopedFeatureKey =
  | "QQBOT_REALTIME_MESSAGE_ENABLED"
  | "QQ_VOICE_INPUT_ENABLED"
  | "QQ_VOICE_OUTPUT_ENABLED"
  | "CHAT_NATURAL_TRIGGER_ENABLED"
  | "QQBOT_REPLY_INTERRUPT_ENABLED";

export type FeatureScopeKind = "private_default" | "group";
export type ConversationTargetScopeKind = "private" | "group";

export interface FeatureScopeOverrideRecord {
  id: number;
  featureKey: ScopedFeatureKey;
  scopeKind: FeatureScopeKind;
  scopeId: string;
  enabled: number;
  updatedAt: number;
}

export interface FeatureOverrideInput {
  featureKey: ScopedFeatureKey;
  scopeKind: FeatureScopeKind;
  scopeId: string;
  enabled: boolean;
}

export interface ConsoleFeatureScope {
  scopeKind: FeatureScopeKind;
  scopeId: string;
  roomId: number | null;
  roomName: string;
  groupId: string | null;
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

export interface ClearConversationHistoryResult {
  ok: true;
  roomId: number;
  conversationId: string;
  deletedMessages: number;
  updatedAt: number;
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

// ─── Tool Policy ─────────────────────────────────────────────────────────────

export type ToolRouteProfile = "agent" | "automation";
export type ToolPolicyScopeKind =
  | "global_default"
  | "private_default"
  | "private_conversation"
  | "group";
export type ToolCompatibility = "compatible" | "conditional" | "incompatible";
export type ToolRiskLevel = "low" | "medium" | "high";
export type ToolCategoryKey = "builtin" | "file" | "web" | "geo";
export type ToolOverrideMode = "inherit" | "enabled" | "disabled";

export interface ToolCatalogEntry {
  toolName: string;
  title: string;
  category: ToolCategoryKey;
  description: string;
  compatibility: ToolCompatibility;
  compatibilityNote: string;
  hardDependencies: string[];
  relatedTools: string[];
  riskLevel: ToolRiskLevel;
  source?: "project" | "chatluna_runtime";
  registered?: boolean;
  availableRoutes: ToolRouteProfile[];
  defaultEnabledByRoute?: Record<ToolRouteProfile, boolean>;
}

export interface ToolPolicyScope {
  scopeKind: ToolPolicyScopeKind;
  scopeId: string;
  roomId: number | null;
  roomName: string;
  groupId: string | null;
  conversationId: string | null;
  visibility: string | null;
  updatedAt: number | null;
}

export interface ToolPolicyOverrideRecord {
  id: number;
  toolName: string;
  routeProfile: ToolRouteProfile;
  scopeKind: ToolPolicyScopeKind;
  scopeId: string;
  enabled: number;
  updatedAt: number;
}

export interface ToolPolicyOverrideInput {
  toolName: string;
  routeProfile: ToolRouteProfile;
  scopeKind: ToolPolicyScopeKind;
  scopeId: string;
  enabled: boolean;
}

export interface BotConsoleToolPolicyState {
  routeProfiles: ToolRouteProfile[];
  catalog: ToolCatalogEntry[];
  routeProfileInfo?: Array<{
    id: ToolRouteProfile;
    title: string;
    description: string;
    note?: string;
  }>;
  defaultScopes?: Array<{
    scopeKind: ToolPolicyScopeKind;
    scopeId: string;
    title: string;
    description: string;
  }>;
  scopes: ToolPolicyScope[];
  overrides: ToolPolicyOverrideRecord[];
  conversationTargets?: ConversationTarget[];
}

// ─── Bot Console State ────────────────────────────────────────────────────────

export interface BotConsoleState {
  env: Record<string, string>;
  envFiles: BotConsoleEnvFilesState;
  services: BotServiceStatus[];
  presets: PresetSummary[];
  defaultPreset: string;
  featureScopes: ConsoleFeatureScope[];
  featureOverrides: FeatureScopeOverrideRecord[];
  conversationTargets: ConversationTarget[];
  affinity: AffinityStateSummary;
  toolPolicy?: BotConsoleToolPolicyState | null;
  modelTabs: BotConsoleModelTabsState;
  tts: BotConsoleTtsState;
  runtimeStatus: {
    memory: MemoryStatusSnapshot;
    tts: BotConsoleTtsHealthSnapshot;
  };
}

export interface BotConsoleMemoryUserItem {
  userKey: string;
  platform: string | null;
  userId: string | null;
  qqNick: string | null;
  avatarUrl: string | null;
  label: string;
  factCount: number;
  episodeCount: number;
  pendingReviewCount: number;
  readEnabled: boolean;
  writeEnabled: boolean;
  latestSeenAt: number | null;
}

export interface BotConsoleMemoryFactItem {
  id: number;
  userKey: string;
  sourceContextKey: string;
  kind: MemoryProfileKind;
  topicKey: string;
  content: string;
  keywords: string[];
  importance: number;
  confidence: number;
  sensitivity: MemorySensitivity;
  visibility: MemoryVisibility;
  firstSeenAt: number;
  lastSeenAt: number;
  lastAccessedAt: number | null;
  hasEmbedding: boolean;
  archived: boolean;
  conflictSetId: string | null;
}

export interface BotConsoleMemoryEpisodeItem {
  id: number;
  userKey: string;
  sourceContextKey: string;
  title: string;
  summary: string;
  keywords: string[];
  importance: number;
  confidence: number;
  sensitivity: MemorySensitivity;
  visibility: MemoryVisibility;
  periodStart: number | null;
  periodEnd: number | null;
  firstSeenAt: number;
  lastSeenAt: number;
  lastAccessedAt: number | null;
  hasEmbedding: boolean;
  archived: boolean;
  conflictSetId: string | null;
}

export interface BotConsoleMemoryPendingReviewItem {
  id: number;
  batchId: string;
  candidateType: "fact" | "episode" | "drop";
  userKey: string;
  contextKey: string;
  conversationId: string;
  payload: string;
  sensitivity: MemorySensitivity;
  suggestedVisibility: MemoryVisibility;
  finalVisibility: MemoryVisibility | null;
  dropReason: string | null;
  providerRoute: MemoryOutputProtocolId;
  createdAt: number;
}

export interface BotConsoleMemoryJobItem {
  id: number;
  jobType: MemoryJobType;
  status: MemoryJobStatus;
  userKey: string | null;
  contextKey: string | null;
  conversationId: string | null;
  retryCount: number;
  nextRunAt: number;
  lockedAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
}

export interface BotConsoleMemoryAuditItem {
  id: number;
  userKey: string | null;
  contextKey: string | null;
  eventType: string;
  memoryType: MemoryRecordType | null;
  memoryId: number | null;
  candidateId: number | null;
  turnId: string | null;
  detail: string | null;
  createdAt: number;
}

export interface BotConsoleMemorySummary {
  userCount: number;
  factCount: number;
  episodeCount: number;
  pendingReviewCount: number;
  pendingJobs: number;
  processingJobs: number;
  deadLetterJobs: number;
}

export interface BotConsoleMemoryState {
  available: boolean;
  summary: BotConsoleMemorySummary;
  users: BotConsoleMemoryUserItem[];
  selectedUser: string | null;
  facts: BotConsoleMemoryFactItem[];
  episodes: BotConsoleMemoryEpisodeItem[];
  pendingReview: BotConsoleMemoryPendingReviewItem[];
  jobs: BotConsoleMemoryJobItem[];
  audit: BotConsoleMemoryAuditItem[];
  provenanceCount: number;
  status: MemoryStatusSnapshot | null;
  providerRoutes: MemoryProviderRouteStats[];
  recentFailures: string[];
}

export interface BotConsoleProbeResponse {
  target: "embedding" | "extraction" | "provider";
  memory: MemoryProbeResult;
}

export interface GetMemoryStateResponse extends BotConsoleMemoryState {}

export interface BotConsoleMemoryMutationResponse {
  ok: boolean;
  memory: BotConsoleMemoryState;
}

export interface SaveAffinitySettingsResponse {
  ok: boolean;
  affinity: AffinityStateSummary;
}

export interface SaveAffinityWhitelistResponse {
  ok: boolean;
  affinity: AffinityStateSummary;
}

export interface AdjustAffinityUserResponse {
  ok: boolean;
  affinity: AffinityStateSummary;
}

export interface SaveEnvResponse {
  env: Record<string, string>;
  restartRequired: boolean;
}

export interface SaveTtsSettingsRequest {
  botEnv?: Record<string, string | null | undefined>;
  localEnv?: Record<string, string | null | undefined>;
}

export interface SaveTtsSettingsResponse {
  env: Record<string, string>;
  tts: BotConsoleTtsState;
  restartRequired: {
    bot: boolean;
    tts: boolean;
  };
}

export interface ProbeTtsHealthResponse {
  health: BotConsoleTtsHealthSnapshot;
}

export interface SynthesizeTtsSampleRequest {
  text: string;
  style: BotConsoleTtsStyleId;
}

export interface SynthesizeTtsSampleResponse {
  ok: true;
  text: string;
  style: BotConsoleTtsStyleId;
  elapsedMs: number;
  bytes: number;
  contentType: string;
  dataUri: string;
  audio: {
    format: "wav";
    durationSeconds: number | null;
    sampleRate: number | null;
    channels: number | null;
  };
}

export interface SaveModelTabsRequest {
  activeTab: BotConsoleModelTabId;
  tabs: BotConsoleBuiltinModelTab[];
  dirtyTabIds: BotConsoleModelTabId[];
}

export interface SaveModelTabsResponse {
  env: Record<string, string>;
  modelTabs: BotConsoleModelTabsState;
  hotSwitched: boolean;
  restartRequired: boolean;
  restartReason: string | null;
}

export interface CopilotAuthState {
  authKind: "oauth_device";
  authStatus: BotConsoleAuthStatus;
  accountLabel: string | null;
  authError: string | null;
  attempt: CopilotAuthAttempt | null;
}

export interface CodexAuthState {
  authKind: "codex_oauth";
  authStatus: BotConsoleAuthStatus;
  accountLabel: string | null;
  authError: string | null;
  tokenExpiresAt: number | null;
  attempt: CodexAuthAttempt | null;
}

export interface CopilotAuthStartResponse extends CopilotAuthState {}
export interface CopilotAuthPollResponse extends CopilotAuthState {}
export interface CopilotAuthStatusResponse extends CopilotAuthState {}
export interface CopilotAuthCancelResponse extends CopilotAuthState {}
export interface CopilotAuthLogoutResponse extends CopilotAuthState {}
export interface CodexAuthStartResponse extends CodexAuthState {}
export interface CodexAuthPollResponse extends CodexAuthState {}
export interface CodexAuthStatusResponse extends CodexAuthState {}
export interface CodexAuthCancelResponse extends CodexAuthState {}
export interface CodexAuthLogoutResponse extends CodexAuthState {}

export interface SavePresetResponse {
  preset: PresetDocument;
  restartRequired: boolean;
}

export interface SaveFeatureOverridesResponse {
  overrides: FeatureScopeOverrideRecord[];
}

export interface SaveToolOverridesResponse {
  overrides: ToolPolicyOverrideRecord[];
}

export interface ServiceActionResponse {
  status: BotServiceStatus;
}

export interface ClearConversationHistoryResponse {
  result: ClearConversationHistoryResult;
}

export interface DeleteConversationRoomResponse {
  result: DeleteConversationRoomResult;
}
