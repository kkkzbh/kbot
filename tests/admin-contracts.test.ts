import { describe, expect, it } from 'vitest';
import {
  adminErrorSchema,
  affinitySettingsRequestSchema,
  modelAdminAggregateSchema,
  modelConfigPutSchema,
  modelOAuthPollRequestSchema,
  memoryArchiveRequestSchema,
  memoryForgetRequestSchema,
  memoryPageQuerySchema,
  contextPresetCatalogResponseSchema,
  contextPresetCreateRequestSchema,
  contextPresetPreviewResponseSchema,
  contextPresetUpdateRequestSchema,
  contextTargetSchema,
  contextSnapshotSchema,
  presetRevisionRequestSchema,
  rolePresetCatalogResponseSchema,
  rolePresetCreateRequestSchema,
  rolePresetUpdateRequestSchema,
  settingsPatchRequestSchema,
} from '../src/admin/contracts/index.js';

const rolePreset = {
  schemaVersion: 1 as const,
  id: 'sakiko',
  displayName: 'Sakiko',
  messages: [],
};

const contextPreset = {
  schemaVersion: 1 as const,
  id: 'sakiko',
  displayName: 'Sakiko',
  aliases: ['小祥'],
  blocks: [
    { id: 'role', type: 'role' as const, rolePresetId: 'sakiko' },
    { id: 'input', type: 'currentInput' as const, inputFormat: null },
    {
      id: 'output',
      type: 'modelOutput' as const,
      maxOutputTokens: 1024,
      postHandler: null,
    },
  ],
};

const modelDraft = {
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
    contextSize: 128_000,
    requestMode: 'responses' as const,
    structuredOutputProtocol: 'native_responses_json_schema' as const,
    capabilities: {
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
    { workload: 'affinity.analysis', mode: 'inheritMain' as const },
    { workload: 'naturalTrigger.decision', mode: 'disabled' as const },
    { workload: 'agent.subagent.default', mode: 'inheritInvocation' as const },
    { workload: 'sticker.index', mode: 'disabled' as const },
  ],
};

describe('admin shared contracts', () => {
  it('validates structured errors', () => {
    expect(adminErrorSchema.parse({ error: { code: 'bad_request', message: 'invalid input', requestId: 'request-1' } })).toEqual({
      error: { code: 'bad_request', message: 'invalid input', requestId: 'request-1' },
    });
    expect(adminErrorSchema.parse({
      error: {
        code: 'unauthorized',
        message: 'authentication required',
        requestId: 'request-2',
      },
    }).error.code).toBe('unauthorized');
    expect(adminErrorSchema.parse({
      error: {
        code: 'memory_error',
        message: 'memory operation failed',
        requestId: 'request-3',
        details: {
          operation: 'forget',
          stage: 'finalize',
          memoryCode: 'lease_expired',
          retryable: true,
        },
      },
    }).error.code).toBe('memory_error');
  });

  it('models secret retention and explicit clear as separate operations', () => {
    expect(settingsPatchRequestSchema.parse({ changes: [{ key: 'API_KEY' }] })).toEqual({ changes: [{ key: 'API_KEY' }] });
    expect(settingsPatchRequestSchema.parse({ changes: [{ key: 'API_KEY', clear: true }] })).toEqual({ changes: [{ key: 'API_KEY', clear: true }] });
    expect(() => settingsPatchRequestSchema.parse({ changes: [{ key: 'API_KEY', value: 'next', clear: true }] })).toThrow();
  });

  it('normalizes bounded pagination query values', () => {
    expect(memoryPageQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(memoryPageQuerySchema.parse({ page: '2', pageSize: '50' })).toEqual({ page: 2, pageSize: 50 });
    expect(() => memoryPageQuerySchema.parse({ pageSize: 101 })).toThrow();
    expect(memoryForgetRequestSchema.parse({
      streamId: 'stream-1',
      reasonCode: 'operator-delete',
    })).toEqual({
      streamId: 'stream-1',
      reasonCode: 'operator-delete',
    });
    expect(() => memoryForgetRequestSchema.parse({
      reasonCode: 'operator-delete',
    })).toThrow();
    expect(() => memoryForgetRequestSchema.parse({
      streamId: 'stream-1',
      all: true,
      reasonCode: 'operator-delete',
    })).toThrow();
    expect(() => memoryForgetRequestSchema.parse({
      streamId: 'stream-1',
      reasonCode: 'contains private content',
    })).toThrow();
    expect(memoryArchiveRequestSchema.parse({
      streamId: 'stream-1',
      reasonCode: 'duplicate',
    })).toEqual({
      streamId: 'stream-1',
      reasonCode: 'duplicate',
    });
    expect(() => memoryArchiveRequestSchema.parse({
      streamId: 'stream-1',
      reasonCode: 'free form text',
    })).toThrow();
  });

  it('keeps affinity settings free of model configuration', () => {
    const settings = {
      enabled: true,
      proactiveEnabled: true,
      randomWindowStartHour: 8,
      randomWindowEndHour: 22,
      randomCountWeights: [0, 1, 1, 0] as const,
      enabledDirections: ['daily_greeting'] as const,
      webSourceEnabled: false,
    };
    expect(affinitySettingsRequestSchema.parse({ settings })).toEqual({ settings });
    expect(() => affinitySettingsRequestSchema.parse({
      settings: {
        ...settings,
        analysisModel: { model: 'hidden-owner' },
      },
    })).toThrow();
  });

  it('shares strict aggregate, CAS mutation, and OAuth poll contracts', () => {
    const aggregate = modelAdminAggregateSchema.parse({
      schemaVersion: 3,
      savedRevision: 2,
      appliedRevision: 1,
      pending: true,
      pendingReason: 'saved_revision_not_applied',
      updatedAt: '2026-07-25T00:00:00.000Z',
      migration: null,
      ...modelDraft,
      connections: [{
        ...modelDraft.connections[0],
        credentialState: 'configured',
        hasSecret: true,
      }],
      liveBindings: [],
      connectionStates: [{
        connectionId: 'openai',
        status: 'ready',
        accountLabel: null,
        error: null,
        tokenExpiresAt: null,
        attempt: null,
      }],
    });
    expect(aggregate.connections[0].hasSecret).toBe(true);
    expect(() => modelAdminAggregateSchema.parse({
      ...aggregate,
      leakedSecret: 'secret',
    })).toThrow();
    expect(modelConfigPutSchema.parse({
      expectedRevision: 2,
      draft: modelDraft,
      secretOperations: [{
        connectionId: 'openai',
        operation: 'set',
        value: 'next-secret',
      }],
    }).secretOperations[0].operation).toBe('set');
    expect(() => modelConfigPutSchema.parse({
      expectedRevision: 2,
      draft: modelDraft,
      secretOperations: [{
        connectionId: 'openai',
        operation: 'retain',
        value: 'not-allowed',
      }],
    })).toThrow();
    expect(modelOAuthPollRequestSchema.parse({ attemptId: 'attempt-1' }))
      .toEqual({ attemptId: 'attempt-1' });
  });

  it('shares independent strict context and role preset contracts', () => {
    expect(contextPresetCreateRequestSchema.parse({ contextPreset }))
      .toEqual({ contextPreset });
    expect(contextPresetUpdateRequestSchema.parse({
      contextPreset,
      expectedRevision: 'revision-context',
    })).toEqual({
      contextPreset,
      expectedRevision: 'revision-context',
    });
    expect(rolePresetCreateRequestSchema.parse({ rolePreset })).toEqual({ rolePreset });
    expect(rolePresetUpdateRequestSchema.parse({
      rolePreset,
      expectedRevision: 'revision-role',
    })).toEqual({
      rolePreset,
      expectedRevision: 'revision-role',
    });
    expect(() => contextPresetCreateRequestSchema.parse(contextPreset)).toThrow();
    expect(() => contextPresetUpdateRequestSchema.parse({ contextPreset })).toThrow();
    expect(() => contextPresetCreateRequestSchema.parse({
      contextPreset: {
        ...contextPreset,
        blocks: [
          ...contextPreset.blocks,
          {
            id: 'long-memory',
            type: 'longMemory',
            enabled: true,
            budgetPriority: 200,
            maxTokens: null,
            prompt: null,
            extractPrompt: null,
            newQuestionPrompt: null,
          },
        ],
      },
    })).toThrow(/do not support the ChatLuna longMemory block/u);
    expect(() => rolePresetUpdateRequestSchema.parse({ rolePreset })).toThrow();
    expect(presetRevisionRequestSchema.parse({
      expectedRevision: 'revision-context',
    })).toEqual({
      expectedRevision: 'revision-context',
    });

    expect(contextPresetCatalogResponseSchema.parse({
      contextPresets: [{
        id: 'sakiko',
        displayName: 'Sakiko',
        aliases: ['小祥'],
        source: 'runtime',
        hasOverride: false,
        revision: 'revision-context',
        isGlobalDefault: true,
      }],
      globalDefaultContextPresetId: 'sakiko',
    }).globalDefaultContextPresetId).toBe('sakiko');
    expect(rolePresetCatalogResponseSchema.parse({
      rolePresets: [{
        id: 'sakiko',
        displayName: 'Sakiko',
        source: 'runtime',
        hasOverride: false,
        revision: 'revision-role',
        referenceCount: 2,
      }],
    }).rolePresets[0].referenceCount).toBe(2);
  });

  it('validates the resolved context stack preview', () => {
    expect(contextPresetPreviewResponseSchema.parse({
      blocks: [{
        id: 'role',
        type: 'role',
        source: 'stored',
        owner: 'role',
        locked: true,
        movable: false,
        enabled: true,
        staticTokens: 42,
        budget: null,
        legalDropRange: null,
      }],
      inputBudgetTokens: 7168,
      outputBudgetTokens: 1024,
    }).blocks[0].owner).toBe('role');
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

  it('requires per-provider-call snapshot identity', () => {
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
