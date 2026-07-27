#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  ContextPresetDefinitionV1Schema,
  RolePresetDefinitionV1Schema,
} from 'koishi-plugin-chatluna/preset-schema';
import YAML from 'yaml';

function parseArgs(argv) {
  const options = {
    config: 'koishi.yml',
    dist: 'dist',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      options.config = argv[++index];
      continue;
    }
    if (arg === '--dist') {
      options.dist = argv[++index];
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!options.config || !options.dist) {
    throw new Error('usage: verify-runtime-artifacts.mjs [--config koishi.yml] [--dist dist]');
  }

  return options;
}

function resolveFromRoot(rootDir, pathValue) {
  return isAbsolute(pathValue) ? pathValue : resolve(rootDir, pathValue);
}

function collectLocalPluginSpecs(value, specs = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectLocalPluginSpecs(item, specs);
    return specs;
  }

  if (!value || typeof value !== 'object') return specs;

  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('./dist/plugins/')) {
      specs.add(key);
    }
    collectLocalPluginSpecs(child, specs);
  }

  return specs;
}

function fileExists(filePath) {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function directoryHasFile(dirPath, pattern) {
  try {
    return readdirSync(dirPath).some((name) => pattern.test(name) && fileExists(join(dirPath, name)));
  } catch {
    return false;
  }
}

function collectFilesRecursively(dirPath, output = []) {
  if (!existsSync(dirPath)) return output;
  for (const name of readdirSync(dirPath)) {
    const path = join(dirPath, name);
    const info = lstatSync(path);
    if (info.isDirectory()) collectFilesRecursively(path, output);
    else if (info.isFile()) output.push(path);
  }
  return output;
}

function validateMemoryRuntimeCutover(distDir) {
  const memoryDir = join(distDir, 'plugins/memory');
  if (!existsSync(memoryDir)) return;
  const forbiddenFiles = new Set([
    'conflict.js',
    'consolidation.js',
    'jobs.js',
    'migration.js',
    'ranking.js',
    'scope.js',
  ]);
  const forbiddenTable = /\bmemory_(?:fact|episode|profile|candidate|source|provenance|job|tombstone)(?:_v\d+)?\b/u;
  for (const filePath of collectFilesRecursively(memoryDir)) {
    const name = filePath.slice(memoryDir.length + 1);
    if (forbiddenFiles.has(name) || forbiddenFiles.has(name.split('/').at(-1))) {
      throw new Error(`Legacy memory runtime artifact remains: ${filePath}`);
    }
    if (!filePath.endsWith('.js')) continue;
    const source = readFileSync(filePath, 'utf8');
    if (source.includes('runLegacyMemoryMigration') || forbiddenTable.test(source)) {
      throw new Error(`Legacy memory runtime reference remains: ${filePath}`);
    }
  }
}

function artifactPathForSpec(distDir, spec) {
  const localPath = spec.split(':')[0];
  const relativePath = localPath.replace(/^\.\/dist\//, '');
  return join(distDir, relativePath, 'index.js');
}

function validatePresetCatalog(dirPath, schema, label) {
  const info = lstatSync(dirPath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${dirPath}`);
  }
  const names = readdirSync(dirPath).sort();
  if (names.length === 0) throw new Error(`${label} must not be empty: ${dirPath}`);
  const ids = new Set();
  for (const name of names) {
    if (!/\.ya?ml$/i.test(name)) {
      throw new Error(`${label} contains an unsupported entry: ${name}`);
    }
    const definition = schema.parse(YAML.parse(readFileSync(join(dirPath, name), 'utf8')));
    if (name !== `${definition.id}.yml`) {
      throw new Error(`${label} filename must match id ${definition.id}: ${name}`);
    }
    if (ids.has(definition.id)) throw new Error(`Duplicate ${label} id: ${definition.id}`);
    ids.add(definition.id);
  }
}

function main() {
  const rootDir = process.cwd();
  const options = parseArgs(process.argv.slice(2));
  const configPath = resolveFromRoot(rootDir, options.config);
  const distDir = resolveFromRoot(rootDir, options.dist);
  const config = YAML.parse(readFileSync(configPath, 'utf8'));
  const specs = [...collectLocalPluginSpecs(config)].sort();
  validateMemoryRuntimeCutover(distDir);
  validatePresetCatalog(
    join(rootDir, 'data/chathub/role-presets'),
    RolePresetDefinitionV1Schema,
    'bundled role preset catalog',
  );
  validatePresetCatalog(
    join(rootDir, 'data/chathub/context-presets'),
    ContextPresetDefinitionV1Schema,
    'bundled context preset catalog',
  );

  if (specs.length === 0) {
    throw new Error(`no ./dist/plugins entries found in ${configPath}`);
  }

  const missing = [];

  for (const spec of specs) {
    const artifactPath = artifactPathForSpec(distDir, spec);
    if (!fileExists(artifactPath)) {
      missing.push(artifactPath);
    }
  }

  if (specs.some((spec) => spec.split(':')[0] === './dist/plugins/admin-api')) {
    for (const assetPath of [
      join(distDir, 'admin-web/index.html'),
    ]) {
      if (!fileExists(assetPath)) {
        missing.push(assetPath);
      }
    }
    const adminAssetsDir = join(distDir, 'admin-web/assets');
    if (!directoryHasFile(adminAssetsDir, /\.js$/)) missing.push(`${adminAssetsDir}/*.js`);
    if (!directoryHasFile(adminAssetsDir, /\.css$/)) missing.push(`${adminAssetsDir}/*.css`);
  }

  for (const toolPath of [
    join(distDir, 'tools/context-preset-cutover.mjs'),
    join(distDir, 'tools/context-preset-sqlite.py'),
    join(distDir, 'tools/model-config-cutover.mjs'),
    join(distDir, 'tools/model-auth-connection-cutover.mjs'),
    join(distDir, 'tools/memory-v2-cutover.mjs'),
    join(distDir, 'tools/memory-evaluation.mjs'),
    join(distDir, 'tools/memory-evaluation-adapter.mjs'),
  ]) {
    if (!fileExists(toolPath)) missing.push(toolPath);
  }

  if (missing.length > 0) {
    console.error('[error] Runtime artifacts are missing:');
    for (const filePath of missing) {
      console.error(`[error] - ${filePath}`);
    }
    console.error('[error] Run: pnpm build');
    process.exit(1);
  }

  console.log(`[info] Runtime artifacts verified: ${specs.length} local plugins from ${configPath}`);
}

try {
  main();
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
