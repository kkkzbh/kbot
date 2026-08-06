import { z } from 'zod';
import { groupSummaryDocumentSchema } from '../../plugins/group-summary/schema.js';

export { groupSummaryDocumentSchema };

export const groupSummaryGroupIdSchema = z.string().regex(/^\d+$/u).max(32);
export const groupSummarySelectionModeSchema = z.enum(['automatic', 'manual']);
export const groupSummaryTaskStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed']);

export const groupSummaryGroupSchema = z.object({
  groupId: groupSummaryGroupIdSchema,
  roomName: z.string().min(1),
  enabled: z.boolean(),
  promptOverride: z.string().nullable(),
}).strict();

export const groupSummaryGroupListItemSchema = groupSummaryGroupSchema.extend({
  messageCount: z.number().int().nonnegative(),
  unsummarizedCount: z.number().int().nonnegative(),
  lastMessageAt: z.number().nullable(),
  lastSummaryAt: z.number().nullable(),
  activeTask: z.boolean(),
}).strict();

export const groupSummaryAdminStateSchema = z.object({
  defaultPrompt: z.string().min(1),
  groups: z.array(groupSummaryGroupListItemSchema),
}).strict();

export const groupSummarySettingsRequestSchema = z.object({
  defaultPrompt: z.string().trim().min(1).max(8_000),
}).strict();

export const groupSummaryGroupRequestSchema = z.object({
  enabled: z.boolean(),
  roomName: z.string().trim().min(1).max(300).nullable(),
  promptOverride: z.string().trim().min(1).max(8_000).nullable(),
}).strict();

export const groupSummaryRangeRequestSchema = z.union([
  z.object({ mode: z.literal('automatic') }).strict(),
  z.object({
    mode: z.literal('manual'),
    startAt: z.number().finite().nonnegative(),
    endAt: z.number().finite().nonnegative(),
  }).strict().refine((value) => value.startAt <= value.endAt, { message: 'startAt must not exceed endAt' }),
]);

export const groupSummaryPreviewSchema = z.object({
  mode: groupSummarySelectionModeSchema,
  messageCount: z.number().int().nonnegative(),
  startAt: z.number().nullable(),
  endAt: z.number().nullable(),
  firstMessageId: z.number().int().positive().nullable(),
  lastMessageId: z.number().int().positive().nullable(),
  mediaCount: z.number().int().nonnegative(),
}).strict();

export const groupSummaryTaskRequestSchema = z.union([
  z.object({ mode: z.literal('automatic') }).strict(),
  z.object({
    mode: z.literal('manual'),
    startAt: z.number().finite().nonnegative(),
    endAt: z.number().finite().nonnegative(),
    firstMessageId: z.number().int().positive(),
    lastMessageId: z.number().int().positive(),
  }).strict().refine((value) => value.startAt <= value.endAt && value.firstMessageId <= value.lastMessageId, { message: 'manual summary boundaries are invalid' }),
]);

export const groupSummaryTaskErrorSchema = z.object({
  code: z.string(),
  operation: z.string(),
  stage: z.string(),
  message: z.string(),
}).passthrough();

export const groupSummaryTaskSchema = z.object({
  id: z.number().int().positive(),
  groupId: groupSummaryGroupIdSchema,
  mode: groupSummarySelectionModeSchema,
  status: groupSummaryTaskStatusSchema,
  stage: z.string(),
  messageCount: z.number().int().nonnegative(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  model: z.string().nullable(),
  error: groupSummaryTaskErrorSchema.nullable(),
  batchId: z.number().int().positive().nullable(),
}).strict();

export const groupSummaryBatchSchema = z.object({
  id: z.number().int().positive(),
  mode: groupSummarySelectionModeSchema,
  messageCount: z.number().int().positive(),
  startAt: z.number(),
  endAt: z.number(),
  overlapsPrevious: z.boolean(),
  summary: groupSummaryDocumentSchema,
  createdAt: z.number(),
}).strict();

export const groupSummaryDetailSchema = z.object({
  group: groupSummaryGroupSchema,
  overview: groupSummaryDocumentSchema.nullable(),
  overviewUpdatedAt: z.number().nullable(),
  messageCount: z.number().int().nonnegative(),
  batches: z.array(groupSummaryBatchSchema),
  latestTask: groupSummaryTaskSchema.nullable(),
}).strict();

export const groupSummaryMessagesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
}).strict();

export const groupSummaryMessageSchema = z.object({
  id: z.number().int().positive(),
  platformMessageId: z.string().min(1),
  senderId: z.string().min(1),
  senderName: z.string().min(1),
  capturedAt: z.number(),
  text: z.string(),
  media: z.array(z.record(z.unknown())),
}).strict();

export const groupSummaryMessagesResponseSchema = z.object({
  items: z.array(groupSummaryMessageSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
}).strict();

export const groupSummaryClearRequestSchema = z.object({
  confirmGroupId: groupSummaryGroupIdSchema,
}).strict();

export const groupSummaryClearResponseSchema = z.object({
  ok: z.literal(true),
  groupId: groupSummaryGroupIdSchema,
}).strict();

export type GroupSummaryAdminState = z.infer<typeof groupSummaryAdminStateSchema>;
export type GroupSummaryDetail = z.infer<typeof groupSummaryDetailSchema>;
export type GroupSummaryDocumentContract = z.infer<typeof groupSummaryDocumentSchema>;
