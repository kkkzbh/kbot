import { join } from 'node:path';
import { Context, Logger, Schema } from 'koishi';
import type { PresetService } from 'koishi-plugin-chatluna/preset';
import type { PlatformService } from 'koishi-plugin-chatluna/llm-core/platform/service';
import type { ModelUsagePayload } from 'koishi-plugin-chatluna/llm-core/platform/usage';
import type { CopilotOAuthBridgeService } from '../copilot-oauth/index.js';
import type { CodexOAuthBridgeService } from '../codex-oauth/index.js';
import type { ModelConfigService } from '../model-config/index.js';
import type { AffinityServiceLike } from '../../types/affinity.js';
import type { FeaturePolicyServiceLike } from '../../types/feature-policy.js';
import type { MemoryStatusServiceLike } from '../../types/memory.js';
import type { MemoryAdminService } from '../memory/index.js';
import type { ToolPolicyServiceLike } from '../../types/tool-policy.js';
import type { StickerMaintenanceService } from '../../types/model-config.js';
import { AdminRuntimeManager } from './server.js';
import { AdminSessionService } from './session.js';
import { AdminLogService } from './logs.js';
import { registerAdminApi, type AdminRuntimeServices } from './http-api.js';
import { registerAdminStatic } from './static.js';
import { registerInternalBridges } from './internal-bridges.js';
import { ensureOperationalEventTables, OperationalEventService } from './operational-events.js';
import {
  ModelContextSnapshotStore,
  type ModelContextPayload,
} from './model-context.js';

export const name = 'admin-api';
export const inject = {
  required: ['server', 'database', 'chatluna', 'modelConfig', 'codexBridge', 'copilotBridge'],
  optional: [
    'memoryStatus',
    'memoryAdmin',
    'featurePolicy',
    'toolPolicy',
    'affinity',
    'stickerMaintenance',
  ],
} as const;

export interface Config {
  apiPath: string;
  accessToken: string;
  sessionSecret: string;
  allowedOrigins: string[];
  sessionTtlSeconds: number;
}

export const Config: Schema<Config> = Schema.object({
  apiPath: Schema.string().default('/api/admin/v1').description('Admin HTTP API 的基础路径。'),
  accessToken: Schema.string().role('secret').required().description('登录独立管理端使用的 access token。'),
  sessionSecret: Schema.string().role('secret').required().description('签发管理 session 的 HMAC secret。'),
  allowedOrigins: Schema.array(Schema.string()).required().description('允许访问管理端的完整 Origin 列表。'),
  sessionTtlSeconds: Schema.natural().min(300).max(31536000).default(7776000).description('管理 session 持久化有效期；每次打开管理台会滚动续期。'),
});

type RuntimeContext = Context & {
  chatluna: {
    preset: PresetService;
    platform: PlatformService;
  };
  modelConfig: ModelConfigService;
  codexBridge: CodexOAuthBridgeService;
  copilotBridge: CopilotOAuthBridgeService;
  memoryStatus?: MemoryStatusServiceLike;
  memoryAdmin?: MemoryAdminService;
  featurePolicy?: FeaturePolicyServiceLike;
  toolPolicy?: ToolPolicyServiceLike;
  affinity?: AffinityServiceLike;
  stickerMaintenance?: StickerMaintenanceService;
};

export function apply(ctx: Context, config: Config): void {
  const logger = new Logger('admin-api');
  const runtimeCtx = ctx as RuntimeContext;
  const copilotBridge = runtimeCtx.copilotBridge;
  const codexBridge = runtimeCtx.codexBridge;
  const manager = new AdminRuntimeManager({ rootDir: ctx.baseDir });
  const session = new AdminSessionService({
    accessToken: config.accessToken,
    sessionSecret: config.sessionSecret,
    allowedOrigins: config.allowedOrigins,
    ttlSeconds: config.sessionTtlSeconds,
  });
  const logs = new AdminLogService();
  const contextSnapshots = new ModelContextSnapshotStore(
    Date.now,
    (message) => logger.warn('%s', message),
  );
  ensureOperationalEventTables(ctx);
  ctx.on('dispose', () => logs.dispose());
  ctx.on('chatluna/model-context', async (payload: ModelContextPayload) => {
    contextSnapshots.ingestContext(payload);
  });
  ctx.on('chatluna/model-usage', async (payload: ModelUsagePayload) => {
    contextSnapshots.ingestUsage(payload);
  });
  ctx.setInterval(() => contextSnapshots.prunePending(), 30_000);
  const services: AdminRuntimeServices = {
    database: ctx.database as unknown as AdminRuntimeServices['database'],
    get memoryStatus() { return runtimeCtx.memoryStatus; },
    get memoryAdmin() { return runtimeCtx.memoryAdmin; },
    get featurePolicy() { return runtimeCtx.featurePolicy; },
    get toolPolicy() { return runtimeCtx.toolPolicy; },
    get affinity() { return runtimeCtx.affinity; },
    get stickerMaintenance() { return runtimeCtx.stickerMaintenance; },
  };
  const events = new OperationalEventService(
    services.database,
    manager,
    () => runtimeCtx.memoryAdmin,
    logger,
  );

  manager.syncManagedChatLunaAgentConfig();

  registerAdminApi({
    ctx: runtimeCtx,
    apiPath: config.apiPath,
    manager,
    session,
    services,
    logs,
    events,
    copilotBridge,
    codexBridge,
    logger,
    contextSnapshots,
    modelConfig: runtimeCtx.modelConfig,
  });
  registerAdminStatic({
    ctx,
    assetDir: join(ctx.baseDir, 'dist/admin-web'),
    session,
    logger,
  });
  registerInternalBridges({
    ctx,
    copilotBridge,
    codexBridge,
    getAffinity: () => runtimeCtx.affinity,
    logger,
  });
  events.start(ctx);

  logger.info('independent admin workspace registered at /');
}
