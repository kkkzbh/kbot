#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback, gzip as gzipCallback } from 'node:zlib';
import { compilePreset } from 'koishi-plugin-chatluna/preset-compiler';
import {
  convertPresetV1,
  migratePresetBindingKey,
  migratePresetReference,
  PRESET_V1_CONFLICT_MAP,
  PRESET_V1_ID_MAP,
} from 'koishi-plugin-chatluna/migration/preset-v2';
import { PresetDefinitionV2Schema } from 'koishi-plugin-chatluna/preset-schema';
import YAML from 'yaml';

process.umask(0o077);

const ROOT_DIR = process.cwd();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SQLITE_HELPER = join(SCRIPT_DIR, 'preset-v2-sqlite.py');
const gunzip = promisify(gunzipCallback);
const gzip = promisify(gzipCallback);
const PRESET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PRESET_FILE_PATTERN = /\.(?:ya?ml|txt)$/i;
const SYSTEMD_UNITS = ['qqbot.target', 'qqbot-koishi.service'];
const VALUE_OPTIONS = new Set([
  'database',
  'bundled-dir',
  'runtime-dir',
  'archive-source-root',
  'archive-target-root',
  'archive-staging-dir',
  'global-default',
  'report',
  'staging-dir',
  'backup-dir',
  'systemctl',
]);
const OBSOLETE_ORDER_FILES = new Set([
  '.admin-preset-order.json',
  '.bot-console-preset-order.json',
]);
const DISPLAY_NAME_OVERRIDES = {
  catgirl: '猫娘',
  empty: '空预设',
  sakiko: 'Sakiko',
  'sakiko-cold': 'sakiko（冷漠）',
  sydney: 'Sydney',
};

function usage() {
  return `Usage:
  node scripts/preset-v2-cutover.mjs preflight [options]
  node scripts/preset-v2-cutover.mjs apply [options] --confirm-service-stopped

Options:
  --database <path>         SQLite database (default: data/koishi.db)
  --bundled-dir <path>      Bundled preset directory
  --runtime-dir <path>      Runtime preset directory
  --archive-source-root <path>
                            Trusted legacy application archive root
  --archive-target-root <path>
                            Dedicated persistent archive root
  --archive-staging-dir <path>
                            Apply-only archive copy staging directory
  --global-default <id>     Required when the V1 database has no V2 meta value
  --report <path>           Write the migration report as JSON
  --staging-dir <path>      Apply-only V2 staging directory
  --backup-dir <path>       Apply-only backup directory
  --systemctl <path>        systemctl binary (default: /usr/bin/systemctl)
  --confirm-service-stopped Assert that qqbot.target is stopped
`;
}

function parseArgs(argv) {
  const command = argv[0];
  if (!['preflight', 'apply'].includes(command)) {
    throw new Error(usage());
  }

  const values = new Map();
  const flags = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    if (
      argument === '--confirm-service-stopped'
      || argument === '--fault-after-database-apply'
    ) {
      if (flags.has(argument.slice(2))) {
        throw new Error(`Duplicate argument: ${argument}`);
      }
      flags.add(argument.slice(2));
      continue;
    }
    const name = argument.slice(2);
    if (!VALUE_OPTIONS.has(name)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}`);
    }
    if (values.has(name)) {
      throw new Error(`Duplicate argument: ${argument}`);
    }
    values.set(name, value);
    index += 1;
  }

  const runtimeDir = resolve(values.get('runtime-dir') ?? join(ROOT_DIR, '.runtime/chathub/presets'));
  const archiveTargetRoot = values.has('archive-target-root')
    ? resolve(values.get('archive-target-root'))
    : null;
  const faultAfterDatabaseApply = flags.has('fault-after-database-apply');
  if (
    faultAfterDatabaseApply
    && process.env.QQBOT_PRESET_V2_ENABLE_FAULT_INJECTION !== '1'
  ) {
    throw new Error(
      '--fault-after-database-apply requires '
      + 'QQBOT_PRESET_V2_ENABLE_FAULT_INJECTION=1.',
    );
  }
  return {
    command,
    database: resolve(values.get('database') ?? join(ROOT_DIR, 'data/koishi.db')),
    bundledDir: resolve(values.get('bundled-dir') ?? join(ROOT_DIR, 'data/chathub/presets')),
    runtimeDir,
    archiveSourceRoot: values.has('archive-source-root')
      ? resolve(values.get('archive-source-root'))
      : null,
    archiveTargetRoot,
    archiveStagingDir: values.has('archive-staging-dir')
      ? resolve(values.get('archive-staging-dir'))
      : archiveTargetRoot == null
        ? null
        : resolve(`${archiveTargetRoot}.v2-staging`),
    globalDefault: values.get('global-default') ?? null,
    report: values.has('report') ? resolve(values.get('report')) : null,
    stagingDir: resolve(values.get('staging-dir') ?? `${runtimeDir}.v2-staging`),
    backupDir: values.has('backup-dir') ? resolve(values.get('backup-dir')) : null,
    systemctl: resolve(values.get('systemctl') ?? '/usr/bin/systemctl'),
    confirmServiceStopped: flags.has('confirm-service-stopped'),
    faultAfterDatabaseApply,
  };
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path, content) {
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, content, {
      flag: 'wx',
      mode: 0o600,
      ...(typeof content === 'string' ? { encoding: 'utf8' } : {}),
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function runChecked(command, args, operation) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  if (result.error != null) {
    throw new Error(`${operation}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${operation} failed with exit code ${result.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  return result.stdout.trim();
}

function assertSystemdServicesStopped(options) {
  for (const unit of SYSTEMD_UNITS) {
    const loadState = runChecked(
      options.systemctl,
      ['show', '--property=LoadState', '--value', unit],
      `Inspect ${unit} load state`,
    );
    if (loadState !== 'loaded') {
      throw new Error(`Systemd unit ${unit} must be loaded before Preset V2 apply: ${loadState}`);
    }
    const activeState = runChecked(
      options.systemctl,
      ['show', '--property=ActiveState', '--value', unit],
      `Inspect ${unit} active state`,
    );
    if (activeState !== 'inactive') {
      throw new Error(`Systemd unit ${unit} must be inactive before Preset V2 apply: ${activeState}`);
    }
  }
}

function isWithin(root, candidate) {
  const child = relative(root, candidate);
  return child.length > 0
    && child !== '..'
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child);
}

function pathsOverlap(left, right) {
  return left === right || isWithin(left, right) || isWithin(right, left);
}

async function assertExistingRealDirectory(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a real directory without symlinks: ${path}`);
  }
  const canonical = await realpath(path);
  if (canonical !== path) {
    throw new Error(`${label} must not contain symlink path components: ${path}`);
  }
  return canonical;
}

async function assertExistingRealFile(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`${label} must be a real file without symlinks: ${path}`);
  }
  const canonical = await realpath(path);
  if (canonical !== path) {
    throw new Error(`${label} must not contain symlink path components: ${path}`);
  }
  return canonical;
}

async function assertTrustedMissingPath(path, label) {
  let ancestor = path;
  while (!await pathExists(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  await assertExistingRealDirectory(ancestor, `${label} existing ancestor`);
}

function assertCutoverPathTopology(options) {
  const paths = [
    ['Database', options.database],
    ['Bundled preset directory', options.bundledDir],
    ['Runtime preset directory', options.runtimeDir],
    ['Preset staging directory', options.stagingDir],
    ...(options.backupDir == null ? [] : [['Backup directory', options.backupDir]]),
    ...(options.report == null ? [] : [['Report file', options.report]]),
    ...(options.archiveSourceRoot == null
      ? []
      : [['Archive source root', options.archiveSourceRoot]]),
    ...(options.archiveTargetRoot == null
      ? []
      : [['Archive target root', options.archiveTargetRoot]]),
    ...(options.archiveStagingDir == null
      ? []
      : [['Archive staging directory', options.archiveStagingDir]]),
  ];
  const filesystemRoot = resolve(sep);
  for (const [label, path] of paths) {
    if (path === filesystemRoot) {
      throw new Error(`${label} must be a scoped path: ${path}`);
    }
  }
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (pathsOverlap(paths[left][1], paths[right][1])) {
        throw new Error(
          `${paths[left][0]} and ${paths[right][0]} must use separate paths: `
          + `${paths[left][1]} <> ${paths[right][1]}`,
        );
      }
    }
  }
}

async function resolveArchiveRoots(options, archives) {
  if (archives.length === 0) {
    return { sourceRoot: null, targetRoot: null, stagingRoot: null };
  }
  if (options.archiveSourceRoot == null) {
    throw new Error(
      '--archive-source-root is required when recoverable archives exist.',
    );
  }
  if (options.archiveTargetRoot == null) {
    throw new Error(
      '--archive-target-root is required when recoverable archives exist.',
    );
  }
  if (options.archiveStagingDir == null) {
    throw new Error('Archive staging directory could not be resolved.');
  }

  const sourceRoot = resolve(options.archiveSourceRoot);
  const targetRoot = resolve(options.archiveTargetRoot);
  const stagingRoot = resolve(options.archiveStagingDir);
  const filesystemRoot = resolve(sourceRoot, sep);
  for (const [label, path] of [
    ['Archive source root', sourceRoot],
    ['Archive target root', targetRoot],
    ['Archive staging directory', stagingRoot],
  ]) {
    if (path === filesystemRoot) {
      throw new Error(`${label} must be a scoped directory: ${path}`);
    }
  }
  if (pathsOverlap(sourceRoot, targetRoot)) {
    throw new Error('Archive source and target roots must be separate directory trees.');
  }
  if (pathsOverlap(sourceRoot, stagingRoot) || pathsOverlap(targetRoot, stagingRoot)) {
    throw new Error(
      'Archive staging directory must be separate from source and target roots.',
    );
  }

  await assertExistingRealDirectory(sourceRoot, 'Archive source root');
  if (await pathExists(targetRoot)) {
    await assertExistingRealDirectory(targetRoot, 'Archive target root');
    const entries = await readdir(targetRoot);
    if (entries.length > 0) {
      throw new Error(`Archive target root must be empty before cutover: ${targetRoot}`);
    }
  } else {
    await assertTrustedMissingPath(targetRoot, 'Archive target root');
  }
  await assertTrustedMissingPath(stagingRoot, 'Archive staging directory');
  return { sourceRoot, targetRoot, stagingRoot };
}

async function collectArchiveTreeEntries(root, current = root, entries = []) {
  for (const name of (await readdir(current)).sort()) {
    const path = join(current, name);
    const info = await lstat(path);
    const relativePath = relative(root, path);
    if (info.isSymbolicLink()) {
      throw new Error(`Archive tree must not contain symlinks: ${path}`);
    }
    if (info.isDirectory()) {
      entries.push({ type: 'directory', path, relativePath });
      await collectArchiveTreeEntries(root, path, entries);
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`Archive tree contains an unsupported entry: ${path}`);
    }
    entries.push({ type: 'file', path, relativePath });
  }
  return entries;
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function hashArchiveArtifact(path, format) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(`Archive artifact must not be a symlink: ${path}`);
  }
  if (format === 'gzip') {
    if (!info.isFile()) {
      throw new Error(`Gzip archive must be a regular file: ${path}`);
    }
    return hashFile(path);
  }
  if (!info.isDirectory()) {
    throw new Error(`Directory archive must remain a directory: ${path}`);
  }
  const hash = createHash('sha256');
  for (const entry of await collectArchiveTreeEntries(path)) {
    hash.update(entry.type === 'directory' ? 'directory\0' : 'file\0');
    hash.update(entry.relativePath);
    hash.update('\0');
    if (entry.type === 'file') hash.update(await hashFile(entry.path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function inspectTrustedArchivePath(archive, sourceRoot, targetRoot) {
  if (!ARCHIVE_ID_PATTERN.test(archive.id)) {
    throw new Error(`Archive ID is unsafe for migration paths: ${archive.id}`);
  }
  if (!isAbsolute(archive.path)) {
    throw new Error(`Archive path must be absolute for offline migration: ${archive.path}`);
  }

  const candidate = resolve(archive.path);
  if (!isWithin(sourceRoot, candidate)) {
    throw new Error(`Archive path escapes the trusted source root: ${archive.path}`);
  }
  const info = await lstat(candidate);
  if (info.isSymbolicLink()) {
    throw new Error(`Archive path must not be a symlink: ${candidate}`);
  }
  const canonical = await realpath(candidate);
  if (canonical !== candidate || !isWithin(sourceRoot, canonical)) {
    throw new Error(`Archive path contains a symlink or escapes its source root: ${candidate}`);
  }

  const relativePath = relative(sourceRoot, canonical);
  const targetPath = resolve(targetRoot, relativePath);
  if (!isWithin(targetRoot, targetPath)) {
    throw new Error(`Archive target path escapes the configured target root: ${targetPath}`);
  }
  if (info.isFile()) {
    return {
      format: 'gzip',
      sourcePath: canonical,
      sourceContentPath: canonical,
      targetPath,
      targetContentPath: targetPath,
      relativePath,
    };
  }
  if (!info.isDirectory()) {
    throw new Error(`Archive path must be a directory or gzip file: ${candidate}`);
  }

  const sourceContentPath = join(canonical, 'conversation.json');
  const fileInfo = await lstat(sourceContentPath);
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
    throw new Error(
      `Archive conversation must be a regular file without symlinks: ${sourceContentPath}`,
    );
  }
  const canonicalFile = await realpath(sourceContentPath);
  if (canonicalFile !== sourceContentPath || !isWithin(sourceRoot, canonicalFile)) {
    throw new Error(`Archive conversation escapes its source root: ${sourceContentPath}`);
  }
  await collectArchiveTreeEntries(canonical);
  return {
    format: 'directory',
    sourcePath: canonical,
    sourceContentPath: canonicalFile,
    targetPath,
    targetContentPath: join(targetPath, 'conversation.json'),
    relativePath,
  };
}

async function assertSourceArchiveUnchanged(change) {
  const currentArtifactHash = await hashArchiveArtifact(change.sourcePath, change.format);
  if (currentArtifactHash !== change.sourceArtifactHash) {
    throw new Error(`Archive changed after preflight: ${change.sourcePath}`);
  }
  const currentContent = await readFile(change.sourceContentPath);
  if (sha256(currentContent) !== change.sourceContentHash) {
    throw new Error(`Archive conversation changed after preflight: ${change.sourceContentPath}`);
  }
}

function runSqlite(operation, database, destination, payload) {
  const args = [SQLITE_HELPER, operation, database];
  if (destination != null) args.push(destination);
  const result = spawnSync('python3', args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    input: payload == null ? undefined : JSON.stringify(payload),
    maxBuffer: 64 * 1024 * 1024,
  });
  let output = null;
  try {
    output = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  } catch {
    // The process result below contains the actionable parse failure.
  }
  if (result.status !== 0 || output?.error) {
    throw new Error(
      output?.error
      ?? result.stderr.trim()
      ?? `SQLite helper failed with exit code ${result.status}`,
    );
  }
  return output;
}

function canonicalIdForLegacyFile(fileName) {
  const stem = fileName.replace(/\.(?:ya?ml|txt)$/i, '');
  const mapped = PRESET_V1_ID_MAP[stem];
  if (mapped != null) return mapped;
  if (PRESET_ID_PATTERN.test(stem)) return stem;
  throw new Error(`Preset V1 file has no canonical ID mapping: ${fileName}`);
}

async function readPresetDirectory(directory, source) {
  if (!await pathExists(directory)) {
    if (source === 'runtime') {
      await assertTrustedMissingPath(directory, 'Runtime preset directory');
      return { records: [], obsoleteFiles: [] };
    }
    throw new Error(`Bundled preset directory does not exist: ${directory}`);
  }

  await assertExistingRealDirectory(
    directory,
    source === 'runtime'
      ? 'Runtime preset directory'
      : 'Bundled preset directory',
  );

  const records = [];
  const obsoleteFiles = [];
  const ids = new Set();
  const names = (await readdir(directory)).sort();
  for (const name of names) {
    const filePath = join(directory, name);
    const fileStat = await lstat(filePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error(`Preset entry must be a real regular file: ${filePath}`);
    }
    if (OBSOLETE_ORDER_FILES.has(name)) {
      obsoleteFiles.push(filePath);
      continue;
    }
    if (!PRESET_FILE_PATTERN.test(name)) {
      throw new Error(`Unsupported preset directory entry would be discarded: ${filePath}`);
    }
    const raw = await readFile(filePath, 'utf8');
    const parsed = YAML.parse(raw);
    let definition;
    let migratedFromV1 = false;
    if (parsed?.schemaVersion === 2) {
      definition = PresetDefinitionV2Schema.parse(parsed);
      if (name !== `${definition.id}.yml`) {
        throw new Error(
          `Preset V2 file name must be <id>.yml: ${filePath} declares ${definition.id}`,
        );
      }
    } else {
      const id = canonicalIdForLegacyFile(name);
      definition = convertPresetV1({
        filePath,
        raw,
        id,
        displayName: DISPLAY_NAME_OVERRIDES[id],
      });
      migratedFromV1 = true;
    }

    if (ids.has(definition.id)) {
      throw new Error(`Duplicate canonical preset ID in ${directory}: ${definition.id}`);
    }
    ids.add(definition.id);
    records.push({
      source,
      filePath,
      rawHash: sha256(raw),
      migratedFromV1,
      definition: structuredClone(definition),
    });
  }
  return { records, obsoleteFiles };
}

function resolveIdentityConflicts(effectiveRecords) {
  const ownersByName = new Map();
  for (const record of effectiveRecords) {
    const identities = [
      { value: record.definition.id, canonical: true },
      ...record.definition.aliases.map((value) => ({ value, canonical: false })),
    ];
    for (const identity of identities) {
      const key = identity.value.toLowerCase();
      const owners = ownersByName.get(key) ?? [];
      owners.push({ record, canonical: identity.canonical });
      ownersByName.set(key, owners);
    }
  }

  const resolutions = [];
  for (const [name, owners] of ownersByName) {
    const ownerIds = [...new Set(owners.map(({ record }) => record.definition.id))];
    if (ownerIds.length < 2) continue;
    const selectedId = PRESET_V1_CONFLICT_MAP[name];
    if (selectedId == null || !ownerIds.includes(selectedId)) {
      throw new Error(
        `Preset identity is ambiguous without an explicit conflict mapping: `
        + `${name} -> ${ownerIds.join(', ')}`,
      );
    }

    for (const owner of owners) {
      if (owner.record.definition.id === selectedId) continue;
      if (owner.canonical) {
        throw new Error(
          `Explicit conflict mapping cannot replace canonical preset ID `
          + `${owner.record.definition.id}`,
        );
      }
      if (owner.record.source === 'bundled') {
        throw new Error(
          `Bundled V2 preset still contains a conflicting alias: `
          + `${owner.record.filePath} (${name})`,
        );
      }
      owner.record.definition.aliases = owner.record.definition.aliases.filter(
        (alias) => alias.toLowerCase() !== name,
      );
    }
    resolutions.push({ identity: name, selectedId, candidates: ownerIds });
  }

  for (const record of effectiveRecords) {
    record.definition = PresetDefinitionV2Schema.parse(record.definition);
  }
  return resolutions;
}

function createMigrationPlan(bundledRecords, runtimeRecords) {
  const effective = new Map();
  for (const record of bundledRecords) effective.set(record.definition.id, record);
  for (const record of runtimeRecords) effective.set(record.definition.id, record);
  if (effective.size === 0) {
    throw new Error('Preset catalog is empty.');
  }

  const effectiveRecords = [...effective.values()];
  const conflictResolutions = resolveIdentityConflicts(effectiveRecords);
  const references = new Map();
  for (const record of effectiveRecords) {
    references.set(record.definition.id, record.definition.id);
    for (const alias of record.definition.aliases) {
      references.set(alias.toLowerCase(), record.definition.id);
    }
  }
  for (const [identity, id] of Object.entries(PRESET_V1_CONFLICT_MAP)) {
    if (!effective.has(id)) continue;
    const key = identity.toLowerCase();
    const existing = references.get(key);
    if (existing != null && existing !== id) {
      throw new Error(
        `Explicit conflict mapping would replace canonical or unique identity: `
        + `${identity} -> ${existing}, requested ${id}`,
      );
    }
    references.set(key, id);
  }

  return {
    definitions: effectiveRecords.map((record) => record.definition),
    references,
    effectiveRecords,
    runtimeRecords,
    conflictResolutions,
  };
}

function migrateReference(value, plan, location) {
  try {
    return migratePresetReference(value, plan);
  } catch (error) {
    throw new Error(`${location}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function migrateBindingKey(value, plan, location) {
  try {
    return migratePresetBindingKey(value, plan);
  } catch (error) {
    throw new Error(`${location}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function addReferenceChange(changes, plan, table, row, column, label, required = false) {
  const before = row[column];
  if (before == null) {
    if (required) throw new Error(`${label}: preset reference is required`);
    return;
  }
  if (typeof before !== 'string' || before.length === 0) {
    throw new Error(`${label}: preset reference must be a canonical ID or unique alias`);
  }
  const after = migrateReference(before, plan, label);
  if (after === before) return;
  changes.push({ table, rowid: row._rowid, column, from: before, to: after });
}

function addBindingChange(changes, plan, table, row, column, label) {
  const before = row[column];
  if (typeof before !== 'string' || before.length === 0) {
    throw new Error(`${label}: binding key must be a non-empty string`);
  }
  if (!before.includes(':preset:')) return;
  const after = migrateBindingKey(before, plan, label);
  if (after === before) return;
  changes.push({ table, rowid: row._rowid, column, from: before, to: after });
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function timestampValue(value, label) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    if (/^-?\d+(?:\.\d+)?$/u.test(value)) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`${label}: timestamp must be a finite number or parseable date string`);
}

function migratedBindingTarget(bindingKey, plan, label) {
  if (typeof bindingKey !== 'string' || bindingKey.length === 0) {
    throw new Error(`${label}: binding key must be a non-empty string`);
  }
  if (!bindingKey.includes(':preset:')) return bindingKey;
  return migrateBindingKey(bindingKey, plan, label);
}

function bindingSourceRow(row) {
  return {
    rowid: row._rowid,
    bindingKey: row.bindingKey,
    activeConversationId: row.activeConversationId ?? null,
    lastConversationId: row.lastConversationId ?? null,
    updatedAt: row.updatedAt,
  };
}

function buildBindingPlans(database, plan, conversationTargets) {
  const grouped = new Map();
  for (const row of database.bindings) {
    const target = migratedBindingTarget(
      row.bindingKey,
      plan,
      `chatluna_binding(${row.bindingKey}).bindingKey`,
    );
    const group = grouped.get(target) ?? [];
    group.push(row);
    grouped.set(target, group);
  }

  const conversationById = new Map();
  for (const row of database.conversations) {
    if (conversationById.has(row.id)) {
      throw new Error(`Duplicate conversation ID in migration snapshot: ${row.id}`);
    }
    conversationById.set(row.id, row);
  }

  const bindingPlans = [];
  const bindingMerges = [];
  const targets = [...grouped.keys()].sort(compareStrings);
  for (const targetBindingKey of targets) {
    const sourceRows = grouped.get(targetBindingKey).slice().sort(
      (left, right) => compareStrings(left.bindingKey, right.bindingKey)
        || left._rowid - right._rowid,
    );
    const isMerge = sourceRows.length > 1;
    if (!isMerge && sourceRows[0].bindingKey === targetBindingKey) continue;

    const keeper = sourceRows.find((row) => row.bindingKey === targetBindingKey)
      ?? sourceRows[0];
    for (const row of sourceRows) {
      timestampValue(
        row.updatedAt,
        `chatluna_binding(${row.bindingKey}).updatedAt`,
      );
    }
    let activeConversationId = sourceRows[0].activeConversationId ?? null;
    let lastConversationId = sourceRows[0].lastConversationId ?? null;
    let updatedAt = sourceRows[0].updatedAt;
    const excludedCandidates = [];

    if (isMerge) {
      const timestampedRows = sourceRows.map((row) => ({
        row,
        timestamp: timestampValue(
          row.updatedAt,
          `chatluna_binding(${row.bindingKey}).updatedAt`,
        ),
      })).sort((left, right) => right.timestamp - left.timestamp
        || compareStrings(left.row.bindingKey, right.row.bindingKey)
        || left.row._rowid - right.row._rowid);
      updatedAt = timestampedRows[0].row.updatedAt;

      const candidates = [];
      for (const { row, timestamp } of timestampedRows) {
        for (const field of ['activeConversationId', 'lastConversationId']) {
          const conversationId = row[field];
          if (conversationId == null) continue;
          if (typeof conversationId !== 'string' || conversationId.length === 0) {
            excludedCandidates.push({
              sourceBindingKey: row.bindingKey,
              field,
              conversationId,
              reason: 'invalid-conversation-id',
            });
            continue;
          }
          const conversation = conversationById.get(conversationId);
          if (conversation == null) {
            excludedCandidates.push({
              sourceBindingKey: row.bindingKey,
              field,
              conversationId,
              reason: 'conversation-missing',
            });
            continue;
          }
          if (conversationTargets.get(conversation._rowid) !== targetBindingKey) {
            excludedCandidates.push({
              sourceBindingKey: row.bindingKey,
              field,
              conversationId,
              reason: 'conversation-belongs-to-another-binding',
            });
            continue;
          }
          candidates.push({
            conversationId,
            field,
            sourceBindingKey: row.bindingKey,
            sourceRowid: row._rowid,
            timestamp,
          });
        }
      }

      const candidateOrder = (preferredField) => (left, right) => (
        right.timestamp - left.timestamp
        || Number(right.field === preferredField) - Number(left.field === preferredField)
        || compareStrings(left.sourceBindingKey, right.sourceBindingKey)
        || left.sourceRowid - right.sourceRowid
        || compareStrings(left.conversationId, right.conversationId)
      );
      const activeCandidate = candidates
        .filter((candidate) => candidate.field === 'activeConversationId')
        .sort(candidateOrder('activeConversationId'))[0];
      activeConversationId = activeCandidate?.conversationId ?? null;

      const seenLastCandidates = new Set();
      const remaining = candidates
        .filter((candidate) => candidate.conversationId !== activeConversationId)
        .sort(candidateOrder('lastConversationId'))
        .filter((candidate) => {
          if (seenLastCandidates.has(candidate.conversationId)) return false;
          seenLastCandidates.add(candidate.conversationId);
          return true;
        });
      lastConversationId = remaining[0]?.conversationId ?? null;
    }

    const operation = {
      targetBindingKey,
      sourceRows: sourceRows.map(bindingSourceRow),
      keeperRowid: keeper._rowid,
      activeConversationId,
      lastConversationId,
      updatedAt,
    };
    bindingPlans.push(operation);
    if (isMerge) {
      bindingMerges.push({
        targetBindingKey,
        sourceBindingKeys: sourceRows.map((row) => row.bindingKey),
        keeperSourceBindingKey: keeper.bindingKey,
        removedSourceBindingKeys: sourceRows
          .filter((row) => row._rowid !== keeper._rowid)
          .map((row) => row.bindingKey),
        activeConversationId,
        lastConversationId,
        updatedAt,
        excludedCandidates,
      });
    }
  }
  return { bindingPlans, bindingMerges, bindingGroups: grouped };
}

function validConversationSequence(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function buildConversationSequenceChanges(
  database,
  conversationTargets,
  bindingGroups,
) {
  const grouped = new Map();
  for (const row of database.conversations) {
    const target = conversationTargets.get(row._rowid);
    const group = grouped.get(target) ?? [];
    group.push(row);
    grouped.set(target, group);
  }

  const changes = [];
  const renumbers = [];
  for (const targetBindingKey of [...grouped.keys()].sort(compareStrings)) {
    const conversations = grouped.get(targetBindingKey);
    const sourceBindingKeys = new Set(conversations.map((row) => row.bindingKey));
    const mergedBindingRowCount = bindingGroups.get(targetBindingKey)?.length ?? 0;
    if (sourceBindingKeys.size < 2 && mergedBindingRowCount < 2) continue;

    const counts = new Map();
    for (const row of conversations) {
      const seq = validConversationSequence(row.seq);
      if (seq != null) counts.set(seq, (counts.get(seq) ?? 0) + 1);
    }
    const occupied = new Set(
      [...counts.entries()]
        .filter(([, count]) => count === 1)
        .map(([seq]) => seq),
    );
    const pending = conversations
      .filter((row) => {
        const seq = validConversationSequence(row.seq);
        return seq == null || counts.get(seq) !== 1;
      })
      .map((row) => ({
        row,
        createdAt: timestampValue(
          row.createdAt,
          `chatluna_conversation(${row.id}).createdAt`,
        ),
        updatedAt: timestampValue(
          row.updatedAt,
          `chatluna_conversation(${row.id}).updatedAt`,
        ),
        seq: validConversationSequence(row.seq),
      }))
      .sort((left, right) => left.createdAt - right.createdAt
        || (left.seq ?? Number.MAX_SAFE_INTEGER) - (right.seq ?? Number.MAX_SAFE_INTEGER)
        || left.updatedAt - right.updatedAt
        || compareStrings(left.row.id, right.row.id));

    let candidate = 1;
    for (const item of pending) {
      while (occupied.has(candidate)) candidate += 1;
      const nextSeq = candidate;
      occupied.add(nextSeq);
      candidate += 1;
      if (item.row.seq === nextSeq) continue;
      changes.push({
        table: 'chatluna_conversation',
        rowid: item.row._rowid,
        column: 'seq',
        from: item.row.seq,
        to: nextSeq,
      });
      renumbers.push({
        targetBindingKey,
        conversationId: item.row.id,
        sourceBindingKey: item.row.bindingKey,
        from: item.row.seq,
        to: nextSeq,
        createdAt: item.row.createdAt,
      });
    }

    const finalSequences = conversations.map((row) => {
      const renumber = renumbers.find(
        (change) => change.targetBindingKey === targetBindingKey
          && change.conversationId === row.id,
      );
      return renumber?.to ?? validConversationSequence(row.seq);
    });
    if (
      finalSequences.some((seq) => seq == null)
      || new Set(finalSequences).size !== finalSequences.length
    ) {
      throw new Error(
        `Conversation sequence plan is not unique for binding: ${targetBindingKey}`,
      );
    }
  }
  return { changes, renumbers };
}

function parseGlobalDefault(databaseValue, explicitValue, plan) {
  let databaseIdentity = null;
  if (databaseValue != null) {
    try {
      const parsed = JSON.parse(databaseValue);
      if (typeof parsed !== 'string' || parsed.length === 0) {
        throw new Error('value must be a non-empty string');
      }
      databaseIdentity = parsed;
    } catch {
      throw new Error('chatluna_meta.globalDefaultPresetId is not valid JSON.');
    }
  }
  if (databaseIdentity != null && explicitValue != null) {
    const live = migrateReference(databaseIdentity, plan, 'stored global default preset');
    const requested = migrateReference(explicitValue, plan, 'explicit global default preset');
    if (live !== requested) {
      throw new Error(
        `--global-default conflicts with the stored live default: ${requested} != ${live}`,
      );
    }
    return live;
  }
  const value = databaseIdentity ?? explicitValue;
  if (value == null) {
    throw new Error(
      'Global default is missing. Pass --global-default with the current V1 preset identity.',
    );
  }
  return migrateReference(value, plan, 'global default preset');
}

function buildDatabaseMigration(database, plan) {
  const changes = [];
  const conversationTargets = new Map();
  for (const row of database.conversations) {
    addReferenceChange(
      changes,
      plan,
      'chatluna_conversation',
      row,
      'preset',
      `chatluna_conversation(${row.id}).preset`,
      true,
    );
    const targetBindingKey = migratedBindingTarget(
      row.bindingKey,
      plan,
      `chatluna_conversation(${row.id}).bindingKey`,
    );
    conversationTargets.set(row._rowid, targetBindingKey);
    addBindingChange(
      changes,
      plan,
      'chatluna_conversation',
      row,
      'bindingKey',
      `chatluna_conversation(${row.id}).bindingKey`,
    );
  }
  for (const row of database.constraints) {
    for (const column of ['activePresetLane', 'defaultPreset', 'fixedPreset']) {
      addReferenceChange(
        changes,
        plan,
        'chatluna_constraint',
        row,
        column,
        `chatluna_constraint(rowid=${row._rowid}).${column}`,
      );
    }
  }
  for (const row of database.rooms) {
    addReferenceChange(
      changes,
      plan,
      'chathub_room',
      row,
      'preset',
      `chathub_room(${row.roomId}).preset`,
    );
  }

  const binding = buildBindingPlans(database, plan, conversationTargets);
  const sequence = buildConversationSequenceChanges(
    database,
    conversationTargets,
    binding.bindingGroups,
  );
  changes.push(...sequence.changes);
  return {
    changes,
    bindingPlans: binding.bindingPlans,
    bindingMerges: binding.bindingMerges,
    conversationSeqRenumbers: sequence.renumbers,
  };
}

async function buildArchiveChanges(database, plan, options) {
  const changes = [];
  const recoverable = database.archives.filter((archive) => archive.state !== 'broken');
  for (const archive of recoverable) {
    if (archive.state !== 'ready') {
      throw new Error(`Archive ${archive.id} is not stable for migration: ${archive.state}`);
    }
  }
  const roots = await resolveArchiveRoots(options, recoverable);
  for (const archive of recoverable) {
    const archiveFile = await inspectTrustedArchivePath(
      archive,
      roots.sourceRoot,
      roots.targetRoot,
    );
    for (const existing of changes) {
      if (pathsOverlap(existing.sourcePath, archiveFile.sourcePath)) {
        throw new Error(
          `Recoverable archive paths overlap: ${existing.sourcePath} and `
          + `${archiveFile.sourcePath}`,
        );
      }
      if (pathsOverlap(existing.targetPath, archiveFile.targetPath)) {
        throw new Error(
          `Archive target paths overlap: ${existing.targetPath} and `
          + `${archiveFile.targetPath}`,
        );
      }
    }
    if (await pathExists(archiveFile.targetPath)) {
      throw new Error(`Archive target already exists: ${archiveFile.targetPath}`);
    }

    const sourceArtifactHash = await hashArchiveArtifact(
      archiveFile.sourcePath,
      archiveFile.format,
    );
    const raw = await readFile(archiveFile.sourceContentPath);
    let archivePayload = null;
    let conversation;
    if (archiveFile.format === 'directory') {
      conversation = JSON.parse(raw.toString('utf8'));
    } else {
      archivePayload = JSON.parse((await gunzip(raw)).toString('utf8'));
      if (
        archivePayload == null
        || typeof archivePayload !== 'object'
        || Array.isArray(archivePayload)
      ) {
        throw new Error(`Gzip archive payload is invalid: ${archiveFile.sourceContentPath}`);
      }
      conversation = archivePayload.conversation;
    }
    if (conversation == null || typeof conversation !== 'object' || Array.isArray(conversation)) {
      throw new Error(`Archive conversation is invalid: ${archiveFile.sourceContentPath}`);
    }
    const next = structuredClone(conversation);
    const fieldChanges = [];
    if (typeof next.preset !== 'string' || next.preset.length === 0) {
      throw new Error(
        `archive(${archive.id}).conversation.preset must be a canonical ID or unique alias`,
      );
    }
    const migratedPreset = migrateReference(
      next.preset,
      plan,
      `archive(${archive.id}).conversation.preset`,
    );
    if (migratedPreset !== next.preset) {
      fieldChanges.push({ field: 'preset', from: next.preset, to: migratedPreset });
      next.preset = migratedPreset;
    }
    if (typeof next.bindingKey !== 'string' || next.bindingKey.length === 0) {
      throw new Error(`archive(${archive.id}).conversation.bindingKey must be non-empty`);
    }
    if (next.bindingKey.includes(':preset:')) {
      const migrated = migrateBindingKey(
        next.bindingKey,
        plan,
        `archive(${archive.id}).conversation.bindingKey`,
      );
      if (migrated !== next.bindingKey) {
        fieldChanges.push({ field: 'bindingKey', from: next.bindingKey, to: migrated });
        next.bindingKey = migrated;
      }
    }
    const content = archiveFile.format === 'directory'
      ? Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8')
      : await gzip(Buffer.from(JSON.stringify({
        ...archivePayload,
        conversation: next,
      }), 'utf8'));
    changes.push({
      archiveId: archive.id,
      format: archiveFile.format,
      sourceDatabasePath: archive.path,
      sourcePath: archiveFile.sourcePath,
      sourceContentPath: archiveFile.sourceContentPath,
      targetPath: archiveFile.targetPath,
      targetContentPath: archiveFile.targetContentPath,
      relativePath: archiveFile.relativePath,
      sourceArtifactHash,
      sourceContentHash: sha256(raw),
      targetContentHash: sha256(content),
      fieldChanges,
      content,
    });
  }
  return { changes, roots };
}

function reportFor(result, options) {
  return {
    schemaVersion: 2,
    mode: 'preflight',
    createdAt: new Date().toISOString(),
    inputs: {
      database: options.database,
      bundledDir: options.bundledDir,
      runtimeDir: options.runtimeDir,
      archiveSourceRoot: options.archiveSourceRoot,
      archiveTargetRoot: options.archiveTargetRoot,
      archiveStagingDir: options.archiveStagingDir,
    },
    globalDefaultPresetId: result.globalDefaultPresetId,
    presets: result.plan.effectiveRecords
      .map((record) => ({
        id: record.definition.id,
        displayName: record.definition.displayName,
        aliases: record.definition.aliases,
        source: record.source,
        filePath: record.filePath,
        sourceHash: record.rawHash,
        migratedFromV1: record.migratedFromV1,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    conflictResolutions: result.plan.conflictResolutions,
    removedObsoleteOrderFiles: result.obsoleteFiles,
    databaseChanges: result.databaseChanges,
    bindingPlans: result.bindingPlans,
    bindingMerges: result.bindingMerges,
    conversationSeqRenumbers: result.conversationSeqRenumbers,
    archiveChanges: result.archiveChanges.map(({ content: _content, ...change }) => change),
    archiveSourceRetention: {
      status: 'retained-until-finalize',
      sourceRoot: result.archiveRoots.sourceRoot,
      sourcePaths: result.archiveChanges.map((change) => change.sourcePath),
    },
    summary: {
      presetCount: result.plan.effectiveRecords.length,
      runtimePresetCount: result.plan.runtimeRecords.length,
      migratedV1FileCount: [
        ...result.bundledRecords,
        ...result.runtimeRecords,
      ].filter((record) => record.migratedFromV1).length,
      databaseChangeCount: result.databaseChanges.length
        + result.bindingPlans.reduce(
          (count, bindingPlan) => count + bindingPlan.sourceRows.length,
          0,
        ),
      bindingMergeCount: result.bindingMerges.length,
      bindingRowsRemovedCount: result.bindingMerges.reduce(
        (count, merge) => count + merge.removedSourceBindingKeys.length,
        0,
      ),
      conversationSeqRenumberCount: result.conversationSeqRenumbers.length,
      archiveChangeCount: result.archiveChanges.length,
      archiveRelocationCount: result.archiveChanges.length,
      removedObsoleteOrderFileCount: result.obsoleteFiles.length,
    },
  };
}

async function preflight(options) {
  assertCutoverPathTopology(options);
  await assertExistingRealFile(options.database, 'Database');
  const [bundled, runtime] = await Promise.all([
    readPresetDirectory(options.bundledDir, 'bundled'),
    readPresetDirectory(options.runtimeDir, 'runtime'),
  ]);
  const bundledRecords = bundled.records;
  const runtimeRecords = runtime.records;
  const plan = createMigrationPlan(bundledRecords, runtimeRecords);
  for (const record of plan.effectiveRecords) {
    const raw = YAML.stringify(record.definition, { lineWidth: 100 });
    compilePreset(record.definition, {
      source: record.source,
      raw,
      path: record.filePath,
      handlers: new Map(),
    });
  }
  const database = runSqlite('inspect', options.database, null, null);
  const globalDefaultPresetId = parseGlobalDefault(
    database.globalDefaultValue,
    options.globalDefault,
    plan,
  );
  if (!plan.definitions.some((definition) => definition.id === globalDefaultPresetId)) {
    throw new Error(`Global default preset is not in the effective catalog: ${globalDefaultPresetId}`);
  }
  const databaseMigration = buildDatabaseMigration(database, plan);
  const archivePlan = await buildArchiveChanges(database, plan, options);
  const result = {
    bundledRecords,
    runtimeRecords,
    obsoleteFiles: [...bundled.obsoleteFiles, ...runtime.obsoleteFiles],
    plan,
    database,
    globalDefaultPresetId,
    databaseChanges: databaseMigration.changes,
    bindingPlans: databaseMigration.bindingPlans,
    bindingMerges: databaseMigration.bindingMerges,
    conversationSeqRenumbers: databaseMigration.conversationSeqRenumbers,
    archiveChanges: archivePlan.changes,
    archiveRoots: archivePlan.roots,
  };
  const report = reportFor(result, options);
  if (options.report != null) {
    await writeAtomic(options.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  return { result, report };
}

async function prepareStagingDirectory(options, result) {
  if (await pathExists(options.stagingDir)) {
    throw new Error(`Staging directory already exists: ${options.stagingDir}`);
  }
  await assertTrustedMissingPath(options.stagingDir, 'Preset staging directory');
  const parent = dirname(options.stagingDir);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertExistingRealDirectory(parent, 'Preset staging parent directory');

  let stagingOwned = false;
  try {
    await mkdir(options.stagingDir, { recursive: false, mode: 0o700 });
    stagingOwned = true;
    for (const record of result.runtimeRecords.sort(
      (left, right) => left.definition.id.localeCompare(right.definition.id),
    )) {
      const validated = PresetDefinitionV2Schema.parse(record.definition);
      const raw = YAML.stringify(validated, { lineWidth: 100 });
      const roundTrip = PresetDefinitionV2Schema.parse(YAML.parse(raw));
      if (roundTrip.id !== validated.id) {
        throw new Error(`Staged preset round-trip changed canonical ID: ${validated.id}`);
      }
      compilePreset(roundTrip, {
        source: 'runtime',
        raw,
        path: join(options.stagingDir, `${validated.id}.yml`),
        handlers: new Map(),
      });
      await writeFile(join(options.stagingDir, `${validated.id}.yml`), raw, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    }
  } catch (error) {
    if (stagingOwned) {
      await rm(options.stagingDir, { recursive: true, force: true });
    }
    throw error;
  }
}

async function prepareArchiveStaging(result) {
  if (result.archiveChanges.length === 0) {
    return {
      targetRootExisted: false,
      stagingCreated: false,
      stagedChanges: [],
    };
  }
  const { targetRoot, stagingRoot } = result.archiveRoots;
  if (await pathExists(stagingRoot)) {
    throw new Error(`Archive staging directory already exists: ${stagingRoot}`);
  }
  const targetRootExisted = await pathExists(targetRoot);
  if (!targetRootExisted) {
    await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  }
  await assertExistingRealDirectory(targetRoot, 'Archive target root');
  if ((await readdir(targetRoot)).length > 0) {
    throw new Error(`Archive target root must remain empty before staging: ${targetRoot}`);
  }

  let stagingCreated = false;
  try {
    await mkdir(stagingRoot, { recursive: false, mode: 0o700 });
    stagingCreated = true;
    const stagedChanges = [];
    for (const change of result.archiveChanges) {
      await assertSourceArchiveUnchanged(change);
      const stagedPath = resolve(stagingRoot, change.relativePath);
      if (!isWithin(stagingRoot, stagedPath)) {
        throw new Error(`Staged archive escapes its staging root: ${stagedPath}`);
      }
      const stagedContentPath = change.format === 'directory'
        ? join(stagedPath, 'conversation.json')
        : stagedPath;
      await mkdir(dirname(stagedPath), { recursive: true, mode: 0o700 });
      await cp(change.sourcePath, stagedPath, {
        recursive: change.format === 'directory',
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
      });
      const copiedArtifactHash = await hashArchiveArtifact(stagedPath, change.format);
      if (copiedArtifactHash !== change.sourceArtifactHash) {
        throw new Error(`Staged archive copy failed hash verification: ${change.sourcePath}`);
      }
      await assertSourceArchiveUnchanged(change);
      await writeAtomic(stagedContentPath, change.content);
      const stagedContent = await readFile(stagedContentPath);
      if (sha256(stagedContent) !== change.targetContentHash) {
        throw new Error(`Staged archive content failed hash verification: ${stagedContentPath}`);
      }
      const targetArtifactHash = await hashArchiveArtifact(stagedPath, change.format);
      stagedChanges.push({
        ...change,
        stagedPath,
        stagedContentPath,
        targetArtifactHash,
      });
    }
    return { targetRootExisted, stagingCreated, stagedChanges };
  } catch (error) {
    if (stagingCreated) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
    if (!targetRootExisted) {
      try {
        await rmdir(targetRoot);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Archive staging failed and target root cleanup was incomplete.',
        );
      }
    }
    throw error;
  }
}

async function backupLegacyArchives(result, backupDir) {
  if (result.archiveChanges.length === 0) return null;
  const root = join(backupDir, 'legacy-archive-source');
  await mkdir(root, { recursive: false, mode: 0o700 });
  for (const change of result.archiveChanges) {
    await assertSourceArchiveUnchanged(change);
    const target = resolve(root, change.relativePath);
    if (!isWithin(root, target)) {
      throw new Error(`Legacy archive backup escapes its backup root: ${target}`);
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await cp(change.sourcePath, target, {
      recursive: change.format === 'directory',
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    if (await hashArchiveArtifact(target, change.format) !== change.sourceArtifactHash) {
      throw new Error(`Legacy archive backup failed hash verification: ${change.sourcePath}`);
    }
  }
  return root;
}

async function activateStagedArchives(result, archiveState) {
  if (result.archiveChanges.length === 0) return [];
  const activatedPaths = [];
  try {
    for (const change of archiveState.stagedChanges) {
      await assertSourceArchiveUnchanged(change);
      if (await pathExists(change.targetPath)) {
        throw new Error(`Archive target appeared during cutover: ${change.targetPath}`);
      }
      await mkdir(dirname(change.targetPath), { recursive: true, mode: 0o700 });
      await rename(change.stagedPath, change.targetPath);
      activatedPaths.push(change.targetPath);
      const targetArtifactHash = await hashArchiveArtifact(
        change.targetPath,
        change.format,
      );
      if (targetArtifactHash !== change.targetArtifactHash) {
        throw new Error(
          `Activated archive failed hash verification: ${change.targetPath}`,
        );
      }
    }
    await rm(result.archiveRoots.stagingRoot, { recursive: true, force: true });
    archiveState.stagingCreated = false;
    return activatedPaths;
  } catch (error) {
    archiveState.activatedPaths = activatedPaths;
    throw error;
  }
}

async function removeActivatedArchives(result, archiveState) {
  if (result.archiveChanges.length === 0) return;
  const targetRoot = result.archiveRoots.targetRoot;
  for (const targetPath of [...archiveState.activatedPaths].sort(
    (left, right) => right.length - left.length,
  )) {
    if (!isWithin(targetRoot, targetPath)) {
      throw new Error(`Refusing to remove archive outside target root: ${targetPath}`);
    }
    await rm(targetPath, { recursive: true, force: true });
    let parent = dirname(targetPath);
    while (parent !== targetRoot && isWithin(targetRoot, parent)) {
      try {
        await rmdir(parent);
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error;
        break;
      }
      parent = dirname(parent);
    }
  }
  archiveState.activatedPaths = [];
  if (archiveState.stagingCreated) {
    await rm(result.archiveRoots.stagingRoot, { recursive: true, force: true });
    archiveState.stagingCreated = false;
  }
  if (!archiveState.targetRootExisted) {
    await rmdir(targetRoot);
  }
}

async function apply(options) {
  assertCutoverPathTopology(options);
  if (!options.confirmServiceStopped) {
    throw new Error(
      'Apply requires --confirm-service-stopped after system-level qqbot.target is stopped.',
    );
  }
  assertSystemdServicesStopped(options);
  if (options.backupDir == null) {
    throw new Error('Apply requires --backup-dir.');
  }
  if (await pathExists(options.backupDir)) {
    throw new Error(`Backup directory already exists: ${options.backupDir}`);
  }
  await assertTrustedMissingPath(options.backupDir, 'Backup directory');

  const { result, report } = await preflight({ ...options, report: null });
  await mkdir(dirname(options.backupDir), { recursive: true, mode: 0o700 });
  await mkdir(options.backupDir, { recursive: false, mode: 0o700 });
  await chmod(options.backupDir, 0o700);

  const databaseBackup = join(options.backupDir, 'koishi.db');
  runSqlite('backup', options.database, databaseBackup, null);
  const runtimeBackup = join(options.backupDir, 'runtime-presets');
  if (await pathExists(options.runtimeDir)) {
    await cp(options.runtimeDir, runtimeBackup, { recursive: true, errorOnExist: true });
  } else {
    await mkdir(runtimeBackup, { mode: 0o700 });
  }
  await chmod(runtimeBackup, 0o700);
  const legacyArchiveRetentionRoot = await backupLegacyArchives(
    result,
    options.backupDir,
  );

  await writeAtomic(
    join(options.backupDir, 'preflight-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const rollbackRuntimeDir = `${options.runtimeDir}.v1-${stamp}`;
  if (await pathExists(rollbackRuntimeDir)) {
    throw new Error(`Runtime rollback directory already exists: ${rollbackRuntimeDir}`);
  }
  let databaseApplied = false;
  let runtimeMoved = false;
  let runtimeActivated = false;
  let runtimeStagingCreated = false;
  let archiveStatePrepared = false;
  let archiveState = {
    targetRootExisted: false,
    stagingCreated: false,
    stagedChanges: [],
    activatedPaths: [],
  };
  try {
    await prepareStagingDirectory(options, result);
    runtimeStagingCreated = true;
    archiveState = {
      ...await prepareArchiveStaging(result),
      activatedPaths: [],
    };
    archiveStatePrepared = true;
    assertSystemdServicesStopped(options);
    archiveState.activatedPaths = await activateStagedArchives(result, archiveState);
    runSqlite('apply', options.database, null, {
      changes: result.databaseChanges,
      bindingPlans: result.bindingPlans,
      archivePathChanges: result.archiveChanges.map((change) => ({
        id: change.archiveId,
        from: change.sourceDatabasePath,
        to: change.targetPath,
        state: 'ready',
      })),
      globalDefaultPresetId: result.globalDefaultPresetId,
      expectedState: result.database,
    });
    databaseApplied = true;
    if (options.faultAfterDatabaseApply) {
      throw new Error('Injected failure after database apply.');
    }

    if (await pathExists(options.runtimeDir)) {
      await rename(options.runtimeDir, rollbackRuntimeDir);
      runtimeMoved = true;
    }
    await rename(options.stagingDir, options.runtimeDir);
    runtimeActivated = true;
    runtimeStagingCreated = false;

    const appliedReport = {
      ...report,
      mode: 'apply',
      appliedAt: new Date().toISOString(),
      backupDir: options.backupDir,
      rollbackRuntimeDir: runtimeMoved ? rollbackRuntimeDir : null,
      archiveRelocationVerification: archiveState.stagedChanges.map((change) => ({
        archiveId: change.archiveId,
        sourcePath: change.sourcePath,
        targetPath: change.targetPath,
        sourceArtifactHash: change.sourceArtifactHash,
        targetArtifactHash: change.targetArtifactHash,
      })),
      finalize: {
        required: legacyArchiveRetentionRoot != null,
        legacyArchiveSourceRoot: result.archiveRoots.sourceRoot,
        legacyArchiveRetentionRoot,
        action: legacyArchiveRetentionRoot == null
          ? null
          : 'Retain the legacy source until the documented post-cutover finalize step.',
      },
    };
    await writeAtomic(
      join(options.backupDir, 'applied-report.json'),
      `${JSON.stringify(appliedReport, null, 2)}\n`,
    );
    if (options.report != null) {
      await writeAtomic(options.report, `${JSON.stringify(appliedReport, null, 2)}\n`);
    }
    return appliedReport;
  } catch (error) {
    const rollbackErrors = [];
    let databaseRestored = !databaseApplied;
    if (databaseApplied) {
      try {
        runSqlite('restore', databaseBackup, options.database, null);
        databaseRestored = true;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (databaseRestored) {
      if (runtimeActivated) {
        try {
          await rm(options.runtimeDir, { recursive: true, force: true });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (runtimeMoved) {
        try {
          await rename(rollbackRuntimeDir, options.runtimeDir);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (runtimeStagingCreated) {
        try {
          await rm(options.stagingDir, { recursive: true, force: true });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (archiveStatePrepared) {
        try {
          await removeActivatedArchives(result, archiveState);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Preset V2 apply failed and rollback was incomplete. Keep qqbot.target stopped.',
      );
    }
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'preflight') {
    const { report } = await preflight(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const report = await apply(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function formatCliError(error, depth = 0) {
  const prefix = depth === 0 ? '' : `${'  '.repeat(depth)}Caused by: `;
  const detail = error instanceof Error
    ? error.stack ?? error.message
    : String(error);
  if (!(error instanceof AggregateError)) {
    return `${prefix}${detail}`;
  }
  return [
    `${prefix}${detail}`,
    ...error.errors.map((cause) => formatCliError(cause, depth + 1)),
  ].join('\n');
}

main().catch((error) => {
  console.error(formatCliError(error));
  process.exitCode = 1;
});
