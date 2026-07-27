import type {
  MemoryJobStatus,
  MemoryJobType,
  MemoryOutputProtocolId,
  MemoryProfileKind,
  MemoryRecordType,
  MemorySensitivity,
  MemoryVisibility,
} from './memory.js';
import type {
  ClearConversationHistoryResult,
  ClearConversationHistoryTarget,
  DeleteConversationRoomResult,
  DeleteConversationRoomTarget,
  FeatureOverrideInput,
  FeatureScopeOverrideRecord,
} from './feature-policy.js';
import type {
  ToolOverrideInput,
  ToolOverrideRecord,
} from './tool-policy.js';
import type {
  AffinityMutationResponse,
  AffinitySettings,
  AffinityWhitelistInput,
} from './affinity.js';

export type ServiceAction = 'start' | 'stop' | 'restart' | 'enable';

export type BotServiceRuntimeState = 'healthy' | 'degraded' | 'stopped' | 'unknown';

export type AdminApplyReason = 'basic' | 'features' | 'tts';

export type BotServiceUnit =
  | 'qqbot.target'
  | 'qqbot-pmhq.service'
  | 'qqbot-llbot.service'
  | 'qqbot-koishi.service'
  | 'cloudflared-qqbot-hbu-jw.service'
  | 'cloudflared-qqbot-genshin.service'
  | 'qqbot-voice-tts.service'
  | 'qqbot-voice-tts-tailnet.service';

export interface BotServiceStatus {
  unit: BotServiceUnit;
  description: string;
  runtimeState: BotServiceRuntimeState;
  controllerState: {
    loadState: string;
    activeState: string;
    subState: string;
    unitFileState: string;
    result: string;
    invocationId: string | null;
  };
  checkedAt: number;
  healthDetail: string;
  canStart: boolean;
  canStop: boolean;
  canRestart: boolean;
  canEnable: boolean;
}

export interface AdminApplyRestartTarget {
  unit: BotServiceUnit;
  previousInvocationId: string | null;
}

export type OperationalEventSource = 'systemd' | 'memory' | 'runtime';
export type OperationalEventType =
  | 'service_start_failed'
  | 'service_controller_mismatch'
  | 'memory_job_dead_letter'
  | 'memory_review_required'
  | 'runtime_exception'
  | 'runtime_warning';
export type OperationalEventSeverity = 'warning' | 'error';
export type OperationalEventStatus = 'open' | 'acknowledged' | 'resolved';
export type OperationalEventResolution =
  | 'recovered'
  | 'retried'
  | 'discarded'
  | 'completed'
  | 'deduplicated'
  | null;
export type OperationalEventAction = 'acknowledge' | 'retry' | 'discard';

export interface OperationalEventItem {
  id: number;
  sourceKey: string;
  source: OperationalEventSource;
  type: OperationalEventType;
  severity: OperationalEventSeverity;
  status: OperationalEventStatus;
  resolution: OperationalEventResolution;
  title: string;
  summary: string;
  component: string | null;
  fingerprint: string | null;
  details: string;
  occurrenceCount: number;
  unit: BotServiceUnit | null;
  invocationId: string | null;
  memoryJobId: number | null;
  memoryCandidateId: number | null;
  occurredAt: number;
  lastOccurredAt: number;
  acknowledgedAt: number | null;
  resolvedAt: number | null;
  updatedAt: number;
  availableActions: OperationalEventAction[];
  targetPath: string;
}

export interface OperationalEventPage {
  items: OperationalEventItem[];
  total: number;
  openCount: number;
  page: number;
  pageSize: number;
}

export interface OperationalEventOccurrence {
  id: number;
  summary: string;
  details: string;
  occurrenceCount: number;
  unit: BotServiceUnit | null;
  invocationId: string | null;
  firstOccurredAt: number;
  lastOccurredAt: number;
}

export interface OperationalEventDetail extends OperationalEventItem {
  occurrences: OperationalEventOccurrence[];
  journal: string[];
}

export interface EnvPatch {
  [key: string]: string | null | undefined;
}

export interface AdminEnvFilesState {
  mode: 'single' | 'layered';
  baseFile: string | null;
  overrideFile: string | null;
  editTarget: string;
}

export type AdminAuthStatus = 'unauthenticated' | 'pending' | 'ready' | 'expired' | 'error';
export type CodexCatalogSyncStatus = 'ready' | 'degraded' | 'unavailable';

export interface CodexCatalogState {
  source: 'dynamic';
  status: CodexCatalogSyncStatus;
  clientVersion: string | null;
  fetchedAt: string | null;
  error: string | null;
}

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

export type AdminTtsHealthStatus = 'unknown' | 'ok' | 'degraded' | 'unreachable';
export type AdminTtsStyleId = 'white' | 'black';

export interface AdminTtsStyleConfig {
  id: AdminTtsStyleId;
  refAudioPath: string;
  promptText: string;
  promptLang: string;
}

export interface AdminTtsLocalGatewayState {
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
    styles: AdminTtsStyleConfig[];
  };
}

export interface AdminTtsHealthSnapshot {
  status: AdminTtsHealthStatus;
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

export interface AdminTtsState {
  localGateway: AdminTtsLocalGatewayState;
  health: AdminTtsHealthSnapshot;
}

export interface SaveTtsSettingsRequest {
  botEnv?: EnvPatch;
  localEnv?: EnvPatch;
}

export interface SaveTtsSettingsResponse {
  env: Record<string, string>;
  tts: AdminTtsState;
  restartRequired: {
    bot: boolean;
    tts: boolean;
  };
}

export interface ProbeTtsHealthResponse {
  health: AdminTtsHealthSnapshot;
}

export interface SynthesizeTtsSampleRequest {
  text: string;
  style: AdminTtsStyleId;
}

export interface AdminMemoryUserItem {
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

export interface AdminMemoryFactItem {
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

export interface AdminMemoryEpisodeItem {
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

export interface AdminMemoryPendingReviewItem {
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

export interface AdminMemoryJobItem {
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

export interface AdminMemoryAuditItem {
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

export interface AdminMemorySummary {
  userCount: number;
  factCount: number;
  episodeCount: number;
  pendingReviewCount: number;
  pendingJobs: number;
  processingJobs: number;
  deadLetterJobs: number;
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

export interface CopilotAuthState {
  authKind: 'oauth_device';
  authStatus: AdminAuthStatus;
  accountLabel: string | null;
  authError: string | null;
  attempt: CopilotAuthAttempt | null;
}

export interface CodexAuthState {
  authKind: 'codex_oauth';
  authStatus: AdminAuthStatus;
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
