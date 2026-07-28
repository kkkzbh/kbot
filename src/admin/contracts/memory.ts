import { z } from 'zod';

export const memoryAssertionTypeSchema = z.enum([
  'userAssertion',
  'groupArtifact',
  'assistantCommitment',
  'episode',
]);

export const memoryFactKindSchema = z.enum([
  'identity',
  'preference',
  'trait',
  'boundary',
  'plan',
  'relationship',
  'response_policy',
]);

export const memoryHeadStateSchema = z.enum([
  'active',
  'pendingReview',
  'archived',
  'retracted',
  'forgotten',
]);

export const memoryAudiencePolicySchema = z.enum([
  'subjectPrivate',
  'sourceContext',
  'captureAudience',
  'subjectAllContexts',
  'explicitContexts',
]);

export const memorySensitivitySchema = z.enum([
  'low',
  'personal',
  'sensitive',
  'secret',
]);

export const memoryPageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  subjectKey: z.string().trim().min(1).max(256).optional(),
  contextKey: z.string().trim().min(1).max(512).optional(),
  state: memoryHeadStateSchema.optional(),
  assertionType: memoryAssertionTypeSchema.optional(),
}).strict();

export const memoryReviewsQuerySchema = memoryPageQuerySchema.omit({
  state: true,
});

export const memoryReviewRequestSchema = z.object({
  decision: z.enum(['approve', 'reject']),
}).strict();

export const memoryArchiveReasonCodeSchema = z.enum([
  'duplicate',
  'superseded',
  'outdated',
  'quality-review',
  'operator-archive',
]);

export const memoryArchiveRequestSchema = z.object({
  streamId: z.string().trim().min(1).max(256),
  reasonCode: memoryArchiveReasonCodeSchema,
}).strict();

export const memoryForgetReasonCodeSchema = z.enum([
  'privacy-request',
  'incorrect-memory',
  'subject-forget',
  'operator-delete',
  'retention-policy',
]);

export const memoryForgetRequestSchema = z.object({
  streamId: z.string().trim().min(1).max(256).optional(),
  subjectKey: z.string().trim().min(1).max(256).optional(),
  contextKey: z.string().trim().min(1).max(512).optional(),
  all: z.boolean().optional(),
  reasonCode: memoryForgetReasonCodeSchema,
}).strict().superRefine((input, context) => {
  if (!input.streamId && !input.subjectKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'streamId 与 subjectKey 至少需要一个。',
    });
  }
  if (input.streamId && input.all) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '按 streamId 删除时不能提交 all。',
    });
  }
});

export const memoryProbeWorkloadSchema = z.literal('memory.extract');

export const memoryQueueSummarySchema = z.object({
  pending: z.number().int().nonnegative(),
  leased: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  deadLetter: z.number().int().nonnegative(),
  byType: z.object({
    extract: z.number().int().nonnegative(),
    maintenance: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const memoryLedgerCountsSchema = z.object({
  active: z.number().int().nonnegative(),
  pendingReview: z.number().int().nonnegative(),
  archived: z.number().int().nonnegative(),
  retracted: z.number().int().nonnegative(),
  forgotten: z.number().int().nonnegative(),
  stranded: z.number().int().nonnegative(),
  lexicalDocuments: z.number().int().nonnegative(),
  lexicalTerms: z.number().int().nonnegative(),
  orphanEvidence: z.number().int().nonnegative(),
  staleLexicalDocuments: z.number().int().nonnegative(),
  inactiveLexicalDocuments: z.number().int().nonnegative(),
  strandedByReason: z.object({
    payload: z.number().int().nonnegative(),
    evidence: z.number().int().nonnegative(),
    audience: z.number().int().nonnegative(),
    lexical: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const memorySearchMetricsSchema = z.object({
  searches: z.number().int().nonnegative(),
  recentReads: z.number().int().nonnegative(),
  returnedItems: z.number().int().nonnegative(),
  rejectedCalls: z.number().int().nonnegative(),
  lastSearchAt: z.number().nullable(),
}).strict();

export const memoryOperationSnapshotSchema = z.object({
  configured: z.boolean(),
  state: z.enum(['never', 'success', 'failed']),
  lastSource: z.enum(['runtime', 'probe']).nullable(),
  lastAttemptAt: z.number().nullable(),
  lastSuccessAt: z.number().nullable(),
  lastFailureAt: z.number().nullable(),
  lastLatencyMs: z.number().int().nonnegative().nullable(),
  lastError: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
}).strict();

export const memoryStatusSnapshotSchema = z.object({
  schemaVersion: z.literal(3),
  available: z.boolean(),
  enabled: z.boolean(),
  maintenance: z.boolean(),
  readEnabled: z.boolean(),
  writeEnabled: z.boolean(),
  extractConfigured: z.boolean(),
  extractModel: z.string(),
  toolReady: z.boolean(),
  jobs: memoryQueueSummarySchema,
  counts: memoryLedgerCountsSchema,
  searchMetrics: memorySearchMetricsSchema,
  providerRoutes: z.array(z.object({
    route: z.enum([
      'native_responses_json_schema',
      'native_chat_json_schema',
      'unsupported_protocol',
    ]),
    success: z.number().int().nonnegative(),
    failure: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
  }).strict()),
  lastMaintenanceAt: z.number().nullable(),
  extract: memoryOperationSnapshotSchema,
}).strict();

export const memoryResolvedBindingSchema = z.object({
  workload: memoryProbeWorkloadSchema,
  sourceWorkload: z.string().min(1),
  mode: z.enum(['dedicated', 'disabled', 'inheritMain', 'inheritInvocation']),
  revision: z.number().int().positive(),
  canonicalModel: z.string().nullable(),
  connectionId: z.string().nullable(),
  modelId: z.string().nullable(),
}).strict();

export const memoryOverviewResponseSchema = z.object({
  status: memoryStatusSnapshotSchema,
  bindings: z.object({
    extraction: memoryResolvedBindingSchema,
  }).strict(),
}).strict();

export const memoryAssertionItemSchema = z.object({
  streamId: z.string().min(1),
  revision: z.number().int().positive(),
  state: memoryHeadStateSchema,
  assertionType: memoryAssertionTypeSchema,
  kind: memoryFactKindSchema.nullable(),
  topicKey: z.string(),
  subjectKey: z.string().min(1),
  sourceContextKey: z.string().min(1),
  audiencePolicy: memoryAudiencePolicySchema,
  audienceContextKeys: z.array(z.string()),
  audienceSnapshots: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
  sensitivity: memorySensitivitySchema,
  content: z.string().nullable(),
  evidenceMessageIds: z.array(z.string()),
  importance: z.number().finite(),
  confidence: z.number().finite(),
  updatedAt: z.number(),
}).strict();

function memoryPageResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    total: z.number().int().nonnegative(),
  }).strict();
}

export const memoryAssertionsResponseSchema = memoryPageResponseSchema(
  memoryAssertionItemSchema,
);

export const memoryReviewItemSchema = memoryAssertionItemSchema.extend({
  state: z.literal('pendingReview'),
}).strict();

export const memoryReviewsResponseSchema = memoryPageResponseSchema(
  memoryReviewItemSchema,
);

export const memoryReviewResponseSchema = z.object({
  ok: z.literal(true),
}).strict();

export const memoryArchiveResponseSchema = z.object({
  ok: z.literal(true),
}).strict();

export const memoryForgetResponseSchema = z.object({
  forgotten: z.number().int().nonnegative(),
}).strict();

export const memoryProbeResponseSchema = z.object({
  target: memoryProbeWorkloadSchema,
  ok: z.boolean(),
  checkedAt: z.number(),
  latencyMs: z.number().int().nonnegative().nullable(),
  canonicalModel: z.string().min(1).nullable(),
  schemaValid: z.boolean(),
  error: z.string().nullable(),
  snapshot: memoryStatusSnapshotSchema,
}).strict();

export type MemoryPageQuery = z.infer<typeof memoryPageQuerySchema>;
export type MemoryReviewRequest = z.infer<typeof memoryReviewRequestSchema>;
export type MemoryArchiveRequest = z.infer<typeof memoryArchiveRequestSchema>;
export type MemoryForgetRequest = z.infer<typeof memoryForgetRequestSchema>;
export type MemoryOverviewResponse = z.infer<typeof memoryOverviewResponseSchema>;
export type MemoryAssertionItem = z.infer<typeof memoryAssertionItemSchema>;
export type MemoryAssertionsResponse = z.infer<typeof memoryAssertionsResponseSchema>;
export type MemoryReviewsResponse = z.infer<typeof memoryReviewsResponseSchema>;
