#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VERSION_MARKER = '.qqbot-llbot-version';
const ENTRYPOINT_FILE = 'llbot.js';
const DEFAULT_CONFIG_FILE = 'default_config.json';
const PMHQ_QQ_CONFIG_DESTINATION = '/root/.config/QQ';
const PMHQ_MEDIA_PATH_PATCH_MARKER = 'qqbot-managed-pmhq-media-path-rewrite';

function normalizeTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function applyManagedConfig(config, env = process.env) {
  const next = structuredClone(config);
  const ws = next.ob11?.connect?.find((item) => item.type === 'ws');
  if (!ws) {
    throw new Error('Missing ob11 ws config in managed llbot config');
  }

  next.webui = {
    ...next.webui,
    enable: true,
    host: '',
    port: Number(env.LLONEBOT_WEBUI_PORT || env.WEBUI_PORT || '3080'),
  };

  next.ob11 = {
    ...next.ob11,
    enable: true,
  };

  ws.enable = true;
  ws.host = '0.0.0.0';
  ws.port = Number(env.LLONEBOT_WS_PORT || '3001');
  ws.token = env.ONEBOT_TOKEN || '';

  for (const item of next.ob11?.connect || []) {
    if (item.type === 'ws-reverse') {
      item.enable = false;
      item.url = '';
      item.token = '';
    }
    if (item.type === 'http') {
      item.enable = false;
      item.host = '127.0.0.1';
      item.token = '';
    }
    if (item.type === 'http-post') {
      item.enable = false;
      item.url = '';
      item.token = '';
    }
  }

  next.ffmpeg = '/usr/bin/ffmpeg';
  return next;
}

function rewriteJsonConfig(filePath, env = process.env) {
  const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  fs.writeFileSync(filePath, `${JSON.stringify(applyManagedConfig(config, env), null, 2)}\n`, 'utf8');
}

function patchLlbotMediaPathResolution({ runtimeDir, qqConfigMountSource }) {
  const sourceDir = String(qqConfigMountSource || '').trim();
  if (!sourceDir) {
    throw requiredPmhqMountSourceError();
  }

  const entrypointPath = path.join(runtimeDir, ENTRYPOINT_FILE);
  const source = fs.readFileSync(entrypointPath, 'utf8');
  const original = [
    '\t\tconst mediaPath = await this.getRichMediaFilePath(fileMd5, fileName, elementType, elementSubType);',
    '\t\tawait copyFile(filePath, mediaPath);',
  ].join('\n');
  const replacement = [
    '\t\tlet mediaPath = await this.getRichMediaFilePath(fileMd5, fileName, elementType, elementSubType);',
    `\t\tconst qqbotManagedPmhqMediaRoot = ${JSON.stringify(path.resolve(sourceDir).replace(/[/\\]+$/, ''))};`,
    `\t\tconst qqbotManagedPmhqMediaPath = ${JSON.stringify(PMHQ_QQ_CONFIG_DESTINATION)};`,
    '\t\tif (typeof mediaPath === "string" && mediaPath.startsWith(qqbotManagedPmhqMediaPath)) {',
    '\t\t\tconst qqbotManagedRelativeMediaPath = mediaPath.slice(qqbotManagedPmhqMediaPath.length).replace(/^[/\\\\]+/, "");',
    '\t\t\tmediaPath = qqbotManagedRelativeMediaPath',
    '\t\t\t\t? `${qqbotManagedPmhqMediaRoot}/${qqbotManagedRelativeMediaPath}`',
    '\t\t\t\t: qqbotManagedPmhqMediaRoot;',
    '\t\t}',
    `\t\t/* ${PMHQ_MEDIA_PATH_PATCH_MARKER} */`,
    '\t\tawait copyFile(filePath, mediaPath);',
  ].join('\n');

  if (source.includes(replacement)) {
    return false;
  }
  if (!source.includes(original)) {
    throw new Error('Failed to locate llbot uploadFile media destination for managed media path rewrite');
  }

  fs.writeFileSync(entrypointPath, source.replace(original, replacement), 'utf8');
  return true;
}

function requiredPmhqMountSourceError() {
  return new Error(
    [
      'PMHQ QQ config mount source is required for managed host LLBot runtime.',
      `Set QQBOT_QQ_CONFIG_MOUNT_SOURCE or make podman inspect resolve ${PMHQ_QQ_CONFIG_DESTINATION}.`,
      'When LLBot HOME is isolated, QQBOT_HOST_HOME must point to the real host user home for rootless Podman.',
    ].join(' '),
  );
}

function disableWebUIAuthMiddleware({ runtimeDir, dataDir, disableAuth }) {
  if (!disableAuth) return;

  const entrypointPath = path.join(runtimeDir, ENTRYPOINT_FILE);
  const source = fs.readFileSync(entrypointPath, 'utf8');
  const startMatch = source.match(/(async\s+)?function authMiddleware\(([^)]*)\) \{/);
  const start = startMatch?.index ?? -1;
  let end = -1;

  if (start !== -1) {
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
  }

  if (start === -1 || end === -1) {
    throw new Error('Failed to locate llbot WebUI auth middleware');
  }

  const asyncPrefix = startMatch?.[1] || '';
  const params = startMatch?.[2] || 'req, res, next';
  const nextParam = params.split(',').map((item) => item.trim()).filter(Boolean).at(-1) || 'next';
  const replacement = asyncPrefix
    ? `${asyncPrefix}function authMiddleware(${params}) {\n\treturn await ${nextParam}();\n}`
    : `function authMiddleware(${params}) {\n\t${nextParam}();\n}`;
  fs.writeFileSync(entrypointPath, `${source.slice(0, start)}${replacement}${source.slice(end)}`, 'utf8');

  const tokenPath = path.join(dataDir, 'webui_token.txt');
  if (fs.existsSync(tokenPath)) {
    fs.rmSync(tokenPath, { force: true });
  }
}

function resolvePmhqQqConfigMountSource({
  containerName = process.env.QQBOT_PMHQ_CONTAINER_NAME || 'pmhq',
  spawnImpl = spawnSync,
  env = process.env,
} = {}) {
  const podmanEnv = { ...env };
  const hostHome = String(env.QQBOT_HOST_HOME || '').trim();
  if (hostHome) {
    podmanEnv.HOME = hostHome;
  }

  const inspect = spawnImpl(
    'podman',
    ['inspect', containerName, '--format', '{{json .Mounts}}'],
    { encoding: 'utf8', env: podmanEnv },
  );

  if (inspect.status !== 0 || !inspect.stdout.trim()) {
    return '';
  }

  try {
    const mounts = JSON.parse(inspect.stdout);
    const qqMount = mounts.find((mount) => mount?.Destination === PMHQ_QQ_CONFIG_DESTINATION);
    return typeof qqMount?.Source === 'string' ? qqMount.Source : '';
  } catch {
    return '';
  }
}

function resolveRequiredPmhqQqConfigMountSource(
  env = process.env,
  options = {},
) {
  const explicitSource = String(env.QQBOT_QQ_CONFIG_MOUNT_SOURCE || '').trim();
  const resolvedSource = explicitSource || resolvePmhqQqConfigMountSource({
    ...options,
    containerName: options.containerName || env.QQBOT_PMHQ_CONTAINER_NAME || 'pmhq',
    env,
  });
  const sourceDir = String(resolvedSource || '').trim();
  if (!sourceDir) {
    throw requiredPmhqMountSourceError();
  }

  const absoluteSourceDir = path.resolve(sourceDir);
  if (!fs.existsSync(absoluteSourceDir)) {
    throw new Error(`PMHQ QQ config mount source does not exist: ${absoluteSourceDir}`);
  }
  return absoluteSourceDir;
}

async function ensureQqConfigBridge({
  runtimeDir,
  homeDir = path.join(runtimeDir, '.host-home'),
  qqConfigMountSource = '',
  now = new Date(),
} = {}) {
  const sourceInput = String(qqConfigMountSource || '').trim();
  if (!sourceInput) {
    throw requiredPmhqMountSourceError();
  }
  const sourceDir = path.resolve(sourceInput);
  const bridgeHomeDir = path.resolve(homeDir);

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`PMHQ QQ config mount source does not exist: ${sourceDir}`);
  }

  const configDir = path.join(bridgeHomeDir, '.config');
  const qqLinkPath = path.join(configDir, 'QQ');
  await fsp.mkdir(configDir, { recursive: true });

  const currentLinkStats = await fsp.lstat(qqLinkPath).catch(() => null);
  if (currentLinkStats) {
    const currentRealPath = await fsp.realpath(qqLinkPath).catch(() => '');
    if (currentRealPath !== sourceDir) {
      await fsp.rm(qqLinkPath, { recursive: true, force: true });
    }
  }
  if (!fs.existsSync(qqLinkPath)) {
    await fsp.symlink(sourceDir, qqLinkPath, 'dir');
  }

  const monthDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('nt_qq_')) {
      continue;
    }
    await fsp.mkdir(path.join(sourceDir, entry.name, 'nt_data', 'Pic', monthDir, 'Ori'), { recursive: true });
    await fsp.mkdir(path.join(sourceDir, entry.name, 'nt_data', 'Pic', monthDir, 'Thumb'), { recursive: true });
  }

  return { bridgeHomeDir, qqConfigMountSource: sourceDir, linked: true };
}

function resolveReleaseZipPath(version, releaseZipPath = '') {
  const explicitPath = String(releaseZipPath || process.env.LLBOT_RELEASE_ZIP_PATH || '').trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  return path.resolve(__dirname, '..', '..', 'vendor', 'llbot', `LLBot-${version}.zip`);
}

function findPythonBinary() {
  for (const candidate of ['python3', 'python']) {
    const result = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (result.status === 0) {
      return candidate;
    }
  }
  throw new Error('python3 or python is required to extract LLBot.zip');
}

function hasNonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

async function extractReleaseZip(zipPath, runtimeDir) {
  const python = findPythonBinary();
  const result = spawnSync(python, ['-m', 'zipfile', '-e', zipPath, runtimeDir], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`Failed to extract LLBot.zip into ${runtimeDir}`);
  }
}

async function prepareRuntimeVersion(options) {
  const {
    runtimeDir,
    version,
    releaseZipPath = '',
    extractZip = extractReleaseZip,
  } = options;

  const markerPath = path.join(runtimeDir, VERSION_MARKER);
  const entrypointPath = path.join(runtimeDir, ENTRYPOINT_FILE);
  const configPath = path.join(runtimeDir, DEFAULT_CONFIG_FILE);
  const currentVersion = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : '';

  if (
    currentVersion === version &&
    hasNonEmptyFile(entrypointPath) &&
    hasNonEmptyFile(configPath)
  ) {
    return false;
  }

  await fsp.rm(runtimeDir, { recursive: true, force: true });
  await fsp.mkdir(runtimeDir, { recursive: true });

  const zipPath = resolveReleaseZipPath(version, releaseZipPath);
  if (!hasNonEmptyFile(zipPath)) {
    throw new Error(`LLBot release zip is required before runtime start: ${zipPath}`);
  }

  await extractZip(zipPath, runtimeDir);
  await fsp.writeFile(markerPath, `${version}\n`, 'utf8');

  return true;
}

async function ensureRuntimeDataLink(runtimeDir, dataDir) {
  const runtimeDataPath = path.join(runtimeDir, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.rm(runtimeDataPath, { recursive: true, force: true });
  await fsp.symlink(dataDir, runtimeDataPath, 'dir');
}

async function prepareManagedRuntime(env = process.env) {
  const runtimeDir = path.resolve(env.LLBOT_RUNTIME_DIR || './.runtime/llbot');
  const dataDir = path.resolve(env.LLONEBOT_DATA_DIR || './.runtime/llonebot');
  const version = String(env.LLBOT_VERSION || '').trim();
  if (!version) {
    throw new Error('LLBOT_VERSION is required');
  }

  await prepareRuntimeVersion({ runtimeDir, version });
  await ensureRuntimeDataLink(runtimeDir, dataDir);
  const qqConfigMountSource = resolveRequiredPmhqQqConfigMountSource(env);
  await ensureQqConfigBridge({
    runtimeDir,
    homeDir: env.HOME || path.join(runtimeDir, '.host-home'),
    qqConfigMountSource,
  });
  patchLlbotMediaPathResolution({ runtimeDir, qqConfigMountSource });

  rewriteJsonConfig(path.join(runtimeDir, DEFAULT_CONFIG_FILE), env);

  if (fs.existsSync(dataDir)) {
    for (const name of fs.readdirSync(dataDir)) {
      if (/^config_\d+\.json$/.test(name)) {
        rewriteJsonConfig(path.join(dataDir, name), env);
      }
    }
  }

  disableWebUIAuthMiddleware({
    runtimeDir,
    dataDir,
    disableAuth: normalizeTruthy(env.LLONEBOT_DISABLE_WEBUI_AUTH),
  });

  return {
    runtimeDir,
    dataDir,
  };
}

async function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  if (command !== 'prepare') {
    throw new Error(`Unsupported command: ${command || '(empty)'}`);
  }
  await prepareManagedRuntime(process.env);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  VERSION_MARKER,
  applyManagedConfig,
  disableWebUIAuthMiddleware,
  ensureQqConfigBridge,
  ensureRuntimeDataLink,
  extractReleaseZip,
  resolveReleaseZipPath,
  resolvePmhqQqConfigMountSource,
  resolveRequiredPmhqQqConfigMountSource,
  normalizeTruthy,
  patchLlbotMediaPathResolution,
  prepareManagedRuntime,
  prepareRuntimeVersion,
  rewriteJsonConfig,
};
