#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
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

function artifactPathForSpec(distDir, spec) {
  const localPath = spec.split(':')[0];
  const relativePath = localPath.replace(/^\.\/dist\//, '');
  return join(distDir, relativePath, 'index.js');
}

function main() {
  const rootDir = process.cwd();
  const options = parseArgs(process.argv.slice(2));
  const configPath = resolveFromRoot(rootDir, options.config);
  const distDir = resolveFromRoot(rootDir, options.dist);
  const config = YAML.parse(readFileSync(configPath, 'utf8'));
  const specs = [...collectLocalPluginSpecs(config)].sort();

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
