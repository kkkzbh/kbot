import { z } from 'zod';

export const MODEL_CONFIG_SCHEMA_VERSION = 1 as const;

export const adapterTypeSchema = z.enum([
  'openaiCompatible',
  'codexBridge',
  'copilotBridge',
]);
export type AdapterType = z.infer<typeof adapterTypeSchema>;

export const catalogDriverSchema = z.enum([
  'static',
  'openaiModels',
  'codexBridge',
  'copilotBridge',
]);
export type CatalogDriver = z.infer<typeof catalogDriverSchema>;

export const connectionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'must be a canonical connection identifier');

export const modelIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, 'must be a canonical model identifier');

const secretReferenceSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9](?:[a-z0-9:._-]*[a-z0-9])?$/, 'must be a canonical secret reference');

export const connectionAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({
    kind: z.literal('apiKey'),
    secretRef: secretReferenceSchema,
  }).strict(),
  z.object({
    kind: z.literal('oauth'),
    provider: z.enum(['codex', 'copilot']),
  }).strict(),
]);
export type ConnectionAuth = z.infer<typeof connectionAuthSchema>;

const connectionDefinitionShape = {
  id: connectionIdSchema,
  displayName: z.string().trim().min(1).max(120),
  adapter: adapterTypeSchema,
  baseUrl: z.string().url().nullable(),
  auth: connectionAuthSchema,
  catalogDriver: catalogDriverSchema,
};

const connectionDefinitionObjectSchema = z.object(connectionDefinitionShape).strict();

export const connectionDefinitionSchema = connectionDefinitionObjectSchema.superRefine(
  validateConnectionDefinition,
);
export type ConnectionDefinition = z.infer<typeof connectionDefinitionSchema>;

function validateConnectionDefinition(
  connection: z.infer<typeof connectionDefinitionObjectSchema>,
  context: z.RefinementCtx,
): void {
  if (connection.adapter === 'openaiCompatible') {
    if (connection.baseUrl === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrl'],
        message: 'openaiCompatible connections require baseUrl',
      });
    }
    if (connection.catalogDriver !== 'static' && connection.catalogDriver !== 'openaiModels') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['catalogDriver'],
        message: 'openaiCompatible connections require static or openaiModels catalogDriver',
      });
    }
    if (connection.auth.kind === 'oauth') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['auth'],
        message: 'openaiCompatible connections do not support bridge OAuth references',
      });
    }
    if (connection.baseUrl !== null) {
      let baseUrl: URL;
      try {
        baseUrl = new URL(connection.baseUrl);
      } catch {
        return;
      }
      if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['baseUrl'],
          message: 'baseUrl must use http or https',
        });
      }
      if (
        baseUrl.username.length > 0
        || baseUrl.password.length > 0
        || baseUrl.search.length > 0
        || baseUrl.hash.length > 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['baseUrl'],
          message: 'baseUrl cannot contain credentials, query parameters, or fragments',
        });
      }
    }
    return;
  }

  const expectedProvider = connection.adapter === 'codexBridge' ? 'codex' : 'copilot';
  const expectedCatalog = connection.adapter === 'codexBridge' ? 'codexBridge' : 'copilotBridge';
  if (connection.baseUrl !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['baseUrl'],
      message: `${connection.adapter} connections obtain their endpoint from the bridge`,
    });
  }
  if (connection.auth.kind !== 'oauth' || connection.auth.provider !== expectedProvider) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['auth'],
      message: `${connection.adapter} connections require ${expectedProvider} OAuth`,
    });
  }
  if (connection.catalogDriver !== expectedCatalog) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['catalogDriver'],
      message: `${connection.adapter} connections require ${expectedCatalog} catalogDriver`,
    });
  }
}

export const modelCapabilitiesSchema = z.object({
  chat: z.boolean(),
  embedding: z.boolean(),
  vision: z.boolean(),
  tools: z.boolean(),
  structuredOutput: z.boolean(),
}).strict();
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

export const requestDefaultsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  reasoningEffort: z.enum([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
  ]).optional(),
  thinkingMode: z.enum(['enabled', 'disabled']).optional(),
}).strict();
export type RequestDefaults = z.infer<typeof requestDefaultsSchema>;

export const modelDefinitionSchema = z.object({
  id: modelIdSchema,
  connectionId: connectionIdSchema,
  displayName: z.string().trim().min(1).max(160),
  transportModel: z.string().trim().min(1).max(240),
  modelType: z.enum(['chat', 'embedding']),
  contextSize: z.number().int().positive(),
  requestMode: z.enum(['chat_completions', 'responses']).nullable(),
  structuredOutputProtocol: z.enum([
    'native_chat_json_schema',
    'native_responses_json_schema',
    'chat_reply_v1',
    'json_mode',
  ]).nullable(),
  capabilities: modelCapabilitiesSchema,
  timeoutMs: z.number().int().min(1_000).max(600_000),
  requestDefaults: requestDefaultsSchema,
}).strict().superRefine((model, context) => {
  if (model.modelType === 'embedding') {
    if (!model.capabilities.embedding) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities', 'embedding'],
        message: 'embedding models require embedding capability',
      });
    }
    for (const capability of ['chat', 'vision', 'tools', 'structuredOutput'] as const) {
      if (model.capabilities[capability]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['capabilities', capability],
          message: `embedding models cannot declare ${capability} capability`,
        });
      }
    }
    if (model.requestMode !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestMode'],
        message: 'embedding models do not use a chat request mode',
      });
    }
    if (model.structuredOutputProtocol !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['structuredOutputProtocol'],
        message: 'embedding models do not use a structured output protocol',
      });
    }
    return;
  }

  if (!model.capabilities.chat) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capabilities', 'chat'],
      message: 'chat models require chat capability',
    });
  }
  if (model.capabilities.embedding) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capabilities', 'embedding'],
      message: 'chat model profiles cannot also be embedding profiles',
    });
  }
  if (model.requestMode === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requestMode'],
      message: 'chat models require requestMode',
    });
  }
  if (model.capabilities.structuredOutput !== (model.structuredOutputProtocol !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['structuredOutputProtocol'],
      message: 'structuredOutput capability and structuredOutputProtocol must agree',
    });
  }
  if (
    model.structuredOutputProtocol === 'native_chat_json_schema'
    && model.requestMode !== 'chat_completions'
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['structuredOutputProtocol'],
      message: 'native_chat_json_schema requires chat_completions requestMode',
    });
  }
  if (
    model.structuredOutputProtocol === 'native_responses_json_schema'
    && model.requestMode !== 'responses'
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['structuredOutputProtocol'],
      message: 'native_responses_json_schema requires responses requestMode',
    });
  }
});
export type ModelDefinition = z.infer<typeof modelDefinitionSchema>;

export const FIXED_MODEL_WORKLOADS = [
  'main.chat',
  'memory.extract',
  'memory.embedding',
  'affinity.analysis',
  'naturalTrigger.decision',
  'search.summary',
  'chatluna.defaultEmbedding',
  'agent.subagent.default',
  'sticker.index',
] as const;

export const fixedModelWorkloadSchema = z.enum(FIXED_MODEL_WORKLOADS);
export type FixedModelWorkload = z.infer<typeof fixedModelWorkloadSchema>;

const agentOverrideWorkloadSchema = z
  .string()
  .regex(
    /^agent\.subagent\.[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$/,
    'must be agent.subagent.<canonical-agent-id>',
  )
  .refine((value) => value !== 'agent.subagent.default', {
    message: 'agent.subagent.default is the fixed default workload',
  });

export const modelWorkloadSchema = z.union([
  fixedModelWorkloadSchema,
  agentOverrideWorkloadSchema,
]);
export type ModelWorkload = z.infer<typeof modelWorkloadSchema>;

export const dedicatedModelBindingSchema = z.object({
  workload: modelWorkloadSchema,
  mode: z.literal('dedicated'),
  connectionId: connectionIdSchema,
  modelId: modelIdSchema,
}).strict();

export const disabledModelBindingSchema = z.object({
  workload: modelWorkloadSchema,
  mode: z.literal('disabled'),
}).strict();

export const inheritMainModelBindingSchema = z.object({
  workload: modelWorkloadSchema,
  mode: z.literal('inheritMain'),
}).strict();

export const inheritInvocationModelBindingSchema = z.object({
  workload: modelWorkloadSchema,
  mode: z.literal('inheritInvocation'),
}).strict();

export const modelBindingSchema = z.discriminatedUnion('mode', [
  dedicatedModelBindingSchema,
  disabledModelBindingSchema,
  inheritMainModelBindingSchema,
  inheritInvocationModelBindingSchema,
]);
export type ModelBinding = z.infer<typeof modelBindingSchema>;

export const WORKLOAD_ALLOWED_MODES = {
  'main.chat': ['dedicated'],
  'memory.extract': ['dedicated', 'disabled'],
  'memory.embedding': ['dedicated', 'disabled'],
  'affinity.analysis': ['inheritMain', 'dedicated'],
  'naturalTrigger.decision': ['dedicated', 'disabled'],
  'search.summary': ['inheritInvocation', 'dedicated'],
  'chatluna.defaultEmbedding': ['dedicated', 'disabled'],
  'agent.subagent.default': ['inheritInvocation', 'dedicated'],
  'sticker.index': ['dedicated', 'disabled'],
} as const satisfies Record<FixedModelWorkload, readonly ModelBinding['mode'][]>;

export const AGENT_OVERRIDE_ALLOWED_MODES = [
  'inheritInvocation',
  'dedicated',
] as const satisfies readonly ModelBinding['mode'][];

const REQUIRED_CAPABILITIES: Record<
  FixedModelWorkload | 'agent.subagent.override',
  readonly (keyof ModelCapabilities)[]
> = {
  'main.chat': ['chat', 'tools', 'structuredOutput'],
  'memory.extract': ['chat', 'structuredOutput'],
  'memory.embedding': ['embedding'],
  'affinity.analysis': ['chat', 'structuredOutput'],
  'naturalTrigger.decision': ['chat', 'structuredOutput'],
  'search.summary': ['chat'],
  'chatluna.defaultEmbedding': ['embedding'],
  'agent.subagent.default': ['chat', 'tools'],
  'agent.subagent.override': ['chat', 'tools'],
  'sticker.index': ['chat', 'vision', 'structuredOutput'],
};

export function requiredCapabilitiesForWorkload(
  workload: ModelWorkload,
): readonly (keyof ModelCapabilities)[] {
  return workload.startsWith('agent.subagent.') && workload !== 'agent.subagent.default'
    ? REQUIRED_CAPABILITIES['agent.subagent.override']
    : REQUIRED_CAPABILITIES[workload as FixedModelWorkload];
}

const NATIVE_SCHEMA_WORKLOADS = new Set<ModelWorkload>([
  'memory.extract',
  'affinity.analysis',
  'naturalTrigger.decision',
  'sticker.index',
]);

export function workloadRequiresNativeStructuredOutput(
  workload: ModelWorkload,
): boolean {
  return NATIVE_SCHEMA_WORKLOADS.has(workload);
}

export function supportsWorkloadProtocol(
  workload: ModelWorkload,
  model: ModelDefinition,
): boolean {
  if (workload === 'main.chat') {
    return model.structuredOutputProtocol === 'native_chat_json_schema'
      || model.structuredOutputProtocol === 'native_responses_json_schema'
      || model.structuredOutputProtocol === 'chat_reply_v1';
  }
  if (workloadRequiresNativeStructuredOutput(workload)) {
    return model.structuredOutputProtocol === 'native_chat_json_schema'
      || model.structuredOutputProtocol === 'native_responses_json_schema';
  }
  return true;
}

export const modelConfigDraftSchema = z.object({
  connections: z.array(connectionDefinitionSchema),
  models: z.array(modelDefinitionSchema),
  bindings: z.array(modelBindingSchema),
}).strict().superRefine((draft, context) => {
  const connectionIndexes = uniqueIndexes(draft.connections.map((connection) => connection.id));
  for (const duplicate of connectionIndexes.duplicates) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['connections', duplicate.index, 'id'],
      message: `duplicate connection id: ${duplicate.value}`,
    });
  }

  const secretRefIndexes = uniqueIndexes(
    draft.connections.flatMap((connection, index) => (
      connection.auth.kind === 'apiKey'
        ? [{ value: connection.auth.secretRef, index }]
        : []
    )),
  );
  for (const duplicate of secretRefIndexes.duplicates) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['connections', duplicate.index, 'auth', 'secretRef'],
      message: `duplicate secret reference: ${duplicate.value}`,
    });
  }

  const modelIndexes = uniqueIndexes(
    draft.models.map((model) => modelIdentity(model.connectionId, model.id)),
  );
  for (const duplicate of modelIndexes.duplicates) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['models', duplicate.index, 'id'],
      message: `duplicate model identity: ${duplicate.value}`,
    });
  }

  const connectionIds = new Set(connectionIndexes.values);
  for (const [index, model] of draft.models.entries()) {
    const connection = draft.connections.find(
      (candidate) => candidate.id === model.connectionId,
    );
    if (!connectionIds.has(model.connectionId) || !connection) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', index, 'connectionId'],
        message: `model references missing connection: ${model.connectionId}`,
      });
      continue;
    }
    if (connection.adapter === 'codexBridge') {
      if (model.modelType !== 'chat') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models', index, 'modelType'],
          message: 'codexBridge only supports chat model profiles',
        });
      }
      if (model.requestMode !== 'responses') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models', index, 'requestMode'],
          message: 'codexBridge chat model profiles require responses requestMode',
        });
      }
    }
    if (connection.adapter === 'copilotBridge' && model.modelType !== 'chat') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', index, 'modelType'],
        message: 'copilotBridge only supports chat model profiles',
      });
    }
  }

  const bindingIndexes = uniqueIndexes(draft.bindings.map((binding) => binding.workload));
  for (const duplicate of bindingIndexes.duplicates) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bindings', duplicate.index, 'workload'],
      message: `duplicate workload binding: ${duplicate.value}`,
    });
  }

  const bindingWorkloads = new Set(bindingIndexes.values);
  for (const workload of FIXED_MODEL_WORKLOADS) {
    if (!bindingWorkloads.has(workload)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bindings'],
        message: `missing required workload binding: ${workload}`,
      });
    }
  }

  const connectionsById = new Map(draft.connections.map((connection) => [connection.id, connection]));
  const modelsByIdentity = new Map(
    draft.models.map((model) => [
      modelIdentity(model.connectionId, model.id),
      model,
    ]),
  );
  const mainBinding = draft.bindings.find(
    (binding) => binding.workload === 'main.chat' && binding.mode === 'dedicated',
  );
  const mainModel = mainBinding?.mode === 'dedicated'
    ? modelsByIdentity.get(
        modelIdentity(mainBinding.connectionId, mainBinding.modelId),
      )
    : undefined;
  for (const [index, binding] of draft.bindings.entries()) {
    const allowedModes = binding.workload.startsWith('agent.subagent.')
      && binding.workload !== 'agent.subagent.default'
      ? AGENT_OVERRIDE_ALLOWED_MODES
      : WORKLOAD_ALLOWED_MODES[binding.workload as FixedModelWorkload];
    if (!(allowedModes as readonly string[]).includes(binding.mode)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bindings', index, 'mode'],
        message: `${binding.mode} is not allowed for ${binding.workload}`,
      });
    }
    if (binding.mode !== 'dedicated' && binding.mode !== 'inheritMain') continue;

    let model: ModelDefinition | undefined;
    if (binding.mode === 'dedicated') {
      const connection = connectionsById.get(binding.connectionId);
      model = modelsByIdentity.get(
        modelIdentity(binding.connectionId, binding.modelId),
      );
      if (!connection) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bindings', index, 'connectionId'],
          message: `binding references missing connection: ${binding.connectionId}`,
        });
      }
      if (!model) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bindings', index, 'modelId'],
          message: `binding references missing model: ${binding.connectionId}/${binding.modelId}`,
        });
        continue;
      }
    } else {
      model = mainModel;
    }
    if (!model) continue;
    for (const capability of requiredCapabilitiesForWorkload(binding.workload)) {
      if (!model.capabilities[capability]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bindings', index, 'modelId'],
          message: `${binding.workload} requires ${capability} capability`,
        });
      }
    }
    if (!supportsWorkloadProtocol(binding.workload, model)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bindings', index, 'modelId'],
        message: `${binding.workload} requires a compatible typed schema protocol`,
      });
    }
  }
});
export type ModelConfigDraft = z.infer<typeof modelConfigDraftSchema>;

export const modelConfigMigrationSchema = z.object({
  completedAt: z.string().datetime(),
  sourceVersion: z.string().trim().min(1).max(120),
  reportHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ModelConfigMigration = z.infer<typeof modelConfigMigrationSchema>;

export const encryptedModelSecretSchema = z.object({
  secretRef: secretReferenceSchema,
  connectionId: connectionIdSchema,
  cipherText: z.string().min(1),
  meta: z.string().min(1),
}).strict();
export type EncryptedModelSecret = z.infer<typeof encryptedModelSecretSchema>;

export const modelConfigDocumentSchema = z.object({
  schemaVersion: z.literal(MODEL_CONFIG_SCHEMA_VERSION),
  savedRevision: z.number().int().positive(),
  appliedRevision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  migration: modelConfigMigrationSchema.nullable(),
  connections: z.array(connectionDefinitionSchema),
  models: z.array(modelDefinitionSchema),
  bindings: z.array(modelBindingSchema),
  secrets: z.array(encryptedModelSecretSchema),
}).strict().superRefine((document, context) => {
  if (document.appliedRevision > document.savedRevision) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['appliedRevision'],
      message: 'appliedRevision cannot exceed savedRevision',
    });
  }
  const draftResult = modelConfigDraftSchema.safeParse({
    connections: document.connections,
    models: document.models,
    bindings: document.bindings,
  });
  if (!draftResult.success) {
    for (const issue of draftResult.error.issues) {
      context.addIssue(issue);
    }
  }

  const connectionById = new Map(document.connections.map((connection) => [connection.id, connection]));
  const secretRefs = new Set<string>();
  for (const [index, secret] of document.secrets.entries()) {
    if (secretRefs.has(secret.secretRef)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['secrets', index, 'secretRef'],
        message: `duplicate encrypted secret: ${secret.secretRef}`,
      });
    }
    secretRefs.add(secret.secretRef);
    const connection = connectionById.get(secret.connectionId);
    if (!connection) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['secrets', index, 'connectionId'],
        message: `secret references missing connection: ${secret.connectionId}`,
      });
    } else if (connection.auth.kind !== 'apiKey' || connection.auth.secretRef !== secret.secretRef) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['secrets', index, 'secretRef'],
        message: `secret ${secret.secretRef} is not the auth reference for ${secret.connectionId}`,
      });
    }
  }
});
export type ModelConfigDocument = z.infer<typeof modelConfigDocumentSchema>;

function modelIdentity(connectionId: string, modelId: string): string {
  return `${connectionId}/${modelId}`;
}

export const secretOperationSchema = z.discriminatedUnion('operation', [
  z.object({
    connectionId: connectionIdSchema,
    operation: z.literal('retain'),
  }).strict(),
  z.object({
    connectionId: connectionIdSchema,
    operation: z.literal('set'),
    value: z.string().trim().min(1).max(65_536),
  }).strict(),
  z.object({
    connectionId: connectionIdSchema,
    operation: z.literal('clear'),
  }).strict(),
]);
export type SecretOperation = z.infer<typeof secretOperationSchema>;

export const modelConfigPutSchema = z.object({
  expectedRevision: z.number().int().positive(),
  draft: modelConfigDraftSchema,
  secretOperations: z.array(secretOperationSchema),
}).strict();
export type ModelConfigPutInput = z.infer<typeof modelConfigPutSchema>;

export const redactedConnectionSchema = z.object({
  ...connectionDefinitionShape,
  credentialState: z.enum(['configured', 'missing', 'external']),
  hasSecret: z.boolean(),
}).strict().superRefine(validateConnectionDefinition);
export type RedactedConnection = z.infer<typeof redactedConnectionSchema>;

export const redactedResolvedBindingSchema = z.object({
  workload: modelWorkloadSchema,
  sourceWorkload: modelWorkloadSchema,
  mode: z.enum(['dedicated', 'disabled', 'inheritMain', 'inheritInvocation']),
  revision: z.number().int().positive(),
  canonicalModel: z.string().nullable(),
  connectionId: connectionIdSchema.nullable(),
  modelId: modelIdSchema.nullable(),
}).strict();
export type RedactedResolvedBinding = z.infer<typeof redactedResolvedBindingSchema>;

export const modelConfigAggregateSchema = z.object({
  schemaVersion: z.literal(MODEL_CONFIG_SCHEMA_VERSION),
  savedRevision: z.number().int().positive(),
  appliedRevision: z.number().int().nonnegative(),
  pending: z.boolean(),
  pendingReason: z.literal('saved_revision_not_applied').nullable(),
  updatedAt: z.string().datetime(),
  migration: modelConfigMigrationSchema.nullable(),
  connections: z.array(redactedConnectionSchema),
  models: z.array(modelDefinitionSchema),
  bindings: z.array(modelBindingSchema),
  liveBindings: z.array(redactedResolvedBindingSchema),
}).strict();
export type ModelConfigAggregate = z.infer<typeof modelConfigAggregateSchema>;

export interface RuntimeConnection extends ConnectionDefinition {
  apiKey: string | null;
}

export interface ModelRuntimeSnapshot {
  readonly revision: number;
  readonly connections: readonly RuntimeConnection[];
  readonly models: readonly ModelDefinition[];
  readonly bindings: readonly ModelBinding[];
}

export interface RedactedModelRuntimeSnapshot {
  readonly revision: number;
  readonly connections: readonly RedactedConnection[];
  readonly models: readonly ModelDefinition[];
  readonly bindings: readonly ModelBinding[];
  readonly resolvedBindings: readonly RedactedResolvedBinding[];
}

export interface ConnectionRuntimeView {
  readonly revision: number;
  readonly connection: RuntimeConnection;
  readonly models: readonly ModelDefinition[];
}

function uniqueIndexes(values: readonly string[] | readonly { value: string; index: number }[]): {
  values: string[];
  duplicates: Array<{ value: string; index: number }>;
} {
  const seen = new Set<string>();
  const output: string[] = [];
  const duplicates: Array<{ value: string; index: number }> = [];
  for (const [position, entry] of values.entries()) {
    const value = typeof entry === 'string' ? entry : entry.value;
    const index = typeof entry === 'string' ? position : entry.index;
    if (seen.has(value)) {
      duplicates.push({ value, index });
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return { values: output, duplicates };
}
