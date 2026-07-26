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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function copilotAutoSessionPayload(overrides: Record<string, unknown> = {}) {
  return {
    session_token: 'copilot-auto-session-token',
    available_models: ['gpt-5-mini', 'gpt-5.4-mini', 'gpt-5.3-codex'],
    discounted_costs: {
      'gpt-5-mini': 0.1,
      'gpt-5.4-mini': 0.1,
      'gpt-5.3-codex': 0.1,
    },
    expires_at: Math.floor((Date.now() + 60_000) / 1000),
    ...overrides,
  };
}

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
    expect(normalizeCopilotModelId('openai/Auto')).toBe('auto');
  });

  it('derives bridge url from koishi port', () => {
    vi.stubEnv('KOISHI_PORT', '6150');
    expect(buildCopilotBridgeBaseUrl(process.env)).toBe('http://127.0.0.1:6150/api/internal/copilot/v1');
  });

  it('generates and persists the bridge secret without reading legacy ChatLuna API keys', async () => {
    const dir = createTempDir();
    vi.stubEnv('KOISHI_PORT', '5140');
    vi.stubEnv('CHATLUNA_COPILOT_API_KEY', 'legacy-copilot-secret');
    vi.stubEnv('CHATLUNA_API_KEY', 'legacy-generic-secret');

    const service = new CopilotOAuthBridgeService({
      rootDir: dir,
      envFiles: {
        mode: 'single',
        baseFilePath: join(dir, '.env.local'),
        overrideFilePath: null,
        editTarget: join(dir, '.env.local'),
      },
    });

    expect(await service.getAdminStatus()).toMatchObject({
      authKind: 'oauth_device',
      authStatus: 'unauthenticated',
      accountLabel: null,
      authError: null,
      attempt: null,
    });

    const config = await service.getRuntimeConfig();
    expect(config.baseUrl).toBe('http://127.0.0.1:5140/api/internal/copilot/v1');
    expect(config.apiKey).not.toBe('legacy-copilot-secret');
    expect(config.apiKey).not.toBe('legacy-generic-secret');
    expect(config.apiKey).toMatch(/^qqbot-copilot-[a-f0-9]{48}$/);
    expect((await readFile(join(dir, '.runtime/github-copilot.bridge-secret'), 'utf8')).trim()).toBe(config.apiKey);

    vi.stubEnv('CHATLUNA_COPILOT_API_KEY', 'different-legacy-secret');
    const restarted = new CopilotOAuthBridgeService({
      rootDir: dir,
      envFiles: {
        mode: 'single',
        baseFilePath: join(dir, '.env.local'),
        overrideFilePath: null,
        editTarget: join(dir, '.env.local'),
      },
    });
    expect((await restarted.getRuntimeConfig()).apiKey).toBe(config.apiKey);
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
    expect(JSON.parse(result.body).error).toMatchObject({
      type: 'invalid_request_error',
      code: 'copilot_oauth_required',
    });
    expect(result.body).not.toContain('gpt-4.1');
  });

  it('returns the Copilot Auto entry after OAuth is ready', async () => {
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

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(copilotAutoSessionPayload()));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await service.proxyModels();
    const body = JSON.parse(result.body) as {
      data: Array<{
        id: string;
        supported_endpoints: string[];
        qqbot: { rateLabel?: string; availableModels?: string[] };
      }>;
    };

    expect(result.status).toBe(200);
    expect(body.data.map((model) => model.id)).toEqual(['auto']);
    expect(body.data.every((model) => model.supported_endpoints.includes('/v1/responses'))).toBe(true);
    expect(body.data[0]?.qqbot).toMatchObject({
      rateLabel: '0.1x',
      availableModels: ['gpt-5-mini', 'gpt-5.4-mini', 'gpt-5.3-codex'],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.individual.githubcopilot.com/models/session',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ auto_mode: { model_hints: ['auto'] } }),
      }),
    );
  });

  it('routes Auto responses through Copilot session intent', async () => {
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

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/models/session')) {
        return jsonResponse(copilotAutoSessionPayload());
      }
      if (url.endsWith('/models/session/intent')) {
        return jsonResponse({
          predicted_label: 'no_reasoning',
          candidate_models: ['gpt-5.4-mini', 'gpt-5.3-codex'],
          chosen_model: 'gpt-5.4-mini',
          fallback: false,
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await service.proxyResponses({
      model: 'openai/auto',
      temperature: 0,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });

    expect(result).toMatchObject({
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
      body: '{"ok":true}',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.individual.githubcopilot.com/models/session/intent',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Copilot-Session-Token': 'copilot-auto-session-token',
        }),
        body: JSON.stringify({
          prompt: 'hello',
          available_models: ['gpt-5-mini', 'gpt-5.4-mini', 'gpt-5.3-codex'],
        }),
      }),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://api.individual.githubcopilot.com/responses',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Copilot-Session-Token': 'copilot-auto-session-token',
        }),
        body: JSON.stringify({
          model: 'gpt-5.4-mini',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          max_output_tokens: 4096,
          reasoning: { effort: 'low' },
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports Auto router transport failures as an upstream gateway error', async () => {
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
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/models/session')) {
        return jsonResponse(copilotAutoSessionPayload());
      }
      throw new Error('Client network socket disconnected before secure TLS connection was established');
    }) as typeof fetch;

    const result = await service.proxyResponses({
      model: 'auto',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });

    expect(result.status).toBe(502);
    expect(result.body).toContain('Copilot Auto 模型路由失败');
    expect(result.body).toContain('Client network socket disconnected');
    expect(JSON.parse(result.body).error).toMatchObject({
      type: 'upstream_error',
      code: 'upstream_transport_error',
    });
  });

  it('rejects concrete Copilot chat completions outside the Auto entry', async () => {
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

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await service.proxyChatCompletions({
      model: 'openai/gpt-5-mini',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.status).toBe(400);
    expect(result.body).toContain('GitHub Copilot Auto 入口列表不支持：gpt-5-mini');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
