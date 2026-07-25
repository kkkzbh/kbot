import { z } from 'zod';
import {
  PresetDefinitionV2Schema,
  PresetIdSchema,
} from 'koishi-plugin-chatluna/preset-schema';

export type AdminJsonValue =
  | null
  | boolean
  | number
  | string
  | AdminJsonValue[]
  | { [key: string]: AdminJsonValue };

export const adminJsonValueSchema: z.ZodType<AdminJsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(adminJsonValueSchema),
  z.record(adminJsonValueSchema),
]));

export const adminErrorCodeSchema = z.enum([
  'bad_request',
  'unauthenticated',
  'forbidden_origin',
  'invalid_host',
  'not_found',
  'conflict',
  'service_unavailable',
  'internal_error',
]);

export const adminErrorSchema = z.object({
  error: z.object({
    code: adminErrorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});

export const loginRequestSchema = z.object({
  accessToken: z.string().min(1),
});

export const sessionStateSchema = z.object({
  authenticated: z.boolean(),
  expiresAt: z.number().int().nullable(),
});

export const adminLogLevelSchema = z.enum(['success', 'error', 'info', 'warn', 'debug']);

export const adminLogsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const adminLogEntrySchema = z.object({
  id: z.number().int().positive(),
  timestamp: z.number().int().positive(),
  level: adminLogLevelSchema,
  namespace: z.string(),
  content: z.string(),
});

export const adminLogsResponseSchema = z.object({
  entries: z.array(adminLogEntrySchema),
  nextCursor: z.number().int().min(0),
  truncated: z.boolean(),
});

export const serviceActionSchema = z.enum(['start', 'stop', 'restart', 'enable']);

export const serviceActionRequestSchema = z.object({
  unit: z.enum([
    'qqbot.target',
    'qqbot-pmhq.service',
    'qqbot-llbot.service',
    'qqbot-koishi.service',
    'cloudflared-qqbot-hbu-jw.service',
    'cloudflared-qqbot-genshin.service',
    'qqbot-voice-tts.service',
    'qqbot-voice-tts-tailnet.service',
  ]),
  action: serviceActionSchema,
});

export const operationalEventListQuerySchema = z.object({
  view: z.enum(['pending', 'history']).default('pending'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const operationalEventActionRequestSchema = z.object({
  action: z.enum(['acknowledge', 'retry', 'discard']),
});

export const settingsSectionSchema = z.enum(['basic', 'features', 'model']);

export const settingsChangeSchema = z.object({
  key: z.string().min(1),
  value: z.string().optional(),
  clear: z.boolean().optional(),
}).superRefine((change, context) => {
  if (change.clear === true && change.value !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'clear 与 value 不能同时提交。' });
  }
});

export const settingsPatchRequestSchema = z.object({
  changes: z.array(settingsChangeSchema).min(1),
});

export const settingsFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['toggle', 'text', 'secret', 'number']),
  section: settingsSectionSchema,
  value: z.string().nullable(),
  configured: z.boolean(),
});

export const settingsResponseSchema = z.object({
  section: settingsSectionSchema,
  fields: z.array(settingsFieldSchema),
  restartRequired: z.boolean(),
});

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  userKey: z.string().trim().min(1).optional(),
  search: z.string().trim().max(200).optional(),
});

export const memoryKindSchema = z.enum(['facts', 'episodes', 'reviews', 'jobs', 'audit']);

export const memoryMutationSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('visibility'),
    userKey: z.string().min(1),
    type: z.enum(['fact', 'episode']),
    id: z.number().int().positive(),
    visibility: z.enum(['global', 'private_only', 'source_context_only', 'allowed_contexts', 'denied_contexts', 'pending_review', 'archived']),
  }),
  z.object({
    action: z.literal('edit'),
    userKey: z.string().min(1),
    type: z.enum(['fact', 'episode']),
    id: z.number().int().positive(),
    content: z.string().trim().min(1).max(10_000),
  }),
  z.object({
    action: z.literal('forget'),
    userKey: z.string().min(1),
    type: z.enum(['fact', 'episode']).optional(),
    id: z.number().int().positive().optional(),
    topicKey: z.string().trim().min(1).optional(),
    contextKey: z.string().trim().min(1).optional(),
    all: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('review'),
    candidateId: z.number().int().positive(),
    decision: z.enum(['approve', 'reject', 'private']),
  }),
]);

export const oauthProviderSchema = z.enum(['copilot', 'codex']);
export const oauthAttemptRequestSchema = z.object({ attemptId: z.string().min(1) });

export const modelTabIdSchema = z.enum(['siliconflow', 'openai', 'codex', 'copilot', 'deepseek', 'mimo']);
export const modelRequestModeSchema = z.enum(['chat_completions', 'responses']);
export const modelStructuredOutputProtocolSchema = z.enum([
  'native_chat_json_schema',
  'native_responses_json_schema',
  'chat_reply_v1',
]);
export const modelReasoningEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh']);
export const modelAuthStatusSchema = z.enum(['unauthenticated', 'pending', 'ready', 'expired', 'error']);

export const modelListRequestSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
}).strict();

export const modelTabPatchSchema = z.object({
  id: modelTabIdSchema,
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  clearApiKey: z.boolean().optional(),
  defaultModel: z.string().trim().min(1),
  reasoningEffort: modelReasoningEffortSchema.nullable().optional(),
}).strict().superRefine((tab, context) => {
  if (tab.clearApiKey && tab.apiKey !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'clearApiKey 与 apiKey 不能同时提交。' });
  }
});

export const modelTabsPatchRequestSchema = z.object({
  activeTab: modelTabIdSchema,
  tabs: z.array(modelTabPatchSchema).min(1),
  dirtyTabIds: z.array(modelTabIdSchema).min(1),
}).strict();

export const oauthAttemptSchema = z.object({
  attemptId: z.string().min(1),
  userCode: z.string().min(1),
  verificationUri: z.string().url(),
  expiresAt: z.number().finite(),
  intervalSec: z.number().int().positive(),
  nextPollAt: z.number().finite(),
  state: z.enum(['pending', 'authorized', 'expired', 'failed', 'cancelled']),
  error: z.string().nullable(),
}).strict();

export const codexCatalogStateSchema = z.object({
  source: z.literal('dynamic'),
  status: z.enum(['ready', 'degraded', 'unavailable']),
  clientVersion: z.string().min(1).nullable(),
  fetchedAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
}).strict();

export const modelTabSchema = z.object({
  id: modelTabIdSchema,
  title: z.string().min(1),
  provider: z.enum(['siliconflow', 'openai', 'deepseek', 'mimo']),
  strategyId: z.enum([
    'siliconflow-kimi-main-chat',
    'openai-gpt54-main-chat',
    'codex-chatgpt-oauth-main-chat',
    'copilot-github-oauth-main-chat',
    'deepseek-official-main-chat',
    'mimo-official-main-chat',
  ]),
  requestMode: modelRequestModeSchema,
  structuredOutputProtocol: modelStructuredOutputProtocolSchema,
  description: z.string(),
  modelHint: z.string(),
  authKind: z.enum(['manual', 'oauth_device', 'codex_oauth']),
  authStatus: modelAuthStatusSchema,
  accountLabel: z.string().nullable().optional(),
  authError: z.string().nullable().optional(),
  tokenExpiresAt: z.number().finite().nullable().optional(),
  oauthAttempt: oauthAttemptSchema.nullable().optional(),
  catalog: codexCatalogStateSchema.nullable().optional(),
  baseUrl: z.string(),
  apiKey: z.null(),
  apiKeyConfigured: z.boolean(),
  defaultModel: z.string().min(1),
  reasoningEffort: modelReasoningEffortSchema.nullable().optional(),
  canonicalModel: z.string().min(1).optional(),
  transportModel: z.string().min(1).optional(),
}).strict();

export const modelTabsResponseSchema = z.object({
  activeTab: modelTabIdSchema,
  tabs: z.array(modelTabSchema),
}).strict();

export const modelOptionSchema = z.object({
  modelId: z.string().min(1),
  label: z.string().min(1),
  rateLabel: z.string().min(1).optional(),
  requestMode: modelRequestModeSchema.optional(),
  structuredOutputProtocol: modelStructuredOutputProtocolSchema.optional(),
  metadataTags: z.array(z.string().min(1)).optional(),
  deprecated: z.boolean().optional(),
  deprecationDate: z.string().min(1).optional(),
}).strict();

export const modelListResponseSchema = z.object({
  source: z.enum(['dynamic', 'static']),
  models: z.array(modelOptionSchema),
  error: z.string().nullable(),
  catalog: codexCatalogStateSchema.optional(),
}).strict();

export const adminApplyStateSchema = z.object({
  restartRequired: z.boolean(),
  reasons: z.array(z.enum(['basic', 'features', 'model', 'preset', 'tts'])),
}).strict();

export const saveModelsResponseSchema = z.object({
  modelTabs: modelTabsResponseSchema,
  hotSwitched: z.boolean(),
  restartRequired: z.boolean(),
  restartReason: z.string().nullable(),
  apply: adminApplyStateSchema,
}).strict();

export const oauthMutationResponseSchema = z.object({
  authKind: z.enum(['oauth_device', 'codex_oauth']),
  authStatus: modelAuthStatusSchema,
  accountLabel: z.string().nullable(),
  authError: z.string().nullable(),
  tokenExpiresAt: z.number().finite().nullable().optional(),
  attempt: oauthAttemptSchema.nullable(),
}).strict();

export const emptyRequestSchema = z.object({}).strict();
export const emptyResponseSchema = z.void();

export const presetIdSchema = PresetIdSchema;
export const presetDefinitionV2Schema = PresetDefinitionV2Schema;
export const presetSourceSchema = z.enum(['bundled', 'runtime']);
export const presetSummarySchema = z.object({
  id: presetIdSchema,
  displayName: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1)),
  source: presetSourceSchema,
  hasOverride: z.boolean(),
  revision: z.string().min(1),
  isGlobalDefault: z.boolean(),
}).strict();
export const presetCatalogResponseSchema = z.object({
  presets: z.array(presetSummarySchema),
  globalDefaultPresetId: presetIdSchema,
}).strict();
export const presetDetailResponseSchema = z.object({
  preset: PresetDefinitionV2Schema,
  source: presetSourceSchema,
  hasOverride: z.boolean(),
  revision: z.string().min(1),
}).strict();
export const presetCreateRequestSchema = z.object({
  preset: PresetDefinitionV2Schema,
}).strict();
export const presetUpdateRequestSchema = z.object({
  preset: PresetDefinitionV2Schema,
  expectedRevision: z.string().min(1),
}).strict();
export const presetRevisionRequestSchema = z.object({
  expectedRevision: z.string().min(1),
}).strict();
export const presetDefaultRequestSchema = z.object({
  id: presetIdSchema,
}).strict();
export const presetDefaultResponseSchema = z.object({
  globalDefaultPresetId: presetIdSchema,
}).strict();

export const contextBlueprintSourceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  path: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  purpose: z.string().min(1).optional(),
  content: adminJsonValueSchema.optional(),
}).strict();
export const contextBlueprintSectionSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().min(0),
  label: z.string().min(1),
  description: z.string().min(1),
  dynamic: z.boolean(),
  sources: z.array(contextBlueprintSourceSchema),
}).strict();
export const contextBlueprintQuerySchema = z.object({
  presetId: presetIdSchema,
}).strict();
export const contextBlueprintResponseSchema = z.object({
  presetId: presetIdSchema,
  presetRevision: z.string().min(1),
  sections: z.array(contextBlueprintSectionSchema),
}).strict();

export const presetResolutionSchema = z.object({
  source: z.enum([
    'fixed',
    'conversation',
    'presetLane',
    'constraintDefault',
    'globalDefault',
  ]),
  presetId: presetIdSchema,
  bindingKey: z.string().min(1),
}).strict();

export const contextTargetSchema = z.object({
  conversationId: z.string().min(1),
  roomId: z.number().int().positive().optional(),
  label: z.string().min(1),
  scope: z.string().min(1).optional(),
}).strict();
export const contextTargetsResponseSchema = z.object({
  targets: z.array(contextTargetSchema),
}).strict();

export const contextSnapshotMessageSchema = z.object({
  id: z.string().min(1),
  index: z.number().int().min(0),
  role: z.string().min(1),
  purpose: z.string().min(1).optional(),
  content: adminJsonValueSchema,
  stage: z.string().min(1),
  source: z.string().min(1),
  sourcePath: z.string().min(1).optional(),
  authority: z.string().min(1).optional(),
  trust: z.string().min(1).optional(),
  ttl: z.string().min(1).optional(),
  estimatedTokens: z.number().int().min(0),
  included: z.boolean(),
  dropReason: z.string().min(1).nullable().optional(),
}).strict();
export const contextSnapshotToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  schema: adminJsonValueSchema.optional(),
}).strict();
export const contextSnapshotSchema = z.object({
  requestId: z.string().min(1),
  callId: z.string().min(1),
  callOrdinal: z.number().int().positive(),
  conversationId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  platform: z.string().min(1),
  model: z.string().min(1),
  transportModel: z.string().min(1).nullable().optional(),
  requestMode: z.enum(['chat_completions', 'responses']).nullable().optional(),
  stream: z.boolean(),
  semanticStage: z.literal('before_provider_serialization'),
  effectivePresetId: presetIdSchema.nullable().optional(),
  presetResolution: presetResolutionSchema,
  presetRevision: z.string().min(1).nullable().optional(),
  contextSize: z.number().int().nonnegative().nullable().optional(),
  contextRatio: z.number().min(0).nullable().optional(),
  contextLimit: z.number().int().positive(),
  modelContextSize: z.number().int().positive(),
  estimatedTokens: z.number().int().nonnegative(),
  providerInputTokens: z.number().int().nonnegative().nullable().optional(),
  providerOutputTokens: z.number().int().nonnegative().nullable().optional(),
  providerUsageEstimated: z.boolean().nullable().optional(),
  assembledCount: z.number().int().nonnegative(),
  finalCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  messages: z.array(contextSnapshotMessageSchema),
  tools: z.array(contextSnapshotToolSchema),
}).strict();
export const contextSnapshotResponseSchema = z.object({
  snapshot: contextSnapshotSchema.nullable(),
  unavailableReason: z.string().min(1).nullable().optional(),
}).strict();

export const modelRuntimeStateSchema = z.object({
  configuredModel: z.string().min(1).nullable(),
  liveModel: z.string().min(1).nullable(),
  transportModel: z.string().min(1).nullable(),
  requestMode: z.enum(['chat_completions', 'responses']).nullable(),
  modelContextSize: z.number().int().positive().nullable(),
  contextLimit: z.number().int().positive().nullable(),
  pending: z.boolean(),
  pendingReason: z.string().min(1).nullable(),
  updatedAt: z.string().datetime().nullable(),
}).strict();

export const ttsSampleRequestSchema = z.object({
  text: z.string().trim().min(1).max(500),
  style: z.enum(['white', 'black']),
});

export const featureOverridesRequestSchema = z.object({ overrides: z.array(z.unknown()) });
export const toolOverridesRequestSchema = z.object({ overrides: z.array(z.unknown()) });
export const affinitySettingsRequestSchema = z.object({
  settings: z.record(z.unknown()),
  analysisModelApiKey: z.string().optional(),
  clearAnalysisModelApiKey: z.boolean().optional(),
}).superRefine((input, context) => {
  if (input.analysisModelApiKey !== undefined && input.clearAnalysisModelApiKey) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'clearAnalysisModelApiKey 与 analysisModelApiKey 不能同时提交。' });
  }
});
export const affinityWhitelistRequestSchema = z.object({ scopes: z.array(z.unknown()) });
export const affinityAdjustRequestSchema = z.object({
  userKey: z.string().min(1),
  reason: z.string().trim().min(1),
  trust: z.number().optional(),
  familiarity: z.number().optional(),
  comfort: z.number().optional(),
  tension: z.number().optional(),
});

export const conversationTargetRequestSchema = z.object({
  roomId: z.number().int().positive(),
  conversationId: z.string().min(1),
});

export type AdminError = z.infer<typeof adminErrorSchema>;
export type AdminLogEntry = z.infer<typeof adminLogEntrySchema>;
export type AdminLogsResponse = z.infer<typeof adminLogsResponseSchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;
export type SettingsField = z.infer<typeof settingsFieldSchema>;
export type SettingsSection = z.infer<typeof settingsSectionSchema>;
export type SettingsPatchRequest = z.infer<typeof settingsPatchRequestSchema>;
export type MemoryKind = z.infer<typeof memoryKindSchema>;
export type MemoryMutation = z.infer<typeof memoryMutationSchema>;
export type OperationalEventListQuery = z.infer<typeof operationalEventListQuerySchema>;
export type OperationalEventActionRequest = z.infer<typeof operationalEventActionRequestSchema>;
export type ModelTabId = z.infer<typeof modelTabIdSchema>;
export type ModelRequestMode = z.infer<typeof modelRequestModeSchema>;
export type ModelReasoningEffort = z.infer<typeof modelReasoningEffortSchema>;
export type ModelAuthStatus = z.infer<typeof modelAuthStatusSchema>;
export type OAuthAttempt = z.infer<typeof oauthAttemptSchema>;
export type CodexCatalogState = z.infer<typeof codexCatalogStateSchema>;
export type ModelTab = z.infer<typeof modelTabSchema>;
export type ModelTabsResponse = z.infer<typeof modelTabsResponseSchema>;
export type ModelOption = z.infer<typeof modelOptionSchema>;
export type ModelListResponse = z.infer<typeof modelListResponseSchema>;
export type ModelTabPatch = z.infer<typeof modelTabPatchSchema>;
export type SaveModelsResponse = z.infer<typeof saveModelsResponseSchema>;
export type OAuthMutationResponse = z.infer<typeof oauthMutationResponseSchema>;
export type PresetDefinitionV2 = z.infer<typeof PresetDefinitionV2Schema>;
export type PresetSource = z.infer<typeof presetSourceSchema>;
export type PresetSummary = z.infer<typeof presetSummarySchema>;
export type PresetCatalogResponse = z.infer<typeof presetCatalogResponseSchema>;
export type PresetDetailResponse = z.infer<typeof presetDetailResponseSchema>;
export type PresetCreateRequest = z.infer<typeof presetCreateRequestSchema>;
export type PresetUpdateRequest = z.infer<typeof presetUpdateRequestSchema>;
export type PresetRevisionRequest = z.infer<typeof presetRevisionRequestSchema>;
export type PresetDefaultRequest = z.infer<typeof presetDefaultRequestSchema>;
export type PresetDefaultResponse = z.infer<typeof presetDefaultResponseSchema>;
export type ContextBlueprintSource = z.infer<typeof contextBlueprintSourceSchema>;
export type ContextBlueprintSection = z.infer<typeof contextBlueprintSectionSchema>;
export type ContextBlueprintResponse = z.infer<typeof contextBlueprintResponseSchema>;
export type PresetResolution = z.infer<typeof presetResolutionSchema>;
export type ContextTarget = z.infer<typeof contextTargetSchema>;
export type ContextTargetsResponse = z.infer<typeof contextTargetsResponseSchema>;
export type ContextSnapshotMessage = z.infer<typeof contextSnapshotMessageSchema>;
export type ContextSnapshotTool = z.infer<typeof contextSnapshotToolSchema>;
export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;
export type ContextSnapshotResponse = z.infer<typeof contextSnapshotResponseSchema>;
export type ModelRuntimeState = z.infer<typeof modelRuntimeStateSchema>;

export interface OperationalEventBulkAcknowledgeResult {
  acknowledgedCount: number;
}

export type {
  BotServiceStatus,
  BotServiceRuntimeState,
  BotServiceUnit,
  OperationalEventAction,
  OperationalEventDetail,
  OperationalEventItem,
  OperationalEventPage,
} from '../../types/admin.js';
