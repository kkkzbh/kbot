import { z } from 'zod';
import {
  ContextPresetDefinitionV1Schema,
  ContextPresetBlockSchema,
  PresetIdSchema,
  RolePresetDefinitionV1Schema,
} from 'koishi-plugin-chatluna/preset-schema';
import {
  connectionIdSchema,
  modelConfigAggregateSchema,
  modelConfigDraftSchema,
  modelConfigPutSchema,
  modelIdSchema,
  type ModelConfigAggregate,
  type ModelConfigDraft,
  type ModelConfigPutInput,
} from '../../plugins/model-config/types.js';
import {
  NATURAL_TRIGGER_CONFIG_SCHEMA_VERSION,
  naturalTriggerConfigPutSchema,
  naturalTriggerConfigSchema,
} from '../../plugins/natural-trigger-config/types.js';

export * from './memory.js';

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
  'unauthorized',
  'forbidden_origin',
  'invalid_host',
  'not_found',
  'conflict',
  'provider_auth_required',
  'memory_error',
  'upstream_error',
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
  action: z.enum(['acknowledge', 'retry']),
});

export const settingsSectionSchema = z.enum(['features']);

export const voiceFeatureSettingKeys = [
  'QQ_VOICE_INPUT_ENABLED',
  'QQ_VOICE_OUTPUT_ENABLED',
  'QQ_VOICE_TTS_BASE_URL',
  'QQ_VOICE_TTS_API_KEY',
  'QQ_VOICE_OUTPUT_LANGUAGE',
  'QQ_VOICE_OUTPUT_MAX_WORDS',
  'QQ_VOICE_OUTPUT_MAX_SECONDS',
  'QQ_VOICE_SYNTH_TIMEOUT_MS',
] as const;

export const fileSystemToolSettingKeys = [
  'CHATLUNA_COMMON_FS_ALLOWED_GROUPS',
  'CHATLUNA_COMMON_FS',
  'CHATLUNA_COMMON_FS_SCOPE_PATH',
] as const;

export const memoryFeatureSettingKeys = [
  'MEMORY_ENABLED',
  'MEMORY_READ_ENABLED',
  'MEMORY_WRITE_ENABLED',
  'MEMORY_EXTRACT_IDLE_MS',
  'MEMORY_EXTRACT_MESSAGE_BATCH',
  'MEMORY_ARCHIVE_DAYS',
  'MEMORY_MAX_JOB_RETRIES',
  'MEMORY_JOB_LOCK_TIMEOUT_MS',
] as const;

export { naturalTriggerConfigPutSchema, naturalTriggerConfigSchema };

export const naturalTriggerDecisionBindingSchema = z.object({
  mode: z.enum(['dedicated', 'disabled']),
  canonicalModel: z.string().nullable(),
  displayName: z.string().nullable(),
  available: z.boolean(),
  compatible: z.boolean(),
}).strict();

export const naturalTriggerAdminResponseSchema = z.object({
  schemaVersion: z.literal(NATURAL_TRIGGER_CONFIG_SCHEMA_VERSION),
  savedRevision: z.number().int().positive(),
  appliedRevision: z.number().int().nonnegative(),
  pending: z.boolean(),
  updatedAt: z.string().datetime(),
  config: naturalTriggerConfigSchema,
  groupOptions: z.array(z.object({
    groupId: z.string().min(1),
    roomName: z.string().min(1),
  }).strict()),
  decisionBinding: naturalTriggerDecisionBindingSchema,
  voiceInputEnabled: z.boolean(),
  restartRequired: z.boolean(),
  reasons: z.array(z.enum(['features', 'tts', 'naturalTrigger'])),
}).strict();
export type NaturalTriggerAdminResponse = z.infer<typeof naturalTriggerAdminResponseSchema>;

export const runtimeFeatureSettingKeys = [
  'QQBOT_REALTIME_MESSAGE_ENABLED',
  'QQBOT_REALTIME_MESSAGE_MAX_INJECT_COUNT',
  'QQBOT_REPLY_INTERRUPT_ENABLED',
] as const;

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

export const modelConnectionAuthStateSchema = z.object({
  connectionId: connectionIdSchema,
  status: z.enum(['not_required', 'unauthenticated', 'pending', 'ready', 'expired', 'error']),
  accountLabel: z.string().nullable(),
  error: z.string().nullable(),
  tokenExpiresAt: z.number().finite().nullable(),
  attempt: oauthAttemptSchema.nullable(),
}).strict();

export const modelAdminAggregateSchema = modelConfigAggregateSchema.extend({
  connectionStates: z.array(modelConnectionAuthStateSchema),
}).strict();

export const modelConnectionProbeResponseSchema = z.object({
  connectionId: connectionIdSchema,
  status: z.literal('ready'),
  checkedAt: z.string().datetime(),
  latencyMs: z.number().int().nonnegative(),
}).strict();

export const modelCatalogEntrySchema = z.object({
  transportModel: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  requestMode: z.enum(['chat_completions', 'responses']).nullable(),
  structuredOutputProtocol: z.enum([
    'native_chat_json_schema',
    'native_responses_json_schema',
    'chat_reply_v1',
    'json_mode',
  ]).nullable(),
  metadataTags: z.array(z.string().trim().min(1)),
}).strict();

export const modelCatalogResponseSchema = z.object({
  connectionId: connectionIdSchema,
  fetchedAt: z.string().datetime(),
  models: z.array(modelCatalogEntrySchema),
}).strict();

export const modelOAuthPollRequestSchema = z.object({
  attemptId: z.string().trim().min(1),
}).strict();

export const modelApplyRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
}).strict();

export const modelApplyResponseSchema = z.object({
  accepted: z.literal(true),
  savedRevision: z.number().int().positive(),
  target: z.object({
    unit: z.literal('qqbot-koishi.service'),
    previousInvocationId: z.string().nullable(),
  }).strict(),
}).strict();

export const stickerIndexMaintenanceResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  model: z.string().trim().min(1),
  indexed: z.number().int().nonnegative(),
  reused: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict();

export {
  connectionIdSchema,
  modelConfigAggregateSchema,
  modelConfigDraftSchema,
  modelConfigPutSchema,
  modelIdSchema,
};

export const emptyRequestSchema = z.object({}).strict();
export const emptyResponseSchema = z.void();

export const presetIdSchema = PresetIdSchema;
export const presetSourceSchema = z.enum(['bundled', 'runtime']);
export const rolePresetDefinitionV1Schema = RolePresetDefinitionV1Schema;
function rejectChatLunaLongMemoryBlock(
  preset: z.infer<typeof ContextPresetDefinitionV1Schema>,
  context: z.RefinementCtx,
): void {
  const index = preset.blocks.findIndex((block) => block.type === 'longMemory');
  if (index >= 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['blocks', index, 'type'],
      message: 'QQBot context presets do not support the ChatLuna longMemory block',
    });
  }
}

export const contextPresetDefinitionV1Schema = ContextPresetDefinitionV1Schema
  .superRefine(rejectChatLunaLongMemoryBlock);
export const contextPresetBlockSchema = ContextPresetBlockSchema.refine(
  (block) => block.type !== 'longMemory',
  { message: 'QQBot context presets do not support the ChatLuna longMemory block' },
);

export const contextPresetSummarySchema = z.object({
  id: presetIdSchema,
  displayName: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1)),
  source: presetSourceSchema,
  hasOverride: z.boolean(),
  revision: z.string().min(1),
  isGlobalDefault: z.boolean(),
}).strict();
export const contextPresetCatalogResponseSchema = z.object({
  contextPresets: z.array(contextPresetSummarySchema),
  globalDefaultContextPresetId: presetIdSchema,
}).strict();
export const contextPresetDetailResponseSchema = z.object({
  contextPreset: contextPresetDefinitionV1Schema,
  source: presetSourceSchema,
  hasOverride: z.boolean(),
  revision: z.string().min(1),
}).strict();
export const contextPresetCreateRequestSchema = z.object({
  contextPreset: contextPresetDefinitionV1Schema,
}).strict();
export const contextPresetUpdateRequestSchema = z.object({
  contextPreset: contextPresetDefinitionV1Schema,
  expectedRevision: z.string().min(1),
}).strict();
export const presetRevisionRequestSchema = z.object({
  expectedRevision: z.string().min(1),
}).strict();
export const contextPresetDefaultRequestSchema = z.object({
  id: presetIdSchema,
}).strict();
export const contextPresetDefaultResponseSchema = z.object({
  globalDefaultContextPresetId: presetIdSchema,
}).strict();

export const promptFragmentPolicyConfigSchema = z.object({
  relationshipState: z.boolean(),
  attachmentReferences: z.boolean(),
  nativeCapabilities: z.boolean(),
}).strict();
export const promptFragmentPolicyStateSchema = z.object({
  contextPresetId: presetIdSchema,
  revision: z.number().int().nonnegative(),
  source: z.enum(['default', 'override']),
  updatedAt: z.string().datetime().nullable(),
  config: promptFragmentPolicyConfigSchema,
}).strict();
export const promptFragmentPolicyPutRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  config: promptFragmentPolicyConfigSchema,
}).strict();
export const promptFragmentPolicyResetRequestSchema = z.object({
  expectedRevision: z.coerce.number().int().nonnegative(),
}).strict();

export const contextPresetDraftDefinitionV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: presetIdSchema,
  displayName: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1)),
  blocks: z.array(contextPresetBlockSchema).min(3),
}).strict().superRefine(rejectChatLunaLongMemoryBlock);

export const rolePresetSummarySchema = z.object({
  id: presetIdSchema,
  displayName: z.string().trim().min(1),
  source: presetSourceSchema,
  hasOverride: z.boolean(),
  revision: z.string().min(1),
  referenceCount: z.number().int().nonnegative(),
}).strict();
export const rolePresetCatalogResponseSchema = z.object({
  rolePresets: z.array(rolePresetSummarySchema),
}).strict();
export const rolePresetDetailResponseSchema = z.object({
  rolePreset: RolePresetDefinitionV1Schema,
  source: presetSourceSchema,
  hasOverride: z.boolean(),
  revision: z.string().min(1),
  referenceCount: z.number().int().nonnegative(),
}).strict();
export const rolePresetCreateRequestSchema = z.object({
  rolePreset: RolePresetDefinitionV1Schema,
}).strict();
export const rolePresetUpdateRequestSchema = z.object({
  rolePreset: RolePresetDefinitionV1Schema,
  expectedRevision: z.string().min(1),
}).strict();

export const resolvedContextBlockSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    'role',
    'chatHistory',
    'requestDocuments',
    'lore',
    'authorsNote',
    'knowledge',
    'currentInput',
    'agentScratchpad',
    'modelOutput',
    'qqbotFragments',
    'toolDefinitions',
  ]),
  source: z.enum(['stored', 'runtime']),
  owner: z.enum(['context', 'role', 'runtime']),
  locked: z.boolean(),
  movable: z.boolean(),
  enabled: z.boolean(),
  staticTokens: z.number().int().nonnegative().nullable(),
  budget: z.object({
    priority: z.number().int().nonnegative(),
    maxTokens: z.number().int().positive().nullable(),
  }).strict().nullable(),
  legalDropRange: z.object({
    minIndex: z.number().int().nonnegative(),
    maxIndex: z.number().int().nonnegative(),
  }).strict().nullable(),
}).strict();
export const contextPresetPreviewRequestSchema = z.object({
  contextPreset: contextPresetDraftDefinitionV1Schema,
  inputTokenLimit: z.number().int().positive().optional(),
}).strict();
export const contextPresetPreviewResponseSchema = z.object({
  blocks: z.array(resolvedContextBlockSchema),
  inputBudgetTokens: z.number().int().nonnegative().nullable(),
  outputBudgetTokens: z.number().int().positive(),
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

export const ttsSampleRequestSchema = z.object({
  text: z.string().trim().min(1).max(500),
  style: z.enum(['white', 'black']),
});

export const featureOverridesRequestSchema = z.object({ overrides: z.array(z.unknown()) });
export const toolOverridesRequestSchema = z.object({ overrides: z.array(z.unknown()) });
export const affinitySettingsRequestSchema = z.object({
  settings: z.object({
    enabled: z.boolean(),
    proactiveEnabled: z.boolean(),
    randomWindowStartHour: z.number().int().min(0).max(23),
    randomWindowEndHour: z.number().int().min(0).max(23),
    randomCountWeights: z.tuple([
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative(),
    ]),
    enabledDirections: z.array(z.enum([
      'local_thread',
      'daily_greeting',
      'music_rehearsal',
      'contest_discussion',
      'computer_knowledge',
      'web_hot_topic',
      'relationship_scene',
    ])),
    webSourceEnabled: z.boolean(),
  }).strict(),
}).strict();
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
export type SettingsField = z.infer<typeof settingsFieldSchema>;
export type SettingsSection = z.infer<typeof settingsSectionSchema>;
export type SettingsPatchRequest = z.infer<typeof settingsPatchRequestSchema>;
export type OperationalEventListQuery = z.infer<typeof operationalEventListQuerySchema>;
export type OperationalEventActionRequest = z.infer<typeof operationalEventActionRequestSchema>;
export type OAuthAttempt = z.infer<typeof oauthAttemptSchema>;
export type ModelConfigAdminAggregate = z.infer<typeof modelAdminAggregateSchema>;
export type ModelConnectionAuthState = z.infer<typeof modelConnectionAuthStateSchema>;
export type ModelConnectionProbeResponse = z.infer<typeof modelConnectionProbeResponseSchema>;
export type ModelCatalogEntry = z.infer<typeof modelCatalogEntrySchema>;
export type ModelCatalogResponse = z.infer<typeof modelCatalogResponseSchema>;
export type ModelApplyRequest = z.infer<typeof modelApplyRequestSchema>;
export type ModelApplyResponse = z.infer<typeof modelApplyResponseSchema>;
export type StickerIndexMaintenanceResponse = z.infer<typeof stickerIndexMaintenanceResponseSchema>;
export type {
  ModelConfigAggregate,
  ModelConfigDraft,
  ModelConfigPutInput,
};
export type PresetSource = z.infer<typeof presetSourceSchema>;
export type RolePresetDefinitionV1 = z.infer<typeof RolePresetDefinitionV1Schema>;
export type ContextPresetDefinitionV1 = z.infer<typeof ContextPresetDefinitionV1Schema>;
export type ContextPresetBlock = z.infer<typeof ContextPresetBlockSchema>;
export type ContextPresetSummary = z.infer<typeof contextPresetSummarySchema>;
export type ContextPresetCatalogResponse = z.infer<typeof contextPresetCatalogResponseSchema>;
export type ContextPresetDetailResponse = z.infer<typeof contextPresetDetailResponseSchema>;
export type ContextPresetCreateRequest = z.infer<typeof contextPresetCreateRequestSchema>;
export type ContextPresetUpdateRequest = z.infer<typeof contextPresetUpdateRequestSchema>;
export type PresetRevisionRequest = z.infer<typeof presetRevisionRequestSchema>;
export type ContextPresetDefaultRequest = z.infer<typeof contextPresetDefaultRequestSchema>;
export type ContextPresetDefaultResponse = z.infer<typeof contextPresetDefaultResponseSchema>;
export type PromptFragmentPolicyConfig = z.infer<typeof promptFragmentPolicyConfigSchema>;
export type PromptFragmentPolicyState = z.infer<typeof promptFragmentPolicyStateSchema>;
export type PromptFragmentPolicyPutRequest = z.infer<typeof promptFragmentPolicyPutRequestSchema>;
export type PromptFragmentPolicyResetRequest = z.infer<typeof promptFragmentPolicyResetRequestSchema>;
export type RolePresetSummary = z.infer<typeof rolePresetSummarySchema>;
export type RolePresetCatalogResponse = z.infer<typeof rolePresetCatalogResponseSchema>;
export type RolePresetDetailResponse = z.infer<typeof rolePresetDetailResponseSchema>;
export type RolePresetCreateRequest = z.infer<typeof rolePresetCreateRequestSchema>;
export type RolePresetUpdateRequest = z.infer<typeof rolePresetUpdateRequestSchema>;
export type ResolvedContextBlock = z.infer<typeof resolvedContextBlockSchema>;
export type ContextPresetPreviewRequest = z.infer<typeof contextPresetPreviewRequestSchema>;
export type ContextPresetPreviewResponse = z.infer<typeof contextPresetPreviewResponseSchema>;
export type PresetResolution = z.infer<typeof presetResolutionSchema>;
export type ContextTarget = z.infer<typeof contextTargetSchema>;
export type ContextTargetsResponse = z.infer<typeof contextTargetsResponseSchema>;
export type ContextSnapshotMessage = z.infer<typeof contextSnapshotMessageSchema>;
export type ContextSnapshotTool = z.infer<typeof contextSnapshotToolSchema>;
export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;
export type ContextSnapshotResponse = z.infer<typeof contextSnapshotResponseSchema>;
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
