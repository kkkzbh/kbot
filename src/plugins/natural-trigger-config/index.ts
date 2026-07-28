import { isAbsolute, resolve } from 'node:path';
import { Context, Logger, Schema } from 'koishi';
import { NaturalTriggerConfigService } from './service.js';

export * from './errors.js';
export * from './service.js';
export * from './store.js';
export * from './types.js';

export const name = 'natural-trigger-config';

export interface Config {
  configPath: string;
}

export const Config: Schema<Config> = Schema.object({
  configPath: Schema.string().required().description('Natural trigger config JSON path.'),
});

const logger = new Logger(name);

declare module 'koishi' {
  interface Context {
    naturalTriggerConfig?: NaturalTriggerConfigService;
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const configPath = isAbsolute(config.configPath)
    ? config.configPath
    : resolve(ctx.baseDir, config.configPath);
  const service = new NaturalTriggerConfigService({ configPath });
  const snapshot = await service.loadAndApply();
  provideService(ctx, 'naturalTriggerConfig', service);
  logger.info(
    'natural trigger config revision %d loaded: groups=%d aliases=%d',
    snapshot.revision,
    snapshot.config.allowedGroupIds.length,
    snapshot.config.mechanisms.alias.aliases.length,
  );
}

function provideService(ctx: Context, serviceName: string, value: unknown): void {
  const provider = ctx as Context & {
    provide?: (name: string) => void;
    set?: (name: string, value: unknown) => void;
  };
  if (typeof provider.provide !== 'function' || typeof provider.set !== 'function') {
    throw new Error(`Koishi context cannot provide ${serviceName}.`);
  }
  provider.provide(serviceName);
  provider.set(serviceName, value);
}
