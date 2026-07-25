import { describe, expect, it } from 'vitest';
import {
  adminErrorSchema,
  loginRequestSchema,
  modelListResponseSchema,
  modelRuntimeStateSchema,
  modelTabsResponseSchema,
  modelTabsPatchRequestSchema,
  oauthMutationResponseSchema,
  pageQuerySchema,
  presetCatalogResponseSchema,
  presetCreateRequestSchema,
  presetRevisionRequestSchema,
  presetUpdateRequestSchema,
  contextTargetSchema,
  contextSnapshotSchema,
  settingsPatchRequestSchema,
} from '../src/admin/contracts/index.js';

const preset = {
  schemaVersion: 2 as const,
  id: 'sakiko',
  displayName: 'Sakiko',
  aliases: ['小祥'],
  messages: [],
  inputFormat: null,
  lore: { defaults: {}, entries: [] },
  authorsNote: null,
  knowledge: null,
  promptConfig: {},
};

describe('admin shared contracts', () => {
  it('validates login and structured errors', () => {
    expect(loginRequestSchema.parse({ accessToken: 'secret' })).toEqual({ accessToken: 'secret' });
    expect(adminErrorSchema.parse({ error: { code: 'unauthenticated', message: 'expired', requestId: 'request-1' } })).toEqual({
      error: { code: 'unauthenticated', message: 'expired', requestId: 'request-1' },
    });
  });

  it('models secret retention and explicit clear as separate operations', () => {
    expect(settingsPatchRequestSchema.parse({ changes: [{ key: 'API_KEY' }] })).toEqual({ changes: [{ key: 'API_KEY' }] });
    expect(settingsPatchRequestSchema.parse({ changes: [{ key: 'API_KEY', clear: true }] })).toEqual({ changes: [{ key: 'API_KEY', clear: true }] });
    expect(() => settingsPatchRequestSchema.parse({ changes: [{ key: 'API_KEY', value: 'next', clear: true }] })).toThrow();
  });

  it('normalizes bounded pagination query values', () => {
    expect(pageQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(pageQuerySchema.parse({ page: '2', pageSize: '50' })).toEqual({ page: 2, pageSize: 50 });
    expect(() => pageQuerySchema.parse({ pageSize: 101 })).toThrow();
  });

  it('requires explicit model dirty tabs and explicit key clear', () => {
    expect(modelTabsPatchRequestSchema.parse({
      activeTab: 'openai',
      dirtyTabIds: ['openai'],
      tabs: [{ id: 'openai', baseUrl: 'https://example.com/v1', defaultModel: 'gpt-test', clearApiKey: true }],
    }).tabs[0].clearApiKey).toBe(true);
    expect(() => modelTabsPatchRequestSchema.parse({
      activeTab: 'openai', dirtyTabIds: ['openai'],
      tabs: [{ id: 'openai', defaultModel: 'gpt-test', apiKey: 'next', clearApiKey: true }],
    })).toThrow();
  });

  it('shares strict model, catalog, and OAuth response contracts', () => {
    const tab = {
      id: 'openai',
      title: 'OpenAI',
      provider: 'openai',
      strategyId: 'openai-gpt54-main-chat',
      requestMode: 'responses',
      structuredOutputProtocol: 'native_responses_json_schema',
      description: 'Main chat',
      modelHint: 'gpt-test',
      authKind: 'manual',
      authStatus: 'ready',
      baseUrl: 'https://api.example.com/v1',
      apiKey: null,
      apiKeyConfigured: true,
      defaultModel: 'gpt-test',
    };
    expect(modelTabsResponseSchema.parse({
      activeTab: 'openai',
      tabs: [tab],
    }).tabs[0].apiKey).toBeNull();
    expect(() => modelTabsResponseSchema.parse({
      activeTab: 'openai',
      tabs: [{ ...tab, leakedSecret: 'secret' }],
    })).toThrow();
    expect(modelListResponseSchema.parse({
      source: 'dynamic',
      models: [{ modelId: 'gpt-test', label: 'GPT Test' }],
      error: null,
    }).models).toHaveLength(1);
    expect(oauthMutationResponseSchema.parse({
      authKind: 'oauth_device',
      authStatus: 'unauthenticated',
      accountLabel: null,
      authError: null,
      attempt: null,
    }).authStatus).toBe('unauthenticated');
  });

  it('shares strict Preset V2 mutation and catalog contracts', () => {
    expect(presetCreateRequestSchema.parse({ preset })).toEqual({ preset });
    expect(presetUpdateRequestSchema.parse({
      preset,
      expectedRevision: 'revision-1',
    })).toEqual({
      preset,
      expectedRevision: 'revision-1',
    });
    expect(() => presetCreateRequestSchema.parse(preset)).toThrow();
    expect(() => presetUpdateRequestSchema.parse({ preset })).toThrow();
    expect(presetRevisionRequestSchema.parse({
      expectedRevision: 'revision-1',
    })).toEqual({
      expectedRevision: 'revision-1',
    });
    expect(() => presetRevisionRequestSchema.parse({})).toThrow();
    expect(() => presetRevisionRequestSchema.parse({
      expectedRevision: 'revision-1',
      ignored: true,
    })).toThrow();
    expect(() => presetCreateRequestSchema.parse({
      preset: { keywords: [], prompts: [] },
    })).toThrow();
    expect(presetCatalogResponseSchema.parse({
      presets: [{
        id: 'sakiko',
        displayName: 'Sakiko',
        aliases: ['小祥'],
        source: 'runtime',
        hasOverride: false,
        revision: 'revision-1',
        isGlobalDefault: true,
      }],
      globalDefaultPresetId: 'sakiko',
    }).globalDefaultPresetId).toBe('sakiko');
  });

  it('keeps context targets as selector metadata without inferred runtime state', () => {
    expect(contextTargetSchema.parse({
      conversationId: 'conversation-1',
      roomId: 12,
      label: 'Test room',
      scope: 'group:group-1',
    })).toEqual({
      conversationId: 'conversation-1',
      roomId: 12,
      label: 'Test room',
      scope: 'group:group-1',
    });
    expect(() => contextTargetSchema.parse({
      conversationId: 'conversation-1',
      label: 'Test room',
      effectivePresetId: 'sakiko',
    })).toThrow();
  });

  it('requires ISO runtime timestamps and per-provider-call snapshot identity', () => {
    expect(modelRuntimeStateSchema.parse({
      configuredModel: 'openai/gpt-test',
      liveModel: 'openai/gpt-test',
      transportModel: 'gpt-test',
      requestMode: 'responses',
      modelContextSize: 128_000,
      contextLimit: 128_000,
      pending: false,
      pendingReason: null,
      updatedAt: '2026-07-25T00:00:00.000Z',
    }).updatedAt).toBe('2026-07-25T00:00:00.000Z');
    expect(() => modelRuntimeStateSchema.parse({
      configuredModel: null,
      liveModel: null,
      transportModel: null,
      requestMode: null,
      modelContextSize: null,
      contextLimit: null,
      pending: false,
      pendingReason: null,
      updatedAt: Date.now(),
    })).toThrow();

    const snapshot = {
      requestId: 'request-1',
      callId: 'call-1',
      callOrdinal: 1,
      conversationId: 'conversation-1',
      createdAt: Date.now(),
      platform: 'openai',
      model: 'openai/gpt-test',
      transportModel: 'gpt-test',
      requestMode: 'responses',
      stream: true,
      semanticStage: 'before_provider_serialization',
      effectivePresetId: 'sakiko',
      presetResolution: {
        source: 'conversation',
        presetId: 'sakiko',
        bindingKey: 'shared:onebot:bot:group',
      },
      presetRevision: 'revision-1',
      contextSize: 100,
      contextRatio: 0.01,
      contextLimit: 10_000,
      modelContextSize: 128_000,
      estimatedTokens: 100,
      providerInputTokens: null,
      providerOutputTokens: null,
      providerUsageEstimated: null,
      assembledCount: 1,
      finalCount: 1,
      truncated: false,
      messages: [],
      tools: [],
    };
    expect(contextSnapshotSchema.parse(snapshot).callId).toBe('call-1');
    expect(() => contextSnapshotSchema.parse({
      ...snapshot,
      callId: undefined,
    })).toThrow();
  });
});
