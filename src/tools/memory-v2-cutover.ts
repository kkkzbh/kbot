#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { backup, DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { ContextPresetDefinitionV1Schema } from 'koishi-plugin-chatluna/preset-schema';
import YAML from 'yaml';
import { z } from 'zod';
import {
  MEMORY_LEDGER_SCHEMA_VERSION,
  MEMORY_LEDGER_SQLITE_DDL,
  MEMORY_LEDGER_TABLE_NAMES,
  MEMORY_LEDGER_TABLES,
} from '../plugins/memory/schema.js';
import {
  createMemoryExtractLaneKey,
  type MemoryExtractLaneKey,
} from '../plugins/memory/identity.js';
import {
  createMemoryLexicalProjection,
  memoryLexicalProjectionMatches,
  type MemoryLexicalProjectionRow,
} from '../plugins/memory/search-index.js';
import { modelConfigDocumentSchema } from '../plugins/model-config/types.js';

process.umask(0o077);

type CutoverCommand =
  | 'status'
  | 'initialize'
  | 'preflight'
  | 'apply'
  | 'bootstrap-verify'
  | 'probe-gate'
  | 'verify';
type LegacyRecordType = 'fact' | 'episode';
type FaultPoint =
  | 'after-schema'
  | 'after-active-records'
  | 'before-commit'
  | 'after-commit'
  | 'before-publish'
  | 'after-preset-rename-before-fsync'
  | 'after-preset-publish'
  | 'after-model-rename-before-fsync'
  | 'after-model-publish'
  | 'after-database-sidecar-cleanup'
  | 'after-database-rename-before-fsync'
  | 'after-database-publish';

export const EXPECTED_MEMORY_V2_BASELINE = Object.freeze({
  users: 23,
  contexts: 15,
  cursors: 33,
  candidates: 86,
  facts: 180,
  episodes: 193,
  profiles: 4,
  sessions: 0,
  sources: 71,
  provenance: 68,
  jobs: 43,
  auditEvents: 1507,
  tombstones: 0,
  activeFactsSourceContext: 39,
  activeFactsPrivate: 4,
  activeEpisodesSourceContext: 16,
  active: 59,
  purgedFactsUserGroup: 113,
  purgedFactsUser: 24,
  purgedEpisodesUserGroup: 163,
  purgedEpisodesUser: 14,
  purged: 314,
  deadLetterWindows: 37,
  deadLetterLanes: 9,
  legacyFactV3: 0,
  legacyEpisodeV3: 0,
  legacyCandidateV3: 6,
  legacyProfileV4: 0,
  legacyJobV3: 1,
  chatlunaDocstore: 0,
  operationalMemoryEvents: 43,
  operationalMemoryCandidateRefs: 0,
} as const);

export const LEGACY_MEMORY_TABLE_NAMES = Object.freeze([
  'memory_user',
  'memory_context',
  'memory_extract_cursor',
  'memory_candidate',
  'memory_fact',
  'memory_episode',
  'memory_profile',
  'memory_session',
  'memory_source',
  'memory_provenance',
  'memory_job',
  'memory_audit_event',
  'memory_tombstone',
  'memory_fact_v3',
  'memory_episode_v3',
  'memory_candidate_v3',
  'memory_profile_v4',
  'memory_job_v3',
] as const);

const CUTOVER_OPERATION = 'qqbot-memory-ledger-v2';
const ACTOR_KEY = 'system:memory-v2-cutover';
const EXPECTED_EMBEDDING_CONNECTION_ID = 'siliconflow';
const EXPECTED_EMBEDDING_MODEL_ID = 'qwen-qwen3-embedding-8b';
const EXPECTED_EMBEDDING_TRANSPORT_MODEL = 'Qwen/Qwen3-Embedding-8B';
const LEGACY_TABLE_SET = new Set<string>(LEGACY_MEMORY_TABLE_NAMES);
const V2_TABLE_SET = new Set<string>(MEMORY_LEDGER_TABLE_NAMES);
const REVIEWED_PRODUCTION_MISSING_ANCHORS = Object.freeze({
  records: 22,
  anchors: 20,
  digest: '52efe1d0da8d95d2c38a5cce7168e76efc13153ec82756de00569268667c0f16',
} as const);
const RELEVANT_LEGACY_TABLE_NAMES = Object.freeze([
  ...LEGACY_MEMORY_TABLE_NAMES,
  'admin_operational_event',
  'admin_operational_event_occurrence',
] as const);
const RELEVANT_LEGACY_TABLE_SET = new Set<string>(RELEVANT_LEGACY_TABLE_NAMES);
const REVIEWED_LEGACY_INDEX_NAMES = new Set<string>([
  'index:admin_operational_event:source+fingerprint',
  'index:admin_operational_event:source+memoryJobId',
  'index:admin_operational_event:source+unit',
  'index:admin_operational_event:status+lastOccurredAt',
  'index:admin_operational_event:status+occurredAt',
  'index:admin_operational_event_occurrence:eventId+lastOccurredAt',
  'index:memory_audit_event:eventType+createdAt',
  'index:memory_audit_event:turnId',
  'index:memory_audit_event:userKey+contextKey+createdAt',
  'index:memory_candidate:batchId',
  'index:memory_candidate:contextKey+reviewStatus',
  'index:memory_candidate:ownerUserKey+reviewStatus+createdAt',
  'index:memory_candidate_v3:batchId',
  'index:memory_candidate_v3:contextKey+reviewStatus',
  'index:memory_candidate_v3:userKey+reviewStatus+createdAt',
  'index:memory_context:contextKey',
  'index:memory_context:platform+channelType',
  'index:memory_episode:lastAccessedAt',
  'index:memory_episode:memoryKey',
  'index:memory_episode:ownerUserKey+archived',
  'index:memory_episode:ownerUserKey+scopeType+scopeKey+archived',
  'index:memory_episode:ownerUserKey+sourceContextKey+archived',
  'index:memory_episode:ownerUserKey+visibility+sensitivity+archived',
  'index:memory_episode:periodStart',
  'index:memory_episode:scopeKey+lastSeenAt',
  'index:memory_episode:scopeType+scopeKey+archived',
  'index:memory_episode_v3:lastAccessedAt',
  'index:memory_episode_v3:periodStart',
  'index:memory_episode_v3:userKey+archived',
  'index:memory_episode_v3:userKey+sourceContextKey+archived',
  'index:memory_episode_v3:userKey+visibility+sensitivity+archived',
  'index:memory_extract_cursor:conversationId',
  'index:memory_extract_cursor:ownerUserKey+contextKey',
  'index:memory_fact:conflictSetId',
  'index:memory_fact:lastAccessedAt',
  'index:memory_fact:memoryKey',
  'index:memory_fact:ownerUserKey+archived',
  'index:memory_fact:ownerUserKey+kind+topicKey+archived',
  'index:memory_fact:ownerUserKey+kind+topicKey+scopeType+scopeKey+archived',
  'index:memory_fact:ownerUserKey+scopeType+scopeKey+archived',
  'index:memory_fact:ownerUserKey+visibility+sensitivity+archived',
  'index:memory_fact:scopeKey+kind+topicKey',
  'index:memory_fact:scopeKey+topicKey',
  'index:memory_fact:scopeType+scopeKey+archived',
  'index:memory_fact_v3:conflictSetId',
  'index:memory_fact_v3:lastAccessedAt',
  'index:memory_fact_v3:userKey+archived',
  'index:memory_fact_v3:userKey+kind+topicKey+archived',
  'index:memory_fact_v3:userKey+visibility+sensitivity+archived',
  'index:memory_job:jobKey',
  'index:memory_job:jobType+status+nextRunAt',
  'index:memory_job:status+lockedAt',
  'index:memory_job_v3:jobKey',
  'index:memory_job_v3:jobType+status+nextRunAt',
  'index:memory_job_v3:status+lockedAt',
  'index:memory_profile:ownerUserKey+archived',
  'index:memory_profile:ownerUserKey+kind+profileKey+archived',
  'index:memory_profile:ownerUserKey+scopeType+scopeKey+archived',
  'index:memory_provenance:conversationId',
  'index:memory_provenance:memoryType+memoryId',
  'index:memory_provenance:ownerUserKey+contextKey',
  'index:memory_provenance:userKey+contextKey',
  'index:memory_session:expiresAt',
  'index:memory_session:ownerUserKey+contextKey+archived',
  'index:memory_session:sessionKey',
  'index:memory_source:conversationId',
  'index:memory_source:ownerUserKey+contextKey',
  'index:memory_source:sourceId',
  'index:memory_tombstone:createdAt',
  'index:memory_tombstone:userKey+contextKey',
  'index:memory_tombstone:userKey+memoryType+topicKey',
  'index:memory_user:userKey',
]);
const REVIEWED_LEGACY_AUTO_INDEX_OWNERS = new Map<string, string>([
  ['sqlite_autoindex_admin_operational_event_1', 'admin_operational_event'],
  [
    'sqlite_autoindex_admin_operational_event_occurrence_1',
    'admin_operational_event_occurrence',
  ],
]);

interface LegacyMemoryRecord {
  id: number;
  ownerUserKey: string;
  sourceContextKey: string;
  targetSpeakerId: string | null;
  targetSpeakerName: string | null;
  evidenceMessageIds: string | null;
  evidenceSpeakerIds: string | null;
  attributionStatus: string;
  visibility: string;
  scopeType: string | null;
  scopeKey: string | null;
  memoryKey: string | null;
  sensitivity: string;
  retrievalText: string | null;
  importance: number;
  confidence: number;
  validFrom: number | null;
  validUntil: number | null;
  expiresAt: number | null;
  firstSeenAt: number;
  lastSeenAt: number;
  version: number;
  archived: number;
  content?: string;
  title?: string;
  summary?: string;
  periodStart?: number | null;
}

interface ActiveMigrationRecord {
  legacyType: LegacyRecordType;
  legacyId: number;
  legacyRefDigest: string;
  streamId: string;
  eventId: string;
  payloadId: string;
  revision: number;
  assertionType: 'userAssertion' | 'episode';
  subjectKey: string;
  sourceContextKey: string;
  audiencePolicy: 'subjectPrivate';
  audienceContextKeys: string[];
  audienceSnapshots: Record<string, string[]>;
  evidenceCaptureAudienceSubjectKeys: string[];
  audienceDecisionReason:
    | 'legacy-direct-subject-private'
    | 'legacy-capture-audience-unavailable';
  sensitivity: 'low' | 'personal' | 'sensitive' | 'secret';
  content: string;
  retrievalText: string;
  contentHash: string;
  importance: number;
  confidence: number;
  validFrom: number | null;
  validUntil: number | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  evidence: Array<{
    evidenceId: string;
    messageId: string;
    speakerId: string;
    occurredAt: number;
  }>;
}

interface PurgedRecord {
  legacyType: LegacyRecordType;
  legacyId: number;
  legacyRefDigest: string;
  subjectKey: null;
  contextKey: null;
  scopeCatalogState:
    | 'resolved'
    | 'missingUser'
    | 'missingContext'
    | 'missingUserAndContext';
  createdAt: number;
}

interface DeadLetterRecord {
  legacyId: number;
  legacyRefDigest: string;
  workKey: string;
  laneKey: MemoryExtractLaneKey;
  subjectKey: string;
  contextKey: string;
  conversationId: string;
  rangeStartAfterMessageId: string | null;
  latestAnchorMessageId: string;
  anchorObservedAt: number;
  anchorMessageAt: number | null;
  anchorPresent: boolean;
  logicalWindowDigest: string;
  createdAt: number;
  updatedAt: number;
}

interface AdminOperationalPreservationSnapshot {
  preservedEventCount: number;
  preservedOccurrenceCount: number;
  preservedEventDigest: string;
  preservedOccurrenceDigest: string;
  preservedCombinedDigest: string;
  sourceEventBoundaryId: number;
  sourceOccurrenceBoundaryId: number;
  preservedEventIdentityDigest: string;
  preservedOccurrenceIdentityDigest: string;
}

interface LegacyProfileDecision {
  legacyRefDigest: string;
  subjectKey: string;
  contextKey: string;
  derivationMode: 'active-heads-on-read';
  createdAt: number;
}

interface LegacyRemnantDecision {
  legacyType: 'candidateV3' | 'jobV3';
  legacyRefDigest: string;
  createdAt: number;
}

interface EmbeddingIdentity {
  connectionId: string;
  modelId: string;
  transportModel: string;
  canonicalModel: string;
  modelRevision: number;
}

interface ContextPresetMigration {
  id: string;
  path: string;
  originalRaw: string;
  nextRaw: string;
  originalRevision: string;
  nextRevision: string;
  removedBlockId: string;
  mode: number;
}

interface ModelConfigSummary {
  schemaVersion: number;
  removedWorkloads: ['chatluna.defaultEmbedding'];
  sourceSavedRevision: number;
  sourceAppliedRevision: number;
  stagedSavedRevision: number;
  stagedAppliedRevision: number;
  startupAppliedRevision: number;
  extractionSourceMode: 'dedicated';
  extractionMode: 'inheritMain';
  extractionCanonicalModel: string;
  embedding: EmbeddingIdentity;
}

interface ModelConfigTransition {
  summary: ModelConfigSummary;
  originalRaw: string;
  nextRaw: string;
}

export interface MemoryV2CutoverOptions {
  command: CutoverCommand;
  database: string;
  modelConfig: string | null;
  koishiConfig: string | null;
  bundledContextDir: string | null;
  runtimeContextDir: string | null;
  report: string | null;
  preflightReport: string | null;
  backupDir: string | null;
  adminOrigin: string | null;
  systemctl: string;
  confirmServiceStopped: boolean;
  now?: () => Date;
  injectFault?: (point: FaultPoint) => void;
}

export interface MemoryV2PreflightReport {
  schemaVersion: 1;
  operation: typeof CUTOVER_OPERATION;
  command: 'preflight';
  dryRun: true;
  applied: false;
  ledgerSchemaVersion: typeof MEMORY_LEDGER_SCHEMA_VERSION;
  sourceDigest: string;
  planHash: string;
  cutoverEpochMs: number;
  database: {
    legacyTables: string[];
    v2Tables: string[];
    legacyRemnants: {
      memoryFactV3: number;
      memoryEpisodeV3: number;
      memoryCandidateV3: number;
      memoryProfileV4: number;
      memoryJobV3: number;
    };
    chatlunaDocstoreRows: number;
    operationalEvents: {
      memoryLinkedRemoved: number;
      memoryCandidateLinkedRemoved: number;
      nonMemoryPolicy: 'preserve-all';
      removedColumns: ['memoryJobId', 'memoryCandidateId'];
      preservedEventCount: number;
      preservedOccurrenceCount: number;
      preservedEventDigest: string;
      preservedOccurrenceDigest: string;
      preservedCombinedDigest: string;
      sourceEventBoundaryId: number;
      sourceOccurrenceBoundaryId: number;
      preservedEventIdentityDigest: string;
      preservedOccurrenceIdentityDigest: string;
    };
  };
  baseline: typeof EXPECTED_MEMORY_V2_BASELINE;
  decisions: {
    active: number;
    purged: number;
    profilesDerivedOnRead: number;
    profileDerivationMode: 'active-heads-on-read';
    profileSubjectContexts: number;
    profileSourceActiveHeads: number;
    legacyCandidatesPurged: number;
    legacyJobRemnantsPurged: number;
    deadLettersDiscarded: number;
    deadLetterLogicalWindows: number;
    deadLetterLanes: number;
    deadLetterMissingAnchorRecords: number;
    deadLetterMissingAnchors: number;
    deadLetterMissingAnchorDigest: string;
    purgeScopeCatalog: {
      resolved: number;
      missingUser: number;
      missingContext: number;
      missingUserAndContext: number;
      unresolvedDigest: string;
    };
    backfillQueued: number;
    activeRefDigests: string[];
    audienceDecisions: Array<{
      legacyRefDigest: string;
      audiencePolicy: 'subjectPrivate';
      reasonCode:
        | 'legacy-direct-subject-private'
        | 'legacy-capture-audience-unavailable';
    }>;
    purgedRefDigests: string[];
    profileRefDigests: string[];
    deadLetterRefDigests: string[];
  };
  modelConfig: ModelConfigSummary;
  qqbotRuntime: {
    koishiConfigDigest: string;
    chatlunaLongMemoryPluginLoaded: false;
  };
  contextPresets: {
    bundledDigest: string;
    runtimeDigest: string;
    migrated: Array<{
      id: string;
      originalRevision: string;
      nextRevision: string;
      removedBlockId: string;
    }>;
  };
}

export interface MemoryV2ApplyReport
  extends Omit<MemoryV2PreflightReport, 'command' | 'dryRun' | 'applied'> {
  command: 'apply';
  dryRun: false;
  applied: true;
  appliedAt: string;
}

export interface MemoryV2MigrationPlan {
  report: MemoryV2PreflightReport;
  active: ActiveMigrationRecord[];
  purged: PurgedRecord[];
  deadLetters: DeadLetterRecord[];
  profiles: LegacyProfileDecision[];
  legacyRemnants: LegacyRemnantDecision[];
  embedding: EmbeddingIdentity;
  contextPresets: ContextPresetMigration[];
  modelConfigTransition: ModelConfigTransition;
  adminOperationalPreservation: AdminOperationalPreservationSnapshot;
}

interface StatusResult {
  state: 'empty' | 'legacy' | 'v2';
  schemaVersion: number | null;
}

interface InitializeResult {
  state: 'v2';
  schemaVersion: typeof MEMORY_LEDGER_SCHEMA_VERSION;
  initialized: true;
  tables: number;
}

interface VerifyResult {
  state: 'v2';
  schemaVersion: typeof MEMORY_LEDGER_SCHEMA_VERSION;
  savedRevision: number;
  appliedRevision: number;
  extractionMode: 'inheritMain';
  active: number;
  fts: number;
  embeddings: number;
  backfillSucceeded: number;
  backfillIncomplete: 0;
  stranded: 0;
}

interface BootstrapVerifyResult {
  state: 'v2';
  schemaVersion: typeof MEMORY_LEDGER_SCHEMA_VERSION;
  savedRevision: number;
  appliedRevision: number;
  extractionMode: 'inheritMain';
  active: number;
  fts: number;
  embeddings: 0;
  backfillPending: number;
  strandedBeforeBackfill: number;
}

interface ProbeGateResult {
  state: 'ready';
  attemptsPerWorkload: 3;
  extraction: {
    canonicalModel: string;
    schemaValid: true;
  };
  embedding: {
    canonicalModel: string;
    schemaValid: true;
    dimensions: number;
  };
  runtime: {
    enabled: true;
    maintenance: false;
    readEnabled: false;
    writeEnabled: false;
  };
}

function usage(): string {
  return `Usage:
  node dist/tools/memory-v2-cutover.mjs status --database <path>
  node dist/tools/memory-v2-cutover.mjs initialize --database <path> \\
    --confirm-service-stopped [--systemctl <path>]
  node dist/tools/memory-v2-cutover.mjs bootstrap-verify \\
    --database <path> --model-config <path> --koishi-config <path> \\
    --bundled-context-dir <path> --runtime-context-dir <path> \\
    --preflight-report <path>
  node dist/tools/memory-v2-cutover.mjs probe-gate \\
    --database <path> --preflight-report <path> --admin-origin <origin>
  node dist/tools/memory-v2-cutover.mjs verify \\
    --database <path> --model-config <path> --koishi-config <path> \\
    --bundled-context-dir <path> --runtime-context-dir <path> \\
    --preflight-report <path>
  node dist/tools/memory-v2-cutover.mjs preflight \\
    --database <path> --model-config <path> --koishi-config <path> \\
    --bundled-context-dir <path> --runtime-context-dir <path> --report <path>
  node dist/tools/memory-v2-cutover.mjs apply \\
    --database <path> --model-config <path> --koishi-config <path> \\
    --bundled-context-dir <path> --runtime-context-dir <path> \\
    --preflight-report <path> --backup-dir <path> --report <path> \\
    --confirm-service-stopped [--systemctl <path>]
`;
}

function one(values: Map<string, string[]>, key: string): string | null {
  const matches = values.get(key) ?? [];
  if (matches.length > 1) throw new Error(`--${key} may only be provided once.`);
  return matches[0] ?? null;
}

export function parseMemoryV2CutoverArgs(argv: string[]): MemoryV2CutoverOptions {
  const [commandInput, ...args] = argv;
  if (
    commandInput !== 'status'
    && commandInput !== 'initialize'
    && commandInput !== 'preflight'
    && commandInput !== 'apply'
    && commandInput !== 'bootstrap-verify'
    && commandInput !== 'probe-gate'
    && commandInput !== 'verify'
  ) {
    throw new Error(usage());
  }
  const values = new Map<string, string[]>();
  let confirmServiceStopped = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--confirm-service-stopped') {
      confirmServiceStopped = true;
      continue;
    }
    if (!argument.startsWith('--')) throw new Error(`Unknown argument: ${argument}`);
    const key = argument.slice(2);
    if (![
      'database',
      'model-config',
      'koishi-config',
      'bundled-context-dir',
      'runtime-context-dir',
      'report',
      'preflight-report',
      'backup-dir',
      'admin-origin',
      'systemctl',
    ].includes(key)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = args[index + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`${argument} requires a path.`);
    }
    values.set(key, [...(values.get(key) ?? []), value]);
    index += 1;
  }

  const database = one(values, 'database');
  if (!database) throw new Error('--database is required.');
  const command = commandInput;
  const modelConfig = one(values, 'model-config');
  const koishiConfig = one(values, 'koishi-config');
  const bundledContextDir = one(values, 'bundled-context-dir');
  const runtimeContextDir = one(values, 'runtime-context-dir');
  const report = one(values, 'report');
  const preflightReport = one(values, 'preflight-report');
  const backupDir = one(values, 'backup-dir');
  const adminOrigin = one(values, 'admin-origin');
  if (
    command === 'preflight'
    || command === 'apply'
    || command === 'bootstrap-verify'
    || command === 'verify'
  ) {
    if (!modelConfig) throw new Error('--model-config is required.');
    if (!koishiConfig) throw new Error('--koishi-config is required.');
    if (!bundledContextDir) throw new Error('--bundled-context-dir is required.');
    if (!runtimeContextDir) throw new Error('--runtime-context-dir is required.');
  }
  if (command === 'preflight' || command === 'apply') {
    if (!report) throw new Error('--report is required.');
  }
  if (
    (
      command === 'bootstrap-verify'
      || command === 'probe-gate'
      || command === 'verify'
    )
    && !preflightReport
  ) {
    throw new Error('--preflight-report is required for post-start verification.');
  }
  if (command === 'probe-gate' && !adminOrigin) {
    throw new Error('--admin-origin is required for semantic probes.');
  }
  if (command === 'apply') {
    if (!preflightReport) throw new Error('--preflight-report is required for apply.');
    if (!backupDir) throw new Error('--backup-dir is required for apply.');
    if (!confirmServiceStopped) {
      throw new Error('apply requires --confirm-service-stopped.');
    }
  }
  if (command === 'initialize' && !confirmServiceStopped) {
    throw new Error('initialize requires --confirm-service-stopped.');
  }
  return {
    command,
    database: resolve(database),
    modelConfig: modelConfig ? resolve(modelConfig) : null,
    koishiConfig: koishiConfig ? resolve(koishiConfig) : null,
    bundledContextDir: bundledContextDir ? resolve(bundledContextDir) : null,
    runtimeContextDir: runtimeContextDir ? resolve(runtimeContextDir) : null,
    report: report ? resolve(report) : null,
    preflightReport: preflightReport ? resolve(preflightReport) : null,
    backupDir: backupDir ? resolve(backupDir) : null,
    adminOrigin,
    systemctl: resolve(one(values, 'systemctl') ?? '/usr/bin/systemctl'),
    confirmServiceStopped,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    if (Buffer.isBuffer(value)) return { $binary: value.toString('base64') };
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function refDigest(table: string, id: number): string {
  return sha256(`${CUTOVER_OPERATION}\0${table}\0${id}`);
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function tableExists(database: DatabaseSync, table: string): boolean {
  const row = database.prepare(
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table) as { present?: number } | undefined;
  return row?.present === 1;
}

function tableCount(database: DatabaseSync, table: string): number {
  const row = database.prepare(
    `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`,
  ).get() as { count: number };
  return Number(row.count);
}

function readRows<T extends object>(
  database: DatabaseSync,
  table: string,
): T[] {
  return database.prepare(
    `SELECT * FROM ${quoteIdentifier(table)} ORDER BY "id" ASC`,
  ).all() as T[];
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
}

function isSameOrAncestor(candidate: string, target: string): boolean {
  const child = relative(candidate, target);
  return child === ''
    || (
      child !== '..'
      && !child.startsWith(`..${sep}`)
      && !isAbsolute(child)
    );
}

async function assertSafeOutputPath(path: string, label: string): Promise<void> {
  for (const protectedPath of [
    resolve(sep),
    resolve(process.cwd()),
    resolve(homedir()),
  ]) {
    if (isSameOrAncestor(path, protectedPath)) {
      throw new Error(`${label} is too broad or protected: ${path}`);
    }
  }
}

function listMemoryTables(database: DatabaseSync): string[] {
  return (database.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name LIKE 'memory_%'
     ORDER BY name`,
  ).all() as Array<{ name: string }>).map((row) => row.name);
}

function assertKnownMemoryTables(database: DatabaseSync): {
  legacy: string[];
  v2: string[];
} {
  const names = listMemoryTables(database);
  const unknown = names.filter(
    (name) => !LEGACY_TABLE_SET.has(name)
      && !V2_TABLE_SET.has(name),
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown memory tables block cutover: ${unknown.join(', ')}`);
  }
  return {
    legacy: names.filter((name) => LEGACY_TABLE_SET.has(name)),
    v2: names.filter((name) => V2_TABLE_SET.has(name)),
  };
}

interface RelevantLegacySchemaObject {
  type: 'table' | 'index' | 'trigger' | 'view';
  name: string;
  table: string;
  sql: string | null;
}

function normalizeSqlSchema(sql: string | null): string | null {
  return sql?.trim().replace(/\s+/gu, ' ') ?? null;
}

function schemaObjectReferencesLegacyScope(
  table: string,
  normalizedSql: string | null,
): boolean {
  if (table.startsWith('memory_') || RELEVANT_LEGACY_TABLE_SET.has(table)) {
    return true;
  }
  return normalizedSql != null && (
    /\bmemory_[A-Za-z0-9_]+\b/u.test(normalizedSql)
    || /\badmin_operational_event(?:_occurrence)?\b/u.test(normalizedSql)
  );
}

function reviewedExplicitIndexOwner(name: string): string | null {
  if (!REVIEWED_LEGACY_INDEX_NAMES.has(name)) return null;
  const match = /^index:([^:]+):/u.exec(name);
  if (!match) {
    throw new Error(`Reviewed legacy SQLite index has an invalid name: ${name}`);
  }
  return match[1]!;
}

function relevantLegacySchema(
  database: DatabaseSync,
): RelevantLegacySchemaObject[] {
  const rows = database.prepare(
    `SELECT type, name, tbl_name AS "table", sql
       FROM sqlite_master
      WHERE type IN ('table', 'index', 'trigger', 'view')
      ORDER BY type, name`,
  ).all() as Array<{
    type: RelevantLegacySchemaObject['type'];
    name: string;
    table: string;
    sql: string | null;
  }>;
  const relevant = rows
    .map((row) => ({
      ...row,
      sql: normalizeSqlSchema(row.sql),
    }))
    .filter((row) => schemaObjectReferencesLegacyScope(row.table, row.sql));
  for (const object of relevant) {
    if (object.type === 'table') {
      if (!RELEVANT_LEGACY_TABLE_SET.has(object.name) || object.table !== object.name) {
        throw new Error(
          `Unknown relevant SQLite table blocks cutover: ${object.name}`,
        );
      }
      continue;
    }
    if (object.type === 'trigger' || object.type === 'view') {
      throw new Error(
        `Unknown relevant SQLite ${object.type} blocks cutover: ${object.name}`,
      );
    }
    const explicitOwner = reviewedExplicitIndexOwner(object.name);
    const autoOwner = REVIEWED_LEGACY_AUTO_INDEX_OWNERS.get(object.name) ?? null;
    const expectedOwner = explicitOwner ?? autoOwner;
    if (!expectedOwner || expectedOwner !== object.table) {
      throw new Error(
        `Unknown relevant SQLite index blocks cutover: ${object.name}`,
      );
    }
    if ((explicitOwner == null) !== (object.sql == null)) {
      throw new Error(
        `Relevant SQLite index definition is invalid: ${object.name}`,
      );
    }
  }
  return relevant;
}

export async function inspectMemoryV2Status(databasePath: string): Promise<StatusResult> {
  await assertRegularFile(databasePath, 'SQLite database');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = assertKnownMemoryTables(database);
    if (tables.legacy.length > 0 && tables.v2.length > 0) {
      throw new Error('Mixed legacy and Memory Ledger V2 tables require manual recovery.');
    }
    if (tables.legacy.length > 0) {
      return { state: 'legacy', schemaVersion: null };
    }
    if (tables.v2.length === 0) {
      return { state: 'empty', schemaVersion: null };
    }
    for (const table of MEMORY_LEDGER_TABLE_NAMES) {
      if (!tableExists(database, table)) {
        throw new Error(`Incomplete Memory Ledger V2 schema: missing ${table}`);
      }
    }
    const meta = database.prepare(
      `SELECT value FROM "memory_v2_meta" WHERE key = 'schemaVersion'`,
    ).get() as { value?: string } | undefined;
    const schemaVersion = Number(meta?.value);
    if (schemaVersion !== MEMORY_LEDGER_SCHEMA_VERSION) {
      throw new Error(
        `Memory Ledger schemaVersion must be ${MEMORY_LEDGER_SCHEMA_VERSION}, received ${String(meta?.value)}`,
      );
    }
    return { state: 'v2', schemaVersion };
  } finally {
    database.close();
  }
}

function assertExactCount(
  database: DatabaseSync,
  table: string,
  expected: number,
): void {
  if (!tableExists(database, table)) throw new Error(`Missing legacy table: ${table}`);
  const actual = tableCount(database, table);
  if (actual !== expected) {
    throw new Error(`${table} count drifted: expected ${expected}, received ${actual}`);
  }
}

const ADMIN_OPERATIONAL_EVENT_CANONICAL_COLUMNS = Object.freeze([
  'id',
  'sourceKey',
  'source',
  'type',
  'severity',
  'status',
  'resolution',
  'title',
  'summary',
  'unit',
  'invocationId',
  'occurredAt',
  'acknowledgedAt',
  'resolvedAt',
  'updatedAt',
  'component',
  'fingerprint',
  'details',
  'occurrenceCount',
  'lastOccurredAt',
] as const);

function queryRowsDigest(
  database: DatabaseSync,
  namespace: string,
  sql: string,
  params: readonly SQLInputValue[] = [],
): { count: number; digest: string } {
  const hash = createHash('sha256');
  hash.update(`${CUTOVER_OPERATION}\0${namespace}\0v1`);
  let count = 0;
  const rows = database.prepare(sql).iterate(...params) as Iterable<Record<string, unknown>>;
  for (const row of rows) {
    hash.update('\0row\0');
    hash.update(stableJson(row));
    count += 1;
  }
  return { count, digest: hash.digest('hex') };
}

const ADMIN_OPERATIONAL_ALLOCATOR_PROBE_ROWS = Object.freeze({
  admin_operational_event: Object.freeze({
    columns: Object.freeze([
      'sourceKey',
      'source',
      'type',
      'severity',
      'status',
      'resolution',
      'title',
      'summary',
      'unit',
      'invocationId',
      'occurredAt',
      'acknowledgedAt',
      'resolvedAt',
      'updatedAt',
      'component',
      'fingerprint',
      'details',
      'occurrenceCount',
      'lastOccurredAt',
    ]),
    values: Object.freeze([
      'allocator-probe:event',
      'allocator-probe',
      'allocator_probe',
      'warning',
      'open',
      null,
      'Allocator probe',
      'Allocator probe',
      null,
      null,
      1,
      null,
      null,
      1,
      'allocator-probe',
      'allocator-probe',
      'Allocator probe',
      1,
      1,
    ] satisfies SQLInputValue[]),
  }),
  admin_operational_event_occurrence: Object.freeze({
    columns: Object.freeze([
      'sourceKey',
      'eventId',
      'summary',
      'details',
      'occurrenceCount',
      'unit',
      'invocationId',
      'firstOccurredAt',
      'lastOccurredAt',
      'updatedAt',
    ]),
    values: Object.freeze([
      'allocator-probe:occurrence',
      1,
      'Allocator probe',
      'Allocator probe',
      1,
      null,
      null,
      1,
      1,
      1,
    ] satisfies SQLInputValue[]),
  }),
} as const);

type AdminOperationalAllocatorTable =
  keyof typeof ADMIN_OPERATIONAL_ALLOCATOR_PROBE_ROWS;

interface SqliteTableColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: unknown;
  readonly pk: number;
  readonly hidden: number;
}

function assertOperationalAllocatorColumns(
  probe: DatabaseSync,
  table: AdminOperationalAllocatorTable,
): void {
  const columns = probe.prepare(
    `PRAGMA table_xinfo(${quoteIdentifier(table)})`,
  ).all() as unknown as SqliteTableColumnInfo[];
  const definition = ADMIN_OPERATIONAL_ALLOCATOR_PROBE_ROWS[table];
  const canonicalNames = new Set(['id', ...definition.columns]);
  const legacyEventNames = new Set([
    ...canonicalNames,
    'memoryJobId',
    'memoryCandidateId',
  ]);
  const matches = (expected: ReadonlySet<string>) => (
    columns.length === expected.size
    && columns.every((column) => expected.has(column.name))
  );
  const hasExpectedColumns = table === 'admin_operational_event'
    ? matches(canonicalNames) || matches(legacyEventNames)
    : matches(canonicalNames);
  if (!hasExpectedColumns || columns.some((column) => column.hidden !== 0)) {
    throw new Error('allocator table columns are not canonical');
  }
  const id = columns.find((column) => column.name === 'id');
  if (
    !id
    || id.type.trim().toUpperCase() !== 'INTEGER'
    || id.pk !== 1
    || id.dflt_value !== null
    || columns.some((column) => column.name !== 'id' && column.pk !== 0)
  ) {
    throw new Error('id is not the canonical INTEGER PRIMARY KEY rowid');
  }
}

function assertTableIdAllocatorBehavior(
  database: DatabaseSync,
  table: AdminOperationalAllocatorTable,
): void {
  const schema = database.prepare(
    `SELECT "sql"
       FROM "sqlite_master"
      WHERE "type" = 'table' AND "name" = ?`,
  ).get(table) as { sql?: string } | undefined;
  if (!schema?.sql) {
    throw new Error(`Admin operational table schema is missing: ${table}.`);
  }
  const quotedTable = `(?:"${table}"|\`${table}\`|\\[${table}\\]|${table})`;
  const createTablePrefix = new RegExp(
    `^\\s*CREATE\\s+TABLE\\s+${quotedTable}\\s*\\(`,
    'iu',
  );
  if (!createTablePrefix.test(schema.sql)) {
    throw new Error(
      `Admin operational table schema is not a direct CREATE TABLE: ${table}.`,
    );
  }
  const probe = new DatabaseSync(':memory:');
  try {
    probe.prepare(schema.sql).run();
    const recreated = probe.prepare(
      `SELECT "sql"
         FROM "sqlite_master"
        WHERE "type" = 'table' AND "name" = ?`,
    ).get(table) as { sql?: string } | undefined;
    if (recreated?.sql !== schema.sql) {
      throw new Error('schema contains a trailing statement or unparsed SQL');
    }
    assertOperationalAllocatorColumns(probe, table);
    const definition = ADMIN_OPERATIONAL_ALLOCATOR_PROBE_ROWS[table];
    const columns = definition.columns.map(quoteIdentifier);
    const placeholders = definition.columns.map(() => '?').join(', ');
    const boundary = 1_000_000;
    const valuesFor = (suffix: string): SQLInputValue[] => (
      definition.values.map((value, index) => (
        index === 0 ? `${String(value)}:${suffix}` : value
      ))
    );
    const explicit = probe.prepare(
      `INSERT INTO ${quoteIdentifier(table)}
        (${quoteIdentifier('id')}, ${columns.join(', ')})
       VALUES (?, ${placeholders})
       RETURNING ${quoteIdentifier('id')} AS "id", rowid AS "actualRowId"`,
    ).get(boundary, ...valuesFor('explicit')) as {
      id?: number;
      actualRowId?: number;
    } | undefined;
    if (Number(explicit?.id) !== boundary || Number(explicit?.actualRowId) !== boundary) {
      throw new Error('explicit id is not the table rowid');
    }
    probe.prepare(
      `DELETE FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier('id')} = ?`,
    ).run(boundary);
    const sequenceRows = probe.prepare(
      `SELECT "seq" FROM "sqlite_sequence" WHERE "name" = ?`,
    ).all(table) as Array<{ seq: number }>;
    if (sequenceRows.length !== 1) {
      throw new Error('allocator sequence row was not created');
    }
    probe.prepare(
      `UPDATE "sqlite_sequence" SET "seq" = ? WHERE "name" = ?`,
    ).run(boundary, table);
    for (const offset of [1, 2] as const) {
      const expected = boundary + offset;
      const allocated = probe.prepare(
        `INSERT INTO ${quoteIdentifier(table)}
          (${columns.join(', ')})
         VALUES (${placeholders})
         RETURNING ${quoteIdentifier('id')} AS "id", rowid AS "actualRowId"`,
      ).get(...valuesFor(`implicit-${offset}`)) as {
        id?: number;
        actualRowId?: number;
      } | undefined;
      if (
        Number(allocated?.id) !== expected
        || Number(allocated?.actualRowId) !== expected
      ) {
        throw new Error(
          `implicit id ${String(allocated?.id)} is not canonical rowid ${expected}`,
        );
      }
    }
    const finalSequence = probe.prepare(
      `SELECT "seq" FROM "sqlite_sequence" WHERE "name" = ?`,
    ).get(table) as { seq?: number } | undefined;
    if (Number(finalSequence?.seq) !== boundary + 2) {
      throw new Error('allocator sequence did not track canonical rowid');
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Admin operational table failed isolated allocator probe: ${table}: ${detail}`,
    );
  } finally {
    probe.close();
  }
}

function tableIdBoundary(
  database: DatabaseSync,
  table: AdminOperationalAllocatorTable,
): number {
  assertTableIdAllocatorBehavior(database, table);
  if (!tableExists(database, 'sqlite_sequence')) {
    throw new Error('SQLite allocator table is missing.');
  }
  const row = database.prepare(
    `SELECT COALESCE(MAX("id"), 0) AS boundary
       FROM ${quoteIdentifier(table)}`,
  ).get() as { boundary: number };
  const maxId = Number(row.boundary);
  const sequenceRows = database.prepare(
    `SELECT "seq" FROM "sqlite_sequence" WHERE "name" = ?`,
  ).all(table) as Array<{ seq: number }>;
  if (sequenceRows.length !== 1) {
    throw new Error(`SQLite allocator state is missing or duplicated for ${table}.`);
  }
  const sequence = Number(sequenceRows[0]!.seq);
  if (
    !Number.isSafeInteger(maxId)
    || maxId < 0
    || !Number.isSafeInteger(sequence)
    || sequence < 0
  ) {
    throw new Error(`Invalid Admin operational ID allocator state for ${table}.`);
  }
  return Math.max(maxId, sequence);
}

function setTableIdBoundary(
  database: DatabaseSync,
  table: AdminOperationalAllocatorTable,
  boundary: number,
): void {
  if (!Number.isSafeInteger(boundary) || boundary < 0) {
    throw new Error(`Invalid Admin operational ID boundary for ${table}.`);
  }
  assertTableIdAllocatorBehavior(database, table);
  if (!tableExists(database, 'sqlite_sequence')) {
    throw new Error('SQLite allocator table is missing.');
  }
  const sequenceRows = database.prepare(
    `SELECT "seq" FROM "sqlite_sequence" WHERE "name" = ?`,
  ).all(table) as Array<{ seq: number }>;
  if (sequenceRows.length !== 1) {
    throw new Error(`SQLite allocator state is missing or duplicated for ${table}.`);
  }
  database.prepare(
    `UPDATE "sqlite_sequence" SET "seq" = ? WHERE "name" = ?`,
  ).run(boundary, table);
}

function adminOperationalPreservationSnapshot(
  database: DatabaseSync,
  sourceBoundaries?: {
    eventId: number;
    occurrenceId: number;
  },
): AdminOperationalPreservationSnapshot {
  const columns = new Set(
    (database.prepare(
      'PRAGMA table_info("admin_operational_event")',
    ).all() as Array<{ name: string }>).map((column) => column.name),
  );
  const hasLegacyMemoryColumns = (
    columns.has('memoryJobId') && columns.has('memoryCandidateId')
  );
  if (
    columns.has('memoryJobId') !== columns.has('memoryCandidateId')
  ) {
    throw new Error(
      'Admin operational event legacy columns are partially present.',
    );
  }
  const missingCanonicalColumns = ADMIN_OPERATIONAL_EVENT_CANONICAL_COLUMNS.filter(
    (column) => !columns.has(column),
  );
  if (missingCanonicalColumns.length > 0) {
    throw new Error(
      `Admin operational event table is missing canonical columns: `
      + `${missingCanonicalColumns.join(', ')}`,
    );
  }
  const projection = ADMIN_OPERATIONAL_EVENT_CANONICAL_COLUMNS
    .map((column) => quoteIdentifier(column))
    .join(', ');
  const events = queryRowsDigest(
    database,
    'admin-operational-preserved-events',
    `SELECT ${projection}
       FROM "admin_operational_event"
       ${hasLegacyMemoryColumns
    ? `WHERE "memoryJobId" IS NULL AND "memoryCandidateId" IS NULL`
    : ''}
      ORDER BY "id" ASC`,
  );
  const orphanOccurrences = database.prepare(
    `SELECT COUNT(*) AS count
       FROM "admin_operational_event_occurrence" occurrence
       LEFT JOIN "admin_operational_event" event
         ON event.id = occurrence.eventId
      WHERE event.id IS NULL`,
  ).get() as { count: number };
  if (Number(orphanOccurrences.count) !== 0) {
    throw new Error(
      'Admin operational event occurrences contain orphan event references.',
    );
  }
  const occurrences = queryRowsDigest(
    database,
    'admin-operational-preserved-occurrences',
    `SELECT *
       FROM "admin_operational_event_occurrence"
      ORDER BY "id" ASC`,
  );
  const sourceEventBoundaryId = sourceBoundaries?.eventId
    ?? tableIdBoundary(database, 'admin_operational_event');
  const sourceOccurrenceBoundaryId = sourceBoundaries?.occurrenceId
    ?? tableIdBoundary(database, 'admin_operational_event_occurrence');
  const eventIdentities = queryRowsDigest(
    database,
    'admin-operational-preserved-event-identities',
    `SELECT "id", "sourceKey", "source", "type", "title", "component"
       FROM "admin_operational_event"
      WHERE "id" <= ?
        ${hasLegacyMemoryColumns
    ? `AND "memoryJobId" IS NULL AND "memoryCandidateId" IS NULL`
    : ''}
      ORDER BY "id" ASC`,
    [sourceEventBoundaryId],
  );
  const occurrenceIdentities = queryRowsDigest(
    database,
    'admin-operational-preserved-occurrence-identities',
    `SELECT "id", "sourceKey", "eventId"
       FROM "admin_operational_event_occurrence"
      WHERE "id" <= ?
      ORDER BY "id" ASC`,
    [sourceOccurrenceBoundaryId],
  );
  return {
    preservedEventCount: events.count,
    preservedOccurrenceCount: occurrences.count,
    preservedEventDigest: events.digest,
    preservedOccurrenceDigest: occurrences.digest,
    preservedCombinedDigest: sha256(stableJson({
      eventCount: events.count,
      eventDigest: events.digest,
      occurrenceCount: occurrences.count,
      occurrenceDigest: occurrences.digest,
    })),
    sourceEventBoundaryId,
    sourceOccurrenceBoundaryId,
    preservedEventIdentityDigest: eventIdentities.digest,
    preservedOccurrenceIdentityDigest: occurrenceIdentities.digest,
  };
}

function assertRuntimeOperationalPreservation(
  database: DatabaseSync,
  expected: AdminOperationalPreservationSnapshot,
): void {
  const actual = adminOperationalPreservationSnapshot(database, {
    eventId: expected.sourceEventBoundaryId,
    occurrenceId: expected.sourceOccurrenceBoundaryId,
  });
  if (
    actual.preservedEventCount < expected.preservedEventCount
    || actual.preservedOccurrenceCount < expected.preservedOccurrenceCount
  ) {
    throw new Error(
      'Admin operational event runtime tables lost preserved records.',
    );
  }
  if (
    actual.preservedEventIdentityDigest !== expected.preservedEventIdentityDigest
    || actual.preservedOccurrenceIdentityDigest
      !== expected.preservedOccurrenceIdentityDigest
  ) {
    throw new Error(
      'Admin operational event runtime preservation identities changed after cutover.',
    );
  }
  for (const [table, boundary] of [
    ['admin_operational_event', expected.sourceEventBoundaryId],
    [
      'admin_operational_event_occurrence',
      expected.sourceOccurrenceBoundaryId,
    ],
  ] as const) {
    assertTableIdAllocatorBehavior(database, table);
    const sequenceRows = database.prepare(
      `SELECT "seq"
         FROM "sqlite_sequence"
        WHERE "name" = ?`,
    ).all(table) as Array<{ seq: number }>;
    const sequence = Number(sequenceRows[0]?.seq);
    if (
      sequenceRows.length !== 1
      || !Number.isSafeInteger(sequence)
      || sequence < boundary
    ) {
      throw new Error(
        `Admin operational runtime ID boundary regressed for ${table}.`,
      );
    }
  }
}

function assertOperationalEventCleanupContract(database: DatabaseSync): void {
  for (const table of [
    'admin_operational_event',
    'admin_operational_event_occurrence',
  ]) {
    if (!tableExists(database, table)) {
      throw new Error(`Missing Admin operational event table: ${table}`);
    }
  }
  const columns = new Set(
    (database.prepare(
      'PRAGMA table_info("admin_operational_event")',
    ).all() as Array<{ name: string }>).map((column) => column.name),
  );
  for (const column of ['memoryJobId', 'memoryCandidateId']) {
    if (!columns.has(column)) {
      throw new Error(`Admin operational event legacy column is missing: ${column}`);
    }
  }
  const memoryJobRefs = countWhere(
    database,
    'admin_operational_event',
    `"memoryJobId" IS NOT NULL`,
  );
  if (memoryJobRefs !== EXPECTED_MEMORY_V2_BASELINE.operationalMemoryEvents) {
    throw new Error(
      `Admin operational memory event count drifted: expected `
      + `${EXPECTED_MEMORY_V2_BASELINE.operationalMemoryEvents}, received ${memoryJobRefs}`,
    );
  }
  const memoryCandidateRefs = countWhere(
    database,
    'admin_operational_event',
    `"memoryCandidateId" IS NOT NULL`,
  );
  if (
    memoryCandidateRefs
    !== EXPECTED_MEMORY_V2_BASELINE.operationalMemoryCandidateRefs
  ) {
    throw new Error(
      `Admin operational memory candidate references drifted: expected `
      + `${EXPECTED_MEMORY_V2_BASELINE.operationalMemoryCandidateRefs}, `
      + `received ${memoryCandidateRefs}`,
    );
  }
  const memorySourceRows = countWhere(
    database,
    'admin_operational_event',
    `"source" = 'memory'`,
  );
  if (memorySourceRows !== memoryJobRefs) {
    throw new Error(
      'Admin operational memory events are not exactly the legacy job-linked events.',
    );
  }
  const invalidPreservedRows = countWhere(
    database,
    'admin_operational_event',
    `("memoryJobId" IS NULL AND "memoryCandidateId" IS NULL)
      AND (
        "sourceKey" IS NULL OR "sourceKey" = ''
        OR "source" IS NULL OR "source" = ''
        OR "type" IS NULL OR "type" = ''
        OR "severity" IS NULL OR "severity" = ''
        OR "status" IS NULL OR "status" = ''
        OR "title" IS NULL OR "title" = ''
        OR "summary" IS NULL
        OR "occurredAt" IS NULL
        OR "updatedAt" IS NULL
      )`,
  );
  if (invalidPreservedRows !== 0) {
    throw new Error(
      'Non-memory Admin operational events violate the canonical table contract.',
    );
  }
  const invalidRefs = database.prepare(
    `SELECT COUNT(*) AS count
       FROM "admin_operational_event" event
       LEFT JOIN "memory_job" job ON job.id = event.memoryJobId
      WHERE event.memoryJobId IS NOT NULL
        AND (
          job.id IS NULL
          OR event.source <> 'memory'
          OR event.type <> 'memory_job_dead_letter'
        )`,
  ).get() as { count: number };
  if (Number(invalidRefs.count) !== 0) {
    throw new Error('Admin operational memory events do not map exactly to legacy dead letters.');
  }
  const linkedOccurrences = database.prepare(
    `SELECT COUNT(*) AS count
       FROM "admin_operational_event_occurrence" occurrence
       JOIN "admin_operational_event" event ON event.id = occurrence.eventId
      WHERE event.memoryJobId IS NOT NULL
         OR event.memoryCandidateId IS NOT NULL`,
  ).get() as { count: number };
  if (Number(linkedOccurrences.count) !== 0) {
    throw new Error(
      'Admin operational memory events have occurrence rows and require explicit review.',
    );
  }
  adminOperationalPreservationSnapshot(database);
}

function parseStringArray(value: unknown, label: string): string[] {
  if (typeof value !== 'string') throw new Error(`${label} must be a JSON array.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (
    !Array.isArray(parsed)
    || parsed.length === 0
    || parsed.some((item) => typeof item !== 'string' || item.trim().length === 0)
  ) {
    throw new Error(`${label} must contain non-empty string values.`);
  }
  return parsed.map((item) => (item as string).trim());
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function finiteNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be finite.`);
  return number;
}

function nullableFiniteNumber(value: unknown, label: string): number | null {
  if (value == null) return null;
  return finiteNumber(value, label);
}

function sensitivity(value: unknown, label: string): ActiveMigrationRecord['sensitivity'] {
  if (value === 'low' || value === 'personal' || value === 'sensitive' || value === 'secret') {
    return value;
  }
  throw new Error(`${label} has unsupported sensitivity: ${String(value)}`);
}

function isVerifiedActiveRecord(row: LegacyMemoryRecord): boolean {
  return row.attributionStatus === 'verified'
    && Number(row.archived) === 0
    && typeof row.targetSpeakerId === 'string'
    && row.targetSpeakerId.trim().length > 0
    && typeof row.evidenceMessageIds === 'string'
    && typeof row.evidenceSpeakerIds === 'string'
    && (
      (
        row.scopeType === 'dm_only'
        && row.visibility === 'private_only'
      )
      || (
        row.scopeType === 'source_context_only'
        && row.visibility === 'source_context_only'
      )
    );
}

interface LegacyScopeIdentityCatalog {
  users: ReadonlySet<string>;
  directContexts: ReadonlySet<string>;
  groupContexts: ReadonlySet<string>;
  runtimeIdentities: ReadonlySet<string>;
  directContextIdentities: ReadonlySet<string>;
  groupContextIdentities: ReadonlySet<string>;
}

function legacyScopeIdentityCatalog(
  database: DatabaseSync,
): LegacyScopeIdentityCatalog {
  const users = new Set(
    readRows<{
      platform: string;
      userId: string;
    }>(database, 'memory_user').map((row) => stableJson([
      nonEmptyString(row.platform, 'memory_user.platform'),
      nonEmptyString(row.userId, 'memory_user.userId'),
    ])),
  );
  const directContexts = new Set<string>();
  const groupContexts = new Set<string>();
  const runtimeIdentities = new Set<string>();
  const directContextIdentities = new Set<string>();
  const groupContextIdentities = new Set<string>();
  for (const row of readRows<{
    platform: string;
    botSelfId: string;
    channelType: string;
    groupId: string | null;
    channelId: string | null;
    rawContextId: string | null;
  }>(database, 'memory_context')) {
    const platform = nonEmptyString(row.platform, 'memory_context.platform');
    const botSelfId = nonEmptyString(row.botSelfId, 'memory_context.botSelfId');
    runtimeIdentities.add(stableJson([platform, botSelfId]));
    if (row.channelType === 'group') {
      const groupId = nonEmptyString(row.groupId, 'memory_context.groupId');
      groupContexts.add(stableJson([
        platform,
        botSelfId,
        groupId,
      ]));
      groupContextIdentities.add(stableJson([platform, groupId]));
      continue;
    }
    if (row.channelType !== 'direct') {
      throw new Error(
        `memory_context has unsupported channelType: ${String(row.channelType)}`,
      );
    }
    for (const raw of [row.channelId, row.rawContextId]) {
      if (typeof raw !== 'string' || !raw.startsWith('private:')) continue;
      const userId = raw.slice('private:'.length);
      if (userId && !userId.includes(':')) {
        directContexts.add(stableJson([platform, botSelfId, userId]));
        directContextIdentities.add(stableJson([platform, userId]));
      }
    }
  }
  return {
    users,
    directContexts,
    groupContexts,
    runtimeIdentities,
    directContextIdentities,
    groupContextIdentities,
  };
}

function isBlankLegacyIdentity(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

function assertCanonicalPurgeScope(
  row: LegacyMemoryRecord,
  type: LegacyRecordType,
  catalog: LegacyScopeIdentityCatalog,
): PurgedRecord['scopeCatalogState'] {
  const label = `${type} ${row.id}`;
  const scopeKey = nonEmptyString(row.scopeKey, `${label}.scopeKey`);
  if (scopeKey !== row.scopeKey) {
    throw new Error(`${label}.scopeKey is not canonical.`);
  }
  if (row.scopeType === 'user') {
    const match = scopeKey.match(/^([^:\s]+):([^:\s]+):user:([^:\s]+)$/u);
    if (!match) {
      throw new Error(`${label}.scopeKey does not match canonical legacy user scope.`);
    }
    const [, platform, botSelfId, userId] = match;
    if (!catalog.runtimeIdentities.has(stableJson([platform, botSelfId]))) {
      throw new Error(`${label}.scopeKey uses an unknown runtime identity.`);
    }
    const userResolved = catalog.users.has(stableJson([platform, userId]));
    const contextResolved = catalog.directContexts.has(
      stableJson([platform, botSelfId, userId]),
    );
    if (
      !contextResolved
      && catalog.directContextIdentities.has(stableJson([platform, userId]))
    ) {
      throw new Error(`${label}.scopeKey conflicts with an existing legacy user lane.`);
    }
    if (userResolved && contextResolved) return 'resolved';
    if (!userResolved && !contextResolved) return 'missingUserAndContext';
    return userResolved ? 'missingContext' : 'missingUser';
  }
  if (row.scopeType === 'user_group') {
    const match = scopeKey.match(
      /^([^:\s]+):([^:\s]+):group:([^:\s]+):user:([^:\s]+)$/u,
    );
    if (!match) {
      throw new Error(`${label}.scopeKey does not match canonical legacy group scope.`);
    }
    const [, platform, botSelfId, groupId, userId] = match;
    if (!catalog.runtimeIdentities.has(stableJson([platform, botSelfId]))) {
      throw new Error(`${label}.scopeKey uses an unknown runtime identity.`);
    }
    const userResolved = catalog.users.has(stableJson([platform, userId]));
    const contextResolved = catalog.groupContexts.has(
      stableJson([platform, botSelfId, groupId]),
    );
    if (
      !contextResolved
      && catalog.groupContextIdentities.has(stableJson([platform, groupId]))
    ) {
      throw new Error(`${label}.scopeKey conflicts with an existing legacy group lane.`);
    }
    if (userResolved && contextResolved) return 'resolved';
    if (!userResolved && !contextResolved) return 'missingUserAndContext';
    return userResolved ? 'missingContext' : 'missingUser';
  }
  throw new Error(`${label}.scopeType is not an approved purge scope.`);
}

function assertPurgeShape(
  row: LegacyMemoryRecord,
  type: LegacyRecordType,
  catalog: LegacyScopeIdentityCatalog,
): PurgedRecord['scopeCatalogState'] {
  const recoverableIdentityFields = [
    ['ownerUserKey', row.ownerUserKey],
    ['sourceContextKey', row.sourceContextKey],
    ['targetSpeakerId', row.targetSpeakerId],
    ['targetSpeakerName', row.targetSpeakerName],
    ['evidenceMessageIds', row.evidenceMessageIds],
    ['evidenceSpeakerIds', row.evidenceSpeakerIds],
    ['memoryKey', row.memoryKey],
  ] as const;
  if (
    Number(row.archived) !== 0
    || row.attributionStatus !== ''
    || row.visibility !== ''
    || recoverableIdentityFields.some(([, value]) => !isBlankLegacyIdentity(value))
  ) {
    throw new Error(
      `${type} ${row.id} does not match the approved permanent-purge classification.`,
    );
  }
  return assertCanonicalPurgeScope(row, type, catalog);
}

function payloadContent(row: LegacyMemoryRecord, type: LegacyRecordType): string {
  if (type === 'fact') return nonEmptyString(row.content, `memory_fact ${row.id}.content`);
  const title = nonEmptyString(row.title, `memory_episode ${row.id}.title`);
  const summary = nonEmptyString(row.summary, `memory_episode ${row.id}.summary`);
  return `${title}\n${summary}`;
}

function buildActiveRecord(
  row: LegacyMemoryRecord,
  type: LegacyRecordType,
): ActiveMigrationRecord {
  const subjectKey = nonEmptyString(row.ownerUserKey, `${type} ${row.id}.ownerUserKey`);
  const contextKey = nonEmptyString(
    row.sourceContextKey,
    `${type} ${row.id}.sourceContextKey`,
  );
  const targetSpeakerId = nonEmptyString(
    row.targetSpeakerId,
    `${type} ${row.id}.targetSpeakerId`,
  );
  const messages = parseStringArray(
    row.evidenceMessageIds,
    `${type} ${row.id}.evidenceMessageIds`,
  );
  if (new Set(messages).size !== messages.length) {
    throw new Error(`${type} ${row.id} contains duplicate evidence message IDs.`);
  }
  const speakers = parseStringArray(
    row.evidenceSpeakerIds,
    `${type} ${row.id}.evidenceSpeakerIds`,
  );
  if (speakers.length !== 1 || speakers[0] !== targetSpeakerId) {
    throw new Error(`${type} ${row.id} has ambiguous evidence speaker attribution.`);
  }
  const streamId = nonEmptyString(row.memoryKey, `${type} ${row.id}.memoryKey`);
  const revision = finiteNumber(row.version, `${type} ${row.id}.version`);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error(`${type} ${row.id}.version must be a positive integer.`);
  }
  const idempotencyKey = `cutover:v2:${type}:${row.id}:${revision}`;
  const eventId = `event:${sha256(idempotencyKey)}`;
  const payloadId = `payload:${sha256(`${eventId}\0assertion`)}`;
  const content = payloadContent(row, type);
  const contentHash = sha256(content);
  const createdAt = finiteNumber(row.firstSeenAt, `${type} ${row.id}.firstSeenAt`);
  const updatedAt = finiteNumber(row.lastSeenAt, `${type} ${row.id}.lastSeenAt`);
  const evidenceOccurredAt = type === 'episode' && row.periodStart != null
    ? finiteNumber(row.periodStart, `episode ${row.id}.periodStart`)
    : createdAt;
  const audiencePolicy = 'subjectPrivate' as const;
  const audienceContextKeys = [contextKey];
  const evidenceCaptureAudienceSubjectKeys = [subjectKey];
  const audienceDecisionReason = row.scopeType === 'dm_only'
    ? 'legacy-direct-subject-private' as const
    : 'legacy-capture-audience-unavailable' as const;
  const retrievalText = nonEmptyString(
    row.retrievalText,
    `${type} ${row.id}.retrievalText`,
  );
  return {
    legacyType: type,
    legacyId: row.id,
    legacyRefDigest: refDigest(`memory_${type}`, row.id),
    streamId,
    eventId,
    payloadId,
    revision,
    assertionType: type === 'fact' ? 'userAssertion' : 'episode',
    subjectKey,
    sourceContextKey: contextKey,
    audiencePolicy,
    audienceContextKeys,
    audienceSnapshots: {
      [contextKey]: evidenceCaptureAudienceSubjectKeys,
    },
    evidenceCaptureAudienceSubjectKeys,
    audienceDecisionReason,
    sensitivity: sensitivity(row.sensitivity, `${type} ${row.id}`),
    content,
    retrievalText,
    contentHash,
    importance: finiteNumber(row.importance, `${type} ${row.id}.importance`),
    confidence: finiteNumber(row.confidence, `${type} ${row.id}.confidence`),
    validFrom: nullableFiniteNumber(row.validFrom, `${type} ${row.id}.validFrom`),
    validUntil: nullableFiniteNumber(row.validUntil, `${type} ${row.id}.validUntil`),
    expiresAt: nullableFiniteNumber(row.expiresAt, `${type} ${row.id}.expiresAt`),
    createdAt,
    updatedAt,
    evidence: messages.map((messageId, index) => ({
      evidenceId: `evidence:${sha256(`${eventId}\0${messageId}\0${index}`)}`,
      messageId,
      speakerId: targetSpeakerId,
      occurredAt: evidenceOccurredAt,
    })),
  };
}

function assertUniqueActiveRecords(active: ActiveMigrationRecord[]): void {
  for (const [label, values] of [
    ['streamId', active.map((record) => record.streamId)],
    ['eventId', active.map((record) => record.eventId)],
    ['payloadId', active.map((record) => record.payloadId)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      throw new Error(`Active migration ${label} values are not unique.`);
    }
  }
}

function classifyRecords(database: DatabaseSync): {
  active: ActiveMigrationRecord[];
  purged: PurgedRecord[];
} {
  const active: ActiveMigrationRecord[] = [];
  const purged: PurgedRecord[] = [];
  const scopeCatalog = legacyScopeIdentityCatalog(database);
  for (const [type, table] of [
    ['fact', 'memory_fact'],
    ['episode', 'memory_episode'],
  ] as const) {
    const rows = readRows<LegacyMemoryRecord>(database, table);
    for (const row of rows) {
      if (isVerifiedActiveRecord(row)) {
        active.push(buildActiveRecord(row, type));
        continue;
      }
      const scopeCatalogState = assertPurgeShape(row, type, scopeCatalog);
      purged.push({
        legacyType: type,
        legacyId: row.id,
        legacyRefDigest: refDigest(table, row.id),
        subjectKey: null,
        contextKey: null,
        scopeCatalogState,
        createdAt: finiteNumber(row.lastSeenAt, `${table} ${row.id}.lastSeenAt`),
      });
    }
  }
  assertUniqueActiveRecords(active);
  if (active.length !== EXPECTED_MEMORY_V2_BASELINE.active) {
    throw new Error(
      `Verified active classification drifted: expected ${EXPECTED_MEMORY_V2_BASELINE.active}, received ${active.length}`,
    );
  }
  if (purged.length !== EXPECTED_MEMORY_V2_BASELINE.purged) {
    throw new Error(
      `Permanent purge classification drifted: expected ${EXPECTED_MEMORY_V2_BASELINE.purged}, received ${purged.length}`,
    );
  }
  return { active, purged };
}

function countWhere(
  database: DatabaseSync,
  table: string,
  where: string,
  values: SQLInputValue[] = [],
): number {
  const row = database.prepare(
    `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE ${where}`,
  ).get(...values) as { count: number };
  return Number(row.count);
}

function assertClassificationGroups(database: DatabaseSync): void {
  const groups: Array<[string, string, SQLInputValue[], number]> = [
    [
      'memory_fact',
      `attributionStatus = 'verified' AND scopeType = 'source_context_only' AND visibility = 'source_context_only'`,
      [],
      EXPECTED_MEMORY_V2_BASELINE.activeFactsSourceContext,
    ],
    [
      'memory_fact',
      `attributionStatus = 'verified' AND scopeType = 'dm_only' AND visibility = 'private_only'`,
      [],
      EXPECTED_MEMORY_V2_BASELINE.activeFactsPrivate,
    ],
    [
      'memory_episode',
      `attributionStatus = 'verified' AND scopeType = 'source_context_only' AND visibility = 'source_context_only'`,
      [],
      EXPECTED_MEMORY_V2_BASELINE.activeEpisodesSourceContext,
    ],
    [
      'memory_fact',
      `attributionStatus = '' AND scopeType = 'user_group' AND visibility = ''`,
      [],
      EXPECTED_MEMORY_V2_BASELINE.purgedFactsUserGroup,
    ],
    [
      'memory_fact',
      `attributionStatus = '' AND scopeType = 'user' AND visibility = ''`,
      [],
      EXPECTED_MEMORY_V2_BASELINE.purgedFactsUser,
    ],
    [
      'memory_episode',
      `attributionStatus = '' AND scopeType = 'user_group' AND visibility = ''`,
      [],
      EXPECTED_MEMORY_V2_BASELINE.purgedEpisodesUserGroup,
    ],
    [
      'memory_episode',
      `attributionStatus = '' AND scopeType = 'user' AND visibility = ''`,
      [],
      EXPECTED_MEMORY_V2_BASELINE.purgedEpisodesUser,
    ],
  ];
  for (const [table, where, values, expected] of groups) {
    const actual = countWhere(database, table, where, values);
    if (actual !== expected) {
      throw new Error(
        `${table} classification group drifted (${where}): expected ${expected}, received ${actual}`,
      );
    }
  }
}

function assertUniqueLegacyIdentityCatalog(database: DatabaseSync): void {
  const userRows = readRows<{
    userKey: string;
    platform: string;
    userId: string;
  }>(database, 'memory_user');
  const platformUserIds = userRows.map((row) => stableJson([
    row.platform,
    row.userId,
  ]));
  if (new Set(platformUserIds).size !== platformUserIds.length) {
    throw new Error(
      'Legacy principals contain duplicate immutable platform user identities.',
    );
  }
  if (new Set(userRows.map((row) => row.userKey)).size !== userRows.length) {
    throw new Error('Legacy principals contain duplicate canonical user keys.');
  }
  const contexts = readRows<{ contextKey: string }>(
    database,
    'memory_context',
  ).map((row) => row.contextKey);
  if (new Set(contexts).size !== contexts.length) {
    throw new Error('Legacy contexts contain duplicate canonical context keys.');
  }
}

function assertActiveReferences(
  database: DatabaseSync,
  active: ActiveMigrationRecord[],
): void {
  const userRows = readRows<{
    userKey: string;
    platform: string;
    userId: string;
  }>(database, 'memory_user');
  const platformUserIds = userRows.map((row) => stableJson([
    row.platform,
    row.userId,
  ]));
  if (new Set(platformUserIds).size !== platformUserIds.length) {
    throw new Error(
      'Legacy principals contain duplicate immutable platform user identities.',
    );
  }
  const users = new Map(
    userRows.map((row) => [row.userKey, row.userId]),
  );
  if (users.size !== userRows.length) {
    throw new Error('Legacy principals contain duplicate canonical user keys.');
  }
  const contextRows = readRows<{ contextKey: string }>(database, 'memory_context');
  const contexts = new Set(contextRows.map((row) => row.contextKey));
  if (contexts.size !== contextRows.length) {
    throw new Error('Legacy contexts contain duplicate canonical context keys.');
  }
  for (const record of active) {
    const subjectUserId = users.get(record.subjectKey);
    if (subjectUserId == null) {
      throw new Error(`${record.legacyType} ${record.legacyId} references a missing principal.`);
    }
    if (
      record.evidence.some((evidence) => evidence.speakerId !== subjectUserId)
    ) {
      throw new Error(
        `${record.legacyType} ${record.legacyId} evidence speaker does not match `
        + `the immutable principal userId.`,
      );
    }
    if (!contexts.has(record.sourceContextKey)) {
      throw new Error(`${record.legacyType} ${record.legacyId} references a missing context.`);
    }
  }

  const verifiedProvenance = new Set<string>();
  const provenanceRows = readRows<{
    memoryType: string;
    memoryId: number;
    ownerUserKey: string;
    contextKey: string;
    evidenceMessageIds: string;
    evidenceSpeakerIds: string;
    attributionStatus: string;
  }>(database, 'memory_provenance');
  for (const row of provenanceRows) {
    if (row.attributionStatus !== 'verified') continue;
    const messageIds = parseStringArray(
      row.evidenceMessageIds,
      `memory_provenance ${row.memoryType}:${row.memoryId}.evidenceMessageIds`,
    );
    const speakerIds = parseStringArray(
      row.evidenceSpeakerIds,
      `memory_provenance ${row.memoryType}:${row.memoryId}.evidenceSpeakerIds`,
    );
    verifiedProvenance.add(stableJson([
      row.memoryType,
      finiteNumber(row.memoryId, 'memory_provenance.memoryId'),
      nonEmptyString(row.ownerUserKey, 'memory_provenance.ownerUserKey'),
      nonEmptyString(row.contextKey, 'memory_provenance.contextKey'),
      messageIds,
      speakerIds,
    ]));
  }
  for (const record of active) {
    const provenanceKey = stableJson([
      record.legacyType,
      record.legacyId,
      record.subjectKey,
      record.sourceContextKey,
      record.evidence.map((evidence) => evidence.messageId),
      [...new Set(record.evidence.map((evidence) => evidence.speakerId))],
    ]);
    if (!verifiedProvenance.has(provenanceKey)) {
      throw new Error(
        `${record.legacyType} ${record.legacyId} has no exact verified provenance.`,
      );
    }
  }
}

interface LegacyChatMessageNode {
  id: string;
  conversationId: string;
  parentId: string | null;
  createdAt: number | null;
}

interface LegacyExtractCursor {
  ownerUserKey: string;
  contextKey: string;
  conversationId: string;
  lastExtractedMessageId: string | null;
  lastExtractedAt: number | null;
  firstSeenAt: number;
  updatedAt: number;
}

function legacyMessageGraph(
  database: DatabaseSync,
): ReadonlyMap<string, LegacyChatMessageNode> {
  if (!tableExists(database, 'chatluna_message')) {
    throw new Error('Missing chatluna_message table; dead-letter anchors cannot be verified.');
  }
  const graph = new Map<string, LegacyChatMessageNode>();
  const rows = database.prepare(
    `SELECT "id", "conversationId", "parentId", "createdAt"
       FROM "chatluna_message"
      ORDER BY "id"`,
  ).all() as Array<{
    id: unknown;
    conversationId: unknown;
    parentId: unknown;
    createdAt: unknown;
  }>;
  for (const row of rows) {
    const id = nonEmptyString(row.id, 'chatluna_message.id');
    if (graph.has(id)) {
      throw new Error(`chatluna_message contains duplicate message ID digest ${sha256(id)}.`);
    }
    graph.set(id, {
      id,
      conversationId: nonEmptyString(
        row.conversationId,
        `chatluna_message ${sha256(id)}.conversationId`,
      ),
      parentId: row.parentId == null || row.parentId === ''
        ? null
        : nonEmptyString(row.parentId, `chatluna_message ${sha256(id)}.parentId`),
      createdAt: row.createdAt == null
        ? null
        : finiteNumber(
          row.createdAt,
          `chatluna_message ${sha256(id)}.createdAt`,
        ),
    });
  }
  return graph;
}

function messageAncestorPath(
  graph: ReadonlyMap<string, LegacyChatMessageNode>,
  anchorId: string,
  conversationId: string,
  label: string,
): readonly string[] {
  const path: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = anchorId;
  let descendantCreatedAt: number | null = null;
  while (currentId) {
    if (visited.has(currentId)) {
      throw new Error(`${label} belongs to a cyclic message ancestor chain.`);
    }
    visited.add(currentId);
    const message = graph.get(currentId);
    if (!message) {
      throw new Error(`${label} belongs to an incomplete message ancestor chain.`);
    }
    if (message.conversationId !== conversationId) {
      throw new Error(`${label} crosses its declared conversation ancestor chain.`);
    }
    if (
      message.createdAt != null
      && descendantCreatedAt != null
      && message.createdAt > descendantCreatedAt
    ) {
      throw new Error(`${label} has a non-monotonic message ancestor chain.`);
    }
    path.push(currentId);
    if (message.createdAt != null) descendantCreatedAt = message.createdAt;
    currentId = message.parentId;
  }
  return path;
}

function deadLetterMissingAnchorSummary(
  deadLetters: readonly DeadLetterRecord[],
): {
  records: number;
  anchors: number;
  digest: string;
} {
  const missing = deadLetters.filter((record) => !record.anchorPresent);
  const anchorDigests = [...new Set(
    missing.map((record) => sha256(record.latestAnchorMessageId)),
  )].sort();
  return {
    records: missing.length,
    anchors: anchorDigests.length,
    digest: sha256(stableJson(anchorDigests)),
  };
}

function assertReviewedMissingAnchorBaseline(
  summary: ReturnType<typeof deadLetterMissingAnchorSummary>,
): void {
  if (
    summary.records !== REVIEWED_PRODUCTION_MISSING_ANCHORS.records
    || summary.anchors !== REVIEWED_PRODUCTION_MISSING_ANCHORS.anchors
    || summary.digest !== REVIEWED_PRODUCTION_MISSING_ANCHORS.digest
  ) {
    throw new Error(
      'Dead-letter missing anchors do not match the frozen reviewed production baseline: '
      + `expected ${REVIEWED_PRODUCTION_MISSING_ANCHORS.records} records, `
      + `${REVIEWED_PRODUCTION_MISSING_ANCHORS.anchors} anchors, `
      + `${REVIEWED_PRODUCTION_MISSING_ANCHORS.digest}; received `
      + `${summary.records} records, ${summary.anchors} anchors, ${summary.digest}.`,
    );
  }
}

function parseDeadLetters(database: DatabaseSync): DeadLetterRecord[] {
  const messages = legacyMessageGraph(database);
  const rows = readRows<{
    id: number;
    jobKey: string;
    jobType: string;
    status: string;
    payload: string;
    createdAt: number;
    updatedAt: number;
  }>(database, 'memory_job');
  const result: DeadLetterRecord[] = [];
  for (const row of rows) {
    if (row.jobType !== 'extract' || row.status !== 'dead_letter') {
      throw new Error(`memory_job ${row.id} is not an approved extract dead-letter.`);
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      throw new Error(`memory_job ${row.id} payload is not valid JSON.`);
    }
    const subjectKey = nonEmptyString(payload.ownerUserKey, `memory_job ${row.id}.ownerUserKey`);
    const contextKey = nonEmptyString(payload.contextKey, `memory_job ${row.id}.contextKey`);
    const conversationId = nonEmptyString(
      payload.conversationId,
      `memory_job ${row.id}.conversationId`,
    );
    const latestAnchorMessageId = nonEmptyString(
      payload.latestAnchorMessageId,
      `memory_job ${row.id}.latestAnchorMessageId`,
    );
    if (!payload.address || typeof payload.address !== 'object') {
      throw new Error(`memory_job ${row.id}.address must be an object.`);
    }
    const address = payload.address as Record<string, unknown>;
    const addressSubjectKey = nonEmptyString(
      address.userKey,
      `memory_job ${row.id}.address.userKey`,
    );
    const addressContextKey = nonEmptyString(
      address.contextKey,
      `memory_job ${row.id}.address.contextKey`,
    );
    const addressConversationId = nonEmptyString(
      address.conversationId,
      `memory_job ${row.id}.address.conversationId`,
    );
    if (
      addressSubjectKey !== subjectKey
      || addressContextKey !== contextKey
      || addressConversationId !== conversationId
    ) {
      throw new Error(
        `memory_job ${row.id} address does not match its extraction lane payload.`,
      );
    }
    const anchorObservedAt = finiteNumber(
      address.observedAt,
      `memory_job ${row.id}.address.observedAt`,
    );
    const rangeStartAfterMessageId = payload.rangeStartAfterMessageId == null
      || payload.rangeStartAfterMessageId === ''
      ? null
      : nonEmptyString(
        payload.rangeStartAfterMessageId,
        `memory_job ${row.id}.rangeStartAfterMessageId`,
      );
    const legacyLaneKey = `extract:${contextKey}:${subjectKey}`;
    if (row.jobKey !== legacyLaneKey) {
      throw new Error(`memory_job ${row.id} jobKey does not match its extraction lane.`);
    }
    const laneKey = createMemoryExtractLaneKey(subjectKey, contextKey);
    const windowIdentity = stableJson({
      contextKey,
      conversationId,
      rangeStartAfterMessageId,
      latestAnchorMessageId,
    });
    const anchor = messages.get(latestAnchorMessageId);
    const anchorPresent = anchor != null;
    if (anchor) {
      if (anchor.conversationId !== conversationId) {
        throw new Error(
          `memory_job ${row.id} anchor belongs to a different conversation.`,
        );
      }
      if (anchor.createdAt == null) {
        throw new Error(`memory_job ${row.id} anchor has no occurrence time.`);
      }
      if (anchor.createdAt > anchorObservedAt) {
        throw new Error(
          `memory_job ${row.id} anchor observation predates the stored message.`,
        );
      }
      const anchorPath = messageAncestorPath(
        messages,
        latestAnchorMessageId,
        conversationId,
        `memory_job ${row.id} anchor`,
      );
      if (
        rangeStartAfterMessageId
        && messages.has(rangeStartAfterMessageId)
        && !anchorPath.includes(rangeStartAfterMessageId)
      ) {
        throw new Error(
          `memory_job ${row.id} range start is not an ancestor of its latest anchor.`,
        );
      }
    }
    result.push({
      legacyId: row.id,
      legacyRefDigest: refDigest('memory_job', row.id),
      workKey: `discarded:${sha256(`${row.jobKey}\0${row.id}`)}`,
      laneKey,
      subjectKey,
      contextKey,
      conversationId,
      rangeStartAfterMessageId,
      latestAnchorMessageId,
      anchorObservedAt,
      anchorMessageAt: anchor?.createdAt ?? null,
      anchorPresent,
      logicalWindowDigest: sha256(windowIdentity),
      createdAt: finiteNumber(row.createdAt, `memory_job ${row.id}.createdAt`),
      updatedAt: finiteNumber(row.updatedAt, `memory_job ${row.id}.updatedAt`),
    });
  }
  const logicalWindows = new Set(result.map((row) => row.logicalWindowDigest));
  const lanes = new Set(result.map((row) => row.laneKey));
  if (result.length !== EXPECTED_MEMORY_V2_BASELINE.jobs) {
    throw new Error(`Dead-letter count drifted: expected 43, received ${result.length}`);
  }
  if (logicalWindows.size !== EXPECTED_MEMORY_V2_BASELINE.deadLetterWindows) {
    throw new Error(
      `Dead-letter window count drifted: expected ${EXPECTED_MEMORY_V2_BASELINE.deadLetterWindows}, received ${logicalWindows.size}`,
    );
  }
  if (lanes.size !== EXPECTED_MEMORY_V2_BASELINE.deadLetterLanes) {
    throw new Error(
      `Dead-letter lane count drifted: expected ${EXPECTED_MEMORY_V2_BASELINE.deadLetterLanes}, received ${lanes.size}`,
    );
  }
  const conversationsByLane = new Map<string, Set<string>>();
  for (const record of result) {
    const conversations = conversationsByLane.get(record.laneKey) ?? new Set<string>();
    conversations.add(record.conversationId);
    conversationsByLane.set(record.laneKey, conversations);
  }
  for (const [lane, conversations] of conversationsByLane) {
    if (conversations.size !== 1) {
      throw new Error(
        `Dead-letter lane spans multiple conversations: ${sha256(lane)}`,
      );
    }
  }
  const cursorByLane = new Map<MemoryExtractLaneKey, LegacyExtractCursor>();
  for (const cursor of readRows<LegacyExtractCursor>(
    database,
    'memory_extract_cursor',
  )) {
    const laneKey = createMemoryExtractLaneKey(
      cursor.ownerUserKey,
      cursor.contextKey,
    );
    if (cursorByLane.has(laneKey)) {
      throw new Error(
        `Legacy extraction cursor lane is duplicated: ${sha256(laneKey)}.`,
      );
    }
    cursorByLane.set(laneKey, cursor);
    if (
      (cursor.lastExtractedMessageId == null) !== (cursor.lastExtractedAt == null)
    ) {
      throw new Error(
        `Legacy extraction cursor is partially populated: ${sha256(laneKey)}.`,
      );
    }
    if (cursor.lastExtractedMessageId != null) {
      nonEmptyString(
        cursor.lastExtractedMessageId,
        `memory_extract_cursor ${sha256(laneKey)}.lastExtractedMessageId`,
      );
      finiteNumber(
        cursor.lastExtractedAt,
        `memory_extract_cursor ${sha256(laneKey)}.lastExtractedAt`,
      );
      const storedCursor = messages.get(cursor.lastExtractedMessageId);
      if (storedCursor) {
        if (storedCursor.conversationId !== cursor.conversationId) {
          throw new Error(
            `Legacy extraction cursor belongs to a different conversation: ${sha256(laneKey)}.`,
          );
        }
        messageAncestorPath(
          messages,
          cursor.lastExtractedMessageId,
          cursor.conversationId,
          `Legacy extraction cursor ${sha256(laneKey)}`,
        );
      }
    }
  }
  for (const record of result) {
    const cursor = cursorByLane.get(record.laneKey);
    if (!cursor) {
      throw new Error(
        `Dead-letter lane has no stable legacy cursor: ${sha256(record.laneKey)}`,
      );
    }
    const anchor = messages.get(record.latestAnchorMessageId);
    const cursorMessage = cursor.lastExtractedMessageId
      ? messages.get(cursor.lastExtractedMessageId)
      : null;
    if (
      anchor
      && cursorMessage
      && cursor.conversationId === record.conversationId
    ) {
      const anchorPath = new Set(messageAncestorPath(
        messages,
        anchor.id,
        record.conversationId,
        `memory_job ${record.legacyId} anchor`,
      ));
      const cursorPath = new Set(messageAncestorPath(
        messages,
        cursorMessage.id,
        cursor.conversationId,
        `Legacy extraction cursor ${sha256(record.laneKey)}`,
      ));
      if (
        !anchorPath.has(cursorMessage.id)
        && !cursorPath.has(anchor.id)
      ) {
        throw new Error(
          `Dead-letter anchor forks from its legacy cursor: ${sha256(record.laneKey)}.`,
        );
      }
    }
  }
  const presentByLane = new Map<string, DeadLetterRecord[]>();
  for (const record of result) {
    if (!record.anchorPresent) continue;
    const laneRecords = presentByLane.get(record.laneKey) ?? [];
    laneRecords.push(record);
    presentByLane.set(record.laneKey, laneRecords);
  }
  for (const [laneKey, records] of presentByLane) {
    const paths = new Map(records.map((record) => [
      record.latestAnchorMessageId,
      new Set(messageAncestorPath(
        messages,
        record.latestAnchorMessageId,
        record.conversationId,
        `Dead-letter lane ${sha256(laneKey)}`,
      )),
    ]));
    for (let left = 0; left < records.length; left += 1) {
      for (let right = left + 1; right < records.length; right += 1) {
        const leftAnchor = records[left]!.latestAnchorMessageId;
        const rightAnchor = records[right]!.latestAnchorMessageId;
        if (
          !paths.get(leftAnchor)?.has(rightAnchor)
          && !paths.get(rightAnchor)?.has(leftAnchor)
        ) {
          throw new Error(
            `Dead-letter lane anchors form a fork: ${sha256(laneKey)}.`,
          );
        }
      }
    }
  }
  return result;
}

function parseProfiles(
  database: DatabaseSync,
  active: ActiveMigrationRecord[],
): LegacyProfileDecision[] {
  return readRows<{
    id: number;
    ownerUserKey: string;
    sourceContextKey: string;
    lastSeenAt: number;
  }>(database, 'memory_profile').map((row) => {
    const subjectKey = nonEmptyString(
      row.ownerUserKey,
      `memory_profile ${row.id}.ownerUserKey`,
    );
    const contextKey = nonEmptyString(
      row.sourceContextKey,
      `memory_profile ${row.id}.sourceContextKey`,
    );
    if (!active.some((record) => (
      record.subjectKey === subjectKey
      && record.sourceContextKey === contextKey
    ))) {
      throw new Error(
        `memory_profile ${row.id} has no active assertion source for derived-on-read reconstruction.`,
      );
    }
    return {
      legacyRefDigest: refDigest('memory_profile', row.id),
      subjectKey,
      contextKey,
      derivationMode: 'active-heads-on-read' as const,
      createdAt: finiteNumber(row.lastSeenAt, `memory_profile ${row.id}.lastSeenAt`),
    };
  });
}

function parseLegacyRemnants(database: DatabaseSync): LegacyRemnantDecision[] {
  const candidates = readRows<{ id: number; createdAt: number }>(
    database,
    'memory_candidate_v3',
  ).map((row) => ({
    legacyType: 'candidateV3' as const,
    legacyRefDigest: refDigest('memory_candidate_v3', row.id),
    createdAt: finiteNumber(row.createdAt, `memory_candidate_v3 ${row.id}.createdAt`),
  }));
  const jobs = readRows<{ id: number; updatedAt: number }>(
    database,
    'memory_job_v3',
  ).map((row) => ({
      legacyType: 'jobV3' as const,
      legacyRefDigest: refDigest('memory_job_v3', row.id),
      createdAt: finiteNumber(row.updatedAt, `memory_job_v3 ${row.id}.updatedAt`),
    }));
  return [...candidates, ...jobs];
}

function assertExactBaseline(database: DatabaseSync): void {
  const expectedCounts: Array<[string, number]> = [
    ['memory_user', EXPECTED_MEMORY_V2_BASELINE.users],
    ['memory_context', EXPECTED_MEMORY_V2_BASELINE.contexts],
    ['memory_extract_cursor', EXPECTED_MEMORY_V2_BASELINE.cursors],
    ['memory_candidate', EXPECTED_MEMORY_V2_BASELINE.candidates],
    ['memory_fact', EXPECTED_MEMORY_V2_BASELINE.facts],
    ['memory_episode', EXPECTED_MEMORY_V2_BASELINE.episodes],
    ['memory_profile', EXPECTED_MEMORY_V2_BASELINE.profiles],
    ['memory_session', EXPECTED_MEMORY_V2_BASELINE.sessions],
    ['memory_source', EXPECTED_MEMORY_V2_BASELINE.sources],
    ['memory_provenance', EXPECTED_MEMORY_V2_BASELINE.provenance],
    ['memory_job', EXPECTED_MEMORY_V2_BASELINE.jobs],
    ['memory_audit_event', EXPECTED_MEMORY_V2_BASELINE.auditEvents],
    ['memory_tombstone', EXPECTED_MEMORY_V2_BASELINE.tombstones],
    ['memory_fact_v3', EXPECTED_MEMORY_V2_BASELINE.legacyFactV3],
    ['memory_episode_v3', EXPECTED_MEMORY_V2_BASELINE.legacyEpisodeV3],
    ['memory_candidate_v3', EXPECTED_MEMORY_V2_BASELINE.legacyCandidateV3],
    ['memory_profile_v4', EXPECTED_MEMORY_V2_BASELINE.legacyProfileV4],
    ['memory_job_v3', EXPECTED_MEMORY_V2_BASELINE.legacyJobV3],
  ];
  for (const [table, expected] of expectedCounts) {
    assertExactCount(database, table, expected);
  }
  if (!tableExists(database, 'chatluna_docstore')) {
    throw new Error('Missing chatluna_docstore table; long-memory namespace cannot be verified.');
  }
  const docstoreCount = tableCount(database, 'chatluna_docstore');
  if (docstoreCount !== EXPECTED_MEMORY_V2_BASELINE.chatlunaDocstore) {
    throw new Error(
      `ChatLuna docstore must be empty before cutover, received ${docstoreCount} rows.`,
    );
  }
  assertClassificationGroups(database);
  assertOperationalEventCleanupContract(database);
}

function hashTable(database: DatabaseSync, hash: ReturnType<typeof createHash>, table: string): void {
  const schema = database.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table) as { sql?: string } | undefined;
  if (!schema?.sql) throw new Error(`Cannot hash missing table: ${table}`);
  const columns = (database.prepare(
    `PRAGMA table_info(${quoteIdentifier(table)})`,
  ).all() as Array<{ cid: number; name: string }>).sort((left, right) => left.cid - right.cid);
  hash.update(`table\0${table}\0${schema.sql}\0`);
  hash.update(stableJson(columns.map((column) => column.name)));
  const orderColumn = columns.some((column) => column.name === 'id') ? '"id"' : 'rowid';
  const rows = database.prepare(
    `SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${orderColumn} ASC`,
  ).iterate() as Iterable<Record<string, unknown>>;
  for (const row of rows) {
    hash.update('\0row\0');
    hash.update(stableJson(columns.map((column) => row[column.name])));
  }
}

function databaseSourceDigest(
  database: DatabaseSync,
  relevantSchema: readonly RelevantLegacySchemaObject[],
): string {
  const hash = createHash('sha256');
  hash.update(`${CUTOVER_OPERATION}\0database-source-v3`);
  hash.update('\0relevant-schema\0');
  hash.update(stableJson(relevantSchema));
  for (const table of [
    ...LEGACY_MEMORY_TABLE_NAMES,
    'chatluna_docstore',
    'admin_operational_event',
    'admin_operational_event_occurrence',
  ]) {
    hashTable(database, hash, table);
  }
  const messageGraph = queryRowsDigest(
    database,
    'chatluna-message-graph',
    `SELECT "id", "conversationId", "parentId", "createdAt"
       FROM "chatluna_message"
      ORDER BY "id"`,
  );
  hash.update('\0chatluna-message-graph\0');
  hash.update(stableJson(messageGraph));
  return hash.digest('hex');
}

function canonicalModel(connectionId: string, modelId: string): string {
  return `qqbot-${connectionId}/${modelId}`;
}

const removedChatlunaEmbeddingBindingSchema = z.discriminatedUnion('mode', [
  z.object({
    workload: z.literal('chatluna.defaultEmbedding'),
    mode: z.literal('dedicated'),
    connectionId: z.string().min(1),
    modelId: z.string().min(1),
  }).strict(),
  z.object({
    workload: z.literal('chatluna.defaultEmbedding'),
    mode: z.literal('disabled'),
  }).strict(),
]);

function buildModelConfigTransition(
  raw: string,
  transitionAtMs: number,
): ModelConfigTransition {
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('Canonical model config is not valid JSON.');
  }
  if (!Array.isArray(document.bindings)) {
    throw new Error('Model config bindings must be an array.');
  }
  const sourceBindings = document.bindings as unknown[];
  const removedBindings = sourceBindings.filter(
    (binding) => (
      binding !== null
      && typeof binding === 'object'
      && !Array.isArray(binding)
      && (binding as Record<string, unknown>).workload === 'chatluna.defaultEmbedding'
    ),
  );
  if (removedBindings.length !== 1) {
    throw new Error(
      'Memory V2 one-shot transition requires exactly one '
      + 'chatluna.defaultEmbedding source binding.',
    );
  }
  const removedBindingValidation = removedChatlunaEmbeddingBindingSchema.safeParse(
    removedBindings[0],
  );
  if (!removedBindingValidation.success) {
    throw new Error(
      `chatluna.defaultEmbedding source binding failed validation: ${
        removedBindingValidation.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')
      }`,
    );
  }
  const sourceWithoutRemovedBinding = {
    ...document,
    bindings: sourceBindings.filter((binding) => binding !== removedBindings[0]),
  };
  const sourceValidation = modelConfigDocumentSchema.safeParse(sourceWithoutRemovedBinding);
  if (!sourceValidation.success) {
    throw new Error(
      `Canonical model config without the removed workload failed validation: ${
        sourceValidation.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')
      }`,
    );
  }
  document = sourceValidation.data;
  const schemaVersion = finiteNumber(document.schemaVersion, 'model config schemaVersion');
  const savedRevision = finiteNumber(document.savedRevision, 'model config savedRevision');
  const appliedRevision = finiteNumber(document.appliedRevision, 'model config appliedRevision');
  if (schemaVersion !== 2) {
    throw new Error('Memory V2 requires canonical model config schemaVersion 2.');
  }
  if (
    !Number.isInteger(savedRevision)
    || savedRevision < 1
    || savedRevision !== appliedRevision
  ) {
    throw new Error('Model config savedRevision and appliedRevision must be equal positive integers.');
  }
  if (!Array.isArray(document.bindings)) throw new Error('Model config bindings must be an array.');
  if (!Array.isArray(document.models)) throw new Error('Model config models must be an array.');
  if (!Array.isArray(document.connections)) throw new Error('Model config connections must be an array.');
  const bindings = document.bindings as Array<Record<string, unknown>>;
  const models = document.models as Array<Record<string, unknown>>;
  const connections = document.connections as Array<Record<string, unknown>>;
  const byWorkload = new Map(bindings.map((binding) => [
    nonEmptyString(binding.workload, 'model binding workload'),
    binding,
  ]));
  if (byWorkload.size !== bindings.length) {
    throw new Error('Model config contains duplicate workload bindings.');
  }
  const extraction = byWorkload.get('memory.extract');
  if (extraction?.mode !== 'dedicated') {
    throw new Error('Memory V2 one-shot transition requires dedicated memory.extract source binding.');
  }
  const extractionConnectionId = nonEmptyString(
    extraction.connectionId,
    'memory.extract connectionId',
  );
  const extractionModelId = nonEmptyString(extraction.modelId, 'memory.extract modelId');
  const extractionModel = models.find(
    (model) => model.connectionId === extractionConnectionId && model.id === extractionModelId,
  );
  if (!extractionModel) {
    throw new Error('memory.extract source binding references a missing model profile.');
  }
  const main = byWorkload.get('main.chat');
  if (main?.mode !== 'dedicated') throw new Error('main.chat must use a dedicated model.');
  const mainConnectionId = nonEmptyString(main.connectionId, 'main.chat connectionId');
  const mainModelId = nonEmptyString(main.modelId, 'main.chat modelId');
  if (!connections.some((connection) => connection.id === mainConnectionId)) {
    throw new Error(`main.chat references missing connection ${mainConnectionId}.`);
  }
  const mainModel = models.find(
    (model) => model.connectionId === mainConnectionId && model.id === mainModelId,
  );
  if (!mainModel) throw new Error('main.chat references a missing model profile.');
  const mainCapabilities = mainModel.capabilities as Record<string, unknown> | undefined;
  if (
    mainCapabilities?.chat !== true
    || mainCapabilities?.structuredOutput !== true
    || typeof mainModel.structuredOutputProtocol !== 'string'
    || mainModel.structuredOutputProtocol.length === 0
  ) {
    throw new Error('main.chat must provide chat and structured-output capabilities.');
  }

  const embedding = byWorkload.get('memory.embedding');
  if (embedding?.mode !== 'dedicated') {
    throw new Error('memory.embedding must use a dedicated model before cutover.');
  }
  const embeddingConnectionId = nonEmptyString(
    embedding.connectionId,
    'memory.embedding connectionId',
  );
  const embeddingModelId = nonEmptyString(embedding.modelId, 'memory.embedding modelId');
  if (
    embeddingConnectionId !== EXPECTED_EMBEDDING_CONNECTION_ID
    || embeddingModelId !== EXPECTED_EMBEDDING_MODEL_ID
  ) {
    throw new Error(
      `memory.embedding must resolve to ${EXPECTED_EMBEDDING_CONNECTION_ID}/${EXPECTED_EMBEDDING_MODEL_ID}.`,
    );
  }
  if (!connections.some((connection) => connection.id === embeddingConnectionId)) {
    throw new Error('memory.embedding references a missing connection.');
  }
  const embeddingModel = models.find(
    (model) => model.connectionId === embeddingConnectionId && model.id === embeddingModelId,
  );
  if (!embeddingModel) throw new Error('memory.embedding references a missing model profile.');
  const embeddingCapabilities = embeddingModel.capabilities as Record<string, unknown> | undefined;
  if (embeddingCapabilities?.embedding !== true) {
    throw new Error('memory.embedding model profile lacks embedding capability.');
  }
  const transportModel = nonEmptyString(
    embeddingModel.transportModel,
    'memory.embedding transportModel',
  );
  if (transportModel !== EXPECTED_EMBEDDING_TRANSPORT_MODEL) {
    throw new Error(
      `memory.embedding transport model must be ${EXPECTED_EMBEDDING_TRANSPORT_MODEL}.`,
    );
  }
  const stagedSavedRevision = savedRevision + 1;
  const nextDocument = {
    ...document,
    savedRevision: stagedSavedRevision,
    appliedRevision,
    updatedAt: new Date(transitionAtMs).toISOString(),
    bindings: bindings.map((binding) => (
      binding.workload === 'memory.extract'
        ? { workload: 'memory.extract', mode: 'inheritMain' }
        : binding
    )),
  };
  const stagedValidation = modelConfigDocumentSchema.safeParse(nextDocument);
  if (!stagedValidation.success) {
    throw new Error(
      `Staged model config failed validation: ${stagedValidation.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const nextRaw = `${JSON.stringify(stagedValidation.data, null, 2)}\n`;
  return {
    originalRaw: raw,
    nextRaw,
    summary: {
      schemaVersion,
      removedWorkloads: ['chatluna.defaultEmbedding'],
      sourceSavedRevision: savedRevision,
      sourceAppliedRevision: appliedRevision,
      stagedSavedRevision,
      stagedAppliedRevision: appliedRevision,
      startupAppliedRevision: stagedSavedRevision,
      extractionSourceMode: 'dedicated',
      extractionMode: 'inheritMain',
      extractionCanonicalModel: canonicalModel(mainConnectionId, mainModelId),
      embedding: {
        connectionId: embeddingConnectionId,
        modelId: embeddingModelId,
        transportModel,
        canonicalModel: canonicalModel(embeddingConnectionId, embeddingModelId),
        modelRevision: stagedSavedRevision,
      },
    },
  };
}

function assertQqbotRuntimeConfig(raw: string): void {
  if (/extension[-_]long[-_]memory|chatluna[-_]long[-_]memory/iu.test(raw)) {
    throw new Error('QQBot runtime still loads the ChatLuna long-memory extension.');
  }
}

async function readContextPresetDirectory(path: string, label: string): Promise<Array<{
  id: string;
  path: string;
  raw: string;
  parsed: Record<string, unknown>;
  mode: number;
}>> {
  await assertRealDirectory(path, label);
  const entries = await readdir(path, { withFileTypes: true });
  const definitions: Array<{
    id: string;
    path: string;
    raw: string;
    parsed: Record<string, unknown>;
    mode: number;
  }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.endsWith('.yml')) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`${label} preset must be a regular file: ${entry.name}`);
    }
    const filePath = join(path, entry.name);
    const [raw, info] = await Promise.all([
      readFile(filePath, 'utf8'),
      stat(filePath),
    ]);
    let parsed: unknown;
    try {
      parsed = YAML.parse(raw);
    } catch {
      throw new Error(`${label} preset is invalid YAML: ${entry.name}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} preset must be an object: ${entry.name}`);
    }
    const id = nonEmptyString(
      (parsed as Record<string, unknown>).id,
      `${label} ${entry.name}.id`,
    );
    if (entry.name !== `${id}.yml`) {
      throw new Error(`${label} preset filename must be ${id}.yml.`);
    }
    definitions.push({
      id,
      path: filePath,
      raw,
      parsed: parsed as Record<string, unknown>,
      mode: info.mode & 0o777,
    });
  }
  const ids = definitions.map((definition) => definition.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} contains duplicate context preset IDs.`);
  }
  return definitions;
}

function contextPresetDirectoryDigest(
  definitions: Array<{ id: string; raw: string }>,
): string {
  const hash = createHash('sha256');
  hash.update(`${CUTOVER_OPERATION}\0context-presets-v1`);
  for (const definition of definitions) {
    hash.update(`\0${definition.id}\0`);
    hash.update(definition.raw);
  }
  return hash.digest('hex');
}

async function planContextPresetMigration(
  bundledPath: string,
  runtimePath: string,
): Promise<{
  migrations: ContextPresetMigration[];
  bundledDigest: string;
  runtimeDigest: string;
}> {
  const [bundled, runtime] = await Promise.all([
    readContextPresetDirectory(bundledPath, 'Bundled context preset directory'),
    readContextPresetDirectory(runtimePath, 'Runtime context preset directory'),
  ]);
  for (const definition of bundled) {
    const parsed = ContextPresetDefinitionV1Schema.parse(definition.parsed);
    if (parsed.blocks.some((block) => block.type === 'longMemory')) {
      throw new Error(
        `Bundled context preset ${definition.id} still contains a longMemory block.`,
      );
    }
  }
  const migrations: ContextPresetMigration[] = [];
  for (const definition of runtime) {
    if (!Array.isArray(definition.parsed.blocks)) {
      throw new Error(`Runtime context preset ${definition.id}.blocks must be an array.`);
    }
    const blocks = definition.parsed.blocks as Array<Record<string, unknown>>;
    const longMemory = blocks.filter((block) => block?.type === 'longMemory');
    if (longMemory.length > 1) {
      throw new Error(
        `Runtime context preset ${definition.id} contains multiple longMemory blocks.`,
      );
    }
    const nextDefinition = {
      ...definition.parsed,
      blocks: blocks.filter((block) => block?.type !== 'longMemory'),
    };
    ContextPresetDefinitionV1Schema.parse(nextDefinition);
    if (longMemory.length === 0) continue;
    const removedBlockId = nonEmptyString(
      longMemory[0]?.id,
      `Runtime context preset ${definition.id} longMemory block ID`,
    );
    const nextRaw = YAML.stringify(nextDefinition, { lineWidth: 0 });
    migrations.push({
      id: definition.id,
      path: definition.path,
      originalRaw: definition.raw,
      nextRaw,
      originalRevision: sha256(definition.raw),
      nextRevision: sha256(nextRaw),
      removedBlockId,
      mode: definition.mode,
    });
  }
  return {
    migrations,
    bundledDigest: contextPresetDirectoryDigest(bundled),
    runtimeDigest: contextPresetDirectoryDigest(runtime),
  };
}

function cutoverEpoch(
  active: ActiveMigrationRecord[],
  purged: PurgedRecord[],
  deadLetters: DeadLetterRecord[],
  profiles: LegacyProfileDecision[],
  remnants: LegacyRemnantDecision[],
): number {
  return Math.max(
    0,
    ...active.map((record) => record.updatedAt),
    ...purged.map((record) => record.createdAt),
    ...deadLetters.map((record) => record.updatedAt),
    ...profiles.map((record) => record.createdAt),
    ...remnants.map((record) => record.createdAt),
  );
}

function reportPlanHash(
  input: Omit<MemoryV2PreflightReport, 'planHash' | 'command' | 'dryRun' | 'applied'>,
): string {
  return sha256(stableJson(input));
}

export async function buildMemoryV2MigrationPlan(
  options: MemoryV2CutoverOptions,
): Promise<MemoryV2MigrationPlan> {
  if (
    !options.modelConfig
    || !options.koishiConfig
    || !options.bundledContextDir
    || !options.runtimeContextDir
  ) {
    throw new Error('Model, QQBot runtime, and context preset paths are required.');
  }
  await Promise.all([
    assertRegularFile(options.database, 'SQLite database'),
    assertRegularFile(options.modelConfig, 'Canonical model config'),
    assertRegularFile(options.koishiConfig, 'QQBot runtime config'),
    assertRealDirectory(options.bundledContextDir, 'Bundled context preset directory'),
    assertRealDirectory(options.runtimeContextDir, 'Runtime context preset directory'),
  ]);
  const [modelRaw, koishiRaw, contextPresets] = await Promise.all([
    readFile(options.modelConfig, 'utf8'),
    readFile(options.koishiConfig, 'utf8'),
    planContextPresetMigration(options.bundledContextDir, options.runtimeContextDir),
  ]);
  assertQqbotRuntimeConfig(koishiRaw);

  const database = new DatabaseSync(options.database, { readOnly: true });
  try {
    const tables = assertKnownMemoryTables(database);
    if (tables.v2.length > 0) {
      throw new Error('Memory Ledger V2 tables already exist; one-shot cutover cannot run again.');
    }
    const missingLegacy = LEGACY_MEMORY_TABLE_NAMES.filter(
      (table) => !tables.legacy.includes(table),
    );
    if (missingLegacy.length > 0) {
      throw new Error(`Legacy memory schema is incomplete: ${missingLegacy.join(', ')}`);
    }
    const relevantSchema = relevantLegacySchema(database);
    assertExactBaseline(database);
    assertUniqueLegacyIdentityCatalog(database);
    const classified = classifyRecords(database);
    assertActiveReferences(database, classified.active);
    const deadLetters = parseDeadLetters(database);
    const missingAnchors = deadLetterMissingAnchorSummary(deadLetters);
    assertReviewedMissingAnchorBaseline(missingAnchors);
    const profiles = parseProfiles(database, classified.active);
    const legacyRemnants = parseLegacyRemnants(database);
    const profileSubjectContexts = new Set(
      profiles.map((profile) => stableJson([
        profile.subjectKey,
        profile.contextKey,
      ])),
    );
    const profileSourceActiveHeads = classified.active.filter((record) => (
      profileSubjectContexts.has(stableJson([
        record.subjectKey,
        record.sourceContextKey,
      ]))
    )).length;
    const adminOperationalPreservation = adminOperationalPreservationSnapshot(database);
    const epoch = cutoverEpoch(
      classified.active,
      classified.purged,
      deadLetters,
      profiles,
      legacyRemnants,
    );
    const modelConfigTransition = buildModelConfigTransition(modelRaw, epoch);
    const modelConfig = modelConfigTransition.summary;
    const unresolvedPurgeScopes = classified.purged
      .filter((record) => record.scopeCatalogState !== 'resolved')
      .map((record) => stableJson([
        record.scopeCatalogState,
        record.legacyRefDigest,
      ]))
      .sort();
    const purgeScopeCatalog = {
      resolved: classified.purged.filter(
        (record) => record.scopeCatalogState === 'resolved',
      ).length,
      missingUser: classified.purged.filter(
        (record) => record.scopeCatalogState === 'missingUser',
      ).length,
      missingContext: classified.purged.filter(
        (record) => record.scopeCatalogState === 'missingContext',
      ).length,
      missingUserAndContext: classified.purged.filter(
        (record) => record.scopeCatalogState === 'missingUserAndContext',
      ).length,
      unresolvedDigest: sha256(stableJson(unresolvedPurgeScopes)),
    };
    const sourceDigest = sha256(stableJson({
      database: databaseSourceDigest(database, relevantSchema),
      modelConfig: sha256(modelRaw),
      koishiConfig: sha256(koishiRaw),
      bundledContextPresets: contextPresets.bundledDigest,
      runtimeContextPresets: contextPresets.runtimeDigest,
    }));
    const withoutHash = {
      schemaVersion: 1 as const,
      operation: CUTOVER_OPERATION as typeof CUTOVER_OPERATION,
      ledgerSchemaVersion: MEMORY_LEDGER_SCHEMA_VERSION,
      sourceDigest,
      cutoverEpochMs: epoch,
      database: {
        legacyTables: [...tables.legacy].sort(),
        v2Tables: [...tables.v2].sort(),
        legacyRemnants: {
          memoryFactV3: EXPECTED_MEMORY_V2_BASELINE.legacyFactV3,
          memoryEpisodeV3: EXPECTED_MEMORY_V2_BASELINE.legacyEpisodeV3,
          memoryCandidateV3: EXPECTED_MEMORY_V2_BASELINE.legacyCandidateV3,
          memoryProfileV4: EXPECTED_MEMORY_V2_BASELINE.legacyProfileV4,
          memoryJobV3: EXPECTED_MEMORY_V2_BASELINE.legacyJobV3,
        },
        chatlunaDocstoreRows: EXPECTED_MEMORY_V2_BASELINE.chatlunaDocstore,
        operationalEvents: {
          memoryLinkedRemoved: EXPECTED_MEMORY_V2_BASELINE.operationalMemoryEvents,
          memoryCandidateLinkedRemoved:
            EXPECTED_MEMORY_V2_BASELINE.operationalMemoryCandidateRefs,
          nonMemoryPolicy: 'preserve-all' as const,
          removedColumns: ['memoryJobId', 'memoryCandidateId'] as [
            'memoryJobId',
            'memoryCandidateId',
          ],
          ...adminOperationalPreservation,
        },
      },
      baseline: EXPECTED_MEMORY_V2_BASELINE,
      decisions: {
        active: classified.active.length,
        purged: classified.purged.length,
        profilesDerivedOnRead: profiles.length,
        profileDerivationMode: 'active-heads-on-read' as const,
        profileSubjectContexts: profileSubjectContexts.size,
        profileSourceActiveHeads,
        legacyCandidatesPurged: legacyRemnants.filter(
          (record) => record.legacyType === 'candidateV3',
        ).length,
        legacyJobRemnantsPurged: legacyRemnants.filter(
          (record) => record.legacyType === 'jobV3',
        ).length,
        deadLettersDiscarded: deadLetters.length,
        deadLetterLogicalWindows: new Set(
          deadLetters.map((record) => record.logicalWindowDigest),
        ).size,
        deadLetterLanes: new Set(deadLetters.map((record) => record.laneKey)).size,
        deadLetterMissingAnchorRecords: missingAnchors.records,
        deadLetterMissingAnchors: missingAnchors.anchors,
        deadLetterMissingAnchorDigest: missingAnchors.digest,
        purgeScopeCatalog,
        backfillQueued: classified.active.length,
        activeRefDigests: classified.active.map((record) => record.legacyRefDigest).sort(),
        audienceDecisions: classified.active
          .map((record) => ({
            legacyRefDigest: record.legacyRefDigest,
            audiencePolicy: record.audiencePolicy,
            reasonCode: record.audienceDecisionReason,
          }))
          .sort((left, right) => left.legacyRefDigest.localeCompare(right.legacyRefDigest)),
        purgedRefDigests: classified.purged.map((record) => record.legacyRefDigest).sort(),
        profileRefDigests: profiles.map((record) => record.legacyRefDigest).sort(),
        deadLetterRefDigests: deadLetters.map((record) => record.legacyRefDigest).sort(),
      },
      modelConfig,
      qqbotRuntime: {
        koishiConfigDigest: sha256(koishiRaw),
        chatlunaLongMemoryPluginLoaded: false as const,
      },
      contextPresets: {
        bundledDigest: contextPresets.bundledDigest,
        runtimeDigest: contextPresets.runtimeDigest,
        migrated: contextPresets.migrations.map((migration) => ({
          id: migration.id,
          originalRevision: migration.originalRevision,
          nextRevision: migration.nextRevision,
          removedBlockId: migration.removedBlockId,
        })),
      },
    };
    const report: MemoryV2PreflightReport = {
      ...withoutHash,
      command: 'preflight',
      dryRun: true,
      applied: false,
      planHash: reportPlanHash(withoutHash),
    };
    return {
      report,
      active: classified.active,
      purged: classified.purged,
      deadLetters,
      profiles,
      legacyRemnants,
      embedding: modelConfig.embedding,
      contextPresets: contextPresets.migrations,
      modelConfigTransition,
      adminOperationalPreservation,
    };
  } finally {
    database.close();
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function checkpointStoppedDatabaseForPublish(path: string): Promise<void> {
  await assertRegularFile(path, 'Stopped SQLite database');
  const database = new DatabaseSync(path);
  try {
    const result = database.prepare(
      'PRAGMA wal_checkpoint(TRUNCATE)',
    ).get() as {
      busy?: unknown;
      log?: unknown;
      checkpointed?: unknown;
    } | undefined;
    const busy = Number(result?.busy);
    const log = Number(result?.log);
    const checkpointed = Number(result?.checkpointed);
    if (
      busy !== 0
      || !Number.isInteger(log)
      || !Number.isInteger(checkpointed)
      || log !== checkpointed
    ) {
      throw new Error(
        `Stopped SQLite WAL checkpoint did not complete: `
        + `busy=${String(result?.busy)}, log=${String(result?.log)}, `
        + `checkpointed=${String(result?.checkpointed)}.`,
      );
    }
  } finally {
    database.close();
  }
  await fsyncFile(path);
  await fsyncDirectory(dirname(path));
}

async function copyFileDurable(
  source: string,
  target: string,
  mode: number,
): Promise<void> {
  await copyFile(source, target, constants.COPYFILE_EXCL);
  await chmod(target, mode);
  await fsyncFile(target);
  await fsyncDirectory(dirname(target));
}

async function writeNewDurableFile(path: string, content: string): Promise<void> {
  await assertSafeOutputPath(path, 'Output file');
  try {
    await lstat(path);
    throw new Error(`Output file must not already exist: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
    await fsyncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function writePreflightReport(
  path: string,
  report: MemoryV2PreflightReport,
): Promise<void> {
  await writeNewDurableFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

function assertServiceStopped(systemctl: string): void {
  for (const unit of ['qqbot.target', 'qqbot-koishi.service']) {
    const result = spawnSync(
      systemctl,
      ['show', unit, '--property=ActiveState', '--value'],
      { encoding: 'utf8' },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Unable to inspect ${unit} through ${systemctl}.`);
    }
    const state = result.stdout.trim();
    if (state !== 'inactive' && state !== 'failed') {
      throw new Error(`${unit} must be inactive before memory cutover (state=${state}).`);
    }
  }
}

function insertPrincipals(database: DatabaseSync): void {
  const rows = readRows<{
    userKey: string;
    platform: string;
    userId: string;
    qqNick: string | null;
    avatarUrl: string | null;
    readEnabled: number;
    writeEnabled: number;
    firstSeenAt: number;
    lastSeenAt: number;
  }>(database, 'memory_user');
  const insert = database.prepare(
    `INSERT INTO "memory_v2_principal"
      ("userKey", "platform", "userId", "displayName", "avatarUrl",
       "readEnabled", "writeEnabled", "firstSeenAt", "lastSeenAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.userKey,
      row.platform,
      row.userId,
      row.qqNick,
      row.avatarUrl,
      Number(row.readEnabled),
      Number(row.writeEnabled),
      Number(row.firstSeenAt),
      Number(row.lastSeenAt),
    );
  }
}

function insertContexts(database: DatabaseSync): void {
  const rows = readRows<{
    contextKey: string;
    platform: string;
    botSelfId: string;
    channelType: string;
    groupId: string | null;
    channelId: string | null;
    rawContextId: string | null;
    firstSeenAt: number;
    lastSeenAt: number;
  }>(database, 'memory_context');
  const insert = database.prepare(
    `INSERT INTO "memory_v2_context"
      ("contextKey", "platform", "botSelfId", "channelType", "groupId",
       "channelId", "rawContextId", "firstSeenAt", "lastSeenAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    if (row.channelType !== 'direct' && row.channelType !== 'group') {
      throw new Error(`Legacy context ${row.contextKey} has invalid channelType.`);
    }
    insert.run(
      row.contextKey,
      row.platform,
      row.botSelfId,
      row.channelType,
      row.groupId,
      row.channelId,
      row.rawContextId,
      Number(row.firstSeenAt),
      Number(row.lastSeenAt),
    );
  }
}

function insertActiveRecords(
  database: DatabaseSync,
  active: ActiveMigrationRecord[],
): void {
  const insertEvent = database.prepare(
    `INSERT INTO "memory_v2_event"
      ("eventId", "streamId", "revision", "eventType", "assertionType",
       "subjectType", "subjectKey", "actorKey", "sourceContextKey",
       "audiencePolicy", "audienceContextKeys", "audienceSnapshots",
       "sensitivity", "payloadId", "causationId", "idempotencyKey", "createdAt")
     VALUES (?, ?, ?, 'asserted', ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  const insertPayload = database.prepare(
    `INSERT INTO "memory_v2_payload"
      ("payloadId", "eventId", "payloadKind", "content", "retrievalText",
       "contentHash", "createdAt")
     VALUES (?, ?, 'assertion', ?, ?, ?, ?)`,
  );
  const insertEvidence = database.prepare(
    `INSERT INTO "memory_v2_evidence"
      ("evidenceId", "eventId", "messageId", "speakerId", "contextKey",
       "threadId", "captureAudienceSubjectKeys", "replyToMessageId",
       "excerptPayloadId", "occurredAt")
     VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?)`,
  );
  const insertHead = database.prepare(
    `INSERT INTO "memory_v2_head"
      ("streamId", "eventId", "revision", "state", "assertionType",
       "subjectType", "subjectKey", "sourceContextKey", "audiencePolicy",
       "audienceContextKeys", "audienceSnapshots", "sensitivity",
       "payloadId", "contentHash", "importance", "confidence", "validFrom",
       "validUntil", "expiresAt", "deletionGeneration", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 'active', ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  );
  const insertAudit = database.prepare(
    `INSERT INTO "memory_v2_audit"
      ("auditId", "idempotencyKey", "subjectKey", "contextKey", "eventType",
       "streamId", "eventId", "workKey", "detailJson", "createdAt")
     VALUES (?, ?, ?, ?, 'migration-active', ?, ?, NULL, ?, ?)`,
  );
  for (const record of active) {
    const audienceContextKeys = stableJson(record.audienceContextKeys);
    const audienceSnapshots = stableJson(record.audienceSnapshots);
    const evidenceCaptureAudienceSubjectKeys = stableJson(
      record.evidenceCaptureAudienceSubjectKeys,
    );
    const eventIdempotency = `cutover:v2:${record.legacyType}:${record.legacyId}:${record.revision}`;
    insertEvent.run(
      record.eventId,
      record.streamId,
      record.revision,
      record.assertionType,
      record.subjectKey,
      ACTOR_KEY,
      record.sourceContextKey,
      record.audiencePolicy,
      audienceContextKeys,
      audienceSnapshots,
      record.sensitivity,
      record.payloadId,
      eventIdempotency,
      record.createdAt,
    );
    insertPayload.run(
      record.payloadId,
      record.eventId,
      record.content,
      record.retrievalText,
      record.contentHash,
      record.createdAt,
    );
    for (const evidence of record.evidence) {
      insertEvidence.run(
        evidence.evidenceId,
        record.eventId,
        evidence.messageId,
        evidence.speakerId,
        record.sourceContextKey,
        evidenceCaptureAudienceSubjectKeys,
        evidence.occurredAt,
      );
    }
    insertHead.run(
      record.streamId,
      record.eventId,
      record.revision,
      record.assertionType,
      record.subjectKey,
      record.sourceContextKey,
      record.audiencePolicy,
      audienceContextKeys,
      audienceSnapshots,
      record.sensitivity,
      record.payloadId,
      record.contentHash,
      record.importance,
      record.confidence,
      record.validFrom,
      record.validUntil,
      record.expiresAt,
      record.createdAt,
      record.updatedAt,
    );
    const auditIdentity = `migration-active:${record.legacyRefDigest}`;
    insertAudit.run(
      `audit:${sha256(auditIdentity)}`,
      auditIdentity,
      record.subjectKey,
      record.sourceContextKey,
      record.streamId,
      record.eventId,
      stableJson({
        reasonCode: 'verified-attribution',
        legacyType: record.legacyType,
        legacyRefDigest: record.legacyRefDigest,
      }),
      record.updatedAt,
    );
  }
}

function insertBackfillWork(
  database: DatabaseSync,
  active: ActiveMigrationRecord[],
  embedding: EmbeddingIdentity,
): void {
  const insert = database.prepare(
    `INSERT INTO "memory_v2_work"
      ("workKey", "workType", "status", "subjectKey", "contextKey", "streamId",
       "laneKey", "payload", "inputHash", "targetRevision",
       "deletionGeneration", "retryCount", "nextRunAt", "leaseToken",
       "leaseExpiresAt", "lastErrorCode", "lastErrorStage", "createdAt",
       "updatedAt", "completedAt")
     VALUES (?, 'backfill', 'pending', ?, ?, ?, NULL, ?, ?, ?, 0, 0, ?,
       NULL, NULL, NULL, NULL, ?, ?, NULL)`,
  );
  for (const record of active) {
    const payload = {
      streamId: record.streamId,
      eventId: record.eventId,
      revision: record.revision,
      canonicalModel: embedding.canonicalModel,
      modelRevision: embedding.modelRevision,
      contentHash: record.contentHash,
    };
    const canonicalPayload = stableJson(payload);
    const inputHash = sha256(canonicalPayload);
    const workKey = `backfill:${sha256(stableJson([
      record.streamId,
      record.eventId,
      record.revision,
      embedding.canonicalModel,
      embedding.modelRevision,
      record.contentHash,
    ]))}`;
    insert.run(
      workKey,
      record.subjectKey,
      record.sourceContextKey,
      record.streamId,
      canonicalPayload,
      inputHash,
      record.revision,
      record.updatedAt,
      record.updatedAt,
      record.updatedAt,
    );
  }
}

function insertFtsProjection(
  database: DatabaseSync,
  active: ActiveMigrationRecord[],
): void {
  const insert = database.prepare(
    `INSERT INTO "memory_v2_fts"
      ("streamId", "eventId", "revision", "contentHash", "canonicalText",
       "tokenCount", "termFrequencies", "createdAt", "updatedAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const record of active) {
    const projection = {
      ...createMemoryLexicalProjection({
        streamId: record.streamId,
        eventId: record.eventId,
        revision: record.revision,
        contentHash: record.contentHash,
        canonicalText: record.retrievalText,
      }, record.createdAt),
      updatedAt: record.updatedAt,
    };
    insert.run(
      projection.streamId,
      projection.eventId,
      projection.revision,
      projection.contentHash,
      projection.canonicalText,
      projection.tokenCount,
      projection.termFrequencies,
      projection.createdAt,
      projection.updatedAt,
    );
  }
}

function assertCanonicalLexicalProjections(
  database: DatabaseSync,
  expectedActive: number,
): void {
  const rows = database.prepare(
    `SELECT projection."streamId",
            projection."eventId",
            projection."revision",
            projection."contentHash",
            projection."canonicalText",
            projection."tokenCount",
            projection."termFrequencies",
            projection."createdAt",
            projection."updatedAt",
            head."eventId" AS "headEventId",
            head."revision" AS "headRevision",
            head."state" AS "headState",
            head."contentHash" AS "headContentHash",
            payload."content" AS "payloadContent",
            payload."retrievalText" AS "payloadRetrievalText",
            payload."contentHash" AS "payloadContentHash"
       FROM "memory_v2_fts" projection
       LEFT JOIN "memory_v2_head" head
         ON head."streamId" = projection."streamId"
       LEFT JOIN "memory_v2_payload" payload
         ON payload."payloadId" = head."payloadId"
        AND payload."payloadKind" = 'assertion'
      ORDER BY projection."streamId"`,
  ).all() as unknown as Array<MemoryLexicalProjectionRow & {
    headEventId: string | null;
    headRevision: number | null;
    headState: string | null;
    headContentHash: string | null;
    payloadContent: string | null;
    payloadRetrievalText: string | null;
    payloadContentHash: string | null;
  }>;
  const activeHeads = tableExists(database, MEMORY_LEDGER_TABLES.head)
    ? countWhere(database, MEMORY_LEDGER_TABLES.head, `"state" = 'active'`)
    : 0;
  if (rows.length !== expectedActive || activeHeads !== expectedActive) {
    throw new Error(
      `Lexical projection coverage expected ${expectedActive}, `
      + `received rows=${rows.length}, activeHeads=${activeHeads}.`,
    );
  }
  for (const row of rows) {
    const canonicalText = row.payloadRetrievalText ?? row.payloadContent;
    if (
      row.headState !== 'active'
      || !row.headEventId
      || row.headRevision == null
      || !row.headContentHash
      || !canonicalText
      || row.payloadContentHash !== row.headContentHash
      || !memoryLexicalProjectionMatches(row, {
        streamId: row.streamId,
        eventId: row.headEventId,
        revision: row.headRevision,
        contentHash: row.headContentHash,
        canonicalText,
      })
    ) {
      throw new Error(`Lexical projection identity is stale or invalid: ${row.streamId}.`);
    }
  }
}

function insertPurgeAudits(database: DatabaseSync, purged: PurgedRecord[]): void {
  const insert = database.prepare(
    `INSERT INTO "memory_v2_audit"
      ("auditId", "idempotencyKey", "subjectKey", "contextKey", "eventType",
       "streamId", "eventId", "workKey", "detailJson", "createdAt")
     VALUES (?, ?, ?, ?, 'migration-purged', NULL, NULL, NULL, ?, ?)`,
  );
  for (const record of purged) {
    const identity = `migration-purged:${record.legacyRefDigest}`;
    insert.run(
      `audit:${sha256(identity)}`,
      identity,
      record.subjectKey,
      record.contextKey,
      stableJson({
        reasonCode: 'unknown-attribution',
        legacyType: record.legacyType,
        legacyRefDigest: record.legacyRefDigest,
        scopeCatalogState: record.scopeCatalogState,
      }),
      record.createdAt,
    );
  }
}

function insertProfileAudits(
  database: DatabaseSync,
  profiles: LegacyProfileDecision[],
): void {
  const insert = database.prepare(
    `INSERT INTO "memory_v2_audit"
      ("auditId", "idempotencyKey", "subjectKey", "contextKey", "eventType",
       "streamId", "eventId", "workKey", "detailJson", "createdAt")
     VALUES (?, ?, ?, ?, 'migration-profile-derived-on-read', NULL, NULL, NULL, ?, ?)`,
  );
  for (const profile of profiles) {
    const identity = `migration-profile-derived-on-read:${profile.legacyRefDigest}`;
    insert.run(
      `audit:${sha256(identity)}`,
      identity,
      profile.subjectKey,
      profile.contextKey,
      stableJson({
        reasonCode: 'derived-profile-active-heads-on-read',
        derivationMode: profile.derivationMode,
        legacyRefDigest: profile.legacyRefDigest,
      }),
      profile.createdAt,
    );
  }
}

function insertLegacyRemnantAudits(
  database: DatabaseSync,
  remnants: LegacyRemnantDecision[],
): void {
  const insert = database.prepare(
    `INSERT INTO "memory_v2_audit"
      ("auditId", "idempotencyKey", "subjectKey", "contextKey", "eventType",
       "streamId", "eventId", "workKey", "detailJson", "createdAt")
     VALUES (?, ?, NULL, NULL, 'migration-remnant-purged', NULL, NULL, NULL, ?, ?)`,
  );
  for (const remnant of remnants) {
    const identity = `migration-remnant-purged:${remnant.legacyRefDigest}`;
    insert.run(
      `audit:${sha256(identity)}`,
      identity,
      stableJson({
        reasonCode: 'obsolete-v3-v4-remnant',
        legacyType: remnant.legacyType,
        legacyRefDigest: remnant.legacyRefDigest,
      }),
      remnant.createdAt,
    );
  }
}

function insertCursorsAndDeadLetterAudits(
  database: DatabaseSync,
  deadLetters: DeadLetterRecord[],
): void {
  const discardsByLane = new Map<string, DeadLetterRecord[]>();
  for (const record of deadLetters) {
    const records = discardsByLane.get(record.laneKey) ?? [];
    records.push(record);
    discardsByLane.set(record.laneKey, records);
  }
  const legacyCursors = readRows<LegacyExtractCursor>(
    database,
    'memory_extract_cursor',
  );
  const insertCursor = database.prepare(
    `INSERT INTO "memory_v2_cursor"
      ("laneKey", "subjectKey", "contextKey", "conversationId", "lastMessageId",
       "lastMessageAt", "lastWindowHash", "discardBeforeMessageId",
       "firstSeenAt", "updatedAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const cursor of legacyCursors) {
    const laneKey = createMemoryExtractLaneKey(
      cursor.ownerUserKey,
      cursor.contextKey,
    );
    const discardedWindows = discardsByLane.get(laneKey) ?? [];
    const trustedWatermarks = [
      cursor.lastExtractedAt,
      ...discardedWindows.map((record) => record.anchorMessageAt),
    ].filter((value): value is number => value != null);
    const barrierAt = trustedWatermarks.length > 0
      ? Math.max(...trustedWatermarks)
      : null;
    const barrierDigest = discardedWindows.length
      ? sha256(stableJson(
        discardedWindows
          .map((record) => record.logicalWindowDigest)
          .sort(),
      ))
      : null;
    insertCursor.run(
      laneKey,
      cursor.ownerUserKey,
      cursor.contextKey,
      cursor.conversationId,
      cursor.lastExtractedMessageId,
      barrierAt,
      barrierDigest,
      null,
      cursor.firstSeenAt,
      Math.max(
        cursor.updatedAt,
        ...discardedWindows.map((record) => record.updatedAt),
      ),
    );
  }

  const migratedCursors = database.prepare(
    `SELECT "laneKey", "conversationId", "lastMessageId", "lastMessageAt",
            "lastWindowHash", "discardBeforeMessageId"
       FROM "memory_v2_cursor"`,
  ).all() as Array<{
    laneKey: MemoryExtractLaneKey;
    conversationId: string;
    lastMessageId: string | null;
    lastMessageAt: number | null;
    lastWindowHash: string | null;
    discardBeforeMessageId: string | null;
  }>;
  if (migratedCursors.length !== legacyCursors.length) {
    throw new Error(
      `Extraction cursor coverage mismatch: expected ${legacyCursors.length}, `
      + `received ${migratedCursors.length}.`,
    );
  }
  const legacyByLane = new Map(legacyCursors.map((cursor) => [
    createMemoryExtractLaneKey(cursor.ownerUserKey, cursor.contextKey),
    cursor,
  ]));
  for (const migrated of migratedCursors) {
    const legacy = legacyByLane.get(migrated.laneKey);
    if (!legacy) {
      throw new Error(`Unexpected migrated extraction lane ${sha256(migrated.laneKey)}.`);
    }
    if (
      migrated.conversationId !== legacy.conversationId
      || migrated.lastMessageId !== legacy.lastExtractedMessageId
      || migrated.discardBeforeMessageId !== null
    ) {
      throw new Error(
        `Extraction cursor identity changed during cutover: ${sha256(migrated.laneKey)}.`,
      );
    }
    const discardedWindows = discardsByLane.get(migrated.laneKey) ?? [];
    const trustedWatermarks = [
      legacy.lastExtractedAt,
      ...discardedWindows.map((record) => record.anchorMessageAt),
    ].filter((value): value is number => value != null);
    const expectedBarrierAt = trustedWatermarks.length > 0
      ? Math.max(...trustedWatermarks)
      : null;
    if (
      migrated.lastMessageAt !== expectedBarrierAt
      || (
        discardedWindows.length > 0
        && migrated.lastWindowHash !== sha256(stableJson(
          discardedWindows
            .map((record) => record.logicalWindowDigest)
            .sort(),
        ))
      )
      || (discardedWindows.length === 0 && migrated.lastWindowHash !== null)
    ) {
      throw new Error(
        `Extraction time watermark is not monotonic for lane ${sha256(migrated.laneKey)}.`,
      );
    }
  }

  const insertAudit = database.prepare(
    `INSERT INTO "memory_v2_audit"
      ("auditId", "idempotencyKey", "subjectKey", "contextKey", "eventType",
       "streamId", "eventId", "workKey", "detailJson", "createdAt")
     VALUES (?, ?, ?, ?, 'operator-discarded', NULL, NULL, ?, ?, ?)`,
  );
  for (const record of deadLetters) {
    const identity = `operator-discarded:${record.legacyRefDigest}`;
    insertAudit.run(
      `audit:${sha256(identity)}`,
      identity,
      record.subjectKey,
      record.contextKey,
      record.workKey,
      stableJson({
        reasonCode: 'operator-discarded',
        legacyRefDigest: record.legacyRefDigest,
        logicalWindowDigest: record.logicalWindowDigest,
        laneDigest: sha256(record.laneKey),
        anchorState: record.anchorPresent ? 'present' : 'missing',
      }),
      record.updatedAt,
    );
  }
}

function insertMeta(
  database: DatabaseSync,
  plan: MemoryV2MigrationPlan,
): void {
  const rows: Array<[string, string]> = [
    ['schemaVersion', String(MEMORY_LEDGER_SCHEMA_VERSION)],
    ['cutoverSourceDigest', plan.report.sourceDigest],
    ['cutoverPlanHash', plan.report.planHash],
    ['cutoverEpochMs', String(plan.report.cutoverEpochMs)],
    ['activeCount', String(plan.active.length)],
    ['purgedCount', String(plan.purged.length)],
    ['deadLetterAccounted', String(plan.deadLetters.length)],
    ['profileDerivedOnRead', String(plan.profiles.length)],
    ['backfillRequired', String(plan.active.length)],
    ['modelConfigRevision', String(plan.embedding.modelRevision)],
  ];
  const insert = database.prepare(
    `INSERT INTO "memory_v2_meta" ("key", "value", "updatedAt") VALUES (?, ?, ?)`,
  );
  for (const [key, value] of rows) {
    insert.run(key, value, plan.report.cutoverEpochMs);
  }
}

function rebuildOperationalEventTable(
  database: DatabaseSync,
  sourceBoundaries: {
    eventId: number;
    occurrenceId: number;
  },
): void {
  const sourceTable = 'admin_operational_event';
  const stagedTable = '_memory_v2_admin_operational_event';
  if (tableExists(database, stagedTable)) {
    throw new Error(`Staging Admin operational event table already exists: ${stagedTable}`);
  }
  const preservedBefore = countWhere(
    database,
    sourceTable,
    `"memoryJobId" IS NULL AND "memoryCandidateId" IS NULL`,
  );
  database.exec(`
    CREATE TABLE "${stagedTable}" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "sourceKey" TEXT NOT NULL,
      "source" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "severity" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "resolution" TEXT,
      "title" TEXT NOT NULL,
      "summary" TEXT NOT NULL,
      "unit" TEXT,
      "invocationId" TEXT,
      "occurredAt" REAL NOT NULL,
      "acknowledgedAt" REAL,
      "resolvedAt" REAL,
      "updatedAt" REAL NOT NULL,
      "component" TEXT,
      "fingerprint" TEXT,
      "details" TEXT,
      "occurrenceCount" INTEGER,
      "lastOccurredAt" REAL,
      UNIQUE ("sourceKey")
    );
    INSERT INTO "${stagedTable}" (
      "id", "sourceKey", "source", "type", "severity", "status",
      "resolution", "title", "summary", "unit", "invocationId",
      "occurredAt", "acknowledgedAt", "resolvedAt", "updatedAt",
      "component", "fingerprint", "details", "occurrenceCount",
      "lastOccurredAt"
    )
    SELECT
      "id", "sourceKey", "source", "type", "severity", "status",
      "resolution", "title", "summary", "unit", "invocationId",
      "occurredAt", "acknowledgedAt", "resolvedAt", "updatedAt",
      "component", "fingerprint", "details", "occurrenceCount",
      "lastOccurredAt"
    FROM "${sourceTable}"
    WHERE "memoryJobId" IS NULL AND "memoryCandidateId" IS NULL;
    DROP TABLE "${sourceTable}";
    ALTER TABLE "${stagedTable}" RENAME TO "${sourceTable}";
    CREATE INDEX "index:admin_operational_event:status+lastOccurredAt"
      ON "${sourceTable}" ("status" ASC, "lastOccurredAt" ASC);
    CREATE INDEX "index:admin_operational_event:source+unit"
      ON "${sourceTable}" ("source" ASC, "unit" ASC);
    CREATE INDEX "index:admin_operational_event:source+fingerprint"
      ON "${sourceTable}" ("source" ASC, "fingerprint" ASC);
  `);
  setTableIdBoundary(database, sourceTable, sourceBoundaries.eventId);
  setTableIdBoundary(
    database,
    'admin_operational_event_occurrence',
    sourceBoundaries.occurrenceId,
  );
  const preservedAfter = tableCount(database, sourceTable);
  if (preservedAfter !== preservedBefore) {
    throw new Error(
      `Admin operational event rebuild lost non-memory rows: `
      + `${preservedBefore} before, ${preservedAfter} after.`,
    );
  }
}

function dropLegacyTables(database: DatabaseSync): void {
  for (const table of [...LEGACY_MEMORY_TABLE_NAMES].reverse()) {
    database.exec(`DROP TABLE ${quoteIdentifier(table)}`);
  }
  database.exec('DROP TABLE "chatluna_docstore"');
}

function assertProfilesDerivedOnRead(
  database: DatabaseSync,
  expected: number,
  expectedSourceActiveHeads: number,
): void {
  const derived = countWhere(
    database,
    MEMORY_LEDGER_TABLES.audit,
    `eventType = 'migration-profile-derived-on-read'`,
  );
  if (derived !== expected) {
    throw new Error(
      `Derived-on-read profile accounting expected ${expected}, received ${derived}.`,
    );
  }
  const withoutActiveSource = database.prepare(
    `SELECT COUNT(*) AS count
       FROM "memory_v2_audit" audit
      WHERE audit.eventType = 'migration-profile-derived-on-read'
        AND NOT EXISTS (
          SELECT 1
            FROM "memory_v2_head" head
           WHERE head.state = 'active'
             AND head.subjectKey = audit.subjectKey
             AND head.sourceContextKey = audit.contextKey
        )`,
  ).get() as { count: number };
  if (Number(withoutActiveSource.count) !== 0) {
    throw new Error(
      'A legacy derived profile has no active assertion source for on-read derivation.',
    );
  }
  const sourceActiveHeads = database.prepare(
    `SELECT COUNT(*) AS count
       FROM "memory_v2_head" head
      WHERE head.state = 'active'
        AND EXISTS (
          SELECT 1
            FROM "memory_v2_audit" audit
           WHERE audit.eventType = 'migration-profile-derived-on-read'
             AND audit.subjectKey = head.subjectKey
             AND audit.contextKey = head.sourceContextKey
        )`,
  ).get() as { count: number };
  if (Number(sourceActiveHeads.count) !== expectedSourceActiveHeads) {
    throw new Error(
      `Derived-on-read profile sources expected ${expectedSourceActiveHeads} active heads, `
      + `received ${Number(sourceActiveHeads.count)}.`,
    );
  }
}

function verifyStagedDatabase(
  database: DatabaseSync,
  plan: MemoryV2MigrationPlan,
): void {
  for (const table of MEMORY_LEDGER_TABLE_NAMES) {
    if (!tableExists(database, table)) throw new Error(`Staging database is missing ${table}.`);
  }
  for (const table of LEGACY_MEMORY_TABLE_NAMES) {
    if (tableExists(database, table)) throw new Error(`Staging database retained ${table}.`);
  }
  if (tableExists(database, 'chatluna_docstore')) {
    throw new Error('Staging database retained the ChatLuna long-memory namespace.');
  }
  const operationalColumns = new Set(
    (database.prepare(
      'PRAGMA table_info("admin_operational_event")',
    ).all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (
    operationalColumns.has('memoryJobId')
    || operationalColumns.has('memoryCandidateId')
  ) {
    throw new Error('Staging Admin operational events retained legacy memory columns.');
  }
  if (
    countWhere(database, 'admin_operational_event', `"source" = 'memory'`)
    !== 0
  ) {
    throw new Error('Staging Admin operational events retained legacy memory rows.');
  }
  const stagedAdminPreservation = adminOperationalPreservationSnapshot(database, {
    eventId: plan.adminOperationalPreservation.sourceEventBoundaryId,
    occurrenceId: plan.adminOperationalPreservation.sourceOccurrenceBoundaryId,
  });
  if (
    stableJson(stagedAdminPreservation)
    !== stableJson(plan.adminOperationalPreservation)
  ) {
    throw new Error(
      'Staging Admin operational events or occurrences changed during rebuild.',
    );
  }
  const expectedEvidence = plan.active.reduce(
    (count, record) => count + record.evidence.length,
    0,
  );
  const expectedAudits = plan.active.length
    + plan.purged.length
    + plan.deadLetters.length
    + plan.profiles.length
    + plan.legacyRemnants.length;
  const counts: Array<[string, number]> = [
    [MEMORY_LEDGER_TABLES.principal, EXPECTED_MEMORY_V2_BASELINE.users],
    [MEMORY_LEDGER_TABLES.context, EXPECTED_MEMORY_V2_BASELINE.contexts],
    [MEMORY_LEDGER_TABLES.event, plan.active.length],
    [MEMORY_LEDGER_TABLES.payload, plan.active.length],
    [MEMORY_LEDGER_TABLES.evidence, expectedEvidence],
    [MEMORY_LEDGER_TABLES.head, plan.active.length],
    [MEMORY_LEDGER_TABLES.embedding, 0],
    [MEMORY_LEDGER_TABLES.fts, plan.active.length],
    [MEMORY_LEDGER_TABLES.work, plan.active.length],
    [MEMORY_LEDGER_TABLES.cursor, EXPECTED_MEMORY_V2_BASELINE.cursors],
    [MEMORY_LEDGER_TABLES.suppression, 0],
    [MEMORY_LEDGER_TABLES.audit, expectedAudits],
  ];
  for (const [table, expected] of counts) {
    const actual = tableCount(database, table);
    if (actual !== expected) {
      throw new Error(`Staging ${table} expected ${expected} rows, received ${actual}.`);
    }
  }
  assertCanonicalLexicalProjections(database, plan.active.length);
  assertProfilesDerivedOnRead(
    database,
    plan.profiles.length,
    plan.report.decisions.profileSourceActiveHeads,
  );
  const invalidWork = countWhere(
    database,
    MEMORY_LEDGER_TABLES.work,
    `workType <> 'backfill' OR status <> 'pending'`,
  );
  if (invalidWork !== 0) throw new Error('Staging backfill work has invalid type or state.');
  const discardWatermarks = countWhere(
    database,
    MEMORY_LEDGER_TABLES.cursor,
    `"lastWindowHash" IS NOT NULL
      AND "lastMessageAt" IS NOT NULL`,
  );
  if (discardWatermarks !== EXPECTED_MEMORY_V2_BASELINE.deadLetterLanes) {
    throw new Error(
      `Staging discard watermark coverage expected `
      + `${EXPECTED_MEMORY_V2_BASELINE.deadLetterLanes}, received ${discardWatermarks}.`,
    );
  }
  const inactiveEmbedding = database.prepare(
    `SELECT COUNT(*) AS count
       FROM "memory_v2_embedding" embedding
       LEFT JOIN "memory_v2_head" head ON head.streamId = embedding.streamId
      WHERE head.state <> 'active' OR head.streamId IS NULL`,
  ).get() as { count: number };
  if (Number(inactiveEmbedding.count) !== 0) {
    throw new Error('Staging database contains embeddings for inactive assertions.');
  }
  const integrity = database.prepare('PRAGMA integrity_check').all() as Array<{
    integrity_check: string;
  }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error(`Staging SQLite integrity check failed: ${stableJson(integrity)}`);
  }
}

function migrateStagedDatabase(
  databasePath: string,
  plan: MemoryV2MigrationPlan,
  injectFault?: (point: FaultPoint) => void,
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA secure_delete = ON');
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of MEMORY_LEDGER_SQLITE_DDL) database.exec(statement);
      injectFault?.('after-schema');
      insertPrincipals(database);
      insertContexts(database);
      insertActiveRecords(database, plan.active);
      injectFault?.('after-active-records');
      insertFtsProjection(database, plan.active);
      insertBackfillWork(database, plan.active, plan.embedding);
      insertPurgeAudits(database, plan.purged);
      insertProfileAudits(database, plan.profiles);
      insertLegacyRemnantAudits(database, plan.legacyRemnants);
      insertCursorsAndDeadLetterAudits(database, plan.deadLetters);
      insertMeta(database, plan);
      rebuildOperationalEventTable(
        database,
        {
          eventId: plan.adminOperationalPreservation.sourceEventBoundaryId,
          occurrenceId:
            plan.adminOperationalPreservation.sourceOccurrenceBoundaryId,
        },
      );
      dropLegacyTables(database);
      injectFault?.('before-commit');
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // The original migration error remains authoritative.
      }
      throw error;
    }
    injectFault?.('after-commit');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    database.exec('VACUUM');
    verifyStagedDatabase(database, plan);
  } finally {
    database.close();
  }
}

async function copyDatabaseWithBackup(sourcePath: string, targetPath: string): Promise<void> {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, targetPath);
  } finally {
    source.close();
  }
  await chmod(targetPath, 0o600);
  await fsyncFile(targetPath);
  await fsyncDirectory(dirname(targetPath));
}

function initializeStagedMemoryV2Database(
  databasePath: string,
  initializedAt: number,
  injectFault?: (point: FaultPoint) => void,
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON');
    const tables = assertKnownMemoryTables(database);
    if (tables.legacy.length > 0 || tables.v2.length > 0) {
      throw new Error('Fresh Memory V2 initialization requires an empty memory schema.');
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of MEMORY_LEDGER_SQLITE_DDL) database.exec(statement);
      injectFault?.('after-schema');
      database.prepare(
        `INSERT INTO "memory_v2_meta" ("key", "value", "updatedAt")
         VALUES ('schemaVersion', ?, ?)`,
      ).run(String(MEMORY_LEDGER_SCHEMA_VERSION), initializedAt);
      database.prepare(
        `INSERT INTO "memory_v2_meta" ("key", "value", "updatedAt")
         VALUES ('initializationMode', 'fresh', ?)`,
      ).run(initializedAt);
      for (const table of MEMORY_LEDGER_TABLE_NAMES) {
        if (!tableExists(database, table)) {
          throw new Error(`Fresh Memory V2 initialization is missing ${table}.`);
        }
      }
      for (const table of MEMORY_LEDGER_TABLE_NAMES) {
        if (
          table !== MEMORY_LEDGER_TABLES.meta
          && tableCount(database, table) !== 0
        ) {
          throw new Error(`Fresh Memory V2 initialization populated ${table}.`);
        }
      }
      const integrity = database.prepare('PRAGMA integrity_check').all() as Array<{
        integrity_check: string;
      }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error(
          `Fresh Memory V2 integrity check failed: ${stableJson(integrity)}`,
        );
      }
      injectFault?.('before-commit');
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // The initialization failure remains authoritative.
      }
      throw error;
    }
    injectFault?.('after-commit');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    database.close();
  }
}

export async function initializeMemoryV2Ledger(
  options: MemoryV2CutoverOptions,
): Promise<InitializeResult> {
  if (options.command !== 'initialize' || !options.confirmServiceStopped) {
    throw new Error(
      'initialize requires command=initialize and --confirm-service-stopped.',
    );
  }
  assertServiceStopped(options.systemctl);
  await assertRealDirectory(dirname(options.database), 'SQLite parent directory');
  let databaseExisted = false;
  try {
    const info = await lstat(options.database);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`SQLite database must be a regular file: ${options.database}`);
    }
    databaseExisted = true;
    const status = await inspectMemoryV2Status(options.database);
    if (status.state !== 'empty') {
      throw new Error(
        `Fresh Memory V2 initialization requires empty state, received ${status.state}.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (databaseExisted) {
    await checkpointStoppedDatabaseForPublish(options.database);
  }

  const stagingDirectory = await mkdtemp(
    join(dirname(options.database), '.memory-v2-initialize-'),
  );
  await chmod(stagingDirectory, 0o700);
  await fsyncDirectory(stagingDirectory);
  await fsyncDirectory(dirname(stagingDirectory));
  const stagedDatabase = join(stagingDirectory, 'koishi.db');
  const originalBackup = join(stagingDirectory, 'original.db');
  let databasePublishStarted = false;
  try {
    if (databaseExisted) {
      await copyDatabaseWithBackup(options.database, originalBackup);
      await copyDatabaseWithBackup(options.database, stagedDatabase);
    } else {
      const empty = new DatabaseSync(stagedDatabase);
      empty.close();
      await chmod(stagedDatabase, 0o600);
      await fsyncFile(stagedDatabase);
      await fsyncDirectory(stagingDirectory);
    }
    const initializedAt = (options.now ?? (() => new Date()))().getTime();
    initializeStagedMemoryV2Database(
      stagedDatabase,
      initializedAt,
      options.injectFault,
    );
    await fsyncFile(stagedDatabase);
    options.injectFault?.('before-publish');
    if (!databaseExisted) {
      try {
        await lstat(options.database);
        throw new Error('SQLite database appeared during fresh initialization.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    databasePublishStarted = true;
    if (databaseExisted) {
      await checkpointStoppedDatabaseForPublish(options.database);
    }
    await rm(`${options.database}-wal`, { force: true });
    await rm(`${options.database}-shm`, { force: true });
    await fsyncDirectory(dirname(options.database));
    options.injectFault?.('after-database-sidecar-cleanup');
    await rename(stagedDatabase, options.database);
    options.injectFault?.('after-database-rename-before-fsync');
    await chmod(options.database, 0o600);
    await fsyncFile(options.database);
    await fsyncDirectory(dirname(options.database));
    options.injectFault?.('after-database-publish');
    const status = await inspectMemoryV2Status(options.database);
    if (status.state !== 'v2') {
      throw new Error('Fresh Memory V2 initialization did not publish V2 state.');
    }
    return {
      state: 'v2',
      schemaVersion: MEMORY_LEDGER_SCHEMA_VERSION,
      initialized: true,
      tables: MEMORY_LEDGER_TABLE_NAMES.length,
    };
  } catch (error) {
    let restoreFailure: unknown = null;
    if (databasePublishStarted) {
      try {
        if (databaseExisted) {
          await restoreDatabaseFromBackup(options.database, originalBackup);
        } else {
          await rm(options.database, { force: true });
          await rm(`${options.database}-wal`, { force: true });
          await rm(`${options.database}-shm`, { force: true });
          await fsyncDirectory(dirname(options.database));
        }
      } catch (restoreError) {
        restoreFailure = restoreError;
      }
    }
    if (restoreFailure) {
      throw new Error(
        `Fresh Memory V2 initialization failed and database restore failed: `
        + `${restoreFailure instanceof Error ? restoreFailure.message : String(restoreFailure)}. `
        + `Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function assertNewBackupDirectory(path: string): Promise<void> {
  await assertSafeOutputPath(path, 'Backup directory');
  try {
    await lstat(path);
    throw new Error(`Backup directory must not already exist: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  await fsyncDirectory(path);
  await fsyncDirectory(dirname(path));
}

async function assertPreflightReportMatches(
  path: string,
  report: MemoryV2PreflightReport,
): Promise<void> {
  await assertRegularFile(path, 'Memory V2 preflight report');
  const raw = await readFile(path, 'utf8');
  let expected: unknown;
  try {
    expected = JSON.parse(raw);
  } catch {
    throw new Error('Memory V2 preflight report is not valid JSON.');
  }
  if (stableJson(expected) !== stableJson(report)) {
    throw new Error('Memory V2 sources or plan changed after preflight.');
  }
}

async function restoreDatabaseFromBackup(
  database: string,
  backupPath: string,
): Promise<void> {
  const restoreTemp = join(
    dirname(database),
    `.memory-v2-restore-${process.pid}-${Date.now()}.db`,
  );
  try {
    await copyFileDurable(backupPath, restoreTemp, 0o600);
    await rm(`${database}-wal`, { force: true });
    await rm(`${database}-shm`, { force: true });
    await rename(restoreTemp, database);
    await chmod(database, 0o600);
    await fsyncFile(database);
    await fsyncDirectory(dirname(database));
  } catch (error) {
    await rm(restoreTemp, { force: true });
    throw error;
  }
}

async function atomicReplaceExistingFile(
  path: string,
  content: string,
  mode: number,
  onRenamed?: () => void,
): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.memory-v2-${process.pid}-${Date.now()}.tmp`,
  );
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, mode);
    await rename(temporary, path);
    onRenamed?.();
    await fsyncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function publishContextPresetMigrations(
  migrations: ContextPresetMigration[],
  published: ContextPresetMigration[],
  injectFault?: (point: FaultPoint) => void,
): Promise<void> {
  for (const migration of migrations) {
    await assertRegularFile(migration.path, `Runtime context preset ${migration.id}`);
    const current = await readFile(migration.path, 'utf8');
    if (current !== migration.originalRaw) {
      throw new Error(`Runtime context preset changed after preflight: ${migration.id}`);
    }
    await atomicReplaceExistingFile(
      migration.path,
      migration.nextRaw,
      migration.mode,
      () => {
        published.push(migration);
        injectFault?.('after-preset-rename-before-fsync');
      },
    );
  }
}

async function restoreContextPresetMigrations(
  migrations: ContextPresetMigration[],
): Promise<void> {
  const failures: string[] = [];
  for (const migration of [...migrations].reverse()) {
    try {
      await atomicReplaceExistingFile(
        migration.path,
        migration.originalRaw,
        migration.mode,
      );
    } catch (error) {
      failures.push(
        `${migration.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`Failed to restore runtime context presets: ${failures.join('; ')}`);
  }
}

async function publishModelConfigTransition(
  path: string,
  transition: ModelConfigTransition,
  onRenamed: () => void,
): Promise<void> {
  await assertRegularFile(path, 'Canonical model config');
  const current = await readFile(path, 'utf8');
  if (current !== transition.originalRaw) {
    throw new Error('Canonical model config changed after Memory V2 preflight.');
  }
  await atomicReplaceExistingFile(path, transition.nextRaw, 0o600, onRenamed);
}

export async function applyMemoryV2Cutover(
  options: MemoryV2CutoverOptions,
  plan?: MemoryV2MigrationPlan,
): Promise<MemoryV2ApplyReport> {
  if (options.command !== 'apply') {
    throw new Error('applyMemoryV2Cutover requires command=apply.');
  }
  if (!options.confirmServiceStopped) {
    throw new Error('apply requires --confirm-service-stopped.');
  }
  if (!options.preflightReport || !options.backupDir || !options.report) {
    throw new Error('apply requires preflight report, backup directory, and apply report.');
  }
  assertServiceStopped(options.systemctl);
  await checkpointStoppedDatabaseForPublish(options.database);
  const currentPlan = plan ?? await buildMemoryV2MigrationPlan(options);
  await assertPreflightReportMatches(options.preflightReport, currentPlan.report);
  await assertNewBackupDirectory(options.backupDir);
  const backupDatabase = join(options.backupDir, 'koishi.db');
  const backupModelConfig = join(options.backupDir, 'model-config.json');
  const backupPreflight = join(options.backupDir, 'preflight-report.json');
  await copyDatabaseWithBackup(options.database, backupDatabase);
  await copyFileDurable(options.modelConfig as string, backupModelConfig, 0o600);
  await copyFileDurable(options.preflightReport, backupPreflight, 0o600);
  const presetBackupDirectory = join(options.backupDir, 'runtime-context-presets');
  await mkdir(presetBackupDirectory, { recursive: true, mode: 0o700 });
  await chmod(presetBackupDirectory, 0o700);
  await fsyncDirectory(presetBackupDirectory);
  await fsyncDirectory(options.backupDir);
  for (const migration of currentPlan.contextPresets) {
    const backupPath = join(presetBackupDirectory, `${migration.id}.yml`);
    await writeNewDurableFile(backupPath, migration.originalRaw);
  }
  await fsyncDirectory(presetBackupDirectory);
  await fsyncDirectory(options.backupDir);

  const stagingDirectory = await mkdtemp(
    join(dirname(options.database), '.memory-v2-cutover-'),
  );
  await chmod(stagingDirectory, 0o700);
  await fsyncDirectory(stagingDirectory);
  await fsyncDirectory(dirname(stagingDirectory));
  const stagedDatabase = join(stagingDirectory, 'koishi.db');
  let published = false;
  let databasePublishStarted = false;
  let modelConfigPublished = false;
  const publishedPresets: ContextPresetMigration[] = [];
  try {
    await copyDatabaseWithBackup(options.database, stagedDatabase);
    migrateStagedDatabase(stagedDatabase, currentPlan, options.injectFault);
    const stagedHandle = await open(stagedDatabase, 'r');
    try {
      await stagedHandle.sync();
    } finally {
      await stagedHandle.close();
    }
    const verifiedPlan = await buildMemoryV2MigrationPlan(options);
    if (
      verifiedPlan.report.sourceDigest !== currentPlan.report.sourceDigest
      || verifiedPlan.report.planHash !== currentPlan.report.planHash
    ) {
      throw new Error('Memory V2 source database drifted before atomic publish.');
    }
    options.injectFault?.('before-publish');
    await publishContextPresetMigrations(
      currentPlan.contextPresets,
      publishedPresets,
      options.injectFault,
    );
    options.injectFault?.('after-preset-publish');
    await publishModelConfigTransition(
      options.modelConfig as string,
      currentPlan.modelConfigTransition,
      () => {
        modelConfigPublished = true;
        options.injectFault?.('after-model-rename-before-fsync');
      },
    );
    options.injectFault?.('after-model-publish');
    databasePublishStarted = true;
    await checkpointStoppedDatabaseForPublish(options.database);
    await rm(`${options.database}-wal`, { force: true });
    await rm(`${options.database}-shm`, { force: true });
    await fsyncDirectory(dirname(options.database));
    options.injectFault?.('after-database-sidecar-cleanup');
    await rename(stagedDatabase, options.database);
    published = true;
    options.injectFault?.('after-database-rename-before-fsync');
    await chmod(options.database, 0o600);
    await fsyncFile(options.database);
    await fsyncDirectory(dirname(options.database));
    options.injectFault?.('after-database-publish');

    const applyReport: MemoryV2ApplyReport = {
      ...currentPlan.report,
      command: 'apply',
      dryRun: false,
      applied: true,
      appliedAt: (options.now ?? (() => new Date()))().toISOString(),
    };
    await writeNewDurableFile(
      options.report,
      `${JSON.stringify(applyReport, null, 2)}\n`,
    );
    return applyReport;
  } catch (error) {
    const restoreFailures: string[] = [];
    if (databasePublishStarted || published) {
      try {
        await restoreDatabaseFromBackup(options.database, backupDatabase);
      } catch (restoreError) {
        restoreFailures.push(
          `database: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        );
      }
    }
    if (modelConfigPublished) {
      try {
        await atomicReplaceExistingFile(
          options.modelConfig as string,
          currentPlan.modelConfigTransition.originalRaw,
          0o600,
        );
      } catch (restoreError) {
        restoreFailures.push(
          `model config: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        );
      }
    }
    if (publishedPresets.length > 0) {
      try {
        await restoreContextPresetMigrations(publishedPresets);
      } catch (restoreError) {
        restoreFailures.push(
          restoreError instanceof Error ? restoreError.message : String(restoreError),
        );
      }
    }
    if (restoreFailures.length > 0) {
      throw new Error(
        `Memory V2 cutover failed and rollback was incomplete: ${restoreFailures.join('; ')}. `
        + `Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

function validatedProbeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Semantic probe Admin origin must be an absolute URL.');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(
      'Semantic probe Admin origin must be a loopback HTTP origin without path or credentials.',
    );
  }
  return parsed.origin;
}

function probeRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object.`);
  }
  return value as Record<string, unknown>;
}

interface SemanticProbeResponse {
  target: 'memory.extract' | 'memory.embedding';
  ok: boolean;
  canonicalModel: string | null;
  schemaValid: boolean;
  dimensions: number | null;
  error: string | null;
  snapshot: {
    schemaVersion: number;
    available: boolean;
    enabled: boolean;
    maintenance: boolean;
    readEnabled: boolean;
    writeEnabled: boolean;
    extractConfigured: boolean;
    embedConfigured: boolean;
  };
}

function parseSemanticProbeResponse(
  value: unknown,
  expectedTarget: SemanticProbeResponse['target'],
): SemanticProbeResponse {
  const response = probeRecord(value, `${expectedTarget} probe response`);
  const snapshot = probeRecord(
    response.snapshot,
    `${expectedTarget} probe runtime snapshot`,
  );
  if (
    response.target !== expectedTarget
    || typeof response.ok !== 'boolean'
    || (
      response.canonicalModel !== null
      && typeof response.canonicalModel !== 'string'
    )
    || typeof response.schemaValid !== 'boolean'
    || (
      response.dimensions !== null
      && (
        typeof response.dimensions !== 'number'
        || !Number.isInteger(response.dimensions)
      )
    )
    || (response.error !== null && typeof response.error !== 'string')
    || typeof snapshot.schemaVersion !== 'number'
    || typeof snapshot.available !== 'boolean'
    || typeof snapshot.enabled !== 'boolean'
    || typeof snapshot.maintenance !== 'boolean'
    || typeof snapshot.readEnabled !== 'boolean'
    || typeof snapshot.writeEnabled !== 'boolean'
    || typeof snapshot.extractConfigured !== 'boolean'
    || typeof snapshot.embedConfigured !== 'boolean'
  ) {
    throw new Error(`${expectedTarget} semantic probe response violated its contract.`);
  }
  return {
    target: expectedTarget,
    ok: response.ok,
    canonicalModel: response.canonicalModel as string | null,
    schemaValid: response.schemaValid,
    dimensions: response.dimensions as number | null,
    error: response.error as string | null,
    snapshot: {
      schemaVersion: snapshot.schemaVersion,
      available: snapshot.available,
      enabled: snapshot.enabled,
      maintenance: snapshot.maintenance,
      readEnabled: snapshot.readEnabled,
      writeEnabled: snapshot.writeEnabled,
      extractConfigured: snapshot.extractConfigured,
      embedConfigured: snapshot.embedConfigured,
    },
  };
}

async function readVerifiedPreflightReport(
  path: string,
): Promise<MemoryV2PreflightReport> {
  await assertRegularFile(path, 'Memory V2 preflight report');
  let report: MemoryV2PreflightReport;
  try {
    report = JSON.parse(await readFile(path, 'utf8')) as MemoryV2PreflightReport;
  } catch {
    throw new Error('Memory V2 preflight report is not valid JSON.');
  }
  if (
    report.operation !== CUTOVER_OPERATION
    || report.ledgerSchemaVersion !== MEMORY_LEDGER_SCHEMA_VERSION
    || report.command !== 'preflight'
  ) {
    throw new Error('Semantic probe gate received the wrong preflight report.');
  }
  const {
    planHash,
    command: _command,
    dryRun: _dryRun,
    applied: _applied,
    ...hashInput
  } = report;
  if (reportPlanHash(hashInput) !== planHash) {
    throw new Error('Semantic probe gate preflight report hash is invalid.');
  }
  return report;
}

async function requestSemanticProbe(
  origin: string,
  target: SemanticProbeResponse['target'],
  attempt: number,
): Promise<SemanticProbeResponse> {
  let response: Response;
  try {
    response = await fetch(
      `${origin}/api/admin/v1/memory/probe/${target}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin,
        },
        body: '{}',
        signal: AbortSignal.timeout(180_000),
      },
    );
  } catch {
    throw new Error(`${target} semantic probe ${attempt}/3 could not reach Admin API.`);
  }
  const requestId = response.headers.get('x-request-id');
  if (!response.ok) {
    throw new Error(
      `${target} semantic probe ${attempt}/3 returned HTTP ${response.status}`
      + `${requestId ? ` (request ${requestId})` : ''}.`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${target} semantic probe ${attempt}/3 returned invalid JSON.`);
  }
  return parseSemanticProbeResponse(body, target);
}

export async function runMemoryV2ProbeGate(
  options: MemoryV2CutoverOptions,
): Promise<ProbeGateResult> {
  if (
    options.command !== 'probe-gate'
    || !options.adminOrigin
    || !options.preflightReport
  ) {
    throw new Error('probe-gate requires Admin origin and preflight report.');
  }
  const origin = validatedProbeOrigin(options.adminOrigin);
  const preflight = await readVerifiedPreflightReport(options.preflightReport);
  const expectedModels = {
    'memory.extract': nonEmptyString(
      preflight.modelConfig.extractionCanonicalModel,
      'preflight memory.extract canonical model',
    ),
    'memory.embedding': nonEmptyString(
      preflight.modelConfig.embedding.canonicalModel,
      'preflight memory.embedding canonical model',
    ),
  } as const;
  let embeddingDimensions: number | null = null;
  for (const target of ['memory.extract', 'memory.embedding'] as const) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await requestSemanticProbe(origin, target, attempt);
      const configured = target === 'memory.extract'
        ? result.snapshot.extractConfigured
        : result.snapshot.embedConfigured;
      if (
        !result.ok
        || result.error !== null
        || !result.schemaValid
        || result.canonicalModel !== expectedModels[target]
        || result.snapshot.schemaVersion !== MEMORY_LEDGER_SCHEMA_VERSION
        || !result.snapshot.available
        || !result.snapshot.enabled
        || result.snapshot.maintenance
        || result.snapshot.readEnabled
        || result.snapshot.writeEnabled
        || !configured
      ) {
        throw new Error(
          `${target} semantic probe ${attempt}/3 failed the release contract.`,
        );
      }
      if (target === 'memory.extract') {
        if (result.dimensions !== null) {
          throw new Error(
            `memory.extract semantic probe ${attempt}/3 returned embedding dimensions.`,
          );
        }
        continue;
      }
      if (
        result.dimensions == null
        || result.dimensions <= 0
        || (
          embeddingDimensions !== null
          && result.dimensions !== embeddingDimensions
        )
      ) {
        throw new Error(
          `memory.embedding semantic probe ${attempt}/3 returned inconsistent dimensions.`,
        );
      }
      embeddingDimensions = result.dimensions;
    }
  }
  if (embeddingDimensions == null) {
    throw new Error('memory.embedding semantic probes did not return dimensions.');
  }
  return {
    state: 'ready',
    attemptsPerWorkload: 3,
    extraction: {
      canonicalModel: expectedModels['memory.extract'],
      schemaValid: true,
    },
    embedding: {
      canonicalModel: expectedModels['memory.embedding'],
      schemaValid: true,
      dimensions: embeddingDimensions,
    },
    runtime: {
      enabled: true,
      maintenance: false,
      readEnabled: false,
      writeEnabled: false,
    },
  };
}

export async function verifyMemoryV2Cutover(
  options: MemoryV2CutoverOptions,
): Promise<VerifyResult | BootstrapVerifyResult> {
  if (
    (
      options.command !== 'bootstrap-verify'
      && options.command !== 'verify'
    )
    || !options.modelConfig
    || !options.koishiConfig
    || !options.bundledContextDir
    || !options.runtimeContextDir
    || !options.preflightReport
  ) {
    throw new Error(
      'Post-start verification requires model, runtime, preset, and preflight inputs.',
    );
  }
  const finalPhase = options.command === 'verify';
  const status = await inspectMemoryV2Status(options.database);
  if (status.state !== 'v2' || status.schemaVersion !== MEMORY_LEDGER_SCHEMA_VERSION) {
    throw new Error('Memory Ledger V2 database has not been published.');
  }
  await Promise.all([
    assertRegularFile(options.modelConfig, 'Canonical model config'),
    assertRegularFile(options.koishiConfig, 'QQBot runtime config'),
    assertRegularFile(options.preflightReport, 'Memory V2 preflight report'),
  ]);
  const [modelRaw, koishiRaw, preflightRaw, presets] = await Promise.all([
    readFile(options.modelConfig, 'utf8'),
    readFile(options.koishiConfig, 'utf8'),
    readFile(options.preflightReport, 'utf8'),
    planContextPresetMigration(options.bundledContextDir, options.runtimeContextDir),
  ]);
  assertQqbotRuntimeConfig(koishiRaw);
  if (presets.migrations.length !== 0) {
    throw new Error('Runtime context presets still contain longMemory blocks.');
  }
  let preflight: MemoryV2PreflightReport;
  let model: Record<string, unknown>;
  try {
    preflight = JSON.parse(preflightRaw) as MemoryV2PreflightReport;
    model = JSON.parse(modelRaw) as Record<string, unknown>;
  } catch {
    throw new Error('Post-start verification input is not valid JSON.');
  }
  if (
    preflight.operation !== CUTOVER_OPERATION
    || preflight.ledgerSchemaVersion !== MEMORY_LEDGER_SCHEMA_VERSION
    || preflight.command !== 'preflight'
  ) {
    throw new Error('Post-start verification received the wrong preflight report.');
  }
  const {
    planHash,
    command: _command,
    dryRun: _dryRun,
    applied: _applied,
    ...preflightHashInput
  } = preflight;
  if (
    reportPlanHash(preflightHashInput) !== planHash
  ) {
    throw new Error('Post-start verification preflight report hash is invalid.');
  }
  const modelValidation = modelConfigDocumentSchema.safeParse(model);
  if (!modelValidation.success) {
    throw new Error(
      `Applied model config failed validation: ${modelValidation.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const modelDocument = modelValidation.data;
  const savedRevision = modelDocument.savedRevision;
  const appliedRevision = modelDocument.appliedRevision;
  const expectedRevision = preflight.modelConfig.startupAppliedRevision;
  if (
    savedRevision !== expectedRevision
    || appliedRevision !== expectedRevision
  ) {
    throw new Error(
      `Model config revision ${expectedRevision} is not applied `
      + `(saved=${savedRevision}, applied=${appliedRevision}).`,
    );
  }
  const extraction = modelDocument.bindings
    .filter((binding) => binding.workload === 'memory.extract');
  if (
    extraction.length !== 1
    || extraction[0]?.mode !== 'inheritMain'
  ) {
    throw new Error('Applied memory.extract binding is not canonical inheritMain.');
  }
  const embeddingBinding = modelDocument.bindings.filter(
    (binding) => binding.workload === 'memory.embedding',
  );
  const expectedEmbedding = preflight.modelConfig.embedding;
  if (
    embeddingBinding.length !== 1
    || embeddingBinding[0]?.mode !== 'dedicated'
    || embeddingBinding[0].connectionId !== expectedEmbedding.connectionId
    || embeddingBinding[0].modelId !== expectedEmbedding.modelId
  ) {
    throw new Error('Applied memory.embedding binding changed after preflight.');
  }
  const embeddingProfile = modelDocument.models.find(
    (candidate) => (
      candidate.connectionId === expectedEmbedding.connectionId
      && candidate.id === expectedEmbedding.modelId
    ),
  );
  if (
    !embeddingProfile
    || embeddingProfile.transportModel !== expectedEmbedding.transportModel
    || !embeddingProfile.capabilities.embedding
  ) {
    throw new Error('Applied memory.embedding model profile changed after preflight.');
  }

  const database = new DatabaseSync(options.database, { readOnly: true });
  try {
    const metaRows = database.prepare(
      `SELECT "key", "value" FROM "memory_v2_meta"`,
    ).all() as Array<{ key: string; value: string }>;
    const meta = new Map(metaRows.map((row) => [row.key, row.value]));
    const metaRevision = meta.get('modelConfigRevision');
    if (Number(metaRevision) !== expectedRevision) {
      throw new Error('Memory Ledger model revision does not match the applied model config.');
    }
    if (
      meta.get('cutoverSourceDigest') !== preflight.sourceDigest
      || meta.get('cutoverPlanHash') !== preflight.planHash
    ) {
      throw new Error('Memory Ledger cutover provenance does not match the preflight report.');
    }
    if (
      tableExists(database, 'chatluna_docstore')
      && tableCount(database, 'chatluna_docstore') !== 0
    ) {
      throw new Error('ChatLuna docstore must be empty after cutover.');
    }
    const operationalColumns = new Set(
      (database.prepare(
        'PRAGMA table_info("admin_operational_event")',
      ).all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (
      operationalColumns.has('memoryJobId')
      || operationalColumns.has('memoryCandidateId')
    ) {
      throw new Error('Admin operational events retained legacy memory columns.');
    }
    const expectedAdminPreservation: AdminOperationalPreservationSnapshot = {
      preservedEventCount:
        preflight.database.operationalEvents.preservedEventCount,
      preservedOccurrenceCount:
        preflight.database.operationalEvents.preservedOccurrenceCount,
      preservedEventDigest:
        preflight.database.operationalEvents.preservedEventDigest,
      preservedOccurrenceDigest:
        preflight.database.operationalEvents.preservedOccurrenceDigest,
      preservedCombinedDigest:
        preflight.database.operationalEvents.preservedCombinedDigest,
      sourceEventBoundaryId:
        preflight.database.operationalEvents.sourceEventBoundaryId,
      sourceOccurrenceBoundaryId:
        preflight.database.operationalEvents.sourceOccurrenceBoundaryId,
      preservedEventIdentityDigest:
        preflight.database.operationalEvents.preservedEventIdentityDigest,
      preservedOccurrenceIdentityDigest:
        preflight.database.operationalEvents.preservedOccurrenceIdentityDigest,
    };
    assertRuntimeOperationalPreservation(database, expectedAdminPreservation);
    const active = countWhere(
      database,
      MEMORY_LEDGER_TABLES.head,
      `state = 'active'`,
    );
    const fts = tableCount(database, MEMORY_LEDGER_TABLES.fts);
    assertCanonicalLexicalProjections(
      database,
      EXPECTED_MEMORY_V2_BASELINE.active,
    );
    const embeddings = tableCount(database, MEMORY_LEDGER_TABLES.embedding);
    const backfillWork = countWhere(
      database,
      MEMORY_LEDGER_TABLES.work,
      `workType = 'backfill'`,
    );
    const backfillSucceeded = countWhere(
      database,
      MEMORY_LEDGER_TABLES.work,
      `workType = 'backfill'
        AND status = 'succeeded'
        AND payload = '{}'
        AND leaseToken IS NULL
        AND leaseExpiresAt IS NULL
        AND completedAt IS NOT NULL`,
    );
    const backfillPending = countWhere(
      database,
      MEMORY_LEDGER_TABLES.work,
      `workType = 'backfill'
        AND status = 'pending'
        AND payload <> '{}'
        AND leaseToken IS NULL
        AND leaseExpiresAt IS NULL
        AND completedAt IS NULL
        AND lastErrorCode IS NULL
        AND lastErrorStage IS NULL`,
    );
    const pendingWork = countWhere(
      database,
      MEMORY_LEDGER_TABLES.work,
      `status = 'pending'`,
    );
    const processingWork = countWhere(
      database,
      MEMORY_LEDGER_TABLES.work,
      `status = 'leased'`,
    );
    const deadLetterWork = countWhere(
      database,
      MEMORY_LEDGER_TABLES.work,
      `status = 'deadLetter'`,
    );
    const backfillIncomplete = backfillWork - backfillSucceeded;
    if (
      active !== EXPECTED_MEMORY_V2_BASELINE.active
      || fts !== active
      || backfillWork !== active
      || (
        finalPhase
        && (embeddings !== active || backfillIncomplete !== 0)
      )
      || (
        !finalPhase
        && (
          embeddings !== 0
          || backfillPending !== active
          || backfillSucceeded !== 0
        )
      )
      || processingWork !== 0
      || deadLetterWork !== 0
      || pendingWork !== (finalPhase ? 0 : active)
    ) {
      throw new Error(
        `Post-start Memory V2 ${finalPhase ? 'final' : 'bootstrap'} gate is incomplete: `
        + `active=${active}, `
        + `fts=${fts}, embeddings=${embeddings}, backfill=${backfillWork}, `
        + `backfillPending=${backfillPending}, `
        + `backfillSucceeded=${backfillSucceeded}, pending=${pendingWork}, `
        + `processing=${processingWork}, deadLetter=${deadLetterWork}.`,
      );
    }
    const heads = database.prepare(
      `SELECT * FROM "memory_v2_head" WHERE state = 'active' ORDER BY streamId`,
    ).all() as Array<{
      streamId: string;
      eventId: string;
      revision: number;
      sourceContextKey: string;
      audiencePolicy: string;
      audienceContextKeys: string;
      audienceSnapshots: string;
      subjectKey: string;
      payloadId: string | null;
      contentHash: string | null;
      deletionGeneration: number;
    }>;
    let coreStranded = 0;
    let finalStranded = 0;
    for (const head of heads) {
      let rowCoreStranded = false;
      let rowFinalStranded = false;
      let audience: unknown;
      let audienceSnapshots: unknown;
      try {
        audience = JSON.parse(head.audienceContextKeys);
        audienceSnapshots = JSON.parse(head.audienceSnapshots);
      } catch {
        audience = null;
        audienceSnapshots = null;
      }
      if (
        !Array.isArray(audience)
        || audience.some((value) => typeof value !== 'string')
        || (
          head.audiencePolicy === 'sourceContext'
          && (
            audience.length !== 1
            || audience[0] !== head.sourceContextKey
          )
        )
        || (
          head.audiencePolicy === 'subjectPrivate'
          && (
            audience.length !== 1
            || audience[0] !== head.sourceContextKey
          )
        )
      ) {
        rowCoreStranded = true;
      }
      if (
        !audienceSnapshots
        || typeof audienceSnapshots !== 'object'
        || Array.isArray(audienceSnapshots)
        || Object.keys(audienceSnapshots).length !== 1
        || !Array.isArray(
          (audienceSnapshots as Record<string, unknown>)[head.sourceContextKey],
        )
        || (
          (audienceSnapshots as Record<string, unknown[]>)[head.sourceContextKey]
            ?.length !== 1
        )
        || (
          (audienceSnapshots as Record<string, unknown[]>)[head.sourceContextKey]
            ?.[0] !== head.subjectKey
        )
      ) {
        rowCoreStranded = true;
      }
      const payloadRows = head.payloadId && head.contentHash
        ? database.prepare(
          `SELECT "eventId", "contentHash"
             FROM "memory_v2_payload"
            WHERE "payloadId" = ?`,
        ).all(head.payloadId) as Array<{ eventId: string; contentHash: string }>
        : [];
      if (
        payloadRows.length !== 1
        || payloadRows[0]?.eventId !== head.eventId
        || payloadRows[0]?.contentHash !== head.contentHash
      ) {
        rowCoreStranded = true;
      }
      const evidenceRows = database.prepare(
        `SELECT "captureAudienceSubjectKeys"
           FROM "memory_v2_evidence"
          WHERE "eventId" = ?`,
      ).all(head.eventId) as Array<{ captureAudienceSubjectKeys: string }>;
      if (evidenceRows.length < 1) {
        rowCoreStranded = true;
      }
      for (const evidence of evidenceRows) {
        let evidenceAudience: unknown;
        try {
          evidenceAudience = JSON.parse(evidence.captureAudienceSubjectKeys);
        } catch {
          evidenceAudience = null;
        }
        if (
          !Array.isArray(evidenceAudience)
          || evidenceAudience.length !== 1
          || evidenceAudience[0] !== head.subjectKey
        ) {
          rowCoreStranded = true;
        }
      }
      const ftsCount = countWhere(
        database,
        MEMORY_LEDGER_TABLES.fts,
        `"streamId" = ? AND "eventId" = ? AND "contentHash" = ?`,
        [head.streamId, head.eventId, head.contentHash],
      );
      if (ftsCount !== 1) rowCoreStranded = true;
      const embeddingRows = finalPhase
        ? database.prepare(
        `SELECT "embeddingKey", "dimensions", "vector"
           FROM "memory_v2_embedding"
          WHERE "streamId" = ?
            AND "eventId" = ?
            AND "revision" = ?
            AND "canonicalModel" = ?
            AND "modelRevision" = ?
            AND "contentHash" = ?`,
      ).all(
        head.streamId,
        head.eventId,
        head.revision,
        expectedEmbedding.canonicalModel,
        expectedRevision,
        head.contentHash,
      ) as Array<{ embeddingKey: string; dimensions: number; vector: string }>
        : [];
      const expectedEmbeddingKey = sha256(stableJson([
        head.streamId,
        head.eventId,
        head.revision,
        expectedEmbedding.canonicalModel,
        expectedRevision,
        head.contentHash,
      ]));
      if (finalPhase && (
        embeddingRows.length !== 1
        || embeddingRows[0]?.embeddingKey !== expectedEmbeddingKey
      )) {
        rowFinalStranded = true;
      } else if (finalPhase) {
        let vector: unknown;
        try {
          vector = JSON.parse(embeddingRows[0].vector);
        } catch {
          vector = null;
        }
        if (
          !Array.isArray(vector)
          || vector.length !== Number(embeddingRows[0].dimensions)
          || vector.length === 0
          || vector.some((value) => (
            typeof value !== 'number' || !Number.isFinite(value)
          ))
        ) {
          rowFinalStranded = true;
        }
      }
      const expectedWorkPayload = stableJson({
        streamId: head.streamId,
        eventId: head.eventId,
        revision: head.revision,
        canonicalModel: expectedEmbedding.canonicalModel,
        modelRevision: expectedRevision,
        contentHash: head.contentHash,
      });
      const expectedWorkKey = `backfill:${sha256(stableJson([
        head.streamId,
        head.eventId,
        head.revision,
        expectedEmbedding.canonicalModel,
        expectedRevision,
        head.contentHash,
      ]))}`;
      const workCount = countWhere(
        database,
        MEMORY_LEDGER_TABLES.work,
        `"workKey" = ?
          AND "status" = ?
          AND "inputHash" = ?
          AND "targetRevision" = ?
          AND "deletionGeneration" = ?
          AND "payload" = ?`,
        [
          expectedWorkKey,
          finalPhase ? 'succeeded' : 'pending',
          sha256(expectedWorkPayload),
          head.revision,
          head.deletionGeneration,
          finalPhase ? '{}' : expectedWorkPayload,
        ],
      );
      if (workCount !== 1) {
        if (finalPhase) rowFinalStranded = true;
        else rowCoreStranded = true;
      }
      if (rowCoreStranded) coreStranded += 1;
      if (rowCoreStranded || rowFinalStranded) finalStranded += 1;
    }
    const orphanPayloads = database.prepare(
      `SELECT COUNT(*) AS count
         FROM "memory_v2_payload" payload
         LEFT JOIN "memory_v2_event" event ON event.eventId = payload.eventId
        WHERE event.eventId IS NULL`,
    ).get() as { count: number };
    const orphanEvidence = database.prepare(
      `SELECT COUNT(*) AS count
         FROM "memory_v2_evidence" evidence
         LEFT JOIN "memory_v2_event" event ON event.eventId = evidence.eventId
        WHERE event.eventId IS NULL`,
    ).get() as { count: number };
    const staleEmbeddings = database.prepare(
      `SELECT COUNT(*) AS count
         FROM "memory_v2_embedding" embedding
         LEFT JOIN "memory_v2_head" head
           ON head.streamId = embedding.streamId
          AND head.eventId = embedding.eventId
          AND head.revision = embedding.revision
          AND head.contentHash = embedding.contentHash
          AND head.state = 'active'
        WHERE head.streamId IS NULL
           OR embedding.canonicalModel <> ?
           OR embedding.modelRevision <> ?`,
    ).get(expectedEmbedding.canonicalModel, expectedRevision) as { count: number };
    const inactiveEmbeddings = database.prepare(
      `SELECT COUNT(*) AS count
         FROM "memory_v2_embedding" embedding
         LEFT JOIN "memory_v2_head" head
           ON head.streamId = embedding.streamId
          AND head.eventId = embedding.eventId
          AND head.revision = embedding.revision
          AND head.contentHash = embedding.contentHash
        WHERE head.streamId IS NULL
           OR head.state <> 'active'`,
    ).get() as { count: number };
    const stranded = finalPhase ? finalStranded : coreStranded;
    if (
      stranded !== 0
      || Number(orphanPayloads.count) !== 0
      || Number(orphanEvidence.count) !== 0
      || Number(staleEmbeddings.count) !== 0
      || Number(inactiveEmbeddings.count) !== 0
    ) {
      throw new Error(
        `Post-start Memory V2 ${finalPhase ? 'final' : 'bootstrap'} stranded gate failed: `
        + `stranded=${stranded}, `
        + `orphanPayloads=${Number(orphanPayloads.count)}, `
        + `orphanEvidence=${Number(orphanEvidence.count)}, `
        + `staleEmbeddings=${Number(staleEmbeddings.count)}, `
        + `inactiveEmbeddings=${Number(inactiveEmbeddings.count)}.`,
      );
    }
    const discarded = countWhere(
      database,
      MEMORY_LEDGER_TABLES.audit,
      `eventType = 'operator-discarded'`,
    );
    if (discarded !== EXPECTED_MEMORY_V2_BASELINE.jobs) {
      throw new Error(`Post-start dead-letter accounting mismatch: ${discarded}.`);
    }
    assertProfilesDerivedOnRead(
      database,
      EXPECTED_MEMORY_V2_BASELINE.profiles,
      preflight.decisions.profileSourceActiveHeads,
    );
    if (!finalPhase) {
      return {
        state: 'v2',
        schemaVersion: MEMORY_LEDGER_SCHEMA_VERSION,
        savedRevision,
        appliedRevision,
        extractionMode: 'inheritMain',
        active,
        fts,
        embeddings: 0,
        backfillPending,
        strandedBeforeBackfill: active,
      };
    }
    return {
      state: 'v2',
      schemaVersion: MEMORY_LEDGER_SCHEMA_VERSION,
      savedRevision,
      appliedRevision,
      extractionMode: 'inheritMain',
      active,
      fts,
      embeddings,
      backfillSucceeded,
      backfillIncomplete: 0,
      stranded: 0,
    };
  } finally {
    database.close();
  }
}

export async function runMemoryV2Cutover(
  options: MemoryV2CutoverOptions,
): Promise<
  | StatusResult
  | InitializeResult
  | VerifyResult
  | BootstrapVerifyResult
  | ProbeGateResult
  | MemoryV2PreflightReport
  | MemoryV2ApplyReport
> {
  if (options.command === 'status') return inspectMemoryV2Status(options.database);
  if (options.command === 'initialize') {
    return initializeMemoryV2Ledger(options);
  }
  if (
    options.command === 'bootstrap-verify'
    || options.command === 'verify'
  ) {
    return verifyMemoryV2Cutover(options);
  }
  if (options.command === 'probe-gate') {
    return runMemoryV2ProbeGate(options);
  }
  const plan = await buildMemoryV2MigrationPlan(options);
  if (options.command === 'preflight') {
    if (!options.report) throw new Error('--report is required.');
    await writePreflightReport(options.report, plan.report);
    return plan.report;
  }
  return applyMemoryV2Cutover(options, plan);
}

async function main(): Promise<void> {
  const options = parseMemoryV2CutoverArgs(process.argv.slice(2));
  const result = await runMemoryV2Cutover(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1]
  && /^memory-v2-cutover\.(?:[cm]?[jt]s)$/u.test(basename(process.argv[1]))
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
