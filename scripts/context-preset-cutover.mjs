#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  access,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  ContextPresetDefinitionV1Schema,
  RolePresetDefinitionV1Schema,
} from 'koishi-plugin-chatluna/preset-schema';
import YAML from 'yaml';

process.umask(0o077);

const ROOT_DIR = process.cwd();
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const SQLITE_HELPER = join(SCRIPT_DIR, 'context-preset-sqlite.py');
const FILE_PATTERN = /\.ya?ml$/i;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LEGACY_DEFAULT_LORE_TOKEN_LIMIT = 300;
const CUTOVER_STATE_FILENAME = '.context-role-v1-cutover.json';
const ROLE_ANCHORS = new Set([
  'beforeCharacterDefinitions',
  'afterCharacterDefinitions',
  'beforeScenario',
  'afterScenario',
  'beforeExampleMessages',
  'afterExampleMessages',
]);
const VALUE_OPTIONS = new Set([
  'database',
  'legacy-bundled-dir',
  'legacy-runtime-dir',
  'bundled-role-dir',
  'bundled-context-dir',
  'runtime-role-dir',
  'runtime-context-dir',
  'backup-dir',
  'report',
  'systemctl',
]);

function usage() {
  return `Usage:
  node scripts/context-preset-cutover.mjs preflight [options]
  node scripts/context-preset-cutover.mjs apply [options] --confirm-service-stopped

Options:
  --database <path>             SQLite database whose references remain on context ids
  --legacy-bundled-dir <path>   Preset V2 bundled source
  --legacy-runtime-dir <path>   Preset V2 runtime override source
  --bundled-role-dir <path>     New bundled role catalog to validate
  --bundled-context-dir <path>  New bundled context catalog to validate
  --runtime-role-dir <path>     New runtime role catalog target
  --runtime-context-dir <path>  New runtime context catalog target
  --backup-dir <path>           Required apply backup directory
  --report <path>               Optional JSON report
  --systemctl <path>            systemctl binary (default: /usr/bin/systemctl)
  --confirm-service-stopped     Required for apply
`;
}

function parseArgs(argv) {
  const command = argv[0];
  if (command !== 'preflight' && command !== 'apply') throw new Error(usage());
  const values = new Map();
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
    if (values.has(name)) throw new Error(`Duplicate argument: ${argument}`);
    values.set(name, value);
    index += 1;
  }
  const backup = values.get('backup-dir');
  if (command === 'apply' && !backup) throw new Error('--backup-dir is required for apply.');
  if (command === 'apply' && !confirmServiceStopped) {
    throw new Error('apply requires --confirm-service-stopped.');
  }
  return {
    command,
    database: resolve(values.get('database') ?? join(ROOT_DIR, 'data/koishi.db')),
    legacyBundledDir: resolve(
      values.get('legacy-bundled-dir') ?? join(ROOT_DIR, 'data/chathub/presets'),
    ),
    legacyRuntimeDir: resolve(
      values.get('legacy-runtime-dir') ?? join(ROOT_DIR, '.runtime/chathub/presets'),
    ),
    bundledRoleDir: resolve(
      values.get('bundled-role-dir') ?? join(ROOT_DIR, 'data/chathub/role-presets'),
    ),
    bundledContextDir: resolve(
      values.get('bundled-context-dir') ?? join(ROOT_DIR, 'data/chathub/context-presets'),
    ),
    runtimeRoleDir: resolve(
      values.get('runtime-role-dir') ?? join(ROOT_DIR, '.runtime/chathub/role-presets'),
    ),
    runtimeContextDir: resolve(
      values.get('runtime-context-dir') ?? join(ROOT_DIR, '.runtime/chathub/context-presets'),
    ),
    backupDir: backup ? resolve(backup) : null,
    report: values.has('report') ? resolve(values.get('report')) : null,
    systemctl: resolve(values.get('systemctl') ?? '/usr/bin/systemctl'),
    confirmServiceStopped,
  };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertDirectory(path, label) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
}

async function assertEmptyOrMissingDirectory(path, label) {
  if (!(await pathExists(path))) return;
  await assertDirectory(path, label);
  if ((await readdir(path)).length > 0) {
    throw new Error(`${label} must be absent or empty before cutover: ${path}`);
  }
}

function cutoverStatePath(options) {
  const roleParent = dirname(options.runtimeRoleDir);
  const contextParent = dirname(options.runtimeContextDir);
  if (roleParent !== contextParent) {
    throw new Error('Runtime role and context catalogs must share one parent directory.');
  }
  return join(roleParent, CUTOVER_STATE_FILENAME);
}

async function readCutoverState(options) {
  const path = cutoverStatePath(options);
  if (!(await pathExists(path))) return null;
  const state = JSON.parse(await readFile(path, 'utf8'));
  if (
    state?.schemaVersion !== 1
    || state.operation !== 'preset-v2-to-context-role-v1'
    || typeof state.backupDir !== 'string'
    || typeof state.runtimeRoleDigest !== 'string'
    || typeof state.runtimeContextDigest !== 'string'
    || !['initializing', 'prepared', 'role-installed', 'completed'].includes(state.phase)
  ) {
    throw new Error(`Invalid context preset cutover state: ${path}`);
  }
  if (
    state.runtimeRoleDir !== options.runtimeRoleDir
    || state.runtimeContextDir !== options.runtimeContextDir
  ) {
    throw new Error(`Context preset cutover state targets do not match: ${path}`);
  }
  return state;
}

async function writeCutoverState(options, state) {
  const path = cutoverStatePath(options);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await rm(temporary, { force: true });
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
    flush: true,
  });
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function runSqlite(operation, database, destination) {
  const result = spawnSync('python3', [
    SQLITE_HELPER,
    operation,
    database,
    ...(destination == null ? [] : [destination]),
  ], { encoding: 'utf8' });
  if (result.error) throw result.error;
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`SQLite helper returned invalid JSON during ${operation}.`);
  }
  if (result.status !== 0 || payload.error) {
    throw new Error(`SQLite ${operation} failed: ${payload.error ?? result.stderr.trim()}`);
  }
  return payload;
}

function assertObject(value, label) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`);
  }
}

function validateLegacyPreset(value, file) {
  const preset = assertObject(value, `Preset V2 ${file}`);
  assertKeys(preset, new Set([
    'schemaVersion',
    'id',
    'displayName',
    'aliases',
    'messages',
    'inputFormat',
    'lore',
    'authorsNote',
    'knowledge',
    'promptConfig',
  ]), `Preset V2 ${file}`);
  if (preset.schemaVersion !== 2) throw new Error(`Expected schemaVersion 2: ${file}`);
  if (typeof preset.id !== 'string' || !ID_PATTERN.test(preset.id)) {
    throw new Error(`Invalid Preset V2 id in ${file}`);
  }
  if (typeof preset.displayName !== 'string' || preset.displayName.trim().length === 0) {
    throw new Error(`Invalid Preset V2 displayName in ${file}`);
  }
  if (!Array.isArray(preset.aliases) || !Array.isArray(preset.messages)) {
    throw new Error(`Preset V2 aliases/messages must be arrays: ${file}`);
  }
  assertObject(preset.lore, `Preset V2 lore in ${file}`);
  assertKeys(preset.lore, new Set(['defaults', 'entries']), `Preset V2 lore in ${file}`);
  assertObject(preset.lore.defaults, `Preset V2 lore.defaults in ${file}`);
  if (!Array.isArray(preset.lore.entries)) {
    throw new Error(`Preset V2 lore.entries must be an array: ${file}`);
  }
  assertObject(preset.promptConfig, `Preset V2 promptConfig in ${file}`);
  assertKeys(preset.promptConfig, new Set([
    'maxOutputToken',
    'longMemoryPrompt',
    'loreBooksPrompt',
    'longMemoryExtractPrompt',
    'longMemoryNewQuestionPrompt',
    'postHandler',
    'reActInstruction',
  ]), `Preset V2 promptConfig in ${file}`);
  if (preset.authorsNote != null) {
    assertKeys(assertObject(
      preset.authorsNote,
      `Preset V2 authorsNote in ${file}`,
    ), new Set([
      'content',
      'insertPosition',
      'insertDepth',
      'insertFrequency',
    ]), `Preset V2 authorsNote in ${file}`);
  }
  if (preset.knowledge != null) {
    assertKeys(assertObject(
      preset.knowledge,
      `Preset V2 knowledge in ${file}`,
    ), new Set(['sources', 'prompt']), `Preset V2 knowledge in ${file}`);
  }
  return preset;
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value == null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, stripUndefined(item)]));
}

function loreGroups(preset) {
  const defaultPosition = preset.lore.defaults.insertPosition
    ?? 'afterCharacterDefinitions';
  if (!ROLE_ANCHORS.has(defaultPosition)) {
    throw new Error(`Invalid Lore default anchor in ${preset.id}: ${defaultPosition}`);
  }
  const groups = new Map();
  for (const entry of preset.lore.entries) {
    const position = entry.insertPosition ?? defaultPosition;
    if (!ROLE_ANCHORS.has(position)) {
      throw new Error(`Invalid Lore entry anchor in ${preset.id}: ${position}`);
    }
    const normalized = { ...entry };
    delete normalized.insertPosition;
    const entries = groups.get(position) ?? [];
    entries.push(stripUndefined(normalized));
    groups.set(position, entries);
  }
  const hasConfig = Object.keys(preset.lore.defaults).length > 0
    || preset.promptConfig.loreBooksPrompt != null;
  if (groups.size === 0 && hasConfig) groups.set(defaultPosition, []);
  return groups;
}

export function migratePresetDefinition(input) {
  const preset = validateLegacyPreset(input, '<memory>');
  const prompt = preset.promptConfig;
  const loreDefaults = { ...preset.lore.defaults };
  delete loreDefaults.tokenLimit;
  delete loreDefaults.insertPosition;
  const groupedLore = [...loreGroups(preset)];
  const loreTokenLimit = preset.lore.defaults.tokenLimit
    ?? LEGACY_DEFAULT_LORE_TOKEN_LIMIT;
  if (!Number.isInteger(loreTokenLimit) || loreTokenLimit <= 0) {
    throw new Error(`Invalid Lore tokenLimit in ${preset.id}: ${loreTokenLimit}`);
  }
  if (groupedLore.length > loreTokenLimit) {
    throw new Error(
      `Lore tokenLimit ${loreTokenLimit} cannot preserve ${groupedLore.length} anchored groups in ${preset.id}.`,
    );
  }
  const loreBaseBudget = groupedLore.length === 0
    ? 0
    : Math.floor(loreTokenLimit / groupedLore.length);
  const loreBudgetRemainder = groupedLore.length === 0
    ? 0
    : loreTokenLimit % groupedLore.length;
  const blocks = [
    { id: 'role', type: 'role', rolePresetId: preset.id },
    {
      id: 'chat-history',
      type: 'chatHistory',
      enabled: true,
      budgetPriority: 100,
      maxTokens: null,
    },
    {
      id: 'request-documents',
      type: 'requestDocuments',
      enabled: true,
      budgetPriority: 50,
      maxTokens: null,
    },
  ];
  let priority = 310;
  for (const [groupIndex, [position, entries]] of groupedLore.entries()) {
    blocks.push({
      id: `lore-${position.replace(/[A-Z]/g, (part) => `-${part.toLowerCase()}`)}`,
      type: 'lore',
      enabled: true,
      budgetPriority: priority,
      maxTokens: loreBaseBudget + (groupIndex < loreBudgetRemainder ? 1 : 0),
      anchor: { type: 'role', position },
      prompt: prompt.loreBooksPrompt ?? null,
      defaults: stripUndefined(loreDefaults),
      entries,
    });
    priority += 1;
  }
  if (preset.authorsNote != null) {
    const note = assertObject(preset.authorsNote, `Preset V2 authorsNote in ${preset.id}`);
    const position = note.insertPosition ?? 'inChat';
    blocks.push({
      id: 'authors-note',
      type: 'authorsNote',
      enabled: true,
      budgetPriority: 330,
      maxTokens: null,
      anchor: position === 'inChat'
        ? { type: 'chatHistory', depth: note.insertDepth ?? 0 }
        : { type: 'role', position },
      content: note.content,
      insertFrequency: note.insertFrequency ?? 0,
    });
  }
  if (preset.knowledge != null) {
    const knowledge = assertObject(preset.knowledge, `Preset V2 knowledge in ${preset.id}`);
    blocks.push({
      id: 'knowledge',
      type: 'knowledge',
      enabled: true,
      budgetPriority: 340,
      maxTokens: null,
      sources: knowledge.sources,
      prompt: knowledge.prompt ?? null,
    });
  }
  blocks.push(
    { id: 'current-input', type: 'currentInput', inputFormat: preset.inputFormat },
    {
      id: 'agent-scratchpad',
      type: 'agentScratchpad',
      enabled: true,
      budgetPriority: 400,
      maxTokens: null,
      reActInstruction: prompt.reActInstruction ?? null,
    },
    {
      id: 'model-output',
      type: 'modelOutput',
      maxOutputTokens: prompt.maxOutputToken ?? 1024,
      postHandler: prompt.postHandler ?? null,
    },
  );
  return {
    rolePreset: RolePresetDefinitionV1Schema.parse(stripUndefined({
      schemaVersion: 1,
      id: preset.id,
      displayName: preset.displayName,
      messages: preset.messages,
    })),
    contextPreset: ContextPresetDefinitionV1Schema.parse(stripUndefined({
      schemaVersion: 1,
      id: preset.id,
      displayName: preset.displayName,
      aliases: preset.aliases,
      blocks,
    })),
  };
}

async function readYamlDirectory(path, label, kind) {
  await assertDirectory(path, label);
  const result = new Map();
  const names = (await readdir(path)).sort();
  for (const name of names) {
    if (!FILE_PATTERN.test(name)) {
      throw new Error(`${label} contains an unsupported entry: ${name}`);
    }
    const file = join(path, name);
    const value = YAML.parse(await readFile(file, 'utf8'));
    const definition = kind === 'legacy'
      ? validateLegacyPreset(value, file)
      : kind === 'role'
        ? RolePresetDefinitionV1Schema.parse(value)
        : ContextPresetDefinitionV1Schema.parse(value);
    if (name !== `${definition.id}.yml`) {
      throw new Error(`${label} filename must match id ${definition.id}: ${file}`);
    }
    if (result.has(definition.id)) throw new Error(`Duplicate ${label} id: ${definition.id}`);
    result.set(definition.id, definition);
  }
  return result;
}

async function writeCatalog(path, definitions) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  for (const definition of definitions.values()) {
    await writeFile(join(path, `${definition.id}.yml`), YAML.stringify(definition, {
      lineWidth: 0,
    }), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
      flush: true,
    });
  }
  await syncDirectory(path);
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function effectiveCatalog(bundled, runtime) {
  const result = new Map(bundled);
  for (const [id, definition] of runtime) result.set(id, definition);
  return result;
}

function buildIdentityIndex(contexts) {
  const identities = new Map();
  for (const definition of contexts.values()) {
    for (const identity of [definition.id, ...definition.aliases]) {
      const key = identity.toLowerCase();
      const owner = identities.get(key);
      if (owner != null && owner !== definition.id) {
        throw new Error(
          `Context identity "${identity}" belongs to both ${owner} and ${definition.id}.`,
        );
      }
      identities.set(key, definition.id);
    }
  }
  return identities;
}

function validateDatabaseReferences(database, contexts) {
  const identities = buildIdentityIndex(contexts);
  const references = [];
  const unresolved = [];
  const inspect = (value, location, required = false) => {
    if (value == null) {
      if (required) unresolved.push(`${location}: missing`);
      return;
    }
    if (typeof value !== 'string' || value.length === 0) {
      unresolved.push(`${location}: invalid`);
      return;
    }
    const canonicalId = identities.get(value.toLowerCase());
    if (canonicalId == null) {
      unresolved.push(`${location}: unknown context identity "${value}"`);
      return;
    }
    if (canonicalId !== value) {
      unresolved.push(
        `${location}: persisted alias "${value}" must be canonical "${canonicalId}"`,
      );
      return;
    }
    references.push({ location, contextPresetId: canonicalId });
  };

  let globalDefault;
  try {
    globalDefault = JSON.parse(database.globalDefaultValue);
  } catch {
    unresolved.push('chatluna_meta.globalDefaultPresetId: invalid JSON');
  }
  inspect(globalDefault, 'chatluna_meta.globalDefaultPresetId', true);
  for (const row of database.conversations) {
    inspect(row.preset, `chatluna_conversation(${row.id}).preset`, true);
    const marker = row.bindingKey?.indexOf(':preset:') ?? -1;
    if (marker >= 0) {
      inspect(
        row.bindingKey.slice(marker + ':preset:'.length),
        `chatluna_conversation(${row.id}).bindingKey`,
        true,
      );
    }
  }
  for (const [index, row] of database.bindings.entries()) {
    const marker = row.bindingKey?.indexOf(':preset:') ?? -1;
    if (marker >= 0) {
      inspect(
        row.bindingKey.slice(marker + ':preset:'.length),
        `chatluna_binding(${index}).bindingKey`,
        true,
      );
    }
  }
  for (const [index, row] of database.constraints.entries()) {
    for (const column of ['activePresetLane', 'defaultPreset', 'fixedPreset']) {
      inspect(row[column], `chatluna_constraint(${index}).${column}`);
    }
  }
  for (const row of database.rooms) {
    inspect(row.preset, `chathub_room(${row.roomId}).preset`);
  }
  if (unresolved.length > 0) {
    throw new Error(`Unresolved context preset references:\n${unresolved.join('\n')}`);
  }
  return {
    globalDefaultContextPresetId: globalDefault,
    referenceCount: references.length,
    unresolvedReferences: [],
    canonicalReferencesUnchanged: true,
  };
}

export async function buildPlan(options, { allowInstalledTargets = false } = {}) {
  const bundled = await readYamlDirectory(
    options.legacyBundledDir,
    'legacy bundled catalog',
    'legacy',
  );
  const runtime = await readYamlDirectory(
    options.legacyRuntimeDir,
    'legacy runtime catalog',
    'legacy',
  );
  const bundledRoles = await readYamlDirectory(
    options.bundledRoleDir,
    'bundled role catalog',
    'role',
  );
  const bundledContexts = await readYamlDirectory(
    options.bundledContextDir,
    'bundled context catalog',
    'context',
  );
  if (bundled.size === 0) throw new Error('Legacy bundled catalog must not be empty.');
  for (const [id, definition] of bundled) {
    const migrated = migratePresetDefinition(definition);
    if (!isDeepStrictEqual(bundledRoles.get(id), migrated.rolePreset)) {
      throw new Error(`Bundled role migration mismatch: ${id}`);
    }
    if (!isDeepStrictEqual(bundledContexts.get(id), migrated.contextPreset)) {
      throw new Error(`Bundled context migration mismatch: ${id}`);
    }
  }
  if (bundledRoles.size !== bundled.size || bundledContexts.size !== bundled.size) {
    throw new Error('New bundled role/context catalogs must exactly match legacy bundled ids.');
  }
  if (!allowInstalledTargets) {
    await assertEmptyOrMissingDirectory(options.runtimeRoleDir, 'runtime role target');
    await assertEmptyOrMissingDirectory(options.runtimeContextDir, 'runtime context target');
  }
  const runtimeRoles = new Map();
  const runtimeContexts = new Map();
  for (const [id, definition] of runtime) {
    const migrated = migratePresetDefinition(definition);
    runtimeRoles.set(id, migrated.rolePreset);
    runtimeContexts.set(id, migrated.contextPreset);
  }
  const effectiveRoles = effectiveCatalog(bundledRoles, runtimeRoles);
  const effectiveContexts = effectiveCatalog(bundledContexts, runtimeContexts);
  for (const context of effectiveContexts.values()) {
    const role = context.blocks.find((block) => block.type === 'role');
    if (!effectiveRoles.has(role.rolePresetId)) {
      throw new Error(
        `Context preset ${context.id} references missing role ${role.rolePresetId}.`,
      );
    }
  }
  const database = runSqlite('inspect', options.database);
  const databaseReferences = validateDatabaseReferences(database, effectiveContexts);
  return {
    bundled,
    runtime,
    runtimeRoles,
    runtimeContexts,
    report: {
      schemaVersion: 1,
      operation: 'preset-v2-to-context-role-v1',
      bundledPresetCount: bundled.size,
      runtimePresetCount: runtime.size,
      bundledIds: [...bundled.keys()],
      runtimeIds: [...runtime.keys()],
      databaseReferencesChanged: false,
      database: databaseReferences,
      runtimeRoleDigest: sha256([...runtimeRoles.values()]),
      runtimeContextDigest: sha256([...runtimeContexts.values()]),
    },
  };
}

function assertServiceStopped(systemctl) {
  for (const unit of ['qqbot.target', 'qqbot-koishi.service']) {
    const result = spawnSync(systemctl, ['is-active', '--quiet', unit], {
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status === 0) throw new Error(`${unit} must be stopped before apply.`);
    if (result.status !== 3) {
      throw new Error(`Unable to verify ${unit} is stopped (exit ${result.status}).`);
    }
  }
}

async function writeReport(path, report) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
    flush: true,
  });
  await syncDirectory(dirname(path));
}

async function ensureReport(path, report) {
  if (!path) return;
  if (!(await pathExists(path))) {
    await writeReport(path, report);
    return;
  }
  const existing = JSON.parse(await readFile(path, 'utf8'));
  if (!isDeepStrictEqual(existing, report)) {
    throw new Error(`Existing cutover report does not match this transaction: ${path}`);
  }
}

async function assertPreparedBackup(backupDir) {
  if (!(await pathExists(join(backupDir, 'koishi.db')))) {
    throw new Error(`Context preset cutover backup is missing koishi.db: ${backupDir}`);
  }
  await assertDirectory(
    join(backupDir, 'legacy-bundled-presets'),
    'legacy bundled preset backup',
  );
  await assertDirectory(
    join(backupDir, 'legacy-runtime-presets'),
    'legacy runtime preset backup',
  );
}

async function prepareBackup(options, backupDir) {
  await rm(backupDir, { recursive: true, force: true });
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  runSqlite('backup', options.database, join(backupDir, 'koishi.db'));
  await cp(options.legacyBundledDir, join(backupDir, 'legacy-bundled-presets'), {
    recursive: true,
    preserveTimestamps: true,
  });
  await cp(options.legacyRuntimeDir, join(backupDir, 'legacy-runtime-presets'), {
    recursive: true,
    preserveTimestamps: true,
  });
}

async function catalogInstallState(path, definitions, kind, label) {
  if (!(await pathExists(path))) return 'missing';
  await assertDirectory(path, label);
  const entries = await readdir(path);
  if (entries.length === 0 && definitions.size > 0) return 'empty';
  const actual = await readYamlDirectory(path, label, kind);
  if (!isDeepStrictEqual([...actual], [...definitions])) {
    throw new Error(`${label} does not match the durable cutover transaction.`);
  }
  return 'installed';
}

async function installCatalog(staging, target, definitions, kind, label) {
  const state = await catalogInstallState(target, definitions, kind, label);
  if (state === 'installed') {
    await rm(staging, { recursive: true, force: true });
    return;
  }
  if (state === 'empty') await rmdir(target);
  await rename(staging, target);
  await syncDirectory(dirname(target));
  await catalogInstallState(target, definitions, kind, label);
}

function assertStateMatchesPlan(state, plan) {
  if (
    state.runtimeRoleDigest !== plan.report.runtimeRoleDigest
    || state.runtimeContextDigest !== plan.report.runtimeContextDigest
  ) {
    throw new Error('Context preset cutover state does not match the current migration plan.');
  }
}

export async function applyPlan(options, plan, report, hooks = {}) {
  let state = await readCutoverState(options);
  if (state == null) {
    if (await pathExists(options.backupDir)) {
      throw new Error(`Backup directory must not already exist: ${options.backupDir}`);
    }
    state = {
      schemaVersion: 1,
      operation: 'preset-v2-to-context-role-v1',
      phase: 'initializing',
      backupDir: options.backupDir,
      runtimeRoleDir: options.runtimeRoleDir,
      runtimeContextDir: options.runtimeContextDir,
      runtimeRoleDigest: plan.report.runtimeRoleDigest,
      runtimeContextDigest: plan.report.runtimeContextDigest,
    };
    await writeCutoverState(options, state);
  }
  assertStateMatchesPlan(state, plan);
  const effectiveReport = { ...report, backupDir: state.backupDir };

  if (state.phase === 'initializing') {
    await prepareBackup(options, state.backupDir);
    state = { ...state, phase: 'prepared' };
    await writeCutoverState(options, state);
  } else {
    await assertPreparedBackup(state.backupDir);
  }

  if (state.phase === 'completed') {
    const roleState = await catalogInstallState(
      options.runtimeRoleDir,
      plan.runtimeRoles,
      'role',
      'installed runtime role catalog',
    );
    const contextState = await catalogInstallState(
      options.runtimeContextDir,
      plan.runtimeContexts,
      'context',
      'installed runtime context catalog',
    );
    if (roleState === 'installed' && contextState === 'installed') {
      await ensureReport(options.report, effectiveReport);
      return;
    }
    state = { ...state, phase: 'prepared' };
    await writeCutoverState(options, state);
  }

  const roleStaging = `${options.runtimeRoleDir}.cutover-staging`;
  const contextStaging = `${options.runtimeContextDir}.cutover-staging`;
  await rm(roleStaging, { recursive: true, force: true });
  await rm(contextStaging, { recursive: true, force: true });
  await writeCatalog(roleStaging, plan.runtimeRoles);
  await writeCatalog(contextStaging, plan.runtimeContexts);

  await installCatalog(
    roleStaging,
    options.runtimeRoleDir,
    plan.runtimeRoles,
    'role',
    'runtime role target',
  );
  await hooks.afterRoleInstall?.();
  state = { ...state, phase: 'role-installed' };
  await writeCutoverState(options, state);

  await installCatalog(
    contextStaging,
    options.runtimeContextDir,
    plan.runtimeContexts,
    'context',
    'runtime context target',
  );
  await ensureReport(options.report, effectiveReport);
  state = { ...state, phase: 'completed' };
  await writeCutoverState(options, state);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'apply') assertServiceStopped(options.systemctl);
  const existingState = await readCutoverState(options);
  const plan = await buildPlan(options, {
    allowInstalledTargets: existingState != null,
  });
  const report = {
    ...plan.report,
    command: options.command,
    applied: options.command === 'apply',
    backupDir: existingState?.backupDir ?? options.backupDir,
  };
  if (options.command === 'apply') {
    await applyPlan(options, plan, report);
  } else {
    await writeReport(options.report, report);
  }
  process.stdout.write(`${JSON.stringify({
    ...plan.report,
    command: options.command,
    applied: options.command === 'apply',
  })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
