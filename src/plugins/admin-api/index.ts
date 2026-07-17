import { join } from 'node:path';
import { Context, Logger, Schema } from 'koishi';
import { CopilotOAuthBridgeService } from '../copilot-oauth/index.js';
import { CodexOAuthBridgeService } from '../codex-oauth/index.js';
import type { AffinityServiceLike } from '../../types/affinity.js';
import type { FeaturePolicyServiceLike } from '../../types/feature-policy.js';
import type { MemoryStatusServiceLike } from '../../types/memory.js';
import type { MemoryAdminService } from '../memory/index.js';
import type { ToolPolicyServiceLike } from '../../types/tool-policy.js';
import { AdminRuntimeManager, resolveBotEnvFiles } from './server.js';
import { AdminSessionService } from './session.js';
import { AdminLogService } from './logs.js';
import { registerAdminApi, type AdminRuntimeServices } from './http-api.js';
import { registerAdminStatic } from './static.js';
import { registerInternalBridges } from './internal-bridges.js';
import { ensureOperationalEventTables, OperationalEventService } from './operational-events.js';

export const name = 'admin-api';
export const inject = {
  required: ['server', 'database'],
  optional: ['memoryStatus', 'memoryAdmin', 'featurePolicy', 'toolPolicy', 'affinity'],
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
  memoryStatus?: MemoryStatusServiceLike;
  memoryAdmin?: MemoryAdminService;
  featurePolicy?: FeaturePolicyServiceLike;
  toolPolicy?: ToolPolicyServiceLike;
  affinity?: AffinityServiceLike;
};

export function apply(ctx: Context, config: Config): void {
  const logger = new Logger('admin-api');
  const runtimeCtx = ctx as RuntimeContext;
  const envFiles = resolveBotEnvFiles(ctx.baseDir);
  const copilotBridge = new CopilotOAuthBridgeService({ rootDir: ctx.baseDir, envFiles });
  const codexBridge = new CodexOAuthBridgeService({ rootDir: ctx.baseDir, envFiles });
  const manager = new AdminRuntimeManager({ rootDir: ctx.baseDir, copilotBridge, codexBridge });
  const session = new AdminSessionService({
    accessToken: config.accessToken,
    sessionSecret: config.sessionSecret,
    allowedOrigins: config.allowedOrigins,
    ttlSeconds: config.sessionTtlSeconds,
  });
  const logs = new AdminLogService();
  ensureOperationalEventTables(ctx);
  ctx.on('dispose', () => logs.dispose());
  const services: AdminRuntimeServices = {
    database: ctx.database as unknown as AdminRuntimeServices['database'],
    get memoryStatus() { return runtimeCtx.memoryStatus; },
    get memoryAdmin() { return runtimeCtx.memoryAdmin; },
    get featurePolicy() { return runtimeCtx.featurePolicy; },
    get toolPolicy() { return runtimeCtx.toolPolicy; },
    get affinity() { return runtimeCtx.affinity; },
  };
  const events = new OperationalEventService(
    services.database,
    manager,
    () => runtimeCtx.memoryAdmin,
    logger,
  );

  manager.syncManagedChatLunaAgentConfig();

  registerAdminApi({
    ctx,
    apiPath: config.apiPath,
    manager,
    session,
    services,
    logs,
    events,
    copilotBridge,
    codexBridge,
    logger,
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
