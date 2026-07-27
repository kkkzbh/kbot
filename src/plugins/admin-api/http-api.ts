import type { Context, Logger } from 'koishi';
import type {} from '@koishijs/plugin-server';
import { z } from 'zod';
import type {
  PresetError,
  PresetService,
} from 'koishi-plugin-chatluna/preset';
import { ContextPresetCompileError } from 'koishi-plugin-chatluna/preset-schema';
import {
  affinityAdjustRequestSchema,
  affinitySettingsRequestSchema,
  affinityWhitelistRequestSchema,
  adminLogsQuerySchema,
  connectionIdSchema,
  conversationTargetRequestSchema,
  featureOverridesRequestSchema,
  memoryKindSchema,
  memoryMutationSchema,
  emptyRequestSchema,
  modelAdminAggregateSchema,
  modelApplyRequestSchema,
  modelApplyResponseSchema,
  modelCatalogResponseSchema,
  modelConfigPutSchema,
  modelConnectionAuthStateSchema,
  modelConnectionProbeResponseSchema,
  modelOAuthPollRequestSchema,
  operationalEventActionRequestSchema,
  operationalEventListQuerySchema,
  pageQuerySchema,
  contextPresetCatalogResponseSchema,
  contextPresetCreateRequestSchema,
  contextPresetDefaultRequestSchema,
  contextPresetDefaultResponseSchema,
  contextPresetDetailResponseSchema,
  contextPresetPreviewRequestSchema,
  contextPresetPreviewResponseSchema,
  contextPresetUpdateRequestSchema,
  contextSnapshotResponseSchema,
  contextTargetsResponseSchema,
  presetIdSchema,
  presetRevisionRequestSchema,
  rolePresetCatalogResponseSchema,
  rolePresetCreateRequestSchema,
  rolePresetDetailResponseSchema,
  rolePresetUpdateRequestSchema,
  serviceActionRequestSchema,
  settingsChangeSchema,
  settingsPatchRequestSchema,
  settingsSectionSchema,
  stickerIndexMaintenanceResponseSchema,
  toolOverridesRequestSchema,
  ttsSampleRequestSchema,
  type SettingsSection,
} from '../../admin/contracts/index.js';
import type { AffinityServiceLike } from '../../types/affinity.js';
import type { FeaturePolicyServiceLike } from '../../types/feature-policy.js';
import type { MemoryStatusServiceLike } from '../../types/memory.js';
import type { ToolPolicyServiceLike } from '../../types/tool-policy.js';
import type { StickerMaintenanceService } from '../../types/model-config.js';
import type {
  AdminApplyReason,
  EnvPatch,
} from '../../types/admin.js';
import type { CopilotOAuthBridgeService } from '../copilot-oauth/index.js';
import type { CodexOAuthBridgeService } from '../codex-oauth/index.js';
import {
  ModelConfigError,
  type ModelConfigService,
} from '../model-config/index.js';
import { createUnavailableMemoryStatusSnapshot } from '../shared/memory-status.js';
import type { MemoryAdminService } from '../memory/index.js';
import { TTS_LOCAL_ENV_KEYS } from './tts.js';
import {
  ADMIN_ENV_FIELDS,
  AdminRestartJobError,
  AdminRuntimeManager,
  type ManagedEnvField,
} from './server.js';
import type { AdminLogService } from './logs.js';
import type { OperationalEventService } from './operational-events.js';
import { ModelConnectionOperations } from './model-operations.js';
import {
  buildContextTargets,
  type ModelContextSnapshotStore,
} from './model-context.js';
import {
  AdminAccessPolicy,
  AdminHttpError,
  createRequestId,
} from './access-policy.js';

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
  stickerMaintenance?: StickerMaintenanceService;
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
  accessPolicy: AdminAccessPolicy;
  services: AdminRuntimeServices;
  logs: AdminLogService;
  events: OperationalEventService;
  copilotBridge: CopilotOAuthBridgeService;
  codexBridge: CodexOAuthBridgeService;
  logger: Logger;
  contextSnapshots: ModelContextSnapshotStore;
  modelConfig: ModelConfigService;
};

type KoaContext = any;

type ApiHandler = (koaCtx: KoaContext) => Promise<unknown> | unknown;

type ApiRouteOptions = {
  mutation?: boolean;
};

const ttsChangesRequestSchema = z.object({
  botChanges: z.array(settingsChangeSchema).default([]),
  localChanges: z.array(settingsChangeSchema).default([]),
}).refine((input) => input.botChanges.length + input.localChanges.length > 0, '至少需要提交一个 TTS 配置项。');

const TTS_BOT_ENV_KEYS = new Set([
  'QQ_VOICE_TTS_BASE_URL',
  'QQ_VOICE_TTS_API_KEY',
  'QQ_VOICE_SYNTH_TIMEOUT_MS',
]);

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

function redactAffinityState(state: Awaited<ReturnType<AffinityServiceLike['getAdminState']>>) {
  return state;
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

function safeOperationDiagnostic(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, '[credential redacted]')
    .slice(0, 500);
}

function restartJobErrorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof AdminRestartJobError)) {
    return {
      operation: 'restart_service',
      stage: 'schedule',
      diagnostic: safeOperationDiagnostic(error),
    };
  }
  return {
    restartJobErrorCode: error.code,
    operation: error.operation,
    stage: error.stage,
    targetUnit: error.targetUnit,
    transientUnit: error.transientUnit,
    jobPhase: error.jobPhase,
    systemdResult: error.systemdResult,
  };
}

function presetHttpError(error: PresetError): AdminHttpError {
  const detail = error as PresetError & {
    referenceIds?: string[];
    blockId?: string;
    limit?: number;
  };
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
    referenceIds: detail.referenceIds ?? null,
    blockId: detail.blockId ?? null,
    limit: detail.limit ?? null,
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
    if (error instanceof ContextPresetCompileError) {
      throw new AdminHttpError(400, 'bad_request', error.message, {
        contextCompileErrorCode: error.code,
        stage: error.stage,
        blockId: error.blockId ?? null,
        limit: error.limit ?? null,
      });
    }
    throw error;
  }
}

function modelConfigHttpError(error: ModelConfigError): AdminHttpError {
  const code = error.httpStatus === 404
    ? 'not_found'
    : error.httpStatus === 409
      ? 'conflict'
      : error.httpStatus === 400
        ? 'bad_request'
        : error.httpStatus === 502
          ? 'upstream_error'
          : error.httpStatus === 503
            ? 'service_unavailable'
            : 'internal_error';
  return new AdminHttpError(error.httpStatus, code, error.message, {
    modelConfigErrorCode: error.code,
    operation: error.operation,
    stage: error.stage,
    path: error.path ?? null,
    connectionId: error.connectionId ?? null,
    modelId: error.modelId ?? null,
    workload: error.workload ?? null,
    expectedRevision: error.expectedRevision ?? null,
    actualRevision: error.actualRevision ?? null,
    upstreamStatus: error.upstreamStatus ?? null,
    providerCode: error.providerCode ?? null,
  });
}

async function modelConfigDomain<T>(operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ModelConfigError) throw modelConfigHttpError(error);
    throw error;
  }
}

async function readModelAdminAggregate(
  modelConfig: ModelConfigService,
  operations: ModelConnectionOperations,
) {
  const aggregate = modelConfig.getAggregate();
  return modelAdminAggregateSchema.parse({
    ...aggregate,
    connectionStates: await operations.getAuthStates(aggregate),
  });
}

function readContextPresetDetail(preset: PresetService, id: string) {
  const definition = preset.getContextPresetDefinition(id);
  const compiled = preset.getContextPreset(id).value;
  const summary = preset.listContextPresets().value.find((item) => item.id === id);
  if (!summary) {
    throw new AdminHttpError(500, 'internal_error', `已加载上下文预设 ${id} 缺少列表元数据。`);
  }
  return contextPresetDetailResponseSchema.parse({
    contextPreset: definition,
    source: compiled.source,
    hasOverride: summary.hasOverride,
    revision: compiled.revision,
  });
}

function readRolePresetDetail(preset: PresetService, id: string) {
  const definition = preset.getRolePresetDefinition(id);
  const compiled = preset.getRolePreset(id).value;
  const summary = preset.listRolePresets().value.find((item) => item.id === id);
  if (!summary) {
    throw new AdminHttpError(500, 'internal_error', `已加载角色预设 ${id} 缺少列表元数据。`);
  }
  return rolePresetDetailResponseSchema.parse({
    rolePreset: definition,
    source: compiled.source,
    hasOverride: summary.hasOverride,
    revision: compiled.revision,
    referenceCount: summary.referenceCount,
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

export function registerAdminApi(options: RegisterAdminApiOptions): void {
  const apiPath = normalizeBasePath(options.apiPath);
  const applyState = new AdminApplyState();
  const modelOperations = new ModelConnectionOperations({
    modelConfig: options.modelConfig,
    codexBridge: options.codexBridge,
    copilotBridge: options.copilotBridge,
  });
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
        options.accessPolicy.assertHost(requestHost(koaCtx));
        if (routeOptions.mutation) options.accessPolicy.assertMutationOrigin(requestOrigin(koaCtx));
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

  register('get', '/overview', async () => {
    const [services, modelAggregate, tts, memoryStatus, memorySummary, affinity, eventSummary] = await Promise.all([
      options.manager.getServiceStatuses(),
      readModelAdminAggregate(options.modelConfig, modelOperations),
      options.manager.getTtsState(),
      options.services.memoryStatus?.getSnapshot() ?? Promise.resolve(createUnavailableMemoryStatusSnapshot()),
      options.services.memoryAdmin?.getSummary() ?? Promise.resolve(unavailableMemorySummary()),
      options.services.affinity?.getAdminState() ?? Promise.resolve(null),
      options.events.summary(),
    ]);
    const mainBinding = modelAggregate.liveBindings.find((binding) => binding.workload === 'main.chat');
    const activeModel = mainBinding?.connectionId && mainBinding.modelId
      ? modelAggregate.models.find((model) => (
          model.connectionId === mainBinding.connectionId
          && model.id === mainBinding.modelId
        ))
      : null;
    const activeConnection = mainBinding?.connectionId
      ? modelAggregate.connections.find((connection) => connection.id === mainBinding.connectionId)
      : null;
    const activeAuth = activeConnection
      ? modelAggregate.connectionStates.find((state) => state.connectionId === activeConnection.id)
      : null;
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
        title: activeConnection?.displayName ?? activeModel.displayName,
        model: mainBinding?.canonicalModel ?? activeModel.id,
        authStatus: activeAuth?.status ?? 'error',
      } : null,
      globalDefaultPresetId: options.ctx.chatluna.preset.getGlobalDefaultContextPresetId().value,
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

  register('get', '/models', () => modelConfigDomain(
    () => readModelAdminAggregate(options.modelConfig, modelOperations),
  ));
  register('put', '/models', async (koaCtx) => {
    const input = parseInput(modelConfigPutSchema, koaCtx.request.body);
    const aggregate = await modelConfigDomain(() => options.modelConfig.put(input));
    return modelAdminAggregateSchema.parse({
      ...aggregate,
      connectionStates: await modelOperations.getAuthStates(aggregate),
    });
  }, { mutation: true });
  register('post', '/models/apply', async (koaCtx) => {
    const input = parseInput(modelApplyRequestSchema, koaCtx.request.body);
    const reservation = await modelConfigDomain(
      () => options.modelConfig.reserveApply(input.expectedRevision),
    );
    let status: Awaited<ReturnType<AdminRuntimeManager['getServiceStatus']>>;
    try {
      status = await options.manager.getServiceStatus('qqbot-koishi.service');
    } catch (error) {
      await reservation.release();
      throw new AdminHttpError(
        503,
        'service_unavailable',
        '读取 qqbot-koishi.service 当前状态失败。',
        {
          operation: 'apply',
          stage: 'inspect_service',
          savedRevision: reservation.savedRevision,
          diagnostic: safeOperationDiagnostic(error),
        },
      );
    }
    let restartJob: Awaited<ReturnType<AdminRuntimeManager['scheduleRestart']>>;
    try {
      restartJob = await options.manager.scheduleRestart('qqbot-koishi.service');
    } catch (error) {
      await reservation.release();
      throw new AdminHttpError(
        503,
        'service_unavailable',
        '调度 qqbot-koishi.service 重启任务失败，模型配置未应用。',
        {
          savedRevision: reservation.savedRevision,
          ...restartJobErrorDetails(error),
        },
      );
    }

    void (async () => {
      const outcome = await options.manager.superviseScheduledRestart(
        restartJob,
        status.controllerState.invocationId,
      );
      if (outcome.state !== 'safe_to_release') return;
      await reservation.release();
      options.logger.warn(
        'model config apply revision %d restart job %s ended as %s; reservation released',
        reservation.savedRevision,
        restartJob.transientUnit,
        outcome.reason,
      );
    })().catch((error: unknown) => {
      options.logger.error(
        'model config apply revision %d restart supervision failed; reservation remains locked: %s',
        reservation.savedRevision,
        safeOperationDiagnostic(error),
      );
    });

    return modelApplyResponseSchema.parse({
      accepted: true,
      savedRevision: reservation.savedRevision,
      target: {
        unit: 'qqbot-koishi.service',
        previousInvocationId: status.controllerState.invocationId,
      },
    });
  }, { mutation: true });
  register('post', '/models/maintenance/sticker-index', async (koaCtx) => {
    parseInput(emptyRequestSchema, koaCtx.request.body ?? {});
    const maintenance = requireService(
      options.services.stickerMaintenance,
      'sticker maintenance',
    );
    try {
      return stickerIndexMaintenanceResponseSchema.parse(await maintenance.runIndex());
    } catch (error) {
      if (error instanceof ModelConfigError) throw modelConfigHttpError(error);
      throw new AdminHttpError(
        503,
        'service_unavailable',
        '表情索引维护任务执行失败。',
        {
          operation: 'sticker_index',
          stage: 'execute',
          diagnostic: safeOperationDiagnostic(error),
        },
      );
    }
  }, { mutation: true });
  register('post', '/models/connections/:id/probe', async (koaCtx) => {
    parseInput(emptyRequestSchema, koaCtx.request.body ?? {});
    const connectionId = parseInput(connectionIdSchema, koaCtx.params.id);
    return modelConnectionProbeResponseSchema.parse(
      await modelOperations.probe(connectionId),
    );
  }, { mutation: true });
  register('post', '/models/connections/:id/catalog', async (koaCtx) => {
    parseInput(emptyRequestSchema, koaCtx.request.body ?? {});
    const connectionId = parseInput(connectionIdSchema, koaCtx.params.id);
    return modelCatalogResponseSchema.parse(
      await modelOperations.catalog(connectionId),
    );
  }, { mutation: true });
  register('post', '/models/connections/:id/oauth/start', async (koaCtx) => {
    parseInput(emptyRequestSchema, koaCtx.request.body ?? {});
    const connectionId = parseInput(connectionIdSchema, koaCtx.params.id);
    return modelConnectionAuthStateSchema.parse(
      await modelOperations.oauth(connectionId, 'start'),
    );
  }, { mutation: true });
  register('post', '/models/connections/:id/oauth/poll', async (koaCtx) => {
    const input = parseInput(modelOAuthPollRequestSchema, koaCtx.request.body);
    const connectionId = parseInput(connectionIdSchema, koaCtx.params.id);
    return modelConnectionAuthStateSchema.parse(
      await modelOperations.oauth(connectionId, 'poll', input.attemptId),
    );
  }, { mutation: true });
  register('post', '/models/connections/:id/oauth/logout', async (koaCtx) => {
    parseInput(emptyRequestSchema, koaCtx.request.body ?? {});
    const connectionId = parseInput(connectionIdSchema, koaCtx.params.id);
    return modelConnectionAuthStateSchema.parse(
      await modelOperations.oauth(connectionId, 'logout'),
    );
  }, { mutation: true });

  register('get', '/context-presets', () => presetDomain(() => contextPresetCatalogResponseSchema.parse({
    contextPresets: options.ctx.chatluna.preset.listContextPresets().value,
    globalDefaultContextPresetId: options.ctx.chatluna.preset.getGlobalDefaultContextPresetId().value,
  })));
  register('post', '/context-presets/preview', (koaCtx) => {
    const input = parseInput(contextPresetPreviewRequestSchema, koaCtx.request.body);
    return presetDomain(() => contextPresetPreviewResponseSchema.parse(
      options.ctx.chatluna.preset.previewContextPreset(input.contextPreset, {
        ...(input.inputTokenLimit == null ? {} : { inputTokenLimit: input.inputTokenLimit }),
        runtimeBlocks: ['qqbotFragments', 'toolDefinitions'],
      }),
    ));
  });
  register('put', '/context-presets/default', async (koaCtx) => {
    const input = parseInput(contextPresetDefaultRequestSchema, koaCtx.request.body);
    await presetDomain(() => options.ctx.chatluna.preset.setGlobalDefaultContextPresetId(input.id));
    return contextPresetDefaultResponseSchema.parse({
      globalDefaultContextPresetId: options.ctx.chatluna.preset
        .getGlobalDefaultContextPresetId().value,
    });
  }, { mutation: true });
  register('get', '/context-presets/:id', (koaCtx) => presetDomain(() => readContextPresetDetail(
    options.ctx.chatluna.preset,
    parseInput(presetIdSchema, koaCtx.params.id),
  )));
  register('post', '/context-presets', async (koaCtx) => {
    const input = parseInput(contextPresetCreateRequestSchema, koaCtx.request.body);
    const preset = await presetDomain(() => options.ctx.chatluna.preset
      .createContextPreset(input.contextPreset));
    return readContextPresetDetail(options.ctx.chatluna.preset, preset.id);
  }, { mutation: true });
  register('put', '/context-presets/:id', async (koaCtx) => {
    const id = parseInput(presetIdSchema, koaCtx.params.id);
    const input = parseInput(contextPresetUpdateRequestSchema, koaCtx.request.body);
    const preset = await presetDomain(() => options.ctx.chatluna.preset.updateContextPreset(
      id,
      input.contextPreset,
      input.expectedRevision,
    ));
    return readContextPresetDetail(options.ctx.chatluna.preset, preset.id);
  }, { mutation: true });
  register('delete', '/context-presets/:id', async (koaCtx) => {
    const input = parseInput(presetRevisionRequestSchema, koaCtx.request.body);
    await presetDomain(() => options.ctx.chatluna.preset.deleteContextPreset(
      parseInput(presetIdSchema, koaCtx.params.id),
      input.expectedRevision,
    ));
    koaCtx.status = 204;
  }, { mutation: true });
  register('delete', '/context-presets/:id/override', async (koaCtx) => {
    const input = parseInput(presetRevisionRequestSchema, koaCtx.request.body);
    const preset = await presetDomain(() => options.ctx.chatluna.preset.revertContextPreset(
      parseInput(presetIdSchema, koaCtx.params.id),
      input.expectedRevision,
    ));
    return readContextPresetDetail(options.ctx.chatluna.preset, preset.id);
  }, { mutation: true });

  register('get', '/role-presets', () => presetDomain(() => rolePresetCatalogResponseSchema.parse({
    rolePresets: options.ctx.chatluna.preset.listRolePresets().value,
  })));
  register('get', '/role-presets/:id', (koaCtx) => presetDomain(() => readRolePresetDetail(
    options.ctx.chatluna.preset,
    parseInput(presetIdSchema, koaCtx.params.id),
  )));
  register('post', '/role-presets', async (koaCtx) => {
    const input = parseInput(rolePresetCreateRequestSchema, koaCtx.request.body);
    const preset = await presetDomain(() => options.ctx.chatluna.preset
      .createRolePreset(input.rolePreset));
    return readRolePresetDetail(options.ctx.chatluna.preset, preset.id);
  }, { mutation: true });
  register('put', '/role-presets/:id', async (koaCtx) => {
    const id = parseInput(presetIdSchema, koaCtx.params.id);
    const input = parseInput(rolePresetUpdateRequestSchema, koaCtx.request.body);
    const preset = await presetDomain(() => options.ctx.chatluna.preset.updateRolePreset(
      id,
      input.rolePreset,
      input.expectedRevision,
    ));
    return readRolePresetDetail(options.ctx.chatluna.preset, preset.id);
  }, { mutation: true });
  register('delete', '/role-presets/:id', async (koaCtx) => {
    const input = parseInput(presetRevisionRequestSchema, koaCtx.request.body);
    await presetDomain(() => options.ctx.chatluna.preset.deleteRolePreset(
      parseInput(presetIdSchema, koaCtx.params.id),
      input.expectedRevision,
    ));
    koaCtx.status = 204;
  }, { mutation: true });
  register('delete', '/role-presets/:id/override', async (koaCtx) => {
    const input = parseInput(presetRevisionRequestSchema, koaCtx.request.body);
    const preset = await presetDomain(() => options.ctx.chatluna.preset.revertRolePreset(
      parseInput(presetIdSchema, koaCtx.params.id),
      input.expectedRevision,
    ));
    return readRolePresetDetail(options.ctx.chatluna.preset, preset.id);
  }, { mutation: true });

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
    return redactAffinityState(await requireService(options.services.affinity, 'affinity').saveSettings(input.settings));
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
    const target = parseInput(z.enum(['embedding', 'extraction']), koaCtx.params.target);
    const service = requireService(options.services.memoryStatus, 'memory status');
    return target === 'embedding'
      ? service.probeEmbedding()
      : service.probeExtraction();
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
      botEnv: input.botChanges.length > 0 ? buildEnvPatch(input.botChanges, TTS_BOT_ENV_KEYS, secretKeys) : {},
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
