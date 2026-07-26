import {
  CanonicalModelBindingResolver,
  ModelRuntimeClient,
  type ModelBinding,
  type ModelConfigService,
  type ModelConnectionExecutor,
  type ModelDefinition,
  type ModelRuntimeSnapshot,
  type ResolvedModelTarget,
} from '../src/plugins/model-config/index.js';

export interface TestModelRuntimeOptions {
  revision?: number;
  mainRequestMode?: 'chat_completions' | 'responses';
  mainProtocol?:
    | 'native_chat_json_schema'
    | 'native_responses_json_schema'
    | 'chat_reply_v1'
    | null;
  mainStructuredOutput?: boolean;
  mainRequestDefaults?: ModelDefinition['requestDefaults'];
  affinityMode?: 'inheritMain' | 'dedicated';
  naturalTriggerMode?: 'dedicated' | 'disabled';
  executor?: ModelConnectionExecutor;
}

export interface TestModelRuntime {
  snapshot: ModelRuntimeSnapshot;
  modelConfig: ModelConfigService;
  modelRuntime: ModelRuntimeClient;
  executor: ModelConnectionExecutor;
  mainTarget: ResolvedModelTarget;
}

export function createTestModelRuntime(
  options: TestModelRuntimeOptions = {},
): TestModelRuntime {
  const mainRequestMode = options.mainRequestMode ?? 'chat_completions';
  const mainProtocol = options.mainProtocol === undefined
    ? (mainRequestMode === 'responses'
      ? 'native_responses_json_schema'
      : 'native_chat_json_schema')
    : options.mainProtocol;
  const mainStructuredOutput = options.mainStructuredOutput
    ?? mainProtocol !== null;
  const executor = options.executor ?? {
    async execute(request) {
      if (request.operation === 'embedding') {
        return { vectors: request.payload.inputs.map(() => [0.1, 0.2]) };
      }
      if (request.target.model.id === 'natural-trigger') {
        return { text: JSON.stringify({ trigger: false, confidence: 0 }) };
      }
      if (request.target.model.id === 'affinity-analysis') {
        return {
          text: JSON.stringify({
            route: 'ignore',
            eventType: 'none',
            effectTier: 'ignore',
            category: 'none',
            confidence: 0,
            risk: 'none',
            evidence: null,
            replyHint: null,
            reasonCode: 'test_ignore',
          }),
        };
      }
      return { text: '{}' };
    },
  };
  const bindings: ModelBinding[] = [
    {
      workload: 'main.chat',
      mode: 'dedicated',
      connectionId: 'primary',
      modelId: 'main-chat',
    },
    options.affinityMode === 'dedicated'
      ? {
          workload: 'affinity.analysis',
          mode: 'dedicated',
          connectionId: 'primary',
          modelId: 'affinity-analysis',
        }
      : {
          workload: 'affinity.analysis',
          mode: 'inheritMain',
        },
    options.naturalTriggerMode === 'disabled'
      ? {
          workload: 'naturalTrigger.decision',
          mode: 'disabled',
        }
      : {
          workload: 'naturalTrigger.decision',
          mode: 'dedicated',
          connectionId: 'primary',
          modelId: 'natural-trigger',
        },
  ];
  const snapshot: ModelRuntimeSnapshot = {
    revision: options.revision ?? 7,
    connections: [{
      id: 'primary',
      displayName: 'Primary',
      adapter: 'openaiCompatible',
      baseUrl: 'https://models.example.test/v1',
      auth: { kind: 'none' },
      catalogDriver: 'static',
      apiKey: null,
    }],
    models: [
      {
        id: 'main-chat',
        connectionId: 'primary',
        displayName: 'Main Chat',
        transportModel: 'provider-main-chat',
        modelType: 'chat',
        contextSize: 131_072,
        requestMode: mainRequestMode,
        structuredOutputProtocol: mainProtocol,
        capabilities: {
          chat: true,
          embedding: false,
          vision: true,
          tools: true,
          structuredOutput: mainStructuredOutput,
        },
        timeoutMs: 90_000,
        requestDefaults: options.mainRequestDefaults ?? {},
      },
      {
        id: 'affinity-analysis',
        connectionId: 'primary',
        displayName: 'Affinity Analysis',
        transportModel: 'provider-affinity-analysis',
        modelType: 'chat',
        contextSize: 32_768,
        requestMode: 'chat_completions',
        structuredOutputProtocol: 'native_chat_json_schema',
        capabilities: {
          chat: true,
          embedding: false,
          vision: false,
          tools: false,
          structuredOutput: mainStructuredOutput,
        },
        timeoutMs: 30_000,
        requestDefaults: {},
      },
      {
        id: 'alternate-chat',
        connectionId: 'primary',
        displayName: 'Alternate Chat',
        transportModel: 'provider-alternate-chat',
        modelType: 'chat',
        contextSize: 65_536,
        requestMode: mainRequestMode,
        structuredOutputProtocol: mainProtocol,
        capabilities: {
          chat: true,
          embedding: false,
          vision: true,
          tools: true,
          structuredOutput: true,
        },
        timeoutMs: 90_000,
        requestDefaults: options.mainRequestDefaults ?? {},
      },
      {
        id: 'natural-trigger',
        connectionId: 'primary',
        displayName: 'Natural Trigger',
        transportModel: 'provider-natural-trigger',
        modelType: 'chat',
        contextSize: 16_384,
        requestMode: 'chat_completions',
        structuredOutputProtocol: 'native_chat_json_schema',
        capabilities: {
          chat: true,
          embedding: false,
          vision: false,
          tools: false,
          structuredOutput: true,
        },
        timeoutMs: 15_000,
        requestDefaults: {},
      },
    ],
    bindings,
  };
  const modelRuntime = new ModelRuntimeClient(
    snapshot,
    new Map([['primary', executor]]),
  );
  const mainTarget = new CanonicalModelBindingResolver(snapshot)
    .resolve('main.chat')
    .target;
  if (!mainTarget) throw new Error('test main.chat binding is invalid.');

  return {
    snapshot,
    modelConfig: {
      getRuntimeSnapshot: () => snapshot,
    } as ModelConfigService,
    modelRuntime,
    executor,
    mainTarget,
  };
}
