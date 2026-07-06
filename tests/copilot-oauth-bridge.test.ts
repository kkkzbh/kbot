import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CopilotOAuthBridgeService,
  buildCopilotBridgeBaseUrl,
  normalizeCopilotModelId,
  resolveCopilotStateDir,
} from '../src/plugins/copilot-oauth/service.js';

function createTempDir() {
  return mkdtempSync(join(tmpdir(), 'qqbot-copilot-oauth-'));
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe('copilot oauth bridge helpers', () => {
  it('resolves state dir from env mode', () => {
    expect(
      resolveCopilotStateDir('/repo', {
        mode: 'single',
        baseFilePath: '/repo/.env.local',
        overrideFilePath: null,
        editTarget: '/repo/.env.local',
      }),
    ).toBe('/repo/.runtime');

    expect(
      resolveCopilotStateDir('/repo', {
        mode: 'layered',
        baseFilePath: '/opt/qqbot/current/.env.server',
        overrideFilePath: '/opt/qqbot/shared/.env.runtime',
        editTarget: '/opt/qqbot/shared/.env.runtime',
      }),
    ).toBe('/opt/qqbot/shared');
  });

  it('normalizes copilot model ids from legacy prefixes', () => {
    expect(normalizeCopilotModelId('openai/gpt-4o')).toBe('gpt-4o');
    expect(normalizeCopilotModelId('github-copilot/claude-haiku-4.5')).toBe('claude-haiku-4.5');
    expect(normalizeCopilotModelId('gpt-5-mini')).toBe('gpt-5-mini');
  });

  it('derives bridge url from koishi port', () => {
    vi.stubEnv('KOISHI_PORT', '6150');
    expect(buildCopilotBridgeBaseUrl(process.env)).toBe('http://127.0.0.1:6150/api/internal/copilot/v1');
  });

  it('seeds bridge secret from env and reports unauthenticated status by default', async () => {
    const dir = createTempDir();
    vi.stubEnv('KOISHI_PORT', '5140');
    vi.stubEnv('CHATLUNA_COPILOT_API_KEY', 'copilot-bridge-test-secret');

    const service = new CopilotOAuthBridgeService({
      rootDir: dir,
      envFiles: {
        mode: 'single',
        baseFilePath: join(dir, '.env.local'),
        overrideFilePath: null,
        editTarget: join(dir, '.env.local'),
      },
    });

    expect(await service.getConsoleStatus()).toMatchObject({
      authKind: 'oauth_device',
      authStatus: 'unauthenticated',
      accountLabel: null,
      authError: null,
      attempt: null,
    });

    expect(await service.getRuntimeConfig()).toEqual({
      baseUrl: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      apiKey: 'copilot-bridge-test-secret',
    });

    expect((await readFile(join(dir, '.runtime/github-copilot.bridge-secret'), 'utf8')).trim()).toBe(
      'copilot-bridge-test-secret',
    );
  });

  it('does not seed the Copilot bridge secret from the generic ChatLuna key', async () => {
    const dir = createTempDir();
    vi.stubEnv('CHATLUNA_API_KEY', 'generic-chatluna-secret');

    const service = new CopilotOAuthBridgeService({
      rootDir: dir,
      envFiles: {
        mode: 'single',
        baseFilePath: join(dir, '.env.local'),
        overrideFilePath: null,
        editTarget: join(dir, '.env.local'),
      },
    });

    const config = await service.getRuntimeConfig();
    expect(config.apiKey).not.toBe('generic-chatluna-secret');
    expect(config.apiKey).toMatch(/^qqbot-copilot-[a-f0-9]{48}$/);
    expect((await readFile(join(dir, '.runtime/github-copilot.bridge-secret'), 'utf8')).trim()).toBe(config.apiKey);
  });

  it('includes upstream device-code HTTP details in OAuth errors', async () => {
    const dir = createTempDir();
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad oauth app', { status: 403 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const service = new CopilotOAuthBridgeService({
      rootDir: dir,
      envFiles: {
        mode: 'single',
        baseFilePath: join(dir, '.env.local'),
        overrideFilePath: null,
        editTarget: join(dir, '.env.local'),
      },
    });

    await expect(service.startLogin()).rejects.toThrow('GitHub 设备码申请失败：HTTP 403 bad oauth app');
  });

  it('uses HTTPS_PROXY for GitHub device-code requests', async () => {
    const dir = createTempDir();
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7897');
    vi.stubEnv('https_proxy', '');
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('no_proxy', '');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      device_code: 'device-code',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchMock as typeof fetch;

    const service = new CopilotOAuthBridgeService({
      rootDir: dir,
      envFiles: {
        mode: 'single',
        baseFilePath: join(dir, '.env.local'),
        overrideFilePath: null,
        editTarget: join(dir, '.env.local'),
      },
    });

    await service.startLogin();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://github.com/login/device/code',
      expect.objectContaining({
        dispatcher: expect.any(Object),
      }),
    );
  });

  it('respects NO_PROXY for GitHub device-code requests', async () => {
    const dir = createTempDir();
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7897');
    vi.stubEnv('https_proxy', '');
    vi.stubEnv('NO_PROXY', 'github.com');
    vi.stubEnv('no_proxy', '');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      device_code: 'device-code',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchMock as typeof fetch;

    const service = new CopilotOAuthBridgeService({
      rootDir: dir,
      envFiles: {
        mode: 'single',
        baseFilePath: join(dir, '.env.local'),
        overrideFilePath: null,
        editTarget: join(dir, '.env.local'),
      },
    });

    await service.startLogin();

    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('dispatcher');
  });

  it('does not synthesize a hardcoded models response when OAuth is unavailable', async () => {
    const dir = createTempDir();
    const service = new CopilotOAuthBridgeService({
      rootDir: dir,
      envFiles: {
        mode: 'single',
        baseFilePath: join(dir, '.env.local'),
        overrideFilePath: null,
        editTarget: join(dir, '.env.local'),
      },
    });

    const result = await service.proxyModels();

    expect(result.status).toBe(401);
    expect(result.body).toContain('GitHub Copilot 尚未完成 OAuth 登录');
    expect(result.body).not.toContain('gpt-5.4-mini');
  });

  it('proxies chat completions through the Copilot bridge and normalizes model ids', async () => {
    const dir = createTempDir();
    const service = new CopilotOAuthBridgeService({
      rootDir: dir,
      envFiles: {
        mode: 'single',
        baseFilePath: join(dir, '.env.local'),
        overrideFilePath: null,
        editTarget: join(dir, '.env.local'),
      },
    });

    vi.spyOn(service, 'resolveCopilotSession').mockResolvedValue({
      token: 'copilot-session-token',
      baseUrl: 'https://api.individual.githubcopilot.com',
      expiresAt: Date.now() + 60_000,
      updatedAt: Date.now(),
    });

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://api.individual.githubcopilot.com/models') {
        return {
          status: 200,
          headers: {
            get(name: string) {
              return name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null;
            },
          },
          text: async () => JSON.stringify({
            data: [{
              id: 'gpt-4o',
              model_picker_enabled: true,
              capabilities: { type: 'chat' },
              supported_endpoints: ['/chat/completions'],
            }],
          }),
        };
      }
      return {
        status: 200,
        headers: {
          get(name: string) {
            return name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null;
          },
        },
        text: async () => '{"ok":true}',
      };
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await service.proxyChatCompletions({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result).toMatchObject({
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
      body: '{"ok":true}',
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://api.individual.githubcopilot.com/chat/completions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    );
  });

  it('rejects Copilot chat completions for policy-only models', async () => {
    const dir = createTempDir();
    const service = new CopilotOAuthBridgeService({
      rootDir: dir,
      envFiles: {
        mode: 'single',
        baseFilePath: join(dir, '.env.local'),
        overrideFilePath: null,
        editTarget: join(dir, '.env.local'),
      },
    });

    vi.spyOn(service, 'resolveCopilotSession').mockResolvedValue({
      token: 'copilot-session-token',
      baseUrl: 'https://api.individual.githubcopilot.com',
      expiresAt: Date.now() + 60_000,
      updatedAt: Date.now(),
    });

    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: {
        get(name: string) {
          return name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null;
        },
      },
      text: async () => JSON.stringify({
        data: [{
          id: 'gpt-5-mini',
          model_picker_enabled: false,
          capabilities: { type: 'chat' },
          supported_endpoints: ['/chat/completions', '/responses'],
        }],
      }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await service.proxyChatCompletions({
      model: 'openai/gpt-5-mini',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.status).toBe(400);
    expect(result.body).toContain('GitHub Copilot 模型未开放 model picker/API chat 调用：gpt-5-mini');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.individual.githubcopilot.com/models',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
