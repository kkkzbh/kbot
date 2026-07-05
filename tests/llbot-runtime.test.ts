import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  VERSION_MARKER,
  applyManagedConfig,
  buildRemotePathMappings,
  disableWebUIAuthMiddleware,
  ensureQqConfigBridge,
  prepareManagedRuntime,
  prepareRuntimeVersion,
  resolvePmhqQqConfigMountSource,
  resolveRequiredPmhqQqConfigMountSource,
} = require('../scripts/lib/llbot-runtime.cjs');

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-llbot-runtime-'));
  tempDirs.push(dir);
  return dir;
}

function prepareLauncherRuntime(script: string): {
  dir: string;
  runtimeDir: string;
  dataDir: string;
  qqMountSource: string;
} {
  const dir = createTempDir();
  const runtimeDir = join(dir, 'runtime');
  const dataDir = join(dir, 'data');
  const qqMountSource = join(dir, 'pmhq-qq');
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(qqMountSource, { recursive: true });
  writeFileSync(join(runtimeDir, VERSION_MARKER), '7.12.15\n', 'utf8');
  writeFileSync(
    join(runtimeDir, 'default_config.json'),
    JSON.stringify({
      webui: { enable: false, host: '127.0.0.1', port: 3000 },
      ob11: {
        enable: false,
        connect: [
          { type: 'ws', enable: false, host: '127.0.0.1', port: 9000, token: 'old' },
          { type: 'ws-reverse', enable: true, url: 'ws://old', token: 'old' },
        ],
      },
    }),
    'utf8',
  );
  writeFileSync(
    join(runtimeDir, 'llbot.js'),
    [
      'function authMiddleware(req, res, next) {',
      '\tnext();',
      '}',
      script,
    ].join('\n'),
    'utf8',
  );
  return { dir, runtimeDir, dataDir, qqMountSource };
}

async function runLlbotHostLauncher(env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['scripts/run-llbot-host.sh'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
        QQBOT_ENV_FILE: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('launcher test timed out'));
    }, 8000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('llbot host runtime helpers', () => {
  it('builds the LLBot remote path mapping for the PMHQ QQ volume', () => {
    expect(
      buildRemotePathMappings('/var/lib/containers/storage/volumes/qqbot-stack_qq_volume/_data'),
    ).toEqual([
      {
        name: 'qqbot-pmhq-qq-config',
        remotePrefix: '/root/.config/QQ',
        localPrefix: '/var/lib/containers/storage/volumes/qqbot-stack_qq_volume/_data',
        remoteStyle: 'posix',
        localStyle: 'posix',
      },
    ]);
  });

  it('inspects pmhq through the real host home when llbot home is isolated', () => {
    const spawnImpl = vi.fn((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      expect(options.env.HOME).toBe('/home/qqbot');
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            Destination: '/root/.config/QQ',
            Source: '/home/qqbot/.local/share/containers/storage/volumes/qqbot-stack_qq_volume/_data',
          },
        ]),
      };
    });

    expect(
      resolvePmhqQqConfigMountSource({
        spawnImpl,
        env: {
          HOME: '/opt/qqbot/shared/llbot-runtime/.host-home',
          QQBOT_HOST_HOME: '/home/qqbot',
        },
      }),
    ).toBe('/home/qqbot/.local/share/containers/storage/volumes/qqbot-stack_qq_volume/_data');
    expect(spawnImpl).toHaveBeenCalledWith(
      'podman',
      ['inspect', 'pmhq', '--format', '{{json .Mounts}}'],
      expect.objectContaining({
        env: expect.objectContaining({ HOME: '/home/qqbot' }),
      }),
    );
  });

  it('fails fast when the pmhq qq volume cannot be resolved', () => {
    const spawnImpl = vi.fn(() => ({ status: 125, stdout: '' }));

    expect(() => resolveRequiredPmhqQqConfigMountSource(
      {
        HOME: '/opt/qqbot/shared/llbot-runtime/.host-home',
        QQBOT_HOST_HOME: '/home/qqbot',
      },
      { spawnImpl },
    )).toThrow(/PMHQ QQ config mount source is required/);
  });

  it('extracts the bundled llbot release zip on first prepare', async () => {
    const dir = createTempDir();
    const runtimeDir = join(dir, 'llbot-runtime');
    const releaseZipPath = join(dir, 'LLBot-7.12.15.zip');
    writeFileSync(releaseZipPath, 'zip-bytes', 'utf8');
    const extractZip = vi.fn(async (_zipPath: string, targetDir: string) => {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, 'llbot.js'), 'console.log("llbot")\n', 'utf8');
      writeFileSync(join(targetDir, 'default_config.json'), '{}\n', 'utf8');
    });

    const changed = await prepareRuntimeVersion({
      runtimeDir,
      version: '7.12.15',
      releaseZipPath,
      extractZip,
    });

    expect(changed).toBe(true);
    expect(extractZip).toHaveBeenCalledTimes(1);
    expect(extractZip).toHaveBeenCalledWith(releaseZipPath, runtimeDir);
    expect(readFileSync(join(runtimeDir, VERSION_MARKER), 'utf8').trim()).toBe('7.12.15');
  });

  it('fails when the bundled llbot release zip is missing', async () => {
    const dir = createTempDir();
    await expect(prepareRuntimeVersion({
      runtimeDir: join(dir, 'llbot-runtime'),
      version: '7.12.15',
      releaseZipPath: join(dir, 'missing.zip'),
      extractZip: vi.fn(),
    })).rejects.toThrow(/LLBot release zip is required before runtime start/);
  });

  it('skips re-download when the runtime version already matches', async () => {
    const runtimeDir = join(createTempDir(), 'llbot-runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, VERSION_MARKER), '7.12.15\n', 'utf8');
    writeFileSync(join(runtimeDir, 'llbot.js'), 'console.log("llbot")\n', 'utf8');
    writeFileSync(join(runtimeDir, 'default_config.json'), '{}\n', 'utf8');

    const changed = await prepareRuntimeVersion({
      runtimeDir,
      version: '7.12.15',
      extractZip: vi.fn(),
    });

    expect(changed).toBe(false);
  });

  it('re-extracts the bundled runtime when the matching runtime entrypoint is empty', async () => {
    const dir = createTempDir();
    const runtimeDir = join(dir, 'llbot-runtime');
    const releaseZipPath = join(dir, 'LLBot-7.12.15.zip');
    writeFileSync(releaseZipPath, 'zip-bytes', 'utf8');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, VERSION_MARKER), '7.12.15\n', 'utf8');
    writeFileSync(join(runtimeDir, 'llbot.js'), '', 'utf8');
    writeFileSync(join(runtimeDir, 'default_config.json'), '{}\n', 'utf8');
    const extractZip = vi.fn(async (_zipPath: string, targetDir: string) => {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, 'llbot.js'), 'console.log("llbot")\n', 'utf8');
      writeFileSync(join(targetDir, 'default_config.json'), '{}\n', 'utf8');
    });

    const changed = await prepareRuntimeVersion({
      runtimeDir,
      version: '7.12.15',
      releaseZipPath,
      extractZip,
    });

    expect(changed).toBe(true);
    expect(extractZip).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(runtimeDir, 'llbot.js'), 'utf8')).toContain('console.log("llbot")');
  });

  it('rewrites llbot managed config to host loopback pmhq and local websocket settings', () => {
    const config = applyManagedConfig({
      webui: { enable: false, host: '127.0.0.1', port: 3000 },
      ob11: {
        enable: false,
        connect: [
          { type: 'ws', enable: false, host: '127.0.0.1', port: 9000, token: 'old' },
          { type: 'ws-reverse', enable: true, url: 'ws://old', token: 'old' },
          { type: 'http', enable: true, host: '0.0.0.0', token: 'old' },
          { type: 'http-post', enable: true, url: 'http://old', token: 'old' },
        ],
      },
    }, {
      LLONEBOT_WEBUI_PORT: '3080',
      LLONEBOT_WS_PORT: '3001',
      ONEBOT_TOKEN: 'secret',
      QQBOT_QQ_CONFIG_MOUNT_SOURCE: '/var/lib/containers/storage/volumes/qqbot-stack_qq_volume/_data',
    });

    expect(config.webui).toMatchObject({ enable: true, host: '', port: 3080 });
    expect(config.ob11.enable).toBe(true);
    expect(config.ob11.connect[0]).toMatchObject({
      type: 'ws',
      enable: true,
      host: '0.0.0.0',
      port: 3001,
      token: 'secret',
    });
    expect(config.ob11.connect[1]).toMatchObject({ enable: false, url: '', token: '' });
    expect(config.ob11.connect[2]).toMatchObject({ enable: false, host: '127.0.0.1', token: '' });
    expect(config.ob11.connect[3]).toMatchObject({ enable: false, url: '', token: '' });
    expect(config.remotePathMappings).toEqual([
      {
        name: 'qqbot-pmhq-qq-config',
        remotePrefix: '/root/.config/QQ',
        localPrefix: '/var/lib/containers/storage/volumes/qqbot-stack_qq_volume/_data',
        remoteStyle: 'posix',
        localStyle: 'posix',
      },
    ]);
  });

  it('disables the webui auth middleware and clears stale tokens when requested', () => {
    const dir = createTempDir();
    const runtimeDir = join(dir, 'runtime');
    const dataDir = join(dir, 'data');
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, 'llbot.js'),
      [
        'function authMiddleware(req, res, next) {',
        '\treturn res.status(401).end()',
        '}',
        '//#endregion',
        '//#region src/webui/BE/utils.ts',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(join(dataDir, 'webui_token.txt'), 'secret-token\n', 'utf8');
    symlinkSync(dataDir, join(runtimeDir, 'data'), 'dir');

    disableWebUIAuthMiddleware({ runtimeDir, dataDir, disableAuth: true });

    expect(readFileSync(join(runtimeDir, 'llbot.js'), 'utf8')).toContain('\tnext();');
    expect(() => readFileSync(join(dataDir, 'webui_token.txt'), 'utf8')).toThrow();
  });

  it('disables newer async webui auth middleware signatures', () => {
    const dir = createTempDir();
    const runtimeDir = join(dir, 'runtime');
    const dataDir = join(dir, 'data');
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, 'llbot.js'),
      [
        'async function authMiddleware(c, next) {',
        '\tif (!c.req.header("X-Webui-Token")) return c.json({}, 403);',
        '\tawait next();',
        '}',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(join(dataDir, 'webui_token.txt'), 'secret-token\n', 'utf8');

    disableWebUIAuthMiddleware({ runtimeDir, dataDir, disableAuth: true });

    expect(readFileSync(join(runtimeDir, 'llbot.js'), 'utf8')).toContain('\treturn await next();');
    expect(() => readFileSync(join(dataDir, 'webui_token.txt'), 'utf8')).toThrow();
  });

  it('bridges the host qq config path into the pmhq volume and prepares the monthly pic directories', async () => {
    const dir = createTempDir();
    const runtimeDir = join(dir, 'runtime');
    const bridgeHomeDir = join(dir, 'bridge-home');
    const qqMountSource = join(dir, 'pmhq-qq');
    const qqNtDir = join(qqMountSource, 'nt_qq_test');
    mkdirSync(join(qqNtDir, 'nt_data', 'Pic'), { recursive: true });

    const result = await ensureQqConfigBridge({
      runtimeDir,
      homeDir: bridgeHomeDir,
      qqConfigMountSource: qqMountSource,
      now: new Date('2026-04-08T09:00:00Z'),
    });

    const qqLinkPath = join(bridgeHomeDir, '.config', 'QQ');
    expect(result).toMatchObject({
      bridgeHomeDir,
      qqConfigMountSource: qqMountSource,
      linked: true,
    });
    expect(lstatSync(qqLinkPath).isSymbolicLink()).toBe(true);
    expect(existsSync(join(qqMountSource, 'nt_qq_test', 'nt_data', 'Pic', '2026-04', 'Ori'))).toBe(true);
    expect(existsSync(join(qqMountSource, 'nt_qq_test', 'nt_data', 'Pic', '2026-04', 'Thumb'))).toBe(true);
  });

  it('prepareManagedRuntime applies LLBot remote path mappings and the qq config bridge', async () => {
    const dir = createTempDir();
    const runtimeDir = join(dir, 'runtime');
    const dataDir = join(dir, 'data');
    const homeDir = join(dir, 'home');
    const qqMountSource = join(dir, 'pmhq-qq');
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(join(qqMountSource, 'nt_qq_test', 'nt_data', 'Pic'), { recursive: true });
    writeFileSync(join(runtimeDir, '.qqbot-llbot-version'), '7.12.15\n', 'utf8');
    writeFileSync(
      join(runtimeDir, 'llbot.js'),
      [
        'function authMiddleware(req, res, next) {',
        '\treturn res.status(401).end()',
        '}',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(runtimeDir, 'default_config.json'),
      JSON.stringify({
        webui: { enable: false, host: '127.0.0.1', port: 3000 },
        ob11: {
          enable: false,
          connect: [
            { type: 'ws', enable: false, host: '127.0.0.1', port: 9000, token: 'old' },
          ],
        },
      }),
      'utf8',
    );

    await prepareManagedRuntime({
      LLBOT_VERSION: '7.12.15',
      LLBOT_RUNTIME_DIR: runtimeDir,
      LLONEBOT_DATA_DIR: dataDir,
      QQBOT_QQ_CONFIG_MOUNT_SOURCE: qqMountSource,
      HOME: homeDir,
    });

    const entrypoint = readFileSync(join(runtimeDir, 'llbot.js'), 'utf8');
    const rewrittenConfig = JSON.parse(readFileSync(join(runtimeDir, 'default_config.json'), 'utf8'));
    expect(entrypoint).not.toContain('qqbot-managed-pmhq-media-path-rewrite');
    expect(rewrittenConfig.remotePathMappings).toEqual([
      {
        name: 'qqbot-pmhq-qq-config',
        remotePrefix: '/root/.config/QQ',
        localPrefix: qqMountSource,
        remoteStyle: 'posix',
        localStyle: 'posix',
      },
    ]);
    expect(lstatSync(join(homeDir, '.config', 'QQ')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(qqMountSource, 'nt_qq_test', 'nt_data', 'Pic'))).toBe(true);
  });

  it('keeps the host launcher running until LLBot exits before QQ login', async () => {
    const { runtimeDir, dataDir, qqMountSource } = prepareLauncherRuntime([
      'setTimeout(() => process.exit(0), 300);',
    ].join('\n'));

    const result = await runLlbotHostLauncher({
      LLBOT_VERSION: '7.12.15',
      LLBOT_RUNTIME_DIR: runtimeDir,
      LLONEBOT_DATA_DIR: dataDir,
      QQBOT_QQ_CONFIG_MOUNT_SOURCE: qqMountSource,
      LLONEBOT_WS_PORT: '30191',
    });

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('did not become ready');
  });

  it('propagates the LLBot process exit status', async () => {
    const { runtimeDir, dataDir, qqMountSource } = prepareLauncherRuntime([
      'process.stderr.write("llbot failed\\n");',
      'process.exit(7);',
    ].join('\n'));

    const result = await runLlbotHostLauncher({
      LLBOT_VERSION: '7.12.15',
      LLBOT_RUNTIME_DIR: runtimeDir,
      LLONEBOT_DATA_DIR: dataDir,
      QQBOT_QQ_CONFIG_MOUNT_SOURCE: qqMountSource,
      LLONEBOT_WS_PORT: '30192',
    });

    expect(result.code).toBe(7);
    expect(result.stderr).toContain('llbot failed');
  });
});
