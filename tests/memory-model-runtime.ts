import {
  ModelRuntimeClient,
  type ModelBinding,
  type ModelConnectionExecutor,
  type ModelRuntimeSnapshot,
} from '../src/plugins/model-config/index.js';

export interface MemoryModelRuntimeOptions {
  extractMode?: 'dedicated' | 'disabled';
  embeddingMode?: 'dedicated' | 'disabled';
  extractProtocol?:
    | 'native_chat_json_schema'
    | 'native_responses_json_schema';
  executor?: ModelConnectionExecutor;
}

export function createMemoryModelRuntime(
  options: MemoryModelRuntimeOptions = {},
): {
  client: ModelRuntimeClient;
  executor: ModelConnectionExecutor;
  snapshot: ModelRuntimeSnapshot;
} {
  const extractMode = options.extractMode ?? 'dedicated';
  const embeddingMode = options.embeddingMode ?? 'dedicated';
  const extractProtocol = options.extractProtocol ?? 'native_chat_json_schema';
  const executor = options.executor ?? {
    async execute(request) {
      return request.operation === 'embedding'
        ? { vectors: request.payload.inputs.map(() => [0.1, 0.2]) }
        : { text: JSON.stringify({ facts: [], episodes: [], drops: [] }) };
    },
  };
  const bindings: ModelBinding[] = [
    extractMode === 'dedicated'
      ? {
          workload: 'memory.extract',
          mode: 'dedicated',
          connectionId: 'memory',
          modelId: 'memory-extract',
        }
      : {
          workload: 'memory.extract',
          mode: 'disabled',
        },
    embeddingMode === 'dedicated'
      ? {
          workload: 'memory.embedding',
          mode: 'dedicated',
          connectionId: 'memory',
          modelId: 'memory-embedding',
        }
      : {
          workload: 'memory.embedding',
          mode: 'disabled',
        },
  ];
  const snapshot: ModelRuntimeSnapshot = {
    revision: 9,
    connections: [{
      id: 'memory',
      displayName: 'Memory',
      adapter: 'openaiCompatible',
      baseUrl: 'https://memory.example.test/v1',
      auth: { kind: 'none' },
      catalogDriver: 'static',
      apiKey: null,
    }],
    models: [
      {
        id: 'memory-extract',
        connectionId: 'memory',
        displayName: 'Memory Extract',
        transportModel: 'provider-memory-extract',
        modelType: 'chat',
        contextSize: 65_536,
        requestMode: extractProtocol === 'native_responses_json_schema'
          ? 'responses'
          : 'chat_completions',
        structuredOutputProtocol: extractProtocol,
        capabilities: {
          chat: true,
          embedding: false,
          vision: false,
          tools: false,
          structuredOutput: true,
        },
        timeoutMs: 60_000,
        requestDefaults: {},
      },
      {
        id: 'memory-embedding',
        connectionId: 'memory',
        displayName: 'Memory Embedding',
        transportModel: 'provider-memory-embedding',
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
        timeoutMs: 30_000,
        requestDefaults: {},
      },
    ],
    bindings,
  };

  return {
    client: new ModelRuntimeClient(snapshot, new Map([['memory', executor]])),
    executor,
    snapshot,
  };
}
