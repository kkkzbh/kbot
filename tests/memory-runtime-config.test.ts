import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => {
  type SchemaNode = {
    description: () => SchemaNode;
    role: () => SchemaNode;
  };
  const node = (): SchemaNode => ({
    description: node,
    role: node,
  });
  return {
    Schema: {
      object: node,
      boolean: node,
      natural: node,
    },
  };
});

import {
  toRuntimeConfig,
  type Config,
} from '../src/plugins/memory/config.js';

function featureConfig(): Config {
  return {
    enabled: true,
    maintenance: false,
    readEnabled: true,
    writeEnabled: true,
    queryTopK: 4,
    promptBudgetTokens: 800,
    embedBatchSize: 8,
    extractIdleMs: 10_000,
    extractMessageBatch: 8,
    archiveDays: 30,
    maxJobRetries: 3,
    jobLockTimeoutMs: 300_000,
    maxFacts: 5,
    maxEpisodes: 5,
  };
}

describe('memory runtime config', () => {
  it('keeps only memory policy and queue settings in the feature domain', () => {
    expect(toRuntimeConfig(featureConfig())).toEqual(featureConfig());
  });

  it('fails directly when a required feature setting is absent', () => {
    const config = featureConfig();
    delete config.embedBatchSize;

    expect(() => toRuntimeConfig(config)).toThrow(
      '长期记忆配置缺失或非法：embedBatchSize。',
    );
  });
});
