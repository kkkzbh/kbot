import { z } from 'zod';

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

export const modelListRequestSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
});

export const modelTabPatchSchema = z.object({
  id: z.enum(['siliconflow', 'openai', 'codex', 'copilot', 'deepseek', 'mimo']),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  clearApiKey: z.boolean().optional(),
  defaultModel: z.string().trim().min(1),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).nullable().optional(),
}).superRefine((tab, context) => {
  if (tab.clearApiKey && tab.apiKey !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'clearApiKey 与 apiKey 不能同时提交。' });
  }
});

export const modelTabsPatchRequestSchema = z.object({
  activeTab: z.enum(['siliconflow', 'openai', 'codex', 'copilot', 'deepseek', 'mimo']),
  tabs: z.array(modelTabPatchSchema).min(1),
  dirtyTabIds: z.array(z.enum(['siliconflow', 'openai', 'codex', 'copilot', 'deepseek', 'mimo'])).min(1),
});

export const presetNameSchema = z.string().trim().min(1).max(120);
export const presetReorderRequestSchema = z.object({ names: z.array(presetNameSchema).min(1) });

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
