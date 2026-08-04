import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyEnvPatchToContent,
  AdminRestartJobError,
  AdminRuntimeManager,
  mergeManagedEnvRecords,
  parseJournalDiskUsageBytes,
  parseSystemdShowOutput,
  resolveBackupDirectory,
  resolveBotEnvFilePath,
  resolveBotEnvFiles,
  resolveApplyRestartUnits,
  resolveManagedServiceUnits,
  readManagedEnvPatchFromContent,
  readProcessLines,
  writeFileAtomicWithBackup,
  type ScheduledRestartHandle,
} from '../src/plugins/admin-api/server.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-admin-'));
  tempDirs.push(dir);
  return dir;
}

describe('resolveBackupDirectory', () => {
  it('keeps generated backups under the owner backup directory', () => {
    const rootDir = createTempDir();

    expect(resolveBackupDirectory(rootDir, join(rootDir, 'data/koishi.db'))).toBe(join(rootDir, 'data/backup'));
    expect(resolveBackupDirectory(rootDir, join(rootDir, 'config/voice-tts.local.env'))).toBe(join(rootDir, 'config/backup'));
    expect(resolveBackupDirectory(rootDir, join(rootDir, '.runtime/.env.runtime'))).toBe(join(rootDir, '.runtime/backup'));
    expect(resolveBackupDirectory(rootDir, join(rootDir, '.env.local'))).toBe(join(rootDir, 'backup'));
  });
});

describe('parseJournalDiskUsageBytes', () => {
  it('parses the human-readable journal disk usage reported by systemd', () => {
    expect(parseJournalDiskUsageBytes('Archived and active journals take up 1.4G in the file system.'))
      .toBe(Math.round(1.4 * 1024 ** 3));
  });
});

describe('resolveApplyRestartUnits', () => {
  it('maps configuration reasons to the minimal ordered service plan', () => {
    expect(resolveApplyRestartUnits(
      ['tts', 'features'],
      resolveManagedServiceUnits('/tmp/qqbot/.env.local'),
    )).toEqual([
      'qqbot-voice-tts.service',
      'qqbot-koishi.service',
    ]);
    expect(resolveApplyRestartUnits(
      ['features'],
      resolveManagedServiceUnits('/tmp/qqbot/.env.server'),
    )).toEqual(['qqbot-koishi.service']);
  });

  it('fails directly when a pending reason targets an unmanaged service', () => {
    expect(() => resolveApplyRestartUnits(
      ['tts'],
      resolveManagedServiceUnits('/tmp/qqbot/.env.server'),
    )).toThrow('当前运行角色无法重启待应用的 TTS 服务');
  });
});

describe('AdminRuntimeManager.restartForApplyReasons', () => {
  it('captures current invocations and restarts TTS before Koishi', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');
    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath });
    const getServiceStatus = vi.spyOn(manager, 'getServiceStatus').mockImplementation(async (unit) => ({
      unit,
      description: unit,
      runtimeState: 'healthy',
      controllerState: {
        loadState: 'loaded',
        activeState: 'active',
        subState: 'running',
        unitFileState: 'enabled',
        result: 'success',
        invocationId: `before-${unit}`,
      },
      checkedAt: Date.now(),
      healthDetail: 'healthy',
      canStart: false,
      canStop: true,
      canRestart: true,
      canEnable: false,
    }));
    const runServiceAction = vi.spyOn(manager, 'runServiceAction').mockImplementation(async (unit) => ({
      ...(await getServiceStatus(unit)),
      controllerState: {
        ...(await getServiceStatus(unit)).controllerState,
        invocationId: `after-${unit}`,
      },
    }));

    await expect(manager.restartForApplyReasons(['features', 'tts'])).resolves.toEqual([
      {
        unit: 'qqbot-voice-tts.service',
        previousInvocationId: 'before-qqbot-voice-tts.service',
      },
      {
        unit: 'qqbot-koishi.service',
        previousInvocationId: 'before-qqbot-koishi.service',
      },
    ]);
    expect(runServiceAction.mock.calls.map(([unit, action]) => [unit, action])).toEqual([
      ['qqbot-voice-tts.service', 'restart'],
      ['qqbot-koishi.service', 'restart'],
    ]);
  });
});

function createSystemdShowExec(activeState = 'inactive') {
  return async (_file: string, args: string[]) => ({
    stdout: [
      `Description=${args[2] ?? 'qqbot.service'}`,
      'LoadState=loaded',
      `ActiveState=${activeState}`,
      `SubState=${activeState === 'active' ? 'running' : 'dead'}`,
      'UnitFileState=disabled',
    ].join('\n'),
    stderr: '',
  });
}

function createMinimalWav(): Uint8Array {
  const sampleRate = 32000;
  const channels = 1;
  const bitsPerSample = 16;
  const dataBytes = 64;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(buffer);
}

function createRestartHandle(): ScheduledRestartHandle {
  const transientUnit = 'qqbot-koishi-service-restart-123';
  return {
    targetUnit: 'qqbot-koishi.service',
    transientUnit,
    serviceUnit: `${transientUnit}.service`,
    timerUnit: `${transientUnit}.timer`,
    scheduledAt: 123,
  };
}

function restartTargetOutput(invocationId: string, job = ''): string {
  return [
    'ActiveState=active',
    'SubState=running',
    `InvocationID=${invocationId}`,
    `Job=${job}`,
  ].join('\n');
}

function restartJobUnitOutput(input: {
  loadState?: string;
  activeState: string;
  subState: string;
  result?: string;
  execMainStatus?: number;
  startedAt?: number;
}): string {
  return [
    `LoadState=${input.loadState ?? 'loaded'}`,
    `ActiveState=${input.activeState}`,
    `SubState=${input.subState}`,
    `Result=${input.result ?? 'success'}`,
    `ExecMainStatus=${input.execMainStatus ?? 0}`,
    `ExecMainStartTimestampMonotonic=${input.startedAt ?? 0}`,
  ].join('\n');
}


describe('admin env helpers', () => {
  it('keeps atomically written environment files private', async () => {
    const dir = createTempDir();
    const filePath = join(dir, '.env.runtime');
    writeFileSync(filePath, 'QQBOT_ANTI_RECALL_ENABLED=false\n', { mode: 0o640 });

    await writeFileAtomicWithBackup(filePath, 'QQBOT_ANTI_RECALL_ENABLED=true\n', {
      backupDir: join(dir, 'backup'),
    });

    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('preserves comments and unknown lines while patching managed keys', () => {
    const content = [
      '# comment',
      'UNMANAGED_PROVIDER_FLAG=keep',
      'UNMANAGED_FLAG=keep-me',
      'QQ_VOICE_INPUT_ENABLED=true',
      '',
    ].join('\n');

    const next = applyEnvPatchToContent(content, {
      QQ_VOICE_INPUT_ENABLED: 'false',
    });

    expect(next).toContain('# comment');
    expect(next).toContain('UNMANAGED_FLAG=keep-me');
    expect(next).toContain('UNMANAGED_PROVIDER_FLAG=keep');
    expect(next).toContain('QQ_VOICE_INPUT_ENABLED=false');
  });

  it('keeps the original file when atomic write fails', async () => {
    const dir = createTempDir();
    const filePath = join(dir, '.env.local');
    writeFileSync(filePath, 'UNMANAGED_FLAG=keep\n', 'utf8');

    await expect(
      writeFileAtomicWithBackup(filePath, 'UNMANAGED_FLAG=next\n', {
        backupDir: join(dir, 'backup'),
        fs: {
          access: async () => undefined,
          chmod: async () => undefined,
          copyFile: async (...args) => writeFile(args[1] as string, readFileSync(args[0] as string, 'utf8'), 'utf8'),
          mkdir: async () => undefined,
          readFile: (async (path: unknown, encoding: unknown) =>
            readFileSync(String(path), encoding as BufferEncoding)) as any,
          readdir: async () => [],
          rename: async () => undefined,
          rm: async () => undefined,
          stat: async () => ({}) as any,
          writeFile: async () => {
            throw new Error('disk full');
          },
        },
      }),
    ).rejects.toThrow('disk full');

    expect(readFileSync(filePath, 'utf8')).toBe('UNMANAGED_FLAG=keep\n');
  });

  it('falls back to .env.server when .env.local is absent', () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=server\n', 'utf8');

    expect(resolveBotEnvFilePath(dir)).toBe(envFilePath);
  });

  it('prefers QQBOT_ENV_FILE when explicitly set', () => {
    const dir = createTempDir();
    writeFileSync(join(dir, '.env.local'), 'UNMANAGED_FLAG=local\n', 'utf8');
    writeFileSync(join(dir, '.env.server'), 'UNMANAGED_FLAG=server\n', 'utf8');
    vi.stubEnv('QQBOT_ENV_FILE', '.env.server');

    expect(resolveBotEnvFilePath(dir)).toBe(join(dir, '.env.server'));
  });

  it('switches to layered env mode when runtime override files are configured', () => {
    const dir = createTempDir();
    vi.stubEnv('QQBOT_ENV_BASE_FILE', '/opt/qqbot/current/.env.server');
    vi.stubEnv('QQBOT_ENV_OVERRIDE_FILE', '/opt/qqbot/shared/.env.runtime');

    expect(resolveBotEnvFiles(dir)).toEqual({
      mode: 'layered',
      baseFilePath: '/opt/qqbot/current/.env.server',
      overrideFilePath: '/opt/qqbot/shared/.env.runtime',
      editTarget: '/opt/qqbot/shared/.env.runtime',
    });
  });

  it('defaults local env files to layered mode with a runtime override file', () => {
    const dir = createTempDir();
    writeFileSync(join(dir, '.env.local'), 'UNMANAGED_FLAG=local\n', 'utf8');

    expect(resolveBotEnvFiles(dir)).toEqual({
      mode: 'layered',
      baseFilePath: join(dir, '.env.local'),
      overrideFilePath: join(dir, '.runtime/.env.runtime'),
      editTarget: join(dir, '.runtime/.env.runtime'),
    });
  });

  it('merges managed env values with runtime override precedence', () => {
    const merged = mergeManagedEnvRecords(
      readManagedEnvPatchFromContent([
        'QQBOT_REPLY_INTERRUPT_ENABLED=true',
        'HBU_JW_CREDENTIAL_KEK_PATH=/opt/qqbot/data/hbu-jw/credential-kek.key',
      ].join('\n')),
      readManagedEnvPatchFromContent([
        'QQBOT_REPLY_INTERRUPT_ENABLED=false',
        'QQ_VOICE_OUTPUT_ENABLED=false',
        'HBU_JW_CREDENTIAL_KEK_PATH=',
      ].join('\n')),
    );

    expect(merged).toMatchObject({
      QQBOT_REPLY_INTERRUPT_ENABLED: 'false',
      HBU_JW_CREDENTIAL_KEK_PATH: '/opt/qqbot/data/hbu-jw/credential-kek.key',
      QQ_VOICE_OUTPUT_ENABLED: 'false',
    });
  });

});

describe('admin systemd helpers', () => {
  it('streams process output beyond the child_process exec buffer limit', async () => {
    const payloadBytes = 2_048;
    const lineCount = 1_024;
    const result = await readProcessLines(process.execPath, [
      '-e',
      `for (let index = 0; index < ${lineCount}; index += 1) console.log(String(index).padStart(4, '0') + ':' + 'x'.repeat(${payloadBytes}))`,
    ], { timeout: 15_000 });

    expect(result.lines).toHaveLength(lineCount);
    expect(result.lines[0]).toMatch(/^0000:x+$/);
    expect(result.lines.at(-1)).toMatch(/^1023:x+$/);
    expect(result.stderr).toBe('');
  });

  it('parses systemctl show output into service status flags', () => {
    const status = parseSystemdShowOutput(
      [
        'Description=QQ Bot target',
        'LoadState=loaded',
        'ActiveState=active',
        'SubState=active',
        'UnitFileState=enabled',
      ].join('\n'),
      'qqbot.target',
    );

    expect(status.description).toBe('QQ Bot target');
    expect(status.canRestart).toBe(true);
    expect(status.canStart).toBe(false);
    expect(status.canStop).toBe(true);
    expect(status.canEnable).toBe(false);
    expect(status.runtimeState).toBe('healthy');
    expect(status.controllerState).toMatchObject({ activeState: 'active', subState: 'active' });
  });

  it('reports a healthy PMHQ workload with a failed controller as degraded', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, '', 'utf8');
    const execFile = vi.fn().mockResolvedValue({
      stdout: [
        'Description=QQBot PMHQ Service',
        'LoadState=loaded',
        'ActiveState=failed',
        'SubState=failed',
        'UnitFileState=generated',
        'Result=exit-code',
        'InvocationID=a030b1fd7f4c49d2b54c3e7c339eb284',
      ].join('\n'),
      stderr: '',
    });
    const manager = new AdminRuntimeManager({
      rootDir: dir,
      envFilePath,
      execFile,
      fetchFn: vi.fn(async () => new Response('{}', { status: 200 })),
    });

    const status = await manager.getServiceStatus('qqbot-pmhq.service');

    expect(status.runtimeState).toBe('degraded');
    expect(status.healthDetail).toContain('工作负载健康');
    expect(status.canStart).toBe(true);
    expect(status.canStop).toBe(false);
  });

  it('keeps server service units scoped to production services', () => {
    expect(resolveManagedServiceUnits('/tmp/qqbot/.env.local')).toContain('qqbot-voice-tts.service');
    expect(resolveManagedServiceUnits('/tmp/qqbot/.env.server')).toContain('cloudflared-qqbot-hbu-jw.service');
    expect(resolveManagedServiceUnits('/tmp/qqbot/.env.server')).not.toContain('qqbot-voice-tts.service');
  });
});

describe('admin manager', () => {
  it('rejects unsupported env keys when saving env', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');

    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath });
    await expect(manager.saveEnv({ HACKED: '1' } as any)).rejects.toThrow('不支持这个配置项');
  });

  it('accepts QQBOT_REPLY_INTERRUPT_ENABLED through managed env saves', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');

    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath });
    await expect(manager.saveEnv({ QQBOT_REPLY_INTERRUPT_ENABLED: 'false' })).resolves.toMatchObject({
      QQBOT_REPLY_INTERRUPT_ENABLED: 'false',
    });
  });

  it('accepts realtime-message env settings through managed env saves', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');

    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath });
    await expect(
      manager.saveEnv({
        QQBOT_REALTIME_MESSAGE_ENABLED: 'false',
        QQBOT_REALTIME_MESSAGE_MAX_INJECT_COUNT: '24',
      }),
    ).resolves.toMatchObject({
      QQBOT_REALTIME_MESSAGE_ENABLED: 'false',
      QQBOT_REALTIME_MESSAGE_MAX_INJECT_COUNT: '24',
    });
  });

  it('accepts file system env controls through managed env saves', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');

    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath });
    await expect(
      manager.saveEnv({
        CHATLUNA_COMMON_FS: 'true',
        CHATLUNA_COMMON_FS_SCOPE_PATH: '/tmp/qqbot-scope',
        CHATLUNA_COMMON_FS_ALLOWED_GROUPS: '829573670,921554872',
      }),
    ).resolves.toMatchObject({
      CHATLUNA_COMMON_FS: 'true',
      CHATLUNA_COMMON_FS_SCOPE_PATH: '/tmp/qqbot-scope',
      CHATLUNA_COMMON_FS_ALLOWED_GROUPS: '829573670,921554872',
    });
  });

  it('normalizes managed group allowlists before saving env', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');

    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath });
    await expect(
      manager.saveEnv({
        QQBOT_ANTI_RECALL_ALLOWED_GROUPS: '100\n200， group:300',
        HBU_JW_ALLOWED_GROUPS: '100\n200， group:300',
        HBU_JW_NATURAL_TRIGGER_GROUPS: '100、200 300',
        CHAOXING_ALLOWED_GROUPS: '200\n300， group:400',
        CHAOXING_NATURAL_TRIGGER_GROUPS: '200、300 400',
        GENSHIN_ALLOWED_GROUPS: '300\n400， group:500',
        GENSHIN_NATURAL_TRIGGER_GROUPS: '300、400 500',
        CHATLUNA_COMMON_FS_ALLOWED_GROUPS: 'group:100\n guild:200',
      }),
    ).resolves.toMatchObject({
      QQBOT_ANTI_RECALL_ALLOWED_GROUPS: '100,200,group:300',
      HBU_JW_ALLOWED_GROUPS: '100,200,group:300',
      HBU_JW_NATURAL_TRIGGER_GROUPS: '100,200,300',
      CHAOXING_ALLOWED_GROUPS: '200,300,group:400',
      CHAOXING_NATURAL_TRIGGER_GROUPS: '200,300,400',
      GENSHIN_ALLOWED_GROUPS: '300,400,group:500',
      GENSHIN_NATURAL_TRIGGER_GROUPS: '300,400,500',
      CHATLUNA_COMMON_FS_ALLOWED_GROUPS: 'group:100,guild:200',
    });
    expect(readFileSync(envFilePath, 'utf8')).toContain('QQBOT_ANTI_RECALL_ALLOWED_GROUPS=100,200,group:300');
    expect(readFileSync(envFilePath, 'utf8')).toContain('HBU_JW_ALLOWED_GROUPS=100,200,group:300');
    expect(readFileSync(envFilePath, 'utf8')).toContain('CHAOXING_ALLOWED_GROUPS=200,300,group:400');
    expect(readFileSync(envFilePath, 'utf8')).toContain('GENSHIN_ALLOWED_GROUPS=300,400,group:500');
  });

  it('rejects invalid anti-recall group identifiers before writing env', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');

    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath });
    await expect(manager.saveEnv({
      QQBOT_ANTI_RECALL_ALLOWED_GROUPS: '100,not-a-group',
    })).rejects.toThrow('防撤回生效群包含无效 QQ 群号：not-a-group');
    expect(readFileSync(envFilePath, 'utf8')).toBe('UNMANAGED_FLAG=keep\n');
  });

  it('expands ~/ for file system scope paths when saving env', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');

    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath });
    await expect(
      manager.saveEnv({
        CHATLUNA_COMMON_FS_SCOPE_PATH: '~/system',
      }),
    ).resolves.toMatchObject({
      CHATLUNA_COMMON_FS_SCOPE_PATH: join(homedir(), 'system'),
    });
  });

  it('reads state from .env.server when that is the active runtime env file', async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, '.env.server'), 'QQBOT_REPLY_INTERRUPT_ENABLED=true\n', 'utf8');
    vi.stubEnv('QQBOT_ENV_FILE', '.env.server');

    const manager = new AdminRuntimeManager({ rootDir: dir });
    await expect(manager.getManagedEnv()).resolves.toMatchObject({
      QQBOT_REPLY_INTERRUPT_ENABLED: 'true',
    });
    expect(manager.getEnvFilesState()).toMatchObject({
      mode: 'single',
      editTarget: join(dir, '.env.server'),
    });
  });

  it('writes layered env updates into the runtime override file only', async () => {
    const dir = createTempDir();
    const baseEnvFilePath = join(dir, '.env.server');
    const overrideEnvFilePath = join(dir, '.env.runtime');
    writeFileSync(baseEnvFilePath, 'QQBOT_REPLY_INTERRUPT_ENABLED=true\n', 'utf8');

    const manager = new AdminRuntimeManager({
      rootDir: dir,
      envBaseFilePath: baseEnvFilePath,
      envOverrideFilePath: overrideEnvFilePath,
    });

    await expect(manager.saveEnv({ QQBOT_REPLY_INTERRUPT_ENABLED: 'false' })).resolves.toMatchObject({
      QQBOT_REPLY_INTERRUPT_ENABLED: 'false',
    });
    expect(readFileSync(baseEnvFilePath, 'utf8')).toContain('QQBOT_REPLY_INTERRUPT_ENABLED=true');
    expect(readFileSync(overrideEnvFilePath, 'utf8')).toContain('QQBOT_REPLY_INTERRUPT_ENABLED=false');
  });

  it('writes local default env updates into .runtime/.env.runtime instead of .env.local', async () => {
    const dir = createTempDir();
    const baseEnvFilePath = join(dir, '.env.local');
    const overrideEnvFilePath = join(dir, '.runtime/.env.runtime');
    writeFileSync(baseEnvFilePath, 'QQBOT_REPLY_INTERRUPT_ENABLED=true\n', 'utf8');

    const manager = new AdminRuntimeManager({ rootDir: dir });

    await expect(manager.saveEnv({ QQBOT_REPLY_INTERRUPT_ENABLED: 'false' })).resolves.toMatchObject({
      QQBOT_REPLY_INTERRUPT_ENABLED: 'false',
    });
    expect(readFileSync(baseEnvFilePath, 'utf8')).toContain('QQBOT_REPLY_INTERRUPT_ENABLED=true');
    expect(readFileSync(overrideEnvFilePath, 'utf8')).toContain('QQBOT_REPLY_INTERRUPT_ENABLED=false');
  });

  it('loads TTS state from bot env and the local GPT-SoVITS env file', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    const ttsEnvFilePath = join(dir, 'config/voice-tts.local.env');
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(
      envFilePath,
      [
        'QQ_VOICE_OUTPUT_ENABLED=true',
        'QQ_VOICE_TTS_BASE_URL=http://127.0.0.1:5162',
        'QQ_VOICE_TTS_API_KEY=secret',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      ttsEnvFilePath,
      [
        'VOICE_TTS_HOST=127.0.0.1',
        'VOICE_TTS_PORT=5162',
        'VOICE_TTS_INTERNAL_HOST=127.0.0.1',
        'VOICE_TTS_INTERNAL_PORT=9880',
        'VOICE_TTS_DEVICE=cuda',
        'VOICE_TTS_IS_HALF=true',
        'VOICE_TTS_TEXT_LANG=all_zh',
        'VOICE_TTS_PROMPT_LANG=all_ja',
        'VOICE_TTS_VERSION=v2ProPlus',
        '',
      ].join('\n'),
      'utf8',
    );

    const manager = new AdminRuntimeManager({
      rootDir: dir,
      envFilePath,
      ttsEnvFilePath,
      execFile: createSystemdShowExec('active'),
    });

    await expect(manager.getManagedEnv()).resolves.toMatchObject({
      QQ_VOICE_TTS_BASE_URL: 'http://127.0.0.1:5162',
      QQ_VOICE_TTS_API_KEY: 'secret',
    });
    await expect(manager.getTtsState()).resolves.toMatchObject({
      localGateway: expect.objectContaining({
        provider: 'gpt-sovits',
        manageable: true,
        envFile: ttsEnvFilePath,
        envFileExists: true,
        resolved: expect.objectContaining({
          baseUrl: 'http://127.0.0.1:5162',
          upstreamBaseUrl: 'http://127.0.0.1:9880',
          device: 'cuda',
          isHalf: true,
          textLang: 'all_zh',
          promptLang: 'all_ja',
          version: 'v2ProPlus',
        }),
      }),
      health: expect.objectContaining({
        status: 'unknown',
        targetBaseUrl: 'http://127.0.0.1:5162',
      }),
    });
  });

  it('saves TTS bot env separately from local gateway env', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    const ttsEnvFilePath = join(dir, 'config/voice-tts.local.env');
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(envFilePath, 'QQ_VOICE_TTS_BASE_URL=http://127.0.0.1:5162\n', 'utf8');
    writeFileSync(ttsEnvFilePath, 'VOICE_TTS_TEXT_LANG=all_zh\n', 'utf8');

    const manager = new AdminRuntimeManager({
      rootDir: dir,
      envFilePath,
      ttsEnvFilePath,
      execFile: createSystemdShowExec('active'),
    });
    const result = await manager.saveTtsSettings({
      botEnv: {
        QQ_VOICE_OUTPUT_MAX_WORDS: '96',
        QQ_VOICE_OUTPUT_LANGUAGE: 'ja',
      },
      localEnv: {
        VOICE_TTS_TEXT_LANG: 'auto',
      },
    });

    expect(result.restartRequired).toEqual({ bot: true, tts: true });
    expect(result.env.QQ_VOICE_OUTPUT_MAX_WORDS).toBe('96');
    expect(result.env.QQ_VOICE_OUTPUT_LANGUAGE).toBe('ja');
    expect(readFileSync(envFilePath, 'utf8')).toContain('QQ_VOICE_OUTPUT_MAX_WORDS=96');
    expect(readFileSync(envFilePath, 'utf8')).toContain('QQ_VOICE_OUTPUT_LANGUAGE=ja');
    expect(readFileSync(ttsEnvFilePath, 'utf8')).toContain('VOICE_TTS_TEXT_LANG=auto');
    expect(readFileSync(ttsEnvFilePath, 'utf8')).not.toContain('QQ_VOICE_OUTPUT_LANGUAGE');
  });

  it('rejects local TTS env writes from a server runtime manager', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, 'QQ_VOICE_TTS_BASE_URL=http://100.64.0.1:5162\n', 'utf8');

    const manager = new AdminRuntimeManager({
      rootDir: dir,
      envFilePath,
      ttsEnvFilePath: join(dir, 'config/voice-tts.local.env'),
      execFile: createSystemdShowExec('active'),
    });

    await expect(
      manager.saveTtsSettings({
        localEnv: {
          VOICE_TTS_TEXT_LANG: 'auto',
        },
      }),
    ).rejects.toThrow('当前运行角色不管理本机 TTS 网关配置');
  });

  it('probes TTS health and synthesizes a WAV sample through the configured gateway', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(
      envFilePath,
      [
        'QQ_VOICE_TTS_BASE_URL=http://127.0.0.1:5162',
        'QQ_VOICE_TTS_API_KEY=secret',
        'QQ_VOICE_SYNTH_TIMEOUT_MS=300000',
        '',
      ].join('\n'),
      'utf8',
    );

    const wav = createMinimalWav();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret' });
      if (url === 'http://127.0.0.1:5162/healthz') {
        return new Response(JSON.stringify({
          status: 'ok',
          running: true,
          upstreamHost: '127.0.0.1',
          upstreamPort: 9880,
          device: 'cuda',
          isHalf: true,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'http://127.0.0.1:5162/synthesize') {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          text: '你好',
          speaker: 'sakiko',
          style: 'black',
          format: 'wav',
        });
        const body = new ArrayBuffer(wav.byteLength);
        new Uint8Array(body).set(wav);
        return new Response(body, { status: 200, headers: { 'content-type': 'audio/wav' } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const manager = new AdminRuntimeManager({
      rootDir: dir,
      envFilePath,
      execFile: createSystemdShowExec('active'),
    });

    await expect(manager.probeTtsHealth()).resolves.toMatchObject({
      status: 'ok',
      running: true,
      upstreamHost: '127.0.0.1',
      upstreamPort: 9880,
      device: 'cuda',
      isHalf: true,
    });

    await expect(manager.synthesizeTtsAudio({ text: '你好', style: 'black' })).resolves.toMatchObject({
      data: expect.any(Uint8Array),
      contentType: 'audio/wav',
      sampleRate: 32000,
      channels: 1,
    });
  });

  it('schedules qqbot.target restart through a transient user unit', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        stdout: [
          'Description=QQ Bot target',
          'LoadState=loaded',
          'ActiveState=active',
          'SubState=active',
          'UnitFileState=enabled',
        ].join('\n'),
        stderr: '',
      });

    const manager = new AdminRuntimeManager({
      rootDir: dir,
      envFilePath,
      execFile,
      fetchFn: vi.fn(async () => new Response('{}', { status: 200 })),
    });
    const status = await manager.runServiceAction('qqbot.target', 'restart');

    expect(execFile).toHaveBeenNthCalledWith(
      1,
      'systemd-run',
      ['--user', '--quiet', '--on-active=1s', expect.stringMatching(/^--unit=qqbot-target-restart-\d+$/), 'systemctl', '--user', 'restart', 'qqbot.target'],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      'systemctl',
      ['--user', 'show', 'qqbot.target', '--property', 'Description,LoadState,ActiveState,SubState,UnitFileState,Result,InvocationID'],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
    expect(status.controllerState.activeState).toBe('active');
  });

  it('schedules qqbot-koishi.service restart through a transient user unit', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        stdout: [
          'Description=QQBot Koishi Service',
          'LoadState=loaded',
          'ActiveState=active',
          'SubState=running',
          'UnitFileState=enabled',
        ].join('\n'),
        stderr: '',
      });

    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath, execFile });
    const status = await manager.runServiceAction('qqbot-koishi.service', 'restart');

    expect(execFile).toHaveBeenNthCalledWith(
      1,
      'systemd-run',
      ['--user', '--quiet', '--on-active=1s', expect.stringMatching(/^--unit=qqbot-koishi-service-restart-\d+$/), 'systemctl', '--user', 'restart', 'qqbot-koishi.service'],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      'systemctl',
      ['--user', 'show', 'qqbot-koishi.service', '--property', 'Description,LoadState,ActiveState,SubState,UnitFileState,Result,InvocationID'],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
    expect(status.controllerState.activeState).toBe('active');
  });

  it('uses system-level systemctl for server-mode service actions', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        stdout: [
          'Description=QQBot Koishi Service',
          'LoadState=loaded',
          'ActiveState=active',
          'SubState=running',
          'UnitFileState=enabled',
        ].join('\n'),
        stderr: '',
      });

    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath, execFile });
    const status = await manager.runServiceAction('qqbot-koishi.service', 'restart');

    expect(execFile).toHaveBeenNthCalledWith(
      1,
      'systemd-run',
      ['--quiet', '--on-active=1s', expect.stringMatching(/^--unit=qqbot-koishi-service-restart-\d+$/), 'systemctl', 'restart', 'qqbot-koishi.service'],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      'systemctl',
      ['show', 'qqbot-koishi.service', '--property', 'Description,LoadState,ActiveState,SubState,UnitFileState,Result,InvocationID'],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
    expect(status.controllerState.activeState).toBe('active');
  });

  it('returns a trackable handle when a delayed restart is scheduled', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath, execFile });

    const handle = await manager.scheduleRestart('qqbot-koishi.service');

    expect(handle).toMatchObject({
      targetUnit: 'qqbot-koishi.service',
      transientUnit: expect.stringMatching(/^qqbot-koishi-service-restart-\d+$/),
      serviceUnit: expect.stringMatching(/^qqbot-koishi-service-restart-\d+\.service$/),
      timerUnit: expect.stringMatching(/^qqbot-koishi-service-restart-\d+\.timer$/),
      scheduledAt: expect.any(Number),
    });
    expect(execFile).toHaveBeenCalledWith(
      'systemd-run',
      [
        '--quiet',
        '--on-active=1s',
        `--unit=${handle.transientUnit}`,
        'systemctl',
        'restart',
        'qqbot-koishi.service',
      ],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
  });

  it('keeps the apply lease when the target restart is observed', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');
    const handle = createRestartHandle();
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes(handle.targetUnit) && args.includes('ActiveState,SubState,InvocationID,Job')) {
        return { stdout: restartTargetOutput('new-invocation'), stderr: '' };
      }
      throw new Error(`unexpected systemd call: ${args.join(' ')}`);
    });
    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath, execFile });

    await expect(
      manager.superviseScheduledRestart(handle, 'old-invocation', {
        timeoutMs: 0,
        pollIntervalMs: 0,
      }),
    ).resolves.toEqual({
      state: 'restart_observed',
      job: null,
    });
    expect(execFile.mock.calls.some(([, args]) => args.includes('stop'))).toBe(false);
  });

  it('cancels a failed restart job before allowing the apply lease to release', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');
    const handle = createRestartHandle();
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes('stop')) return { stdout: '', stderr: '' };
      if (args.includes(handle.targetUnit) && args.includes('ActiveState,SubState,InvocationID,Job')) {
        return { stdout: restartTargetOutput('old-invocation'), stderr: '' };
      }
      if (args.includes(handle.timerUnit)) {
        return {
          stdout: restartJobUnitOutput({
            activeState: 'inactive',
            subState: 'dead',
          }),
          stderr: '',
        };
      }
      if (args.includes(handle.serviceUnit)) {
        return {
          stdout: restartJobUnitOutput({
            activeState: 'failed',
            subState: 'failed',
            result: 'exit-code',
            execMainStatus: 1,
            startedAt: 123,
          }),
          stderr: '',
        };
      }
      throw new Error(`unexpected systemd call: ${args.join(' ')}`);
    });
    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath, execFile });

    await expect(
      manager.superviseScheduledRestart(handle, 'old-invocation', {
        timeoutMs: 0,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({
      state: 'safe_to_release',
      reason: 'job_failed',
      job: {
        phase: 'failed',
        result: 'exit-code',
        execMainStatus: 1,
      },
    });

    const stopCall = execFile.mock.calls.find(([, args]) => args.includes('stop'));
    expect(stopCall).toEqual([
      'systemctl',
      ['stop', handle.timerUnit, handle.serviceUnit],
      expect.objectContaining({ cwd: dir, timeout: 5_000 }),
    ]);
    const targetChecks = execFile.mock.calls.filter(
      ([, args]) => args.includes(handle.targetUnit)
        && args.includes('ActiveState,SubState,InvocationID,Job'),
    );
    expect(targetChecks).toHaveLength(2);
  });

  it('cancels an externally cancelled restart job before releasing the apply lease', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');
    const handle = createRestartHandle();
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes('stop')) return { stdout: '', stderr: '' };
      if (args.includes(handle.targetUnit) && args.includes('ActiveState,SubState,InvocationID,Job')) {
        return { stdout: restartTargetOutput('old-invocation'), stderr: '' };
      }
      if (args.includes(handle.timerUnit) || args.includes(handle.serviceUnit)) {
        return {
          stdout: restartJobUnitOutput({
            activeState: 'inactive',
            subState: 'dead',
          }),
          stderr: '',
        };
      }
      throw new Error(`unexpected systemd call: ${args.join(' ')}`);
    });
    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath, execFile });

    await expect(
      manager.superviseScheduledRestart(handle, 'old-invocation', {
        timeoutMs: 0,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({
      state: 'safe_to_release',
      reason: 'job_cancelled',
      job: { phase: 'cancelled' },
    });
    expect(execFile.mock.calls.some(([, args]) => args.includes('stop'))).toBe(true);
  });

  it('retains the apply lease when cancelling a delayed restart cannot be confirmed', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');
    const handle = createRestartHandle();
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes('stop')) throw new Error('systemd unavailable token=must-not-surface');
      if (args.includes(handle.targetUnit) && args.includes('ActiveState,SubState,InvocationID,Job')) {
        return { stdout: restartTargetOutput('old-invocation'), stderr: '' };
      }
      if (args.includes(handle.timerUnit)) {
        return {
          stdout: restartJobUnitOutput({
            activeState: 'active',
            subState: 'waiting',
          }),
          stderr: '',
        };
      }
      if (args.includes(handle.serviceUnit)) {
        return {
          stdout: restartJobUnitOutput({
            activeState: 'inactive',
            subState: 'dead',
          }),
          stderr: '',
        };
      }
      throw new Error(`unexpected systemd call: ${args.join(' ')}`);
    });
    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath, execFile });

    const error = await manager.superviseScheduledRestart(
      handle,
      'old-invocation',
      { timeoutMs: 0, pollIntervalMs: 0 },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AdminRestartJobError);
    expect(error).toMatchObject({
      code: 'restart_job_failed',
      operation: 'restart_service',
      stage: 'cancel',
      targetUnit: 'qqbot-koishi.service',
      transientUnit: handle.transientUnit,
      jobPhase: 'scheduled',
    });
    expect((error as Error).message).not.toContain('must-not-surface');
  });

  it('filters local-only TTS units from server-mode service status queries', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');
    const execFile = vi.fn().mockResolvedValue({
      stdout: [
        'Description=QQBot Service',
        'LoadState=loaded',
        'ActiveState=active',
        'SubState=running',
        'UnitFileState=enabled',
      ].join('\n'),
      stderr: '',
    });

    const manager = new AdminRuntimeManager({
      rootDir: dir,
      envFilePath,
      execFile,
      fetchFn: vi.fn(async () => new Response('{}', { status: 200 })),
    });
    const statuses = await manager.getServiceStatuses();

    expect(statuses.map((status) => status.unit)).toEqual([
      'qqbot.target',
      'qqbot-pmhq.service',
      'qqbot-llbot.service',
      'qqbot-koishi.service',
      'cloudflared-qqbot-hbu-jw.service',
      'cloudflared-qqbot-genshin.service',
    ]);
    expect(execFile).toHaveBeenCalledTimes(6);
  });

  it('rejects local-only TTS service actions in server mode', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');
    const execFile = vi.fn();

    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath, execFile });

    await expect(manager.runServiceAction('qqbot-voice-tts.service', 'start')).rejects.toThrow(
      '当前运行角色不支持这个服务',
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reads managed-service journal records for runtime issue collection', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');
    const readProcessLines = vi.fn().mockResolvedValue({
      lines: [
        JSON.stringify({
          __CURSOR: 'runtime-cursor-2',
          __REALTIME_TIMESTAMP: '1800000000000000',
          _SYSTEMD_UNIT: 'qqbot-koishi.service',
          _SYSTEMD_INVOCATION_ID: 'a030b1fd7f4c49d2b54c3e7c339eb284',
          PRIORITY: '6',
          SYSLOG_IDENTIFIER: 'env',
          MESSAGE: '2026-07-27 11:29:49 [E] chatluna Error: Call Embedding Error',
        }),
        '-- cursor: runtime-cursor-2',
      ],
      stderr: '',
    });
    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath, readProcessLines });

    await expect(manager.readRuntimeIssueJournal('runtime-cursor-1')).resolves.toEqual({
      entries: [{
        cursor: 'runtime-cursor-2',
        unit: 'qqbot-koishi.service',
        invocationId: 'a030b1fd7f4c49d2b54c3e7c339eb284',
        priority: 6,
        syslogIdentifier: 'env',
        messageId: null,
        message: '2026-07-27 11:29:49 [E] chatluna Error: Call Embedding Error',
        occurredAt: 1_800_000_000_000,
      }],
      cursor: 'runtime-cursor-2',
    });
    const [, args] = readProcessLines.mock.calls[0];
    expect(args).toContain('--after-cursor=runtime-cursor-1');
    expect(args).toContain('qqbot-koishi.service');
    expect(args).not.toContain('qqbot-voice-tts.service');
    expect(args.some((arg: unknown) => (
      typeof arg === 'string' && arg.startsWith('--output-fields=MESSAGE')
    ))).toBe(true);
  });

  it('reads the latest persisted runtime logs in chronological order', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, 'UNMANAGED_FLAG=keep\n', 'utf8');
    const record = (sequence: number, cursor: string, message: string) => JSON.stringify({
      __SEQNUM: String(sequence),
      __CURSOR: cursor,
      __REALTIME_TIMESTAMP: String(1_800_000_000_000_000 + sequence * 1_000),
      _SYSTEMD_UNIT: 'qqbot-koishi.service',
      PRIORITY: '6',
      MESSAGE: message,
    });
    const readProcessLines = vi.fn().mockResolvedValue({
      lines: [
        record(102, 'cursor-102', '2026-07-27 11:29:51 [E] chatluna failed'),
        record(101, 'cursor-101', '2026-07-27 11:29:50 [I] koishi ready'),
        record(100, 'cursor-100', 'continuation'),
      ],
      stderr: '',
    });
    const execFile = vi.fn().mockResolvedValue({
      stdout: 'Archived and active journals take up 1.4G in the file system.\n',
      stderr: '',
    });
    const manager = new AdminRuntimeManager({ rootDir: dir, envFilePath, readProcessLines, execFile });

    const result = await manager.readRuntimeLogs({ direction: 'newer', limit: 2 });

    expect(result.entries.map((entry) => ({
      id: entry.id,
      cursor: entry.cursor,
      level: entry.level,
      namespace: entry.namespace,
      content: entry.content,
    }))).toEqual([
      { id: 101, cursor: 'cursor-101', level: 'info', namespace: 'koishi', content: 'ready' },
      { id: 102, cursor: 'cursor-102', level: 'error', namespace: 'chatluna', content: 'failed' },
    ]);
    expect(result).toMatchObject({
      oldestCursor: 'cursor-101',
      newestCursor: 'cursor-102',
      hasOlder: true,
      hasNewer: false,
      retentionLimitBytes: 4 * 1024 ** 3,
    });
    expect(readProcessLines.mock.calls[0]?.[1]).toContain('--reverse');
  });

});
