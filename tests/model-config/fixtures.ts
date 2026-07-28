import type {
  ModelConfigDraft,
  ModelDefinition,
} from '../../src/plugins/model-config/index.js';

export function createValidModelConfigDraft(): ModelConfigDraft {
  const primaryChat = createChatModel({
    id: 'primary-chat',
    connectionId: 'primary',
    displayName: 'Primary Chat',
    transportModel: 'provider-chat-model',
  });
  return {
    connections: [
      {
        id: 'primary',
        displayName: 'Primary',
        adapter: 'openaiCompatible',
        baseUrl: 'https://models.example.test/v1',
        auth: {
          kind: 'apiKey',
          secretRef: 'connection:primary:api-key',
        },
        catalogDriver: 'openaiModels',
      },
      {
        id: 'repairable',
        displayName: 'Repairable missing credential',
        adapter: 'openaiCompatible',
        baseUrl: 'https://repair.example.test/v1',
        auth: {
          kind: 'apiKey',
          secretRef: 'connection:repairable:api-key',
        },
        catalogDriver: 'static',
      },
    ],
    models: [
      primaryChat,
      createChatModel({
        id: 'repairable-chat',
        connectionId: 'repairable',
        displayName: 'Repairable Chat',
        transportModel: 'repairable-model',
      }),
    ],
    bindings: [
      {
        workload: 'main.chat',
        mode: 'dedicated',
        connectionId: 'primary',
        modelId: 'primary-chat',
      },
      {
        workload: 'memory.extract',
        mode: 'dedicated',
        connectionId: 'primary',
        modelId: 'primary-chat',
      },
      {
        workload: 'affinity.analysis',
        mode: 'inheritMain',
      },
      {
        workload: 'naturalTrigger.decision',
        mode: 'disabled',
      },
      {
        workload: 'agent.subagent.default',
        mode: 'inheritInvocation',
      },
      {
        workload: 'sticker.index',
        mode: 'dedicated',
        connectionId: 'primary',
        modelId: 'primary-chat',
      },
    ],
  };
}

export function createChatModel(
  identity: Pick<
    ModelDefinition,
    'id' | 'connectionId' | 'displayName' | 'transportModel'
  >,
): ModelDefinition {
  return {
    ...identity,
    contextSize: 131_072,
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'native_chat_json_schema',
    capabilities: {
      vision: true,
      tools: true,
      structuredOutput: true,
    },
    timeoutMs: 90_000,
    requestDefaults: {
      temperature: 0.7,
      topP: 0.95,
      maxOutputTokens: 8_192,
      reasoningEffort: 'medium',
      thinkingMode: 'disabled',
    },
  };
}
