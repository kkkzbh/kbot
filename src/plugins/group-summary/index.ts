import { Context, Logger, Schema } from 'koishi';
import type { ModelRuntimeClient } from '../model-config/index.js';
import { ensureGroupSummaryTables } from './schema.js';
import { GroupSummaryService } from './service.js';

export * from './schema.js';
export * from './service.js';
export const name = 'group-summary';
export const inject = { required: ['database', 'modelRuntime'] } as const;
export const Config = Schema.object({});

type RuntimeContext = Context & { modelRuntime: ModelRuntimeClient };

export async function apply(ctx: Context): Promise<void> {
  const runtimeCtx = ctx as RuntimeContext;
  ensureGroupSummaryTables(ctx);
  const service = new GroupSummaryService(ctx.database as never, runtimeCtx.modelRuntime, new Logger(name));
  await service.initialize();
  ctx.provide('groupSummary');
  ctx.set('groupSummary', service);
  ctx.middleware(async (session, next) => {
    try { await service.capture(session); }
    catch (error) { new Logger(name).warn('message capture failed: %s', error instanceof Error ? error.message : String(error)); }
    return next();
  }, true);
}
