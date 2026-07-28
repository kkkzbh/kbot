#!/usr/bin/env node

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type {
  MemoryEvaluationAdapter,
  MemoryEvaluationAdapterDescriptor,
  MemoryEvaluationAnswerJudge,
  MemoryEvaluationAnswerJudgeOptions,
  MemoryEvaluationBaseline,
  MemoryContractEvaluationReport,
  MemoryEvaluationEvent,
  MemoryEvaluationPrivacyProbe,
  MemoryEvaluationQtype,
  MemoryEvaluationQuery,
  MemoryEvaluationReport,
  MemoryEvaluationScenario,
  MemoryEvaluationSourceFormat,
  MemoryOfficialEvaluationReport,
  EverMemBenchDimension,
  GroupMemBenchQtype,
} from '../types/memory-evaluation.js';

process.umask(0o077);

const MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024;
const SYNTHETIC_ID = /^syn_[a-z][a-z0-9._:-]{2,127}$/u;
const SAFE_LABEL = /^[a-z][a-z0-9._-]{0,63}$/u;
const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const REPLAY_IDS = {
  scenario: /^qqh1_s_[a-f0-9]{64}$/u,
  assertion: /^qqh1_a_[a-f0-9]{64}$/u,
  message: /^qqh1_m_[a-f0-9]{64}$/u,
  query: /^qqh1_q_[a-f0-9]{64}$/u,
  user: /^qqh1_u_[a-f0-9]{64}$/u,
  subject: /^qqh1_[ugb]_[a-f0-9]{64}$/u,
  context: /^qqh1_c_[a-f0-9]{64}$/u,
} as const;

const assertionTypeSchema = z.enum([
  'UserAssertion',
  'GroupArtifact',
  'AssistantCommitment',
  'Episode',
]);
const audiencePolicySchema = z.enum([
  'subjectPrivate',
  'sourceContext',
  'captureAudience',
  'subjectAllContexts',
  'explicitContexts',
]);
const sensitivitySchema = z.enum(['public', 'personal', 'private']);
const qtypeSchema = z.enum([
  'singleHop',
  'multiHop',
  'temporal',
  'conflict',
  'groupArtifact',
  'speakerAttribution',
  'memoryAwareness',
  'profileUnderstanding',
  'abstention',
  'privacy',
]);
const dimensionSchema = z.enum([
  'recall',
  'memoryAwareness',
  'profileUnderstanding',
  'temporal',
  'abstention',
]);
const privacyProbeSchema = z.enum(['private', 'crossGroup', 'newMember']);

const boundedTextSchema = z.string().min(1).max(8_000);
const scoreSchema = z.number().finite().min(0).max(1);
const relativeTimeSchema = z.number().int().min(0).max(100 * 365 * 24 * 60 * 60 * 1_000);

function uniqueArray<T extends z.ZodTypeAny>(item: T, maximum = 1_024) {
  return z.array(item).max(maximum).refine(
    (values) => new Set(values).size === values.length,
    { message: 'duplicate_values' },
  );
}

const syntheticIdSchema = z.string().regex(SYNTHETIC_ID);
const syntheticEventSchema = z.object({
  memoryKey: syntheticIdSchema,
  eventKey: syntheticIdSchema,
  actorSubjectKey: syntheticIdSchema,
  ownerSubjectKey: syntheticIdSchema,
  contextKey: syntheticIdSchema,
  channelType: z.enum(['direct', 'group']),
  currentAudienceSubjectKeys: uniqueArray(syntheticIdSchema),
  assertionType: assertionTypeSchema,
  audiencePolicy: audiencePolicySchema,
  audienceContextKeys: uniqueArray(syntheticIdSchema),
  captureAudienceSubjectKeys: uniqueArray(syntheticIdSchema),
  sensitivity: sensitivitySchema,
  content: boundedTextSchema,
  retrievalText: boundedTextSchema,
  occurredOffsetMs: relativeTimeSchema,
  importance: scoreSchema,
  confidence: scoreSchema,
}).strict();

const syntheticQuerySchema = z.object({
  queryKey: syntheticIdSchema,
  requesterSubjectKey: syntheticIdSchema,
  contextKey: syntheticIdSchema,
  channelType: z.enum(['direct', 'group']),
  currentAudienceSubjectKeys: uniqueArray(syntheticIdSchema),
  query: boundedTextSchema,
  relevantMemoryKeys: uniqueArray(syntheticIdSchema),
  forbiddenMemoryKeys: uniqueArray(syntheticIdSchema),
  expectedOrder: uniqueArray(syntheticIdSchema),
  qtype: qtypeSchema,
  dimension: dimensionSchema,
  occurredOffsetMs: relativeTimeSchema,
}).strict();

const syntheticContractLineSchema = z.object({
  schemaVersion: z.literal(1),
  contract: z.literal('SyntheticMemoryEvaluation'),
  scenarioKey: syntheticIdSchema,
  events: z.array(syntheticEventSchema).min(1).max(10_000),
  queries: z.array(syntheticQuerySchema).min(1).max(10_000),
}).strict();

const replayEventSchema = z.object({
  memoryKey: z.string().regex(REPLAY_IDS.assertion),
  eventKey: z.string().regex(REPLAY_IDS.message),
  actorSubjectKey: z.string().regex(REPLAY_IDS.user),
  ownerSubjectKey: z.string().regex(REPLAY_IDS.subject),
  contextKey: z.string().regex(REPLAY_IDS.context),
  channelType: z.literal('group'),
  currentAudienceSubjectKeys: uniqueArray(z.string().regex(REPLAY_IDS.user)),
  assertionType: assertionTypeSchema,
  audiencePolicy: audiencePolicySchema,
  audienceContextKeys: uniqueArray(z.string().regex(REPLAY_IDS.context)),
  captureAudienceSubjectKeys: uniqueArray(z.string().regex(REPLAY_IDS.user)),
  sensitivity: sensitivitySchema,
  content: boundedTextSchema,
  retrievalText: boundedTextSchema,
  occurredOffsetMs: relativeTimeSchema,
  importance: scoreSchema,
  confidence: scoreSchema,
}).strict();

const replayQuerySchema = z.object({
  queryKey: z.string().regex(REPLAY_IDS.query),
  requesterSubjectKey: z.string().regex(REPLAY_IDS.user),
  contextKey: z.string().regex(REPLAY_IDS.context),
  channelType: z.literal('group'),
  currentAudienceSubjectKeys: uniqueArray(z.string().regex(REPLAY_IDS.user)),
  query: boundedTextSchema,
  relevantMemoryKeys: uniqueArray(z.string().regex(REPLAY_IDS.assertion)),
  forbiddenMemoryKeys: uniqueArray(z.string().regex(REPLAY_IDS.assertion)),
  expectedOrder: uniqueArray(z.string().regex(REPLAY_IDS.assertion)),
  qtype: z.literal('privacy'),
  dimension: z.literal('abstention'),
  privacyProbe: privacyProbeSchema,
  occurredOffsetMs: relativeTimeSchema,
}).strict();

const replayLineSchema = z.object({
  schemaVersion: z.literal(1),
  corpus: z.literal('QQGroupReplay'),
  anonymization: z.object({
    scheme: z.literal('hmac-sha256-v1'),
    pseudonymFormat: z.literal('qqh1'),
    hmacKeyId: z.string().regex(SAFE_LABEL),
    timeTransform: z.literal('relative-offset-v1'),
    timeShiftId: z.string().regex(SAFE_LABEL),
    rawIdentifiersRemoved: z.literal(true),
    nicknamesRemoved: z.literal(true),
    directMessagesRemoved: z.literal(true),
  }).strict(),
  scenarioKey: z.string().regex(REPLAY_IDS.scenario),
  events: z.array(replayEventSchema).min(1).max(10_000),
  privacyProbes: z.array(replayQuerySchema).min(1).max(10_000),
}).strict();

const officialGroupQtypeSchema = z.enum([
  'multi_hop',
  'knowledge_update',
  'temporal',
  'user_implicit',
  'term_ambiguity',
  'abstention',
]);
const everDimensionSchema = z.enum([
  'recall',
  'memoryAwareness',
  'profileUnderstanding',
]);
const baselineByQtypeSchema = z.record(officialGroupQtypeSchema, scoreSchema).refine(
  (value) => Object.keys(value).length > 0,
  { message: 'baseline_qtype_empty' },
);
const groupMemBenchBaselineSchema = z.object({
  schemaVersion: z.literal(1),
  benchmark: z.literal('GroupMemBench'),
  legacyQQBot: z.object({
    accuracyByQtype: baselineByQtypeSchema,
  }).strict(),
  bm25: z.object({
    accuracyByQtype: baselineByQtypeSchema,
  }).strict(),
}).strict();
const everMemBenchBaselineSchema = z.object({
  schemaVersion: z.literal(1),
  benchmark: z.literal('EverMemBench'),
  legacyQQBot: z.object({
    accuracyByDimension: z.record(everDimensionSchema, scoreSchema).refine(
      (value) => Object.keys(value).length > 0,
      { message: 'baseline_dimension_empty' },
    ),
  }).strict(),
}).strict();
const baselineSchema = z.discriminatedUnion('benchmark', [
  groupMemBenchBaselineSchema,
  everMemBenchBaselineSchema,
]);

const groupMemBenchMessageSchema = z.object({
  msg_node: z.union([z.string().min(1).max(512), z.number().int().safe()]),
  content: z.string().min(1).max(32_000),
  author: z.string().min(1).max(512),
  role: z.string().min(1).max(128),
  timestamp: z.string().min(1).max(128),
  reply_to: z.union([
    z.string().max(512),
    z.number().int().safe(),
    z.null(),
  ]).optional(),
  phase_name: z.string().max(512).optional(),
  topic: z.string().max(1_024).optional(),
  is_noise: z.boolean().optional(),
  is_decision_point: z.boolean().optional(),
}).passthrough();
const groupMemBenchConversationSchema = z.record(
  z.string().min(1).max(512),
  z.array(groupMemBenchMessageSchema).max(100_000),
).refine(
  (value) => Object.values(value).some((messages) => messages.length > 0),
  { message: 'groupmembench_conversation_empty' },
);
const groupMemBenchQuestionSchema = z.object({
  id: z.union([z.string().min(1).max(512), z.number().int().safe()]),
  question: z.string().min(1).max(8_000),
  answer: z.string().min(1).max(8_000),
  asking_user_id: z.union([z.string().min(1).max(512), z.number().int().safe()]),
}).strict();

const everDialogueTurnSchema = z.object({
  speaker: z.string().min(1).max(512),
  time: z.string().min(1).max(128),
  dialogue: z.string().min(1).max(32_000),
}).strict();
const everDialogueSchema = z.object({
  dialogues: z.record(
    z.string().min(1).max(128),
    z.record(
      z.string().min(1).max(512),
      z.array(everDialogueTurnSchema).max(100_000),
    ),
  ),
}).strict();
const everQuestionSchema = z.object({
  id: z.union([z.string().min(1).max(512), z.number().int().safe()]),
  Q: z.string().min(1).max(8_000),
  A: z.string().min(1).max(8_000),
  task_id: z.union([z.string().min(1).max(512), z.number().int().safe()]),
  options: z.record(
    z.string().min(1).max(128),
    z.string().min(1).max(8_000),
  ).nullable(),
}).strict();
const everQuestionsSchema = z.object({
  qars: z.array(everQuestionSchema).min(1).max(100_000),
}).strict();

const answerJudgeDescriptorSchema = z.object({
  contractVersion: z.literal(1),
  runtime: z.literal('qqbot-model-config'),
  workload: z.literal('main.chat'),
  sameModel: z.literal(true),
  modelRevision: z.number().int().positive(),
}).strict();
const answerResultSchema = z.object({
  answer: z.string().min(1).max(32_000),
}).strict();
const judgeResultSchema = z.object({
  correct: z.boolean(),
}).strict();

const adapterDescriptorSchema = z.object({
  contractVersion: z.literal(1),
  runtime: z.literal('qqbot-memory-v3'),
  isolation: z.literal('ephemeral'),
  adapterName: z.string().regex(SAFE_LABEL),
  adapterVersion: z.string().regex(/^[0-9]+(?:\.[0-9]+){0,2}$/u),
}).strict();

const reasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u);
const adapterIngestResultSchema = z.object({
  accepted: z.boolean(),
  recordId: z.string().regex(SAFE_RECORD_ID).nullable(),
  ownerSubjectKey: z.string().min(1).max(256).nullable(),
  evidenceKeys: uniqueArray(z.string().min(1).max(256)),
  reasonCodes: uniqueArray(reasonCodeSchema, 128),
}).strict().superRefine((value, context) => {
  if (value.accepted && (!value.recordId || !value.ownerSubjectKey)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'accepted_record_identity_required',
    });
  }
  if (!value.accepted && value.recordId !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'rejected_record_identity_forbidden',
    });
  }
});
const adapterSearchResultSchema = z.object({
  hits: z.array(z.object({
    recordId: z.string().regex(SAFE_RECORD_ID),
    rank: z.number().int().min(1).max(10),
    score: z.number().finite(),
  }).strict()).max(10).refine(
    (hits) => hits.every((hit, index) => hit.rank === index + 1),
    { message: 'ranks_not_contiguous' },
  ).refine(
    (hits) => new Set(hits.map((hit) => hit.recordId)).size === hits.length,
    { message: 'duplicate_record_ids' },
  ),
}).strict();
const adapterExplainResultSchema = z.object({
  recordId: z.string().regex(SAFE_RECORD_ID),
  included: z.boolean(),
  reasonCodes: uniqueArray(reasonCodeSchema, 128),
  evidenceKeys: uniqueArray(z.string().min(1).max(256)),
}).strict();

const FORBIDDEN_INPUT_KEY = /^(?:qq|qqid|qq_id|rawqqid|raw_qq_id|userid|user_id|senderid|sender_id|groupid|group_id|nickname|displayname|display_name|token|cookie|authorization|password|secret|apikey|api_key|session|dmtext|dm_text|directmessage|direct_message|rawtimestamp|raw_timestamp)$/iu;
const SENSITIVE_TEXT_PATTERNS = [
  /\b(?:authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]/iu,
  /\bbearer\s+[A-Za-z0-9._~+/-]{12,}=*/iu,
  /\bsk-[A-Za-z0-9_-]{12,}\b/u,
  /\bQQ(?:号|ID)?\s*[:：=]?\s*[1-9][0-9]{4,11}\b/iu,
] as const;

const ALL_QTYPES = qtypeSchema.options;
const ALL_PRIVACY_PROBES = privacyProbeSchema.options;

export class MemoryEvaluationInputError extends Error {
  constructor(
    readonly lineNumber: number,
    readonly code: string,
  ) {
    super(`Memory evaluation input line ${lineNumber}: ${code}.`);
    this.name = 'MemoryEvaluationInputError';
  }
}

export class MemoryEvaluationAdapterError extends Error {
  constructor(readonly code: string) {
    super(`Memory evaluation adapter contract failed: ${code}.`);
    this.name = 'MemoryEvaluationAdapterError';
  }
}

function assertNoSensitiveInput(value: unknown, lineNumber: number): void {
  if (typeof value === 'string') {
    if (SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new MemoryEvaluationInputError(lineNumber, 'sensitive_text_detected');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveInput(item, lineNumber);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_INPUT_KEY.test(key)) {
      throw new MemoryEvaluationInputError(lineNumber, 'forbidden_identifier_field');
    }
    assertNoSensitiveInput(child, lineNumber);
  }
}

function assertUniqueScenarioKeys(
  scenario: MemoryEvaluationScenario,
  lineNumber: number,
): void {
  const memoryKeys = new Set<string>();
  const eventKeys = new Set<string>();
  for (const event of scenario.events) {
    if (memoryKeys.has(event.memoryKey) || eventKeys.has(event.eventKey)) {
      throw new MemoryEvaluationInputError(lineNumber, 'duplicate_event_identity');
    }
    memoryKeys.add(event.memoryKey);
    eventKeys.add(event.eventKey);
  }
  const queryKeys = new Set<string>();
  for (const query of scenario.queries) {
    if (queryKeys.has(query.queryKey)) {
      throw new MemoryEvaluationInputError(lineNumber, 'duplicate_query_identity');
    }
    queryKeys.add(query.queryKey);
    for (const key of [
      ...query.relevantMemoryKeys,
      ...query.forbiddenMemoryKeys,
      ...query.expectedOrder,
    ]) {
      if (!memoryKeys.has(key)) {
        throw new MemoryEvaluationInputError(lineNumber, 'query_memory_identity_missing');
      }
    }
    if (query.relevantMemoryKeys.some((key) => query.forbiddenMemoryKeys.includes(key))) {
      throw new MemoryEvaluationInputError(lineNumber, 'query_relevant_forbidden_overlap');
    }
  }
}

function assertReplayPrivacySemantics(
  scenario: MemoryEvaluationScenario,
  lineNumber: number,
): void {
  const events = new Map(scenario.events.map((event) => [event.memoryKey, event]));
  for (const query of scenario.queries) {
    if (!query.privacyProbe || query.forbiddenMemoryKeys.length === 0) {
      throw new MemoryEvaluationInputError(lineNumber, 'privacy_probe_target_missing');
    }
    for (const memoryKey of query.forbiddenMemoryKeys) {
      const event = events.get(memoryKey);
      if (!event) {
        throw new MemoryEvaluationInputError(lineNumber, 'privacy_probe_target_missing');
      }
      if (
        query.privacyProbe === 'private'
        && (
          event.audiencePolicy !== 'subjectPrivate'
          || query.requesterSubjectKey === event.ownerSubjectKey
        )
      ) {
        throw new MemoryEvaluationInputError(lineNumber, 'private_probe_semantics_invalid');
      }
      if (
        query.privacyProbe === 'crossGroup'
        && (
          event.audiencePolicy !== 'sourceContext'
          || query.contextKey === event.contextKey
        )
      ) {
        throw new MemoryEvaluationInputError(lineNumber, 'cross_group_probe_semantics_invalid');
      }
      if (
        query.privacyProbe === 'newMember'
        && (
          event.audiencePolicy !== 'captureAudience'
          || query.contextKey !== event.contextKey
          || event.captureAudienceSubjectKeys.includes(query.requesterSubjectKey)
          || !query.currentAudienceSubjectKeys.includes(query.requesterSubjectKey)
        )
      ) {
        throw new MemoryEvaluationInputError(lineNumber, 'new_member_probe_semantics_invalid');
      }
    }
  }
}

function normalizeSyntheticQuery(
  query: z.infer<typeof syntheticQuerySchema>,
): MemoryEvaluationQuery {
  return {
    ...query,
    privacyProbe: null,
  };
}

function parseLine(
  raw: string,
  format: MemoryEvaluationSourceFormat,
  lineNumber: number,
): MemoryEvaluationScenario {
  if (Buffer.byteLength(raw, 'utf8') > MAX_JSONL_LINE_BYTES) {
    throw new MemoryEvaluationInputError(lineNumber, 'line_too_large');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new MemoryEvaluationInputError(lineNumber, 'invalid_json');
  }
  assertNoSensitiveInput(value, lineNumber);

  let scenario: MemoryEvaluationScenario;
  if (format === 'synthetic-contract') {
    const parsed = syntheticContractLineSchema.safeParse(value);
    if (!parsed.success) {
      throw new MemoryEvaluationInputError(lineNumber, 'synthetic_contract_schema_invalid');
    }
    scenario = {
      scenarioKey: parsed.data.scenarioKey,
      sourceFormat: format,
      events: parsed.data.events,
      queries: parsed.data.queries.map(normalizeSyntheticQuery),
    };
  } else {
    const parsed = replayLineSchema.safeParse(value);
    if (!parsed.success) {
      throw new MemoryEvaluationInputError(lineNumber, 'qq_replay_schema_invalid');
    }
    scenario = {
      scenarioKey: parsed.data.scenarioKey,
      sourceFormat: format,
      events: parsed.data.events,
      queries: parsed.data.privacyProbes.map((query) => ({ ...query })),
    };
  }
  assertUniqueScenarioKeys(scenario, lineNumber);
  if (format === 'qq-group-replay') {
    assertReplayPrivacySemantics(scenario, lineNumber);
  }
  return scenario;
}

export async function loadMemoryEvaluationJsonl(
  inputPath: string,
  format: MemoryEvaluationSourceFormat,
): Promise<MemoryEvaluationScenario[]> {
  const scenarios: MemoryEvaluationScenario[] = [];
  const scenarioKeys = new Set<string>();
  const input = createReadStream(inputPath, {
    encoding: 'utf8',
    highWaterMark: 64 * 1024,
  });
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  try {
    for await (const rawLine of lines) {
      lineNumber += 1;
      const line = rawLine.trim();
      if (!line) continue;
      const scenario = parseLine(line, format, lineNumber);
      if (scenarioKeys.has(scenario.scenarioKey)) {
        throw new MemoryEvaluationInputError(lineNumber, 'duplicate_scenario_identity');
      }
      scenarioKeys.add(scenario.scenarioKey);
      scenarios.push(scenario);
    }
  } catch (error) {
    input.destroy();
    throw error;
  }
  if (scenarios.length === 0) {
    throw new MemoryEvaluationInputError(0, 'input_empty');
  }
  return scenarios;
}

export async function loadMemoryEvaluationBaseline(
  baselinePath: string,
  benchmark: 'GroupMemBench' | 'EverMemBench',
): Promise<MemoryEvaluationBaseline> {
  const raw = await readFile(baselinePath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) {
    throw new MemoryEvaluationInputError(0, 'baseline_too_large');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new MemoryEvaluationInputError(0, 'baseline_json_invalid');
  }
  assertNoSensitiveInput(value, 0);
  const parsed = baselineSchema.safeParse(value);
  if (!parsed.success) {
    throw new MemoryEvaluationInputError(0, 'baseline_schema_invalid');
  }
  if (parsed.data.benchmark !== benchmark) {
    throw new MemoryEvaluationInputError(0, 'baseline_format_mismatch');
  }
  return parsed.data;
}

const MAX_OFFICIAL_DATASET_BYTES = 512 * 1024 * 1024;

async function readBoundedJson(
  inputPath: string,
  schema: z.ZodTypeAny,
  errorCode: string,
): Promise<unknown> {
  const info = await stat(inputPath);
  if (!info.isFile() || info.size > MAX_OFFICIAL_DATASET_BYTES) {
    throw new MemoryEvaluationInputError(0, `${errorCode}_size_invalid`);
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(inputPath, 'utf8'));
  } catch {
    throw new MemoryEvaluationInputError(0, `${errorCode}_json_invalid`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new MemoryEvaluationInputError(0, `${errorCode}_schema_invalid`);
  }
  return parsed.data;
}

async function readOfficialQuestionJsonl<T>(
  inputPath: string,
  schema: z.ZodType<T>,
  errorCode: string,
): Promise<T[]> {
  const info = await stat(inputPath);
  if (!info.isFile() || info.size > MAX_OFFICIAL_DATASET_BYTES) {
    throw new MemoryEvaluationInputError(0, `${errorCode}_size_invalid`);
  }
  const questions: T[] = [];
  const input = createReadStream(inputPath, {
    encoding: 'utf8',
    highWaterMark: 64 * 1024,
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const rawLine of lines) {
      lineNumber += 1;
      const line = rawLine.trim();
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_JSONL_LINE_BYTES) {
        throw new MemoryEvaluationInputError(lineNumber, `${errorCode}_line_too_large`);
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new MemoryEvaluationInputError(lineNumber, `${errorCode}_json_invalid`);
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        throw new MemoryEvaluationInputError(lineNumber, `${errorCode}_schema_invalid`);
      }
      questions.push(parsed.data);
    }
  } catch (error) {
    input.destroy();
    throw error;
  }
  if (questions.length === 0) {
    throw new MemoryEvaluationInputError(0, `${errorCode}_empty`);
  }
  return questions;
}

function stableSyntheticIdentity(kind: string, value: string): string {
  const digest = createHash('sha256')
    .update(`qqbot-memory-official-evaluation:v1:${kind}:${value}`)
    .digest('hex');
  return `syn_${kind}_${digest}`;
}

function officialPassage(parts: Readonly<Record<string, string | null>>): string {
  const metadata = Object.entries(parts)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  return metadata;
}

type OfficialDataset = {
  scenarioKey: string;
  contextKey: string;
  audience: string[];
  events: MemoryEvaluationEvent[];
};

type EverMemBenchQuestion = z.infer<typeof everQuestionSchema>;

async function loadGroupMemBenchDataset(
  conversationPath: string,
): Promise<OfficialDataset> {
  const conversation = await readBoundedJson(
    conversationPath,
    groupMemBenchConversationSchema,
    'groupmembench_conversation',
  ) as z.infer<typeof groupMemBenchConversationSchema>;
  const authors = [...new Set(
    Object.values(conversation).flatMap((messages) => (
      messages.map((message) => String(message.author))
    )),
  )].sort();
  const audience = authors.map((author) => stableSyntheticIdentity('u', author));
  const scenarioKey = stableSyntheticIdentity('s', 'groupmembench');
  const contextKey = stableSyntheticIdentity('c', 'groupmembench');
  const ownerSubjectKey = stableSyntheticIdentity('g', 'groupmembench');
  let offset = 0;
  const events: MemoryEvaluationEvent[] = [];
  for (const [channel, messages] of Object.entries(conversation)) {
    for (const message of messages) {
      const node = String(message.msg_node);
      const memoryKey = stableSyntheticIdentity('a', `${channel}:${node}`);
      offset += 1_000;
      events.push({
        memoryKey,
        eventKey: stableSyntheticIdentity('m', `${channel}:${node}`),
        actorSubjectKey: stableSyntheticIdentity('u', String(message.author)),
        ownerSubjectKey,
        contextKey,
        channelType: 'group',
        currentAudienceSubjectKeys: audience,
        assertionType: 'GroupArtifact',
        audiencePolicy: 'captureAudience',
        audienceContextKeys: [],
        captureAudienceSubjectKeys: audience,
        sensitivity: 'public',
        content: officialPassage({
          channel,
          author: String(message.author),
          role: String(message.role),
          timestamp: String(message.timestamp),
          reply_to: message.reply_to === undefined || message.reply_to === null
            ? null
            : String(message.reply_to),
          phase: message.phase_name ?? null,
          topic: message.topic ?? null,
          content: message.content,
        }),
        retrievalText: message.content,
        occurredOffsetMs: offset,
        importance: message.is_decision_point ? 1 : 0.7,
        confidence: message.is_noise ? 0.5 : 1,
      });
    }
  }
  return { scenarioKey, contextKey, audience, events };
}

async function loadEverMemBenchDataset(
  dialoguePath: string,
): Promise<OfficialDataset> {
  const input = await readBoundedJson(
    dialoguePath,
    everDialogueSchema,
    'evermembench_dialogue',
  ) as z.infer<typeof everDialogueSchema>;
  const turns = Object.entries(input.dialogues).flatMap(([date, groups]) => (
    Object.entries(groups).flatMap(([group, entries]) => (
      entries.map((entry, index) => ({ date, group, index, ...entry }))
    ))
  ));
  if (turns.length === 0) {
    throw new MemoryEvaluationInputError(0, 'evermembench_dialogue_empty');
  }
  const audience = [...new Set(turns.map((turn) => turn.speaker))]
    .sort()
    .map((speaker) => stableSyntheticIdentity('u', speaker));
  const scenarioKey = stableSyntheticIdentity('s', 'evermembench');
  const contextKey = stableSyntheticIdentity('c', 'evermembench');
  const ownerSubjectKey = stableSyntheticIdentity('g', 'evermembench');
  const events = turns.map((turn, index): MemoryEvaluationEvent => {
    const sourceIdentity = `${turn.date}:${turn.group}:${turn.index}`;
    return {
      memoryKey: stableSyntheticIdentity('a', sourceIdentity),
      eventKey: stableSyntheticIdentity('m', sourceIdentity),
      actorSubjectKey: stableSyntheticIdentity('u', turn.speaker),
      ownerSubjectKey,
      contextKey,
      channelType: 'group',
      currentAudienceSubjectKeys: audience,
      assertionType: 'GroupArtifact',
      audiencePolicy: 'captureAudience',
      audienceContextKeys: [],
      captureAudienceSubjectKeys: audience,
      sensitivity: 'public',
      content: officialPassage({
        date: turn.date,
        group: turn.group,
        speaker: turn.speaker,
        time: turn.time,
        content: turn.dialogue,
      }),
      retrievalText: turn.dialogue,
      occurredOffsetMs: (index + 1) * 1_000,
      importance: 0.7,
      confidence: 1,
    };
  });
  return { scenarioKey, contextKey, audience, events };
}

async function ingestOfficialDataset(
  dataset: OfficialDataset,
  adapter: MemoryEvaluationAdapter,
): Promise<{
  passagesByRecord: Map<string, string>;
  acceptedMessages: number;
}> {
  validateAdapterDescriptor(adapter.descriptor);
  await adapter.resetScenario({ scenarioKey: dataset.scenarioKey });
  const passages = new Map<string, string>();
  let acceptedMessages = 0;
  for (const event of dataset.events) {
    const parsed = adapterIngestResultSchema.safeParse(await adapter.ingest({
      scenarioKey: dataset.scenarioKey,
      event,
    }));
    if (!parsed.success) {
      throw new MemoryEvaluationAdapterError('official_ingest_result_invalid');
    }
    if (!parsed.data.accepted || !parsed.data.recordId) continue;
    if (parsed.data.ownerSubjectKey !== event.ownerSubjectKey) {
      throw new MemoryEvaluationAdapterError('official_owner_mapping_invalid');
    }
    if (passages.has(parsed.data.recordId)) {
      throw new MemoryEvaluationAdapterError('record_identity_reused');
    }
    acceptedMessages += 1;
    passages.set(parsed.data.recordId, event.content);
  }
  return { passagesByRecord: passages, acceptedMessages };
}

async function searchOfficialQuestion(
  dataset: OfficialDataset,
  adapter: MemoryEvaluationAdapter,
  passagesByRecord: ReadonlyMap<string, string>,
  queryKey: string,
  requesterSubjectKey: string,
  query: string,
): Promise<{ passages: string[]; hitCount: number }> {
  const parsed = adapterSearchResultSchema.safeParse(await adapter.search({
    scenarioKey: dataset.scenarioKey,
    queryKey,
    requesterSubjectKey,
    contextKey: dataset.contextKey,
    channelType: 'group',
    currentAudienceSubjectKeys: [...new Set([
      ...dataset.audience,
      requesterSubjectKey,
    ])],
    query,
    occurredOffsetMs: dataset.events.length * 1_000 + 1_000,
    limit: 10,
  }));
  if (!parsed.success) {
    throw new MemoryEvaluationAdapterError('official_search_result_invalid');
  }
  return {
    passages: parsed.data.hits.map((hit) => {
      const passage = passagesByRecord.get(hit.recordId);
      if (passage === undefined) {
        throw new MemoryEvaluationAdapterError('search_record_unknown');
      }
      return passage;
    }),
    hitCount: parsed.data.hits.length,
  };
}

function validateAnswerJudge(answerJudge: MemoryEvaluationAnswerJudge): void {
  if (!answerJudgeDescriptorSchema.safeParse(answerJudge?.descriptor).success) {
    throw new MemoryEvaluationAdapterError('answer_judge_descriptor_invalid');
  }
  for (const method of ['answer', 'judge', 'close'] as const) {
    if (typeof answerJudge?.[method] !== 'function') {
      throw new MemoryEvaluationAdapterError(`answer_judge_${method}_missing`);
    }
  }
}

export async function evaluateOfficialGroupMemBench(input: {
  conversationPath: string;
  questionsPath: string;
  qtype: GroupMemBenchQtype;
  baseline: Extract<MemoryEvaluationBaseline, { benchmark: 'GroupMemBench' }>;
  adapter: MemoryEvaluationAdapter;
  answerJudge: MemoryEvaluationAnswerJudge;
}): Promise<MemoryOfficialEvaluationReport> {
  validateAnswerJudge(input.answerJudge);
  const dataset = await loadGroupMemBenchDataset(input.conversationPath);
  const questions = await readOfficialQuestionJsonl(
    input.questionsPath,
    groupMemBenchQuestionSchema,
    'groupmembench_question',
  );
  const ingested = await ingestOfficialDataset(dataset, input.adapter);
  let correct = 0;
  let searchHits = 0;
  for (const question of questions) {
    const requester = stableSyntheticIdentity('u', String(question.asking_user_id));
    const search = await searchOfficialQuestion(
      dataset,
      input.adapter,
      ingested.passagesByRecord,
      stableSyntheticIdentity('q', String(question.id)),
      requester,
      `${question.asking_user_id} ${question.question}`,
    );
    searchHits += search.hitCount;
    const answer = answerResultSchema.parse(await input.answerJudge.answer({
      benchmark: 'GroupMemBench',
      question: question.question,
      passages: search.passages,
      options: null,
    }));
    const judgement = judgeResultSchema.parse(await input.answerJudge.judge({
      benchmark: 'GroupMemBench',
      question: question.question,
      referenceAnswer: question.answer,
      candidateAnswer: answer.answer,
      options: null,
    }));
    if (judgement.correct) correct += 1;
  }
  const accuracy = ratio(correct, questions.length);
  const legacy = input.baseline.legacyQQBot.accuracyByQtype[input.qtype];
  const bm25 = input.baseline.bm25.accuracyByQtype[input.qtype];
  const baselinePassed = typeof legacy === 'number'
    && typeof bm25 === 'number'
    && accuracy >= Math.max(legacy, bm25);
  return {
    schemaVersion: 1,
    mode: 'official-benchmark',
    benchmark: 'GroupMemBench',
    modelRevision: input.answerJudge.descriptor.modelRevision,
    counts: {
      messages: dataset.events.length,
      acceptedMessages: ingested.acceptedMessages,
      questions: questions.length,
      answered: questions.length,
      judged: questions.length,
      correct,
      searchHits,
    },
    accuracy: {
      overall: accuracy,
      byQtype: {
        [input.qtype]: {
          questions: questions.length,
          correct,
          accuracy,
        },
      },
      byDimension: {},
    },
    gates: {
      baselinePassed,
      allRequiredPassed: baselinePassed,
    },
  };
}

export async function evaluateOfficialEverMemBench(input: {
  dialoguePath: string;
  questionsPath: string;
  dimension: EverMemBenchDimension;
  baseline: Extract<MemoryEvaluationBaseline, { benchmark: 'EverMemBench' }>;
  adapter: MemoryEvaluationAdapter;
  answerJudge: MemoryEvaluationAnswerJudge;
}): Promise<MemoryOfficialEvaluationReport> {
  validateAnswerJudge(input.answerJudge);
  const dataset = await loadEverMemBenchDataset(input.dialoguePath);
  const rawQuestions = await readBoundedJson(
    input.questionsPath,
    everQuestionsSchema,
    'evermembench_question',
  ) as z.infer<typeof everQuestionsSchema>;
  const questions: EverMemBenchQuestion[] = rawQuestions.qars;
  const ingested = await ingestOfficialDataset(dataset, input.adapter);
  const requester = dataset.audience[0]!;
  let correct = 0;
  let searchHits = 0;
  for (const question of questions) {
    const search = await searchOfficialQuestion(
      dataset,
      input.adapter,
      ingested.passagesByRecord,
      stableSyntheticIdentity('q', String(question.id)),
      requester,
      question.Q,
    );
    searchHits += search.hitCount;
    const answer = answerResultSchema.parse(await input.answerJudge.answer({
      benchmark: 'EverMemBench',
      question: question.Q,
      passages: search.passages,
      options: question.options,
    }));
    const judgement = judgeResultSchema.parse(await input.answerJudge.judge({
      benchmark: 'EverMemBench',
      question: question.Q,
      referenceAnswer: question.A,
      candidateAnswer: answer.answer,
      options: question.options,
    }));
    if (judgement.correct) correct += 1;
  }
  const accuracy = ratio(correct, questions.length);
  const legacy = input.baseline.legacyQQBot.accuracyByDimension[input.dimension];
  const baselinePassed = typeof legacy === 'number' && accuracy >= legacy;
  return {
    schemaVersion: 1,
    mode: 'official-benchmark',
    benchmark: 'EverMemBench',
    modelRevision: input.answerJudge.descriptor.modelRevision,
    counts: {
      messages: dataset.events.length,
      acceptedMessages: ingested.acceptedMessages,
      questions: questions.length,
      answered: questions.length,
      judged: questions.length,
      correct,
      searchHits,
    },
    accuracy: {
      overall: accuracy,
      byQtype: {},
      byDimension: {
        [input.dimension]: {
          questions: questions.length,
          correct,
          accuracy,
        },
      },
    },
    gates: {
      baselinePassed,
      allRequiredPassed: baselinePassed,
    },
  };
}

export function createReplayPseudonym(
  kind: 's' | 'a' | 'm' | 'q' | 'u' | 'g' | 'b' | 'c',
  rawIdentity: string,
  hmacKey: Uint8Array,
): string {
  if (!rawIdentity || hmacKey.byteLength < 32) {
    throw new Error('Replay pseudonymization requires a non-empty identity and a key of at least 32 bytes.');
  }
  const digest = createHmac('sha256', hmacKey)
    .update(`qqbot-memory-evaluation:v1:${kind}:${rawIdentity}`, 'utf8')
    .digest('hex');
  return `qqh1_${kind}_${digest}`;
}

export function toRelativeShiftedTime(
  timestampMs: number,
  shiftedScenarioOriginMs: number,
): number {
  if (
    !Number.isSafeInteger(timestampMs)
    || !Number.isSafeInteger(shiftedScenarioOriginMs)
    || timestampMs < shiftedScenarioOriginMs
  ) {
    throw new Error('Replay timestamps must be safe integers ordered after the shifted scenario origin.');
  }
  return timestampMs - shiftedScenarioOriginMs;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Number((numerator / denominator).toFixed(6));
}

function createQtypeCounters(): Record<MemoryEvaluationQtype, { queries: number; successes: number }> {
  return Object.fromEntries(ALL_QTYPES.map((qtype) => [
    qtype,
    { queries: 0, successes: 0 },
  ])) as Record<MemoryEvaluationQtype, { queries: number; successes: number }>;
}

function createPrivacyCounters(): Record<MemoryEvaluationPrivacyProbe, { probes: number; disclosures: number }> {
  return Object.fromEntries(ALL_PRIVACY_PROBES.map((probe) => [
    probe,
    { probes: 0, disclosures: 0 },
  ])) as Record<MemoryEvaluationPrivacyProbe, { probes: number; disclosures: number }>;
}

function validateAdapterDescriptor(
  descriptor: unknown,
): MemoryEvaluationAdapterDescriptor {
  const parsed = adapterDescriptorSchema.safeParse(descriptor);
  if (!parsed.success) {
    throw new MemoryEvaluationAdapterError('descriptor_invalid');
  }
  return parsed.data;
}

export async function evaluateMemoryScenarios(
  scenarios: readonly MemoryEvaluationScenario[],
  adapter: MemoryEvaluationAdapter,
): Promise<MemoryContractEvaluationReport> {
  const descriptor = validateAdapterDescriptor(adapter.descriptor);
  if (scenarios.length === 0) {
    throw new MemoryEvaluationInputError(0, 'input_empty');
  }
  const sourceFormat = scenarios[0]!.sourceFormat;
  if (scenarios.some((scenario) => scenario.sourceFormat !== sourceFormat)) {
    throw new MemoryEvaluationInputError(0, 'mixed_source_formats');
  }
  let assertions = 0;
  let acceptedAssertions = 0;
  let attributionCorrect = 0;
  let queries = 0;
  let searchHits = 0;
  let explanations = 0;
  let relevantTotal = 0;
  let relevantRetrieved = 0;
  let hitQueries = 0;
  let evidenceMatched = 0;
  let temporalQueries = 0;
  let temporalCorrect = 0;
  let predictedAbstentions = 0;
  let trueAbstentions = 0;
  let correctAbstentions = 0;
  let privacyProbes = 0;
  let privacyDisclosures = 0;

  const qtypes = createQtypeCounters();
  const privacy = createPrivacyCounters();
  for (const scenario of scenarios) {
    await adapter.resetScenario({ scenarioKey: scenario.scenarioKey });
    const recordsByMemoryKey = new Map<string, string>();
    const memoryKeysByRecord = new Map<string, string>();
    const expectedEvidenceByMemoryKey = new Map<string, string>();

    for (const event of scenario.events) {
      assertions += 1;
      const rawResult = await adapter.ingest({
        scenarioKey: scenario.scenarioKey,
        event,
      });
      const parsed = adapterIngestResultSchema.safeParse(rawResult);
      if (!parsed.success) {
        throw new MemoryEvaluationAdapterError('ingest_result_invalid');
      }
      const result = parsed.data;
      if (!result.accepted || !result.recordId) continue;
      if (memoryKeysByRecord.has(result.recordId)) {
        throw new MemoryEvaluationAdapterError('record_identity_reused');
      }
      acceptedAssertions += 1;
      recordsByMemoryKey.set(event.memoryKey, result.recordId);
      memoryKeysByRecord.set(result.recordId, event.memoryKey);
      expectedEvidenceByMemoryKey.set(event.memoryKey, event.eventKey);
      if (result.ownerSubjectKey === event.ownerSubjectKey) {
        attributionCorrect += 1;
      }
    }

    for (const query of scenario.queries) {
      queries += 1;
      qtypes[query.qtype].queries += 1;
      const rawSearch = await adapter.search({
        scenarioKey: scenario.scenarioKey,
        queryKey: query.queryKey,
        requesterSubjectKey: query.requesterSubjectKey,
        contextKey: query.contextKey,
        channelType: query.channelType,
        currentAudienceSubjectKeys: query.currentAudienceSubjectKeys,
        query: query.query,
        occurredOffsetMs: query.occurredOffsetMs,
        limit: 10,
      });
      const parsedSearch = adapterSearchResultSchema.safeParse(rawSearch);
      if (!parsedSearch.success) {
        throw new MemoryEvaluationAdapterError('search_result_invalid');
      }
      const hits = parsedSearch.data.hits;
      for (const hit of hits) {
        if (!memoryKeysByRecord.has(hit.recordId)) {
          throw new MemoryEvaluationAdapterError('search_record_unknown');
        }
      }
      searchHits += hits.length;
      if (hits.length > 0) hitQueries += 1;

      const relevantRecords = query.relevantMemoryKeys
        .map((key) => recordsByMemoryKey.get(key))
        .filter((recordId): recordId is string => Boolean(recordId));
      const relevantSet = new Set(relevantRecords);
      const retrievedRelevant = hits.filter((hit) => relevantSet.has(hit.recordId));
      relevantTotal += query.relevantMemoryKeys.length;
      relevantRetrieved += retrievedRelevant.length;

      for (const hit of hits) {
        const rawExplain = await adapter.explain({
          scenarioKey: scenario.scenarioKey,
          queryKey: query.queryKey,
          recordId: hit.recordId,
        });
        const parsedExplain = adapterExplainResultSchema.safeParse(rawExplain);
        if (!parsedExplain.success || parsedExplain.data.recordId !== hit.recordId) {
          throw new MemoryEvaluationAdapterError('explain_result_invalid');
        }
        explanations += 1;
        const memoryKey = memoryKeysByRecord.get(hit.recordId)!;
        const expectedEvidence = expectedEvidenceByMemoryKey.get(memoryKey);
        if (
          relevantSet.has(hit.recordId)
          && parsedExplain.data.included
          && expectedEvidence
          && parsedExplain.data.evidenceKeys.includes(expectedEvidence)
        ) {
          evidenceMatched += 1;
        }
      }

      let querySuccess: boolean;
      if (query.privacyProbe) {
        privacyProbes += 1;
        privacy[query.privacyProbe].probes += 1;
        const forbiddenRecords = new Set(query.forbiddenMemoryKeys
          .map((key) => recordsByMemoryKey.get(key))
          .filter((recordId): recordId is string => Boolean(recordId)));
        const disclosed = hits.some((hit) => forbiddenRecords.has(hit.recordId));
        if (disclosed) {
          privacyDisclosures += 1;
          privacy[query.privacyProbe].disclosures += 1;
        }
        querySuccess = !disclosed;
      } else if (query.relevantMemoryKeys.length === 0) {
        querySuccess = hits.length === 0;
      } else {
        querySuccess = retrievedRelevant.length === query.relevantMemoryKeys.length;
      }
      if (querySuccess) {
        qtypes[query.qtype].successes += 1;
      }

      const isTrueAbstention = query.relevantMemoryKeys.length === 0;
      const predictedAbstention = hits.length === 0;
      if (isTrueAbstention) trueAbstentions += 1;
      if (predictedAbstention) predictedAbstentions += 1;
      if (isTrueAbstention && predictedAbstention) correctAbstentions += 1;

      if (query.dimension === 'temporal' || query.qtype === 'temporal') {
        temporalQueries += 1;
        const expectedRecordOrder = query.expectedOrder
          .map((key) => recordsByMemoryKey.get(key))
          .filter((recordId): recordId is string => Boolean(recordId));
        const expectedSet = new Set(expectedRecordOrder);
        const actualOrder = hits
          .map((hit) => hit.recordId)
          .filter((recordId) => expectedSet.has(recordId));
        if (
          expectedRecordOrder.length === query.expectedOrder.length
          && actualOrder.length === expectedRecordOrder.length
          && actualOrder.every((recordId, index) => recordId === expectedRecordOrder[index])
        ) {
          temporalCorrect += 1;
        }
      }
    }
  }

  const attributionPrecision = ratio(attributionCorrect, acceptedAssertions);
  const attributionRecall = ratio(attributionCorrect, assertions);
  const attributionF1 = attributionPrecision + attributionRecall === 0
    ? 0
    : Number((
      (2 * attributionPrecision * attributionRecall)
      / (attributionPrecision + attributionRecall)
    ).toFixed(6));
  const evidenceRecallAt10 = ratio(evidenceMatched, relevantTotal);
  const temporalAccuracy = ratio(temporalCorrect, temporalQueries);
  const abstentionPrecision = ratio(correctAbstentions, predictedAbstentions);
  const byQtype = Object.fromEntries(ALL_QTYPES.map((qtype) => [
    qtype,
    {
      queries: qtypes[qtype].queries,
      successRate: ratio(qtypes[qtype].successes, qtypes[qtype].queries),
    },
  ])) as MemoryContractEvaluationReport['retrieval']['byQtype'];
  const privacyByType = Object.fromEntries(ALL_PRIVACY_PROBES.map((probe) => [
    probe,
    {
      probes: privacy[probe].probes,
      disclosures: privacy[probe].disclosures,
      disclosureRate: ratio(
        privacy[probe].disclosures,
        privacy[probe].probes,
      ),
    },
  ])) as MemoryContractEvaluationReport['privacy']['byType'];
  const privacyDisclosureZero = sourceFormat === 'qq-group-replay'
    ? ALL_PRIVACY_PROBES.every((probe) => (
        privacy[probe].probes > 0
        && privacy[probe].disclosures === 0
      ))
    : null;

  const qualityGates = sourceFormat === 'qq-group-replay'
    ? {
      attributionF1: null,
      targetOwnerPrecision: null,
      evidenceRecallAt10: null,
      temporalAccuracy: null,
      abstentionPrecision: null,
    }
    : {
      attributionF1: assertions > 0 && attributionF1 >= 0.995,
      targetOwnerPrecision: acceptedAssertions > 0 && attributionPrecision >= 0.999,
      evidenceRecallAt10: relevantTotal > 0 && evidenceRecallAt10 >= 0.85,
      temporalAccuracy: temporalQueries > 0 && temporalAccuracy >= 0.9,
      abstentionPrecision: trueAbstentions > 0
        && predictedAbstentions > 0
        && abstentionPrecision >= 0.95,
    };
  const qualityPassed = Object.values(qualityGates).every((gate) => gate !== false);
  const allRequiredPassed = sourceFormat === 'qq-group-replay'
    ? privacyDisclosureZero === true
    : qualityPassed;

  return {
    schemaVersion: 1,
    mode: 'contract',
    sourceFormat,
    adapter: {
      runtime: descriptor.runtime,
      name: descriptor.adapterName,
      version: descriptor.adapterVersion,
    },
    counts: {
      scenarios: scenarios.length,
      assertions,
      acceptedAssertions,
      queries,
      searchHits,
      explanations,
    },
    attribution: {
      precision: attributionPrecision,
      recall: attributionRecall,
      f1: attributionF1,
      targetOwnerPrecision: attributionPrecision,
    },
    retrieval: {
      recallAt10: ratio(relevantRetrieved, relevantTotal),
      precisionAt10: ratio(relevantRetrieved, searchHits),
      hitRateAt10: ratio(hitQueries, queries),
      evidenceRecallAt10,
      temporalAccuracy,
      abstentionPrecision,
      abstentionRecall: ratio(correctAbstentions, trueAbstentions),
      byQtype,
    },
    privacy: {
      probes: privacyProbes,
      disclosures: privacyDisclosures,
      disclosureRate: ratio(privacyDisclosures, privacyProbes),
      byType: privacyByType,
    },
    gates: {
      privacyDisclosureZero,
      adapterContractValid: true,
      ...qualityGates,
      allRequiredPassed,
    },
  };
}

async function loadAdapter(adapterPath: string): Promise<MemoryEvaluationAdapter> {
  const moduleUrl = pathToFileURL(resolve(adapterPath)).href;
  const loaded = await import(/* @vite-ignore */ moduleUrl) as Record<string, unknown>;
  if (typeof loaded.createMemoryEvaluationAdapter !== 'function') {
    throw new MemoryEvaluationAdapterError('factory_missing');
  }
  const adapter = await (
    loaded.createMemoryEvaluationAdapter as () => Promise<MemoryEvaluationAdapter>
  )();
  validateAdapterDescriptor(adapter?.descriptor);
  for (const method of ['resetScenario', 'ingest', 'search', 'explain', 'close'] as const) {
    if (typeof adapter?.[method] !== 'function') {
      throw new MemoryEvaluationAdapterError(`method_${method}_missing`);
    }
  }
  return adapter;
}

async function loadAnswerJudge(
  adapterPath: string,
  options: MemoryEvaluationAnswerJudgeOptions,
): Promise<MemoryEvaluationAnswerJudge> {
  const moduleUrl = pathToFileURL(resolve(adapterPath)).href;
  const loaded = await import(/* @vite-ignore */ moduleUrl) as Record<string, unknown>;
  if (typeof loaded.createMemoryEvaluationAnswerJudge !== 'function') {
    throw new MemoryEvaluationAdapterError('answer_judge_factory_missing');
  }
  const answerJudge = await (
    loaded.createMemoryEvaluationAnswerJudge as (
      input: MemoryEvaluationAnswerJudgeOptions,
    ) => Promise<MemoryEvaluationAnswerJudge>
  )(options);
  validateAnswerJudge(answerJudge);
  return answerJudge;
}

async function writeReport(reportPath: string, report: MemoryEvaluationReport): Promise<void> {
  const destination = resolve(reportPath);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.staging-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    const handle = await open(temporary, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

interface ContractCliArguments {
  format: MemoryEvaluationSourceFormat;
  inputPath: string;
  adapterPath: string;
  reportPath: string;
}

interface OfficialGroupCliArguments {
  format: 'groupmembench';
  inputPath: string;
  questionsPath: string;
  qtype: GroupMemBenchQtype;
  baselinePath: string;
  adapterPath: string;
  modelAdapterPath: string;
  modelOptions: MemoryEvaluationAnswerJudgeOptions;
  reportPath: string;
}

interface OfficialEverCliArguments {
  format: 'evermembench';
  inputPath: string;
  questionsPath: string;
  dimension: EverMemBenchDimension;
  baselinePath: string;
  adapterPath: string;
  modelAdapterPath: string;
  modelOptions: MemoryEvaluationAnswerJudgeOptions;
  reportPath: string;
}

type CliArguments =
  | ContractCliArguments
  | OfficialGroupCliArguments
  | OfficialEverCliArguments;

function parseCliArguments(argv: readonly string[]): CliArguments {
  if (argv[0] !== 'run') {
    throw new Error('Usage: memory-evaluation run --format <synthetic-contract|qq-group-replay|groupmembench|evermembench> ...');
  }
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error('Memory evaluation CLI arguments must be explicit key/value pairs.');
    }
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}.`);
    values.set(key, value);
  }
  const allowed = new Set([
    '--format',
    '--input',
    '--questions',
    '--qtype',
    '--dimension',
    '--adapter',
    '--model-adapter',
    '--model-config',
    '--model-kek',
    '--runtime-root',
    '--report',
    '--baseline',
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error(`Unknown argument: ${key}.`);
  }
  const format = values.get('--format');
  if (
    format !== 'synthetic-contract'
    && format !== 'qq-group-replay'
    && format !== 'groupmembench'
    && format !== 'evermembench'
  ) {
    throw new Error('Memory evaluation format is invalid.');
  }
  const inputPath = values.get('--input');
  const adapterPath = values.get('--adapter');
  const reportPath = values.get('--report');
  if (!inputPath || !adapterPath || !reportPath) {
    throw new Error('Memory evaluation requires --input, --adapter, and --report.');
  }
  if (format === 'synthetic-contract' || format === 'qq-group-replay') {
    const disallowed = [
      '--questions',
      '--qtype',
      '--dimension',
      '--model-adapter',
      '--model-config',
      '--model-kek',
      '--runtime-root',
      '--baseline',
    ];
    if (disallowed.some((key) => values.has(key))) {
      throw new Error(`${format} accepts only contract input, adapter, and report paths.`);
    }
    return { format, inputPath, adapterPath, reportPath };
  }
  const questionsPath = values.get('--questions');
  const baselinePath = values.get('--baseline');
  const modelAdapterPath = values.get('--model-adapter');
  const configPath = values.get('--model-config');
  const kekPath = values.get('--model-kek');
  const runtimeRoot = values.get('--runtime-root');
  if (
    !questionsPath
    || !baselinePath
    || !modelAdapterPath
    || !configPath
    || !kekPath
    || !runtimeRoot
  ) {
    throw new Error('Official benchmarks require --questions, --baseline, --model-adapter, --model-config, --model-kek, and --runtime-root.');
  }
  const modelOptions = { configPath, kekPath, runtimeRoot };
  if (format === 'groupmembench') {
    const qtype = officialGroupQtypeSchema.safeParse(values.get('--qtype'));
    if (!qtype.success || values.has('--dimension')) {
      throw new Error('GroupMemBench requires one canonical --qtype and does not accept --dimension.');
    }
    return {
      format,
      inputPath,
      questionsPath,
      qtype: qtype.data,
      baselinePath,
      adapterPath,
      modelAdapterPath,
      modelOptions,
      reportPath,
    };
  }
  const dimension = everDimensionSchema.safeParse(values.get('--dimension'));
  if (!dimension.success || values.has('--qtype')) {
    throw new Error('EverMemBench requires one canonical --dimension and does not accept --qtype.');
  }
  return {
    format,
    inputPath,
    questionsPath,
    dimension: dimension.data,
    baselinePath,
    adapterPath,
    modelAdapterPath,
    modelOptions,
    reportPath,
  };
}

export async function runMemoryEvaluationCli(argv: readonly string[]): Promise<void> {
  const args = parseCliArguments(argv);
  const adapter = await loadAdapter(args.adapterPath);
  let answerJudge: MemoryEvaluationAnswerJudge | null = null;
  try {
    let report: MemoryEvaluationReport;
    if (args.format === 'groupmembench') {
      answerJudge = await loadAnswerJudge(args.modelAdapterPath, args.modelOptions);
      const baseline = await loadMemoryEvaluationBaseline(
        resolve(args.baselinePath),
        'GroupMemBench',
      );
      if (baseline.benchmark !== 'GroupMemBench') {
        throw new MemoryEvaluationInputError(0, 'baseline_format_mismatch');
      }
      report = await evaluateOfficialGroupMemBench({
        conversationPath: resolve(args.inputPath),
        questionsPath: resolve(args.questionsPath),
        qtype: args.qtype,
        baseline,
        adapter,
        answerJudge,
      });
    } else if (args.format === 'evermembench') {
      answerJudge = await loadAnswerJudge(args.modelAdapterPath, args.modelOptions);
      const baseline = await loadMemoryEvaluationBaseline(
        resolve(args.baselinePath),
        'EverMemBench',
      );
      if (baseline.benchmark !== 'EverMemBench') {
        throw new MemoryEvaluationInputError(0, 'baseline_format_mismatch');
      }
      report = await evaluateOfficialEverMemBench({
        dialoguePath: resolve(args.inputPath),
        questionsPath: resolve(args.questionsPath),
        dimension: args.dimension,
        baseline,
        adapter,
        answerJudge,
      });
    } else {
      const scenarios = await loadMemoryEvaluationJsonl(
        resolve(args.inputPath),
        args.format,
      );
      report = await evaluateMemoryScenarios(scenarios, adapter);
    }
    await writeReport(args.reportPath, report);
    const questions = report.mode === 'contract'
      ? report.counts.queries
      : report.counts.questions;
    process.stdout.write(`[info] Memory evaluation completed: ${questions} questions.\n`);
    if (!report.gates.allRequiredPassed) process.exitCode = 2;
  } finally {
    try {
      await answerJudge?.close();
    } finally {
      await adapter.close();
    }
  }
}

function isDirectExecution(): boolean {
  return /(?:^|[/\\])memory-evaluation\.(?:mjs|js|ts)$/u.test(process.argv[1] ?? '');
}

if (isDirectExecution()) {
  runMemoryEvaluationCli(process.argv.slice(2)).catch((error) => {
    if (
      error instanceof MemoryEvaluationInputError
      || error instanceof MemoryEvaluationAdapterError
    ) {
      console.error(error.message);
    } else {
      console.error(error instanceof Error ? error.message : 'Memory evaluation failed.');
    }
    process.exitCode = 1;
  });
}
