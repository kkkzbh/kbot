import { z } from 'zod';
import type { Context } from 'koishi';
import type { GroupSummaryDocument } from '../../types/group-summary.js';

export const TABLES = {
  setting: 'group_summary_setting',
  group: 'group_summary_group',
  message: 'group_summary_message',
  task: 'group_summary_task',
  taskMessage: 'group_summary_task_message',
  batch: 'group_summary_batch',
  batchMessage: 'group_summary_batch_message',
  overview: 'group_summary_overview',
} as const;

const evidenceSchema = z.object({
  content: z.string().trim().min(1).max(4_000),
  evidenceMessageIds: z.array(z.number().int().positive()).max(100),
}).strict();

export const groupSummaryDocumentSchema: z.ZodType<GroupSummaryDocument> = z.object({
  headline: z.string().trim().min(1).max(1_000),
  institutions: z.array(z.object({
    name: z.string().trim().min(1).max(300),
    program: z.string().trim().min(1).max(300).nullable(),
    details: z.array(z.string().trim().min(1).max(2_000)).max(50),
    deadlines: z.array(z.string().trim().min(1).max(1_000)).max(30),
    requirements: z.array(z.string().trim().min(1).max(1_000)).max(50),
    evidenceMessageIds: z.array(z.number().int().positive()).max(100),
  }).strict()).max(100),
  materials: z.array(evidenceSchema).max(100),
  experiences: z.array(evidenceSchema).max(100),
  actionItems: z.array(evidenceSchema.extend({
    deadline: z.string().trim().min(1).max(300).nullable(),
  }).strict()).max(100),
  openQuestions: z.array(evidenceSchema).max(100),
  conflicts: z.array(evidenceSchema).max(100),
  otherTopicsBrief: z.string().trim().max(1_000),
}).strict();

export const groupSummaryResponseSchema = z.object({
  batchSummary: groupSummaryDocumentSchema,
  currentOverview: groupSummaryDocumentSchema,
}).strict();

export const GROUP_SUMMARY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['batchSummary', 'currentOverview'],
  properties: {
    batchSummary: documentJsonSchema(),
    currentOverview: documentJsonSchema(),
  },
} as const;

function evidenceJsonSchema(extra: Record<string, unknown> = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['content', 'evidenceMessageIds', ...Object.keys(extra)],
    properties: {
      content: { type: 'string' },
      evidenceMessageIds: { type: 'array', items: { type: 'integer' } },
      ...extra,
    },
  };
}

function documentJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['headline', 'institutions', 'materials', 'experiences', 'actionItems', 'openQuestions', 'conflicts', 'otherTopicsBrief'],
    properties: {
      headline: { type: 'string' },
      institutions: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['name', 'program', 'details', 'deadlines', 'requirements', 'evidenceMessageIds'],
          properties: {
            name: { type: 'string' },
            program: { type: ['string', 'null'] },
            details: { type: 'array', items: { type: 'string' } },
            deadlines: { type: 'array', items: { type: 'string' } },
            requirements: { type: 'array', items: { type: 'string' } },
            evidenceMessageIds: { type: 'array', items: { type: 'integer' } },
          },
        },
      },
      materials: { type: 'array', items: evidenceJsonSchema() },
      experiences: { type: 'array', items: evidenceJsonSchema() },
      actionItems: { type: 'array', items: evidenceJsonSchema({ deadline: { type: ['string', 'null'] } }) },
      openQuestions: { type: 'array', items: evidenceJsonSchema() },
      conflicts: { type: 'array', items: evidenceJsonSchema() },
      otherTopicsBrief: { type: 'string' },
    },
  };
}

export function ensureGroupSummaryTables(ctx: Context): void {
  const model = ctx.model as { extend: (...args: any[]) => unknown };
  model.extend(TABLES.setting, { key: 'string', value: 'text', updatedAt: 'double' }, { primary: 'key' });
  model.extend(TABLES.group, {
    groupId: 'string', roomName: { type: 'string', nullable: true }, enabled: 'boolean',
    promptOverride: { type: 'text', nullable: true }, createdAt: 'double', updatedAt: 'double',
  }, { primary: 'groupId' });
  model.extend(TABLES.message, {
    id: 'unsigned', groupId: 'string', platform: 'string', botSelfId: 'string', platformMessageId: 'string',
    senderId: 'string', senderName: 'string', capturedAt: 'double', text: 'text', media: 'json',
  }, { autoInc: true, unique: [['groupId', 'platformMessageId']], indexes: [['groupId', 'id'], ['groupId', 'capturedAt']] });
  model.extend(TABLES.task, {
    id: 'unsigned', groupId: 'string', mode: 'string', status: 'string', stage: 'string',
    highWatermarkId: 'unsigned', messageCount: 'unsigned', startAt: { type: 'double', nullable: true },
    endAt: { type: 'double', nullable: true }, createdAt: 'double', startedAt: { type: 'double', nullable: true },
    finishedAt: { type: 'double', nullable: true }, model: { type: 'string', nullable: true },
    error: { type: 'json', nullable: true }, batchId: { type: 'unsigned', nullable: true },
  }, { autoInc: true, indexes: [['groupId', 'status'], ['createdAt']] });
  model.extend(TABLES.taskMessage, { taskId: 'unsigned', messageId: 'unsigned' }, { primary: ['taskId', 'messageId'], indexes: [['messageId']] });
  model.extend(TABLES.batch, {
    id: 'unsigned', taskId: 'unsigned', groupId: 'string', mode: 'string', messageCount: 'unsigned',
    startAt: 'double', endAt: 'double', overlapsPrevious: 'boolean', summary: 'json', createdAt: 'double',
  }, { autoInc: true, unique: ['taskId'], indexes: [['groupId', 'createdAt']] });
  model.extend(TABLES.batchMessage, { batchId: 'unsigned', messageId: 'unsigned' }, { primary: ['batchId', 'messageId'], indexes: [['messageId']] });
  model.extend(TABLES.overview, { groupId: 'string', summary: 'json', updatedAt: 'double', latestBatchId: 'unsigned' }, { primary: 'groupId' });
}
