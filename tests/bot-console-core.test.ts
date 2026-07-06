import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyEnvPatchToContent,
  buildModelTabsStateFromEnv,
  BotConsoleManager,
  listCopilotModelsFromOAuthBridge,
  listDeepSeekModelsFromOfficialSource,
  listMimoModelsFromOfficialSource,
  mergeManagedEnvRecords,
  parsePresetDocument,
  parseSystemdShowOutput,
  resolveBackupDirectory,
  resolveBotEnvFilePath,
  resolveBotEnvFiles,
  resolveManagedServiceUnits,
  resolveBotPresetPaths,
  readManagedEnvPatchFromContent,
  serializePresetDocument,
  writeFileAtomicWithBackup,
} from '../src/plugins/bot-console/server.js';
import { resolveDefaultLlmCredentials } from '../src/plugins/shared/llm/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-bot-console-'));
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

function createCopilotBridgeWithModels(models: unknown[]) {
  return {
    getRuntimeConfig: async () => ({
      baseUrl: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      apiKey: 'bridge-secret',
    }),
    getConsoleStatus: async () => ({
      authKind: 'oauth_device' as const,
      authStatus: 'ready' as const,
      accountLabel: 'tester',
      authError: null,
    }),
    proxyModels: async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: models }),
    }),
  };
}

function createCodexBridgeWithModels(models: unknown[]) {
  return {
    getRuntimeConfig: async () => ({
      baseUrl: 'http://127.0.0.1:5140/api/internal/codex/v1',
      apiKey: 'codex-bridge-secret',
    }),
    getConsoleStatus: async () => ({
      authKind: 'codex_oauth' as const,
      authStatus: 'ready' as const,
      accountLabel: 'codex-user',
      authError: null,
      tokenExpiresAt: Date.now() + 60_000,
      attempt: null,
    }),
    proxyModels: async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: models }),
    }),
  };
}

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

const COPILOT_ENABLED_MODEL_PAYLOAD = [
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 mini',
    policy: { state: 'enabled' },
    model_picker_enabled: true,
    supported_endpoints: ['/responses', 'ws:/responses'],
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    policy: { state: 'enabled' },
    model_picker_enabled: true,
    capabilities: { supports: { structured_outputs: true } },
    supported_endpoints: ['/chat/completions'],
  },
];

const CODEX_ENABLED_MODEL_PAYLOAD = [
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4-Mini',
  },
];

describe('bot-console env helpers', () => {
  it('preserves comments and unknown lines while patching managed keys', () => {
    const content = [
      '# comment',
      'CHATLUNA_BASE_URL=https://api.siliconflow.cn/v1',
      'UNMANAGED_FLAG=keep-me',
      'QQ_VOICE_INPUT_ENABLED=true',
      '',
    ].join('\n');

    const next = applyEnvPatchToContent(content, {
      CHATLUNA_BASE_URL: 'https://example.com/v1',
      QQ_VOICE_INPUT_ENABLED: 'false',
    });

    expect(next).toContain('# comment');
    expect(next).toContain('UNMANAGED_FLAG=keep-me');
    expect(next).toContain('CHATLUNA_BASE_URL=https://example.com/v1');
    expect(next).toContain('QQ_VOICE_INPUT_ENABLED=false');
  });

  it('keeps the original file when atomic write fails', async () => {
    const dir = createTempDir();
    const filePath = join(dir, '.env.local');
    writeFileSync(filePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    await expect(
      writeFileAtomicWithBackup(filePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5-preview\n', {
        backupDir: join(dir, 'backup'),
        fs: {
          access: async () => undefined,
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

    expect(readFileSync(filePath, 'utf8')).toBe('CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n');
  });

  it('falls back to .env.server when .env.local is absent', () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=deepseek-chat\n', 'utf8');

    expect(resolveBotEnvFilePath(dir)).toBe(envFilePath);
  });

  it('prefers QQBOT_ENV_FILE when explicitly set', () => {
    const dir = createTempDir();
    writeFileSync(join(dir, '.env.local'), 'CHATLUNA_DEFAULT_MODEL=local-model\n', 'utf8');
    writeFileSync(join(dir, '.env.server'), 'CHATLUNA_DEFAULT_MODEL=server-model\n', 'utf8');
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
    writeFileSync(join(dir, '.env.local'), 'CHATLUNA_DEFAULT_MODEL=local-model\n', 'utf8');

    expect(resolveBotEnvFiles(dir)).toEqual({
      mode: 'layered',
      baseFilePath: join(dir, '.env.local'),
      overrideFilePath: join(dir, '.runtime/.env.runtime'),
      editTarget: join(dir, '.runtime/.env.runtime'),
    });
  });

  it('merges managed env values with runtime override precedence', () => {
    const merged = mergeManagedEnvRecords(
      readManagedEnvPatchFromContent('CHATLUNA_DEFAULT_MODEL=base-model\nCHATLUNA_DEFAULT_PRESET=sakiko\n'),
      readManagedEnvPatchFromContent('CHATLUNA_DEFAULT_MODEL=runtime-model\nQQ_VOICE_OUTPUT_ENABLED=false\n'),
    );

    expect(merged).toMatchObject({
      CHATLUNA_DEFAULT_MODEL: 'runtime-model',
      CHATLUNA_DEFAULT_PRESET: 'sakiko',
      QQ_VOICE_OUTPUT_ENABLED: 'false',
    });
  });

  it('builds fixed built-in model tabs from active env state', () => {
    const state = buildModelTabsStateFromEnv({
      CHATLUNA_ACTIVE_TAB: 'openai',
      CHATLUNA_BASE_URL: 'https://shell.wyzai.top/v1',
      CHATLUNA_API_KEY: 'sk-active',
      CHATLUNA_DEFAULT_MODEL: 'openai/gpt-5.4-medium-thinking',
      CHATLUNA_OPENAI_BASE_URL: 'https://shell.wyzai.top/v1',
      CHATLUNA_OPENAI_API_KEY: 'sk-openai',
      CHATLUNA_OPENAI_DEFAULT_MODEL: 'openai/gpt-5.4-medium-thinking',
      CHATLUNA_CODEX_BASE_URL: 'http://127.0.0.1:5140/api/internal/codex/v1',
      CHATLUNA_CODEX_API_KEY: 'codex-bridge-secret',
      CHATLUNA_CODEX_DEFAULT_MODEL: 'openai/gpt-5.5',
      CHATLUNA_CODEX_REASONING_EFFORT: 'xhigh',
      CHATLUNA_COPILOT_BASE_URL: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      CHATLUNA_COPILOT_API_KEY: 'github_pat_123',
      CHATLUNA_COPILOT_DEFAULT_MODEL: 'openai/gpt-5.4-mini',
      CHATLUNA_DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
      CHATLUNA_DEEPSEEK_API_KEY: 'sk-deepseek',
      CHATLUNA_DEEPSEEK_DEFAULT_MODEL: 'deepseek-v4-pro',
      CHATLUNA_MIMO_BASE_URL: 'https://token-plan-cn.xiaomimimo.com/v1',
      CHATLUNA_MIMO_API_KEY: 'sk-mimo',
      CHATLUNA_MIMO_DEFAULT_MODEL: 'mimo-v2.5-pro',
      CHATLUNA_SILICONFLOW_BASE_URL: 'https://custom.invalid/v1',
      CHATLUNA_SILICONFLOW_API_KEY: 'sk-kimi',
      CHATLUNA_SILICONFLOW_DEFAULT_MODEL: 'siliconflow/Pro/moonshotai/Kimi-K2.5',
    } as Record<string, string>);

    expect(state.activeTab).toBe('openai');
    expect(state.tabs).toEqual([
      expect.objectContaining({
        id: 'siliconflow',
        strategyId: 'siliconflow-kimi-main-chat',
        baseUrl: 'https://api.siliconflow.cn/v1',
        defaultModel: 'Pro/moonshotai/Kimi-K2.5',
        canonicalModel: 'Pro/moonshotai/Kimi-K2.5',
        transportModel: 'Pro/moonshotai/Kimi-K2.5',
      }),
      expect.objectContaining({
        id: 'openai',
        requestMode: 'chat_completions',
        structuredOutputProtocol: 'native_chat_json_schema',
        baseUrl: 'https://shell.wyzai.top/v1',
        defaultModel: 'openai/gpt-5.4-medium-thinking',
      }),
      expect.objectContaining({
        id: 'codex',
        strategyId: 'codex-chatgpt-oauth-main-chat',
        requestMode: 'responses',
        structuredOutputProtocol: 'native_responses_json_schema',
        defaultModel: 'openai/gpt-5.5',
        reasoningEffort: 'xhigh',
        canonicalModel: 'openai/gpt-5.5',
        transportModel: 'gpt-5.5',
      }),
      expect.objectContaining({
        id: 'copilot',
        strategyId: 'copilot-github-oauth-main-chat',
        requestMode: 'responses',
        structuredOutputProtocol: 'native_responses_json_schema',
        defaultModel: 'openai/gpt-5.4-mini',
        canonicalModel: 'openai/gpt-5.4-mini',
        transportModel: 'gpt-5.4-mini',
      }),
      expect.objectContaining({
        id: 'deepseek',
        strategyId: 'deepseek-official-main-chat',
        requestMode: 'chat_completions',
        structuredOutputProtocol: 'chat_reply_v1',
        baseUrl: 'https://api.deepseek.com',
        defaultModel: 'deepseek/deepseek-v4-pro',
        canonicalModel: 'deepseek/deepseek-v4-pro',
        transportModel: 'deepseek-v4-pro',
      }),
      expect.objectContaining({
        id: 'mimo',
        strategyId: 'mimo-official-main-chat',
        requestMode: 'chat_completions',
        structuredOutputProtocol: 'native_chat_json_schema',
        baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
        apiKey: 'sk-mimo',
        defaultModel: 'mimo/mimo-v2.5-pro',
        canonicalModel: 'mimo/mimo-v2.5-pro',
        transportModel: 'mimo-v2.5-pro',
      }),
    ]);
  });

  it('loads DeepSeek model ids from the official models endpoint', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.deepseek.com/models');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer sk-deepseek',
        Accept: 'application/json',
      });
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'deepseek-v4-pro', object: 'model' },
            { id: 'deepseek-v4-flash', object: 'model' },
            { id: 'deepseek-v4-pro', object: 'model' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      listDeepSeekModelsFromOfficialSource({
        baseUrl: 'https://api.deepseek.com/',
        apiKey: 'sk-deepseek',
      }),
    ).resolves.toMatchObject({
      source: 'dynamic',
      error: null,
      models: [
        { modelId: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
        { modelId: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
      ],
    });
  });

  it('falls back to the official static DeepSeek model list without an api key', async () => {
    await expect(
      listDeepSeekModelsFromOfficialSource({
        baseUrl: 'https://api.deepseek.com',
        apiKey: '',
      }),
    ).resolves.toMatchObject({
      source: 'static',
      models: [
        { modelId: 'deepseek-v4-flash' },
        { modelId: 'deepseek-v4-pro' },
        { modelId: 'deepseek-chat', deprecated: true, deprecationDate: '2026-07-24' },
        { modelId: 'deepseek-reasoner', deprecated: true, deprecationDate: '2026-07-24' },
      ],
    });
  });

  it('loads and filters MIMO chat model ids from the official models endpoint', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://token-plan-cn.xiaomimimo.com/v1/models');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer sk-mimo',
        Accept: 'application/json',
      });
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'mimo-v2.5-pro', object: 'model' },
            { id: 'mimo-v2.5-tts', object: 'model' },
            { id: 'mimo-v2-omni', object: 'model' },
            { id: 'mimo-v2.5-tts-voiceclone', object: 'model' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      listMimoModelsFromOfficialSource({
        baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1/',
        apiKey: 'sk-mimo',
      }),
    ).resolves.toMatchObject({
      source: 'dynamic',
      error: null,
      models: [
        { modelId: 'mimo-v2.5-pro', label: 'mimo-v2.5-pro' },
        { modelId: 'mimo-v2-omni', label: 'mimo-v2-omni' },
      ],
    });
  });

  it('falls back to the static MIMO chat model list without an api key', async () => {
    await expect(
      listMimoModelsFromOfficialSource({
        baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
        apiKey: '',
      }),
    ).resolves.toMatchObject({
      source: 'static',
      models: [
        { modelId: 'mimo-v2.5-pro' },
        { modelId: 'mimo-v2.5' },
        { modelId: 'mimo-v2-pro' },
        { modelId: 'mimo-v2-omni' },
      ],
    });
  });

  it('loads only enabled picker models from the Copilot OAuth bridge models endpoint', async () => {
    await expect(
      listCopilotModelsFromOAuthBridge(createCopilotBridgeWithModels([
        {
          id: 'gpt-5.4',
          name: 'GPT-5.4',
          policy: { state: 'disabled' },
          model_picker_enabled: true,
          supported_endpoints: ['/responses'],
        },
        {
          id: 'gpt-5.4-mini',
          name: 'GPT-5.4 mini',
          policy: { state: 'enabled' },
          model_picker_enabled: true,
          supported_endpoints: ['/responses', 'ws:/responses'],
        },
        {
          id: 'hidden-model',
          name: 'Hidden',
          policy: { state: 'enabled' },
          model_picker_enabled: false,
          supported_endpoints: ['/responses'],
        },
        {
          id: 'messages-only',
          name: 'Messages only',
          policy: { state: 'enabled' },
          model_picker_enabled: true,
          supported_endpoints: ['/v1/messages'],
        },
      ])),
    ).resolves.toMatchObject({
      source: 'dynamic',
      error: null,
      models: [
        { modelId: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
      ],
    });
  });

  it('does not fall back to a hardcoded Copilot model list when the bridge is unavailable', async () => {
    await expect(listCopilotModelsFromOAuthBridge(undefined)).resolves.toMatchObject({
      source: 'dynamic',
      models: [],
      error: expect.stringContaining('bridge is unavailable'),
    });
  });
});

describe('bot-console preset helpers', () => {
  it('parses and serializes a valid preset document', () => {
    const raw = [
      'keywords:',
      '  - sakiko',
      'prompts:',
      '  - role: system',
      '    content: |-',
      '      hello',
      '',
    ].join('\n');

    const preset = parsePresetDocument('sakiko', '/tmp/sakiko.yml', raw);
    expect(preset.name).toBe('sakiko');
    expect(preset.prompts[0].role).toBe('system');

    const serialized = serializePresetDocument(preset);
    expect(serialized).toContain('keywords:');
    expect(serialized).toContain('role: system');
  });

  it('rejects presets with unsupported roles', () => {
    expect(() =>
      serializePresetDocument({
        name: 'bad-role',
        keywords: [],
        prompts: [{ role: 'moderator' as any, content: 'hi' }],
      }),
    ).toThrow('不支持这个角色类型');
  });

  it('prevents deleting the current default preset', async () => {
    const dir = createTempDir();
    const presetDir = join(dir, 'data/chathub/presets');
    const envFilePath = join(dir, '.env.local');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_PRESET=sakiko\n', 'utf8');
    await writeFile(join(presetDir, 'sakiko.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: hi\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath, presetDirPath: presetDir });
    await expect(manager.deletePreset('sakiko', 'sakiko')).rejects.toThrow('不能删除当前正在使用的默认预设');
  });

  it('lists presets by saved order and appends unordered presets alphabetically', async () => {
    const dir = createTempDir();
    const presetDir = join(dir, 'data/chathub/presets');
    const envFilePath = join(dir, '.env.local');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_PRESET=sakiko\n', 'utf8');
    await Promise.all([
      writeFile(join(presetDir, 'empty.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: empty\n', 'utf8'),
      writeFile(join(presetDir, 'sakiko.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: sakiko\n', 'utf8'),
      writeFile(join(presetDir, 'catgirl.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: catgirl\n', 'utf8'),
      writeFile(join(presetDir, 'sydney.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: sydney\n', 'utf8'),
      writeFile(join(presetDir, '.bot-console-preset-order.json'), JSON.stringify({ names: ['sakiko', 'catgirl'] }), 'utf8'),
    ]);

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath, presetDirPath: presetDir });
    await expect(manager.listPresetSummaries()).resolves.toEqual([
      expect.objectContaining({ name: 'sakiko' }),
      expect.objectContaining({ name: 'catgirl' }),
      expect.objectContaining({ name: 'empty' }),
      expect.objectContaining({ name: 'sydney' }),
    ]);
  });

  it('resolves layered preset directories from runtime env vars', () => {
    const dir = createTempDir();
    vi.stubEnv('CHATLUNA_RUNTIME_PRESET_DIR', '/opt/qqbot/shared/presets');
    vi.stubEnv('CHATLUNA_PRESET_DIRS', '/opt/qqbot/shared/presets:/opt/qqbot/current/data/chathub/presets');

    expect(resolveBotPresetPaths(dir)).toEqual({
      mode: 'layered',
      runtimeDirPath: '/opt/qqbot/shared/presets',
      bundledDirPaths: ['/opt/qqbot/current/data/chathub/presets'],
      allDirPaths: ['/opt/qqbot/shared/presets', '/opt/qqbot/current/data/chathub/presets'],
    });
  });

  it('merges runtime presets ahead of bundled presets and tags their source', async () => {
    const dir = createTempDir();
    const runtimePresetDir = join(dir, 'runtime/presets');
    const bundledPresetDir = join(dir, 'data/chathub/presets');
    const envFilePath = join(dir, '.env.local');
    mkdirSync(runtimePresetDir, { recursive: true });
    mkdirSync(bundledPresetDir, { recursive: true });
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_PRESET=sakiko\n', 'utf8');
    await Promise.all([
      writeFile(join(runtimePresetDir, 'sakiko.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: runtime\n', 'utf8'),
      writeFile(join(runtimePresetDir, 'runtime-only.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: runtime-only\n', 'utf8'),
      writeFile(join(runtimePresetDir, '.bot-console-preset-order.json'), JSON.stringify({ names: ['sakiko', 'runtime-only'] }), 'utf8'),
      writeFile(join(bundledPresetDir, 'sakiko.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: bundled\n', 'utf8'),
      writeFile(join(bundledPresetDir, 'bundled-only.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: bundled-only\n', 'utf8'),
    ]);

    const manager = new BotConsoleManager({
      rootDir: dir,
      envFilePath,
      runtimePresetDirPath: runtimePresetDir,
      bundledPresetDirPaths: [bundledPresetDir],
    });

    await expect(manager.listPresetSummaries()).resolves.toEqual([
      expect.objectContaining({ name: 'sakiko', source: 'runtime' }),
      expect.objectContaining({ name: 'runtime-only', source: 'runtime' }),
      expect.objectContaining({ name: 'bundled-only', source: 'bundled' }),
    ]);
    await expect(manager.getPreset('sakiko')).resolves.toMatchObject({
      name: 'sakiko',
      source: 'runtime',
    });
  });

  it('rejects deleting a bundled-only preset and re-exposes bundled fallback after removing runtime shadow', async () => {
    const dir = createTempDir();
    const runtimePresetDir = join(dir, 'runtime/presets');
    const bundledPresetDir = join(dir, 'data/chathub/presets');
    const envFilePath = join(dir, '.env.local');
    mkdirSync(runtimePresetDir, { recursive: true });
    mkdirSync(bundledPresetDir, { recursive: true });
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_PRESET=sydney\n', 'utf8');
    await Promise.all([
      writeFile(join(runtimePresetDir, 'sakiko.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: runtime\n', 'utf8'),
      writeFile(join(bundledPresetDir, 'sakiko.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: bundled\n', 'utf8'),
      writeFile(join(bundledPresetDir, 'sydney.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: bundled-only\n', 'utf8'),
    ]);

    const manager = new BotConsoleManager({
      rootDir: dir,
      envFilePath,
      runtimePresetDirPath: runtimePresetDir,
      bundledPresetDirPaths: [bundledPresetDir],
    });

    await expect(manager.deletePreset('sydney', 'sakiko')).rejects.toThrow('只能删除运行时预设');
    await expect(manager.deletePreset('sakiko', 'sydney')).resolves.toBeUndefined();
    await expect(manager.getPreset('sakiko')).resolves.toMatchObject({
      name: 'sakiko',
      source: 'bundled',
    });
  });
});

describe('bot-console systemd helpers', () => {
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
  });

  it('keeps server service units scoped to production services', () => {
    expect(resolveManagedServiceUnits('/tmp/qqbot/.env.local')).toContain('qqbot-voice-tts.service');
    expect(resolveManagedServiceUnits('/tmp/qqbot/.env.server')).toContain('cloudflared-qqbot-hbu-jw.service');
    expect(resolveManagedServiceUnits('/tmp/qqbot/.env.server')).not.toContain('qqbot-voice-tts.service');
  });
});

describe('bot-console manager', () => {
  it('rejects unsupported env keys when saving env', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await expect(manager.saveEnv({ HACKED: '1' } as any)).rejects.toThrow('不支持这个配置项');
  });

  it('does not treat legacy OPENAI env keys as managed runtime configuration', async () => {
    expect(readManagedEnvPatchFromContent([
      'OPENAI_BASE_URL=https://legacy.example/v1',
      'OPENAI_API_KEY=sk-legacy',
      'OPENAI_MODEL=legacy-model',
      'CHATLUNA_ACTIVE_TAB=openai',
      'CHATLUNA_OPENAI_BASE_URL=https://current.example/v1',
      'CHATLUNA_OPENAI_API_KEY=sk-current',
      'CHATLUNA_OPENAI_DEFAULT_MODEL=openai/gpt-5.4-medium-thinking',
    ].join('\n'))).toEqual({
      CHATLUNA_ACTIVE_TAB: 'openai',
      CHATLUNA_OPENAI_BASE_URL: 'https://current.example/v1',
      CHATLUNA_OPENAI_API_KEY: 'sk-current',
      CHATLUNA_OPENAI_DEFAULT_MODEL: 'openai/gpt-5.4-medium-thinking',
    });

    expect(resolveDefaultLlmCredentials({
      OPENAI_BASE_URL: 'https://legacy.example/v1',
      OPENAI_API_KEY: 'sk-legacy',
      OPENAI_MODEL: 'legacy-model',
      CHATLUNA_ACTIVE_TAB: 'openai',
      CHATLUNA_OPENAI_BASE_URL: 'https://current.example/v1',
      CHATLUNA_OPENAI_API_KEY: 'sk-current',
      CHATLUNA_OPENAI_DEFAULT_MODEL: 'openai/gpt-5.4-medium-thinking',
    })).toEqual({
      baseUrl: 'https://current.example/v1',
      apiKey: 'sk-current',
      model: 'openai/gpt-5.4-medium-thinking',
    });

    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await expect(manager.saveEnv({ OPENAI_MODEL: 'legacy-model' } as any)).rejects.toThrow('不支持这个配置项：OPENAI_MODEL');
  });

  it('accepts QQBOT_REPLY_INTERRUPT_ENABLED through managed env saves', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await expect(manager.saveEnv({ QQBOT_REPLY_INTERRUPT_ENABLED: 'false' })).resolves.toMatchObject({
      QQBOT_REPLY_INTERRUPT_ENABLED: 'false',
    });
  });

  it('accepts realtime-message env settings through managed env saves', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
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
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
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
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await expect(
      manager.saveEnv({
        HBU_JW_ALLOWED_GROUPS: '100\n200， group:300',
        CHAT_NATURAL_TRIGGER_GROUPS: '100、200 300',
        CHATLUNA_COMMON_FS_ALLOWED_GROUPS: 'group:100\n guild:200',
      }),
    ).resolves.toMatchObject({
      HBU_JW_ALLOWED_GROUPS: '100,200,group:300',
      CHAT_NATURAL_TRIGGER_GROUPS: '100,200,300',
      CHATLUNA_COMMON_FS_ALLOWED_GROUPS: 'group:100,guild:200',
    });
    expect(readFileSync(envFilePath, 'utf8')).toContain('HBU_JW_ALLOWED_GROUPS=100,200,group:300');
  });

  it('expands ~/ for file system scope paths when saving env', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await expect(
      manager.saveEnv({
        CHATLUNA_COMMON_FS_SCOPE_PATH: '~/system',
      }),
    ).resolves.toMatchObject({
      CHATLUNA_COMMON_FS_SCOPE_PATH: join(homedir(), 'system'),
    });
  });

  it('syncs chatluna-agent local computer config from managed env saves', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await manager.saveEnv({
      CHATLUNA_COMMON_FS: 'true',
      CHATLUNA_COMMON_FS_SCOPE_PATH: '~/system',
    });

    const config = JSON.parse(readFileSync(join(dir, 'data/chatluna/agent/config.json'), 'utf8'));
    expect(config).toMatchObject({
      version: 4,
      computer: {
        defaultProvider: 'local',
        local: {
          enabled: true,
          approvalMode: 'never',
          dangerouslySkipPermissions: true,
          networkPolicy: 'allow',
          scopePath: join(homedir(), 'system'),
        },
        e2b: {
          enabled: false,
        },
        openTerminal: {
          enabled: false,
        },
      },
    });
  });

  it('preserves non-computer agent config fields when syncing managed computer config', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    const agentConfigPath = join(dir, 'data/chatluna/agent/config.json');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');
    mkdirSync(join(dir, 'data/chatluna/agent'), { recursive: true });
    writeFileSync(agentConfigPath, JSON.stringify({
      version: 4,
      mcp: { mcpServers: { demo: { command: 'echo', args: ['1'] } }, tools: {} },
    }, null, 2), 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await manager.saveEnv({
      CHATLUNA_COMMON_FS: 'true',
    });

    const config = JSON.parse(readFileSync(agentConfigPath, 'utf8'));
    expect(config.mcp).toEqual({
      mcpServers: { demo: { command: 'echo', args: ['1'] } },
      tools: {},
    });
    expect(config.computer.local.enabled).toBe(true);
  });

  it('reads state from .env.server when that is the active runtime env file', async () => {
    const dir = createTempDir();
    const presetDir = join(dir, 'data/chathub/presets');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(join(dir, '.env.server'), 'CHATLUNA_DEFAULT_MODEL=server-model\nCHATLUNA_DEFAULT_PRESET=sakiko\n', 'utf8');
    writeFileSync(join(presetDir, 'sakiko.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: hi\n', 'utf8');
    vi.stubEnv('QQBOT_ENV_FILE', '.env.server');

    const manager = new BotConsoleManager({ rootDir: dir });
    await expect(manager.getState()).resolves.toMatchObject({
      env: expect.objectContaining({
        CHATLUNA_DEFAULT_MODEL: 'server-model',
        CHATLUNA_DEFAULT_PRESET: 'sakiko',
      }),
      envFiles: expect.objectContaining({
        mode: 'single',
        editTarget: join(dir, '.env.server'),
      }),
      defaultPreset: 'sakiko',
    });
  });

  it('writes layered env updates into the runtime override file only', async () => {
    const dir = createTempDir();
    const baseEnvFilePath = join(dir, '.env.server');
    const overrideEnvFilePath = join(dir, '.env.runtime');
    writeFileSync(baseEnvFilePath, 'CHATLUNA_DEFAULT_MODEL=base-model\nCHATLUNA_DEFAULT_PRESET=sakiko\n', 'utf8');

    const manager = new BotConsoleManager({
      rootDir: dir,
      envBaseFilePath: baseEnvFilePath,
      envOverrideFilePath: overrideEnvFilePath,
    });

    await expect(manager.saveEnv({ CHATLUNA_DEFAULT_MODEL: 'runtime-model' })).resolves.toMatchObject({
      CHATLUNA_DEFAULT_MODEL: 'runtime-model',
      CHATLUNA_DEFAULT_PRESET: 'sakiko',
    });
    expect(readFileSync(baseEnvFilePath, 'utf8')).toContain('CHATLUNA_DEFAULT_MODEL=base-model');
    expect(readFileSync(overrideEnvFilePath, 'utf8')).toContain('CHATLUNA_DEFAULT_MODEL=runtime-model');
  });

  it('writes local default env updates into .runtime/.env.runtime instead of .env.local', async () => {
    const dir = createTempDir();
    const baseEnvFilePath = join(dir, '.env.local');
    const overrideEnvFilePath = join(dir, '.runtime/.env.runtime');
    writeFileSync(baseEnvFilePath, 'CHATLUNA_DEFAULT_MODEL=base-model\nCHATLUNA_DEFAULT_PRESET=sakiko\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir });

    await expect(manager.saveEnv({ CHATLUNA_DEFAULT_MODEL: 'runtime-model' })).resolves.toMatchObject({
      CHATLUNA_DEFAULT_MODEL: 'runtime-model',
      CHATLUNA_DEFAULT_PRESET: 'sakiko',
    });
    expect(readFileSync(baseEnvFilePath, 'utf8')).toContain('CHATLUNA_DEFAULT_MODEL=base-model');
    expect(readFileSync(overrideEnvFilePath, 'utf8')).toContain('CHATLUNA_DEFAULT_MODEL=runtime-model');
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

    const manager = new BotConsoleManager({
      rootDir: dir,
      envFilePath,
      ttsEnvFilePath,
      execFile: createSystemdShowExec('active'),
    });

    await expect(manager.getState()).resolves.toMatchObject({
      env: expect.objectContaining({
        QQ_VOICE_TTS_BASE_URL: 'http://127.0.0.1:5162',
        QQ_VOICE_TTS_API_KEY: 'secret',
      }),
      tts: {
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
      },
    });
  });

  it('saves TTS bot env separately from local gateway env', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    const ttsEnvFilePath = join(dir, 'config/voice-tts.local.env');
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(envFilePath, 'QQ_VOICE_TTS_BASE_URL=http://127.0.0.1:5162\n', 'utf8');
    writeFileSync(ttsEnvFilePath, 'VOICE_TTS_TEXT_LANG=all_zh\n', 'utf8');

    const manager = new BotConsoleManager({
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

    const manager = new BotConsoleManager({
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

    const manager = new BotConsoleManager({
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

    await expect(manager.synthesizeTtsSample({ text: '你好', style: 'black' })).resolves.toMatchObject({
      ok: true,
      style: 'black',
      bytes: wav.byteLength,
      contentType: 'audio/wav',
      audio: {
        format: 'wav',
        sampleRate: 32000,
        channels: 1,
      },
    });
  });

  it('mirrors the active built-in tab into runtime chatluna env keys', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(
      envFilePath,
      [
        'CHATLUNA_BASE_URL=https://api.siliconflow.cn/v1',
        'CHATLUNA_API_KEY=sk-old',
        'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5',
        '',
      ].join('\n'),
      'utf8',
    );

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    const result = await manager.saveModelTabs({
      activeTab: 'openai',
      dirtyTabIds: ['openai'],
      tabs: [
        {
          id: 'siliconflow',
          title: '硅基流动',
          provider: 'siliconflow',
          strategyId: 'siliconflow-kimi-main-chat',
          requestMode: 'chat_completions',
          structuredOutputProtocol: 'native_chat_json_schema',
          description: 'siliconflow',
          modelHint: 'kimi',
          authKind: 'manual',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'https://custom.invalid/v1',
          apiKey: 'sk-kimi',
          defaultModel: 'siliconflow/Pro/moonshotai/Kimi-K2.5',
        },
        {
          id: 'openai',
          title: 'OpenAI',
          provider: 'openai',
          strategyId: 'openai-gpt54-main-chat',
          requestMode: 'chat_completions',
          structuredOutputProtocol: 'native_chat_json_schema',
          description: 'openai',
          modelHint: 'gpt-5.4',
          authKind: 'manual',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'https://shell.wyzai.top/v1',
          apiKey: 'sk-openai',
          defaultModel: 'openai/gpt-5.4-medium-thinking',
        },
        {
          id: 'copilot',
          title: 'GitHub Copilot',
          provider: 'openai',
          strategyId: 'copilot-github-oauth-main-chat',
          requestMode: 'responses',
          structuredOutputProtocol: 'native_responses_json_schema',
          description: 'copilot',
          modelHint: 'openai/gpt-5.4-mini',
          authKind: 'oauth_device',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'http://127.0.0.1:5140/api/internal/copilot/v1',
          apiKey: 'github_pat_123',
          defaultModel: 'openai/gpt-5.4-mini',
        },
        {
          id: 'deepseek',
          title: 'DeepSeek',
          provider: 'deepseek',
          strategyId: 'deepseek-official-main-chat',
          requestMode: 'chat_completions',
          structuredOutputProtocol: 'chat_reply_v1',
          description: 'deepseek',
          modelHint: 'deepseek-v4-flash',
          authKind: 'manual',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'https://api.deepseek.com',
          apiKey: '',
          defaultModel: 'deepseek-v4-flash',
        },
      ],
    });

    expect(result.modelTabs.activeTab).toBe('openai');
    expect(result.modelTabs.tabs).toContainEqual(expect.objectContaining({
      id: 'siliconflow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      defaultModel: 'Pro/moonshotai/Kimi-K2.5',
      canonicalModel: 'Pro/moonshotai/Kimi-K2.5',
      transportModel: 'Pro/moonshotai/Kimi-K2.5',
    }));
    expect(result.env).toMatchObject({
      CHATLUNA_ACTIVE_TAB: 'openai',
      CHATLUNA_PLATFORM: 'openai',
      CHATLUNA_BASE_URL: 'https://shell.wyzai.top/v1',
      CHATLUNA_API_KEY: 'sk-openai',
      CHATLUNA_DEFAULT_MODEL: 'openai/gpt-5.4-medium-thinking',
      CHATLUNA_SILICONFLOW_BASE_URL: 'https://api.siliconflow.cn/v1',
      CHATLUNA_SILICONFLOW_DEFAULT_MODEL: 'Pro/moonshotai/Kimi-K2.5',
      CHATLUNA_OPENAI_DEFAULT_MODEL: 'openai/gpt-5.4-medium-thinking',
      CHATLUNA_COPILOT_BASE_URL: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      CHATLUNA_COPILOT_API_KEY: 'github_pat_123',
      CHATLUNA_COPILOT_DEFAULT_MODEL: 'openai/gpt-5.4-mini',
      CHATLUNA_DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
      CHATLUNA_DEEPSEEK_DEFAULT_MODEL: 'deepseek/deepseek-v4-flash',
    });
  });

  it('mirrors the DeepSeek tab into runtime chatluna env keys', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    const result = await manager.saveModelTabs({
      activeTab: 'deepseek',
      dirtyTabIds: ['deepseek'],
      tabs: [
        {
          id: 'siliconflow',
          provider: 'siliconflow',
          baseUrl: 'https://api.siliconflow.cn/v1',
          apiKey: 'sk-kimi',
          defaultModel: 'Pro/moonshotai/Kimi-K2.5',
        },
        {
          id: 'openai',
          provider: 'openai',
          baseUrl: 'https://shell.wyzai.top/v1',
          apiKey: 'sk-openai',
          defaultModel: 'openai/gpt-5.4-medium-thinking',
        },
        {
          id: 'copilot',
          provider: 'openai',
          baseUrl: 'http://127.0.0.1:5140/api/internal/copilot/v1',
          apiKey: 'github_pat_123',
          defaultModel: 'openai/gpt-5.4-mini',
        },
        {
          id: 'deepseek',
          provider: 'deepseek',
          baseUrl: 'https://api.deepseek.com/',
          apiKey: '',
          defaultModel: 'deepseek-v4-pro',
        },
      ] as any,
    });

    expect(result.modelTabs.activeTab).toBe('deepseek');
    expect(result.modelTabs.tabs).toContainEqual(expect.objectContaining({
      id: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      structuredOutputProtocol: 'chat_reply_v1',
      defaultModel: 'deepseek/deepseek-v4-pro',
      canonicalModel: 'deepseek/deepseek-v4-pro',
      transportModel: 'deepseek-v4-pro',
    }));
    expect(result.env).toMatchObject({
      CHATLUNA_ACTIVE_TAB: 'deepseek',
      CHATLUNA_PLATFORM: 'deepseek',
      CHATLUNA_BASE_URL: 'https://api.deepseek.com',
      CHATLUNA_DEFAULT_MODEL: 'deepseek/deepseek-v4-pro',
      CHATLUNA_DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
      CHATLUNA_DEEPSEEK_DEFAULT_MODEL: 'deepseek/deepseek-v4-pro',
    });
  });

  it('mirrors the Codex tab into runtime chatluna env keys with Responses metadata', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({
      rootDir: dir,
      envFilePath,
      codexBridge: createCodexBridgeWithModels(CODEX_ENABLED_MODEL_PAYLOAD),
    });
    const result = await manager.saveModelTabs({
      activeTab: 'codex',
      dirtyTabIds: ['codex'],
      tabs: [
        {
          id: 'codex',
          provider: 'openai',
          baseUrl: 'http://127.0.0.1:5140/api/internal/codex/v1',
          apiKey: '',
          defaultModel: 'openai/gpt-5.5',
          reasoningEffort: 'high',
        },
      ] as any,
    });

    expect(result.modelTabs.activeTab).toBe('codex');
    expect(result.modelTabs.tabs).toContainEqual(expect.objectContaining({
      id: 'codex',
      strategyId: 'codex-chatgpt-oauth-main-chat',
      requestMode: 'responses',
      structuredOutputProtocol: 'native_responses_json_schema',
      baseUrl: 'http://127.0.0.1:5140/api/internal/codex/v1',
      apiKey: 'codex-bridge-secret',
      defaultModel: 'openai/gpt-5.5',
      reasoningEffort: 'high',
      canonicalModel: 'openai/gpt-5.5',
      transportModel: 'gpt-5.5',
    }));
    expect(result.env).toMatchObject({
      CHATLUNA_ACTIVE_TAB: 'codex',
      CHATLUNA_PLATFORM: 'openai',
      CHATLUNA_BASE_URL: 'http://127.0.0.1:5140/api/internal/codex/v1',
      CHATLUNA_API_KEY: 'codex-bridge-secret',
      CHATLUNA_DEFAULT_MODEL: 'openai/gpt-5.5',
      CHATLUNA_CODEX_BASE_URL: 'http://127.0.0.1:5140/api/internal/codex/v1',
      CHATLUNA_CODEX_API_KEY: 'codex-bridge-secret',
      CHATLUNA_CODEX_DEFAULT_MODEL: 'openai/gpt-5.5',
      CHATLUNA_CODEX_REASONING_EFFORT: 'high',
    });
  });

  it('mirrors the MIMO tab into runtime chatluna env keys and inherited credentials', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(
      envFilePath,
      [
        'CHATLUNA_MIMO_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1',
        'CHATLUNA_MIMO_API_KEY=sk-mimo',
        'CHATLUNA_MIMO_DEFAULT_MODEL=mimo-v2.5-pro',
        '',
      ].join('\n'),
      'utf8',
    );

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    const result = await manager.saveModelTabs({
      activeTab: 'mimo',
      dirtyTabIds: ['mimo'],
      tabs: [
        {
          id: 'mimo',
          provider: 'mimo',
          baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1/',
          apiKey: '',
          defaultModel: 'mimo-v2-omni',
        },
      ] as any,
    });

    expect(result.modelTabs.activeTab).toBe('mimo');
    expect(result.modelTabs.tabs).toContainEqual(expect.objectContaining({
      id: 'mimo',
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      apiKey: 'sk-mimo',
      defaultModel: 'mimo/mimo-v2-omni',
      canonicalModel: 'mimo/mimo-v2-omni',
      transportModel: 'mimo-v2-omni',
    }));
    expect(result.env).toMatchObject({
      CHATLUNA_ACTIVE_TAB: 'mimo',
      CHATLUNA_PLATFORM: 'mimo',
      CHATLUNA_BASE_URL: 'https://token-plan-cn.xiaomimimo.com/v1',
      CHATLUNA_API_KEY: 'sk-mimo',
      CHATLUNA_DEFAULT_MODEL: 'mimo/mimo-v2-omni',
      CHATLUNA_MIMO_BASE_URL: 'https://token-plan-cn.xiaomimimo.com/v1',
      CHATLUNA_MIMO_API_KEY: 'sk-mimo',
      CHATLUNA_MIMO_DEFAULT_MODEL: 'mimo/mimo-v2-omni',
    });
    expect(resolveDefaultLlmCredentials(result.env)).toMatchObject({
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      apiKey: 'sk-mimo',
      model: 'mimo/mimo-v2-omni',
    });
  });

  it('rejects unsupported MIMO TTS models', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_MIMO_API_KEY=sk-mimo\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await expect(
      manager.saveModelTabs({
        activeTab: 'mimo',
        dirtyTabIds: ['mimo'],
        tabs: [
          {
            id: 'mimo',
            provider: 'mimo',
            baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
            apiKey: '',
            defaultModel: 'mimo-v2.5-tts',
          },
        ] as any,
      }),
    ).rejects.toThrow(/MIMO Tab：.*不在允许的聊天模型列表中/);
  });

  it('rejects unsupported OpenAI tab models', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await expect(
      manager.saveModelTabs({
        activeTab: 'openai',
        dirtyTabIds: ['openai'],
        tabs: [
          {
            id: 'siliconflow',
            title: '硅基流动',
            provider: 'siliconflow',
          strategyId: 'siliconflow-kimi-main-chat',
          requestMode: 'chat_completions',
          structuredOutputProtocol: 'native_chat_json_schema',
          description: 'siliconflow',
          modelHint: 'kimi',
          authKind: 'manual',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'https://api.siliconflow.cn/v1',
          apiKey: 'sk-kimi',
          defaultModel: 'Pro/moonshotai/Kimi-K2.5',
        },
          {
            id: 'openai',
            title: 'OpenAI',
            provider: 'openai',
          strategyId: 'openai-gpt54-main-chat',
          requestMode: 'chat_completions',
          structuredOutputProtocol: 'native_chat_json_schema',
          description: 'openai',
          modelHint: 'gpt-5.4',
          authKind: 'manual',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'https://shell.wyzai.top/v1',
          apiKey: 'sk-openai',
          defaultModel: 'openai/gpt-5.2',
        },
          {
          id: 'copilot',
          title: 'GitHub Copilot',
          provider: 'openai',
          strategyId: 'copilot-github-oauth-main-chat',
          requestMode: 'responses',
          structuredOutputProtocol: 'native_responses_json_schema',
          description: 'copilot',
          modelHint: 'openai/gpt-5.4-mini',
          authKind: 'oauth_device',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'http://127.0.0.1:5140/api/internal/copilot/v1',
          apiKey: 'github_pat_123',
          defaultModel: 'openai/gpt-5.4-mini',
        },
      ],
    }),
    ).rejects.toThrow(/OpenAI Tab：.*不在允许的模型族内/);
  });

  it('derives Copilot chat-completions metadata from the selected Copilot model', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({
      rootDir: dir,
      envFilePath,
      copilotBridge: createCopilotBridgeWithModels(COPILOT_ENABLED_MODEL_PAYLOAD),
    });
    const result = await manager.saveModelTabs({
      activeTab: 'copilot',
      dirtyTabIds: ['copilot'],
      tabs: [
        {
          id: 'siliconflow',
          title: '硅基流动',
          provider: 'siliconflow',
          strategyId: 'siliconflow-kimi-main-chat',
          requestMode: 'chat_completions',
          structuredOutputProtocol: 'native_chat_json_schema',
          description: 'siliconflow',
          modelHint: 'kimi',
          authKind: 'manual',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'https://api.siliconflow.cn/v1',
          apiKey: 'sk-kimi',
          defaultModel: 'Pro/moonshotai/Kimi-K2.5',
        },
        {
          id: 'openai',
          title: 'OpenAI',
          provider: 'openai',
          strategyId: 'openai-gpt54-main-chat',
          requestMode: 'chat_completions',
          structuredOutputProtocol: 'native_chat_json_schema',
          description: 'openai',
          modelHint: 'gpt-5.4',
          authKind: 'manual',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'https://shell.wyzai.top/v1',
          apiKey: 'sk-openai',
          defaultModel: 'openai/gpt-5.4-medium-thinking',
        },
        {
          id: 'copilot',
          title: 'GitHub Copilot',
          provider: 'openai',
          strategyId: 'copilot-github-oauth-main-chat',
          requestMode: 'responses',
          structuredOutputProtocol: 'native_responses_json_schema',
          description: 'copilot',
          modelHint: 'openai/gpt-4o',
          authKind: 'oauth_device',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'http://127.0.0.1:5140/api/internal/copilot/v1',
          apiKey: 'github_pat_123',
          defaultModel: 'openai/gpt-4o',
        },
        {
          id: 'deepseek',
          title: 'DeepSeek',
          provider: 'deepseek',
          strategyId: 'deepseek-official-main-chat',
          requestMode: 'chat_completions',
          structuredOutputProtocol: 'chat_reply_v1',
          description: 'deepseek',
          modelHint: 'deepseek-v4-flash',
          authKind: 'manual',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'https://api.deepseek.com',
          apiKey: '',
          defaultModel: 'deepseek-v4-flash',
        },
      ],
    });

    expect(result.modelTabs.activeTab).toBe('copilot');
    expect(result.modelTabs.tabs).toContainEqual(expect.objectContaining({
      id: 'copilot',
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'native_chat_json_schema',
      defaultModel: 'openai/gpt-4o',
      canonicalModel: 'openai/gpt-4o',
      transportModel: 'gpt-4o',
    }));
    expect(result.env).toMatchObject({
      CHATLUNA_ACTIVE_TAB: 'copilot',
      CHATLUNA_DEFAULT_MODEL: 'openai/gpt-4o',
      CHATLUNA_COPILOT_DEFAULT_MODEL: 'openai/gpt-4o',
    });
  });

  it('rejects unsupported Copilot tab models', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({
      rootDir: dir,
      envFilePath,
      copilotBridge: createCopilotBridgeWithModels(COPILOT_ENABLED_MODEL_PAYLOAD.slice(0, 1)),
    });
    await expect(
      manager.saveModelTabs({
        activeTab: 'copilot',
        dirtyTabIds: ['copilot'],
        tabs: [
          {
            id: 'siliconflow',
            title: '硅基流动',
            provider: 'siliconflow',
          strategyId: 'siliconflow-kimi-main-chat',
          requestMode: 'chat_completions',
          structuredOutputProtocol: 'native_chat_json_schema',
          description: 'siliconflow',
          modelHint: 'kimi',
          authKind: 'manual',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'https://api.siliconflow.cn/v1',
          apiKey: 'sk-kimi',
          defaultModel: 'Pro/moonshotai/Kimi-K2.5',
        },
          {
            id: 'openai',
            title: 'OpenAI',
            provider: 'openai',
          strategyId: 'openai-gpt54-main-chat',
          requestMode: 'chat_completions',
          structuredOutputProtocol: 'native_chat_json_schema',
          description: 'openai',
          modelHint: 'gpt-5.4',
          authKind: 'manual',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'https://shell.wyzai.top/v1',
          apiKey: 'sk-openai',
          defaultModel: 'openai/gpt-5.4-medium-thinking',
        },
          {
          id: 'copilot',
          title: 'GitHub Copilot',
          provider: 'openai',
          strategyId: 'copilot-github-oauth-main-chat',
          requestMode: 'responses',
          structuredOutputProtocol: 'native_responses_json_schema',
          description: 'copilot',
          modelHint: 'openai/gpt-5.4-mini',
          authKind: 'oauth_device',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'http://127.0.0.1:5140/api/internal/copilot/v1',
          apiKey: 'github_pat_123',
          defaultModel: 'bad model',
        },
      ],
    }),
    ).rejects.toThrow(/GitHub Copilot Tab：.*不在当前 OAuth 可用模型列表内/);
  });

  it('rejects unsupported Codex tab models outside the current visible API catalog', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({
      rootDir: dir,
      envFilePath,
      codexBridge: createCodexBridgeWithModels(CODEX_ENABLED_MODEL_PAYLOAD.slice(0, 1)),
    });
    await expect(
      manager.saveModelTabs({
        activeTab: 'codex',
        dirtyTabIds: ['codex'],
        tabs: [
          {
            id: 'codex',
            provider: 'openai',
            baseUrl: 'http://127.0.0.1:5140/api/internal/codex/v1',
            apiKey: '',
            defaultModel: 'openai/gpt-5.4-mini',
          },
        ] as any,
      }),
    ).rejects.toThrow(/Codex Tab：.*不在当前 Codex 可见 API 模型列表内/);
  });

  it('rejects unsupported DeepSeek tab models when using the official fallback list', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await expect(
      manager.saveModelTabs({
        activeTab: 'deepseek',
        dirtyTabIds: ['deepseek'],
        tabs: [
          {
            id: 'siliconflow',
            provider: 'siliconflow',
            baseUrl: 'https://api.siliconflow.cn/v1',
            apiKey: 'sk-kimi',
            defaultModel: 'Pro/moonshotai/Kimi-K2.5',
          },
          {
            id: 'openai',
            provider: 'openai',
            baseUrl: 'https://shell.wyzai.top/v1',
            apiKey: 'sk-openai',
            defaultModel: 'openai/gpt-5.4-medium-thinking',
          },
          {
            id: 'copilot',
            provider: 'openai',
            baseUrl: 'http://127.0.0.1:5140/api/internal/copilot/v1',
            apiKey: 'github_pat_123',
            defaultModel: 'openai/gpt-5.4-mini',
          },
          {
            id: 'deepseek',
            provider: 'deepseek',
            baseUrl: 'https://api.deepseek.com',
            apiKey: '',
            defaultModel: 'not-official',
          },
        ] as any,
      }),
    ).rejects.toThrow(/DeepSeek Tab：.*不在允许的模型列表中/);
  });

  it('skips strict validation for tabs that the client did not mark as dirty', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(
      envFilePath,
      [
        'CHATLUNA_ACTIVE_TAB=siliconflow',
        'CHATLUNA_OPENAI_BASE_URL=https://shell.wyzai.top/v1',
        'CHATLUNA_OPENAI_API_KEY=sk-stale',
        // legacy/invalid value left in env from a prior bad save
        'CHATLUNA_OPENAI_DEFAULT_MODEL=openai/gpt-5.2',
        '',
      ].join('\n'),
      'utf8',
    );

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });

    // Client only marks the deepseek tab as dirty. The stale OPENAI tab value should not
    // block the unrelated save anymore.
    const result = await manager.saveModelTabs({
      activeTab: 'deepseek',
      dirtyTabIds: ['deepseek'],
      tabs: [
        {
          id: 'siliconflow',
          provider: 'siliconflow',
          baseUrl: 'https://api.siliconflow.cn/v1',
          apiKey: 'sk-kimi',
          defaultModel: 'Pro/moonshotai/Kimi-K2.5',
        },
        {
          id: 'openai',
          provider: 'openai',
          baseUrl: 'https://shell.wyzai.top/v1',
          apiKey: 'sk-stale',
          // unchanged, still illegal — but client did not mark this tab dirty
          defaultModel: 'openai/gpt-5.2',
        },
        {
          id: 'copilot',
          provider: 'openai',
          baseUrl: 'http://127.0.0.1:5140/api/internal/copilot/v1',
          apiKey: 'github_pat_123',
          defaultModel: 'openai/gpt-5.4-mini',
        },
        {
          id: 'deepseek',
          provider: 'deepseek',
          baseUrl: 'https://api.deepseek.com',
          apiKey: '',
          defaultModel: 'deepseek-v4-flash',
        },
      ] as any,
    });

    expect(result.modelTabs.activeTab).toBe('deepseek');
    expect(result.env).toMatchObject({
      CHATLUNA_ACTIVE_TAB: 'deepseek',
      CHATLUNA_DEEPSEEK_DEFAULT_MODEL: 'deepseek/deepseek-v4-flash',
    });
  });

  it('rejects model tab saves without a dirty tab list', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await expect(
      manager.saveModelTabs({
        activeTab: 'openai',
        tabs: [],
      } as any),
    ).rejects.toThrow('保存模型 Tab 必须携带已修改的 Tab 列表');
  });

  it('rejects unknown model tabs in save payloads', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await expect(
      manager.saveModelTabs({
        activeTab: 'openai',
        dirtyTabIds: ['openai'],
        tabs: [
          {
            id: 'openai',
            baseUrl: 'https://shell.wyzai.top/v1',
            apiKey: 'sk-openai',
            defaultModel: 'openai/gpt-5.4-medium-thinking',
          },
          { id: 'ghost' },
        ] as any,
      }),
    ).rejects.toThrow('未知模型 Tab：ghost');
  });

  it('schedules qqbot.target restart through a transient user unit', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');
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

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath, execFile });
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
      ['--user', 'show', 'qqbot.target', '--property', 'Description,LoadState,ActiveState,SubState,UnitFileState'],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
    expect(status.activeState).toBe('active');
  });

  it('schedules qqbot-koishi.service restart through a transient user unit', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');
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

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath, execFile });
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
      ['--user', 'show', 'qqbot-koishi.service', '--property', 'Description,LoadState,ActiveState,SubState,UnitFileState'],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
    expect(status.activeState).toBe('active');
  });

  it('uses system-level systemctl for server-mode service actions', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');
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

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath, execFile });
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
      ['show', 'qqbot-koishi.service', '--property', 'Description,LoadState,ActiveState,SubState,UnitFileState'],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
    expect(status.activeState).toBe('active');
  });

  it('filters local-only TTS units from server-mode service status queries', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');
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

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath, execFile });
    const statuses = await manager.getServiceStatuses();

    expect(statuses.map((status) => status.unit)).toEqual([
      'qqbot.target',
      'qqbot-pmhq.service',
      'qqbot-llbot.service',
      'qqbot-koishi.service',
      'cloudflared-qqbot-hbu-jw.service',
    ]);
    expect(execFile).toHaveBeenCalledTimes(5);
  });

  it('rejects local-only TTS service actions in server mode', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5\n', 'utf8');
    const execFile = vi.fn();

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath, execFile });

    await expect(manager.runServiceAction('qqbot-voice-tts.service', 'start')).rejects.toThrow(
      '当前运行角色不支持这个服务',
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it('persists custom preset order and removes deleted presets from it', async () => {
    const dir = createTempDir();
    const presetDir = join(dir, 'data/chathub/presets');
    const envFilePath = join(dir, '.env.local');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_PRESET=sakiko\n', 'utf8');
    await Promise.all([
      writeFile(join(presetDir, 'catgirl.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: catgirl\n', 'utf8'),
      writeFile(join(presetDir, 'empty.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: empty\n', 'utf8'),
      writeFile(join(presetDir, 'sakiko.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: sakiko\n', 'utf8'),
    ]);

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath, presetDirPath: presetDir });
    await expect(manager.reorderPresets(['sakiko', 'catgirl', 'empty'])).resolves.toEqual([
      expect.objectContaining({ name: 'sakiko' }),
      expect.objectContaining({ name: 'catgirl' }),
      expect.objectContaining({ name: 'empty' }),
    ]);

    await manager.deletePreset('catgirl', 'sakiko');
    await expect(manager.listPresetSummaries()).resolves.toEqual([
      expect.objectContaining({ name: 'sakiko' }),
      expect.objectContaining({ name: 'empty' }),
    ]);
  });
});
