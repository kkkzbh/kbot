import { describe, expect, it, vi } from 'vitest';
import {
  CanonicalModelBindingResolver,
  ModelConfigError,
  serializeModelConfigDiagnostic,
  ModelRuntimeClient,
  canonicalModelName,
  modelConfigDraftSchema,
  parseCanonicalModelName,
  redactStaticBindings,
  type ModelConfigDraft,
  type ModelConnectionExecutor,
  type ModelDefinition,
  type ModelRuntimeSnapshot,
} from '../../src/plugins/model-config/index.js';
import { createValidModelConfigDraft } from './fixtures.js';

describe('canonical model config schema', () => {
  it('enforces the exact workload mode matrix', () => {
    const draft = createValidModelConfigDraft();
    const affinity = draft.bindings.find(
      (binding) => binding.workload === 'affinity.analysis',
    );
    if (!affinity) throw new Error('fixture is missing affinity.analysis');
    Object.assign(affinity, { mode: 'disabled' });

    const result = modelConfigDraftSchema.safeParse(draft);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ['bindings', 3, 'mode'],
        message: 'disabled is not allowed for affinity.analysis',
      }),
    ]));
  });

  it('requires all fixed workloads exactly once', () => {
    const missing = createValidModelConfigDraft();
    missing.bindings = missing.bindings.filter(
      (binding) => binding.workload !== 'memory.extract',
    );
    expect(modelConfigDraftSchema.safeParse(missing).success).toBe(false);

    const duplicate = createValidModelConfigDraft();
    duplicate.bindings.push(structuredClone(duplicate.bindings[0]));
    expect(modelConfigDraftSchema.safeParse(duplicate).success).toBe(false);
  });

  it('rejects duplicate connection IDs, connection-scoped model IDs, and secret references', () => {
    const duplicateConnection = createValidModelConfigDraft();
    duplicateConnection.connections.push(
      structuredClone(duplicateConnection.connections[0]),
    );
    expect(modelConfigDraftSchema.safeParse(duplicateConnection).success).toBe(false);

    const duplicateModel = createValidModelConfigDraft();
    duplicateModel.models.push(structuredClone(duplicateModel.models[0]));
    expect(modelConfigDraftSchema.safeParse(duplicateModel).success).toBe(false);

    const sameModelIdOnAnotherConnection = createValidModelConfigDraft();
    const repairableModel = sameModelIdOnAnotherConnection.models.find(
      (model) => model.connectionId === 'repairable',
    );
    if (!repairableModel) throw new Error('fixture is missing repairable model');
    repairableModel.id = 'primary-chat';
    expect(modelConfigDraftSchema.safeParse(sameModelIdOnAnotherConnection).success).toBe(true);

    const duplicateSecretRef = createValidModelConfigDraft();
    const repairable = duplicateSecretRef.connections.find(
      (connection) => connection.id === 'repairable',
    );
    if (!repairable || repairable.auth.kind !== 'apiKey') {
      throw new Error('fixture is missing repairable API key connection');
    }
    repairable.auth.secretRef = 'connection:primary:api-key';
    expect(modelConfigDraftSchema.safeParse(duplicateSecretRef).success).toBe(false);
  });

  it('rejects dangling references and capability mismatches', () => {
    const dangling = createValidModelConfigDraft();
    dangling.models = dangling.models.filter((model) => model.id !== 'primary-chat');
    expect(modelConfigDraftSchema.safeParse(dangling).success).toBe(false);

    const wrongCapability = createValidModelConfigDraft();
    const embedding = wrongCapability.models.find(
      (model) => model.id === 'primary-embedding',
    );
    if (!embedding) throw new Error('fixture is missing primary-embedding');
    embedding.capabilities.embedding = false;
    expect(modelConfigDraftSchema.safeParse(wrongCapability).success).toBe(false);
  });

  it('rejects connection IDs the managed platform factory cannot register', () => {
    const draft = createValidModelConfigDraft();
    draft.connections[0].id = 'primary_bad';
    expect(modelConfigDraftSchema.safeParse(draft).success).toBe(false);
  });

  it('accepts only credential-free HTTP(S) endpoints', () => {
    const withEmbeddedAuth = createValidModelConfigDraft();
    withEmbeddedAuth.connections[0].baseUrl = 'https://user:secret@models.example.test/v1';
    expect(modelConfigDraftSchema.safeParse(withEmbeddedAuth).success).toBe(false);

    const withQuery = createValidModelConfigDraft();
    withQuery.connections[0].baseUrl = 'https://models.example.test/v1?key=secret';
    expect(modelConfigDraftSchema.safeParse(withQuery).success).toBe(false);

    const withFragment = createValidModelConfigDraft();
    withFragment.connections[0].baseUrl = 'https://models.example.test/v1#credential';
    expect(modelConfigDraftSchema.safeParse(withFragment).success).toBe(false);

    const withFtp = createValidModelConfigDraft();
    withFtp.connections[0].baseUrl = 'ftp://models.example.test/v1';
    expect(modelConfigDraftSchema.safeParse(withFtp).success).toBe(false);

    const malformed = createValidModelConfigDraft();
    malformed.connections[0].baseUrl = 'models.example.test/v1';
    expect(modelConfigDraftSchema.safeParse(malformed).success).toBe(false);
  });

  it('requires tool calling on the main chat profile', () => {
    const draft = createValidModelConfigDraft();
    const main = draft.models.find((model) => model.id === 'primary-chat');
    if (!main) throw new Error('fixture is missing primary-chat');
    main.capabilities.tools = false;

    const result = modelConfigDraftSchema.safeParse(draft);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      'main.chat requires tools capability',
    );
  });

  it('enforces bridge adapter transport contracts before save', () => {
    const codexChatCompletions = createValidModelConfigDraft();
    configureBridgeConnection(codexChatCompletions, 'codexBridge');
    expect(modelConfigDraftSchema.safeParse(codexChatCompletions).error?.issues)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: 'codexBridge chat model profiles require responses requestMode',
        }),
      ]));

    const codexResponses = createValidModelConfigDraft();
    const codexModel = configureBridgeConnection(codexResponses, 'codexBridge');
    codexModel.requestMode = 'responses';
    codexModel.structuredOutputProtocol = 'native_responses_json_schema';
    expect(modelConfigDraftSchema.safeParse(codexResponses).success).toBe(true);

    const codexEmbedding = createValidModelConfigDraft();
    const codexEmbeddingModel = configureBridgeConnection(codexEmbedding, 'codexBridge');
    configureAsEmbedding(codexEmbeddingModel);
    const codexEmbeddingResult = modelConfigDraftSchema.safeParse(codexEmbedding);
    expect(codexEmbeddingResult.success).toBe(false);
    if (codexEmbeddingResult.success) return;
    expect(codexEmbeddingResult.error.issues.map((issue) => issue.message)).toContain(
      'codexBridge only supports chat model profiles',
    );

    const copilotEmbedding = createValidModelConfigDraft();
    const copilotEmbeddingModel = configureBridgeConnection(
      copilotEmbedding,
      'copilotBridge',
    );
    configureAsEmbedding(copilotEmbeddingModel);
    const copilotEmbeddingResult = modelConfigDraftSchema.safeParse(copilotEmbedding);
    expect(copilotEmbeddingResult.success).toBe(false);
    if (copilotEmbeddingResult.success) return;
    expect(copilotEmbeddingResult.error.issues.map((issue) => issue.message)).toContain(
      'copilotBridge only supports chat model profiles',
    );
  });

  it('requires the main chat typed reply protocol', () => {
    const draft = createValidModelConfigDraft();
    const main = draft.models.find((model) => model.id === 'primary-chat');
    if (!main) throw new Error('fixture is missing primary-chat');
    main.structuredOutputProtocol = 'json_mode';

    const result = modelConfigDraftSchema.safeParse(draft);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      'main.chat requires a compatible typed schema protocol',
    );
  });

  it('reserves native JSON schema protocols for structured internal workloads', () => {
    const draft = createValidModelConfigDraft();
    const main = draft.models.find((model) => model.id === 'primary-chat');
    if (!main) throw new Error('fixture is missing primary-chat');
    main.structuredOutputProtocol = 'chat_reply_v1';

    const result = modelConfigDraftSchema.safeParse(draft);
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((issue) => issue.message);
    expect(messages).toContain(
      'memory.extract requires a compatible typed schema protocol',
    );
    expect(messages).toContain(
      'affinity.analysis requires a compatible typed schema protocol',
    );
    expect(messages).toContain(
      'sticker.index requires a compatible typed schema protocol',
    );
  });
});

describe('CanonicalModelBindingResolver', () => {
  it('resolves dedicated, inheritMain, and invocation-derived bindings explicitly', () => {
    const snapshot = structuredClone(createRuntimeSnapshot());
    const resolver = new CanonicalModelBindingResolver(snapshot);

    expect(resolver.resolve('main.chat')).toMatchObject({
      workload: 'main.chat',
      sourceWorkload: 'main.chat',
      mode: 'dedicated',
      model: 'qqbot-primary/primary-chat',
      revision: 7,
    });
    expect(resolver.resolve('affinity.analysis')).toMatchObject({
      workload: 'affinity.analysis',
      sourceWorkload: 'main.chat',
      mode: 'inheritMain',
      model: 'qqbot-primary/primary-chat',
    });
    expect(() => resolver.resolve('search.summary')).toThrowError(
      expect.objectContaining({
        code: 'binding_invalid',
        workload: 'search.summary',
      }),
    );
    expect(resolver.resolve('search.summary', {
      invocationTarget: {
        connectionId: 'primary',
        modelId: 'primary-chat',
      },
    })).toMatchObject({
      mode: 'inheritInvocation',
      model: 'qqbot-primary/primary-chat',
    });
    expect(resolver.resolveAgent('researcher', {
      invocationTarget: {
        connectionId: 'primary',
        modelId: 'primary-chat',
      },
    })).toMatchObject({
      workload: 'agent.subagent.researcher',
      mode: 'inheritInvocation',
      model: 'qqbot-primary/primary-chat',
    });
  });

  it('round-trips only the new canonical model syntax', () => {
    expect(canonicalModelName({ id: 'primary' }, { id: 'primary-chat' })).toBe(
      'qqbot-primary/primary-chat',
    );
    expect(parseCanonicalModelName('qqbot-primary/primary-chat')).toEqual({
      connectionId: 'primary',
      modelId: 'primary-chat',
    });
    for (const legacy of [
      'openai/gpt-4o',
      'primary/primary-chat',
      'qqbot-primary/PrimaryChat',
      'qqbot-primary_bad/primary-chat',
      'qqbot-primary/primary-chat/extra',
    ]) {
      expect(() => parseCanonicalModelName(legacy)).toThrowError(ModelConfigError);
    }
  });

  it('resolves model IDs within their owning connection', () => {
    const snapshot = structuredClone(createRuntimeSnapshot());
    const repairable = snapshot.models.find(
      (model) => model.connectionId === 'repairable',
    );
    if (!repairable) throw new Error('fixture is missing repairable model');
    repairable.id = 'primary-chat';
    const resolver = new CanonicalModelBindingResolver(snapshot);

    expect(resolver.resolveTarget({
      connectionId: 'primary',
      modelId: 'primary-chat',
    }).model.transportModel).toBe('provider-chat-model');
    expect(resolver.resolveTarget({
      connectionId: 'repairable',
      modelId: 'primary-chat',
    }).model.transportModel).toBe('repairable-model');
  });

  it('accepts runtime Agent IDs containing canonical namespace separators', () => {
    const draft = createValidModelConfigDraft();
    draft.bindings.push({
      workload: 'agent.subagent.builtin:plan',
      mode: 'inheritInvocation',
    });
    draft.bindings.push({
      workload: 'agent.subagent.preset:researcher',
      mode: 'inheritInvocation',
    });

    expect(modelConfigDraftSchema.safeParse(draft).success).toBe(true);
  });

  it('redacts all runtime credentials from the inspectable binding snapshot', () => {
    const snapshot = createRuntimeSnapshot();
    const redacted = redactStaticBindings(snapshot);
    expect(JSON.stringify(redacted)).not.toContain('test-api-key');
    expect(
      redacted.find((binding) => binding.workload === 'search.summary'),
    ).toMatchObject({
      mode: 'inheritInvocation',
      canonicalModel: null,
      connectionId: null,
      modelId: null,
    });
  });

  it('checks invocation-derived capabilities at request resolution time', () => {
    const snapshot = createRuntimeSnapshot();
    const resolver = new CanonicalModelBindingResolver(snapshot);
    expect(() => resolver.resolve('search.summary', {
      invocationTarget: {
        connectionId: 'primary',
        modelId: 'primary-embedding',
      },
    })).toThrowError(expect.objectContaining({
      code: 'binding_invalid',
      workload: 'search.summary',
      modelId: 'primary-embedding',
    }));

    const noToolsSnapshot = structuredClone(snapshot);
    const chat = noToolsSnapshot.models.find((model) => model.id === 'primary-chat');
    if (!chat) throw new Error('fixture is missing primary-chat');
    chat.capabilities.tools = false;
    const noToolsResolver = new CanonicalModelBindingResolver(noToolsSnapshot);
    expect(() => noToolsResolver.resolveAgent('researcher', {
      invocationTarget: {
        connectionId: 'primary',
        modelId: 'primary-chat',
      },
    })).toThrowError(expect.objectContaining({
      code: 'binding_invalid',
      workload: 'agent.subagent.default',
      modelId: 'primary-chat',
    }));
  });
});

describe('ModelRuntimeClient', () => {
  it('executes through the connection registry and validates the response boundary', async () => {
    const executor: ModelConnectionExecutor = {
      execute: vi.fn(async ({ target }) => ({
        text: target.model.transportModel,
      })),
    };
    const client = new ModelRuntimeClient(createRuntimeSnapshot(), new Map([
      ['primary', executor],
    ]));

    const result = await client.executeChat({
      workload: 'memory.extract',
      request: {
        messages: [
          { role: 'user', content: 'hello' },
        ],
        structuredOutput: {
          name: 'memory_extract',
          schema: { type: 'object' },
          strict: true,
        },
      },
    });

    expect(result).toEqual({ text: 'provider-chat-model' });
    expect(executor.execute).toHaveBeenCalledOnce();
  });

  it('fails directly for disabled workloads and unavailable managed connections', async () => {
    const client = new ModelRuntimeClient(createRuntimeSnapshot(), new Map());
    await expect(client.executeChat({
      workload: 'naturalTrigger.decision',
      request: {
        messages: [{ role: 'user', content: 'decide' }],
        structuredOutput: {
          name: 'natural_trigger_decision',
          schema: { type: 'object' },
          strict: true,
        },
      },
    })).rejects.toMatchObject({
      code: 'runtime_operation_invalid',
      workload: 'naturalTrigger.decision',
    });
    await expect(client.executeChat({
      workload: 'memory.extract',
      request: {
        messages: [{ role: 'user', content: 'extract' }],
        structuredOutput: {
          name: 'memory_extract',
          schema: { type: 'object' },
          strict: true,
        },
      },
    })).rejects.toMatchObject({
      code: 'runtime_executor_missing',
      connectionId: 'primary',
    });
  });

  it('normalizes embedding transport responses and verifies vector cardinality', async () => {
    const executor: ModelConnectionExecutor = {
      async execute(request) {
        if (request.operation === 'chat') return { text: 'unused' };
        return {
          vectors: request.payload.inputs.map((_, index) => [index, index + 1]),
        };
      },
    };
    const client = new ModelRuntimeClient(createRuntimeSnapshot(), new Map([
      ['primary', executor],
    ]));

    await expect(client.executeEmbedding({
      workload: 'memory.embedding',
      request: { inputs: ['first', 'second'] },
    })).resolves.toEqual({
      vectors: [[0, 1], [1, 2]],
    });
  });
});

describe('ModelConfigError serialization', () => {
  it('preserves typed upstream diagnostics and drops unsafe provider codes and causes', () => {
    const error = new ModelConfigError({
      code: 'upstream_failed',
      operation: 'execute',
      stage: 'transport',
      message: 'provider request failed',
      upstreamStatus: 429,
      providerCode: 'rate limit: secret-token',
      cause: new Error('secret-token'),
    });

    expect(error.toJSON()).toMatchObject({
      code: 'upstream_failed',
      operation: 'execute',
      stage: 'transport',
      upstreamStatus: 429,
      httpStatus: 502,
    });
    expect(JSON.stringify(error)).not.toContain('secret-token');
    expect(error.toJSON()).not.toHaveProperty('providerCode');
  });

  it('finds typed model diagnostics through causes without logging untyped messages', () => {
    const typed = new ModelConfigError({
      code: 'upstream_failed',
      operation: 'execute',
      stage: 'transport',
      message: 'provider request failed',
      upstreamStatus: 429,
      providerCode: 'rate_limited',
      cause: new Error('Bearer secret-token'),
    });

    expect(serializeModelConfigDiagnostic(
      new Error('wrapper secret-token', { cause: typed }),
    )).toMatchObject({
      name: 'ModelConfigError',
      operation: 'execute',
      stage: 'transport',
      upstreamStatus: 429,
      providerCode: 'rate_limited',
    });
    expect(JSON.stringify(serializeModelConfigDiagnostic(
      new Error('untyped secret-token'),
    ))).toBe('{"name":"Error"}');
  });
});

function configureBridgeConnection(
  draft: ModelConfigDraft,
  adapter: 'codexBridge' | 'copilotBridge',
): ModelDefinition {
  const connection = draft.connections.find((candidate) => candidate.id === 'repairable');
  const model = draft.models.find(
    (candidate) => candidate.connectionId === 'repairable',
  );
  if (!connection || !model) {
    throw new Error('fixture is missing repairable bridge candidates');
  }
  connection.adapter = adapter;
  connection.baseUrl = null;
  connection.auth = {
    kind: 'oauth',
    provider: adapter === 'codexBridge' ? 'codex' : 'copilot',
  };
  connection.catalogDriver = adapter;
  return model;
}

function configureAsEmbedding(model: ModelDefinition): void {
  model.modelType = 'embedding';
  model.requestMode = null;
  model.structuredOutputProtocol = null;
  model.capabilities = {
    chat: false,
    embedding: true,
    vision: false,
    tools: false,
    structuredOutput: false,
  };
  model.requestDefaults = {};
}

function createRuntimeSnapshot(): ModelRuntimeSnapshot {
  const draft = createValidModelConfigDraft();
  return Object.freeze({
    revision: 7,
    connections: Object.freeze(draft.connections.map((connection) => Object.freeze({
      ...connection,
      apiKey: connection.id === 'primary' ? 'test-api-key' : null,
    }))),
    models: Object.freeze(draft.models.map((model) => Object.freeze(model))),
    bindings: Object.freeze(draft.bindings.map((binding) => Object.freeze(binding))),
  });
}
