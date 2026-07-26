import type {
  ModelConfigAdminAggregate,
  ModelConfigDraft,
  ModelConfigPutInput,
} from '../../../../src/admin/contracts/index.js';
import {
  AGENT_OVERRIDE_ALLOWED_MODES,
  WORKLOAD_ALLOWED_MODES,
  requiredCapabilitiesForWorkload,
  supportsWorkloadProtocol,
  type FixedModelWorkload,
  ModelBinding,
  ModelDefinition,
  ModelWorkload,
  SecretOperation,
} from '../../../../src/plugins/model-config/types.js';

export type SecretDraft = {
  operation: SecretOperation['operation'];
  value: string;
};

export type SecretDrafts = Record<string, SecretDraft>;
export type ChatRequestMode = Extract<ModelDefinition['requestMode'], string>;
export type StructuredOutputProtocol = NonNullable<ModelDefinition['structuredOutputProtocol']>;

export interface ModelPageConfigurationLoadResult {
  modelState: ModelConfigAdminAggregate | null;
  requiredError: string | null;
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

export async function loadModelPageConfiguration(
  request: Promise<ModelConfigAdminAggregate>,
): Promise<ModelPageConfigurationLoadResult> {
  try {
    return { modelState: await request, requiredError: null };
  } catch (error) {
    return {
      modelState: null,
      requiredError: errorMessage(error, '模型配置加载失败'),
    };
  }
}

export function createModelConfigDraft(
  aggregate: ModelConfigAdminAggregate,
): ModelConfigDraft {
  return structuredClone({
    connections: aggregate.connections.map((connection) => {
      const { credentialState: _credentialState, hasSecret: _hasSecret, ...definition } = connection;
      return definition;
    }),
    models: aggregate.models,
    bindings: aggregate.bindings,
  });
}

export function createSecretDrafts(
  aggregate: ModelConfigAdminAggregate,
): SecretDrafts {
  return Object.fromEntries(aggregate.connections
    .filter((connection) => connection.auth.kind === 'apiKey')
    .map((connection) => [
      connection.id,
      { operation: 'retain' as const, value: '' },
    ]));
}

function comparableValue(value: unknown): string {
  return JSON.stringify(value);
}

export function hasSecretChanges(secrets: SecretDrafts): boolean {
  return Object.values(secrets).some((secret) => secret.operation !== 'retain');
}

export function isModelDraftDirty(
  aggregate: ModelConfigAdminAggregate,
  draft: ModelConfigDraft,
  secrets: SecretDrafts,
): boolean {
  return comparableValue(createModelConfigDraft(aggregate)) !== comparableValue(draft)
    || hasSecretChanges(secrets);
}

export function isSavedConnectionOperationTarget(
  aggregate: ModelConfigAdminAggregate,
  draft: ModelConfigDraft,
  secrets: SecretDrafts,
  connectionId: string,
): boolean {
  const savedConnection = createModelConfigDraft(aggregate).connections.find(
    (connection) => connection.id === connectionId,
  );
  const draftConnection = draft.connections.find(
    (connection) => connection.id === connectionId,
  );
  if (!savedConnection || !draftConnection) return false;
  if (comparableValue(savedConnection) !== comparableValue(draftConnection)) return false;
  return secrets[connectionId]?.operation !== 'set'
    && secrets[connectionId]?.operation !== 'clear';
}

function secretOperation(
  connectionId: string,
  secret: SecretDraft | undefined,
): SecretOperation {
  if (!secret || secret.operation === 'retain') {
    return { connectionId, operation: 'retain' };
  }
  if (secret.operation === 'clear') {
    return { connectionId, operation: 'clear' };
  }
  return {
    connectionId,
    operation: 'set',
    value: secret.value,
  };
}

export function buildModelConfigPutInput(
  aggregate: ModelConfigAdminAggregate,
  draft: ModelConfigDraft,
  secrets: SecretDrafts,
): ModelConfigPutInput {
  return {
    expectedRevision: aggregate.savedRevision,
    draft: structuredClone(draft),
    secretOperations: draft.connections
      .filter((connection) => connection.auth.kind === 'apiKey')
      .map((connection) => secretOperation(connection.id, secrets[connection.id])),
  };
}

export function allowedBindingModes(
  workload: ModelWorkload,
): readonly ModelBinding['mode'][] {
  if (workload.startsWith('agent.subagent.') && workload !== 'agent.subagent.default') {
    return AGENT_OVERRIDE_ALLOWED_MODES;
  }
  return WORKLOAD_ALLOWED_MODES[workload as FixedModelWorkload];
}

export function replaceBindingMode(
  binding: ModelBinding,
  mode: ModelBinding['mode'],
): ModelBinding {
  if (!allowedBindingModes(binding.workload).includes(mode)) {
    throw new Error(`${binding.workload} 不支持 ${mode}。`);
  }
  if (mode === 'dedicated') {
    return {
      workload: binding.workload,
      mode,
      connectionId: binding.mode === 'dedicated' ? binding.connectionId : '',
      modelId: binding.mode === 'dedicated' ? binding.modelId : '',
    };
  }
  return { workload: binding.workload, mode };
}

export function isModelCompatible(
  workload: ModelWorkload,
  model: ModelDefinition,
): boolean {
  return requiredCapabilitiesForWorkload(workload)
    .every((capability) => model.capabilities[capability])
    && supportsWorkloadProtocol(workload, model);
}

export function structuredOutputProtocolsForRequestMode(
  requestMode: ChatRequestMode,
): readonly StructuredOutputProtocol[] {
  return requestMode === 'responses'
    ? ['native_responses_json_schema', 'chat_reply_v1', 'json_mode']
    : ['native_chat_json_schema', 'chat_reply_v1', 'json_mode'];
}

export function withModelRequestMode(
  model: ModelDefinition,
  requestMode: ChatRequestMode,
): ModelDefinition {
  const protocol = model.structuredOutputProtocol;
  const nextProtocol = protocol === 'native_chat_json_schema'
    || protocol === 'native_responses_json_schema'
    ? requestMode === 'responses'
      ? 'native_responses_json_schema'
      : 'native_chat_json_schema'
    : protocol;
  return {
    ...model,
    requestMode,
    structuredOutputProtocol: nextProtocol,
    capabilities: { ...model.capabilities },
    requestDefaults: { ...model.requestDefaults },
  };
}

export function withStructuredOutputProtocol(
  model: ModelDefinition,
  protocol: ModelDefinition['structuredOutputProtocol'],
): ModelDefinition {
  if (model.modelType !== 'chat' || model.requestMode === null) {
    throw new Error('只有 chat model 可以设置 structured output protocol。');
  }
  if (
    protocol !== null
    && !structuredOutputProtocolsForRequestMode(model.requestMode).includes(protocol)
  ) {
    throw new Error(`${protocol} 不适用于 ${model.requestMode}。`);
  }
  return {
    ...model,
    structuredOutputProtocol: protocol,
    capabilities: {
      ...model.capabilities,
      structuredOutput: protocol !== null,
    },
    requestDefaults: { ...model.requestDefaults },
  };
}

export function incompatibleWorkloadsForModel(
  draft: ModelConfigDraft,
  candidate: ModelDefinition,
): ModelWorkload[] {
  const mainBinding = draft.bindings.find(
    (binding) => binding.workload === 'main.chat' && binding.mode === 'dedicated',
  );
  const candidateIsMain = mainBinding?.mode === 'dedicated'
    && mainBinding.connectionId === candidate.connectionId
    && mainBinding.modelId === candidate.id;
  const workloads = draft.bindings.flatMap((binding) => {
    const directlyReferencesCandidate = binding.mode === 'dedicated'
      && binding.connectionId === candidate.connectionId
      && binding.modelId === candidate.id;
    const inheritsCandidate = binding.mode === 'inheritMain' && candidateIsMain;
    return directlyReferencesCandidate || inheritsCandidate ? [binding.workload] : [];
  });
  return [...new Set(workloads.filter(
    (workload) => !isModelCompatible(workload, candidate),
  ))];
}
