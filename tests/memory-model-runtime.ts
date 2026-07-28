import {
  ModelRuntimeClient,
  type ModelBinding,
  type ModelConnectionExecutor,
  type ModelRuntimeSnapshot,
} from '../src/plugins/model-config/index.js';

export interface MemoryModelRuntimeOptions {
  extractMode?: 'dedicated' | 'disabled';
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
  const extractProtocol = options.extractProtocol ?? 'native_chat_json_schema';
  const executor = options.executor ?? {
    async execute() {
      return { text: JSON.stringify({ facts: [], episodes: [], drops: [] }) };
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
        contextSize: 65_536,
        requestMode: extractProtocol === 'native_responses_json_schema'
          ? 'responses'
          : 'chat_completions',
        structuredOutputProtocol: extractProtocol,
        capabilities: {
          vision: false,
          tools: false,
          structuredOutput: true,
        },
        timeoutMs: 60_000,
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
