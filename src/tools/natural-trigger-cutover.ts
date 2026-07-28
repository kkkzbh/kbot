#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  NATURAL_TRIGGER_CONFIG_SCHEMA_VERSION,
  naturalTriggerConfigDocumentSchema,
  naturalTriggerConfigSchema,
  type NaturalTriggerConfig,
  type NaturalTriggerConfigDocument,
} from '../plugins/natural-trigger-config/types.js';

const LEGACY_KEYS = [
  'CHAT_NATURAL_TRIGGER_ENABLED',
  'CHAT_NATURAL_TRIGGER_GROUPS',
  'CHAT_NATURAL_TRIGGER_ALIASES',
  'CHAT_NATURAL_TRIGGER_DIRECT_PROBABILITY',
  'CHAT_NATURAL_TRIGGER_FOCUS_WINDOW_MS',
  'CHAT_NATURAL_TRIGGER_REPLY_INTERVAL_MS',
  'CHAT_NATURAL_TRIGGER_SPAM_WINDOW_MS',
  'CHAT_NATURAL_TRIGGER_SPAM_THRESHOLD',
  'CHAT_NATURAL_TRIGGER_SPAM_MUTE_MS',
  'CHAT_NATURAL_TRIGGER_DECISION_MIN_CONFIDENCE',
  'CHAT_NATURAL_TRIGGER_DECISION_ENABLED',
  'CHAT_NATURAL_TRIGGER_DECISION_BASE_URL',
  'CHAT_NATURAL_TRIGGER_DECISION_URL',
  'CHAT_NATURAL_TRIGGER_DECISION_API_KEY',
  'CHAT_NATURAL_TRIGGER_DECISION_MODEL',
  'CHAT_NATURAL_TRIGGER_DECISION_TIMEOUT_MS',
] as const;

const REQUIRED_LEGACY_KEYS = LEGACY_KEYS.slice(0, 10);
const EXTENSION_TARGETS = [
  'HBU_JW',
  'CHAOXING',
  'GENSHIN',
] as const;

const reportSchema = z.object({
  schemaVersion: z.literal(1),
  operation: z.literal('natural-trigger-config-cutover'),
  mode: z.enum(['create', 'validate']),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  config: naturalTriggerConfigSchema,
  removedDisabledGroups: z.array(z.string()),
}).strict();
export type NaturalTriggerCutoverReport = z.infer<typeof reportSchema>;

type ParsedEnv = {
  raw: string;
  values: Map<string, string>;
};

function overlayEnv(base: ParsedEnv, override: ParsedEnv | null): ParsedEnv {
  return {
    raw: base.raw,
    values: new Map([
      ...base.values,
      ...(override?.values ?? []),
    ]),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseEnv(raw: string): ParsedEnv {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2] ?? '';
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(match[1]!, value);
  }
  return { raw, values };
}

function requiredValue(env: ParsedEnv, key: string): string {
  if (!env.values.has(key)) throw new Error(`legacy natural trigger key is missing: ${key}`);
  return env.values.get(key)!;
}

function strictBoolean(value: string, key: string): boolean {
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${key} must be true or false`);
  }
  return value === 'true';
}

function strictNumber(
  value: string,
  key: string,
  options: { min: number; max?: number; integer?: boolean },
): number {
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed)
    || parsed < options.min
    || (options.max !== undefined && parsed > options.max)
    || (options.integer && !Number.isInteger(parsed))
  ) {
    throw new Error(`${key} has an invalid numeric value`);
  }
  return parsed;
}

function normalizeGroupIds(value: string): string[] {
  const groups = value
    .split(/[,\s，、]+/)
    .map((entry) => entry.trim().replace(/^(?:group|guild):/, ''))
    .filter(Boolean);
  return [...new Set(groups)];
}

function normalizeAliases(value: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.split(/[,，、]+/)) {
    const alias = entry.trim();
    const identity = alias.toLocaleLowerCase();
    if (!alias || seen.has(identity)) continue;
    seen.add(identity);
    result.push(alias);
  }
  return result;
}

function readDisabledGroups(databasePath: string): string[] {
  if (!existsSync(databasePath)) return [];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const table = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feature_scope_override'",
    ).get();
    if (!table) return [];
    const columns = database.prepare('PRAGMA table_info(feature_scope_override)').all()
      .map((column) => String(column.name));
    for (const required of ['featureKey', 'scopeKind', 'scopeId', 'enabled']) {
      if (!columns.includes(required)) {
        throw new Error(`feature_scope_override is missing column ${required}`);
      }
    }
    return database.prepare(
      `SELECT scopeId
       FROM feature_scope_override
       WHERE featureKey = ? AND scopeKind = 'group' AND enabled = 0`,
    ).all('CHAT_NATURAL_TRIGGER_ENABLED')
      .map((row) => String(row.scopeId).trim())
      .filter(Boolean)
      .sort();
  } finally {
    database.close();
  }
}

function deleteLegacyOverrides(databasePath: string): void {
  if (!existsSync(databasePath)) return;
  const database = new DatabaseSync(databasePath);
  try {
    const table = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feature_scope_override'",
    ).get();
    if (!table) return;
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(
        'DELETE FROM feature_scope_override WHERE featureKey = ?',
      ).run('CHAT_NATURAL_TRIGGER_ENABLED');
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}

export function buildNaturalTriggerConfig(
  env: ParsedEnv,
  disabledGroups: readonly string[],
): NaturalTriggerConfig {
  for (const key of REQUIRED_LEGACY_KEYS) requiredValue(env, key);
  const aliases = normalizeAliases(requiredValue(env, 'CHAT_NATURAL_TRIGGER_ALIASES'));
  const configuredGroups = normalizeGroupIds(requiredValue(env, 'CHAT_NATURAL_TRIGGER_GROUPS'));
  const denied = new Set(disabledGroups);
  const probability = strictNumber(
    requiredValue(env, 'CHAT_NATURAL_TRIGGER_DIRECT_PROBABILITY'),
    'CHAT_NATURAL_TRIGGER_DIRECT_PROBABILITY',
    { min: 0, max: 1 },
  );
  const focusWindowMs = strictNumber(
    requiredValue(env, 'CHAT_NATURAL_TRIGGER_FOCUS_WINDOW_MS'),
    'CHAT_NATURAL_TRIGGER_FOCUS_WINDOW_MS',
    { min: 0, integer: true },
  );

  return naturalTriggerConfigSchema.parse({
    enabled: strictBoolean(
      requiredValue(env, 'CHAT_NATURAL_TRIGGER_ENABLED'),
      'CHAT_NATURAL_TRIGGER_ENABLED',
    ),
    allowedGroupIds: configuredGroups.filter((groupId) => !denied.has(groupId)),
    voiceAdmission: { enabled: true },
    mechanisms: {
      quote: { enabled: true },
      alias: { enabled: aliases.length > 0, aliases },
      heuristic: { enabled: true },
      focus: { enabled: focusWindowMs > 0, windowMs: focusWindowMs },
      random: { enabled: probability > 0, probability },
    },
    modelDecision: {
      minConfidence: strictNumber(
        requiredValue(env, 'CHAT_NATURAL_TRIGGER_DECISION_MIN_CONFIDENCE'),
        'CHAT_NATURAL_TRIGGER_DECISION_MIN_CONFIDENCE',
        { min: 0, max: 1 },
      ),
    },
    pacing: {
      minReplyIntervalMs: strictNumber(
        requiredValue(env, 'CHAT_NATURAL_TRIGGER_REPLY_INTERVAL_MS'),
        'CHAT_NATURAL_TRIGGER_REPLY_INTERVAL_MS',
        { min: 0, integer: true },
      ),
    },
    antiSpam: {
      enabled: true,
      windowMs: strictNumber(
        requiredValue(env, 'CHAT_NATURAL_TRIGGER_SPAM_WINDOW_MS'),
        'CHAT_NATURAL_TRIGGER_SPAM_WINDOW_MS',
        { min: 1, integer: true },
      ),
      threshold: strictNumber(
        requiredValue(env, 'CHAT_NATURAL_TRIGGER_SPAM_THRESHOLD'),
        'CHAT_NATURAL_TRIGGER_SPAM_THRESHOLD',
        { min: 1, integer: true },
      ),
      muteMs: strictNumber(
        requiredValue(env, 'CHAT_NATURAL_TRIGGER_SPAM_MUTE_MS'),
        'CHAT_NATURAL_TRIGGER_SPAM_MUTE_MS',
        { min: 0, integer: true },
      ),
    },
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

export async function preflightNaturalTriggerCutover(input: {
  envPath: string;
  overrideEnvPath?: string;
  databasePath: string;
  configPath: string;
}): Promise<NaturalTriggerCutoverReport> {
  const [envRaw, overrideEnvRaw, disabledGroups] = await Promise.all([
    readFile(input.envPath, 'utf8'),
    input.overrideEnvPath && await pathExists(input.overrideEnvPath)
      ? readFile(input.overrideEnvPath, 'utf8')
      : Promise.resolve(null),
    Promise.resolve(readDisabledGroups(input.databasePath)),
  ]);
  if (await pathExists(input.configPath)) {
    const configRaw = await readFile(input.configPath, 'utf8');
    const document = naturalTriggerConfigDocumentSchema.parse(JSON.parse(configRaw));
    return reportSchema.parse({
      schemaVersion: 1,
      operation: 'natural-trigger-config-cutover',
      mode: 'validate',
      sourceDigest: sha256(configRaw),
      config: document.config,
      removedDisabledGroups: disabledGroups,
    });
  }
  const env = overlayEnv(
    parseEnv(envRaw),
    overrideEnvRaw === null ? null : parseEnv(overrideEnvRaw),
  );
  const config = buildNaturalTriggerConfig(env, disabledGroups);
  const source = JSON.stringify(Object.fromEntries(
    REQUIRED_LEGACY_KEYS.map((key) => [key, requiredValue(env, key)]),
  ));
  return reportSchema.parse({
    schemaVersion: 1,
    operation: 'natural-trigger-config-cutover',
    mode: 'create',
    sourceDigest: sha256(source),
    config,
    removedDisabledGroups: disabledGroups,
  });
}

function updateEnv(
  target: ParsedEnv,
  effective: ParsedEnv,
  configPath: string,
): string {
  const removed = new Set<string>(LEGACY_KEYS);
  const replacement = new Map<string, string>();
  replacement.set('QQBOT_NATURAL_TRIGGER_CONFIG_PATH', configPath);
  const legacyEnabled = effective.values.get('CHAT_NATURAL_TRIGGER_ENABLED');
  const legacyGroups = effective.values.get('CHAT_NATURAL_TRIGGER_GROUPS');
  for (const prefix of EXTENSION_TARGETS) {
    const enabledKey = `${prefix}_NATURAL_TRIGGER_ENABLED`;
    const groupsKey = `${prefix}_NATURAL_TRIGGER_GROUPS`;
    if (legacyEnabled !== undefined && legacyGroups !== undefined) {
      replacement.set(enabledKey, legacyEnabled);
      replacement.set(groupsKey, legacyGroups);
      continue;
    }
    if (!effective.values.has(enabledKey) || !effective.values.has(groupsKey)) {
      throw new Error(`cutover env is missing extension trigger keys for ${prefix}`);
    }
  }

  const output: string[] = [];
  const written = new Set<string>();
  for (const line of target.raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match) {
      output.push(line);
      continue;
    }
    const key = match[1]!;
    if (removed.has(key)) continue;
    const value = replacement.get(key);
    if (value !== undefined) {
      if (!written.has(key)) output.push(`${key}=${value}`);
      written.add(key);
      continue;
    }
    output.push(line);
  }
  for (const [key, value] of replacement) {
    if (!written.has(key)) output.push(`${key}=${value}`);
  }
  while (output.at(-1) === '') output.pop();
  return `${output.join('\n')}\n`;
}

function removeLegacyEnvKeys(parsed: ParsedEnv): string {
  const removed = new Set<string>(LEGACY_KEYS);
  const output = parsed.raw.split(/\r?\n/).filter((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    return !match || !removed.has(match[1]!);
  });
  while (output.at(-1) === '') output.pop();
  return `${output.join('\n')}\n`;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const file = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporaryPath, path);
  const directory = await open(dirname(path), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function applyNaturalTriggerCutover(input: {
  envPath: string;
  overrideEnvPath?: string;
  databasePath: string;
  configPath: string;
  report: NaturalTriggerCutoverReport;
}): Promise<NaturalTriggerConfigDocument> {
  const current = await preflightNaturalTriggerCutover(input);
  if (
    current.mode !== input.report.mode
    || current.sourceDigest !== input.report.sourceDigest
    || JSON.stringify(current.config) !== JSON.stringify(input.report.config)
  ) {
    throw new Error('natural trigger cutover source changed after preflight');
  }
  const parsedEnv = parseEnv(await readFile(input.envPath, 'utf8'));
  const parsedOverride = input.overrideEnvPath && await pathExists(input.overrideEnvPath)
    ? parseEnv(await readFile(input.overrideEnvPath, 'utf8'))
    : null;
  const effectiveEnv = overlayEnv(parsedEnv, parsedOverride);
  let document: NaturalTriggerConfigDocument;
  if (current.mode === 'create') {
    document = naturalTriggerConfigDocumentSchema.parse({
      schemaVersion: NATURAL_TRIGGER_CONFIG_SCHEMA_VERSION,
      savedRevision: 1,
      appliedRevision: 0,
      updatedAt: new Date().toISOString(),
      config: current.config,
    });
    await writeAtomic(input.configPath, `${JSON.stringify(document, null, 2)}\n`);
  } else {
    document = naturalTriggerConfigDocumentSchema.parse(
      JSON.parse(await readFile(input.configPath, 'utf8')),
    );
  }
  deleteLegacyOverrides(input.databasePath);
  await writeAtomic(input.envPath, updateEnv(parsedEnv, effectiveEnv, input.configPath));
  if (input.overrideEnvPath && parsedOverride) {
    await writeAtomic(input.overrideEnvPath, removeLegacyEnvKeys(parsedOverride));
  }
  return document;
}

function assertTargetStopped(): void {
  const result = spawnSync('systemctl', ['is-active', '--quiet', 'qqbot.target'], {
    stdio: 'ignore',
  });
  if (result.status === 0) {
    throw new Error('qqbot.target must be stopped before natural trigger cutover');
  }
}

function parseArgs(argv: string[]): {
  command: 'preflight' | 'apply';
  envPath: string;
  overrideEnvPath?: string;
  databasePath: string;
  configPath: string;
  reportPath: string;
  confirmStopped: boolean;
} {
  const command = argv.shift();
  if (command !== 'preflight' && command !== 'apply') {
    throw new Error('usage: natural-trigger-cutover <preflight|apply>');
  }
  const values = new Map<string, string>();
  let confirmStopped = false;
  while (argv.length > 0) {
    const key = argv.shift()!;
    if (key === '--confirm-service-stopped') {
      confirmStopped = true;
      continue;
    }
    const value = argv.shift();
    if (!value) throw new Error(`${key} requires a value`);
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (!value) throw new Error(`${key} is required`);
    return resolve(value);
  };
  return {
    command,
    envPath: required('--env'),
    overrideEnvPath: values.has('--override-env')
      ? required('--override-env')
      : undefined,
    databasePath: required('--database'),
    configPath: required('--config'),
    reportPath: required('--report'),
    confirmStopped,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'preflight') {
    const report = await preflightNaturalTriggerCutover(args);
    await writeFile(args.reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return;
  }
  if (!args.confirmStopped) throw new Error('apply requires --confirm-service-stopped');
  assertTargetStopped();
  const report = reportSchema.parse(JSON.parse(await readFile(args.reportPath, 'utf8')));
  await applyNaturalTriggerCutover({ ...args, report });
}

if (basename(process.argv[1] ?? '').startsWith('natural-trigger-cutover')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
