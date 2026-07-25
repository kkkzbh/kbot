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
import { AdminRuntimeManager } from '../src/plugins/admin-api/server.js';

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-admin-api-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, '.env.local'), 'CHATLUNA_DEFAULT_MODEL=test-model\nQQ_VOICE_TTS_API_KEY=tts-secret-value\n', 'utf8');
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
    get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), options: vi.fn(), use: vi.fn(),
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
    chatluna: createChatLunaService(),
    ...extra,
  };
  apply(ctx as any, config);
  return { ctx, server, database, preset: ctx.chatluna.preset };
}

function createPresetDefinition(id = 'sakiko') {
  return {
    schemaVersion: 2 as const,
    id,
    displayName: id === 'sakiko' ? 'Sakiko' : id,
    aliases: id === 'sakiko' ? ['小祥'] : [],
    messages: [{ role: 'system' as const, purpose: 'description' as const, content: 'hello' }],
    inputFormat: null,
    lore: { defaults: {}, entries: [] },
    authorsNote: null,
    knowledge: null,
    promptConfig: {},
  };
}

function createChatLunaService() {
  const definitions = new Map([['sakiko', createPresetDefinition()]]);
  const revisions = new Map([['sakiko', 'revision-sakiko']]);
  let globalDefaultPresetId = 'sakiko';
  const missingPreset = (id: string) => Object.assign(
    new Error(`Preset does not exist: ${id}`),
    {
      name: 'PresetError',
      code: 'not_found',
      operation: 'load',
      stage: 'lookup',
      presetId: id,
      runtimeUnchanged: true,
    },
  );
  const compiled = (id: string) => {
    const definition = definitions.get(id);
    if (!definition) throw missingPreset(id);
    return {
      id,
      displayName: definition.displayName,
      aliases: definition.aliases,
      definition,
      messages: [],
      inputFormat: definition.inputFormat,
      lore: definition.lore,
      authorsNote: definition.authorsNote,
      knowledge: definition.knowledge,
      promptConfig: definition.promptConfig,
      source: 'runtime' as const,
      revision: revisions.get(id) ?? `revision-${id}`,
    };
  };
  const preset = {
    listPresets: vi.fn(() => ({
      value: [...definitions.keys()].map((id) => ({
        id,
        displayName: definitions.get(id)!.displayName,
        aliases: definitions.get(id)!.aliases,
        source: 'runtime' as const,
        hasOverride: false,
        revision: revisions.get(id)!,
        isGlobalDefault: id === globalDefaultPresetId,
      })),
    })),
    getGlobalDefaultPresetId: vi.fn(() => ({ value: globalDefaultPresetId })),
    getPreset: vi.fn((id: string) => ({ value: compiled(id) })),
    getDefinition: vi.fn((id: string) => {
      const definition = definitions.get(id);
      if (!definition) throw missingPreset(id);
      return structuredClone(definition);
    }),
    createPreset: vi.fn(async (definition: ReturnType<typeof createPresetDefinition>) => {
      definitions.set(definition.id, structuredClone(definition));
      revisions.set(definition.id, `revision-${definition.id}`);
      return compiled(definition.id);
    }),
    updatePreset: vi.fn(async (
      id: string,
      definition: ReturnType<typeof createPresetDefinition>,
      _expectedRevision: string,
    ) => {
      definitions.set(id, structuredClone(definition));
      revisions.set(id, `revision-${id}-updated`);
      return compiled(id);
    }),
    deletePreset: vi.fn(async (id: string, _expectedRevision: string) => {
      definitions.delete(id);
      revisions.delete(id);
    }),
    revertOverride: vi.fn(async (id: string, _expectedRevision: string) => compiled(id)),
    setGlobalDefaultPresetId: vi.fn(async (id: string) => {
      globalDefaultPresetId = id;
    }),
  };
  return {
    preset,
    platform: {
      findModel: vi.fn(() => ({ value: { maxTokens: 128_000 } })),
    },
  };
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
    expect(getPaths).toContain('/api/admin/v1/events');
    expect(getPaths).toContain('/api/admin/v1/events/summary');
    expect(getPaths).toContain('/api/admin/v1/events/:id');
    expect(getPaths).toContain('/api/admin/v1/memory/users');
    expect(getPaths).toContain('/api/admin/v1/logs');
    expect(getPaths).toContain('/api/admin/v1/models/runtime');
    expect(getPaths).toContain('/api/admin/v1/model-context/blueprint');
    expect(getPaths).toContain('/api/admin/v1/model-context/targets');
    expect(getPaths).toContain('/api/admin/v1/model-context/snapshots/:conversationId');
    expect(getPaths).toContain('/');
    expect(getPaths).toContain('/assets/(.*)');
    expect(getPaths).toContain('/extensions/(.*)');
    expect(postPaths).toContain('/api/admin/v1/session');
    expect(postPaths).toContain('/api/admin/v1/events/acknowledge-all');
    expect(postPaths).toContain('/api/admin/v1/events/:id/action');
    expect(postPaths).toContain('/api/admin/v1/apply/restart');
    expect(postPaths).toContain('/api/admin/v1/tts/sample');
    expect(postPaths).toContain('/api/internal/copilot/v1/responses');
    expect(server.use).not.toHaveBeenCalled();
    expect(postPaths).not.toContain('/api/admin/v1/presets/reorder');
  });

  it('restarts the services implied by pending configuration and clears apply state', async () => {
    const restartForApplyReasons = vi
      .spyOn(AdminRuntimeManager.prototype, 'restartForApplyReasons')
      .mockResolvedValue([{
        unit: 'qqbot-koishi.service',
        previousInvocationId: 'old-invocation',
      }]);
    const { server } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];
    const patchSettings = server.patch.mock.calls.find((call) => call[0] === '/api/admin/v1/settings/:section')?.[1];
    const restart = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/apply/restart')?.[1];
    const loginCtx = createKoaCtx({
      origin: 'https://admin.example.com',
      body: { accessToken: config.accessToken },
    });
    await login(loginCtx);
    const cookie = loginCtx.cookieValues.get('qqbot_admin_session');

    const patchCtx = createKoaCtx({
      cookie,
      origin: 'https://admin.example.com',
      params: { section: 'basic' },
      body: { changes: [{ key: 'CHAT_NATURAL_TRIGGER_ALIASES', value: '小Q' }] },
    });
    await patchSettings(patchCtx);
    expect((patchCtx.body as any).restartRequired).toBe(true);

    const restartCtx = createKoaCtx({
      cookie,
      origin: 'https://admin.example.com',
      body: {},
    });
    await restart(restartCtx);

    expect(restartForApplyReasons).toHaveBeenCalledWith(['basic']);
    expect(restartCtx.status).toBe(200);
    expect(restartCtx.body).toEqual({
      targets: [{
        unit: 'qqbot-koishi.service',
        previousInvocationId: 'old-invocation',
      }],
      apply: { restartRequired: false, reasons: [] },
    });
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

  it('returns live model runtime state with an ISO update timestamp', async () => {
    const { server } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];
    const loginCtx = createKoaCtx({
      origin: 'https://admin.example.com',
      body: { accessToken: config.accessToken },
    });
    await login(loginCtx);
    const readRuntime = server.get.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/models/runtime',
    )?.[1];
    const request = createKoaCtx({
      cookie: loginCtx.cookieValues.get('qqbot_admin_session'),
    });

    await readRuntime(request);

    expect(request.status).toBe(200);
    expect(request.body).toMatchObject({
      modelContextSize: 128_000,
      contextLimit: 128_000,
      pending: expect.any(Boolean),
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
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

  it('delegates strict Preset V2 CRUD and default mutations to ChatLuna', async () => {
    const { server, preset } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];
    const loginCtx = createKoaCtx({
      origin: 'https://admin.example.com',
      body: { accessToken: config.accessToken },
    });
    await login(loginCtx);
    const cookie = loginCtx.cookieValues.get('qqbot_admin_session');
    const definition = createPresetDefinition('new-role');

    const create = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/presets')?.[1];
    const createCtx = createKoaCtx({
      cookie,
      origin: 'https://admin.example.com',
      body: { preset: definition },
    });
    await create(createCtx);
    expect(createCtx.status).toBe(200);
    expect(preset.createPreset).toHaveBeenCalledWith(definition);
    expect(createCtx.body).toMatchObject({
      preset: { id: 'new-role' },
      revision: 'revision-new-role',
    });

    const update = server.put.mock.calls.find((call) => call[0] === '/api/admin/v1/presets/:id')?.[1];
    const updateCtx = createKoaCtx({
      cookie,
      origin: 'https://admin.example.com',
      params: { id: 'new-role' },
      body: {
        preset: { ...definition, displayName: 'Updated role' },
        expectedRevision: 'revision-new-role',
      },
    });
    await update(updateCtx);
    expect(updateCtx.status).toBe(200);
    expect(preset.updatePreset).toHaveBeenCalledWith(
      'new-role',
      expect.objectContaining({ displayName: 'Updated role' }),
      'revision-new-role',
    );

    const setDefault = server.put.mock.calls.find((call) => call[0] === '/api/admin/v1/presets/default')?.[1];
    const defaultCtx = createKoaCtx({
      cookie,
      origin: 'https://admin.example.com',
      body: { id: 'new-role' },
    });
    await setDefault(defaultCtx);
    expect(defaultCtx.body).toEqual({ globalDefaultPresetId: 'new-role' });
    expect(preset.setGlobalDefaultPresetId).toHaveBeenCalledWith('new-role');

    const revert = server.delete.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/presets/:id/override',
    )?.[1];
    const revertCtx = createKoaCtx({
      cookie,
      origin: 'https://admin.example.com',
      params: { id: 'new-role' },
      body: { expectedRevision: 'revision-new-role-updated' },
    });
    await revert(revertCtx);
    expect(revertCtx.status).toBe(200);
    expect(preset.revertOverride).toHaveBeenCalledWith(
      'new-role',
      'revision-new-role-updated',
    );

    const remove = server.delete.mock.calls.find((call) => call[0] === '/api/admin/v1/presets/:id')?.[1];
    const removeCtx = createKoaCtx({
      cookie,
      origin: 'https://admin.example.com',
      params: { id: 'new-role' },
      body: { expectedRevision: 'revision-new-role-updated' },
    });
    await remove(removeCtx);
    expect(removeCtx.status).toBe(204);
    expect(preset.deletePreset).toHaveBeenCalledWith(
      'new-role',
      'revision-new-role-updated',
    );
  });

  it('maps PresetError details without returning the underlying secret cause', async () => {
    const { server, preset } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];
    const loginCtx = createKoaCtx({
      origin: 'https://admin.example.com',
      body: { accessToken: config.accessToken },
    });
    await login(loginCtx);
    const cause = Object.assign(new Error('Bearer upstream-secret'), {
      status: 409,
      code: 'revision_conflict',
      authorization: 'Bearer upstream-secret',
    });
    preset.updatePreset.mockRejectedValueOnce(Object.assign(
      new Error('Preset revision is stale.', { cause }),
      {
        name: 'PresetError',
        code: 'conflict',
        operation: 'update',
        stage: 'revision_check',
        presetId: 'sakiko',
        filePath: '/opt/qqbot/data/chathub/presets/sakiko.yml',
        runtimeUnchanged: true,
      },
    ));
    const update = server.put.mock.calls.find((call) => call[0] === '/api/admin/v1/presets/:id')?.[1];
    const request = createKoaCtx({
      cookie: loginCtx.cookieValues.get('qqbot_admin_session'),
      origin: 'https://admin.example.com',
      params: { id: 'sakiko' },
      body: {
        preset: createPresetDefinition(),
        expectedRevision: 'stale-revision',
      },
    });

    await update(request);

    expect(request.status).toBe(409);
    expect(request.body).toMatchObject({
      error: {
        code: 'conflict',
        details: {
          presetErrorCode: 'conflict',
          operation: 'update',
          stage: 'revision_check',
          presetId: 'sakiko',
          filePath: '/opt/qqbot/data/chathub/presets/sakiko.yml',
          runtimeUnchanged: true,
          upstreamStatus: 409,
          providerCode: 'revision_conflict',
        },
      },
    });
    expect(JSON.stringify(request.body)).not.toContain('upstream-secret');
  });

  it('maps a missing preset detail lookup to a typed 404', async () => {
    const { server } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];
    const loginCtx = createKoaCtx({
      origin: 'https://admin.example.com',
      body: { accessToken: config.accessToken },
    });
    await login(loginCtx);
    const readPreset = server.get.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/presets/:id',
    )?.[1];
    const request = createKoaCtx({
      cookie: loginCtx.cookieValues.get('qqbot_admin_session'),
      params: { id: 'missing-role' },
    });

    await readPreset(request);

    expect(request.status).toBe(404);
    expect(request.body).toMatchObject({
      error: {
        code: 'not_found',
        details: {
          presetErrorCode: 'not_found',
          operation: 'load',
          stage: 'lookup',
          presetId: 'missing-role',
          runtimeUnchanged: true,
        },
      },
    });
  });
});
