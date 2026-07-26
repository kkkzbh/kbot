import { Schema } from 'koishi';

export interface Config {
  enabled?: boolean;
  readEnabled?: boolean;
  writeEnabled?: boolean;
  queryTopK?: number;
  promptBudgetTokens?: number;
  embedBatchSize?: number;
  extractIdleMs?: number;
  extractMessageBatch?: number;
  archiveDays?: number;
  maxJobRetries?: number;
  jobLockTimeoutMs?: number;
  maxFacts?: number;
  maxEpisodes?: number;
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().description('是否启用本地长期记忆。'),
  readEnabled: Schema.boolean().description('是否启用长期记忆召回。'),
  writeEnabled: Schema.boolean().description('是否启用长期记忆提炼写入。'),
  queryTopK: Schema.natural().description('长期记忆召回条数上限。'),
  promptBudgetTokens: Schema.natural().description('长期记忆注入 prompt 预算。'),
  embedBatchSize: Schema.natural().description('单批 embedding 条数。'),
  extractIdleMs: Schema.natural().role('time').description('会话静默多久后触发记忆提炼。'),
  extractMessageBatch: Schema.natural().description('提炼时读取的最近消息条数。'),
  archiveDays: Schema.natural().description('低风险 episode 归档天数。'),
  maxJobRetries: Schema.natural().description('job 最大重试次数。'),
  jobLockTimeoutMs: Schema.natural().role('time').description('processing job 锁超时。'),
  maxFacts: Schema.natural().description('单批最多写入 fact 候选数。'),
  maxEpisodes: Schema.natural().description('单批最多写入 episode 候选数。'),
});

export interface MemoryRuntimeConfig {
  enabled: boolean;
  readEnabled: boolean;
  writeEnabled: boolean;
  queryTopK: number;
  promptBudgetTokens: number;
  embedBatchSize: number;
  extractIdleMs: number;
  extractMessageBatch: number;
  archiveDays: number;
  maxJobRetries: number;
  jobLockTimeoutMs: number;
  maxFacts: number;
  maxEpisodes: number;
}

function requireNaturalConfig(
  config: Config,
  key: keyof Config,
  min = 1,
): number {
  const parsed = Number(config[key]);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`长期记忆配置缺失或非法：${String(key)}。默认值必须由 koishi.yml 显式传入。`);
  }
  return Math.max(min, Math.floor(parsed));
}

function requireBooleanConfig(config: Config, key: keyof Config): boolean {
  const value = config[key];
  if (typeof value !== 'boolean') {
    throw new Error(`长期记忆配置缺失或非法：${String(key)}。默认值必须由 koishi.yml 显式传入。`);
  }
  return value;
}

export function toRuntimeConfig(config: Config): MemoryRuntimeConfig {
  return {
    enabled: requireBooleanConfig(config, 'enabled'),
    readEnabled: requireBooleanConfig(config, 'readEnabled'),
    writeEnabled: requireBooleanConfig(config, 'writeEnabled'),
    queryTopK: requireNaturalConfig(config, 'queryTopK', 1),
    promptBudgetTokens: requireNaturalConfig(config, 'promptBudgetTokens', 200),
    embedBatchSize: requireNaturalConfig(config, 'embedBatchSize', 1),
    extractIdleMs: requireNaturalConfig(config, 'extractIdleMs', 10_000),
    extractMessageBatch: requireNaturalConfig(config, 'extractMessageBatch', 4),
    archiveDays: requireNaturalConfig(config, 'archiveDays', 7),
    maxJobRetries: requireNaturalConfig(config, 'maxJobRetries', 0),
    jobLockTimeoutMs: requireNaturalConfig(config, 'jobLockTimeoutMs', 30_000),
    maxFacts: requireNaturalConfig(config, 'maxFacts', 1),
    maxEpisodes: requireNaturalConfig(config, 'maxEpisodes', 1),
  };
}
