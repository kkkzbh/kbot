import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => {
  type Node = {
    default: () => Node;
    description: () => Node;
    role: () => Node;
    required: () => Node;
    min: () => Node;
    max: () => Node;
  };
  const node = (): Node => ({
    default: () => node(), description: () => node(), role: () => node(),
    required: () => node(), min: () => node(), max: () => node(),
  });
  return {
    Context: class {},
    Logger: class {
      static DEBUG = 3;
      static targets: unknown[] = [];
      info(): void {}
      warn(): void {}
      error(): void {}
    },
    Schema: { object: node, string: node, array: node, natural: node, boolean: node, union: node },
    $: {
      add: vi.fn(), ifNull: vi.fn(), count: vi.fn(), sum: vi.fn(),
      eq: vi.fn(), and: vi.fn(), gte: vi.fn(), lt: vi.fn(),
    },
    Time: {
      minute: 60_000,
      getDateNumber: () => 20260716,
      fromDateNumber: (value: number) => value,
    },
  };
});
import { apply, type Config } from '../src/plugins/admin-api/index.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-admin-api-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'data/chathub/presets'), { recursive: true });
  writeFileSync(join(dir, '.env.local'), 'CHATLUNA_DEFAULT_MODEL=test-model\nQQ_VOICE_TTS_API_KEY=tts-secret-value\n', 'utf8');
  writeFileSync(join(dir, 'data/chathub/presets/sakiko.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: hi\n', 'utf8');
  return dir;
}

const config: Config = {
  apiPath: '/api/admin/v1',
  accessToken: 'admin-access-token',
  sessionSecret: 'admin-session-secret-with-more-than-32-characters',
  allowedOrigins: ['https://admin.example.com'],
  sessionTtlSeconds: 3600,
};

function createRuntime(dir: string, extra: Record<string, unknown> = {}) {
  const server = {
    get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), options: vi.fn(), use: vi.fn(),
  };
  const database = {
    get: vi.fn(async () => []),
    eval: vi.fn(async () => 0),
    set: vi.fn(async () => undefined),
    create: vi.fn(async (_table: string, row: any) => ({ id: 1, ...row })),
    remove: vi.fn(async () => undefined),
    upsert: vi.fn(async () => undefined),
  };
  const ctx = {
    baseDir: dir,
    server,
    database,
    model: { extend: vi.fn() },
    on: vi.fn(),
    setInterval: vi.fn(),
    any: () => ({ before: vi.fn() }),
    bots: {},
    ...extra,
  };
  apply(ctx as any, config);
  return { ctx, server, database };
}

function createKoaCtx(options: { body?: unknown; host?: string; origin?: string; authorization?: string; params?: Record<string,string>; cookie?: string; path?: string; method?: string } = {}) {
  const cookies = new Map<string, string>();
  if (options.cookie) cookies.set('qqbot_admin_session', options.cookie);
  return {
    status: 404,
    body: undefined as unknown,
    type: '',
    path: options.path ?? '/',
    method: options.method ?? 'GET',
    host: options.host ?? 'admin.example.com',
    secure: true,
    params: options.params ?? {},
    query: {},
    request: { body: options.body },
    set: vi.fn(),
    get: vi.fn((name: string) => {
      if (name.toLowerCase() === 'origin') return options.origin ?? '';
      if (name.toLowerCase() === 'host') return options.host ?? 'admin.example.com';
      if (name.toLowerCase() === 'authorization') return options.authorization ?? '';
      return '';
    }),
    cookies: {
      get: vi.fn((name: string) => cookies.get(name)),
      set: vi.fn((name: string, value: string) => cookies.set(name, value)),
    },
    cookieValues: cookies,
  };
}

describe('independent admin API plugin', () => {
  it('registers domain HTTP routes, explicit SPA routes and no console IPC', () => {
    const { server } = createRuntime(createTempDir());
    const getPaths = server.get.mock.calls.map((call) => call[0]);
    const postPaths = server.post.mock.calls.map((call) => call[0]);
    expect(getPaths).toContain('/api/admin/v1/overview');
    expect(getPaths).toContain('/api/admin/v1/memory/users');
    expect(getPaths).toContain('/api/admin/v1/logs');
    expect(getPaths).toContain('/');
    expect(getPaths).toContain('/assets/(.*)');
    expect(getPaths).toContain('/extensions/(.*)');
    expect(postPaths).toContain('/api/admin/v1/session');
    expect(postPaths).toContain('/api/admin/v1/tts/sample');
    expect(postPaths).toContain('/api/internal/copilot/v1/responses');
    expect(server.use).not.toHaveBeenCalled();
  });

  it('serves root and nested SPA routes from explicit router handlers', async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, 'dist/admin-web'), { recursive: true });
    writeFileSync(join(dir, 'dist/admin-web/index.html'), '<div id="app"></div>\n', 'utf8');
    const { server } = createRuntime(dir);
    const routes = new Map(server.get.mock.calls.map((call) => [call[0], call[1]]));

    for (const [route, path] of [['/', '/'], ['/extensions/(.*)', '/extensions/campus/auth']]) {
      const request = createKoaCtx({ path });
      await routes.get(route)?.(request);
      expect(request.status).toBe(200);
      expect(request.type).toBe('text/html; charset=utf-8');
      (request.body as { destroy: () => void }).destroy();
    }

    for (const path of ['/admin', '/api/(.*)', '/campus/(.*)', '/chatluna-storage/(.*)']) {
      expect(routes.has(path)).toBe(false);
    }
  });

  it('enforces Host and Origin before issuing a session', async () => {
    const { server } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];

    const badHost = createKoaCtx({ host: 'public.example.com', origin: 'https://admin.example.com', body: { accessToken: config.accessToken } });
    await login(badHost);
    expect(badHost.status).toBe(421);

    const badOrigin = createKoaCtx({ origin: 'https://evil.example.com', body: { accessToken: config.accessToken } });
    await login(badOrigin);
    expect(badOrigin.status).toBe(403);

    const good = createKoaCtx({ origin: 'https://admin.example.com', body: { accessToken: config.accessToken } });
    await login(good);
    expect(good.status).toBe(200);
    expect(good.body).toMatchObject({ authenticated: true, expiresAt: expect.any(Number) });
    expect(good.cookieValues.get('qqbot_admin_session')).toMatch(/^v1\./);
  });

  it('renews an authenticated persistent session when the workspace opens', async () => {
    const { server } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];
    const check = server.get.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];
    const loginCtx = createKoaCtx({ origin: 'https://admin.example.com', body: { accessToken: config.accessToken } });
    await login(loginCtx);
    const originalCookie = loginCtx.cookieValues.get('qqbot_admin_session');

    const checkCtx = createKoaCtx({ cookie: originalCookie });
    await check(checkCtx);

    expect(checkCtx.status).toBe(200);
    expect(checkCtx.body).toMatchObject({ authenticated: true, expiresAt: expect.any(Number) });
    expect(checkCtx.cookieValues.get('qqbot_admin_session')).toMatch(/^v1\./);
    expect(checkCtx.cookieValues.get('qqbot_admin_session')).not.toBe(originalCookie);
  });

  it('rejects protected domain routes without a valid session', async () => {
    const { server } = createRuntime(createTempDir());
    const overview = server.get.mock.calls.find((call) => call[0] === '/api/admin/v1/overview')?.[1];
    const request = createKoaCtx();

    await overview(request);

    expect(request.status).toBe(401);
    expect(request.body).toMatchObject({ error: { code: 'unauthenticated', requestId: expect.any(String) } });
  });

  it('never returns managed secret values from settings', async () => {
    const { server } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];
    const loginCtx = createKoaCtx({ origin: 'https://admin.example.com', body: { accessToken: config.accessToken } });
    await login(loginCtx);
    const cookie = loginCtx.cookieValues.get('qqbot_admin_session');

    const readSettings = server.get.mock.calls.find((call) => call[0] === '/api/admin/v1/settings/:section')?.[1];
    const settingsCtx = createKoaCtx({ cookie, params: { section: 'features' } });
    await readSettings(settingsCtx);
    expect(settingsCtx.status).toBe(200);
    const secret = (settingsCtx.body as any).fields.find((field: any) => field.key === 'QQ_VOICE_TTS_API_KEY');
    expect(secret).toMatchObject({ configured: true, value: null, type: 'secret' });
    expect(JSON.stringify(settingsCtx.body)).not.toContain('tts-secret-value');
  });

  it('redacts TTS secrets from both bot and local gateway state', async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config/voice-tts.local.env'), 'VOICE_TTS_API_KEY=local-tts-secret\n', 'utf8');
    const { server } = createRuntime(dir);
    const login = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];
    const loginCtx = createKoaCtx({ origin: 'https://admin.example.com', body: { accessToken: config.accessToken } });
    await login(loginCtx);
    const cookie = loginCtx.cookieValues.get('qqbot_admin_session');

    const readTts = server.get.mock.calls.find((call) => call[0] === '/api/admin/v1/tts')?.[1];
    const ttsCtx = createKoaCtx({ cookie });
    await readTts(ttsCtx);

    expect(ttsCtx.status).toBe(200);
    expect((ttsCtx.body as any).localGateway.secretState.VOICE_TTS_API_KEY).toEqual({ configured: true, value: null });
    expect(JSON.stringify(ttsCtx.body)).not.toContain('tts-secret-value');
    expect(JSON.stringify(ttsCtx.body)).not.toContain('local-tts-secret');
  });

  it('keeps the authenticated affinity internal bridge endpoint', async () => {
    const previous = process.env.QQ_VOICE_BRIDGE_API_KEY;
    process.env.QQ_VOICE_BRIDGE_API_KEY = 'bridge-secret';
    try {
      const createManualRandomPlan = vi.fn(async () => ({ ok: true, planId: 123, scheduledAt: 1800000005000, triggerKind: 'manual' }));
      const { server } = createRuntime(createTempDir(), { affinity: { createManualRandomPlan } });
      const handler = server.post.mock.calls.find((call) => call[0] === '/api/internal/affinity/v1/random-plans')?.[1];
      const bad = createKoaCtx({ body: { scopeKind: 'group', scopeId: '829573670' } });
      await handler(bad);
      expect(bad.status).toBe(401);
      const good = createKoaCtx({ body: { scopeKind: 'group', scopeId: '829573670', delayMs: 5000 }, authorization: 'Bearer bridge-secret' });
      await handler(good);
      expect(good.status).toBe(200);
      expect(createManualRandomPlan).toHaveBeenCalledWith(expect.objectContaining({ scopeKind: 'group', scopeId: '829573670', delayMs: 5000 }));
    } finally {
      if (previous == null) delete process.env.QQ_VOICE_BRIDGE_API_KEY;
      else process.env.QQ_VOICE_BRIDGE_API_KEY = previous;
    }
  });
});
