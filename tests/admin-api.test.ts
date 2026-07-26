import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ContextPresetCompileError,
  type ContextPresetDefinitionV1,
} from 'koishi-plugin-chatluna/preset-schema';

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
import {
  AdminRestartJobError,
  AdminRuntimeManager,
  type ScheduledRestartHandle,
} from '../src/plugins/admin-api/server.js';
import { ModelConfigError } from '../src/plugins/model-config/index.js';

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-admin-api-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, '.env.local'), 'QQ_VOICE_TTS_API_KEY=tts-secret-value\n', 'utf8');
  return dir;
}

const config: Config = {
  apiPath: '/api/admin/v1',
  accessToken: 'admin-access-token',
  sessionSecret: 'admin-session-secret-with-more-than-32-characters',
  allowedOrigins: ['https://admin.example.com'],
  sessionTtlSeconds: 3600,
};

function createModelDraft() {
  return {
    connections: [{
      id: 'openai',
      displayName: 'OpenAI',
      adapter: 'openaiCompatible' as const,
      baseUrl: 'https://api.example.com/v1',
      auth: { kind: 'apiKey' as const, secretRef: 'connection:openai' },
      catalogDriver: 'openaiModels' as const,
    }],
    models: [{
      id: 'gpt-test',
      connectionId: 'openai',
      displayName: 'GPT Test',
      transportModel: 'gpt-test',
      modelType: 'chat' as const,
      contextSize: 128_000,
      requestMode: 'responses' as const,
      structuredOutputProtocol: 'native_responses_json_schema' as const,
      capabilities: {
        chat: true,
        embedding: false,
        vision: true,
        tools: true,
        structuredOutput: true,
      },
      timeoutMs: 180_000,
      requestDefaults: {},
    }],
    bindings: [
      { workload: 'main.chat', mode: 'dedicated' as const, connectionId: 'openai', modelId: 'gpt-test' },
      { workload: 'memory.extract', mode: 'disabled' as const },
      { workload: 'memory.embedding', mode: 'disabled' as const },
      { workload: 'affinity.analysis', mode: 'inheritMain' as const },
      { workload: 'naturalTrigger.decision', mode: 'disabled' as const },
      { workload: 'search.summary', mode: 'inheritInvocation' as const },
      { workload: 'chatluna.defaultEmbedding', mode: 'disabled' as const },
      { workload: 'agent.subagent.default', mode: 'inheritInvocation' as const },
      { workload: 'sticker.index', mode: 'disabled' as const },
    ],
  };
}

function createScheduledRestartHandle(): ScheduledRestartHandle {
  const transientUnit = 'qqbot-koishi-service-restart-123';
  return {
    targetUnit: 'qqbot-koishi.service',
    transientUnit,
    serviceUnit: `${transientUnit}.service`,
    timerUnit: `${transientUnit}.timer`,
    scheduledAt: 123,
  };
}

function createModelConfigService() {
  let draft = createModelDraft();
  let savedRevision = 2;
  const aggregate = () => ({
    schemaVersion: 1 as const,
    savedRevision,
    appliedRevision: 1,
    pending: true,
    pendingReason: 'saved_revision_not_applied' as const,
    updatedAt: '2026-07-25T00:00:00.000Z',
    migration: null,
    ...structuredClone(draft),
    connections: draft.connections.map((connection) => ({
      ...structuredClone(connection),
      credentialState: 'configured' as const,
      hasSecret: true,
    })),
    liveBindings: [],
  });
  return {
    getAggregate: vi.fn(() => aggregate()),
    reserveApply: vi.fn(async (expectedRevision: number) => {
      if (expectedRevision !== savedRevision) {
        throw new ModelConfigError({
          code: 'revision_conflict',
          operation: 'apply',
          stage: 'compare',
          message: 'model config apply revision conflict',
          expectedRevision,
          actualRevision: savedRevision,
        });
      }
      return {
        savedRevision,
        appliedRevision: 1,
        release: vi.fn(async () => undefined),
      };
    }),
    put: vi.fn(async (input: { expectedRevision: number; draft: ReturnType<typeof createModelDraft> }) => {
      if (input.expectedRevision !== savedRevision) {
        throw new ModelConfigError({
          code: 'revision_conflict',
          operation: 'save',
          stage: 'compare',
          message: 'model config revision conflict',
          expectedRevision: input.expectedRevision,
          actualRevision: savedRevision,
        });
      }
      draft = structuredClone(input.draft);
      savedRevision += 1;
      return aggregate();
    }),
    getConnectionRuntime: vi.fn((connectionId: string) => {
      const connection = draft.connections.find((item) => item.id === connectionId);
      if (!connection) {
        throw new ModelConfigError({
          code: 'connection_not_found',
          operation: 'read',
          stage: 'lookup',
          message: `connection ${connectionId} not found`,
          connectionId,
        });
      }
      return {
        revision: savedRevision,
        connection: { ...structuredClone(connection), apiKey: 'runtime-secret' },
        models: structuredClone(draft.models.filter((model) => model.connectionId === connectionId)),
      };
    }),
  };
}

function createOAuthBridge(authKind: 'codex_oauth' | 'oauth_device') {
  const status = {
    authKind,
    authStatus: 'ready' as const,
    accountLabel: 'test-account',
    authError: null,
    tokenExpiresAt: null,
    attempt: null,
  };
  return {
    getAdminStatus: vi.fn(async () => status),
    startLogin: vi.fn(async () => status),
    pollLogin: vi.fn(async () => status),
    logout: vi.fn(async () => ({ ...status, authStatus: 'unauthenticated' as const })),
    proxyModels: vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: [{ id: 'bridge-model', name: 'Bridge Model' }] }),
    })),
  };
}

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
  const modelConfig = createModelConfigService();
  const codexBridge = createOAuthBridge('codex_oauth');
  const copilotBridge = createOAuthBridge('oauth_device');
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
    modelConfig,
    codexBridge,
    copilotBridge,
    ...extra,
  };
  apply(ctx as any, config);
  return {
    ctx,
    server,
    database,
    preset: ctx.chatluna.preset,
    modelConfig: ctx.modelConfig,
    codexBridge: ctx.codexBridge,
    copilotBridge: ctx.copilotBridge,
  };
}

function createRolePresetDefinition(id = 'sakiko') {
  return {
    schemaVersion: 1 as const,
    id,
    displayName: id === 'sakiko' ? 'Sakiko' : id,
    messages: [{ role: 'system' as const, purpose: 'description' as const, content: 'hello' }],
  };
}

function createContextPresetDefinition(
  id = 'sakiko',
  rolePresetId = id,
): ContextPresetDefinitionV1 {
  return {
    schemaVersion: 1 as const,
    id,
    displayName: id === 'sakiko' ? 'Sakiko' : id,
    aliases: id === 'sakiko' ? ['小祥'] : [],
    blocks: [
      { id: 'role', type: 'role' as const, rolePresetId },
      { id: 'input', type: 'currentInput' as const, inputFormat: null },
      {
        id: 'output',
        type: 'modelOutput' as const,
        maxOutputTokens: 1024,
        postHandler: null,
      },
    ],
  };
}

function createChatLunaService() {
  const contexts = new Map([['sakiko', createContextPresetDefinition()]]);
  const roles = new Map([['sakiko', createRolePresetDefinition()]]);
  const contextRevisions = new Map([['sakiko', 'revision-context-sakiko']]);
  const roleRevisions = new Map([['sakiko', 'revision-role-sakiko']]);
  let globalDefaultContextPresetId = 'sakiko';
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
  const compiledContext = (id: string) => {
    const definition = contexts.get(id);
    if (!definition) throw missingPreset(id);
    return {
      id,
      displayName: definition.displayName,
      aliases: definition.aliases,
      definition,
      source: 'runtime' as const,
      revision: contextRevisions.get(id) ?? `revision-context-${id}`,
    };
  };
  const compiledRole = (id: string) => {
    const definition = roles.get(id);
    if (!definition) throw missingPreset(id);
    return {
      id,
      displayName: definition.displayName,
      definition,
      messages: definition.messages,
      source: 'runtime' as const,
      revision: roleRevisions.get(id) ?? `revision-role-${id}`,
    };
  };
  const preset = {
    listContextPresets: vi.fn(() => ({
      value: [...contexts.keys()].map((id) => ({
        id,
        displayName: contexts.get(id)!.displayName,
        aliases: contexts.get(id)!.aliases,
        source: 'runtime' as const,
        hasOverride: false,
        revision: contextRevisions.get(id)!,
        isGlobalDefault: id === globalDefaultContextPresetId,
      })),
    })),
    getGlobalDefaultContextPresetId: vi.fn(() => ({ value: globalDefaultContextPresetId })),
    getContextPreset: vi.fn((id: string) => ({ value: compiledContext(id) })),
    getContextPresetDefinition: vi.fn((id: string) => {
      const definition = contexts.get(id);
      if (!definition) throw missingPreset(id);
      return structuredClone(definition);
    }),
    createContextPreset: vi.fn(async (definition: ReturnType<typeof createContextPresetDefinition>) => {
      contexts.set(definition.id, structuredClone(definition));
      contextRevisions.set(definition.id, `revision-context-${definition.id}`);
      return compiledContext(definition.id);
    }),
    updateContextPreset: vi.fn(async (
      id: string,
      definition: ReturnType<typeof createContextPresetDefinition>,
      _expectedRevision: string,
    ) => {
      contexts.set(id, structuredClone(definition));
      contextRevisions.set(id, `revision-context-${id}-updated`);
      return compiledContext(id);
    }),
    deleteContextPreset: vi.fn(async (id: string, _expectedRevision: string) => {
      contexts.delete(id);
      contextRevisions.delete(id);
    }),
    revertContextPreset: vi.fn(async (id: string, _expectedRevision: string) => compiledContext(id)),
    setGlobalDefaultContextPresetId: vi.fn(async (id: string) => {
      globalDefaultContextPresetId = id;
    }),
    listRolePresets: vi.fn(() => ({
      value: [...roles.keys()].map((id) => ({
        id,
        displayName: roles.get(id)!.displayName,
        source: 'runtime' as const,
        hasOverride: false,
        revision: roleRevisions.get(id)!,
        referenceCount: [...contexts.values()].filter((context) => context.blocks.some(
          (block) => block.type === 'role' && block.rolePresetId === id,
        )).length,
      })),
    })),
    getRolePreset: vi.fn((id: string) => ({ value: compiledRole(id) })),
    getRolePresetDefinition: vi.fn((id: string) => {
      const definition = roles.get(id);
      if (!definition) throw missingPreset(id);
      return structuredClone(definition);
    }),
    createRolePreset: vi.fn(async (definition: ReturnType<typeof createRolePresetDefinition>) => {
      roles.set(definition.id, structuredClone(definition));
      roleRevisions.set(definition.id, `revision-role-${definition.id}`);
      return compiledRole(definition.id);
    }),
    updateRolePreset: vi.fn(async (
      id: string,
      definition: ReturnType<typeof createRolePresetDefinition>,
      _expectedRevision: string,
    ) => {
      roles.set(id, structuredClone(definition));
      roleRevisions.set(id, `revision-role-${id}-updated`);
      return compiledRole(id);
    }),
    deleteRolePreset: vi.fn(async (id: string, _expectedRevision: string) => {
      roles.delete(id);
      roleRevisions.delete(id);
    }),
    revertRolePreset: vi.fn(async (id: string, _expectedRevision: string) => compiledRole(id)),
    previewContextPreset: vi.fn((definition: ReturnType<typeof createContextPresetDefinition>) => ({
      blocks: definition.blocks.map((block) => ({
        id: block.id,
        type: block.type,
        source: 'stored' as const,
        owner: block.type === 'role' ? 'role' as const : 'context' as const,
        locked: true,
        movable: false,
        enabled: true,
        staticTokens: block.type === 'role' ? 5 : null,
        budget: null,
        legalDropRange: null,
      })),
      inputBudgetTokens: null,
      outputBudgetTokens: definition.blocks.find(
        (block) => block.type === 'modelOutput',
      )?.maxOutputTokens ?? 1024,
    })),
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
    const putPaths = server.put.mock.calls.map((call) => call[0]);
    expect(getPaths).toContain('/api/admin/v1/overview');
    expect(getPaths).toContain('/api/admin/v1/events');
    expect(getPaths).toContain('/api/admin/v1/events/summary');
    expect(getPaths).toContain('/api/admin/v1/events/:id');
    expect(getPaths).toContain('/api/admin/v1/memory/users');
    expect(getPaths).toContain('/api/admin/v1/logs');
    expect(getPaths).toContain('/api/admin/v1/models');
    expect(getPaths).toContain('/api/admin/v1/context-presets');
    expect(getPaths).toContain('/api/admin/v1/context-presets/:id');
    expect(getPaths).toContain('/api/admin/v1/role-presets');
    expect(getPaths).toContain('/api/admin/v1/role-presets/:id');
    expect(getPaths).toContain('/api/admin/v1/model-context/targets');
    expect(getPaths).toContain('/api/admin/v1/model-context/snapshots/:conversationId');
    expect(getPaths).toContain('/');
    expect(getPaths).toContain('/assets/(.*)');
    expect(getPaths).toContain('/extensions/(.*)');
    expect(postPaths).toContain('/api/admin/v1/session');
    expect(postPaths).toContain('/api/admin/v1/events/acknowledge-all');
    expect(postPaths).toContain('/api/admin/v1/events/:id/action');
    expect(postPaths).toContain('/api/admin/v1/apply/restart');
    expect(postPaths).toContain('/api/admin/v1/models/apply');
    expect(postPaths).toContain('/api/admin/v1/models/maintenance/sticker-index');
    expect(postPaths).toContain('/api/admin/v1/models/connections/:id/probe');
    expect(postPaths).toContain('/api/admin/v1/models/connections/:id/catalog');
    expect(postPaths).toContain('/api/admin/v1/models/connections/:id/oauth/start');
    expect(postPaths).toContain('/api/admin/v1/models/connections/:id/oauth/poll');
    expect(postPaths).toContain('/api/admin/v1/models/connections/:id/oauth/logout');
    expect(postPaths).toContain('/api/admin/v1/context-presets');
    expect(postPaths).toContain('/api/admin/v1/context-presets/preview');
    expect(postPaths).toContain('/api/admin/v1/role-presets');
    expect(putPaths).toContain('/api/admin/v1/models');
    expect(postPaths).toContain('/api/admin/v1/tts/sample');
    expect(postPaths).toContain('/api/internal/copilot/v1/responses');
    expect(server.use).not.toHaveBeenCalled();
    expect(getPaths).not.toContain('/api/admin/v1/model-context/blueprint');
    expect(getPaths).not.toContain('/api/admin/v1/models/runtime');
    expect(postPaths).not.toContain('/api/admin/v1/models/:provider/list');
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

  it('applies only the saved model revision by restarting Koishi', async () => {
    const status = {
      unit: 'qqbot-koishi.service' as const,
      description: 'QQBot Koishi',
      runtimeState: 'healthy' as const,
      controllerState: {
        loadState: 'loaded',
        activeState: 'active',
        subState: 'running',
        unitFileState: 'enabled',
        result: 'success',
        invocationId: 'before-model-apply',
      },
      checkedAt: Date.now(),
      healthDetail: 'healthy',
      canStart: false,
      canStop: true,
      canRestart: true,
      canEnable: false,
    };
    const getServiceStatus = vi
      .spyOn(AdminRuntimeManager.prototype, 'getServiceStatus')
      .mockResolvedValue(status);
    const restartJob = createScheduledRestartHandle();
    const scheduleRestart = vi
      .spyOn(AdminRuntimeManager.prototype, 'scheduleRestart')
      .mockResolvedValue(restartJob);
    const superviseScheduledRestart = vi
      .spyOn(AdminRuntimeManager.prototype, 'superviseScheduledRestart')
      .mockResolvedValue({ state: 'restart_observed', job: null });
    const { server, modelConfig } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];
    const applyModels = server.post.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/models/apply',
    )?.[1];
    const loginCtx = createKoaCtx({
      origin: 'https://admin.example.com',
      body: { accessToken: config.accessToken },
    });
    await login(loginCtx);

    const request = createKoaCtx({
      cookie: loginCtx.cookieValues.get('qqbot_admin_session'),
      origin: 'https://admin.example.com',
      body: { expectedRevision: 2 },
    });
    await applyModels(request);

    expect(modelConfig.reserveApply).toHaveBeenCalledWith(2);
    expect(getServiceStatus).toHaveBeenCalledWith('qqbot-koishi.service');
    expect(scheduleRestart).toHaveBeenCalledWith('qqbot-koishi.service');
    expect(superviseScheduledRestart).toHaveBeenCalledWith(
      restartJob,
      'before-model-apply',
    );
    const reservation = await modelConfig.reserveApply.mock.results[0]?.value;
    expect(reservation?.release).not.toHaveBeenCalled();
    expect(request.status).toBe(200);
    expect(request.body).toEqual({
      accepted: true,
      savedRevision: 2,
      target: {
        unit: 'qqbot-koishi.service',
        previousInvocationId: 'before-model-apply',
      },
    });
  });

  it('releases the model apply reservation after a failed restart job is cancelled', async () => {
    const status = {
      unit: 'qqbot-koishi.service' as const,
      description: 'QQBot Koishi',
      runtimeState: 'healthy' as const,
      controllerState: {
        loadState: 'loaded',
        activeState: 'active',
        subState: 'running',
        unitFileState: 'enabled',
        result: 'success',
        invocationId: 'before-model-apply',
      },
      checkedAt: Date.now(),
      healthDetail: 'healthy',
      canStart: false,
      canStop: true,
      canRestart: true,
      canEnable: false,
    };
    const restartJob = createScheduledRestartHandle();
    vi.spyOn(AdminRuntimeManager.prototype, 'getServiceStatus').mockResolvedValue(status);
    vi.spyOn(AdminRuntimeManager.prototype, 'scheduleRestart').mockResolvedValue(restartJob);
    vi.spyOn(AdminRuntimeManager.prototype, 'superviseScheduledRestart').mockResolvedValue({
      state: 'safe_to_release',
      reason: 'job_failed',
      job: null,
    });
    const { server, modelConfig } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/session',
    )?.[1];
    const applyModels = server.post.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/models/apply',
    )?.[1];
    const loginCtx = createKoaCtx({
      origin: 'https://admin.example.com',
      body: { accessToken: config.accessToken },
    });
    await login(loginCtx);

    const request = createKoaCtx({
      cookie: loginCtx.cookieValues.get('qqbot_admin_session'),
      origin: 'https://admin.example.com',
      body: { expectedRevision: 2 },
    });
    await applyModels(request);

    const reservation = await modelConfig.reserveApply.mock.results[0]?.value;
    await vi.waitFor(() => expect(reservation?.release).toHaveBeenCalledOnce());
    expect(request.status).toBe(200);
  });

  it('releases the model apply reservation when restart scheduling fails with typed details', async () => {
    const status = {
      unit: 'qqbot-koishi.service' as const,
      description: 'QQBot Koishi',
      runtimeState: 'healthy' as const,
      controllerState: {
        loadState: 'loaded',
        activeState: 'active',
        subState: 'running',
        unitFileState: 'enabled',
        result: 'success',
        invocationId: 'before-model-apply',
      },
      checkedAt: Date.now(),
      healthDetail: 'healthy',
      canStart: false,
      canStop: true,
      canRestart: true,
      canEnable: false,
    };
    vi.spyOn(AdminRuntimeManager.prototype, 'getServiceStatus').mockResolvedValue(status);
    vi.spyOn(AdminRuntimeManager.prototype, 'scheduleRestart').mockRejectedValue(
      new AdminRestartJobError({
        message: '无法调度 qqbot-koishi.service 重启任务',
        stage: 'schedule',
        targetUnit: 'qqbot-koishi.service',
        transientUnit: 'qqbot-koishi-service-restart-123',
        cause: new Error('token=must-not-surface'),
      }),
    );
    const { server, modelConfig } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/session',
    )?.[1];
    const applyModels = server.post.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/models/apply',
    )?.[1];
    const loginCtx = createKoaCtx({
      origin: 'https://admin.example.com',
      body: { accessToken: config.accessToken },
    });
    await login(loginCtx);

    const request = createKoaCtx({
      cookie: loginCtx.cookieValues.get('qqbot_admin_session'),
      origin: 'https://admin.example.com',
      body: { expectedRevision: 2 },
    });
    await applyModels(request);

    const reservation = await modelConfig.reserveApply.mock.results[0]?.value;
    expect(reservation?.release).toHaveBeenCalledOnce();
    expect(request.status).toBe(503);
    expect(request.body).toMatchObject({
      error: {
        code: 'service_unavailable',
        details: {
          restartJobErrorCode: 'restart_job_failed',
          operation: 'restart_service',
          stage: 'schedule',
          targetUnit: 'qqbot-koishi.service',
          transientUnit: 'qqbot-koishi-service-restart-123',
          savedRevision: 2,
        },
      },
    });
    expect(JSON.stringify(request.body)).not.toContain('must-not-surface');
  });

  it('rejects a stale model apply revision before scheduling a restart', async () => {
    const scheduleRestart = vi
      .spyOn(AdminRuntimeManager.prototype, 'scheduleRestart');
    const { server } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/session',
    )?.[1];
    const applyModels = server.post.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/models/apply',
    )?.[1];
    const loginCtx = createKoaCtx({
      origin: 'https://admin.example.com',
      body: { accessToken: config.accessToken },
    });
    await login(loginCtx);

    const request = createKoaCtx({
      cookie: loginCtx.cookieValues.get('qqbot_admin_session'),
      origin: 'https://admin.example.com',
      body: { expectedRevision: 1 },
    });
    await applyModels(request);

    expect(request.status).toBe(409);
    expect(request.body).toMatchObject({
      error: {
        code: 'conflict',
        details: {
          operation: 'apply',
          stage: 'compare',
          expectedRevision: 1,
          actualRevision: 2,
        },
      },
    });
    expect(scheduleRestart).not.toHaveBeenCalled();
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

  it('returns the redacted aggregate model configuration and live binding state', async () => {
    const { server } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];
    const loginCtx = createKoaCtx({
      origin: 'https://admin.example.com',
      body: { accessToken: config.accessToken },
    });
    await login(loginCtx);
    const readModels = server.get.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/models',
    )?.[1];
    const request = createKoaCtx({
      cookie: loginCtx.cookieValues.get('qqbot_admin_session'),
    });

    await readModels(request);

    expect(request.status).toBe(200);
    expect(request.body).toMatchObject({
      schemaVersion: 1,
      savedRevision: 2,
      appliedRevision: 1,
      pending: true,
      pendingReason: 'saved_revision_not_applied',
      connections: [expect.objectContaining({
        id: 'openai',
        credentialState: 'configured',
        hasSecret: true,
      })],
      models: [expect.objectContaining({ id: 'gpt-test', transportModel: 'gpt-test' })],
      bindings: expect.arrayContaining([
        expect.objectContaining({ workload: 'main.chat', mode: 'dedicated' }),
      ]),
      connectionStates: [expect.objectContaining({ connectionId: 'openai', status: 'ready' })],
    });
    expect(JSON.stringify(request.body)).not.toContain('runtime-secret');
  });

  it('saves one aggregate draft with CAS and returns a typed revision conflict', async () => {
    const { server, modelConfig } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];
    const loginCtx = createKoaCtx({
      origin: 'https://admin.example.com',
      body: { accessToken: config.accessToken },
    });
    await login(loginCtx);
    const saveModels = server.put.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/models',
    )?.[1];
    const request = createKoaCtx({
      origin: 'https://admin.example.com',
      cookie: loginCtx.cookieValues.get('qqbot_admin_session'),
      body: {
        expectedRevision: 2,
        draft: createModelDraft(),
        secretOperations: [{ connectionId: 'openai', operation: 'retain' }],
      },
    });

    await saveModels(request);

    expect(request.status).toBe(200);
    expect(request.body).toMatchObject({ savedRevision: 3, appliedRevision: 1, pending: true });
    expect(modelConfig.put).toHaveBeenCalledWith({
      expectedRevision: 2,
      draft: createModelDraft(),
      secretOperations: [{ connectionId: 'openai', operation: 'retain' }],
    });

    const stale = createKoaCtx({
      origin: 'https://admin.example.com',
      cookie: loginCtx.cookieValues.get('qqbot_admin_session'),
      body: {
        expectedRevision: 2,
        draft: createModelDraft(),
        secretOperations: [{ connectionId: 'openai', operation: 'retain' }],
      },
    });
    await saveModels(stale);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      error: {
        code: 'conflict',
        details: {
          modelConfigErrorCode: 'revision_conflict',
          operation: 'save',
          stage: 'compare',
          expectedRevision: 2,
          actualRevision: 3,
        },
      },
    });
  });

  it('probes catalogs with runtime credentials and filters upstream errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'gpt-test', name: 'GPT Test' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 'invalid_api_key', message: 'Bearer runtime-secret' },
      }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const { server } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];
    const loginCtx = createKoaCtx({
      origin: 'https://admin.example.com',
      body: { accessToken: config.accessToken },
    });
    await login(loginCtx);
    const catalog = server.post.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/models/connections/:id/catalog',
    )?.[1];
    const request = createKoaCtx({
      origin: 'https://admin.example.com',
      cookie: loginCtx.cookieValues.get('qqbot_admin_session'),
      params: { id: 'openai' },
      body: {},
    });

    await catalog(request);

    expect(request.status).toBe(200);
    expect(request.body).toMatchObject({
      connectionId: 'openai',
      models: [{ transportModel: 'gpt-test', displayName: 'GPT Test' }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer runtime-secret' }),
      }),
    );
    expect(JSON.stringify(request.body)).not.toContain('runtime-secret');

    const rejected = createKoaCtx({
      origin: 'https://admin.example.com',
      cookie: loginCtx.cookieValues.get('qqbot_admin_session'),
      params: { id: 'openai' },
      body: {},
    });
    await catalog(rejected);
    expect(rejected.status).toBe(502);
    expect(rejected.body).toMatchObject({
      error: {
        code: 'upstream_error',
        details: {
          operation: 'catalog',
          stage: 'transport',
          connectionId: 'openai',
          upstreamStatus: 401,
          providerCode: 'invalid_api_key',
        },
      },
    });
    expect(JSON.stringify(rejected.body)).not.toContain('runtime-secret');
  });

  it('runs sticker indexing through the unified models maintenance API', async () => {
    const runIndex = vi.fn(async () => ({
      generatedAt: '2026-07-26T12:00:00.000Z',
      model: 'qqbot-openai/gpt-test',
      indexed: 3,
      reused: 7,
      total: 10,
    }));
    const { server } = createRuntime(createTempDir(), {
      stickerMaintenance: { runIndex },
    });
    const login = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];
    const loginCtx = createKoaCtx({
      origin: 'https://admin.example.com',
      body: { accessToken: config.accessToken },
    });
    await login(loginCtx);
    const runStickerIndex = server.post.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/models/maintenance/sticker-index',
    )?.[1];
    const request = createKoaCtx({
      origin: 'https://admin.example.com',
      cookie: loginCtx.cookieValues.get('qqbot_admin_session'),
      body: {},
    });

    await runStickerIndex(request);

    expect(request.status).toBe(200);
    expect(runIndex).toHaveBeenCalledOnce();
    expect(request.body).toEqual({
      generatedAt: '2026-07-26T12:00:00.000Z',
      model: 'qqbot-openai/gpt-test',
      indexed: 3,
      reused: 7,
      total: 10,
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

  it('rejects model and cross-domain keys on the TTS mutation endpoint', async () => {
    const saveTtsSettings = vi.spyOn(AdminRuntimeManager.prototype, 'saveTtsSettings');
    const { server } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];
    const loginCtx = createKoaCtx({
      origin: 'https://admin.example.com',
      body: { accessToken: config.accessToken },
    });
    await login(loginCtx);
    const patchTts = server.patch.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/tts',
    )?.[1];
    const request = createKoaCtx({
      cookie: loginCtx.cookieValues.get('qqbot_admin_session'),
      origin: 'https://admin.example.com',
      body: {
        botChanges: [{ key: 'QQBOT_MODEL_CONFIG_PATH', value: '/unexpected/model-config.json' }],
        localChanges: [],
      },
    });

    await patchTts(request);

    expect(request.status).toBe(400);
    expect(request.body).toMatchObject({
      error: {
        code: 'bad_request',
        message: '不支持这个配置项：QQBOT_MODEL_CONFIG_PATH',
      },
    });
    expect(saveTtsSettings).not.toHaveBeenCalled();
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

  it('delegates independent context and role CRUD, preview, and default mutations', async () => {
    const { server, preset } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];
    const loginCtx = createKoaCtx({
      origin: 'https://admin.example.com',
      body: { accessToken: config.accessToken },
    });
    await login(loginCtx);
    const cookie = loginCtx.cookieValues.get('qqbot_admin_session');
    const roleDefinition = createRolePresetDefinition('new-role');
    const contextDefinition = createContextPresetDefinition('new-context', 'new-role');

    const createRole = server.post.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/role-presets',
    )?.[1];
    const createRoleCtx = createKoaCtx({
      cookie,
      origin: 'https://admin.example.com',
      body: { rolePreset: roleDefinition },
    });
    await createRole(createRoleCtx);
    expect(createRoleCtx.status).toBe(200);
    expect(preset.createRolePreset).toHaveBeenCalledWith(roleDefinition);
    expect(createRoleCtx.body).toMatchObject({
      rolePreset: { id: 'new-role' },
      revision: 'revision-role-new-role',
      referenceCount: 0,
    });

    const createContext = server.post.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/context-presets',
    )?.[1];
    const createContextCtx = createKoaCtx({
      cookie,
      origin: 'https://admin.example.com',
      body: { contextPreset: contextDefinition },
    });
    await createContext(createContextCtx);
    expect(createContextCtx.status).toBe(200);
    expect(preset.createContextPreset).toHaveBeenCalledWith(contextDefinition);
    expect(createContextCtx.body).toMatchObject({
      contextPreset: { id: 'new-context' },
      revision: 'revision-context-new-context',
    });

    const preview = server.post.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/context-presets/preview',
    )?.[1];
    const previewCtx = createKoaCtx({
      cookie,
      body: { contextPreset: contextDefinition, inputTokenLimit: 8192 },
    });
    await preview(previewCtx);
    const previewBody = previewCtx.body as {
      outputBudgetTokens: number;
      blocks: unknown[];
    };
    expect(previewBody).toMatchObject({ outputBudgetTokens: 1024 });
    expect(previewBody.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'role', owner: 'role' }),
    ]));
    expect(preset.previewContextPreset).toHaveBeenCalledWith(
      contextDefinition,
      {
        inputTokenLimit: 8192,
        runtimeBlocks: ['qqbotFragments', 'toolDefinitions'],
      },
    );

    const updateRole = server.put.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/role-presets/:id',
    )?.[1];
    const updateRoleCtx = createKoaCtx({
      cookie,
      origin: 'https://admin.example.com',
      params: { id: 'new-role' },
      body: {
        rolePreset: { ...roleDefinition, displayName: 'Updated role' },
        expectedRevision: 'revision-role-new-role',
      },
    });
    await updateRole(updateRoleCtx);
    expect(preset.updateRolePreset).toHaveBeenCalledWith(
      'new-role',
      expect.objectContaining({ displayName: 'Updated role' }),
      'revision-role-new-role',
    );

    const setDefault = server.put.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/context-presets/default',
    )?.[1];
    const defaultCtx = createKoaCtx({
      cookie,
      origin: 'https://admin.example.com',
      body: { id: 'new-context' },
    });
    await setDefault(defaultCtx);
    expect(defaultCtx.body).toEqual({
      globalDefaultContextPresetId: 'new-context',
    });
    expect(preset.setGlobalDefaultContextPresetId).toHaveBeenCalledWith('new-context');

    const removeContext = server.delete.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/context-presets/:id',
    )?.[1];
    const removeContextCtx = createKoaCtx({
      cookie,
      origin: 'https://admin.example.com',
      params: { id: 'new-context' },
      body: { expectedRevision: 'revision-context-new-context' },
    });
    await removeContext(removeContextCtx);
    expect(removeContextCtx.status).toBe(204);
    expect(preset.deleteContextPreset).toHaveBeenCalledWith(
      'new-context',
      'revision-context-new-context',
    );

    const removeRole = server.delete.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/role-presets/:id',
    )?.[1];
    const removeRoleCtx = createKoaCtx({
      cookie,
      origin: 'https://admin.example.com',
      params: { id: 'new-role' },
      body: { expectedRevision: 'revision-role-new-role-updated' },
    });
    await removeRole(removeRoleCtx);
    expect(removeRoleCtx.status).toBe(204);
    expect(preset.deleteRolePreset).toHaveBeenCalledWith(
      'new-role',
      'revision-role-new-role-updated',
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
    preset.updateContextPreset.mockRejectedValueOnce(Object.assign(
      new Error('Preset revision is stale.', { cause }),
      {
        name: 'PresetError',
        code: 'conflict',
        operation: 'update',
        stage: 'revision_check',
        presetId: 'sakiko',
        filePath: '/opt/qqbot/data/chathub/context-presets/sakiko.yml',
        runtimeUnchanged: true,
      },
    ));
    const update = server.put.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/context-presets/:id',
    )?.[1];
    const request = createKoaCtx({
      cookie: loginCtx.cookieValues.get('qqbot_admin_session'),
      origin: 'https://admin.example.com',
      params: { id: 'sakiko' },
      body: {
        contextPreset: createContextPresetDefinition(),
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
          filePath: '/opt/qqbot/data/chathub/context-presets/sakiko.yml',
          runtimeUnchanged: true,
          upstreamStatus: 409,
          providerCode: 'revision_conflict',
        },
      },
    });
    expect(JSON.stringify(request.body)).not.toContain('upstream-secret');
  });

  it('returns role reference ids on typed delete conflicts', async () => {
    const { server, preset } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find((call) => call[0] === '/api/admin/v1/session')?.[1];
    const loginCtx = createKoaCtx({
      origin: 'https://admin.example.com',
      body: { accessToken: config.accessToken },
    });
    await login(loginCtx);
    preset.deleteRolePreset.mockRejectedValueOnce(Object.assign(
      new Error('Role preset is referenced.'),
      {
        name: 'PresetError',
        code: 'conflict',
        operation: 'delete',
        stage: 'references',
        presetId: 'sakiko',
        referenceIds: ['sakiko', 'other-context'],
        runtimeUnchanged: true,
      },
    ));
    const removeRole = server.delete.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/role-presets/:id',
    )?.[1];
    const request = createKoaCtx({
      cookie: loginCtx.cookieValues.get('qqbot_admin_session'),
      origin: 'https://admin.example.com',
      params: { id: 'sakiko' },
      body: { expectedRevision: 'revision-role-sakiko' },
    });

    await removeRole(request);

    expect(request.status).toBe(409);
    expect(request.body).toMatchObject({
      error: {
        code: 'conflict',
        details: {
          presetErrorCode: 'conflict',
          operation: 'delete',
          stage: 'references',
          presetId: 'sakiko',
          referenceIds: ['sakiko', 'other-context'],
          runtimeUnchanged: true,
        },
      },
    });
  });

  it('maps context preview compile failures to typed draft errors', async () => {
    const { server, preset } = createRuntime(createTempDir());
    const login = server.post.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/session',
    )?.[1];
    const loginCtx = createKoaCtx({
      origin: 'https://admin.example.com',
      body: { accessToken: config.accessToken },
    });
    await login(loginCtx);
    preset.previewContextPreset.mockImplementationOnce(() => {
      throw new ContextPresetCompileError(
        'invalid_anchor',
        'anchor',
        'Lore anchor is invalid.',
        'lore-one',
      );
    });
    const preview = server.post.mock.calls.find(
      (call) => call[0] === '/api/admin/v1/context-presets/preview',
    )?.[1];
    const draft = createContextPresetDefinition();
    draft.blocks.splice(1, 0, {
      id: 'lore-one',
      type: 'lore',
      enabled: true,
      budgetPriority: 300,
      maxTokens: 128,
      anchor: {
        type: 'block',
        blockId: 'missing-anchor-target',
        position: 'after',
      },
      prompt: null,
      defaults: {},
      entries: [],
    });
    const request = createKoaCtx({
      cookie: loginCtx.cookieValues.get('qqbot_admin_session'),
      body: { contextPreset: draft },
    });

    await preview(request);

    expect(preset.previewContextPreset).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sakiko' }),
      expect.objectContaining({
        runtimeBlocks: ['qqbotFragments', 'toolDefinitions'],
      }),
    );
    expect(request.status).toBe(400);
    expect(request.body).toMatchObject({
      error: {
        code: 'bad_request',
        details: {
          contextCompileErrorCode: 'invalid_anchor',
          stage: 'anchor',
          blockId: 'lore-one',
          limit: null,
        },
      },
    });
  });
});
