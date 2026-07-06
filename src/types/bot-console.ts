import type {
  MemoryJobStatus,
  MemoryJobType,
  MemoryOutputProtocolId,
  MemoryProfileKind,
  MemoryRecordType,
  MemorySensitivity,
  MemoryProbeResult,
  MemoryStatusSnapshot,
  MemoryVisibility,
} from './memory.js';
import type {
  ClearConversationHistoryResult,
  ClearConversationHistoryTarget,
  ConsoleFeatureScope,
  DeleteConversationRoomResult,
  DeleteConversationRoomTarget,
  FeatureOverrideInput,
  FeatureScopeOverrideRecord,
} from './feature-policy.js';
import type {
  BotConsoleToolPolicyState,
  ToolOverrideInput,
  ToolOverrideRecord,
} from './tool-policy.js';
import type {
  AffinityMutationResponse,
  AffinitySettings,
  AffinityStateSummary,
  AffinityWhitelistInput,
} from './affinity.js';

export type ServiceAction = 'start' | 'stop' | 'restart' | 'enable';

export type BotServiceUnit =
  | 'qqbot.target'
  | 'qqbot-pmhq.service'
  | 'qqbot-llbot.service'
  | 'qqbot-koishi.service'
  | 'cloudflared-qqbot-hbu-jw.service'
  | 'qqbot-voice-tts.service'
  | 'qqbot-voice-tts-tailnet.service';

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

export interface EnvPatch {
  [key: string]: string | null | undefined;
}

export type PresetSource = 'runtime' | 'bundled';

export interface BotConsoleEnvFilesState {
  mode: 'single' | 'layered';
  baseFile: string | null;
  overrideFile: string | null;
  editTarget: string;
}

export interface PresetPrompt {
  role: 'system' | 'user' | 'assistant' | 'tool';
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

export type BotConsoleModelTabId = 'siliconflow' | 'openai' | 'codex' | 'copilot' | 'deepseek' | 'mimo';
export type BotConsoleAuthKind = 'manual' | 'oauth_device' | 'codex_oauth';
export type BotConsoleAuthStatus = 'unauthenticated' | 'pending' | 'ready' | 'expired' | 'error';
export type BotConsoleModelListSource = 'dynamic' | 'static';

export interface CopilotAuthAttempt {
  attemptId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSec: number;
  nextPollAt: number;
  state: 'pending' | 'authorized' | 'expired' | 'failed' | 'cancelled';
  error: string | null;
}

export interface CodexAuthAttempt {
  attemptId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSec: number;
  nextPollAt: number;
  state: 'pending' | 'authorized' | 'expired' | 'failed' | 'cancelled';
  error: string | null;
}

export interface BotConsoleBuiltinModelTab {
  id: BotConsoleModelTabId;
  title: string;
  provider: 'siliconflow' | 'openai' | 'deepseek' | 'mimo';
  strategyId: 'siliconflow-kimi-main-chat' | 'openai-gpt54-main-chat' | 'codex-chatgpt-oauth-main-chat' | 'copilot-github-oauth-main-chat' | 'deepseek-official-main-chat' | 'mimo-official-main-chat';
  requestMode: 'chat_completions' | 'responses';
  structuredOutputProtocol: 'native_chat_json_schema' | 'native_responses_json_schema' | 'chat_reply_v1';
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
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | null;
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
  requestMode?: 'chat_completions' | 'responses';
  structuredOutputProtocol?: 'native_chat_json_schema' | 'native_responses_json_schema' | 'chat_reply_v1';
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

export type BotConsoleTtsHealthStatus = 'unknown' | 'ok' | 'degraded' | 'unreachable';
export type BotConsoleTtsStyleId = 'white' | 'black';

export interface BotConsoleTtsStyleConfig {
  id: BotConsoleTtsStyleId;
  refAudioPath: string;
  promptText: string;
  promptLang: string;
}

export interface BotConsoleTtsLocalGatewayState {
  provider: 'gpt-sovits';
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

export interface SaveTtsSettingsRequest {
  botEnv?: EnvPatch;
  localEnv?: EnvPatch;
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
    format: 'wav';
    durationSeconds: number | null;
    sampleRate: number | null;
    channels: number | null;
  };
}

export interface BotConsoleState {
  env: Record<string, string>;
  envFiles: BotConsoleEnvFilesState;
  services: BotServiceStatus[];
  presets: PresetSummary[];
  defaultPreset: string;
  featureScopes: ConsoleFeatureScope[];
  featureOverrides: FeatureScopeOverrideRecord[];
  conversationTargets: import('./feature-policy.js').ConversationTarget[];
  affinity: AffinityStateSummary;
  toolPolicy: BotConsoleToolPolicyState;
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
  candidateType: 'fact' | 'episode' | 'drop';
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
  providerRoutes: MemoryStatusSnapshot['providerRoutes'];
  recentFailures: string[];
}

export interface BotConsoleBaseState {
  env: Record<string, string>;
  envFiles: BotConsoleEnvFilesState;
  services: BotServiceStatus[];
  presets: PresetSummary[];
  defaultPreset: string;
}

export interface BotConsoleProbeResult {
  target: 'embedding' | 'extraction' | 'provider';
  memory: MemoryProbeResult;
}

export interface GetMemoryStateResponse extends BotConsoleMemoryState {}

export interface BotConsoleMemoryMutationResponse {
  ok: boolean;
  memory: BotConsoleMemoryState;
}

export interface SaveAffinitySettingsRequest {
  settings: Partial<AffinitySettings>;
}

export interface SaveAffinityWhitelistRequest {
  scopes: AffinityWhitelistInput[];
}

export interface AdjustAffinityUserRequest {
  userKey: string;
  reason: string;
  trust?: number;
  familiarity?: number;
  comfort?: number;
  tension?: number;
}

export interface SaveAffinitySettingsResponse extends AffinityMutationResponse {}
export interface SaveAffinityWhitelistResponse extends AffinityMutationResponse {}
export interface AdjustAffinityUserResponse extends AffinityMutationResponse {}

export interface BotConsoleMemoryVisibilityRequest {
  userKey: string;
  type: MemoryRecordType;
  id: number;
  visibility: MemoryVisibility;
}

export interface BotConsoleMemoryEditRequest {
  userKey: string;
  type: MemoryRecordType;
  id: number;
  content: string;
}

export interface BotConsoleMemoryForgetRequest {
  userKey: string;
  type?: MemoryRecordType;
  id?: number;
  topicKey?: string;
  contextKey?: string;
  all?: boolean;
}

export interface BotConsoleMemoryReviewRequest {
  candidateId: number;
  action: 'approve' | 'reject' | 'private';
}

export interface SaveModelTabsRequest {
  activeTab: BotConsoleModelTabId;
  tabs: BotConsoleBuiltinModelTab[];
  /**
   * IDs of tabs whose fields the user actually edited in this save.
   * The server validates only these (plus the active tab); untouched tabs are accepted as-is so a
   * stale model value somewhere else doesn't block an unrelated change.
   */
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
  authKind: 'oauth_device';
  authStatus: BotConsoleAuthStatus;
  accountLabel: string | null;
  authError: string | null;
  attempt: CopilotAuthAttempt | null;
}

export interface CodexAuthState {
  authKind: 'codex_oauth';
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

export interface SaveFeatureOverridesRequest {
  overrides: FeatureOverrideInput[];
}

export interface SaveFeatureOverridesResponse {
  overrides: FeatureScopeOverrideRecord[];
}

export interface SaveToolOverridesRequest {
  overrides: ToolOverrideInput[];
}

export interface SaveToolOverridesResponse {
  overrides: ToolOverrideRecord[];
}

export interface ClearConversationHistoryRequest extends ClearConversationHistoryTarget {}

export interface ClearConversationHistoryResponse {
  result: ClearConversationHistoryResult;
}

export interface DeleteConversationRoomRequest extends DeleteConversationRoomTarget {}

export interface DeleteConversationRoomResponse {
  result: DeleteConversationRoomResult;
}
