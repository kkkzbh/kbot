import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexOAuthBridgeService,
  buildCodexBridgeBaseUrl,
  decodeJwtExpiresAtMs,
  filterCodexModelCatalog,
  resolveCodexStateDir,
} from '../src/plugins/codex-oauth/service.js';
import {
  CODEX_RELEASE_METADATA_TTL_MS,
  CODEX_RELEASE_METADATA_URL,
  CodexReleaseMetadataProvider,
} from '../src/plugins/codex-oauth/release-metadata.js';

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;
const TEST_CODEX_VERSION = '0.145.0';

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-codex-oauth-'));
  tempDirs.push(dir);
  return dir;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(payload)}.sig`;
}

function createService(dir: string) {
  writeCodexReleaseMetadata(dir);
  return new CodexOAuthBridgeService({
    rootDir: dir,
    envFiles: {
      mode: 'single',
      baseFilePath: join(dir, '.env.local'),
      overrideFilePath: null,
      editTarget: join(dir, '.env.local'),
    },
  });
}

function writeCodexReleaseMetadata(
  dir: string,
  overrides: Partial<{
    version: string;
    releaseTag: string;
    etag: string;
    fetchedAt: string;
  }> = {},
): void {
  const version = overrides.version ?? TEST_CODEX_VERSION;
  const stateDir = join(dir, '.runtime');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'codex-release-metadata.json'), `${JSON.stringify({
    schemaVersion: 1,
    version,
    releaseTag: overrides.releaseTag ?? `rust-v${version}`,
    etag: overrides.etag ?? '"release-etag"',
    fetchedAt: overrides.fetchedAt ?? new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
}

function writeCodexAuth(dir: string, auth: unknown): void {
  const stateDir = join(dir, '.runtime');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'codex-chatgpt.oauth.json'), `${JSON.stringify(auth, null, 2)}\n`, 'utf8');
}

function readCodexAuth(dir: string): any {
  return JSON.parse(readFileSync(join(dir, '.runtime/codex-chatgpt.oauth.json'), 'utf8'));
}

describe('codex oauth bridge helpers', () => {
  it('resolves state dir from env mode and derives bridge url from koishi port', () => {
    expect(
      resolveCodexStateDir('/repo', {
        mode: 'single',
        baseFilePath: '/repo/.env.local',
        overrideFilePath: null,
        editTarget: '/repo/.env.local',
      }),
    ).toBe('/repo/.runtime');

    expect(
      resolveCodexStateDir('/repo', {
        mode: 'layered',
        baseFilePath: '/opt/qqbot/current/.env.server',
        overrideFilePath: '/opt/qqbot/shared/.env.runtime',
        editTarget: '/opt/qqbot/shared/.env.runtime',
      }),
    ).toBe('/opt/qqbot/shared');

    vi.stubEnv('KOISHI_PORT', '6151');
    expect(buildCodexBridgeBaseUrl(process.env)).toBe('http://127.0.0.1:6151/api/internal/codex/v1');
  });

  it('generates and persists the bridge secret without reading legacy ChatLuna API keys', async () => {
    const dir = createTempDir();
    vi.stubEnv('CHATLUNA_CODEX_API_KEY', 'legacy-codex-secret');
    vi.stubEnv('CHATLUNA_API_KEY', 'legacy-generic-secret');

    const service = createService(dir);
    const config = await service.getRuntimeConfig();

    expect(config.baseUrl).toBe('http://127.0.0.1:5140/api/internal/codex/v1');
    expect(config.apiKey).not.toBe('legacy-codex-secret');
    expect(config.apiKey).not.toBe('legacy-generic-secret');
    expect(config.apiKey).toMatch(/^qqbot-codex-[a-f0-9]{48}$/);
    expect(readFileSync(join(dir, '.runtime/codex-oauth.bridge-secret'), 'utf8').trim()).toBe(config.apiKey);

    vi.stubEnv('CHATLUNA_CODEX_API_KEY', 'different-legacy-secret');
    expect((await createService(dir).getRuntimeConfig()).apiKey).toBe(config.apiKey);
  });

  it('synchronizes official release metadata with ETag revalidation and atomic state', async () => {
    const dir = createTempDir();
    let now = Date.parse('2026-07-25T00:00:00.000Z');
    const fetchFn = vi.fn()
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('if-none-match')).toBeNull();
        return new Response(JSON.stringify({
          tag_name: 'rust-v0.145.0',
          draft: false,
          prerelease: false,
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ETag: '"release-v145"',
          },
        });
      })
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('if-none-match')).toBe('"release-v145"');
        return new Response(null, { status: 304 });
      });
    const provider = new CodexReleaseMetadataProvider({
      stateDir: join(dir, '.runtime'),
      fetchFn: fetchFn as typeof fetch,
      now: () => now,
    });

    await expect(provider.refresh({ force: true })).resolves.toMatchObject({
      status: 'ready',
      clientVersion: '0.145.0',
      fetchedAt: '2026-07-25T00:00:00.000Z',
    });
    expect(JSON.parse(readFileSync(join(dir, '.runtime/codex-release-metadata.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      version: '0.145.0',
      releaseTag: 'rust-v0.145.0',
      etag: '"release-v145"',
      fetchedAt: '2026-07-25T00:00:00.000Z',
    });

    now += CODEX_RELEASE_METADATA_TTL_MS;
    await expect(provider.refresh()).resolves.toMatchObject({
      status: 'ready',
      clientVersion: '0.145.0',
      fetchedAt: '2026-07-25T01:00:00.000Z',
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls.every(([url]) => url === CODEX_RELEASE_METADATA_URL)).toBe(true);
  });

  it('marks release metadata degraded after a failed refresh and keeps the last confirmed version', async () => {
    const dir = createTempDir();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tag_name: 'rust-v0.145.0',
        draft: false,
        prerelease: false,
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ETag: '"release-v145"',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'rate limit exceeded' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }));
    const provider = new CodexReleaseMetadataProvider({
      stateDir: join(dir, '.runtime'),
      fetchFn: fetchFn as typeof fetch,
    });

    await provider.refresh({ force: true });
    await expect(provider.refresh({ force: true })).resolves.toMatchObject({
      status: 'degraded',
      clientVersion: '0.145.0',
      error: expect.stringContaining('HTTP 403 / rate limit exceeded'),
    });
    expect(JSON.parse(readFileSync(join(dir, '.runtime/codex-release-metadata.json'), 'utf8'))).toMatchObject({
      version: '0.145.0',
      releaseTag: 'rust-v0.145.0',
    });
  });

  it('rejects draft, prerelease, and malformed release tags without manufacturing a client version', async () => {
    const fixtures = [
      {
        payload: { tag_name: 'rust-v9.9.9', draft: true, prerelease: false },
        error: 'draft',
      },
      {
        payload: { tag_name: 'rust-v9.9.9', draft: false, prerelease: true },
        error: 'prerelease',
      },
      {
        payload: { tag_name: 'v9.9.9', draft: false, prerelease: false },
        error: 'release tag',
      },
    ];

    for (const fixture of fixtures) {
      const dir = createTempDir();
      const provider = new CodexReleaseMetadataProvider({
        stateDir: join(dir, '.runtime'),
        fetchFn: vi.fn(async () => new Response(JSON.stringify(fixture.payload), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ETag: '"unconfirmed"',
          },
        })) as typeof fetch,
      });

      await expect(provider.refresh({ force: true })).resolves.toMatchObject({
        status: 'unavailable',
        clientVersion: null,
        error: expect.stringContaining(fixture.error),
      });
    }
  });

  it('filters Codex catalog to visible API-supported model slugs', () => {
    expect(filterCodexModelCatalog({
      models: [
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_in_api: true },
        { slug: 'gpt-5.3-codex-spark', display_name: 'Spark', visibility: 'list', supported_in_api: false },
        { slug: 'codex-auto-review', display_name: 'Auto Review', visibility: 'hide', supported_in_api: true },
        { slug: 'openai/bad', display_name: 'Bad', visibility: 'list', supported_in_api: true },
        { slug: 'gpt-5.5', display_name: 'duplicate', visibility: 'list', supported_in_api: true },
        { id: 'gpt-5.4-mini', name: 'GPT-5.4-Mini', visibility: 'list', supported_in_api: true },
      ],
    })).toEqual([
      { modelId: 'gpt-5.5', label: 'GPT-5.5' },
      { modelId: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
    ]);
  });

  it('reports missing Codex ChatGPT auth without token material', async () => {
    const dir = createTempDir();
    const status = await createService(dir).getAdminStatus({ probe: true });

    expect(status).toMatchObject({
      authKind: 'codex_oauth',
      authStatus: 'unauthenticated',
      accountLabel: null,
      tokenExpiresAt: null,
    });
    expect(status.authError).toContain('控制台 Codex Tab');
    expect(JSON.stringify(status)).not.toContain('access_token');
    expect(JSON.stringify(status)).not.toContain('refresh_token');
  });

  it('starts and completes a managed Codex OAuth device login without exposing token material', async () => {
    const dir = createTempDir();
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      client_id: 'codex-client',
      'https://api.openai.com/profile': { email: 'managed@example.test' },
    });
    const idToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: ['codex-client'],
      email: 'managed@example.test',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-managed',
        chatgpt_plan_type: 'pro',
      },
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
        expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
        expect(JSON.parse(String(init?.body))).toMatchObject({
          client_id: expect.any(String),
        });
        return new Response(JSON.stringify({
          device_auth_id: 'device-123',
          user_code: 'ABCD-EFGH',
          interval: '1',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
        expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
        expect(JSON.parse(String(init?.body))).toEqual({
          device_auth_id: 'device-123',
          user_code: 'ABCD-EFGH',
        });
        return new Response(JSON.stringify({
          authorization_code: 'auth-code-123',
          code_challenge: 'challenge-from-codex',
          code_verifier: 'verifier-from-codex',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        expect(String(init?.body)).toContain('grant_type=authorization_code');
        expect(String(init?.body)).toContain('code=auth-code-123');
        expect(String(init?.body)).toContain('code_verifier=');
        return new Response(JSON.stringify({
          access_token: accessToken,
          refresh_token: 'managed-refresh',
          id_token: idToken,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const service = createService(dir);
    const started = await service.startLogin();
    expect(started).toMatchObject({
      authKind: 'codex_oauth',
      authStatus: 'pending',
      attempt: {
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://auth.openai.com/codex/device',
        state: 'pending',
      },
    });
    expect(JSON.stringify(started)).not.toContain(accessToken);

    const polled = await service.pollLogin(started.attempt?.attemptId ?? '');
    const persisted = readCodexAuth(dir);
    expect(polled).toMatchObject({
      authKind: 'codex_oauth',
      authStatus: 'ready',
      accountLabel: 'managed@example.test',
      tokenExpiresAt: decodeJwtExpiresAtMs(accessToken),
      attempt: null,
    });
    expect(persisted.tokens.access_token).toBe(accessToken);
    expect(persisted.tokens.refresh_token).toBe('managed-refresh');
    expect(persisted.tokens.account_id).toBe('acct-managed');
    expect(JSON.stringify(polled)).not.toContain(accessToken);
    expect(JSON.stringify(polled)).not.toContain('managed-refresh');
  });

  it('keeps Codex OAuth device login pending while the Codex token endpoint returns 403', async () => {
    const dir = createTempDir();
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
        return new Response(JSON.stringify({
          device_auth_id: 'device-403',
          user_code: 'WAIT-403',
          interval: '1',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
        return new Response('', { status: 403 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const service = createService(dir);
    const started = await service.startLogin();
    const polled = await service.pollLogin(started.attempt?.attemptId ?? '');

    expect(polled).toMatchObject({
      authKind: 'codex_oauth',
      authStatus: 'pending',
      authError: null,
      attempt: {
        userCode: 'WAIT-403',
        state: 'pending',
      },
    });
  });

  it('surfaces OpenAI device-code errors without exposing token material', async () => {
    const dir = createTempDir();
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
        return new Response(JSON.stringify({
          error: {
            code: 'device_code_not_enabled',
            type: 'request_forbidden',
            message: 'Device code login is not enabled.',
          },
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const service = createService(dir);
    await expect(service.startLogin()).rejects.toThrow(/device_code_not_enabled/);
    await expect(service.startLogin()).rejects.toThrow(/device code 登录需要/);
    await expect(service.startLogin()).rejects.not.toThrow(/access_token|refresh_token/i);
  });

  it('uses HTTPS_PROXY for Codex device-code requests', async () => {
    const dir = createTempDir();
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7897');
    vi.stubEnv('https_proxy', '');
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('no_proxy', '');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      device_auth_id: 'device-proxy',
      user_code: 'PROXY-123',
      interval: 5,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    globalThis.fetch = fetchMock as typeof fetch;

    await createService(dir).startLogin();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://auth.openai.com/api/accounts/deviceauth/usercode',
      expect.objectContaining({
        dispatcher: expect.any(Object),
      }),
    );
  });

  it('respects NO_PROXY for Codex device-code requests', async () => {
    const dir = createTempDir();
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7897');
    vi.stubEnv('https_proxy', '');
    vi.stubEnv('NO_PROXY', 'auth.openai.com');
    vi.stubEnv('no_proxy', '');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      device_auth_id: 'device-direct',
      user_code: 'DIRECT-12',
      interval: 5,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    globalThis.fetch = fetchMock as typeof fetch;

    await createService(dir).startLogin();

    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('dispatcher');
  });

  it('refreshes near-expiry Codex OAuth tokens and preserves managed auth state atomically', async () => {
    const dir = createTempDir();
    const oldAccess = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 30,
      client_id: 'codex-client',
      'https://api.openai.com/profile': { email: 'tester@example.test' },
    });
    const oldRefresh = 'old-refresh-token';
    const newAccess = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, client_id: 'codex-client' });
    const newIdToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: ['codex-client'],
      email: 'tester@example.test',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123',
      },
    });
    writeCodexAuth(dir, {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: oldAccess,
        refresh_token: oldRefresh,
        id_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, aud: ['codex-client'] }),
        account_id: 'acct_123',
      },
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://auth.openai.com/oauth/token');
      expect(String(init?.body)).toContain('grant_type=refresh_token');
      expect(String(init?.body)).toContain('client_id=codex-client');
      expect(String(init?.body)).toContain(`refresh_token=${oldRefresh}`);
      return new Response(JSON.stringify({
        access_token: newAccess,
        refresh_token: 'new-refresh-token',
        id_token: newIdToken,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const status = await createService(dir).getAdminStatus({ probe: true });
    const persisted = readCodexAuth(dir);

    expect(status).toMatchObject({
      authKind: 'codex_oauth',
      authStatus: 'ready',
      accountLabel: 'tester@example.test',
      authError: null,
      tokenExpiresAt: decodeJwtExpiresAtMs(newAccess),
    });
    expect(persisted.tokens.access_token).toBe(newAccess);
    expect(persisted.tokens.refresh_token).toBe('new-refresh-token');
    expect(persisted.tokens.account_id).toBe('acct_123');
    expect(JSON.stringify(status)).not.toContain(oldAccess);
    expect(JSON.stringify(status)).not.toContain(newAccess);
    expect(JSON.stringify(status)).not.toContain(oldRefresh);
  });

  it('refreshes Codex OAuth tokens and retries ChatGPT backend responses after upstream 401', async () => {
    const dir = createTempDir();
    const oldAccess = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, client_id: 'codex-client' });
    const oldRefresh = 'old-refresh-token';
    const newAccess = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 7200, client_id: 'codex-client' });
    const newIdToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 7200,
      aud: ['codex-client'],
      email: 'retry@example.test',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-retry',
      },
    });
    writeCodexAuth(dir, {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: oldAccess,
        refresh_token: oldRefresh,
        account_id: 'acct-retry',
      },
    });

    let responseCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://chatgpt.com/backend-api/codex/responses') {
        responseCalls += 1;
        expect(init?.headers).toMatchObject({
          Authorization: `Bearer ${responseCalls === 1 ? oldAccess : newAccess}`,
          'ChatGPT-Account-ID': 'acct-retry',
        });
        return new Response(responseCalls === 1 ? '{"error":{"message":"expired"}}' : '{"ok":true}', {
          status: responseCalls === 1 ? 401 : 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        expect(String(init?.body)).toContain('grant_type=refresh_token');
        expect(String(init?.body)).toContain(`refresh_token=${oldRefresh}`);
        return new Response(JSON.stringify({
          access_token: newAccess,
          refresh_token: 'new-refresh-token',
          id_token: newIdToken,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await createService(dir).proxyResponses({
      model: 'openai/gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });
    const persisted = readCodexAuth(dir);

    expect(result).toMatchObject({
      status: 200,
      body: '{"ok":true}',
    });
    expect(responseCalls).toBe(2);
    expect(persisted.tokens.access_token).toBe(newAccess);
    expect(persisted.tokens.refresh_token).toBe('new-refresh-token');
    expect(result.body).not.toContain(oldAccess);
    expect(result.body).not.toContain(newAccess);
  });

  it('serves models from Codex catalog and proxies responses with stripped model ids', async () => {
    const dir = createTempDir();
    const accessToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, client_id: 'codex-client' });
    writeCodexAuth(dir, {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: accessToken,
        refresh_token: 'refresh-token',
        account_id: 'acct-managed',
      },
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `https://chatgpt.com/backend-api/codex/models?client_version=${TEST_CODEX_VERSION}`) {
        expect(init).toMatchObject({ method: 'GET' });
        expect(init?.headers).toMatchObject({
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'ChatGPT-Account-ID': 'acct-managed',
          originator: 'codex_cli_rs',
          'User-Agent': `codex_cli_rs/${TEST_CODEX_VERSION}`,
          version: TEST_CODEX_VERSION,
        });
        return new Response(JSON.stringify({
          models: [
            { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_in_api: true },
            { slug: 'gpt-5.3-codex-spark', display_name: 'Spark', visibility: 'list', supported_in_api: false },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
      }
      if (url === 'https://chatgpt.com/backend-api/codex/responses') {
        const body = JSON.parse(String(init?.body)) as Record<string, any>;
        expect(init).toMatchObject({ method: 'POST' });
        expect(init?.headers).toMatchObject({
          Authorization: `Bearer ${accessToken}`,
          'ChatGPT-Account-ID': 'acct-managed',
          originator: 'codex_cli_rs',
          'Content-Type': 'application/json',
          'User-Agent': `codex_cli_rs/${TEST_CODEX_VERSION}`,
          version: TEST_CODEX_VERSION,
        });
        expect(init?.headers).toEqual(expect.objectContaining({
          'session-id': expect.any(String),
          'thread-id': expect.any(String),
        }));
        expect(body).toMatchObject({
          model: 'gpt-5.5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          store: false,
          stream: true,
          prompt_cache_key: expect.any(String),
          client_metadata: {
            'x-codex-installation-id': expect.any(String),
            session_id: expect.any(String),
            thread_id: expect.any(String),
            turn_id: expect.any(String),
            'x-codex-window-id': 'qqbot-koishi-codex-bridge',
            'x-codex-turn-metadata': expect.any(String),
          },
        });
        expect(body).not.toHaveProperty('temperature');
        expect(body).not.toHaveProperty('top_p');
        expect(body).not.toHaveProperty('stop');
        expect(body).not.toHaveProperty('max_output_tokens');
        expect(body.client_metadata.thread_id).toBe((init?.headers as Record<string, string>)['thread-id']);
        expect(body.client_metadata.session_id).toBe((init?.headers as Record<string, string>)['session-id']);
        expect(JSON.parse(body.client_metadata['x-codex-turn-metadata'])).toMatchObject({
          installation_id: body.client_metadata['x-codex-installation-id'],
          session_id: body.client_metadata.session_id,
          thread_id: body.client_metadata.thread_id,
          turn_id: body.client_metadata.turn_id,
          window_id: 'qqbot-koishi-codex-bridge',
        });
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const service = createService(dir);
    const models = await service.proxyModels();
    expect(models.status).toBe(200);
    expect(JSON.parse(models.body)).toMatchObject({
      data: [
        {
          id: 'gpt-5.5',
          supported_endpoints: ['/v1/responses'],
          capabilities: { structured_outputs: false },
          qqbot: {
            requestMode: 'responses',
            structuredOutputProtocol: 'chat_reply_v1',
          },
        },
      ],
    });
    expect(models.body).not.toContain(accessToken);
    const cachedModels = await service.proxyModels();
    expect(cachedModels).toEqual(models);

    const result = await service.proxyResponses({
      model: 'openai/gpt-5.5',
      temperature: 0.8,
      top_p: 0.95,
      stop: ['END'],
      max_output_tokens: 512,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });

    expect(result).toMatchObject({
      status: 200,
      body: '{"ok":true}',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns an explicit upstream error without static models when catalog synchronization fails', async () => {
    const dir = createTempDir();
    writeCodexAuth(dir, {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        account_id: 'acct-managed',
      },
    });
    globalThis.fetch = vi.fn(async (url: string) => {
      expect(url).toBe(`https://chatgpt.com/backend-api/codex/models?client_version=${TEST_CODEX_VERSION}`);
      return new Response(JSON.stringify({
        error: {
          code: 'catalog_unavailable',
          message: 'catalog unavailable',
        },
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await createService(dir).proxyModels();

    expect(result.status).toBe(502);
    expect(JSON.parse(result.body)).toEqual({
      error: {
        message: 'Codex 模型列表请求失败：HTTP 502 / catalog_unavailable / catalog unavailable',
        type: 'upstream_error',
        code: 'codex_model_catalog_unavailable',
      },
    });
    expect(result.body).not.toContain('"data"');
  });

  it('keys the five-minute model cache by confirmed clientVersion and invalidates it on release change', async () => {
    const dir = createTempDir();
    writeCodexAuth(dir, {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        account_id: 'acct-managed',
      },
    });
    const releaseFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tag_name: 'rust-v0.145.0',
        draft: false,
        prerelease: false,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: '"v145"' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tag_name: 'rust-v0.146.0',
        draft: false,
        prerelease: false,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: '"v146"' },
      }));
    const provider = new CodexReleaseMetadataProvider({
      stateDir: join(dir, '.runtime'),
      fetchFn: releaseFetch as typeof fetch,
    });
    const backendFetch = vi.fn(async (url: string) => {
      const version = new URL(url).searchParams.get('client_version');
      return new Response(JSON.stringify({
        models: [{
          slug: `model-${version}`,
          display_name: `Model ${version}`,
          visibility: 'list',
          supported_in_api: true,
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: `"models-${version}"` },
      });
    });
    globalThis.fetch = backendFetch as typeof fetch;
    const service = new CodexOAuthBridgeService({
      rootDir: dir,
      envFiles: {
        mode: 'single',
        baseFilePath: join(dir, '.env.local'),
        overrideFilePath: null,
        editTarget: join(dir, '.env.local'),
      },
      releaseMetadataProvider: provider,
    });

    await service.refreshReleaseMetadata({ force: true });
    const first = await service.proxyModels({ forceRefresh: true });
    const cached = await service.proxyModels();
    await service.refreshReleaseMetadata({ force: true });
    const upgraded = await service.proxyModels({ forceRefresh: true });

    expect(JSON.parse(first.body).data[0].id).toBe('model-0.145.0');
    expect(cached.body).toBe(first.body);
    expect(JSON.parse(upgraded.body).data[0].id).toBe('model-0.146.0');
    expect(backendFetch.mock.calls.map(([url]) => new URL(url).searchParams.get('client_version'))).toEqual([
      '0.145.0',
      '0.146.0',
    ]);
  });

  it('lifts ChatLuna system inputs into top-level Codex instructions before proxying responses', async () => {
    const dir = createTempDir();
    const accessToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, client_id: 'codex-client' });
    writeCodexAuth(dir, {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: accessToken,
        refresh_token: 'refresh-token',
        account_id: 'acct-managed',
      },
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(body.instructions).toBe('preexisting instructions\n\npersona instructions\n\nruntime contract');
      expect(body.input).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
      ]);
      expect(body.store).toBe(false);
      expect(body.stream).toBe(true);
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await createService(dir).proxyResponses({
      model: 'openai/gpt-5.5',
      instructions: 'preexisting instructions',
      input: [
        { role: 'system', content: 'persona instructions' },
        { role: 'developer', content: [{ type: 'input_text', text: 'runtime contract' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
      ],
    });

    expect(result).toMatchObject({
      status: 200,
      body: '{"ok":true}',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('converts Codex SSE response streams into Responses JSON for ChatLuna', async () => {
    const dir = createTempDir();
    const accessToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, client_id: 'codex-client' });
    writeCodexAuth(dir, {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: accessToken,
        refresh_token: 'refresh-token',
        account_id: 'acct-managed',
      },
    });
    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_sse","status":"in_progress","output":[]}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"hello","output_index":1,"content_index":0}',
      '',
      'event: response.output_text.done',
      'data: {"type":"response.output_text.done","text":"hello","output_index":1,"content_index":0}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_sse","status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}',
      '',
    ].join('\n');
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await createService(dir).proxyResponses({
      model: 'openai/gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });

    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toContain('application/json');
    expect(result.body).not.toContain('event:');
    expect(JSON.parse(result.body)).toMatchObject({
      id: 'resp_sse',
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'hello' }],
        },
      ],
    });
  });

  it('reports interrupted Codex response bodies as retryable proxy transport failures', async () => {
    const dir = createTempDir();
    const accessToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, client_id: 'codex-client' });
    writeCodexAuth(dir, {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: accessToken,
        refresh_token: 'refresh-token',
        account_id: 'acct-managed',
      },
    });
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7897');
    vi.stubEnv('https_proxy', '');
    vi.stubEnv('ALL_PROXY', '');
    vi.stubEnv('all_proxy', '');
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('no_proxy', '');
    const socketError = Object.assign(new Error('other side closed'), {
      code: 'UND_ERR_SOCKET',
    });
    const terminated = Object.assign(new TypeError('terminated'), {
      cause: socketError,
    });
    const response = new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    });
    vi.spyOn(response, 'text').mockRejectedValue(terminated);
    globalThis.fetch = vi.fn(async () => response) as typeof fetch;

    const result = await createService(dir).proxyResponses({
      model: 'openai/gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });
    const error = JSON.parse(result.body).error;

    expect(result.status).toBe(502);
    expect(error).toMatchObject({
      type: 'upstream_error',
      code: 'upstream_transport_error',
    });
    expect(error.message).toContain('Codex Responses 响应体读取失败');
    expect(error.message).toContain('UND_ERR_SOCKET');
    expect(error.message).toContain('other side closed');
    expect(error.message).toContain('url=https://chatgpt.com/backend-api/codex/responses');
    expect(error.message).toContain('proxy=http://127.0.0.1:7897/');
    expect(result.body).not.toContain(accessToken);
  });

  it('repairs partially populated completed output with final Codex SSE text', async () => {
    const dir = createTempDir();
    const accessToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, client_id: 'codex-client' });
    writeCodexAuth(dir, {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: accessToken,
        refresh_token: 'refresh-token',
        account_id: 'acct-managed',
      },
    });
    const sse = [
      'event: response.output_text.done',
      'data: {"type":"response.output_text.done","text":"hello","output_index":0,"content_index":0}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_partial","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hel"}]}]}}',
      '',
    ].join('\n');
    globalThis.fetch = vi.fn(async () => new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    })) as typeof fetch;

    const result = await createService(dir).proxyResponses({
      model: 'openai/gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });

    expect(JSON.parse(result.body)).toMatchObject({
      id: 'resp_partial',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'hello' }],
        },
      ],
    });
  });

  it('preserves streamed Codex function calls when completed output is empty', async () => {
    const dir = createTempDir();
    const accessToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, client_id: 'codex-client' });
    writeCodexAuth(dir, {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: accessToken,
        refresh_token: 'refresh-token',
        account_id: 'acct-managed',
      },
    });
    const sse = [
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"search","arguments":"{\\"q\\":\\"sakiko\\"}","status":"completed"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_tool","status":"completed","output":[]}}',
      '',
    ].join('\n');
    globalThis.fetch = vi.fn(async () => new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })) as typeof fetch;

    const result = await createService(dir).proxyResponses({
      model: 'openai/gpt-5.5',
      tools: [{ type: 'function', name: 'search', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }],
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'search sakiko' }] }],
    });

    expect(JSON.parse(result.body)).toMatchObject({
      id: 'resp_tool',
      output: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'search',
          arguments: '{"q":"sakiko"}',
        },
      ],
    });
  });

  it('rejects old Codex OAuth state without ChatGPT account id before proxying upstream', async () => {
    const dir = createTempDir();
    const accessToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, client_id: 'codex-client' });
    writeCodexAuth(dir, {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: accessToken,
        refresh_token: 'refresh-token',
      },
    });
    const fetchMock = vi.fn(async () => new Response('{"unexpected":true}', {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    const service = createService(dir);
    const status = await service.getAdminStatus({ probe: true });
    const result = await service.proxyResponses({
      model: 'openai/gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });

    expect(status).toMatchObject({
      authKind: 'codex_oauth',
      authStatus: 'error',
    });
    expect(status.authError).toContain('ChatGPT account id');
    expect(result.status).toBe(401);
    expect(result.body).toContain('ChatGPT account id');
    expect(result.body).not.toContain(accessToken);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
