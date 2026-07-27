#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
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
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { backup, DatabaseSync } from 'node:sqlite';
import YAML from 'yaml';
import {
  canonicalModelName,
  describeConnectionIdentity,
  modelConfigDraftSchema,
  modelConfigDocumentSchema,
  ModelConfigService,
  type AdapterType,
  type CatalogDriver,
  type ConnectionAuth,
  type ConnectionDefinition,
  type FixedModelWorkload,
  type ModelBinding,
  type ModelConfigDraft,
  type ModelDefinition,
  type ModelWorkload,
  type RequestDefaults,
} from '../plugins/model-config/index.js';

process.umask(0o077);

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);
const ROOT_DIR = process.cwd();
const SOURCE_VERSION = 'legacy-model-config-v1';
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const EMPTY_MODEL_VALUES = new Set(['', 'empty', '无']);

export const LEGACY_MODEL_ENV_KEYS = [
  'CHATLUNA_ACTIVE_TAB',
  'CHATLUNA_PLATFORM',
  'CHATLUNA_BASE_URL',
  'CHATLUNA_API_KEY',
  'CHATLUNA_DEFAULT_MODEL',
  'CHATLUNA_MAX_CONTEXT_RATIO',
  'CHATLUNA_PULL_MODELS',
  'CHATLUNA_SILICONFLOW_BASE_URL',
  'CHATLUNA_SILICONFLOW_API_KEY',
  'CHATLUNA_SILICONFLOW_DEFAULT_MODEL',
  'CHATLUNA_OPENAI_BASE_URL',
  'CHATLUNA_OPENAI_API_KEY',
  'CHATLUNA_OPENAI_DEFAULT_MODEL',
  'CHATLUNA_CODEX_BASE_URL',
  'CHATLUNA_CODEX_API_KEY',
  'CHATLUNA_CODEX_DEFAULT_MODEL',
  'CHATLUNA_CODEX_REASONING_EFFORT',
  'CHATLUNA_COPILOT_BASE_URL',
  'CHATLUNA_COPILOT_API_KEY',
  'CHATLUNA_COPILOT_DEFAULT_MODEL',
  'CHATLUNA_DEEPSEEK_BASE_URL',
  'CHATLUNA_DEEPSEEK_API_KEY',
  'CHATLUNA_DEEPSEEK_DEFAULT_MODEL',
  'CHATLUNA_MIMO_BASE_URL',
  'CHATLUNA_MIMO_API_KEY',
  'CHATLUNA_MIMO_DEFAULT_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'MEMORY_EXTRACT_BASE_URL',
  'MEMORY_EXTRACT_API_KEY',
  'MEMORY_EXTRACT_MODEL',
  'MEMORY_EXTRACT_TIMEOUT_MS',
  'MEMORY_EXTRACT_REQUEST_MODE',
  'MEMORY_EXTRACT_STRUCTURED_OUTPUT_PROTOCOL',
  'MEMORY_EXTRACT_SUPPORTS_JSON_MODE',
  'MEMORY_EMBED_BASE_URL',
  'MEMORY_EMBED_API_KEY',
  'MEMORY_EMBED_MODEL',
  'MEMORY_EMBED_TIMEOUT_MS',
  'CHAT_NATURAL_TRIGGER_DECISION_ENABLED',
  'CHAT_NATURAL_TRIGGER_DECISION_BASE_URL',
  'CHAT_NATURAL_TRIGGER_DECISION_API_KEY',
  'CHAT_NATURAL_TRIGGER_DECISION_MODEL',
  'CHAT_NATURAL_TRIGGER_DECISION_TIMEOUT_MS',
  'STICKER_INDEXER_BASE_URL',
  'STICKER_INDEXER_API_KEY',
  'STICKER_INDEXER_MODEL',
  'STICKER_INDEXER_TIMEOUT_MS',
  'TASK_AUTOMATION_CHAT_REPLY_MODEL',
  'TASK_AUTOMATION_DELIVERY_MODEL',
  'TASK_AUTOMATION_INTENT_API_KEY',
  'TASK_AUTOMATION_INTENT_BASE_URL',
  'TASK_AUTOMATION_INTENT_MODEL',
] as const;

const LEGACY_MODEL_ENV_KEY_SET = new Set<string>(LEGACY_MODEL_ENV_KEYS);

type CutoverCommand = 'preflight' | 'apply';

export interface ModelConfigCutoverOptions {
  command: CutoverCommand;
  database: string;
  envFiles: string[];
  agentDataRoot: string;
  legacyAgentRoot: string | null;
  agentDirs: string[];
  modelMaps: Array<{
    legacyModel: string;
    profileSourceId: string;
  }>;
  modelMapFile: string | null;
  archiveRoot: string | null;
  configOut: string;
  kekOut: string;
  backupDir: string | null;
  report: string | null;
  systemctl: string;
  confirmServiceStopped: boolean;
  now?: () => Date;
}

interface EnvFileSnapshot {
  path: string;
  content: string;
  values: Map<string, string>;
  definedKeys: Set<string>;
  nextContent: string;
  removedKeys: string[];
}

type LegacyProfileKind =
  | 'main-tab'
  | 'generic-openai'
  | 'automation-intent'
  | 'memory-extract'
  | 'memory-embedding'
  | 'natural-trigger'
  | 'affinity'
  | 'sticker';

interface LegacyProfile {
  sourceId: string;
  kind: LegacyProfileKind;
  adapter: AdapterType;
  catalogDriver: CatalogDriver;
  baseUrl: string | null;
  apiKey: string | null;
  auth: ConnectionAuth;
  connectionLabel: string;
  model: string;
  transportModel: string;
  modelType: 'chat' | 'embedding';
  contextSize: number;
  requestMode: 'chat_completions' | 'responses' | null;
  structuredOutputProtocol:
    | 'native_chat_json_schema'
    | 'native_responses_json_schema'
    | 'chat_reply_v1'
    | 'json_mode'
    | null;
  timeoutMs: number;
  requestDefaults: RequestDefaults;
  capabilities: ModelDefinition['capabilities'];
}

interface ModelReference {
  source: string;
  legacyModel: string;
  profileSourceId: string;
}

interface DatabaseValueChange {
  table: 'chatluna_conversation' | 'chathub_room' | 'automation_job';
  rowId: number;
  identity: string;
  column: 'model';
  before: string | null;
  after: string;
}

interface AffinityDelete {
  rowId: number;
  identity: string;
  key: string;
  value: string | null;
}

interface AutomationReference {
  jobId: string;
  sourceRoomId: string;
  sourceConversationId: string;
  conversationModel: string;
  canonicalModel: string;
}

interface DatabasePlan {
  valueChanges: DatabaseValueChange[];
  affinityDeletes: AffinityDelete[];
  automationReferences: AutomationReference[];
}

interface DatabaseModelRow {
  table: 'chatluna_conversation' | 'chathub_room' | 'automation_job';
  rowId: number;
  identity: string;
  model: string | null;
}

interface AutomationJobRow {
  jobId: string;
  sourceRoomId: string;
  sourceConversationId: string | null;
  status: string | null;
}

interface DatabaseSnapshot {
  modelRows: DatabaseModelRow[];
  conversationModels: Map<string, DatabaseModelRow>;
  affinityRows: AffinityDelete[];
  automationJobs: AutomationJobRow[];
  archiveRows: Array<{
    id: string;
    path: string;
    state: string;
  }>;
}

interface AgentFileChange {
  path: string;
  kind: 'json' | 'markdown';
  nextContent: string;
  removed: Array<{
    agentId: string;
    legacyModel: string;
    canonicalModel: string;
  }>;
}

interface PendingAgentFile {
  path: string;
  kind: 'json' | 'markdown';
  content: string;
  entries: Array<{
    agentId: string;
    legacyModel: string;
    profileSourceId: string | null;
    jsonPath?: ['subAgent', 'items' | 'builtin' | 'presetAgents', string];
  }>;
}

interface AgentSourceFile {
  path: string;
  content: Buffer;
}

interface AgentTargetFile {
  path: string;
  relativePath: string;
  content: Buffer;
  mode: number;
}

interface AgentDataPlan {
  root: string;
  sourceFiles: AgentSourceFile[];
  targetFiles: AgentTargetFile[];
  directories: string[];
  files: AgentFileChange[];
  idMappings: AgentIdMapping[];
  bindings: ModelBinding[];
}

interface AgentIdMapping {
  source: 'builtin' | 'markdown' | 'preset';
  oldAgentId: string;
  canonicalAgentId: string;
  artifactPath: string;
}

interface ArchiveChange {
  archiveId: string;
  format: 'directory' | 'gzip';
  archivePath: string;
  contentPath: string;
  sourceHash: string;
  nextContent: Buffer;
  legacyModel: string;
  canonicalModel: string;
}

interface PendingArchive {
  archiveId: string;
  format: ArchiveChange['format'];
  archivePath: string;
  contentPath: string;
  sourceHash: string;
  payload: Record<string, unknown>;
  conversation: Record<string, unknown>;
  legacyModel: string;
  profileSourceId: string;
}

interface RedactedConnectionReport {
  id: string;
  displayName: string;
  adapter: AdapterType;
  baseUrl: string | null;
  auth: {
    kind: ConnectionAuth['kind'];
    credentialState: 'configured' | 'external' | 'none';
  };
  catalogDriver: CatalogDriver;
  sources: string[];
}

export interface ModelConfigMigrationReport {
  schemaVersion: 1;
  operation: 'legacy-model-config-to-canonical-v1';
  sourceVersion: typeof SOURCE_VERSION;
  command: CutoverCommand;
  dryRun: boolean;
  applied: boolean;
  reportHash: string;
  connections: RedactedConnectionReport[];
  models: ModelDefinition[];
  bindings: ModelBinding[];
  modelMappings: Array<{
    legacyModel: string;
    canonicalModel: string;
    sources: string[];
  }>;
  envFiles: Array<{
    path: string;
    removedKeys: string[];
  }>;
  databaseChanges: Array<Omit<DatabaseValueChange, 'rowId'>>;
  affinityDeletes: Array<Pick<AffinityDelete, 'identity' | 'key'>>;
  automationReferences: AutomationReference[];
  agentChanges: Array<{
    path: string;
    kind: AgentFileChange['kind'];
    agents: AgentFileChange['removed'];
  }>;
  agentIdMappings: AgentIdMapping[];
  archiveChanges: Array<{
    archiveId: string;
    format: ArchiveChange['format'];
    archivePath: string;
    legacyModel: string;
    canonicalModel: string;
    sourceHash: string;
  }>;
  explicitModelMaps: Array<{
    legacyModel: string;
    profileSourceId: string;
  }>;
  contextBudget: {
    legacyMaxContextRatio: number;
    nominalChatContextSize: number;
    effectiveChatContextSize: number;
  };
  summary: {
    connectionCount: number;
    modelCount: number;
    bindingCount: number;
    modelMappingCount: number;
    envFileCount: number;
    databaseChangeCount: number;
    affinityDeleteCount: number;
    automationReferenceCount: number;
    agentFileChangeCount: number;
    agentIdMappingCount: number;
    archiveChangeCount: number;
    explicitModelMapCount: number;
  };
}

export interface ModelConfigMigrationPlan {
  draft: ModelConfigDraft;
  apiKeys: Record<string, string>;
  report: ModelConfigMigrationReport;
  envFiles: EnvFileSnapshot[];
  database: DatabasePlan;
  agentData: AgentDataPlan;
  archiveChanges: ArchiveChange[];
  modelMapFile: {
    path: string;
    content: string;
  } | null;
}

interface ConnectionBuildRecord {
  key: string;
  candidateId: string;
  definition: ConnectionDefinition;
  apiKey: string | null;
  sources: Set<string>;
}

interface ModelBuildIntent {
  profile: LegacyProfile;
  connectionKey: string;
}

interface BuiltModelRecord {
  profileSourceId: string;
  connectionId: string;
  modelId: string;
  definition: ModelDefinition;
}

const VALUE_OPTIONS = new Set([
  'database',
  'env-file',
  'agent-data-root',
  'legacy-agent-root',
  'agent-dir',
  'archive-root',
  'config-out',
  'kek-out',
  'backup-dir',
  'report',
  'systemctl',
  'model-map',
  'model-map-file',
]);

function usage(): string {
  return `Usage:
  node dist/tools/model-config-cutover.mjs preflight --env-file <path> [options]
  node dist/tools/model-config-cutover.mjs apply --env-file <path> [options] \\
    --backup-dir <path> --confirm-service-stopped

Options:
  --database <path>          SQLite database (default: ./data/koishi.db)
  --env-file <path>          Dotenv layer, low to high priority; repeatable
  --agent-data-root <path>   Canonical ChatLuna Agent data root
  --legacy-agent-root <path> Legacy active-app Agent root
  --agent-dir <path>         Additional Agent Markdown root; repeatable
  --model-map <old=profile>  Resolve an ambiguous old model; repeatable
  --model-map-file <path>    JSON object of old model to profile mappings
  --archive-root <path>      Trusted root for recoverable ChatLuna archives
  --config-out <path>        Canonical model-config JSON output
  --kek-out <path>           Canonical model-config KEK output
  --backup-dir <path>        Required apply backup directory
  --report <path>            Optional apply report path; preflight is stdout-only
  --systemctl <path>         systemctl binary (default: /usr/bin/systemctl)
  --confirm-service-stopped  Required for apply
`;
}

export function parseModelConfigCutoverArgs(argv: string[]): ModelConfigCutoverOptions {
  const command = argv[0];
  if (command !== 'preflight' && command !== 'apply') {
    throw new Error(usage());
  }

  const values = new Map<string, string[]>();
  let confirmServiceStopped = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--confirm-service-stopped') {
      if (confirmServiceStopped) throw new Error(`Duplicate argument: ${argument}`);
      confirmServiceStopped = true;
      continue;
    }
    if (!argument.startsWith('--') || !VALUE_OPTIONS.has(argument.slice(2))) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}`);
    }
    const name = argument.slice(2);
    const previous = values.get(name) ?? [];
    if (
      name !== 'env-file'
      && name !== 'agent-dir'
      && name !== 'model-map'
      && previous.length > 0
    ) {
      throw new Error(`Duplicate argument: ${argument}`);
    }
    previous.push(value);
    values.set(name, previous);
    index += 1;
  }

  const one = (key: string): string | undefined => values.get(key)?.[0];
  const envFiles = (values.get('env-file') ?? []).map((path) => resolve(path));
  if (envFiles.length === 0) throw new Error('At least one --env-file is required.');
  const backup = one('backup-dir');
  const report = one('report');
  if (command === 'apply' && !backup) {
    throw new Error('--backup-dir is required for apply.');
  }
  if (command === 'apply' && !confirmServiceStopped) {
    throw new Error('apply requires --confirm-service-stopped.');
  }
  if (command === 'preflight' && report) {
    throw new Error('preflight is a zero-write dry run; read its report from stdout.');
  }
  const modelMaps: ModelConfigCutoverOptions['modelMaps'] = [];
  const seenLegacyModels = new Set<string>();
  for (const input of values.get('model-map') ?? []) {
    const separator = input.indexOf('=');
    if (separator <= 0 || separator !== input.lastIndexOf('=') || separator === input.length - 1) {
      throw new Error(`Invalid --model-map value: ${input}`);
    }
    const legacyModel = input.slice(0, separator).trim();
    const profileSourceId = input.slice(separator + 1).trim();
    if (!legacyModel || !/^[a-z0-9._:-]+$/u.test(profileSourceId)) {
      throw new Error(`Invalid --model-map value: ${input}`);
    }
    if (seenLegacyModels.has(legacyModel)) {
      throw new Error(`Duplicate --model-map legacy model: ${legacyModel}`);
    }
    seenLegacyModels.add(legacyModel);
    modelMaps.push({ legacyModel, profileSourceId });
  }

  return {
    command,
    database: resolve(one('database') ?? join(ROOT_DIR, 'data/koishi.db')),
    envFiles,
    agentDataRoot: resolve(
      one('agent-data-root') ?? join(ROOT_DIR, 'data/chatluna'),
    ),
    legacyAgentRoot: one('legacy-agent-root')
      ? resolve(one('legacy-agent-root')!)
      : resolve(join(ROOT_DIR, 'data/chatluna/agent')),
    agentDirs: (values.get('agent-dir') ?? []).map((path) => resolve(path)),
    modelMaps,
    modelMapFile: one('model-map-file') ? resolve(one('model-map-file')!) : null,
    archiveRoot: one('archive-root') ? resolve(one('archive-root')!) : null,
    configOut: resolve(
      one('config-out') ?? join(ROOT_DIR, '.runtime/model-config.json'),
    ),
    kekOut: resolve(
      one('kek-out') ?? join(ROOT_DIR, '.runtime/model-config.kek'),
    ),
    backupDir: backup ? resolve(backup) : null,
    report: report ? resolve(report) : null,
    systemctl: resolve(one('systemctl') ?? '/usr/bin/systemctl'),
    confirmServiceStopped,
  };
}

function parseEnvValue(rawValue: string, label: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) {
      throw new Error(`Unterminated single-quoted dotenv value at ${label}.`);
    }
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"') || trimmed.length < 2) {
      throw new Error(`Unterminated double-quoted dotenv value at ${label}.`);
    }
    return trimmed
      .slice(1, -1)
      .replace(/\\n/gu, '\n')
      .replace(/\\"/gu, '"')
      .replace(/\\\\/gu, '\\');
  }
  return trimmed;
}

function parseEnvContent(content: string, path: string): {
  values: Map<string, string>;
  definedKeys: Set<string>;
} {
  const values = new Map<string, string>();
  const definedKeys = new Set<string>();
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) continue;
    const [, key, rawValue] = match;
    definedKeys.add(key);
    values.set(key, parseEnvValue(rawValue, `${path}:${index + 1}`));
  }
  return { values, definedKeys };
}

function removeLegacyEnvLines(content: string): {
  content: string;
  removedKeys: string[];
} {
  const removed = new Set<string>();
  const lines = content.split(/\r?\n/u);
  const output = lines.filter((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/u);
    if (!match || !LEGACY_MODEL_ENV_KEY_SET.has(match[1])) return true;
    removed.add(match[1]);
    return false;
  });
  return {
    content: `${output.join('\n').replace(/\n+$/u, '')}\n`,
    removedKeys: [...removed].sort(),
  };
}

async function readLayeredEnv(paths: string[]): Promise<{
  files: EnvFileSnapshot[];
  effective: Record<string, string>;
}> {
  const files: EnvFileSnapshot[] = [];
  const effective: Record<string, string> = {};
  for (const path of paths) {
    const content = await readFile(path, 'utf8');
    const parsed = parseEnvContent(content, path);
    for (const [key, value] of parsed.values) effective[key] = value;
    const next = removeLegacyEnvLines(content);
    files.push({
      path,
      content,
      values: parsed.values,
      definedKeys: parsed.definedKeys,
      nextContent: next.content,
      removedKeys: next.removedKeys,
    });
  }
  return { files, effective };
}

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function emptyModel(value: unknown): boolean {
  return EMPTY_MODEL_VALUES.has(trim(value).toLowerCase());
}

function parseBoolean(value: unknown, fallback: boolean, label: string): boolean {
  const normalized = trim(value).toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${label} must be true or false.`);
}

function parsePositiveInteger(value: unknown, fallback: number, label: string): number {
  const normalized = trim(value);
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parseLegacyContextRatio(value: unknown): number {
  const normalized = trim(value);
  if (!normalized) return 0.35;
  const ratio = Number(normalized);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    throw new Error('CHATLUNA_MAX_CONTEXT_RATIO must be greater than 0 and at most 1.');
  }
  return ratio;
}

function normalizeEndpoint(value: unknown, label: string): string {
  const raw = trim(value);
  if (!raw) throw new Error(`${label} is empty.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} cannot contain credentials, query parameters, or a fragment.`);
  }
  url.pathname = url.pathname
    .replace(/\/(?:chat\/completions|responses|embeddings)\/?$/iu, '')
    .replace(/\/+$/u, '');
  return url.toString().replace(/\/+$/u, '');
}

function normalizeLegacyTransportModel(
  model: string,
  sourceId: string,
): string {
  const value = trim(model);
  if (!value) throw new Error(`${sourceId} model is empty.`);
  const strip = (prefix: string): string | null => {
    if (!value.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) return null;
    const result = value.slice(prefix.length + 1).trim();
    return result || null;
  };

  if (sourceId === 'main:siliconflow') {
    return strip('siliconflow') ?? value;
  }
  if (sourceId === 'main:openai') {
    return strip('openai') ?? value;
  }
  if (sourceId === 'main:codex') {
    return strip('openai') ?? value;
  }
  if (sourceId === 'main:copilot') {
    return strip('openai') ?? strip('github-copilot') ?? value;
  }
  if (sourceId === 'main:deepseek') {
    return strip('deepseek') ?? value;
  }
  if (sourceId === 'main:mimo') {
    return strip('mimo') ?? value;
  }
  if (sourceId === 'legacy:openai-generic') {
    return strip('openai') ?? strip('deepseek') ?? value;
  }
  return value;
}

const CHAT_CAPABILITIES: ModelDefinition['capabilities'] = {
  chat: true,
  embedding: false,
  vision: false,
  tools: false,
  structuredOutput: false,
};

function chatCapabilities(
  overrides: Partial<ModelDefinition['capabilities']>,
): ModelDefinition['capabilities'] {
  return { ...CHAT_CAPABILITIES, ...overrides };
}

const MAIN_TAB_DEFINITIONS = {
  siliconflow: {
    label: 'SiliconFlow',
    provider: 'siliconflow',
    baseUrlKey: 'CHATLUNA_SILICONFLOW_BASE_URL',
    apiKeyKey: 'CHATLUNA_SILICONFLOW_API_KEY',
    modelKey: 'CHATLUNA_SILICONFLOW_DEFAULT_MODEL',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Pro/moonshotai/Kimi-K2.5',
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'native_chat_json_schema',
    adapter: 'openaiCompatible',
    catalogDriver: 'openaiModels',
  },
  openai: {
    label: 'OpenAI compatible',
    provider: 'openai',
    baseUrlKey: 'CHATLUNA_OPENAI_BASE_URL',
    apiKeyKey: 'CHATLUNA_OPENAI_API_KEY',
    modelKey: 'CHATLUNA_OPENAI_DEFAULT_MODEL',
    defaultBaseUrl: '',
    defaultModel: '',
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'native_chat_json_schema',
    adapter: 'openaiCompatible',
    catalogDriver: 'openaiModels',
  },
  codex: {
    label: 'Codex OAuth',
    provider: 'openai',
    baseUrlKey: 'CHATLUNA_CODEX_BASE_URL',
    apiKeyKey: 'CHATLUNA_CODEX_API_KEY',
    modelKey: 'CHATLUNA_CODEX_DEFAULT_MODEL',
    defaultBaseUrl: '',
    defaultModel: '',
    requestMode: 'responses',
    structuredOutputProtocol: 'native_responses_json_schema',
    adapter: 'codexBridge',
    catalogDriver: 'codexBridge',
  },
  copilot: {
    label: 'GitHub Copilot OAuth',
    provider: 'openai',
    baseUrlKey: 'CHATLUNA_COPILOT_BASE_URL',
    apiKeyKey: 'CHATLUNA_COPILOT_API_KEY',
    modelKey: 'CHATLUNA_COPILOT_DEFAULT_MODEL',
    defaultBaseUrl: '',
    defaultModel: 'openai/auto',
    requestMode: 'responses',
    structuredOutputProtocol: 'native_responses_json_schema',
    adapter: 'copilotBridge',
    catalogDriver: 'copilotBridge',
  },
  deepseek: {
    label: 'DeepSeek',
    provider: 'deepseek',
    baseUrlKey: 'CHATLUNA_DEEPSEEK_BASE_URL',
    apiKeyKey: 'CHATLUNA_DEEPSEEK_API_KEY',
    modelKey: 'CHATLUNA_DEEPSEEK_DEFAULT_MODEL',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'chat_reply_v1',
    adapter: 'openaiCompatible',
    catalogDriver: 'openaiModels',
  },
  mimo: {
    label: 'Xiaomi MIMO',
    provider: 'mimo',
    baseUrlKey: 'CHATLUNA_MIMO_BASE_URL',
    apiKeyKey: 'CHATLUNA_MIMO_API_KEY',
    modelKey: 'CHATLUNA_MIMO_DEFAULT_MODEL',
    defaultBaseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'native_chat_json_schema',
    adapter: 'openaiCompatible',
    catalogDriver: 'openaiModels',
  },
} as const;

type MainTabId = keyof typeof MAIN_TAB_DEFINITIONS;

function resolveActiveMainTab(env: Record<string, string>): MainTabId {
  const active = trim(env.CHATLUNA_ACTIVE_TAB).toLowerCase();
  if (active) {
    if (active in MAIN_TAB_DEFINITIONS) return active as MainTabId;
    throw new Error(`Unknown CHATLUNA_ACTIVE_TAB: ${active}`);
  }
  const platform = trim(env.CHATLUNA_PLATFORM).toLowerCase();
  if (platform) {
    if (platform === 'siliconflow' || platform === 'deepseek' || platform === 'mimo') {
      return platform;
    }
    if (platform !== 'openai') {
      throw new Error(`Unknown CHATLUNA_PLATFORM: ${platform}`);
    }
  }
  const model = trim(env.CHATLUNA_DEFAULT_MODEL).toLowerCase();
  if (model === 'openai/auto' || model === 'github-copilot/auto') return 'copilot';
  if (model.startsWith('deepseek/')) return 'deepseek';
  if (model.startsWith('mimo/')) return 'mimo';
  if (model.startsWith('openai/')) return 'openai';
  if (model.startsWith('siliconflow/') || model.startsWith('pro/')) return 'siliconflow';
  return 'siliconflow';
}

function assertMirroredField(
  genericValue: string,
  specificValue: string,
  normalize: (value: string) => string,
  genericKey: string,
  specificKey: string,
): void {
  if (!genericValue || !specificValue) return;
  if (normalize(genericValue) !== normalize(specificValue)) {
    throw new Error(`Conflicting layered model configuration: ${genericKey} and ${specificKey}.`);
  }
}

function mainTabConfigured(
  id: MainTabId,
  active: MainTabId,
  env: Record<string, string>,
): boolean {
  if (id === active) return true;
  const definition = MAIN_TAB_DEFINITIONS[id];
  return Boolean(
    trim(env[definition.baseUrlKey])
    || trim(env[definition.apiKeyKey])
    || trim(env[definition.modelKey]),
  );
}

function buildMainProfiles(env: Record<string, string>): {
  activeTab: MainTabId;
  profiles: LegacyProfile[];
  activeProfile: LegacyProfile;
} {
  const activeTab = resolveActiveMainTab(env);
  const profiles: LegacyProfile[] = [];

  for (const id of Object.keys(MAIN_TAB_DEFINITIONS) as MainTabId[]) {
    if (!mainTabConfigured(id, activeTab, env)) continue;
    const definition = MAIN_TAB_DEFINITIONS[id];
    const specificBaseUrl = trim(env[definition.baseUrlKey]);
    const specificApiKey = trim(env[definition.apiKeyKey]);
    const specificModel = trim(env[definition.modelKey]);
    const genericBaseUrl = id === activeTab ? trim(env.CHATLUNA_BASE_URL) : '';
    const genericApiKey = id === activeTab ? trim(env.CHATLUNA_API_KEY) : '';
    const genericModel = id === activeTab ? trim(env.CHATLUNA_DEFAULT_MODEL) : '';

    if (definition.adapter === 'openaiCompatible') {
      assertMirroredField(
        genericBaseUrl,
        specificBaseUrl,
        (value) => normalizeEndpoint(value, 'main chat endpoint'),
        'CHATLUNA_BASE_URL',
        definition.baseUrlKey,
      );
      assertMirroredField(
        genericApiKey,
        specificApiKey,
        (value) => value,
        'CHATLUNA_API_KEY',
        definition.apiKeyKey,
      );
    }
    assertMirroredField(
      genericModel,
      specificModel,
      (value) => normalizeLegacyTransportModel(value, `main:${id}`).toLowerCase(),
      'CHATLUNA_DEFAULT_MODEL',
      definition.modelKey,
    );

    const model = specificModel || genericModel || definition.defaultModel;
    if (!model) {
      if (id === activeTab) {
        throw new Error(`Active main tab ${id} has no configured model.`);
      }
      continue;
    }

    let baseUrl: string | null = null;
    let apiKey: string | null = null;
    let auth: ConnectionAuth;
    if (definition.adapter === 'openaiCompatible') {
      const endpoint = specificBaseUrl || genericBaseUrl || definition.defaultBaseUrl;
      if (!endpoint) {
        throw new Error(`Main tab ${id} has no configured endpoint.`);
      }
      baseUrl = normalizeEndpoint(endpoint, `${definition.baseUrlKey}`);
      apiKey = specificApiKey || genericApiKey || null;
      if (id === activeTab && !apiKey) {
        throw new Error(`Active main tab ${id} has no configured API key.`);
      }
      auth = apiKey
        ? { kind: 'apiKey', secretRef: `connection:${id}:api-key` }
        : { kind: 'none' };
    } else {
      auth = {
        kind: 'oauth',
        provider: definition.adapter === 'codexBridge' ? 'codex' : 'copilot',
      };
    }

    const sourceId = `main:${id}`;
    const defaults: RequestDefaults = {};
    if (id === 'codex') {
      const effort = trim(env.CHATLUNA_CODEX_REASONING_EFFORT).toLowerCase() || 'medium';
      if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) {
        throw new Error('CHATLUNA_CODEX_REASONING_EFFORT is invalid.');
      }
      defaults.reasoningEffort = effort as 'low' | 'medium' | 'high' | 'xhigh';
    } else if (id === 'openai') {
      const match = model.toLowerCase().match(
        /-(non|minimal|low|medium|high|xhigh)-thinking$/u,
      );
      if (match) {
        defaults.reasoningEffort = (match[1] === 'non' ? 'none' : match[1]) as
          NonNullable<RequestDefaults['reasoningEffort']>;
      }
    }
    const profile: LegacyProfile = {
      sourceId,
      kind: 'main-tab',
      adapter: definition.adapter,
      catalogDriver: definition.catalogDriver,
      baseUrl,
      apiKey,
      auth,
      connectionLabel: describeConnectionIdentity({
        adapter: definition.adapter,
        baseUrl,
        auth,
      }).displayNameBase,
      model,
      transportModel: normalizeLegacyTransportModel(model, sourceId),
      modelType: 'chat',
      contextSize: 128_000,
      requestMode: definition.requestMode,
      structuredOutputProtocol: definition.structuredOutputProtocol,
      timeoutMs: 180_000,
      requestDefaults: defaults,
      capabilities: chatCapabilities({
        vision: id !== 'deepseek',
        tools: true,
        structuredOutput: true,
      }),
    };
    profiles.push(profile);
  }

  const activeProfile = profiles.find((profile) => profile.sourceId === `main:${activeTab}`);
  if (!activeProfile) throw new Error(`Active main profile ${activeTab} was not constructed.`);
  return { activeTab, profiles, activeProfile };
}

function buildOpenAiProfile(args: {
  sourceId: string;
  kind: LegacyProfileKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  modelType?: 'chat' | 'embedding';
  requestMode?: 'chat_completions' | 'responses' | null;
  structuredOutputProtocol?: LegacyProfile['structuredOutputProtocol'];
  timeoutMs: number;
  capabilities: ModelDefinition['capabilities'];
}): LegacyProfile {
  const modelType = args.modelType ?? 'chat';
  const baseUrl = normalizeEndpoint(args.baseUrl, `${args.sourceId} endpoint`);
  const auth = {
    kind: 'apiKey' as const,
    secretRef: `connection:${slug(args.sourceId)}:api-key`,
  };
  return {
    sourceId: args.sourceId,
    kind: args.kind,
    adapter: 'openaiCompatible',
    catalogDriver: 'static',
    baseUrl,
    apiKey: args.apiKey,
    auth,
    connectionLabel: describeConnectionIdentity({
      adapter: 'openaiCompatible',
      baseUrl,
      auth,
    }).displayNameBase,
    model: args.model,
    transportModel: normalizeLegacyTransportModel(args.model, args.sourceId),
    modelType,
    contextSize: modelType === 'embedding' ? 8_192 : 128_000,
    requestMode: args.requestMode ?? (modelType === 'embedding' ? null : 'chat_completions'),
    structuredOutputProtocol:
      args.structuredOutputProtocol ?? (modelType === 'embedding' ? null : 'native_chat_json_schema'),
    timeoutMs: args.timeoutMs,
    requestDefaults: {},
    capabilities: args.capabilities,
  };
}

function coreFields(env: Record<string, string>, prefix: string): {
  baseUrl: string;
  apiKey: string;
  model: string;
  count: number;
} {
  const baseUrl = trim(env[`${prefix}_BASE_URL`]);
  const apiKey = trim(env[`${prefix}_API_KEY`]);
  const model = trim(env[`${prefix}_MODEL`]);
  return {
    baseUrl,
    apiKey,
    model,
    count: [baseUrl, apiKey, model].filter(Boolean).length,
  };
}

function buildMemoryExtractProfile(env: Record<string, string>): LegacyProfile | null {
  const fields = coreFields(env, 'MEMORY_EXTRACT');
  if (fields.count < 3) return null;
  const requestMode = trim(env.MEMORY_EXTRACT_REQUEST_MODE) || 'chat_completions';
  if (requestMode !== 'chat_completions' && requestMode !== 'responses') {
    throw new Error('MEMORY_EXTRACT_REQUEST_MODE is invalid.');
  }
  const protocol = trim(env.MEMORY_EXTRACT_STRUCTURED_OUTPUT_PROTOCOL)
    || (requestMode === 'responses'
      ? 'native_responses_json_schema'
      : 'native_chat_json_schema');
  if (
    protocol !== 'native_chat_json_schema'
    && protocol !== 'native_responses_json_schema'
  ) {
    throw new Error(
      'Complete Memory extraction requires a native JSON schema protocol for canonical cutover.',
    );
  }
  if (
    (requestMode === 'responses') !== (protocol === 'native_responses_json_schema')
  ) {
    throw new Error('Memory extraction request mode conflicts with its structured output protocol.');
  }
  return buildOpenAiProfile({
    sourceId: 'memory:extract',
    kind: 'memory-extract',
    ...fields,
    requestMode,
    structuredOutputProtocol: protocol,
    timeoutMs: parsePositiveInteger(
      env.MEMORY_EXTRACT_TIMEOUT_MS,
      180_000,
      'MEMORY_EXTRACT_TIMEOUT_MS',
    ),
    capabilities: chatCapabilities({ structuredOutput: true }),
  });
}

function buildMemoryEmbeddingProfile(env: Record<string, string>): LegacyProfile | null {
  const fields = coreFields(env, 'MEMORY_EMBED');
  if (fields.count < 3) return null;
  return buildOpenAiProfile({
    sourceId: 'memory:embedding',
    kind: 'memory-embedding',
    ...fields,
    modelType: 'embedding',
    requestMode: null,
    structuredOutputProtocol: null,
    timeoutMs: parsePositiveInteger(
      env.MEMORY_EMBED_TIMEOUT_MS,
      12_000,
      'MEMORY_EMBED_TIMEOUT_MS',
    ),
    capabilities: {
      chat: false,
      embedding: true,
      vision: false,
      tools: false,
      structuredOutput: false,
    },
  });
}

function buildNaturalProfile(env: Record<string, string>): LegacyProfile | null {
  const enabled = parseBoolean(
    env.CHAT_NATURAL_TRIGGER_DECISION_ENABLED,
    true,
    'CHAT_NATURAL_TRIGGER_DECISION_ENABLED',
  );
  if (!enabled) return null;
  const fields = coreFields(env, 'CHAT_NATURAL_TRIGGER_DECISION');
  if (fields.count < 3) return null;
  return buildOpenAiProfile({
    sourceId: 'natural-trigger:decision',
    kind: 'natural-trigger',
    ...fields,
    timeoutMs: parsePositiveInteger(
      env.CHAT_NATURAL_TRIGGER_DECISION_TIMEOUT_MS,
      4_000,
      'CHAT_NATURAL_TRIGGER_DECISION_TIMEOUT_MS',
    ),
    capabilities: chatCapabilities({ structuredOutput: true }),
  });
}

function buildStickerProfile(env: Record<string, string>): LegacyProfile | null {
  const baseUrl = trim(env.STICKER_INDEXER_BASE_URL)
    || 'https://ark.cn-beijing.volces.com/api/v3';
  const apiKey = trim(env.STICKER_INDEXER_API_KEY);
  const model = trim(env.STICKER_INDEXER_MODEL)
    || 'doubao-seed-2-0-mini-260215';
  if (!apiKey) return null;
  return buildOpenAiProfile({
    sourceId: 'sticker:index',
    kind: 'sticker',
    baseUrl,
    apiKey,
    model,
    timeoutMs: parsePositiveInteger(
      env.STICKER_INDEXER_TIMEOUT_MS,
      60_000,
      'STICKER_INDEXER_TIMEOUT_MS',
    ),
    capabilities: chatCapabilities({
      vision: true,
      structuredOutput: true,
    }),
  });
}

function buildGenericOpenAiProfile(env: Record<string, string>): LegacyProfile | null {
  const fields = coreFields(env, 'OPENAI');
  if (fields.count === 0) return null;
  if (fields.count !== 3) {
    throw new Error('OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL must be configured together.');
  }
  const endpoint = normalizeEndpoint(fields.baseUrl, 'OPENAI_BASE_URL');
  const normalizedModel = fields.model.toLowerCase();
  const isDeepSeek = new URL(endpoint).hostname.toLowerCase() === 'api.deepseek.com'
    || normalizedModel.startsWith('deepseek');
  return buildOpenAiProfile({
    sourceId: 'legacy:openai-generic',
    kind: 'generic-openai',
    ...fields,
    requestMode: 'chat_completions',
    structuredOutputProtocol: isDeepSeek
      ? 'chat_reply_v1'
      : 'native_chat_json_schema',
    timeoutMs: 180_000,
    capabilities: chatCapabilities({
      vision: !isDeepSeek,
      tools: true,
      structuredOutput: true,
    }),
  });
}

function buildAutomationIntentProfile(
  env: Record<string, string>,
): LegacyProfile | null {
  const fields = coreFields(env, 'TASK_AUTOMATION_INTENT');
  if (fields.count === 0 || (fields.count === 1 && fields.model)) return null;
  if (fields.count !== 3) {
    throw new Error(
      'TASK_AUTOMATION_INTENT_BASE_URL, TASK_AUTOMATION_INTENT_API_KEY, and TASK_AUTOMATION_INTENT_MODEL must be configured together when an explicit transport is retained.',
    );
  }
  return buildOpenAiProfile({
    sourceId: 'automation:intent',
    kind: 'automation-intent',
    ...fields,
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'native_chat_json_schema',
    timeoutMs: 12_000,
    capabilities: chatCapabilities({ structuredOutput: true }),
  });
}

function validateExplicitModelMaps(
  entries: ModelConfigCutoverOptions['modelMaps'],
  profiles: LegacyProfile[],
): Map<string, string> {
  const available = new Set(profiles.map((profile) => profile.sourceId));
  const result = new Map<string, string>();
  for (const entry of entries) {
    if (!available.has(entry.profileSourceId)) {
      throw new Error(
        `Explicit model map ${entry.legacyModel} targets unavailable profile ${entry.profileSourceId}.`,
      );
    }
    if (
      entry.legacyModel.toLowerCase() === 'openai/auto'
      && entry.profileSourceId !== 'main:copilot'
    ) {
      throw new Error('openai/auto can only map to main:copilot.');
    }
    result.set(entry.legacyModel, entry.profileSourceId);
  }
  return result;
}

async function loadExplicitModelMaps(
  options: ModelConfigCutoverOptions,
): Promise<{
  entries: ModelConfigCutoverOptions['modelMaps'];
  file: ModelConfigMigrationPlan['modelMapFile'];
}> {
  const entries: ModelConfigCutoverOptions['modelMaps'] = [];
  let file: ModelConfigMigrationPlan['modelMapFile'] = null;
  if (options.modelMapFile) {
    const info = await lstat(options.modelMapFile);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Model map file must be a regular file: ${options.modelMapFile}`);
    }
    const content = await readFile(options.modelMapFile, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`Model map file is not valid JSON: ${options.modelMapFile}`);
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Model map file must contain a JSON object.');
    }
    for (const [legacyModel, target] of Object.entries(parsed)) {
      if (
        !legacyModel.trim()
        || typeof target !== 'string'
        || !/^[a-z0-9._:-]+$/u.test(target.trim())
      ) {
        throw new Error(`Invalid model map file entry: ${legacyModel}`);
      }
      entries.push({
        legacyModel: legacyModel.trim(),
        profileSourceId: target.trim(),
      });
    }
    file = { path: options.modelMapFile, content };
  }
  entries.push(...options.modelMaps.map((entry) => ({ ...entry })));
  entries.sort((left, right) => left.legacyModel.localeCompare(right.legacyModel));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]?.legacyModel === entries[index]?.legacyModel) {
      throw new Error(
        `Duplicate explicit model map legacy model: ${entries[index]!.legacyModel}`,
      );
    }
  }
  return { entries, file };
}

function applyLegacyContextBudget(
  profiles: LegacyProfile[],
  ratio: number,
): {
  nominalChatContextSize: number;
  effectiveChatContextSize: number;
} {
  const nominalChatContextSize = 128_000;
  const effectiveChatContextSize = Math.floor(nominalChatContextSize * ratio);
  if (effectiveChatContextSize < 1) {
    throw new Error('CHATLUNA_MAX_CONTEXT_RATIO produces an empty canonical context budget.');
  }
  for (const profile of profiles) {
    if (profile.modelType === 'chat') {
      profile.contextSize = Math.floor(profile.contextSize * ratio);
    }
  }
  return { nominalChatContextSize, effectiveChatContextSize };
}

function parseAffinityProfile(value: string | null): LegacyProfile | null {
  if (value == null || !value.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('affinity_config.analysisModel must contain valid JSON.');
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('affinity_config.analysisModel must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  const baseUrl = trim(record.baseUrl);
  const apiKey = trim(record.apiKey);
  const model = trim(record.model);
  const count = [baseUrl, apiKey, model].filter(Boolean).length;
  if (count === 0) return null;
  if (count !== 3) {
    throw new Error('affinity_config.analysisModel is partially configured.');
  }
  const requestMode = trim(record.requestMode) || 'chat_completions';
  const protocol = trim(record.structuredOutputProtocol)
    || (requestMode === 'responses'
      ? 'native_responses_json_schema'
      : 'native_chat_json_schema');
  if (requestMode !== 'chat_completions' && requestMode !== 'responses') {
    throw new Error('affinity_config.analysisModel.requestMode is invalid.');
  }
  if (
    protocol !== 'native_chat_json_schema'
    && protocol !== 'native_responses_json_schema'
  ) {
    throw new Error(
      'Affinity analysis requires a native JSON schema protocol for canonical cutover.',
    );
  }
  if (
    (requestMode === 'responses') !== (protocol === 'native_responses_json_schema')
  ) {
    throw new Error('Affinity analysis request mode conflicts with its protocol.');
  }
  return buildOpenAiProfile({
    sourceId: 'affinity:analysis',
    kind: 'affinity',
    baseUrl,
    apiKey,
    model,
    requestMode,
    structuredOutputProtocol: protocol,
    timeoutMs: parsePositiveInteger(
      record.timeoutMs,
      5_000,
      'affinity_config.analysisModel.timeoutMs',
    ),
    capabilities: chatCapabilities({ structuredOutput: true }),
  });
}

function sqliteTableNames(database: DatabaseSync): Set<string> {
  const rows = database.prepare(
    "select name from sqlite_schema where type = 'table'",
  ).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function sqliteColumns(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`pragma table_info("${table}")`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((row) => row.name));
}

function requireColumns(
  database: DatabaseSync,
  table: string,
  required: string[],
): void {
  const columns = sqliteColumns(database, table);
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(`${table} is missing migration column(s): ${missing.join(', ')}`);
  }
}

function sqlText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  return value;
}

function sqlNullableText(value: unknown, label: string): string | null {
  if (value == null) return null;
  return sqlText(value, label);
}

function sqlRowId(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} rowid is invalid.`);
  }
  return value;
}

function readDatabaseSnapshot(path: string): DatabaseSnapshot {
  const database = new DatabaseSync(path, {
    open: true,
    readOnly: true,
  });
  try {
    const tables = sqliteTableNames(database);
    const modelRows: DatabaseModelRow[] = [];
    const conversationModels = new Map<string, DatabaseModelRow>();

    if (tables.has('chatluna_conversation')) {
      requireColumns(database, 'chatluna_conversation', ['id', 'model']);
      const rows = database.prepare(
        'select rowid as rowId, id, model from chatluna_conversation order by rowid',
      ).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const identity = sqlText(row.id, 'chatluna_conversation.id');
        const modelRow: DatabaseModelRow = {
          table: 'chatluna_conversation',
          rowId: sqlRowId(row.rowId, 'chatluna_conversation'),
          identity,
          model: sqlNullableText(row.model, 'chatluna_conversation.model'),
        };
        if (conversationModels.has(identity)) {
          throw new Error(
            `Duplicate chatluna_conversation.id in migration snapshot: ${identity}`,
          );
        }
        conversationModels.set(identity, modelRow);
        modelRows.push(modelRow);
      }
    }

    if (tables.has('chathub_room')) {
      requireColumns(database, 'chathub_room', ['roomId', 'model']);
      const rows = database.prepare(
        'select rowid as rowId, roomId, model from chathub_room order by rowid',
      ).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const identity = String(row.roomId);
        const modelRow: DatabaseModelRow = {
          table: 'chathub_room',
          rowId: sqlRowId(row.rowId, 'chathub_room'),
          identity,
          model: sqlNullableText(row.model, 'chathub_room.model'),
        };
        modelRows.push(modelRow);
      }
    }

    const affinityRows: AffinityDelete[] = [];
    if (tables.has('affinity_config')) {
      requireColumns(database, 'affinity_config', ['id', 'key', 'value']);
      const rows = database.prepare(
        "select rowid as rowId, id, key, value from affinity_config where key = 'analysisModel' order by rowid",
      ).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        affinityRows.push({
          rowId: sqlRowId(row.rowId, 'affinity_config'),
          identity: String(row.id),
          key: sqlText(row.key, 'affinity_config.key'),
          value: sqlNullableText(row.value, 'affinity_config.value'),
        });
      }
      if (affinityRows.length > 1) {
        throw new Error('affinity_config contains duplicate analysisModel rows.');
      }
    }

    const automationJobs: AutomationJobRow[] = [];
    if (tables.has('automation_job')) {
      const columns = sqliteColumns(database, 'automation_job');
      if (
        !columns.has('id')
        || !columns.has('sourceRoomId')
        || !columns.has('sourceConversationId')
      ) {
        throw new Error(
          'automation_job is missing id/sourceRoomId/sourceConversationId migration columns.',
        );
      }
      const statusSelect = columns.has('status') ? 'status' : 'null as status';
      const rows = database.prepare(
        `select id, sourceRoomId, sourceConversationId, ${statusSelect} from automation_job order by id`,
      ).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        automationJobs.push({
          jobId: String(row.id),
          sourceRoomId: String(row.sourceRoomId),
          sourceConversationId: sqlNullableText(
            row.sourceConversationId,
            'automation_job.sourceConversationId',
          ),
          status: sqlNullableText(row.status, 'automation_job.status'),
        });
      }
      if (columns.has('model')) {
        const directRows = database.prepare(
          'select rowid as rowId, id, model from automation_job order by rowid',
        ).all() as Array<Record<string, unknown>>;
        for (const row of directRows) {
          modelRows.push({
            table: 'automation_job',
            rowId: sqlRowId(row.rowId, 'automation_job'),
            identity: String(row.id),
            model: sqlNullableText(row.model, 'automation_job.model'),
          });
        }
      }
    }

    const archiveRows: DatabaseSnapshot['archiveRows'] = [];
    if (tables.has('chatluna_archive')) {
      requireColumns(database, 'chatluna_archive', ['id', 'path', 'state']);
      const rows = database.prepare(
        'select id, path, state from chatluna_archive order by id',
      ).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        archiveRows.push({
          id: sqlText(row.id, 'chatluna_archive.id'),
          path: sqlText(row.path, 'chatluna_archive.path'),
          state: sqlText(row.state, 'chatluna_archive.state'),
        });
      }
    }

    return {
      modelRows,
      conversationModels,
      affinityRows,
      automationJobs,
      archiveRows,
    };
  } finally {
    database.close();
  }
}

function connectionIdentity(profile: LegacyProfile): string {
  if (profile.adapter === 'codexBridge') return 'codexBridge';
  if (profile.adapter === 'copilotBridge') return 'copilotBridge';
  return JSON.stringify([
    'openaiCompatible',
    profile.baseUrl,
    profile.auth.kind,
    profile.apiKey,
  ]);
}

function slug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\x00-\x7F]/gu, '-')
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/gu, '')
    .slice(0, 64)
    .replace(/[._-]+$/gu, '');
  return normalized || 'model';
}

function modelIdBase(transportModel: string): string {
  return slug(transportModel).slice(0, 88).replace(/[._-]+$/gu, '') || 'model';
}

function mergeCapabilities(
  left: ModelDefinition['capabilities'],
  right: ModelDefinition['capabilities'],
): ModelDefinition['capabilities'] {
  return {
    chat: left.chat || right.chat,
    embedding: left.embedding || right.embedding,
    vision: left.vision || right.vision,
    tools: left.tools || right.tools,
    structuredOutput: left.structuredOutput || right.structuredOutput,
  };
}

function mergeModelProfiles(profiles: LegacyProfile[]): LegacyProfile {
  const [first, ...rest] = profiles;
  if (!first) throw new Error('Cannot merge an empty model profile group.');
  const merged = structuredClone(first);
  for (const profile of rest) {
    if (merged.modelType !== profile.modelType) {
      throw new Error(
        `Model ${first.transportModel} is configured as both chat and embedding on one connection.`,
      );
    }
    if (
      merged.requestMode != null
      && profile.requestMode != null
      && merged.requestMode !== profile.requestMode
    ) {
      throw new Error(
        `Model ${first.transportModel} has conflicting request modes on one connection.`,
      );
    }
    if (
      merged.structuredOutputProtocol != null
      && profile.structuredOutputProtocol != null
      && merged.structuredOutputProtocol !== profile.structuredOutputProtocol
    ) {
      throw new Error(
        `Model ${first.transportModel} has conflicting structured output protocols.`,
      );
    }
    merged.requestMode ??= profile.requestMode;
    merged.structuredOutputProtocol ??= profile.structuredOutputProtocol;
    merged.timeoutMs = Math.max(merged.timeoutMs, profile.timeoutMs);
    merged.contextSize = Math.max(merged.contextSize, profile.contextSize);
    merged.capabilities = mergeCapabilities(merged.capabilities, profile.capabilities);
    merged.requestDefaults = {
      ...profile.requestDefaults,
      ...merged.requestDefaults,
    };
  }
  if (
    merged.modelType === 'chat'
    && merged.capabilities.structuredOutput
    && merged.structuredOutputProtocol == null
  ) {
    merged.structuredOutputProtocol = merged.requestMode === 'responses'
      ? 'native_responses_json_schema'
      : 'native_chat_json_schema';
  }
  return merged;
}

function buildCanonicalCatalog(profiles: LegacyProfile[]): {
  connections: ConnectionDefinition[];
  models: ModelDefinition[];
  connectionReports: RedactedConnectionReport[];
  apiKeys: Record<string, string>;
  byProfileSourceId: Map<string, BuiltModelRecord>;
} {
  const connectionsByKey = new Map<string, ConnectionBuildRecord>();
  const usedConnectionIds = new Set<string>();
  const connectionLabelCounts = new Map<string, number>();
  for (const profile of profiles) {
    const key = connectionIdentity(profile);
    let record = connectionsByKey.get(key);
    if (!record) {
      const baseId = slug(
        profile.adapter === 'codexBridge'
          ? 'codex'
          : profile.adapter === 'copilotBridge'
            ? 'copilot'
            : profile.connectionLabel,
      );
      let id = baseId;
      let suffix = 2;
      while (usedConnectionIds.has(id)) {
        id = `${baseId.slice(0, 60)}-${suffix}`;
        suffix += 1;
      }
      usedConnectionIds.add(id);
      const labelIndex = (connectionLabelCounts.get(profile.connectionLabel) ?? 0) + 1;
      connectionLabelCounts.set(profile.connectionLabel, labelIndex);
      const auth: ConnectionAuth = profile.auth.kind === 'apiKey'
        ? {
            kind: 'apiKey',
            secretRef: `connection:${id}:api-key`,
          }
        : profile.auth;
      record = {
        key,
        candidateId: id,
        definition: {
          id,
          displayName: labelIndex === 1
            ? profile.connectionLabel
            : `${profile.connectionLabel} ${labelIndex}`,
          adapter: profile.adapter,
          baseUrl: profile.baseUrl,
          auth,
          catalogDriver: profile.catalogDriver,
        },
        apiKey: profile.apiKey,
        sources: new Set(),
      };
      connectionsByKey.set(key, record);
    } else if (
      record.definition.catalogDriver === 'static'
      && profile.catalogDriver === 'openaiModels'
    ) {
      record.definition.catalogDriver = 'openaiModels';
    }
    record.sources.add(profile.sourceId);
  }

  const groupedModels = new Map<string, LegacyProfile[]>();
  for (const profile of profiles) {
    const connectionKey = connectionIdentity(profile);
    const key = JSON.stringify([connectionKey, profile.transportModel]);
    const group = groupedModels.get(key) ?? [];
    group.push(profile);
    groupedModels.set(key, group);
  }

  const modelRecords = new Map<string, BuiltModelRecord>();
  const models: ModelDefinition[] = [];
  const usedModelIds = new Map<string, Set<string>>();
  const orderedGroups = [...groupedModels.entries()].sort(([left], [right]) =>
    left.localeCompare(right));
  for (const [, group] of orderedGroups) {
    const merged = mergeModelProfiles(group);
    const connection = connectionsByKey.get(connectionIdentity(merged));
    if (!connection) throw new Error(`Connection missing for ${merged.sourceId}.`);
    const used = usedModelIds.get(connection.candidateId) ?? new Set<string>();
    const base = modelIdBase(merged.transportModel);
    let modelId = base;
    let suffix = 2;
    while (used.has(modelId)) {
      modelId = `${base.slice(0, 88)}-${suffix}`;
      suffix += 1;
    }
    used.add(modelId);
    usedModelIds.set(connection.candidateId, used);

    const definition: ModelDefinition = {
      id: modelId,
      connectionId: connection.candidateId,
      displayName: merged.model,
      transportModel: merged.transportModel,
      modelType: merged.modelType,
      contextSize: merged.contextSize,
      requestMode: merged.requestMode,
      structuredOutputProtocol: merged.structuredOutputProtocol,
      capabilities: merged.capabilities,
      timeoutMs: merged.timeoutMs,
      requestDefaults: merged.requestDefaults,
    };
    models.push(definition);
    for (const profile of group) {
      modelRecords.set(profile.sourceId, {
        profileSourceId: profile.sourceId,
        connectionId: connection.candidateId,
        modelId,
        definition,
      });
    }
  }

  const connections = [...connectionsByKey.values()]
    .map((record) => record.definition)
    .sort((left, right) => left.id.localeCompare(right.id));
  models.sort((left, right) =>
    left.connectionId.localeCompare(right.connectionId)
    || left.id.localeCompare(right.id));

  const apiKeys: Record<string, string> = {};
  const connectionReports: RedactedConnectionReport[] = [];
  for (const record of [...connectionsByKey.values()].sort((left, right) =>
    left.candidateId.localeCompare(right.candidateId))) {
    if (record.apiKey) apiKeys[record.candidateId] = record.apiKey;
    connectionReports.push({
      id: record.candidateId,
      displayName: record.definition.displayName,
      adapter: record.definition.adapter,
      baseUrl: record.definition.baseUrl,
      auth: {
        kind: record.definition.auth.kind,
        credentialState: record.definition.auth.kind === 'oauth'
          ? 'external'
          : record.apiKey
            ? 'configured'
            : 'none',
      },
      catalogDriver: record.definition.catalogDriver,
      sources: [...record.sources].sort(),
    });
  }
  return {
    connections,
    models,
    connectionReports,
    apiKeys,
    byProfileSourceId: modelRecords,
  };
}

function cloneProfileForReference(
  base: LegacyProfile,
  legacyModel: string,
  source: string,
): LegacyProfile {
  const sourceId = `reference:${createHash('sha256')
    .update(`${base.sourceId}\0${legacyModel}`)
    .digest('hex')
    .slice(0, 20)}`;
  const profile = structuredClone(base);
  profile.sourceId = sourceId;
  profile.model = legacyModel;
  profile.transportModel = normalizeLegacyTransportModel(legacyModel, base.sourceId);
  profile.connectionLabel = base.connectionLabel;
  void source;
  return profile;
}

function canonicalForRecord(record: BuiltModelRecord): string {
  return canonicalModelName(
    { id: record.connectionId },
    { id: record.modelId },
  );
}

function resolveUnscopedProfile(
  legacyModel: string,
  mainProfiles: LegacyProfile[],
  source: string,
  explicitModelMaps: ReadonlyMap<string, string>,
): LegacyProfile {
  const raw = trim(legacyModel);
  if (emptyModel(raw)) {
    throw new Error(`${source} has no model to migrate.`);
  }
  const lower = raw.toLowerCase();

  const explicitSourceId = explicitModelMaps.get(raw);
  if (explicitSourceId) {
    const explicit = mainProfiles.find((profile) => profile.sourceId === explicitSourceId);
    if (!explicit) {
      throw new Error(
        `${source} maps ${legacyModel} to unavailable profile ${explicitSourceId}.`,
      );
    }
    return explicit;
  }

  const rawExact = mainProfiles.filter((profile) => profile.model === raw);
  const rawExactConnections = new Set(rawExact.map(connectionIdentity));
  if (rawExactConnections.size === 1 && rawExact[0]) return rawExact[0];
  if (rawExactConnections.size > 1) {
    throw new Error(
      `${source} model ${legacyModel} exactly matches multiple configured connections; add --model-map.`,
    );
  }

  const normalizedExact = mainProfiles.filter((profile) =>
    profile.transportModel === normalizeLegacyTransportModel(raw, profile.sourceId));
  const normalizedConnections = new Set(normalizedExact.map(connectionIdentity));
  if (normalizedConnections.size === 1 && normalizedExact[0]) return normalizedExact[0];
  if (normalizedConnections.size > 1) {
    throw new Error(
      `${source} model ${legacyModel} matches multiple configured connections; add --model-map.`,
    );
  }

  let preferredSource: string | null = null;
  if (lower.startsWith('siliconflow/') || lower.startsWith('pro/')) {
    preferredSource = 'main:siliconflow';
  } else if (lower.startsWith('deepseek/')) {
    preferredSource = 'main:deepseek';
  } else if (lower.startsWith('mimo/')) {
    preferredSource = 'main:mimo';
  } else if (lower.startsWith('github-copilot/') || lower === 'auto') {
    preferredSource = 'main:copilot';
  } else if (lower === 'openai/auto') {
    preferredSource = 'main:copilot';
  }
  if (preferredSource) {
    const preferred = mainProfiles.find((profile) => profile.sourceId === preferredSource);
    if (!preferred) {
      throw new Error(`${source} references ${legacyModel}, but ${preferredSource} is not configured.`);
    }
    return preferred;
  }

  throw new Error(
    `${source} references unknown or ambiguous model ${legacyModel}; add --model-map.`,
  );
}

function registerReferenceProfile(args: {
  profiles: LegacyProfile[];
  references: ModelReference[];
  baseProfile: LegacyProfile;
  legacyModel: string;
  source: string;
}): string {
  const normalizedLegacy = emptyModel(args.legacyModel)
    ? args.baseProfile.model
    : trim(args.legacyModel);
  const candidate = cloneProfileForReference(
    args.baseProfile,
    normalizedLegacy,
    args.source,
  );
  const existing = args.profiles.find((profile) => profile.sourceId === candidate.sourceId);
  if (!existing) args.profiles.push(candidate);
  args.references.push({
    source: args.source,
    legacyModel: normalizedLegacy,
    profileSourceId: candidate.sourceId,
  });
  return candidate.sourceId;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

function expandAgentDir(baseDir: string, path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith(`~${sep}`)) {
    return resolve(homedir(), path.slice(2));
  }
  if (
    path.startsWith('.agents/')
    || path.startsWith('.codex/')
    || path.startsWith('.claude/')
    || path.startsWith('.config/opencode/')
  ) {
    return resolve(homedir(), path);
  }
  return resolve(baseDir, path);
}

async function collectMarkdownFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Agent Markdown root must be a real directory: ${root}`);
  }
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Agent Markdown roots cannot contain symlinks: ${path}`);
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(resolve(path));
      }
    }
  };
  await visit(root);
  return files;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

const WEB_RUN_TOOL_NAME = 'web_run';
const REMOVED_WEB_TOOL_NAMES = new Set([
  'web_search',
  'web_browser',
  'web_fetch',
  'web_post',
]);

function removedWebToolName(value: string): boolean {
  return REMOVED_WEB_TOOL_NAMES.has(value) || value.startsWith('browser_');
}

function migrateWebToolReferences(value: unknown): void {
  if (Array.isArray(value)) {
    let hasWebRun = false;
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (typeof item === 'string' && removedWebToolName(item)) {
        value[index] = WEB_RUN_TOOL_NAME;
      } else {
        migrateWebToolReferences(item);
      }
    }
    for (let index = value.length - 1; index >= 0; index -= 1) {
      if (value[index] !== WEB_RUN_TOOL_NAME) continue;
      if (hasWebRun) value.splice(index, 1);
      hasWebRun = true;
    }
    return;
  }
  if (value == null || typeof value !== 'object') return;
  for (const child of Object.values(value as Record<string, unknown>)) {
    migrateWebToolReferences(child);
  }
}

function migrateWebRunAgentConfig(config: Record<string, unknown>): void {
  migrateWebToolReferences(config);
  if (config.tool == null) return;
  const tool = objectRecord(config.tool, 'Agent config tool');
  if (tool.items == null) return;
  const items = objectRecord(tool.items, 'Agent config tool.items');
  let migrated: Record<string, unknown> | null = null;
  for (const [name, rawItem] of Object.entries(items)) {
    if (!removedWebToolName(name)) continue;
    migrated ??= {
      ...objectRecord(rawItem, `Agent config tool.items.${name}`),
      enabled: true,
      main: true,
    };
    delete items[name];
  }
  if (migrated && items[WEB_RUN_TOOL_NAME] == null) {
    items[WEB_RUN_TOOL_NAME] = migrated;
  }
}

function migrateWebRunSkillContent(content: string): string {
  let migrated = content.replace(
    /\b(?:web_search|web_browser|web_fetch|web_post|browser_[a-z0-9_]+)\b/gu,
    WEB_RUN_TOOL_NAME,
  );
  let previous: string;
  do {
    previous = migrated;
    migrated = migrated.replace(
      /`web_run`(?:,\s*(?:and\s+)?|\s+and\s+)`web_run`/gu,
      '`web_run`',
    );
  } while (migrated !== previous);
  return migrated.replace(
    /^(\s*(?:allow|deny):\s*)\[(?:\s*web_run\s*,?)+\]\s*$/gmu,
    '$1[web_run]',
  );
}

interface MergedAgentFile {
  relativePath: string;
  content: Buffer;
  mode: number;
  sourcePaths: string[];
}

interface AgentDataInput {
  pending: PendingAgentFile[];
  sourceFiles: AgentSourceFile[];
  mergedFiles: MergedAgentFile[];
  directories: string[];
  idMappings: AgentIdMapping[];
}

const CANONICAL_AGENT_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$/u;
const BUILTIN_AGENT_KEYS = new Set(['plan', 'general', 'explore']);

function createAgentHashId(path: string): string {
  return createHash('sha1').update(resolve(path)).digest('hex').slice(0, 16);
}

function createPresetAgentId(displayName: string): string {
  const normalized = displayName.normalize('NFKC').trim();
  if (!normalized) {
    throw new Error('Preset Agent display name must not be empty.');
  }
  const slugValue = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return `preset:${slugValue || createAgentHashId(normalized)}`;
}

function assertCanonicalAgentId(id: string, label: string): void {
  if (!CANONICAL_AGENT_ID_PATTERN.test(id)) {
    throw new Error(`${label} has invalid canonical Agent ID ${id}.`);
  }
}

async function collectManagedAgentTree(args: {
  root: string;
  logicalPrefix: 'agents' | 'skills' | 'computer';
  merged: Map<string, MergedAgentFile>;
  directories: Set<string>;
  sourceFiles: AgentSourceFile[];
}): Promise<void> {
  if (!(await pathExists(args.root))) return;
  const rootInfo = await lstat(args.root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Agent data source must be a real directory: ${args.root}`);
  }
  args.directories.add(args.logicalPrefix);
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const sourcePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Agent data sources cannot contain symlinks: ${sourcePath}`);
      }
      const relativePath = relativeDirectory
        ? join(relativeDirectory, entry.name)
        : entry.name;
      const logicalPath = join(args.logicalPrefix, relativePath);
      if (entry.isDirectory()) {
        args.directories.add(logicalPath);
        await visit(sourcePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Agent data source contains an unsupported artifact: ${sourcePath}`);
      }
      const [content, info] = await Promise.all([
        readFile(sourcePath),
        lstat(sourcePath),
      ]);
      args.sourceFiles.push({ path: sourcePath, content });
      const existing = args.merged.get(logicalPath);
      if (existing) {
        if (!existing.content.equals(content)) {
          throw new Error(
            `Conflicting Agent data artifact ${logicalPath}: ${
              [...existing.sourcePaths, sourcePath].join(', ')
            }`,
          );
        }
        existing.sourcePaths.push(sourcePath);
        continue;
      }
      args.merged.set(logicalPath, {
        relativePath: logicalPath,
        content,
        mode: info.mode & 0o777,
        sourcePaths: [sourcePath],
      });
    }
  };
  await visit(args.root, '');
}

async function mergeLogicalAgentFile(args: {
  sourcePath: string;
  logicalPath: string;
  merged: Map<string, MergedAgentFile>;
  directories: Set<string>;
  sourceFiles: AgentSourceFile[];
}): Promise<void> {
  if (!(await pathExists(args.sourcePath))) return;
  const info = await lstat(args.sourcePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Agent data source must be a regular file: ${args.sourcePath}`);
  }
  const content = await readFile(args.sourcePath);
  args.sourceFiles.push({ path: args.sourcePath, content });
  args.directories.add(dirname(args.logicalPath));
  const existing = args.merged.get(args.logicalPath);
  if (existing) {
    if (!existing.content.equals(content)) {
      throw new Error(
        `Conflicting Agent data artifact ${args.logicalPath}: ${
          [...existing.sourcePaths, args.sourcePath].join(', ')
        }`,
      );
    }
    existing.sourcePaths.push(args.sourcePath);
    return;
  }
  args.merged.set(args.logicalPath, {
    relativePath: args.logicalPath,
    content,
    mode: info.mode & 0o777,
    sourcePaths: [args.sourcePath],
  });
}

function registerAgentIdMapping(args: {
  mappings: AgentIdMapping[];
  oldToCanonical: Map<string, string>;
  canonicalOwners: Map<string, string>;
  source: AgentIdMapping['source'];
  oldAgentId: string;
  canonicalAgentId: string;
  artifactPath: string;
  logicalOwner: string;
}): void {
  assertCanonicalAgentId(args.canonicalAgentId, args.artifactPath);
  const existingTarget = args.oldToCanonical.get(args.oldAgentId);
  if (existingTarget && existingTarget !== args.canonicalAgentId) {
    throw new Error(
      `Agent ID ${args.oldAgentId} maps to both ${existingTarget} and ${args.canonicalAgentId}.`,
    );
  }
  const existingOwner = args.canonicalOwners.get(args.canonicalAgentId);
  if (existingOwner && existingOwner !== args.logicalOwner) {
    throw new Error(
      `Canonical Agent ID collision ${args.canonicalAgentId}: ${existingOwner} and ${args.logicalOwner}.`,
    );
  }
  args.oldToCanonical.set(args.oldAgentId, args.canonicalAgentId);
  args.canonicalOwners.set(args.canonicalAgentId, args.logicalOwner);
  if (!args.mappings.some((mapping) =>
    mapping.source === args.source
    && mapping.oldAgentId === args.oldAgentId
    && mapping.canonicalAgentId === args.canonicalAgentId
    && mapping.artifactPath === args.artifactPath)) {
    args.mappings.push({
      source: args.source,
      oldAgentId: args.oldAgentId,
      canonicalAgentId: args.canonicalAgentId,
      artifactPath: args.artifactPath,
    });
  }
}

function rewriteAgentCollection(
  subAgent: Record<string, unknown>,
  section: 'items' | 'presetAgents',
  entries: Array<[string, Record<string, unknown>]>,
): void {
  subAgent[section] = Object.fromEntries(entries);
}

async function readAgentDataInput(args: {
  agentDataRoot: string;
  legacyAgentRoot: string | null;
  explicitDirs: string[];
  mainProfiles: LegacyProfile[];
  profiles: LegacyProfile[];
  references: ModelReference[];
  explicitModelMaps: ReadonlyMap<string, string>;
}): Promise<AgentDataInput> {
  const merged = new Map<string, MergedAgentFile>();
  const directories = new Set<string>(['agents', 'skills', 'computer']);
  const sourceFiles: AgentSourceFile[] = [];
  await collectManagedAgentTree({
    root: join(args.agentDataRoot, 'agents'),
    logicalPrefix: 'agents',
    merged,
    directories,
    sourceFiles,
  });
  await collectManagedAgentTree({
    root: join(args.agentDataRoot, 'skills'),
    logicalPrefix: 'skills',
    merged,
    directories,
    sourceFiles,
  });
  await collectManagedAgentTree({
    root: join(args.agentDataRoot, 'computer'),
    logicalPrefix: 'computer',
    merged,
    directories,
    sourceFiles,
  });
  if (args.legacyAgentRoot && await pathExists(args.legacyAgentRoot)) {
    const info = await lstat(args.legacyAgentRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(
        `Legacy Agent root must be a real directory: ${args.legacyAgentRoot}`,
      );
    }
    await mergeLogicalAgentFile({
      sourcePath: join(args.legacyAgentRoot, 'config.json'),
      logicalPath: join('agents', 'config.json'),
      merged,
      directories,
      sourceFiles,
    });
    for (const logicalPrefix of ['agents', 'skills', 'computer'] as const) {
      await collectManagedAgentTree({
        root: join(args.legacyAgentRoot, logicalPrefix),
        logicalPrefix,
        merged,
        directories,
        sourceFiles,
      });
    }
  }

  const pending: PendingAgentFile[] = [];
  const idMappings: AgentIdMapping[] = [];
  const oldToCanonical = new Map<string, string>();
  const canonicalOwners = new Map<string, string>();
  const targetConfigPath = join(args.agentDataRoot, 'agents/config.json');
  const mergedConfig = merged.get(join('agents', 'config.json'));
  let config: Record<string, unknown> = {};
  if (mergedConfig) {
    const content = mergedConfig.content.toString('utf8');
    try {
      config = objectRecord(JSON.parse(content), `Agent config ${targetConfigPath}`);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Agent config is not valid JSON: ${targetConfigPath}`);
      }
      throw error;
    }
    migrateWebRunAgentConfig(config);
  }

  const webRunSkill = merged.get(
    join('skills', 'sub-agent-creator', 'SKILL.md'),
  );
  const migratedWebRunSkill = webRunSkill == null
    ? null
    : migrateWebRunSkillContent(webRunSkill.content.toString('utf8'));
  if (
    webRunSkill
    && migratedWebRunSkill != null
    && migratedWebRunSkill !== webRunSkill.content.toString('utf8')
  ) {
    pending.push({
      path: resolve(args.agentDataRoot, webRunSkill.relativePath),
      kind: 'markdown',
      content: migratedWebRunSkill,
      entries: [],
    });
  }

  const managedMarkdown = [...merged.values()]
    .filter((file) =>
      file.relativePath.startsWith(`agents${sep}`)
      && file.relativePath.toLowerCase().endsWith('.md'))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const markdownFiles = new Map<string, {
    content: string;
    targetPath: string;
    sourcePaths: string[];
    canonicalAgentId: string;
  }>();
  for (const file of managedMarkdown) {
    const targetPath = resolve(args.agentDataRoot, file.relativePath);
    const canonicalAgentId = createAgentHashId(targetPath);
    const logicalOwner = `markdown:${file.relativePath}`;
    registerAgentIdMapping({
      mappings: idMappings,
      oldToCanonical,
      canonicalOwners,
      source: 'markdown',
      oldAgentId: canonicalAgentId,
      canonicalAgentId,
      artifactPath: targetPath,
      logicalOwner,
    });
    for (const sourcePath of file.sourcePaths) {
      registerAgentIdMapping({
        mappings: idMappings,
        oldToCanonical,
        canonicalOwners,
        source: 'markdown',
        oldAgentId: createAgentHashId(sourcePath),
        canonicalAgentId,
        artifactPath: sourcePath,
        logicalOwner,
      });
    }
    markdownFiles.set(targetPath, {
      content: file.content.toString('utf8'),
      targetPath,
      sourcePaths: file.sourcePaths,
      canonicalAgentId,
    });
  }

  const configDir = dirname(targetConfigPath);
  const configuredDirs = config.subAgent == null
    ? []
    : (() => {
        const subAgent = objectRecord(config.subAgent, 'Agent config subAgent');
        if (subAgent.dirs == null) return [];
        if (!Array.isArray(subAgent.dirs) || subAgent.dirs.some((item) => typeof item !== 'string')) {
          throw new Error('Agent config subAgent.dirs must be an array of paths.');
        }
        return subAgent.dirs as string[];
      })();
  const roots = [
    ...configuredDirs.map((path) => expandAgentDir(configDir, path)),
    ...args.explicitDirs,
  ];
  const seenRoots = new Set<string>();
  const externalFiles = new Set<string>();
  for (const root of roots) {
    const normalized = resolve(root);
    if (isSameOrAncestor(resolve(args.agentDataRoot, 'agents'), normalized)) {
      continue;
    }
    if (seenRoots.has(normalized)) continue;
    seenRoots.add(normalized);
    for (const file of await collectMarkdownFiles(normalized)) {
      externalFiles.add(file);
    }
  }

  for (const path of [...externalFiles].sort()) {
    const content = await readFile(path, 'utf8');
    sourceFiles.push({ path, content: Buffer.from(content, 'utf8') });
    const canonicalAgentId = createAgentHashId(path);
    registerAgentIdMapping({
      mappings: idMappings,
      oldToCanonical,
      canonicalOwners,
      source: 'markdown',
      oldAgentId: canonicalAgentId,
      canonicalAgentId,
      artifactPath: path,
      logicalOwner: `markdown:${path}`,
    });
    markdownFiles.set(path, {
      content,
      targetPath: path,
      sourcePaths: [path],
      canonicalAgentId,
    });
  }

  const configEntries: PendingAgentFile['entries'] = [];
  if (mergedConfig) {
    const subAgent = config.subAgent == null
      ? null
      : objectRecord(config.subAgent, 'Agent config subAgent');
    const itemCollection = subAgent?.items == null
      ? {}
      : objectRecord(subAgent.items, 'Agent config subAgent.items');
    const rewrittenItems: Array<[string, Record<string, unknown>]> = [];
    const seenItemIds = new Set<string>();
    for (const [oldAgentId, rawItem] of Object.entries(itemCollection)) {
      const item = objectRecord(
        rawItem,
        `Agent config subAgent.items.${oldAgentId}`,
      );
      const canonicalAgentId = oldToCanonical.get(oldAgentId);
      if (!canonicalAgentId) {
        throw new Error(
          `Agent config override ${oldAgentId} cannot be associated with a scanned Markdown Agent.`,
        );
      }
      if (seenItemIds.has(canonicalAgentId)) {
        throw new Error(
          `Agent config overrides collide at canonical ID ${canonicalAgentId}.`,
        );
      }
      seenItemIds.add(canonicalAgentId);
      rewrittenItems.push([canonicalAgentId, item]);
      if (Object.prototype.hasOwnProperty.call(item, 'model')) {
        if (typeof item.model !== 'string') {
          throw new Error(
            `Agent config subAgent.items.${oldAgentId}.model must be text.`,
          );
        }
        configEntries.push({
          agentId: canonicalAgentId,
          legacyModel: trim(item.model),
          profileSourceId: null,
          jsonPath: ['subAgent', 'items', canonicalAgentId],
        });
      }
    }
    if (subAgent) rewriteAgentCollection(subAgent, 'items', rewrittenItems);

    const builtinCollection = subAgent?.builtin == null
      ? {}
      : objectRecord(subAgent.builtin, 'Agent config subAgent.builtin');
    for (const [key, rawItem] of Object.entries(builtinCollection)) {
      if (!BUILTIN_AGENT_KEYS.has(key)) {
        throw new Error(`Unknown builtin Agent config key: ${key}`);
      }
      const item = objectRecord(rawItem, `Agent config subAgent.builtin.${key}`);
      const canonicalAgentId = `builtin:${key}`;
      registerAgentIdMapping({
        mappings: idMappings,
        oldToCanonical,
        canonicalOwners,
        source: 'builtin',
        oldAgentId: canonicalAgentId,
        canonicalAgentId,
        artifactPath: targetConfigPath,
        logicalOwner: canonicalAgentId,
      });
      if (Object.prototype.hasOwnProperty.call(item, 'model')) {
        if (typeof item.model !== 'string') {
          throw new Error(
            `Agent config subAgent.builtin.${key}.model must be text.`,
          );
        }
        configEntries.push({
          agentId: canonicalAgentId,
          legacyModel: trim(item.model),
          profileSourceId: null,
          jsonPath: ['subAgent', 'builtin', key],
        });
      }
    }

    const presetCollection = subAgent?.presetAgents == null
      ? {}
      : objectRecord(subAgent.presetAgents, 'Agent config subAgent.presetAgents');
    const rewrittenPresets: Array<[string, Record<string, unknown>]> = [];
    const seenPresetIds = new Set<string>();
    for (const [legacyKey, rawItem] of Object.entries(presetCollection)) {
      const item = objectRecord(
        rawItem,
        `Agent config subAgent.presetAgents.${legacyKey}`,
      );
      const displayName = typeof item.name === 'string' && item.name.trim()
        ? item.name
        : legacyKey;
      const oldAgentId = legacyKey.startsWith('preset:')
        ? legacyKey
        : `preset:${legacyKey}`;
      const canonicalAgentId = legacyKey.startsWith('preset:')
        ? legacyKey
        : createPresetAgentId(displayName);
      if (
        !canonicalAgentId.startsWith('preset:')
        || canonicalAgentId === 'preset:'
      ) {
        throw new Error(`Invalid preset Agent ID: ${canonicalAgentId}`);
      }
      if (seenPresetIds.has(canonicalAgentId)) {
        throw new Error(
          `Preset Agents collide at canonical ID ${canonicalAgentId}.`,
        );
      }
      seenPresetIds.add(canonicalAgentId);
      registerAgentIdMapping({
        mappings: idMappings,
        oldToCanonical,
        canonicalOwners,
        source: 'preset',
        oldAgentId,
        canonicalAgentId,
        artifactPath: targetConfigPath,
        logicalOwner: `preset:${legacyKey}`,
      });
      rewrittenPresets.push([canonicalAgentId, item]);
      if (Object.prototype.hasOwnProperty.call(item, 'model')) {
        if (typeof item.model !== 'string') {
          throw new Error(
            `Agent config subAgent.presetAgents.${legacyKey}.model must be text.`,
          );
        }
        configEntries.push({
          agentId: canonicalAgentId,
          legacyModel: trim(item.model),
          profileSourceId: null,
          jsonPath: ['subAgent', 'presetAgents', canonicalAgentId],
        });
      }
    }
    if (subAgent) rewriteAgentCollection(subAgent, 'presetAgents', rewrittenPresets);
  }

  for (const entry of configEntries) {
    if (!emptyModel(entry.legacyModel)) {
      const baseProfile = resolveUnscopedProfile(
        entry.legacyModel,
        args.mainProfiles,
        `Agent ${entry.agentId}`,
        args.explicitModelMaps,
      );
      entry.profileSourceId = registerReferenceProfile({
        profiles: args.profiles,
        references: args.references,
        baseProfile,
        legacyModel: entry.legacyModel,
        source: `agent-json:${entry.agentId}`,
      });
    }
  }
  if (mergedConfig) {
    pending.push({
      path: targetConfigPath,
      kind: 'json',
      content: `${JSON.stringify(config, null, 2)}\n`,
      entries: configEntries,
    });
  }

  for (const file of [...markdownFiles.values()].sort((left, right) =>
    left.targetPath.localeCompare(right.targetPath))) {
    const path = file.targetPath;
    const content = file.content;
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?([\s\S]*)$/u);
    if (!match) continue;
    const document = YAML.parseDocument(match[1]);
    if (document.errors.length > 0) {
      throw new Error(`Agent Markdown frontmatter is invalid: ${path}`);
    }
    const value = document.toJS() as unknown;
    const frontmatter = value == null ? {} : objectRecord(value, `Agent Markdown ${path}`);
    if (!Object.prototype.hasOwnProperty.call(frontmatter, 'model')) continue;
    if (typeof frontmatter.model !== 'string') {
      throw new Error(`Agent Markdown model must be text: ${path}`);
    }
    const legacyModel = trim(frontmatter.model);
    const agentId = file.canonicalAgentId;
    let profileSourceId: string | null = null;
    if (!emptyModel(legacyModel)) {
      const baseProfile = resolveUnscopedProfile(
        legacyModel,
        args.mainProfiles,
        `Agent ${agentId}`,
        args.explicitModelMaps,
      );
      profileSourceId = registerReferenceProfile({
        profiles: args.profiles,
        references: args.references,
        baseProfile,
        legacyModel,
        source: `agent-markdown:${agentId}`,
      });
    }
    pending.push({
      path,
      kind: 'markdown',
      content,
      entries: [{
        agentId,
        legacyModel,
        profileSourceId,
      }],
    });
  }
  return {
    pending,
    sourceFiles: sourceFiles.sort((left, right) => left.path.localeCompare(right.path)),
    mergedFiles: [...merged.values()].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)),
    directories: [...directories].sort(),
    idMappings: idMappings.sort((left, right) =>
      left.canonicalAgentId.localeCompare(right.canonicalAgentId)
      || left.oldAgentId.localeCompare(right.oldAgentId)
      || left.artifactPath.localeCompare(right.artifactPath)),
  };
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

async function assertTrustedArchivePath(
  archivePath: string,
  archiveRoot: string,
): Promise<string> {
  if (!isAbsolute(archivePath)) {
    throw new Error(`Recoverable archive path must be absolute: ${archivePath}`);
  }
  const rootInfo = await lstat(archiveRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Archive root must be a real directory: ${archiveRoot}`);
  }
  const resolvedRoot = resolve(archiveRoot);
  const resolvedPath = resolve(archivePath);
  const canonicalRoot = await realpath(resolvedRoot);
  const canonicalPath = await realpath(resolvedPath);
  if (canonicalRoot !== resolvedRoot || canonicalPath !== resolvedPath) {
    throw new Error(`Recoverable archive path cannot contain symlinks: ${archivePath}`);
  }
  if (!isSameOrAncestor(canonicalRoot, canonicalPath) || canonicalRoot === canonicalPath) {
    throw new Error(`Recoverable archive escapes the trusted root: ${archivePath}`);
  }
  const pathInfo = await lstat(canonicalPath);
  if (pathInfo.isSymbolicLink()) {
    throw new Error(`Recoverable archive cannot be a symlink: ${archivePath}`);
  }
  return canonicalPath;
}

async function hashArchiveArtifact(path: string, format: ArchiveChange['format']): Promise<string> {
  const hash = createHash('sha256');
  if (format === 'gzip') {
    hash.update(await readFile(path));
    return hash.digest('hex');
  }
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const itemPath = join(directory, entry.name);
      const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`Recoverable archive cannot contain symlinks: ${itemPath}`);
      }
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}:${relativeName}\0`);
      if (entry.isDirectory()) {
        await visit(itemPath, relativeName);
      } else if (entry.isFile()) {
        hash.update(await readFile(itemPath));
      } else {
        throw new Error(`Unsupported archive entry: ${itemPath}`);
      }
    }
  };
  await visit(path, '');
  return hash.digest('hex');
}

async function readPendingArchives(args: {
  rows: DatabaseSnapshot['archiveRows'];
  archiveRoot: string | null;
  activeProfile: LegacyProfile;
  mainProfiles: LegacyProfile[];
  profiles: LegacyProfile[];
  references: ModelReference[];
  explicitModelMaps: ReadonlyMap<string, string>;
}): Promise<PendingArchive[]> {
  const recoverable = args.rows.filter((row) => row.state !== 'broken');
  if (recoverable.length === 0) return [];
  if (!args.archiveRoot) {
    throw new Error('--archive-root is required when recoverable archives exist.');
  }
  const pending: PendingArchive[] = [];
  const seenPaths = new Set<string>();
  for (const row of recoverable) {
    if (row.state !== 'ready') {
      throw new Error(`Recoverable archive ${row.id} is not stable: ${row.state}`);
    }
    if (!ARCHIVE_ID_PATTERN.test(row.id)) {
      throw new Error(`Archive ID is unsafe for migration: ${row.id}`);
    }
    const archivePath = await assertTrustedArchivePath(row.path, args.archiveRoot);
    if (seenPaths.has(archivePath)) {
      throw new Error(`Recoverable archives share one artifact path: ${archivePath}`);
    }
    seenPaths.add(archivePath);
    const info = await lstat(archivePath);
    const format: ArchiveChange['format'] = info.isDirectory()
      ? 'directory'
      : info.isFile() && archivePath.toLowerCase().endsWith('.gz')
        ? 'gzip'
        : (() => {
            throw new Error(`Unsupported recoverable archive artifact: ${archivePath}`);
          })();
    const contentPath = format === 'directory'
      ? join(archivePath, 'conversation.json')
      : archivePath;
    let payload: Record<string, unknown>;
    let conversation: Record<string, unknown>;
    if (format === 'directory') {
      const contentInfo = await lstat(contentPath);
      if (!contentInfo.isFile() || contentInfo.isSymbolicLink()) {
        throw new Error(`Archive conversation must be a regular file: ${contentPath}`);
      }
      try {
        conversation = objectRecord(
          JSON.parse(await readFile(contentPath, 'utf8')),
          `archive(${row.id}).conversation`,
        );
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(`Archive conversation is not valid JSON: ${contentPath}`);
        }
        throw error;
      }
      payload = conversation;
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse((await gunzipAsync(await readFile(contentPath))).toString('utf8'));
      } catch (error) {
        throw new Error(
          `Gzip archive payload is invalid: ${contentPath} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      payload = objectRecord(parsed, `archive(${row.id})`);
      conversation = objectRecord(payload.conversation, `archive(${row.id}).conversation`);
    }
    const rawModel = conversation.model;
    if (rawModel != null && typeof rawModel !== 'string') {
      throw new Error(`archive(${row.id}).conversation.model must be text.`);
    }
    const legacyModel = trim(rawModel);
    const baseProfile = emptyModel(legacyModel)
      ? args.activeProfile
      : resolveUnscopedProfile(
          legacyModel,
          args.mainProfiles,
          `archive(${row.id})`,
          args.explicitModelMaps,
        );
    const profileSourceId = registerReferenceProfile({
      profiles: args.profiles,
      references: args.references,
      baseProfile,
      legacyModel: emptyModel(legacyModel) ? args.activeProfile.model : legacyModel,
      source: `archive:${row.id}`,
    });
    pending.push({
      archiveId: row.id,
      format,
      archivePath,
      contentPath,
      sourceHash: await hashArchiveArtifact(archivePath, format),
      payload,
      conversation,
      legacyModel,
      profileSourceId,
    });
  }
  return pending;
}

function requireBuiltModel(
  catalog: ReturnType<typeof buildCanonicalCatalog>,
  profileSourceId: string,
): BuiltModelRecord {
  const record = catalog.byProfileSourceId.get(profileSourceId);
  if (!record) throw new Error(`Canonical model missing for profile ${profileSourceId}.`);
  return record;
}

function dedicatedBinding(
  workload: ModelWorkload,
  record: BuiltModelRecord,
): ModelBinding {
  return {
    workload,
    mode: 'dedicated',
    connectionId: record.connectionId,
    modelId: record.modelId,
  };
}

function addBinding(
  bindings: Map<string, ModelBinding>,
  binding: ModelBinding,
): void {
  const existing = bindings.get(binding.workload);
  if (!existing) {
    bindings.set(binding.workload, binding);
    return;
  }
  if (JSON.stringify(existing) !== JSON.stringify(binding)) {
    throw new Error(`Conflicting canonical bindings for ${binding.workload}.`);
  }
}

function buildModelMappings(
  references: ModelReference[],
  catalog: ReturnType<typeof buildCanonicalCatalog>,
): ModelConfigMigrationReport['modelMappings'] {
  const grouped = new Map<string, {
    targets: Set<string>;
    sources: Set<string>;
  }>();
  for (const reference of references) {
    const canonical = canonicalForRecord(
      requireBuiltModel(catalog, reference.profileSourceId),
    );
    const entry = grouped.get(reference.legacyModel) ?? {
      targets: new Set<string>(),
      sources: new Set<string>(),
    };
    entry.targets.add(canonical);
    entry.sources.add(reference.source);
    grouped.set(reference.legacyModel, entry);
  }
  const result: ModelConfigMigrationReport['modelMappings'] = [];
  for (const [legacyModel, entry] of [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right))) {
    if (entry.targets.size !== 1) {
      const targets = [...entry.targets].sort().join(', ');
      const sources = [...entry.sources].sort().join(', ');
      throw new Error(
        `Legacy model ${legacyModel} resolves to multiple canonical model identities: ${targets}; sources: ${sources}.`,
      );
    }
    result.push({
      legacyModel,
      canonicalModel: [...entry.targets][0],
      sources: [...entry.sources].sort(),
    });
  }
  return result;
}

function buildDatabasePlan(
  snapshot: DatabaseSnapshot,
  profileSourcesByDatabaseRow: Map<string, string>,
  catalog: ReturnType<typeof buildCanonicalCatalog>,
): DatabasePlan {
  const valueChanges: DatabaseValueChange[] = [];
  const canonicalConversationModels = new Map<string, string>();
  for (const row of snapshot.modelRows) {
    const key = `${row.table}:${row.rowId}`;
    const profileSourceId = profileSourcesByDatabaseRow.get(key);
    if (!profileSourceId) throw new Error(`Database model plan missing for ${key}.`);
    const after = canonicalForRecord(requireBuiltModel(catalog, profileSourceId));
    if (row.table === 'chatluna_conversation') {
      canonicalConversationModels.set(row.identity, after);
    }
    if (row.model === after) {
      throw new Error(
        `${row.table}(${row.identity}) already contains canonical model syntax before cutover.`,
      );
    }
    valueChanges.push({
      table: row.table,
      rowId: row.rowId,
      identity: row.identity,
      column: 'model',
      before: row.model,
      after,
    });
  }

  const automationReferences: AutomationReference[] = [];
  for (const job of snapshot.automationJobs) {
    if (job.status === 'deleted') continue;
    const sourceConversationId = job.sourceConversationId?.trim();
    if (!sourceConversationId) {
      throw new Error(
        `automation_job(${job.jobId}) has no sourceConversationId.`,
      );
    }
    const conversation = snapshot.conversationModels.get(sourceConversationId);
    if (!conversation) {
      throw new Error(
        `automation_job(${job.jobId}) references missing source conversation ${sourceConversationId}.`,
      );
    }
    const canonicalModel = canonicalConversationModels.get(sourceConversationId);
    if (!canonicalModel) {
      throw new Error(
        `automation_job(${job.jobId}) source conversation has no canonical model plan.`,
      );
    }
    automationReferences.push({
      jobId: job.jobId,
      sourceRoomId: job.sourceRoomId,
      sourceConversationId,
      conversationModel: conversation.model ?? '',
      canonicalModel,
    });
  }
  return {
    valueChanges,
    affinityDeletes: snapshot.affinityRows,
    automationReferences,
  };
}

function deleteJsonAgentModel(
  root: Record<string, unknown>,
  path: NonNullable<PendingAgentFile['entries'][number]['jsonPath']>,
): void {
  const subAgent = objectRecord(root[path[0]], 'Agent config subAgent');
  const section = objectRecord(subAgent[path[1]], `Agent config subAgent.${path[1]}`);
  const item = objectRecord(
    section[path[2]],
    `Agent config subAgent.${path[1]}.${path[2]}`,
  );
  delete item.model;
}

function buildAgentChanges(
  pending: PendingAgentFile[],
  catalog: ReturnType<typeof buildCanonicalCatalog>,
): {
  files: AgentFileChange[];
  bindings: ModelBinding[];
} {
  const files: AgentFileChange[] = [];
  const effectiveEntries = new Map<string, {
    priority: number;
    binding: ModelBinding | null;
    source: string;
  }>();

  for (const file of pending) {
    const removed: AgentFileChange['removed'] = [];
    let nextContent: string;
    if (file.kind === 'json') {
      const parsed = objectRecord(JSON.parse(file.content), `Agent config ${file.path}`);
      for (const entry of file.entries) {
        if (!entry.jsonPath) throw new Error(`Agent JSON path missing for ${entry.agentId}.`);
        deleteJsonAgentModel(parsed, entry.jsonPath);
        const canonicalModel = entry.profileSourceId
          ? canonicalForRecord(requireBuiltModel(catalog, entry.profileSourceId))
          : '';
        removed.push({
          agentId: entry.agentId,
          legacyModel: entry.legacyModel,
          canonicalModel,
        });
        const binding = entry.profileSourceId
          ? dedicatedBinding(
              `agent.subagent.${entry.agentId}`,
              requireBuiltModel(catalog, entry.profileSourceId),
            )
          : null;
        const existing = effectiveEntries.get(entry.agentId);
        if (
          existing?.priority === 2
          && JSON.stringify(existing.binding) !== JSON.stringify(binding)
        ) {
          throw new Error(
            `Agent ${entry.agentId} has conflicting JSON model fields in ${existing.source} and ${file.path}.`,
          );
        }
        effectiveEntries.set(entry.agentId, {
          priority: 2,
          binding,
          source: `Agent JSON ${file.path}`,
        });
      }
      nextContent = `${JSON.stringify(parsed, null, 2)}\n`;
    } else {
      const match = file.content.match(
        /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?([\s\S]*)$/u,
      );
      if (!match) throw new Error(`Agent Markdown lost its frontmatter: ${file.path}`);
      const document = YAML.parseDocument(match[1]);
      document.delete('model');
      const body = match[2];
      nextContent = `---\n${String(document).trimEnd()}\n---\n${body}`;
      if (!nextContent.endsWith('\n')) nextContent += '\n';
      for (const entry of file.entries) {
        const canonicalModel = entry.profileSourceId
          ? canonicalForRecord(requireBuiltModel(catalog, entry.profileSourceId))
          : '';
        removed.push({
          agentId: entry.agentId,
          legacyModel: entry.legacyModel,
          canonicalModel,
        });
        const binding = entry.profileSourceId
          ? dedicatedBinding(
              `agent.subagent.${entry.agentId}`,
              requireBuiltModel(catalog, entry.profileSourceId),
            )
          : null;
        const existing = effectiveEntries.get(entry.agentId);
        if (!existing || existing.priority < 1) {
          effectiveEntries.set(entry.agentId, {
            priority: 1,
            binding,
            source: `Agent Markdown ${file.path}`,
          });
        } else if (
          existing.priority === 1
          && JSON.stringify(existing.binding) !== JSON.stringify(binding)
        ) {
          throw new Error(
            `Agent ${entry.agentId} has conflicting Markdown model fields in ${existing.source} and ${file.path}.`,
          );
        }
      }
    }
    files.push({
      path: file.path,
      kind: file.kind,
      nextContent,
      removed,
    });
  }

  return {
    files,
    bindings: [...effectiveEntries.values()]
      .flatMap((entry) => entry.binding ? [entry.binding] : [])
      .sort((left, right) => left.workload.localeCompare(right.workload)),
  };
}

async function buildArchiveChanges(
  pending: PendingArchive[],
  catalog: ReturnType<typeof buildCanonicalCatalog>,
): Promise<ArchiveChange[]> {
  const changes: ArchiveChange[] = [];
  for (const archive of pending) {
    const canonicalModel = canonicalForRecord(
      requireBuiltModel(catalog, archive.profileSourceId),
    );
    const nextConversation = structuredClone(archive.conversation);
    nextConversation.model = canonicalModel;
    let nextContent: Buffer;
    if (archive.format === 'directory') {
      nextContent = Buffer.from(`${JSON.stringify(nextConversation, null, 2)}\n`, 'utf8');
    } else {
      const nextPayload = structuredClone(archive.payload);
      nextPayload.conversation = nextConversation;
      nextContent = await gzipAsync(
        Buffer.from(`${JSON.stringify(nextPayload, null, 2)}\n`, 'utf8'),
      );
    }
    changes.push({
      archiveId: archive.archiveId,
      format: archive.format,
      archivePath: archive.archivePath,
      contentPath: archive.contentPath,
      sourceHash: archive.sourceHash,
      nextContent,
      legacyModel: archive.legacyModel,
      canonicalModel,
    });
  }
  return changes;
}

function reportHash(report: Omit<ModelConfigMigrationReport, 'reportHash'>): string {
  const stable = {
    ...report,
    command: 'preflight',
    dryRun: true,
    applied: false,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export async function buildModelConfigMigrationPlan(
  options: ModelConfigCutoverOptions,
): Promise<ModelConfigMigrationPlan> {
  await access(options.database);
  if (await pathExists(options.configOut)) {
    throw new Error(`Canonical model config already exists: ${options.configOut}`);
  }
  if (await pathExists(options.kekOut)) {
    throw new Error(`Canonical model KEK already exists: ${options.kekOut}`);
  }

  const layeredEnv = await readLayeredEnv(options.envFiles);
  const main = buildMainProfiles(layeredEnv.effective);
  const explicitModelMapInput = await loadExplicitModelMaps(options);
  const databaseSnapshot = readDatabaseSnapshot(options.database);
  const affinityValue = databaseSnapshot.affinityRows[0]?.value ?? null;
  const genericOpenAi = buildGenericOpenAiProfile(layeredEnv.effective);
  const memoryExtract = buildMemoryExtractProfile(layeredEnv.effective);
  const memoryEmbedding = buildMemoryEmbeddingProfile(layeredEnv.effective);
  const natural = buildNaturalProfile(layeredEnv.effective);
  const affinity = parseAffinityProfile(affinityValue);
  const sticker = buildStickerProfile(layeredEnv.effective);
  const automationIntent = buildAutomationIntentProfile(layeredEnv.effective);
  const resolvableProfiles = [
    ...main.profiles,
    ...[genericOpenAi].filter(
      (profile): profile is LegacyProfile => profile != null,
    ),
  ];
  const explicitModelMaps = validateExplicitModelMaps(
    explicitModelMapInput.entries,
    resolvableProfiles,
  );
  const explicitProfiles = [
    ...resolvableProfiles,
    ...[
      memoryExtract,
      memoryEmbedding,
      natural,
      affinity,
      sticker,
      automationIntent,
    ]
      .filter((profile): profile is LegacyProfile => profile != null),
  ];
  const legacyMaxContextRatio = parseLegacyContextRatio(
    layeredEnv.effective.CHATLUNA_MAX_CONTEXT_RATIO,
  );
  const contextBudget = applyLegacyContextBudget(
    explicitProfiles,
    legacyMaxContextRatio,
  );
  const profiles = [...explicitProfiles];
  const references: ModelReference[] = [];
  for (const profile of explicitProfiles) {
    references.push({
      source: `profile:${profile.sourceId}`,
      legacyModel: profile.model,
      profileSourceId: profile.sourceId,
    });
  }

  for (const key of [
    'TASK_AUTOMATION_CHAT_REPLY_MODEL',
    'TASK_AUTOMATION_DELIVERY_MODEL',
  ] as const) {
    const legacyModel = trim(layeredEnv.effective[key]);
    if (emptyModel(legacyModel)) continue;
    const baseProfile = resolveUnscopedProfile(
      legacyModel,
      resolvableProfiles,
      key,
      explicitModelMaps,
    );
    registerReferenceProfile({
      profiles,
      references,
      baseProfile,
      legacyModel,
      source: `legacy-env:${key}`,
    });
  }
  const automationIntentModel = trim(
    layeredEnv.effective.TASK_AUTOMATION_INTENT_MODEL,
  );
  if (!emptyModel(automationIntentModel)) {
    if (automationIntent) {
      references.push({
        source: 'legacy-env:TASK_AUTOMATION_INTENT_MODEL',
        legacyModel: automationIntentModel,
        profileSourceId:
          explicitModelMaps.get(automationIntentModel) ?? automationIntent.sourceId,
      });
    } else {
      const baseProfile = resolveUnscopedProfile(
        automationIntentModel,
        resolvableProfiles,
        'TASK_AUTOMATION_INTENT_MODEL',
        explicitModelMaps,
      );
      registerReferenceProfile({
        profiles,
        references,
        baseProfile,
        legacyModel: automationIntentModel,
        source: 'legacy-env:TASK_AUTOMATION_INTENT_MODEL',
      });
    }
  }

  const profileSourcesByDatabaseRow = new Map<string, string>();
  for (const row of databaseSnapshot.modelRows) {
    const legacyModel = emptyModel(row.model) ? main.activeProfile.model : trim(row.model);
    const baseProfile = emptyModel(row.model)
      ? main.activeProfile
      : resolveUnscopedProfile(
          legacyModel,
          resolvableProfiles,
          `${row.table}(${row.identity})`,
          explicitModelMaps,
        );
    const profileSourceId = registerReferenceProfile({
      profiles,
      references,
      baseProfile,
      legacyModel,
      source: `${row.table}:${row.identity}`,
    });
    profileSourcesByDatabaseRow.set(`${row.table}:${row.rowId}`, profileSourceId);
  }

  const agentInput = await readAgentDataInput({
    agentDataRoot: options.agentDataRoot,
    legacyAgentRoot: options.legacyAgentRoot,
    explicitDirs: options.agentDirs,
    mainProfiles: resolvableProfiles,
    profiles,
    references,
    explicitModelMaps,
  });
  const pendingArchives = await readPendingArchives({
    rows: databaseSnapshot.archiveRows,
    archiveRoot: options.archiveRoot,
    activeProfile: main.activeProfile,
    mainProfiles: resolvableProfiles,
    profiles,
    references,
    explicitModelMaps,
  });
  const catalog = buildCanonicalCatalog(profiles);
  const mappings = buildModelMappings(references, catalog);
  const database = buildDatabasePlan(
    databaseSnapshot,
    profileSourcesByDatabaseRow,
    catalog,
  );
  const agentChanges = buildAgentChanges(agentInput.pending, catalog);
  const changesByPath = new Map(
    agentChanges.files.map((file) => [resolve(file.path), file] as const),
  );
  const agentTargetFiles: AgentTargetFile[] = agentInput.mergedFiles.map((file) => {
    const path = resolve(options.agentDataRoot, file.relativePath);
    const change = changesByPath.get(path);
    return {
      path,
      relativePath: file.relativePath,
      content: change
        ? Buffer.from(change.nextContent, 'utf8')
        : Buffer.from(file.content),
      mode: file.mode,
    };
  });
  const agentData: AgentDataPlan = {
    root: options.agentDataRoot,
    sourceFiles: agentInput.sourceFiles,
    targetFiles: agentTargetFiles,
    directories: agentInput.directories,
    files: agentChanges.files,
    idMappings: agentInput.idMappings,
    bindings: agentChanges.bindings,
  };
  const archiveChanges = await buildArchiveChanges(pendingArchives, catalog);

  const bindings = new Map<string, ModelBinding>();
  addBinding(
    bindings,
    dedicatedBinding('main.chat', requireBuiltModel(catalog, main.activeProfile.sourceId)),
  );
  addBinding(
    bindings,
    memoryExtract
      ? dedicatedBinding(
          'memory.extract',
          requireBuiltModel(catalog, memoryExtract.sourceId),
        )
      : { workload: 'memory.extract', mode: 'disabled' },
  );
  const embeddingBinding = memoryEmbedding
    ? dedicatedBinding(
        'memory.embedding',
        requireBuiltModel(catalog, memoryEmbedding.sourceId),
      )
    : { workload: 'memory.embedding' as const, mode: 'disabled' as const };
  addBinding(bindings, embeddingBinding);
  addBinding(
    bindings,
    memoryEmbedding
      ? dedicatedBinding(
          'chatluna.defaultEmbedding',
          requireBuiltModel(catalog, memoryEmbedding.sourceId),
        )
      : { workload: 'chatluna.defaultEmbedding', mode: 'disabled' },
  );
  addBinding(
    bindings,
    affinity
      ? dedicatedBinding(
          'affinity.analysis',
          requireBuiltModel(catalog, affinity.sourceId),
        )
      : { workload: 'affinity.analysis', mode: 'inheritMain' },
  );
  addBinding(
    bindings,
    natural
      ? dedicatedBinding(
          'naturalTrigger.decision',
          requireBuiltModel(catalog, natural.sourceId),
        )
      : { workload: 'naturalTrigger.decision', mode: 'disabled' },
  );
  addBinding(bindings, {
    workload: 'agent.subagent.default',
    mode: 'inheritInvocation',
  });
  addBinding(
    bindings,
    sticker
      ? dedicatedBinding(
          'sticker.index',
          requireBuiltModel(catalog, sticker.sourceId),
        )
      : { workload: 'sticker.index', mode: 'disabled' },
  );
  for (const binding of agentData.bindings) addBinding(bindings, binding);

  const draft = modelConfigDraftSchema.parse({
    connections: catalog.connections,
    models: catalog.models,
    bindings: [...bindings.values()].sort((left, right) =>
      left.workload.localeCompare(right.workload)),
  });

  const reportWithoutHash: Omit<ModelConfigMigrationReport, 'reportHash'> = {
    schemaVersion: 1,
    operation: 'legacy-model-config-to-canonical-v1',
    sourceVersion: SOURCE_VERSION,
    command: options.command,
    dryRun: options.command === 'preflight',
    applied: false,
    connections: catalog.connectionReports,
    models: draft.models,
    bindings: draft.bindings,
    modelMappings: mappings,
    envFiles: layeredEnv.files.map((file) => ({
      path: file.path,
      removedKeys: file.removedKeys,
    })),
    databaseChanges: database.valueChanges.map(({ rowId: _rowId, ...change }) => change),
    affinityDeletes: database.affinityDeletes.map(({ identity, key }) => ({
      identity,
      key,
    })),
    automationReferences: database.automationReferences,
    agentChanges: agentData.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      agents: file.removed,
    })),
    agentIdMappings: agentData.idMappings,
    archiveChanges: archiveChanges.map((change) => ({
      archiveId: change.archiveId,
      format: change.format,
      archivePath: change.archivePath,
      legacyModel: change.legacyModel,
      canonicalModel: change.canonicalModel,
      sourceHash: change.sourceHash,
    })),
    explicitModelMaps: explicitModelMapInput.entries.map((entry) => ({ ...entry })),
    contextBudget: {
      legacyMaxContextRatio,
      ...contextBudget,
    },
    summary: {
      connectionCount: draft.connections.length,
      modelCount: draft.models.length,
      bindingCount: draft.bindings.length,
      modelMappingCount: mappings.length,
      envFileCount: layeredEnv.files.length,
      databaseChangeCount: database.valueChanges.length,
      affinityDeleteCount: database.affinityDeletes.length,
      automationReferenceCount: database.automationReferences.length,
      agentFileChangeCount: agentData.files.length,
      agentIdMappingCount: agentData.idMappings.length,
      archiveChangeCount: archiveChanges.length,
      explicitModelMapCount: explicitModelMapInput.entries.length,
    },
  };
  const report: ModelConfigMigrationReport = {
    ...reportWithoutHash,
    reportHash: reportHash(reportWithoutHash),
  };
  return {
    draft,
    apiKeys: catalog.apiKeys,
    report,
    envFiles: layeredEnv.files,
    database,
    agentData,
    archiveChanges,
    modelMapFile: explicitModelMapInput.file,
  };
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
      throw new Error(`${unit} must be inactive before model config cutover (state=${state}).`);
    }
  }
}

async function assertNewRealDirectory(path: string): Promise<void> {
  if (await pathExists(path)) {
    throw new Error(`Cutover directory must not already exist: ${path}`);
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeNewFileDurable(
  path: string,
  content: string | Buffer,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    mode,
  );
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(dirname(path));
}

async function atomicReplaceFile(
  path: string,
  content: string | Buffer,
  mode: number,
): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.model-cutover.${process.pid}.${createHash('sha256')
      .update(path)
      .digest('hex')
      .slice(0, 8)}.tmp`,
  );
  if (await pathExists(temporary)) {
    throw new Error(`Stale model cutover staging file exists: ${temporary}`);
  }
  try {
    await writeNewFileDurable(temporary, content, mode);
    await rename(temporary, path);
    await fsyncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function backupArtifactName(path: string): string {
  const digest = createHash('sha256').update(resolve(path)).digest('hex').slice(0, 16);
  return `${digest}-${basename(path)}`;
}

interface FileBackup {
  target: string;
  backup: string;
  mode: number;
}

async function backupFile(
  target: string,
  directory: string,
): Promise<FileBackup> {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Cutover file must be a regular file: ${target}`);
  }
  const backupPath = join(directory, backupArtifactName(target));
  await copyFile(target, backupPath, constants.COPYFILE_EXCL);
  await chmod(backupPath, 0o600);
  return {
    target,
    backup: backupPath,
    mode: info.mode & 0o777,
  };
}

async function restoreFiles(backups: FileBackup[]): Promise<string[]> {
  const failures: string[] = [];
  for (const item of [...backups].reverse()) {
    try {
      await atomicReplaceFile(
        item.target,
        await readFile(item.backup),
        item.mode,
      );
    } catch (error) {
      failures.push(
        `${item.target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return failures;
}

function verifyAndApplyDatabasePlan(
  databasePath: string,
  plan: DatabasePlan,
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const change of plan.valueChanges) {
        const current = database.prepare(
          `select model from "${change.table}" where rowid = ?`,
        ).get(change.rowId) as { model?: unknown } | undefined;
        if (!current || (current.model ?? null) !== change.before) {
          throw new Error(
            `${change.table}(${change.identity}).model changed after preflight.`,
          );
        }
        const result = database.prepare(
          `update "${change.table}" set model = ? where rowid = ? and model is ?`,
        ).run(change.after, change.rowId, change.before);
        if (Number(result.changes) !== 1) {
          throw new Error(
            `${change.table}(${change.identity}).model update did not affect one row.`,
          );
        }
      }
      for (const deletion of plan.affinityDeletes) {
        const current = database.prepare(
          'select key, value from affinity_config where rowid = ?',
        ).get(deletion.rowId) as { key?: unknown; value?: unknown } | undefined;
        if (
          !current
          || current.key !== deletion.key
          || (current.value ?? null) !== deletion.value
        ) {
          throw new Error(
            `affinity_config(${deletion.identity}) changed after preflight.`,
          );
        }
        const result = database.prepare(
          'delete from affinity_config where rowid = ? and key = ? and value is ?',
        ).run(deletion.rowId, deletion.key, deletion.value);
        if (Number(result.changes) !== 1) {
          throw new Error(
            `affinity_config(${deletion.identity}) delete did not affect one row.`,
          );
        }
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}

async function stageCanonicalModelConfig(args: {
  options: ModelConfigCutoverOptions;
  plan: ModelConfigMigrationPlan;
  completedAt: string;
}): Promise<{
  config: string;
  kek: string;
}> {
  const config = join(
    dirname(args.options.configOut),
    `.${basename(args.options.configOut)}.model-cutover.${process.pid}.staging`,
  );
  const kek = join(
    dirname(args.options.kekOut),
    `.${basename(args.options.kekOut)}.model-cutover.${process.pid}.staging`,
  );
  if (await pathExists(config) || await pathExists(kek)) {
    throw new Error('Canonical model config staging artifacts already exist.');
  }
  const service = new ModelConfigService({
    configPath: config,
    kekPath: kek,
    now: () => new Date(args.completedAt),
  });
  const snapshot = await service.createInitial({
    draft: args.plan.draft,
    apiKeys: args.plan.apiKeys,
    migration: {
      completedAt: args.completedAt,
      sourceVersion: SOURCE_VERSION,
      reportHash: args.plan.report.reportHash,
    },
  });
  const document = modelConfigDocumentSchema.parse(
    JSON.parse(await readFile(config, 'utf8')),
  );
  for (const [connectionId, apiKey] of Object.entries(args.plan.apiKeys)) {
    const connection = snapshot.connections.find((item) => item.id === connectionId);
    if (!connection || connection.apiKey !== apiKey) {
      throw new Error(
        `Canonical model config staging failed credential verification for ${connectionId}.`,
      );
    }
  }
  await chmod(config, 0o600);
  await chmod(kek, 0o600);
  return { config, kek };
}

async function publishStagedCanonicalModelConfig(args: {
  staging: { config: string; kek: string };
  options: ModelConfigCutoverOptions;
}): Promise<void> {
  await mkdir(dirname(args.options.configOut), { recursive: true, mode: 0o700 });
  await mkdir(dirname(args.options.kekOut), { recursive: true, mode: 0o700 });
  await rename(args.staging.kek, args.options.kekOut);
  try {
    await rename(args.staging.config, args.options.configOut);
  } catch (error) {
    await rm(args.options.kekOut, { force: true });
    throw error;
  }
  await fsyncDirectory(dirname(args.options.kekOut));
  if (dirname(args.options.configOut) !== dirname(args.options.kekOut)) {
    await fsyncDirectory(dirname(args.options.configOut));
  }
}

async function backupArchives(
  changes: ArchiveChange[],
  backupDir: string,
): Promise<void> {
  if (changes.length === 0) return;
  const root = join(backupDir, 'archives');
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const change of changes) {
    const target = join(root, `${slug(change.archiveId)}-${basename(change.archivePath)}`);
    if (change.format === 'directory') {
      await cp(change.archivePath, target, {
        recursive: true,
        preserveTimestamps: true,
        errorOnExist: true,
        force: false,
      });
    } else {
      await copyFile(change.archivePath, target, constants.COPYFILE_EXCL);
      await chmod(target, 0o600);
    }
  }
}

const MANAGED_AGENT_DATA_DIRECTORIES = ['agents', 'skills', 'computer'] as const;

interface PublishedAgentDirectory {
  target: string;
  backup: string;
  hadPrevious: boolean;
}

async function stageAgentData(plan: AgentDataPlan): Promise<string> {
  const staging = join(
    dirname(plan.root),
    `.${basename(plan.root)}.agent-cutover.${process.pid}.staging`,
  );
  if (await pathExists(staging)) {
    throw new Error(`Agent data staging root already exists: ${staging}`);
  }
  await mkdir(dirname(plan.root), { recursive: true, mode: 0o700 });
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    for (const relativeDirectory of plan.directories) {
      const target = resolve(staging, relativeDirectory);
      if (!isSameOrAncestor(staging, target)) {
        throw new Error(`Agent data directory escapes staging root: ${relativeDirectory}`);
      }
      await mkdir(target, { recursive: true, mode: 0o700 });
    }
    for (const file of plan.targetFiles) {
      const target = resolve(staging, file.relativePath);
      if (!isSameOrAncestor(staging, target)) {
        throw new Error(`Agent data file escapes staging root: ${file.relativePath}`);
      }
      const mode = file.relativePath === join('agents', 'config.json')
        ? 0o600
        : file.mode;
      await writeNewFileDurable(target, file.content, mode);
    }
    await fsyncDirectory(staging);
    return staging;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function restorePublishedAgentData(
  published: PublishedAgentDirectory[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const item of [...published].reverse()) {
    try {
      await rm(item.target, { recursive: true, force: true });
      if (item.hadPrevious) {
        await rename(item.backup, item.target);
      }
    } catch (error) {
      failures.push(
        `${item.target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return failures;
}

async function publishStagedAgentData(args: {
  staging: string;
  root: string;
  backupDir: string;
}): Promise<PublishedAgentDirectory[]> {
  await mkdir(args.root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(args.root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Canonical Agent data root must be a real directory: ${args.root}`);
  }
  const backupRoot = join(args.backupDir, 'agent-data');
  await mkdir(backupRoot, { recursive: false, mode: 0o700 });
  const published: PublishedAgentDirectory[] = [];
  try {
    for (const name of MANAGED_AGENT_DATA_DIRECTORIES) {
      const target = join(args.root, name);
      const staged = join(args.staging, name);
      const backupPath = join(backupRoot, name);
      const targetExists = await pathExists(target);
      if (targetExists) {
        const info = await lstat(target);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error(`Managed Agent data target must be a real directory: ${target}`);
        }
        await rename(target, backupPath);
      } else {
        await writeNewFileDurable(join(backupRoot, `${name}.absent`), '');
      }
      const record = {
        target,
        backup: backupPath,
        hadPrevious: targetExists,
      };
      published.push(record);
      try {
        await rename(staged, target);
      } catch (error) {
        if (targetExists) await rename(backupPath, target);
        published.pop();
        throw error;
      }
    }
    await rm(args.staging, { recursive: true, force: true });
    await fsyncDirectory(args.root);
    return published;
  } catch (error) {
    const failures = await restorePublishedAgentData(published);
    await rm(args.staging, { recursive: true, force: true });
    if (failures.length > 0) {
      throw new Error(
        `Agent data publish failed and rollback was incomplete: ${
          failures.join('; ')
        }. Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }
}

async function verifyArchivesUnchanged(changes: ArchiveChange[]): Promise<void> {
  for (const change of changes) {
    const currentHash = await hashArchiveArtifact(change.archivePath, change.format);
    if (currentHash !== change.sourceHash) {
      throw new Error(`Recoverable archive changed after preflight: ${change.archiveId}`);
    }
  }
}

async function verifyPlanSourcesUnchanged(
  plan: ModelConfigMigrationPlan,
): Promise<void> {
  for (const file of plan.envFiles) {
    if (await readFile(file.path, 'utf8') !== file.content) {
      throw new Error(`Layered env file changed after preflight: ${file.path}`);
    }
  }
  for (const file of plan.agentData.sourceFiles) {
    if (!(await readFile(file.path)).equals(file.content)) {
      throw new Error(`Agent data file changed after preflight: ${file.path}`);
    }
  }
  if (
    plan.modelMapFile
    && await readFile(plan.modelMapFile.path, 'utf8') !== plan.modelMapFile.content
  ) {
    throw new Error(`Model map file changed after preflight: ${plan.modelMapFile.path}`);
  }
  await verifyArchivesUnchanged(plan.archiveChanges);
}

export async function applyModelConfigMigration(
  options: ModelConfigCutoverOptions,
  plan?: ModelConfigMigrationPlan,
): Promise<ModelConfigMigrationReport> {
  if (options.command !== 'apply') {
    throw new Error('applyModelConfigMigration requires command=apply.');
  }
  if (!options.confirmServiceStopped) {
    throw new Error('apply requires --confirm-service-stopped.');
  }
  if (!options.backupDir) throw new Error('--backup-dir is required for apply.');
  assertServiceStopped(options.systemctl);

  const currentPlan = plan ?? await buildModelConfigMigrationPlan(options);
  if (await pathExists(options.configOut) || await pathExists(options.kekOut)) {
    throw new Error('Canonical model config or KEK appeared after preflight.');
  }
  await verifyPlanSourcesUnchanged(currentPlan);
  const completedAt = (options.now ?? (() => new Date()))().toISOString();
  await assertNewRealDirectory(options.backupDir);
  const filesBackupDir = join(options.backupDir, 'files');
  await mkdir(filesBackupDir, { recursive: true, mode: 0o700 });
  if (currentPlan.modelMapFile) {
    await backupFile(currentPlan.modelMapFile.path, filesBackupDir);
  }
  const databaseBackupPath = join(options.backupDir, 'koishi.db');
  const database = new DatabaseSync(options.database, { readOnly: true });
  try {
    await backup(database, databaseBackupPath);
  } finally {
    database.close();
  }
  await chmod(databaseBackupPath, 0o600);
  await backupArchives(currentPlan.archiveChanges, options.backupDir);
  await writeNewFileDurable(
    join(options.backupDir, 'preflight-report.json'),
    `${JSON.stringify(currentPlan.report, null, 2)}\n`,
  );

  const fileBackups: FileBackup[] = [];
  const publishedTargets: string[] = [];
  const staging = await stageCanonicalModelConfig({
    options,
    plan: currentPlan,
    completedAt,
  });
  let agentStaging: string;
  try {
    agentStaging = await stageAgentData(currentPlan.agentData);
  } catch (error) {
    await rm(staging.config, { force: true });
    await rm(staging.kek, { force: true });
    throw error;
  }
  let reportPublished = false;
  let publishedAgentData: PublishedAgentDirectory[] = [];
  const appliedReport: ModelConfigMigrationReport = {
    ...currentPlan.report,
    command: 'apply',
    dryRun: false,
    applied: true,
  };

  try {
    const fileChanges = [
      ...currentPlan.envFiles
        .filter((file) => file.content !== file.nextContent)
        .map((file) => ({
          path: file.path,
          content: file.nextContent as string | Buffer,
        })),
      ...currentPlan.agentData.files
        .filter((file) => !isSameOrAncestor(currentPlan.agentData.root, file.path))
        .map((file) => ({
          path: file.path,
          content: file.nextContent as string | Buffer,
        })),
      ...currentPlan.archiveChanges.map((change) => ({
        path: change.contentPath,
        content: change.nextContent as string | Buffer,
      })),
    ];
    const seenTargets = new Set<string>();
    for (const change of fileChanges) {
      if (seenTargets.has(change.path)) {
        throw new Error(`Two cutover artifacts target the same file: ${change.path}`);
      }
      seenTargets.add(change.path);
      const backupRecord = await backupFile(change.path, filesBackupDir);
      fileBackups.push(backupRecord);
      await atomicReplaceFile(
        change.path,
        change.content,
        backupRecord.mode,
      );
      publishedTargets.push(change.path);
    }

    publishedAgentData = await publishStagedAgentData({
      staging: agentStaging,
      root: currentPlan.agentData.root,
      backupDir: options.backupDir,
    });
    await publishStagedCanonicalModelConfig({ staging, options });
    publishedTargets.push(options.kekOut, options.configOut);

    if (options.report) {
      if (await pathExists(options.report)) {
        throw new Error(`Apply report already exists: ${options.report}`);
      }
      await writeNewFileDurable(
        options.report,
        `${JSON.stringify(appliedReport, null, 2)}\n`,
      );
      reportPublished = true;
    }

    verifyAndApplyDatabasePlan(options.database, currentPlan.database);
    return appliedReport;
  } catch (error) {
    const rollbackFailures: string[] = [];
    rollbackFailures.push(...await restorePublishedAgentData(publishedAgentData));
    if (reportPublished && options.report) {
      try {
        await rm(options.report, { force: true });
      } catch (rollbackError) {
        rollbackFailures.push(
          `${options.report}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    for (const target of [options.configOut, options.kekOut]) {
      if (!publishedTargets.includes(target)) continue;
      try {
        await rm(target, { force: true });
      } catch (rollbackError) {
        rollbackFailures.push(
          `${target}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    rollbackFailures.push(...await restoreFiles(fileBackups));
    await rm(agentStaging, { recursive: true, force: true });
    await rm(staging.config, { force: true });
    await rm(staging.kek, { force: true });
    if (rollbackFailures.length > 0) {
      throw new Error(
        `Model config cutover failed and rollback was incomplete: ${
          rollbackFailures.join('; ')
        }. Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }
}

export async function runModelConfigCutover(
  options: ModelConfigCutoverOptions,
): Promise<ModelConfigMigrationReport> {
  const plan = await buildModelConfigMigrationPlan(options);
  if (options.command === 'preflight') return plan.report;
  return applyModelConfigMigration(options, plan);
}

async function main(): Promise<void> {
  const options = parseModelConfigCutoverArgs(process.argv.slice(2));
  const report = await runModelConfigCutover(options);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (
  process.argv[1]
  && /^model-config-cutover\.(?:[cm]?[jt]s)$/u.test(basename(process.argv[1]))
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
