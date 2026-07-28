import { describe, expect, it, vi } from 'vitest';
import {
  capabilityProbeKindsForWorkload,
  modelCapabilityProbeFingerprint,
  verifyModelCapabilityProbe,
  type ModelConfigPutInput,
  type ModelConnectionExecutor,
  type ResolvedModelTarget,
} from '../../src/plugins/model-config/index.js';
import { ModelConnectionOperations } from '../../src/plugins/admin-api/model-operations.js';

describe('model capability verification', () => {
  it('uses the smallest distinct probe set for each workload contract', () => {
    const target = createTarget();
    expect(capabilityProbeKindsForWorkload('main.chat', target.model)).toEqual([
      'toolCalling',
      'nativeStructuredOutput',
    ]);
    expect(capabilityProbeKindsForWorkload('memory.extract', target.model)).toEqual([
      'nativeStructuredOutput',
    ]);
    expect(capabilityProbeKindsForWorkload('affinity.analysis', target.model)).toEqual([
      'nativeStructuredOutput',
    ]);
    expect(capabilityProbeKindsForWorkload('agent.subagent.default', target.model)).toEqual([
      'toolCalling',
    ]);
  });

  it('rejects declared structured output when the provider response violates the schema', async () => {
    const target = createTarget();
    const executor: ModelConnectionExecutor = {
      execute: vi.fn(async () => ({ text: '{"ok":false}' })),
    };

    await expect(verifyModelCapabilityProbe({
      workload: 'memory.extract',
      kind: 'nativeStructuredOutput',
      target,
      executor,
    })).rejects.toMatchObject({
      code: 'binding_invalid',
      operation: 'save',
      stage: 'validate',
      workload: 'memory.extract',
      connectionId: 'provider',
      modelId: 'chat',
      providerCode: 'capability_probe_failed',
    });
  });

  it('deduplicates successful low-cost probes by connection and model contract', async () => {
    const input = createPutInput();
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if ('tools' in body) {
        return jsonResponse({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                type: 'function',
                function: {
                  name: 'qqbot_capability_probe',
                  arguments: '{"marker":"ok"}',
                },
              }],
            },
          }],
        });
      }
      return jsonResponse({
        choices: [{ message: { content: '{"ok":true}' } }],
      });
    });
    const modelConfig = {
      getConnectionRuntime: vi.fn(() => ({
        revision: 1,
        connection: {
          ...input.draft.connections[0],
          apiKey: 'runtime-secret',
        },
        models: input.draft.models,
      })),
    };
    const unusedBridge = {
      getRuntimeConfig: vi.fn(async () => ({
        baseUrl: 'https://bridge.example.test/v1',
        apiKey: 'bridge-secret',
      })),
    };
    const operations = new ModelConnectionOperations({
      modelConfig: modelConfig as never,
      codexBridge: unusedBridge as never,
      copilotBridge: unusedBridge as never,
      fetchFn,
    });

    await operations.verifyBindings(input);
    await operations.verifyBindings(input);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const requestBodies = fetchFn.mock.calls.map(([, init]) => (
      JSON.parse(String(init?.body)) as Record<string, unknown>
    ));
    expect(requestBodies.map((body) => body.max_tokens)).toEqual([24, 16]);

    input.draft.models[0].transportModel = 'provider-chat-v2';
    await operations.verifyBindings(input);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('invalidates a cached proof when credentials change', () => {
    const target = createTarget();
    const before = modelCapabilityProbeFingerprint({
      connection: target.connection,
      model: target.model,
      kind: 'nativeStructuredOutput',
    });
    const after = modelCapabilityProbeFingerprint({
      connection: { ...target.connection, apiKey: 'rotated-secret' },
      model: target.model,
      kind: 'nativeStructuredOutput',
    });

    expect(before).not.toBe(after);
    expect(before).toMatch(/^[a-f0-9]{64}$/);
  });
});

function createPutInput(): ModelConfigPutInput {
  return {
    expectedRevision: 1,
    draft: {
      connections: [{
        id: 'provider',
        displayName: 'Provider',
        adapter: 'openaiCompatible',
        baseUrl: 'https://provider.example.test/v1',
        auth: { kind: 'apiKey', secretRef: 'provider.api-key' },
        catalogDriver: 'openaiModels',
      }],
      models: [createTarget().model],
      bindings: [
        {
          workload: 'main.chat',
          mode: 'dedicated',
          connectionId: 'provider',
          modelId: 'chat',
        },
        { workload: 'memory.extract', mode: 'disabled' },
        { workload: 'affinity.analysis', mode: 'inheritMain' },
        { workload: 'naturalTrigger.decision', mode: 'disabled' },
        { workload: 'agent.subagent.default', mode: 'inheritInvocation' },
        { workload: 'sticker.index', mode: 'disabled' },
      ],
    },
    secretOperations: [{ connectionId: 'provider', operation: 'retain' }],
  };
}

function createTarget(): ResolvedModelTarget {
  return {
    canonicalModel: 'qqbot-provider/chat',
    connection: {
      id: 'provider',
      displayName: 'Provider',
      adapter: 'openaiCompatible',
      baseUrl: 'https://provider.example.test/v1',
      auth: { kind: 'apiKey', secretRef: 'provider.api-key' },
      catalogDriver: 'openaiModels',
      apiKey: 'runtime-secret',
    },
    model: {
      id: 'chat',
      connectionId: 'provider',
      displayName: 'Chat',
      transportModel: 'provider-chat',
      contextSize: 128_000,
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'native_chat_json_schema',
      capabilities: {
        vision: false,
        tools: true,
        structuredOutput: true,
      },
      timeoutMs: 30_000,
      requestDefaults: {},
    },
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
