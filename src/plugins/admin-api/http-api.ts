import type { Context, Logger } from 'koishi';
import type {} from '@koishijs/plugin-server';
import { z } from 'zod';
import type {
  PresetError,
  PresetService,
} from 'koishi-plugin-chatluna/preset';
import {
  affinityAdjustRequestSchema,
  affinitySettingsRequestSchema,
  affinityWhitelistRequestSchema,
  adminLogsQuerySchema,
  conversationTargetRequestSchema,
  featureOverridesRequestSchema,
  loginRequestSchema,
  memoryKindSchema,
  memoryMutationSchema,
  modelListRequestSchema,
  modelListResponseSchema,
  modelTabsPatchRequestSchema,
  modelTabsResponseSchema,
  modelRuntimeStateSchema,
  oauthAttemptRequestSchema,
  oauthMutationResponseSchema,
  oauthProviderSchema,
  operationalEventActionRequestSchema,
  operationalEventListQuerySchema,
  pageQuerySchema,
  contextBlueprintQuerySchema,
  contextBlueprintResponseSchema,
  contextSnapshotResponseSchema,
  contextTargetsResponseSchema,
  presetCatalogResponseSchema,
  presetCreateRequestSchema,
  presetDefaultRequestSchema,
  presetDefaultResponseSchema,
  presetDetailResponseSchema,
  presetIdSchema,
  presetRevisionRequestSchema,
  presetUpdateRequestSchema,
  serviceActionRequestSchema,
  settingsChangeSchema,
  settingsPatchRequestSchema,
  settingsSectionSchema,
  saveModelsResponseSchema,
  toolOverridesRequestSchema,
  ttsSampleRequestSchema,
  type SettingsSection,
} from '../../admin/contracts/index.js';
import type { AffinityServiceLike } from '../../types/affinity.js';
import type { FeaturePolicyServiceLike } from '../../types/feature-policy.js';
import type { MemoryStatusServiceLike } from '../../types/memory.js';
import type { ToolPolicyServiceLike } from '../../types/tool-policy.js';
import type {
  AdminApplyReason,
  AdminBuiltinModelTab,
  AdminModelOption,
  AdminModelTabId,
  CodexCatalogState,
  EnvPatch,
  SaveModelTabsRequest,
} from '../../types/admin.js';
import type { CopilotOAuthBridgeService } from '../copilot-oauth/index.js';
import type { CodexOAuthBridgeService } from '../codex-oauth/index.js';
import {
  canHotSwitchMainChatModelOnly,
  mainChatRuntimeState,
} from '../shared/llm/main-chat-runtime.js';
import {
  getBuiltinMainChatTabDefinition,
  getMainChatProviderStrategy,
  resolveMainChatRuntimeProfileFromTabConfig,
} from '../shared/llm/index.js';
import { createUnavailableMemoryStatusSnapshot } from '../shared/memory-status.js';
import type { MemoryAdminService } from '../memory/index.js';
import { TTS_LOCAL_ENV_KEYS } from './tts.js';
import {
  ADMIN_ENV_FIELDS,
  ADMIN_ENV_KEYS,
  AdminRuntimeManager,
  type ManagedEnvField,
} from './server.js';
import type { AdminLogService } from './logs.js';
import type { OperationalEventService } from './operational-events.js';
import {
  buildContextBlueprint,
  buildContextTargets,
  type ModelContextSnapshotStore,
} from './model-context.js';
import {
  ADMIN_SESSION_COOKIE,
  AdminHttpError,
  AdminSessionService,
  createRequestId,
} from './session.js';

type DatabaseLike = {
  get: (table: string, query: Record<string, unknown>, cursor?: unknown) => Promise<any[]>;
  eval: (table: string, evaluator: (row: any) => unknown, query?: Record<string, unknown>) => Promise<unknown>;
  set: (table: string, query: Record<string, unknown>, data: Record<string, unknown>) => Promise<unknown>;
  create: (table: string, row: Record<string, unknown>) => Promise<Record<string, unknown>>;
  remove: (table: string, query: Record<string, unknown>) => Promise<unknown>;
};

export type AdminRuntimeServices = {
  memoryStatus?: MemoryStatusServiceLike;
  memoryAdmin?: MemoryAdminService;
  featurePolicy?: FeaturePolicyServiceLike;
  toolPolicy?: ToolPolicyServiceLike;
  affinity?: AffinityServiceLike;
  database: DatabaseLike;
};

export type RegisterAdminApiOptions = {
  ctx: Context & {
    chatluna: {
      preset: PresetService;
      platform: {
        findModel: (fullModelName: string) => { value: { maxTokens: number } | null };
      };
    };
  };
  apiPath: string;
  manager: AdminRuntimeManager;
  session: AdminSessionService;
  services: AdminRuntimeServices;
  logs: AdminLogService;
  events: OperationalEventService;
  copilotBridge: CopilotOAuthBridgeService;
  codexBridge: CodexOAuthBridgeService;
  logger: Logger;
  contextSnapshots: ModelContextSnapshotStore;
};

type KoaContext = any;

type ApiHandler = (koaCtx: KoaContext) => Promise<unknown> | unknown;

type ApiRouteOptions = {
  authenticated?: boolean;
  mutation?: boolean;
};

const ttsChangesRequestSchema = z.object({
  botChanges: z.array(settingsChangeSchema).default([]),
  localChanges: z.array(settingsChangeSchema).default([]),
}).refine((input) => input.botChanges.length + input.localChanges.length > 0, '至少需要提交一个 TTS 配置项。');

class AdminApplyState {
  private readonly reasons = new Set<AdminApplyReason>();

  mark(reason: AdminApplyReason): void {
    this.reasons.add(reason);
  }

  clear(reasons: readonly AdminApplyReason[]): void {
    for (const reason of reasons) this.reasons.delete(reason);
  }

  clearForService(unit: string, action: string): void {
    if (action !== 'restart') return;
    if (unit === 'qqbot-koishi.service' || unit === 'qqbot.target') this.reasons.clear();
    if (unit === 'qqbot-voice-tts.service') this.reasons.delete('tts');
  }

  snapshot(): { restartRequired: boolean; reasons: AdminApplyReason[] } {
    return { restartRequired: this.reasons.size > 0, reasons: [...this.reasons] };
  }
}

function normalizeBasePath(value: string): string {
  const normalized = `/${value.trim().replace(/^\/+|\/+$/g, '')}`;
  if (normalized === '/') throw new Error('Admin API path 不能为空。');
  return normalized;
}

function parseInput<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AdminHttpError(400, 'bad_request', '请求数据不符合 Admin API contract。', result.error.flatten());
  }
  return result.data;
}

function requestHost(koaCtx: KoaContext): string {
  return String(koaCtx.host || koaCtx.request?.host || koaCtx.get?.('host') || '').trim().toLowerCase();
}

function requestOrigin(koaCtx: KoaContext): string {
  return String(koaCtx.get?.('origin') || '').trim();
}

function writeJson(koaCtx: KoaContext, status: number, body: unknown): void {
  koaCtx.status = status;
  koaCtx.type = 'application/json';
  koaCtx.body = body;
}

function writeError(koaCtx: KoaContext, error: AdminHttpError, requestId: string): void {
  writeJson(koaCtx, error.status, {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  });
}

function isSecretField(field: ManagedEnvField): boolean {
  return field.type === 'secret';
}

function settingsFields(section: SettingsSection, env: Record<string, string>) {
  return ADMIN_ENV_FIELDS.filter((field) => field.section === section).map((field) => ({
    ...field,
    value: isSecretField(field) ? null : env[field.key] ?? null,
    configured: Boolean(env[field.key]),
  }));
}

function buildEnvPatch(
  changes: z.infer<typeof settingsChangeSchema>[],
  allowedKeys: ReadonlySet<string>,
  secretKeys: ReadonlySet<string>,
): EnvPatch {
  const patch: EnvPatch = {};
  for (const change of changes) {
    if (!allowedKeys.has(change.key)) {
      throw new AdminHttpError(400, 'bad_request', `不支持这个配置项：${change.key}`);
    }
    if (change.clear === true) {
      patch[change.key] = null;
      continue;
    }
    if (change.value === undefined) {
      if (secretKeys.has(change.key)) continue;
      throw new AdminHttpError(400, 'bad_request', `配置项 ${change.key} 缺少 value。`);
    }
    if (secretKeys.has(change.key) && change.value.length === 0) {
      throw new AdminHttpError(400, 'bad_request', `Secret ${change.key} 需要使用 clear 显式清空。`);
    }
    patch[change.key] = change.value;
  }
  if (Object.keys(patch).length === 0) {
    throw new AdminHttpError(400, 'bad_request', '请求没有包含可应用的配置变更。');
  }
  return patch;
}

function redactModelTabs(tabs: { activeTab: string; tabs: AdminBuiltinModelTab[] }) {
  return {
    activeTab: tabs.activeTab,
    tabs: tabs.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      provider: tab.provider,
      strategyId: tab.strategyId,
      requestMode: tab.requestMode,
      structuredOutputProtocol: tab.structuredOutputProtocol,
      description: tab.description,
      modelHint: tab.modelHint,
      authKind: tab.authKind,
      authStatus: tab.authStatus,
      ...(tab.accountLabel === undefined ? {} : { accountLabel: tab.accountLabel }),
      ...(tab.authError === undefined ? {} : { authError: tab.authError }),
      ...(tab.tokenExpiresAt === undefined ? {} : { tokenExpiresAt: tab.tokenExpiresAt }),
      ...(tab.oauthAttempt === undefined ? {} : { oauthAttempt: tab.oauthAttempt }),
      ...(tab.catalog === undefined ? {} : { catalog: tab.catalog }),
      baseUrl: tab.baseUrl,
      apiKey: null,
      apiKeyConfigured: Boolean(tab.apiKey),
      defaultModel: tab.defaultModel,
      ...(tab.reasoningEffort === undefined ? {} : { reasoningEffort: tab.reasoningEffort }),
      ...(tab.canonicalModel ? { canonicalModel: tab.canonicalModel } : {}),
      ...(tab.transportModel ? { transportModel: tab.transportModel } : {}),
    })),
  };
}

type InternalModelListResult = {
  source: 'dynamic' | 'static';
  models: AdminModelOption[];
  error: string | null;
  catalog?: CodexCatalogState;
};

function serializeModelList(
  tabId: Extract<AdminModelTabId, 'codex' | 'copilot' | 'deepseek' | 'mimo'>,
  result: InternalModelListResult,
) {
  const definition = getBuiltinMainChatTabDefinition(tabId);
  const strategy = getMainChatProviderStrategy(definition.strategyId);
  const models = result.models.map((model) => {
    const canonicalModel = strategy.normalizeModel(model.modelId);
    if (!canonicalModel) {
      throw new Error(`${definition.title} 模型目录包含无法规范化的模型 ID：${model.modelId}`);
    }
    const transportModel = strategy.transportModel(canonicalModel);
    if (!transportModel) {
      throw new Error(`${definition.title} 模型目录无法生成 transport model：${canonicalModel}`);
    }
    return {
      canonicalModel,
      transportModel,
      label: model.label,
      ...(model.rateLabel ? { rateLabel: model.rateLabel } : {}),
      ...(model.requestMode ? { requestMode: model.requestMode } : {}),
      ...(model.structuredOutputProtocol
        ? { structuredOutputProtocol: model.structuredOutputProtocol }
        : {}),
      ...(model.metadataTags ? { metadataTags: model.metadataTags } : {}),
      ...(model.deprecated === undefined ? {} : { deprecated: model.deprecated }),
      ...(model.deprecationDate ? { deprecationDate: model.deprecationDate } : {}),
    };
  });
  return modelListResponseSchema.parse({
    source: result.source,
    models,
    error: result.error,
    ...(result.catalog ? { catalog: result.catalog } : {}),
  });
}

function redactTtsState(state: Awaited<ReturnType<AdminRuntimeManager['getTtsState']>>) {
  const apiKey = state.localGateway.env.VOICE_TTS_API_KEY;
  return {
    ...state,
    localGateway: {
      ...state.localGateway,
      env: {
        ...state.localGateway.env,
        VOICE_TTS_API_KEY: null,
      },
      secretState: {
        VOICE_TTS_API_KEY: { configured: Boolean(apiKey), value: null },
      },
    },
  };
}

function ttsBotFields(env: Record<string, string>) {
  const keys = new Set(['QQ_VOICE_TTS_BASE_URL', 'QQ_VOICE_TTS_API_KEY', 'QQ_VOICE_SYNTH_TIMEOUT_MS']);
  return settingsFields('features', env).filter((field) => keys.has(field.key));
}

function redactAffinityState(state: any) {
  const apiKey = String(state?.settings?.analysisModel?.apiKey || '');
  return {
    ...state,
    settings: {
      ...state.settings,
      analysisModel: {
        ...state.settings.analysisModel,
        apiKey: null,
        apiKeyConfigured: Boolean(apiKey),
      },
    },
  };
}

async function domain<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AdminHttpError) throw error;
    throw new AdminHttpError(400, 'bad_request', error instanceof Error ? error.message : String(error));
  }
}

function upstreamErrorDetails(cause: unknown): Record<string, unknown> {
  if (!cause || typeof cause !== 'object' || Array.isArray(cause)) return {};
  const record = cause as Record<string, unknown>;
  const status = Number(record.status ?? record.statusCode);
  const providerCode = typeof record.code === 'string' && record.code.trim()
    ? record.code.trim()
    : null;
  return {
    ...(Number.isInteger(status) && status >= 400 && status <= 599
      ? { upstreamStatus: status }
      : {}),
    ...(providerCode && !/(?:secret|token|password|credential|cookie|authorization)/i.test(providerCode)
      ? { providerCode }
      : {}),
  };
}

function presetHttpError(error: PresetError): AdminHttpError {
  const status = error.code === 'not_found'
    ? 404
    : error.code === 'conflict'
      ? 409
      : error.code === 'write' || error.code === 'reload'
        ? 503
        : 400;
  const code = status === 404
    ? 'not_found'
    : status === 409
      ? 'conflict'
      : status === 503
        ? 'service_unavailable'
        : 'bad_request';
  return new AdminHttpError(status, code, error.message, {
    presetErrorCode: error.code,
    operation: error.operation,
    stage: error.stage,
    presetId: error.presetId ?? null,
    filePath: error.filePath ?? null,
    runtimeUnchanged: error.runtimeUnchanged,
    ...upstreamErrorDetails(error.cause),
  });
}

function isPresetError(error: unknown): error is PresetError {
  if (!(error instanceof Error) || error.name !== 'PresetError') return false;
  const value = error as Partial<PresetError>;
  return typeof value.code === 'string'
    && typeof value.operation === 'string'
    && typeof value.stage === 'string'
    && value.runtimeUnchanged === true;
}

async function presetDomain<T>(operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isPresetError(error)) throw presetHttpError(error);
    throw error;
  }
}

function readPresetDetail(preset: PresetService, id: string) {
  const definition = preset.getDefinition(id);
  const compiled = preset.getPreset(id).value;
  const summary = preset.listPresets().value.find((item) => item.id === id);
  if (!summary) {
    throw new AdminHttpError(500, 'internal_error', `已加载预设 ${id} 缺少列表元数据。`);
  }
  return presetDetailResponseSchema.parse({
    preset: definition,
    source: compiled.source,
    hasOverride: summary.hasOverride,
    revision: compiled.revision,
  });
}

async function readModelRuntimeState(
  options: RegisterAdminApiOptions,
  updatedAt: string,
) {
  const configuredState = await options.manager.getModelTabsState();
  const configured = resolveMainChatRuntimeProfileFromTabConfig(
    configuredState.activeTab,
    configuredState.tabs,
  );
  const live = mainChatRuntimeState.getProfile();
  const pending = (
    configured.tabId !== live.tabId
    || configured.provider !== live.provider
    || configured.strategyId !== live.strategyId
    || configured.requestMode !== live.requestMode
    || configured.structuredOutputProtocol !== live.structuredOutputProtocol
    || configured.baseUrl.trim() !== live.baseUrl.trim()
    || configured.apiKey.trim() !== live.apiKey.trim()
    || configured.canonicalModel !== live.canonicalModel
    || configured.transportModel !== live.transportModel
    || configured.reasoningEffort !== live.reasoningEffort
  );
  const modelInfo = options.ctx.chatluna.platform.findModel(live.canonicalModel).value;
  return modelRuntimeStateSchema.parse({
    configuredModel: configured.canonicalModel || null,
    liveModel: live.canonicalModel || null,
    transportModel: live.transportModel || null,
    requestMode: live.requestMode || null,
    modelContextSize: modelInfo?.maxTokens ?? null,
    contextLimit: options.contextSnapshots.latestContextLimit(live.canonicalModel)
      ?? modelInfo?.maxTokens
      ?? null,
    pending,
    pendingReason: pending
      ? '已配置模型与当前加载的运行时模型不同，等待 Koishi 重启或完成热切换。'
      : null,
    updatedAt,
  });
}

function requireService<T>(service: T | undefined, name: string): T {
  if (!service) throw new AdminHttpError(503, 'service_unavailable', `${name} service unavailable`);
  return service;
}

function unavailableMemorySummary() {
  return {
    userCount: 0,
    factCount: 0,
    episodeCount: 0,
    pendingReviewCount: 0,
    pendingJobs: 0,
    processingJobs: 0,
    deadLetterJobs: 0,
    provenanceCount: 0,
  };
}

function getCookie(koaCtx: KoaContext): string | undefined {
  return koaCtx.cookies?.get?.(ADMIN_SESSION_COOKIE);
}

function setSessionCookie(koaCtx: KoaContext, session: AdminSessionService, token: string, expiresAt: number): void {
  koaCtx.cookies.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: session.shouldUseSecureCookie(requestHost(koaCtx)),
    overwrite: true,
    path: '/',
    expires: new Date(expiresAt),
  });
}

function clearSessionCookie(koaCtx: KoaContext, session: AdminSessionService): void {
  koaCtx.cookies.set(ADMIN_SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: session.shouldUseSecureCookie(requestHost(koaCtx)),
    overwrite: true,
    path: '/',
    expires: new Date(0),
  });
}

export function registerAdminApi(options: RegisterAdminApiOptions): void {
  const apiPath = normalizeBasePath(options.apiPath);
  const applyState = new AdminApplyState();
  let modelRuntimeUpdatedAt = new Date().toISOString();
  const router = options.ctx.server as any;
  const secretKeys = new Set(ADMIN_ENV_FIELDS.filter(isSecretField).map((field) => field.key));
  const ttsLocalKeySet = new Set<string>(TTS_LOCAL_ENV_KEYS);
  const ttsLocalSecretKeys = new Set(['VOICE_TTS_API_KEY']);

  const register = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, handler: ApiHandler, routeOptions: ApiRouteOptions = {}) => {
    router[method](`${apiPath}${path}`, async (koaCtx: KoaContext) => {
      const requestId = createRequestId();
      koaCtx.set?.('x-request-id', requestId);
      koaCtx.set?.('cache-control', 'no-store');
      try {
        options.session.assertHost(requestHost(koaCtx));
        if (routeOptions.mutation) options.session.assertMutationOrigin(requestOrigin(koaCtx));
        if (routeOptions.authenticated !== false) options.session.require(getCookie(koaCtx));
        const body = await handler(koaCtx);
        if (koaCtx.body === undefined && body !== undefined) writeJson(koaCtx, 200, body);
      } catch (error) {
        if (error instanceof AdminHttpError) {
          writeError(koaCtx, error, requestId);
          return;
        }
        options.logger.error('admin request %s failed: %s', requestId, error instanceof Error ? error.stack ?? error.message : String(error));
        writeError(koaCtx, new AdminHttpError(500, 'internal_error', '管理端请求执行失败。'), requestId);
      }
    });
  };

  register('get', '/session', (koaCtx) => {
    const current = options.session.verify(getCookie(koaCtx));
    if (!current.authenticated) return current;
    const renewed = options.session.issue();
    setSessionCookie(koaCtx, options.session, renewed.token, renewed.expiresAt);
    return { authenticated: true, expiresAt: renewed.expiresAt };
  }, { authenticated: false });
  register('post', '/session', (koaCtx) => {
    const input = parseInput(loginRequestSchema, koaCtx.request.body);
    options.session.authenticateAccessToken(input.accessToken);
    const issued = options.session.issue();
    setSessionCookie(koaCtx, options.session, issued.token, issued.expiresAt);
    return { authenticated: true, expiresAt: issued.expiresAt };
  }, { authenticated: false, mutation: true });
  register('delete', '/session', (koaCtx) => {
    clearSessionCookie(koaCtx, options.session);
    koaCtx.status = 204;
  }, { authenticated: false, mutation: true });

  register('get', '/overview', async () => {
    const [services, modelTabs, tts, memoryStatus, memorySummary, affinity, eventSummary] = await Promise.all([
      options.manager.getServiceStatuses(),
      options.manager.getModelTabsState(),
      options.manager.getTtsState(),
      options.services.memoryStatus?.getSnapshot() ?? Promise.resolve(createUnavailableMemoryStatusSnapshot()),
      options.services.memoryAdmin?.getSummary() ?? Promise.resolve(unavailableMemorySummary()),
      options.services.affinity?.getAdminState() ?? Promise.resolve(null),
      options.events.summary(),
    ]);
    const activeModel = modelTabs.tabs.find((tab) => tab.id === modelTabs.activeTab);
    return {
      generatedAt: Date.now(),
      services,
      serviceSummary: {
        total: services.length,
        running: services.filter((service) => service.runtimeState === 'healthy' || service.runtimeState === 'degraded').length,
        healthy: services.filter((service) => service.runtimeState === 'healthy').length,
        degraded: services.filter((service) => service.runtimeState === 'degraded').length,
        stopped: services.filter((service) => service.runtimeState === 'stopped').length,
      },
      currentModel: activeModel ? {
        id: activeModel.id,
        title: activeModel.title,
        model: activeModel.defaultModel,
        authStatus: activeModel.authStatus,
      } : null,
      globalDefaultPresetId: options.ctx.chatluna.preset.getGlobalDefaultPresetId().value,
      memory: { status: memoryStatus, summary: memorySummary },
      tts: tts.health,
      affinity: affinity ? { available: true, enabled: affinity.settings.enabled } : { available: false, enabled: false },
      events: eventSummary,
      apply: applyState.snapshot(),
    };
  });

  register('get', '/services', () => options.manager.getServiceStatuses());
  register('post', '/services/action', async (koaCtx) => {
    const input = parseInput(serviceActionRequestSchema, koaCtx.request.body);
    const status = await domain(() => options.manager.runServiceAction(input.unit, input.action));
    applyState.clearForService(input.unit, input.action);
    return { status, apply: applyState.snapshot() };
  }, { mutation: true });

  register('post', '/apply/restart', async () => {
    const pending = applyState.snapshot();
    if (!pending.restartRequired) {
      return { targets: [], apply: pending };
    }
    try {
      const targets = await options.manager.restartForApplyReasons(pending.reasons);
      applyState.clear(pending.reasons);
      return { targets, apply: applyState.snapshot() };
    } catch (error) {
      throw new AdminHttpError(
        503,
        'service_unavailable',
        `待应用配置重启失败：${error instanceof Error ? error.message : String(error)}`,
        { operation: 'restart_pending_configuration', reasons: pending.reasons },
      );
    }
  }, { mutation: true });

  register('get', '/events', async (koaCtx) => {
    await options.events.sync();
    return options.events.list(parseInput(operationalEventListQuerySchema, koaCtx.query));
  });
  register('get', '/events/summary', () => options.events.summary());
  register('post', '/events/acknowledge-all', () => domain(() => options.events.acknowledgeAll()), { mutation: true });
  register('get', '/events/:id', (koaCtx) => domain(() => options.events.detail(
    parseInput(z.coerce.number().int().positive(), koaCtx.params.id),
  )));
  register('post', '/events/:id/action', async (koaCtx) => {
    const id = parseInput(z.coerce.number().int().positive(), koaCtx.params.id);
    const input = parseInput(operationalEventActionRequestSchema, koaCtx.request.body);
    return domain(() => options.events.runAction(id, input.action));
  }, { mutation: true });

  register('get', '/logs', (koaCtx) => {
    const input = parseInput(adminLogsQuerySchema, koaCtx.query);
    return options.logs.read(input.after, input.limit);
  });

  register('get', '/settings/:section', async (koaCtx) => {
    const section = parseInput(settingsSectionSchema, koaCtx.params.section);
    return { section, fields: settingsFields(section, await options.manager.getManagedEnv()), ...applyState.snapshot() };
  });
  register('patch', '/settings/:section', async (koaCtx) => {
    const section = parseInput(settingsSectionSchema, koaCtx.params.section);
    const input = parseInput(settingsPatchRequestSchema, koaCtx.request.body);
    const sectionKeys = new Set(ADMIN_ENV_FIELDS.filter((field) => field.section === section).map((field) => field.key));
    const patch = buildEnvPatch(input.changes, sectionKeys, secretKeys);
    const env = await domain(() => options.manager.saveEnv(patch));
    applyState.mark(section);
    return { section, fields: settingsFields(section, env), ...applyState.snapshot() };
  }, { mutation: true });

  register('get', '/models', async () => modelTabsResponseSchema.parse(
    redactModelTabs(await options.manager.getModelTabsState()),
  ));
  register('get', '/models/runtime', () => readModelRuntimeState(options, modelRuntimeUpdatedAt));
  register('patch', '/models', async (koaCtx) => {
    const input = parseInput(modelTabsPatchRequestSchema, koaCtx.request.body);
    const current = await options.manager.getModelTabsState();
    const currentById = new Map(current.tabs.map((tab) => [tab.id, tab]));
    const tabs = input.tabs.map(({ clearApiKey, ...tab }) => ({
      ...currentById.get(tab.id),
      ...tab,
      apiKey: clearApiKey ? '' : tab.apiKey,
    })) as AdminBuiltinModelTab[];
    const result = await domain(() => options.manager.saveModelTabs({
      activeTab: input.activeTab,
      tabs,
      dirtyTabIds: input.dirtyTabIds,
    } as SaveModelTabsRequest));
    const dirtyIds = new Set(input.dirtyTabIds);
    const nextProfile = resolveMainChatRuntimeProfileFromTabConfig(result.modelTabs.activeTab, result.modelTabs.tabs);
    const hotSwitchable = dirtyIds.size === 1 && dirtyIds.has(nextProfile.tabId) && canHotSwitchMainChatModelOnly(mainChatRuntimeState.getProfile(), nextProfile);
    const hotSwitched = hotSwitchable ? mainChatRuntimeState.hotSwitchModel(nextProfile) : false;
    if (hotSwitched) modelRuntimeUpdatedAt = new Date().toISOString();
    if (!hotSwitched) applyState.mark('model');
    return saveModelsResponseSchema.parse({
      modelTabs: redactModelTabs(result.modelTabs),
      hotSwitched,
      restartRequired: !hotSwitched,
      restartReason: hotSwitched ? null : 'Provider、接口地址、密钥或 OAuth bridge 变更需要重启 Koishi。',
      apply: applyState.snapshot(),
    });
  }, { mutation: true });

  register('post', '/models/:provider/list', async (koaCtx) => {
    const provider = parseInput(z.enum(['deepseek', 'mimo', 'copilot', 'codex']), koaCtx.params.provider);
    const input = parseInput(modelListRequestSchema, koaCtx.request.body ?? {});
    const result = provider === 'deepseek'
      ? await options.manager.listDeepSeekModels(input)
      : provider === 'mimo'
        ? await options.manager.listMimoModels(input)
        : provider === 'copilot'
          ? await options.manager.listCopilotModels()
          : await options.manager.listCodexModels();
    return serializeModelList(provider, result);
  }, { mutation: true });

  register('get', '/oauth/:provider', async (koaCtx) => {
    const provider = parseInput(oauthProviderSchema, koaCtx.params.provider);
    return oauthMutationResponseSchema.parse(provider === 'copilot'
      ? await options.copilotBridge.getAdminStatus({ probe: true })
      : await options.codexBridge.getAdminStatus({ probe: true }));
  });
  register('post', '/oauth/:provider/start', async (koaCtx) => {
    const provider = parseInput(oauthProviderSchema, koaCtx.params.provider);
    return oauthMutationResponseSchema.parse(provider === 'copilot'
      ? await domain(() => options.copilotBridge.startLogin())
      : await domain(() => options.codexBridge.startLogin()));
  }, { mutation: true });
  register('post', '/oauth/:provider/poll', async (koaCtx) => {
    const input = parseInput(oauthAttemptRequestSchema, koaCtx.request.body);
    const provider = parseInput(oauthProviderSchema, koaCtx.params.provider);
    return oauthMutationResponseSchema.parse(provider === 'copilot'
      ? await domain(() => options.copilotBridge.pollLogin(input.attemptId))
      : await domain(() => options.codexBridge.pollLogin(input.attemptId)));
  }, { mutation: true });
  register('post', '/oauth/:provider/cancel', async (koaCtx) => {
    const input = parseInput(oauthAttemptRequestSchema, koaCtx.request.body);
    const provider = parseInput(oauthProviderSchema, koaCtx.params.provider);
    return oauthMutationResponseSchema.parse(provider === 'copilot'
      ? await domain(() => options.copilotBridge.cancelLogin(input.attemptId))
      : await domain(() => options.codexBridge.cancelLogin(input.attemptId)));
  }, { mutation: true });
  register('post', '/oauth/:provider/logout', async (koaCtx) => {
    const provider = parseInput(oauthProviderSchema, koaCtx.params.provider);
    return oauthMutationResponseSchema.parse(provider === 'copilot'
      ? await domain(() => options.copilotBridge.logout())
      : await domain(() => options.codexBridge.logout()));
  }, { mutation: true });

  register('get', '/presets', () => presetDomain(() => presetCatalogResponseSchema.parse({
    presets: options.ctx.chatluna.preset.listPresets().value,
    globalDefaultPresetId: options.ctx.chatluna.preset.getGlobalDefaultPresetId().value,
  })));
  register('get', '/presets/:id', (koaCtx) => presetDomain(() => readPresetDetail(
    options.ctx.chatluna.preset,
    parseInput(presetIdSchema, koaCtx.params.id),
  )));
  register('post', '/presets', async (koaCtx) => {
    const input = parseInput(presetCreateRequestSchema, koaCtx.request.body);
    const preset = await presetDomain(() => options.ctx.chatluna.preset.createPreset(input.preset));
    return readPresetDetail(options.ctx.chatluna.preset, preset.id);
  }, { mutation: true });
  register('put', '/presets/:id', async (koaCtx) => {
    const id = parseInput(presetIdSchema, koaCtx.params.id);
    const input = parseInput(presetUpdateRequestSchema, koaCtx.request.body);
    const preset = await presetDomain(() => options.ctx.chatluna.preset.updatePreset(
      id,
      input.preset,
      input.expectedRevision,
    ));
    return readPresetDetail(options.ctx.chatluna.preset, preset.id);
  }, { mutation: true });
  register('delete', '/presets/:id', async (koaCtx) => {
    const input = parseInput(presetRevisionRequestSchema, koaCtx.request.body);
    await presetDomain(() => options.ctx.chatluna.preset.deletePreset(
      parseInput(presetIdSchema, koaCtx.params.id),
      input.expectedRevision,
    ));
    koaCtx.status = 204;
  }, { mutation: true });
  register('delete', '/presets/:id/override', async (koaCtx) => {
    const input = parseInput(presetRevisionRequestSchema, koaCtx.request.body);
    const preset = await presetDomain(() => options.ctx.chatluna.preset.revertOverride(
      parseInput(presetIdSchema, koaCtx.params.id),
      input.expectedRevision,
    ));
    return readPresetDetail(options.ctx.chatluna.preset, preset.id);
  }, { mutation: true });
  register('put', '/presets/default', async (koaCtx) => {
    const input = parseInput(presetDefaultRequestSchema, koaCtx.request.body);
    await presetDomain(() => options.ctx.chatluna.preset.setGlobalDefaultPresetId(input.id));
    return presetDefaultResponseSchema.parse({
      globalDefaultPresetId: options.ctx.chatluna.preset.getGlobalDefaultPresetId().value,
    });
  }, { mutation: true });
  register('get', '/model-context/blueprint', (koaCtx) => presetDomain(() => {
    const input = parseInput(contextBlueprintQuerySchema, koaCtx.query);
    options.ctx.chatluna.preset.getDefinition(input.presetId);
    const preset = options.ctx.chatluna.preset.getPreset(input.presetId).value;
    return contextBlueprintResponseSchema.parse(buildContextBlueprint(preset));
  }));
  register('get', '/model-context/targets', async () => {
    return contextTargetsResponseSchema.parse({
      targets: await buildContextTargets(options.services.database),
    });
  });
  register('get', '/model-context/snapshots/:conversationId', (koaCtx) => {
    const conversationId = parseInput(z.string().trim().min(1).max(512), koaCtx.params.conversationId);
    return contextSnapshotResponseSchema.parse(options.contextSnapshots.latest(conversationId));
  });

  register('get', '/policies', async () => {
    const featurePolicy = requireService(options.services.featurePolicy, 'feature policy');
    const toolPolicy = requireService(options.services.toolPolicy, 'tool policy');
    const [featureScopes, featureOverrides, conversationTargets, tools] = await Promise.all([
      featurePolicy.listAdminFeatureScopes(),
      featurePolicy.getFeatureOverrides(),
      featurePolicy.listConversationTargets(),
      toolPolicy.getToolPolicyState(),
    ]);
    return { featureScopes, featureOverrides, conversationTargets, tools };
  });
  register('patch', '/policies/features', async (koaCtx) => {
    const input = parseInput(featureOverridesRequestSchema, koaCtx.request.body);
    const service = requireService(options.services.featurePolicy, 'feature policy');
    return { overrides: await domain(() => service.saveFeatureOverrides(input.overrides as any)) };
  }, { mutation: true });
  register('patch', '/policies/tools', async (koaCtx) => {
    const input = parseInput(toolOverridesRequestSchema, koaCtx.request.body);
    const service = requireService(options.services.toolPolicy, 'tool policy');
    return { overrides: await domain(() => service.saveToolOverrides(input.overrides as any)) };
  }, { mutation: true });
  register('post', '/conversations/clear', async (koaCtx) => {
    const input = parseInput(conversationTargetRequestSchema, koaCtx.request.body);
    const service = requireService(options.services.featurePolicy, 'feature policy');
    return { result: await domain(() => service.clearConversationHistory(input)) };
  }, { mutation: true });
  register('delete', '/conversations', async (koaCtx) => {
    const input = parseInput(conversationTargetRequestSchema, koaCtx.request.body);
    const service = requireService(options.services.featurePolicy, 'feature policy');
    return { result: await domain(() => service.deleteConversationRoom(input)) };
  }, { mutation: true });

  register('get', '/affinity', async () => redactAffinityState(await requireService(options.services.affinity, 'affinity').getAdminState()));
  register('patch', '/affinity/settings', async (koaCtx) => {
    const input = parseInput(affinitySettingsRequestSchema, koaCtx.request.body);
    const settings: any = { ...input.settings };
    if (input.analysisModelApiKey !== undefined || input.clearAnalysisModelApiKey) {
      settings.analysisModel = {
        ...(settings.analysisModel as Record<string, unknown> | undefined),
        apiKey: input.clearAnalysisModelApiKey ? '' : input.analysisModelApiKey,
      };
    }
    return redactAffinityState(await requireService(options.services.affinity, 'affinity').saveSettings(settings));
  }, { mutation: true });
  register('patch', '/affinity/whitelist', async (koaCtx) => {
    const input = parseInput(affinityWhitelistRequestSchema, koaCtx.request.body);
    return redactAffinityState(await requireService(options.services.affinity, 'affinity').saveWhitelist(input.scopes as any));
  }, { mutation: true });
  register('post', '/affinity/adjust', async (koaCtx) => {
    const input = parseInput(affinityAdjustRequestSchema, koaCtx.request.body);
    return redactAffinityState(await requireService(options.services.affinity, 'affinity').adjustUserState(input));
  }, { mutation: true });

  register('get', '/memory', async () => ({
    summary: await requireService(options.services.memoryAdmin, 'memory admin').getSummary(),
    status: options.services.memoryStatus ? await options.services.memoryStatus.getSnapshot() : createUnavailableMemoryStatusSnapshot(),
  }));
  register('get', '/memory/users', (koaCtx) => requireService(options.services.memoryAdmin, 'memory admin').getUsersPage(parseInput(pageQuerySchema, koaCtx.query)));
  register('get', '/memory/:kind', (koaCtx) => requireService(options.services.memoryAdmin, 'memory admin').getRecordsPage(
    parseInput(memoryKindSchema, koaCtx.params.kind),
    parseInput(pageQuerySchema, koaCtx.query),
  ));
  register('post', '/memory/probe/:target', async (koaCtx) => {
    const target = parseInput(z.enum(['embedding', 'extraction', 'provider']), koaCtx.params.target);
    const service = requireService(options.services.memoryStatus, 'memory status');
    const probe = target === 'embedding' ? service.probeEmbedding : target === 'extraction' ? service.probeExtraction : service.probeProvider;
    if (!probe) throw new AdminHttpError(503, 'service_unavailable', `${target} probe is unavailable`);
    return probe.call(service);
  }, { mutation: true });
  register('post', '/memory/mutations', async (koaCtx) => {
    const input = parseInput(memoryMutationSchema, koaCtx.request.body);
    return { ok: await requireService(options.services.memoryAdmin, 'memory admin').mutate(input) };
  }, { mutation: true });
  register('get', '/memory/export/:userKey', async (koaCtx) => {
    const userKey = String(koaCtx.params.userKey || '').trim();
    if (!userKey) throw new AdminHttpError(400, 'bad_request', 'userKey 不能为空。');
    return requireService(options.services.memoryAdmin, 'memory admin').exportUser(userKey);
  });

  register('get', '/tts', async () => {
    const [tts, env] = await Promise.all([options.manager.getTtsState(), options.manager.getManagedEnv()]);
    return { ...redactTtsState(tts), botFields: ttsBotFields(env) };
  });
  register('patch', '/tts', async (koaCtx) => {
    const input = parseInput(ttsChangesRequestSchema, koaCtx.request.body);
    const result = await domain(() => options.manager.saveTtsSettings({
      botEnv: input.botChanges.length > 0 ? buildEnvPatch(input.botChanges, ADMIN_ENV_KEYS, secretKeys) : {},
      localEnv: input.localChanges.length > 0 ? buildEnvPatch(input.localChanges, ttsLocalKeySet, ttsLocalSecretKeys) : {},
    }));
    if (result.restartRequired.bot) applyState.mark('features');
    if (result.restartRequired.tts) applyState.mark('tts');
    return { tts: { ...redactTtsState(result.tts), botFields: ttsBotFields(result.env) }, restartRequired: result.restartRequired, apply: applyState.snapshot() };
  }, { mutation: true });
  register('post', '/tts/probe', async () => ({ health: await options.manager.probeTtsHealth() }), { mutation: true });
  register('post', '/tts/sample', async (koaCtx) => {
    const input = parseInput(ttsSampleRequestSchema, koaCtx.request.body);
    const sample = await domain(() => options.manager.synthesizeTtsAudio(input));
    koaCtx.status = 200;
    koaCtx.type = sample.contentType;
    koaCtx.set('x-qqbot-tts-elapsed-ms', String(sample.elapsedMs));
    if (sample.durationSeconds != null) koaCtx.set('x-qqbot-tts-duration-seconds', String(sample.durationSeconds));
    if (sample.sampleRate != null) koaCtx.set('x-qqbot-tts-sample-rate', String(sample.sampleRate));
    if (sample.channels != null) koaCtx.set('x-qqbot-tts-channels', String(sample.channels));
    koaCtx.body = Buffer.from(sample.data);
  }, { mutation: true });
}
