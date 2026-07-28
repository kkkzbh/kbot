import { describe, expect, it, vi } from 'vitest';
import type {
  ModelConfigAdminAggregate,
  ModelConfigDraft,
} from '../src/admin/contracts/index.js';
import {
  allowedBindingModes,
  buildModelConfigPutInput,
  compatibleConnectionIds,
  createCatalogModelProfile,
  createModelConfigDraft,
  createSecretDrafts,
  incompatibleWorkloadsForModel,
  isModelCompatible,
  isModelDraftDirty,
  isSavedConnectionOperationTarget,
  loadModelPageConfiguration,
  nextCatalogModelId,
  orderModelSettingBindings,
  replaceBindingMode,
  structuredOutputProtocolsForRequestMode,
  trimUnreferencedCatalogModels,
  withModelRequestMode,
  withStructuredOutputProtocol,
} from '../apps/admin-web/src/pages/model-page-state.js';

function aggregate(): ModelConfigAdminAggregate {
  return {
    schemaVersion: 3,
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
      contextSize: 128_000,
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'native_chat_json_schema',
      capabilities: {
        vision: true,
        tools: true,
        structuredOutput: true,
      },
      timeoutMs: 180_000,
      requestDefaults: {},
    }],
    bindings: [
      { workload: 'main.chat', mode: 'dedicated', connectionId: 'provider', modelId: 'chat' },
      { workload: 'memory.extract', mode: 'dedicated', connectionId: 'provider', modelId: 'chat' },
      { workload: 'affinity.analysis', mode: 'inheritMain' },
      { workload: 'naturalTrigger.decision', mode: 'disabled' },
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
  it('creates canonical model profiles from dynamic provider catalog entries', () => {
    const connection = createModelConfigDraft(aggregate()).connections[0]!;
    const entry = {
      transportModel: 'openai/gpt-5.6-luna',
      displayName: 'GPT 5.6 Luna',
      requestMode: 'responses' as const,
      structuredOutputProtocol: 'native_responses_json_schema' as const,
      metadataTags: ['vision', 'tools'],
    };

    expect(nextCatalogModelId(entry.transportModel, [])).toBe('openai-gpt-5.6-luna');
    expect(nextCatalogModelId(entry.transportModel, ['openai-gpt-5.6-luna']))
      .toBe('openai-gpt-5.6-luna-2');
    expect(createCatalogModelProfile({
      connection,
      entry,
      contextSize: 200_000,
      existingIds: [],
    })).toMatchObject({
      id: 'openai-gpt-5.6-luna',
      connectionId: 'provider',
      displayName: 'GPT 5.6 Luna',
      transportModel: 'openai/gpt-5.6-luna',
      contextSize: 200_000,
      requestMode: 'responses',
      structuredOutputProtocol: 'native_responses_json_schema',
      capabilities: {
        vision: true,
        tools: true,
        structuredOutput: true,
      },
    });
  });

  it('derives a directly usable runtime contract from bridge catalogs', () => {
    const connection = {
      id: 'codex',
      displayName: 'Codex OAuth',
      adapter: 'codexBridge' as const,
      baseUrl: null,
      auth: { kind: 'oauth' as const, provider: 'codex' as const },
      catalogDriver: 'codexBridge' as const,
    };

    expect(createCatalogModelProfile({
      connection,
      entry: {
        transportModel: 'gpt-5.6-luna',
        displayName: 'GPT-5.6 Luna',
        requestMode: 'responses',
        structuredOutputProtocol: 'native_responses_json_schema',
        metadataTags: [],
      },
      existingIds: [],
    })).toMatchObject({
      id: 'gpt-5.6-luna',
      contextSize: 44_800,
      requestMode: 'responses',
      structuredOutputProtocol: 'native_responses_json_schema',
      capabilities: {
        vision: false,
        tools: true,
        structuredOutput: true,
      },
    });
  });

  it('orders model settings by operator workflow without changing source indexes', () => {
    const bindings = [
      { workload: 'sticker.index', mode: 'disabled' },
      { workload: 'agent.subagent.preset:research', mode: 'inheritInvocation' },
      { workload: 'main.chat', mode: 'dedicated', connectionId: 'provider', modelId: 'chat' },
      { workload: 'affinity.analysis', mode: 'inheritMain' },
      { workload: 'agent.subagent.default', mode: 'inheritInvocation' },
      { workload: 'memory.extract', mode: 'disabled' },
      { workload: 'naturalTrigger.decision', mode: 'disabled' },
    ] satisfies ModelConfigDraft['bindings'];

    const ordered = orderModelSettingBindings(bindings);

    expect(ordered.map(({ binding }) => binding.workload)).toEqual([
      'main.chat',
      'memory.extract',
      'naturalTrigger.decision',
      'affinity.analysis',
      'agent.subagent.default',
      'agent.subagent.preset:research',
      'sticker.index',
    ]);
    expect(ordered.find(({ binding }) => binding.workload === 'main.chat')?.sourceIndex)
      .toBe(2);
  });

  it('loads the required aggregate through a retryable boundary', async () => {
    const configuration = aggregate();
    const hydrate = vi.fn();
    await expect(loadModelPageConfiguration(Promise.resolve(configuration))).resolves.toEqual({
      modelState: configuration,
      requiredError: null,
    });
    await expect(loadModelPageConfiguration(
      Promise.resolve(configuration),
      hydrate,
    )).resolves.toEqual({
      modelState: configuration,
      requiredError: null,
    });
    expect(hydrate).toHaveBeenCalledWith(configuration);
    await expect(loadModelPageConfiguration(Promise.reject(new Error('models unavailable')))).resolves.toEqual({
      modelState: null,
      requiredError: 'models unavailable',
    });
    await expect(loadModelPageConfiguration(
      Promise.resolve(configuration),
      () => {
        throw new Error('draft initialization failed');
      },
    )).resolves.toEqual({
      modelState: null,
      requiredError: 'draft initialization failed',
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

  it('clones model drafts across Vue proxy boundaries without DataCloneError', () => {
    const configuration = new Proxy(aggregate(), {});
    expect(() => structuredClone(configuration)).toThrow(/could not be cloned|DataCloneError/i);

    const draft = createModelConfigDraft(configuration);
    const secrets = createSecretDrafts(configuration);

    expect(draft.connections[0].id).toBe('provider');
    expect(() => buildModelConfigPutInput(configuration, new Proxy(draft, {}), secrets))
      .not.toThrow();
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

  it('persists catalog models only while a workload uses them', () => {
    const configuration = aggregate();
    configuration.connections.push(
      {
        id: 'catalog',
        displayName: 'Catalog',
        adapter: 'openaiCompatible',
        baseUrl: 'https://catalog.example.com/v1',
        auth: { kind: 'none' },
        catalogDriver: 'openaiModels',
        credentialState: 'external',
        hasSecret: false,
      },
      {
        id: 'manual',
        displayName: 'Manual',
        adapter: 'openaiCompatible',
        baseUrl: 'https://manual.example.com/v1',
        auth: { kind: 'none' },
        catalogDriver: 'static',
        credentialState: 'external',
        hasSecret: false,
      },
    );
    configuration.models.push(
      {
        ...structuredClone(configuration.models[0]),
        id: 'unused-catalog',
        connectionId: 'catalog',
      },
      {
        ...structuredClone(configuration.models[0]),
        id: 'manual-model',
        connectionId: 'manual',
      },
    );

    const trimmed = trimUnreferencedCatalogModels(createModelConfigDraft(configuration));

    expect(trimmed.models.map((model) => `${model.connectionId}/${model.id}`)).toEqual([
      'provider/chat',
      'manual/manual-model',
    ]);
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
    expect(allowedBindingModes('memory.extract')).toEqual(['inheritMain', 'dedicated', 'disabled']);
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
    expect(isModelCompatible('main.chat', chat)).toBe(true);
    expect(isModelCompatible('main.chat', {
      ...chat,
      capabilities: { ...chat.capabilities, tools: false },
    })).toBe(false);
    expect(isModelCompatible('sticker.index', chat)).toBe(true);
    expect(isModelCompatible('sticker.index', {
      ...chat,
      capabilities: { ...chat.capabilities, vision: false },
    })).toBe(false);
  });

  it('filters manual authentication configurations by compatible models', () => {
    const configuration = aggregate();
    configuration.connections.push({
      id: 'chat-only',
      displayName: 'Chat only',
      adapter: 'openaiCompatible',
      baseUrl: 'https://chat-only.example.com/v1',
      auth: { kind: 'none' },
      catalogDriver: 'static',
      credentialState: 'external',
      hasSecret: false,
    });
    configuration.models.push({
      ...structuredClone(configuration.models[0]),
      id: 'plain-chat',
      connectionId: 'chat-only',
      capabilities: {
        vision: false,
        tools: false,
        structuredOutput: false,
      },
      structuredOutputProtocol: null,
    });
    const draft = createModelConfigDraft(configuration);

    expect([...compatibleConnectionIds(draft, 'memory.extract')]).toEqual(['provider']);
    expect([...compatibleConnectionIds(draft, 'agent.subagent.default')]).toEqual(['provider']);
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
