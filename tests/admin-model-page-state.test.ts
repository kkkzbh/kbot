import { describe, expect, it } from 'vitest';
import type {
  ModelConfigAdminAggregate,
} from '../src/admin/contracts/index.js';
import {
  allowedBindingModes,
  buildModelConfigPutInput,
  createModelConfigDraft,
  createSecretDrafts,
  incompatibleWorkloadsForModel,
  isModelCompatible,
  isModelDraftDirty,
  isSavedConnectionOperationTarget,
  loadModelPageConfiguration,
  replaceBindingMode,
  structuredOutputProtocolsForRequestMode,
  withModelRequestMode,
  withStructuredOutputProtocol,
} from '../apps/admin-web/src/pages/model-page-state.js';

function aggregate(): ModelConfigAdminAggregate {
  return {
    schemaVersion: 1,
    savedRevision: 7,
    appliedRevision: 6,
    pending: true,
    pendingReason: 'saved_revision_not_applied',
    updatedAt: '2026-07-26T00:00:00.000Z',
    migration: null,
    connections: [{
      id: 'provider',
      displayName: 'Provider',
      adapter: 'openaiCompatible',
      baseUrl: 'https://provider.example.com/v1',
      auth: { kind: 'apiKey', secretRef: 'provider.api-key' },
      catalogDriver: 'openaiModels',
      credentialState: 'configured',
      hasSecret: true,
    }],
    models: [{
      id: 'chat',
      connectionId: 'provider',
      displayName: 'Chat',
      transportModel: 'chat-transport',
      modelType: 'chat',
      contextSize: 128_000,
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'native_chat_json_schema',
      capabilities: {
        chat: true,
        embedding: false,
        vision: true,
        tools: true,
        structuredOutput: true,
      },
      timeoutMs: 180_000,
      requestDefaults: {},
    }, {
      id: 'embedding',
      connectionId: 'provider',
      displayName: 'Embedding',
      transportModel: 'embedding-transport',
      modelType: 'embedding',
      contextSize: 8_192,
      requestMode: null,
      structuredOutputProtocol: null,
      capabilities: {
        chat: false,
        embedding: true,
        vision: false,
        tools: false,
        structuredOutput: false,
      },
      timeoutMs: 12_000,
      requestDefaults: {},
    }],
    bindings: [
      { workload: 'main.chat', mode: 'dedicated', connectionId: 'provider', modelId: 'chat' },
      { workload: 'memory.extract', mode: 'dedicated', connectionId: 'provider', modelId: 'chat' },
      { workload: 'memory.embedding', mode: 'dedicated', connectionId: 'provider', modelId: 'embedding' },
      { workload: 'affinity.analysis', mode: 'inheritMain' },
      { workload: 'naturalTrigger.decision', mode: 'disabled' },
      { workload: 'search.summary', mode: 'inheritInvocation' },
      { workload: 'chatluna.defaultEmbedding', mode: 'dedicated', connectionId: 'provider', modelId: 'embedding' },
      { workload: 'agent.subagent.default', mode: 'inheritInvocation' },
      { workload: 'sticker.index', mode: 'dedicated', connectionId: 'provider', modelId: 'chat' },
    ],
    liveBindings: [{
      workload: 'main.chat',
      sourceWorkload: 'main.chat',
      mode: 'dedicated',
      revision: 6,
      canonicalModel: 'qqbot-provider/chat',
      connectionId: 'provider',
      modelId: 'chat',
    }],
    connectionStates: [{
      connectionId: 'provider',
      status: 'ready',
      accountLabel: null,
      error: null,
      tokenExpiresAt: null,
      attempt: null,
    }],
  };
}

describe('admin unified model page state', () => {
  it('loads the required aggregate through a retryable boundary', async () => {
    const configuration = aggregate();
    await expect(loadModelPageConfiguration(Promise.resolve(configuration))).resolves.toEqual({
      modelState: configuration,
      requiredError: null,
    });
    await expect(loadModelPageConfiguration(Promise.reject(new Error('models unavailable')))).resolves.toEqual({
      modelState: null,
      requiredError: 'models unavailable',
    });
  });

  it('creates an editable draft without redacted credential metadata', () => {
    const configuration = aggregate();
    const draft = createModelConfigDraft(configuration);

    expect(draft.connections[0]).toEqual({
      id: 'provider',
      displayName: 'Provider',
      adapter: 'openaiCompatible',
      baseUrl: 'https://provider.example.com/v1',
      auth: { kind: 'apiKey', secretRef: 'provider.api-key' },
      catalogDriver: 'openaiModels',
    });
    expect(draft.connections[0]).not.toHaveProperty('credentialState');
    expect(draft.connections[0]).not.toHaveProperty('hasSecret');
  });

  it('preserves model IDs scoped independently to each connection', () => {
    const configuration = aggregate();
    configuration.connections.push({
      id: 'provider-two',
      displayName: 'Provider Two',
      adapter: 'openaiCompatible',
      baseUrl: 'https://provider-two.example.com/v1',
      auth: { kind: 'none' },
      catalogDriver: 'static',
      credentialState: 'external',
      hasSecret: false,
    });
    configuration.models.push({
      ...structuredClone(configuration.models[0]),
      connectionId: 'provider-two',
    });

    const draft = createModelConfigDraft(configuration);
    const submitted = buildModelConfigPutInput(
      configuration,
      draft,
      createSecretDrafts(configuration),
    );

    expect(draft.models
      .filter((model) => model.id === 'chat')
      .map((model) => model.connectionId)).toEqual(['provider', 'provider-two']);
    expect(submitted.draft.models
      .filter((model) => model.id === 'chat')
      .map((model) => model.connectionId)).toEqual(['provider', 'provider-two']);
  });

  it('submits the full aggregate draft with CAS and explicit secret operations', () => {
    const configuration = aggregate();
    const draft = createModelConfigDraft(configuration);
    const secrets = createSecretDrafts(configuration);
    draft.connections[0].displayName = 'Provider updated';
    secrets.provider = { operation: 'set', value: 'new-secret' };

    expect(isModelDraftDirty(configuration, draft, secrets)).toBe(true);
    expect(buildModelConfigPutInput(configuration, draft, secrets)).toEqual({
      expectedRevision: 7,
      draft,
      secretOperations: [{
        connectionId: 'provider',
        operation: 'set',
        value: 'new-secret',
      }],
    });
  });

  it('only enables connection operations for the exact saved connection and credentials', () => {
    const configuration = aggregate();
    const draft = createModelConfigDraft(configuration);
    const secrets = createSecretDrafts(configuration);

    expect(isSavedConnectionOperationTarget(
      configuration,
      draft,
      secrets,
      'provider',
    )).toBe(true);

    draft.connections[0].baseUrl = 'https://draft.example.com/v1';
    expect(isSavedConnectionOperationTarget(
      configuration,
      draft,
      secrets,
      'provider',
    )).toBe(false);

    draft.connections[0].baseUrl = 'https://provider.example.com/v1';
    secrets.provider = { operation: 'set', value: 'draft-secret' };
    expect(isSavedConnectionOperationTarget(
      configuration,
      draft,
      secrets,
      'provider',
    )).toBe(false);

    expect(isSavedConnectionOperationTarget(
      configuration,
      draft,
      secrets,
      'draft-only',
    )).toBe(false);
  });

  it('preserves the exact workload mode matrix when switching bindings', () => {
    expect(allowedBindingModes('main.chat')).toEqual(['dedicated']);
    expect(allowedBindingModes('memory.extract')).toEqual(['dedicated', 'disabled']);
    expect(allowedBindingModes('affinity.analysis')).toEqual(['inheritMain', 'dedicated']);
    expect(allowedBindingModes('agent.subagent.researcher')).toEqual(['inheritInvocation', 'dedicated']);
    expect(allowedBindingModes('agent.subagent.builtin:plan')).toEqual(['inheritInvocation', 'dedicated']);
    expect(allowedBindingModes('agent.subagent.preset:researcher')).toEqual(['inheritInvocation', 'dedicated']);

    expect(replaceBindingMode(
      { workload: 'memory.extract', mode: 'disabled' },
      'dedicated',
    )).toEqual({
      workload: 'memory.extract',
      mode: 'dedicated',
      connectionId: '',
      modelId: '',
    });
    expect(() => replaceBindingMode(
      { workload: 'main.chat', mode: 'dedicated', connectionId: 'provider', modelId: 'chat' },
      'disabled',
    )).toThrow('main.chat 不支持 disabled');
  });

  it('filters profiles by workload capabilities, including vision sticker indexing', () => {
    const configuration = aggregate();
    const chat = configuration.models[0];
    const embedding = configuration.models[1];

    expect(isModelCompatible('main.chat', chat)).toBe(true);
    expect(isModelCompatible('main.chat', {
      ...chat,
      capabilities: { ...chat.capabilities, tools: false },
    })).toBe(false);
    expect(isModelCompatible('memory.embedding', embedding)).toBe(true);
    expect(isModelCompatible('memory.embedding', chat)).toBe(false);
    expect(isModelCompatible('sticker.index', chat)).toBe(true);
    expect(isModelCompatible('sticker.index', {
      ...chat,
      capabilities: { ...chat.capabilities, vision: false },
    })).toBe(false);
  });

  it('keeps request mode and native structured-output protocol atomic', () => {
    const chat = aggregate().models[0];
    const responses = withModelRequestMode(chat, 'responses');

    expect(responses.requestMode).toBe('responses');
    expect(responses.structuredOutputProtocol).toBe('native_responses_json_schema');
    expect(structuredOutputProtocolsForRequestMode('responses')).not.toContain(
      'native_chat_json_schema',
    );
    expect(() => withStructuredOutputProtocol(
      responses,
      'native_chat_json_schema',
    )).toThrow('不适用于 responses');

    const chatCompletions = withModelRequestMode(responses, 'chat_completions');
    expect(chatCompletions.structuredOutputProtocol).toBe('native_chat_json_schema');
  });

  it('reports every existing binding invalidated by a model contract edit', () => {
    const configuration = aggregate();
    const draft = createModelConfigDraft(configuration);
    const chat = draft.models[0];

    expect(incompatibleWorkloadsForModel(draft, {
      ...chat,
      capabilities: { ...chat.capabilities, tools: false },
    })).toContain('main.chat');

    const withoutStructuredOutput = withStructuredOutputProtocol(chat, null);
    expect(incompatibleWorkloadsForModel(draft, withoutStructuredOutput)).toEqual(
      expect.arrayContaining([
        'main.chat',
        'memory.extract',
        'affinity.analysis',
        'sticker.index',
      ]),
    );
  });
});
