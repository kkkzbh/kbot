import { chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import {
  decryptEnvelopeJson,
  encryptEnvelopeJson,
  loadOrCreateKek,
  type CredentialKek,
} from '../shared/credential-crypto.js';
import { ModelConfigError, asModelConfigError } from './errors.js';
import { redactStaticBindings } from './resolver.js';
import {
  assertModelConfigDoesNotExist,
  readModelConfigDocument,
  writeModelConfigDocumentAtomic,
} from './store.js';
import {
  MODEL_CONFIG_SCHEMA_VERSION,
  modelConfigDraftSchema,
  modelConfigDocumentSchema,
  modelConfigPutSchema,
  type ConnectionDefinition,
  type ConnectionRuntimeView,
  type EncryptedModelSecret,
  type ModelConfigAggregate,
  type ModelConfigDocument,
  type ModelConfigDraft,
  type ModelConfigMigration,
  type ModelConfigPutInput,
  type ModelRuntimeSnapshot,
  type RedactedConnection,
  type RedactedModelRuntimeSnapshot,
  type RuntimeConnection,
  type SecretOperation,
} from './types.js';

export const MODEL_CONFIG_PATH_ENV = 'QQBOT_MODEL_CONFIG_PATH';
export const MODEL_CONFIG_KEK_PATH_ENV = 'QQBOT_MODEL_CONFIG_KEK_PATH';
export const DEFAULT_MODEL_CONFIG_PATH = '/opt/qqbot/data/model-config.json';
export const DEFAULT_MODEL_CONFIG_KEK_PATH = '/opt/qqbot/shared/model-config.kek';

export interface ModelConfigServiceOptions {
  configPath: string;
  kekPath: string;
  now?: () => Date;
}

export interface CreateInitialModelConfigInput {
  draft: ModelConfigDraft;
  apiKeys?: Readonly<Record<string, string>>;
  migration?: ModelConfigMigration | null;
}

export interface ModelConfigApplyReservation {
  readonly savedRevision: number;
  readonly appliedRevision: number;
  release(): Promise<void>;
}

export class ModelConfigService {
  readonly configPath: string;
  readonly kekPath: string;
  private readonly now: () => Date;
  private document: ModelConfigDocument | null = null;
  private runtimeSnapshot: ModelRuntimeSnapshot | null = null;
  private kek: CredentialKek | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private applyReservation: {
    revision: number;
    token: symbol;
  } | null = null;

  constructor(options: ModelConfigServiceOptions) {
    this.configPath = resolve(options.configPath);
    this.kekPath = resolve(options.kekPath);
    this.now = options.now ?? (() => new Date());
  }

  static fromEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
    options: Pick<ModelConfigServiceOptions, 'now'> = {},
  ): ModelConfigService {
    return new ModelConfigService({
      configPath: environment[MODEL_CONFIG_PATH_ENV] ?? DEFAULT_MODEL_CONFIG_PATH,
      kekPath: environment[MODEL_CONFIG_KEK_PATH_ENV] ?? DEFAULT_MODEL_CONFIG_KEK_PATH,
      now: options.now,
    });
  }

  async loadAndApply(
    publish: (snapshot: ModelRuntimeSnapshot) => Promise<void> | void,
  ): Promise<ModelRuntimeSnapshot> {
    return this.runMutation(async () => {
      const document = await readModelConfigDocument(this.configPath, 'apply');
      const kek = await this.loadKek('apply');
      const snapshot = this.compileSnapshot(document, kek, 'apply');
      try {
        await publish(snapshot);
      } catch (error) {
        throw asModelConfigError(error, {
          code: 'publish_failed',
          operation: 'apply',
          stage: 'publish',
          path: this.configPath,
          message: `failed to publish model runtime revision ${snapshot.revision}`,
        });
      }
      const appliedDocument = document.appliedRevision === document.savedRevision
        ? document
        : modelConfigDocumentSchema.parse({
            ...document,
            appliedRevision: document.savedRevision,
          });

      if (appliedDocument !== document) {
        await writeModelConfigDocumentAtomic(this.configPath, appliedDocument, 'apply');
      }

      this.document = deepFreezeClone(appliedDocument);
      this.runtimeSnapshot = snapshot;
      this.kek = kek;
      return snapshot;
    });
  }

  async createInitial(input: CreateInitialModelConfigInput): Promise<ModelRuntimeSnapshot> {
    return this.runMutation(async () => {
      await assertModelConfigDoesNotExist(this.configPath);
      const draft = parseDraft(input.draft, 'initialize');
      const kek = await this.loadKek('initialize');
      const secrets = this.encryptInitialSecrets(draft, input.apiKeys ?? {}, kek);
      const now = this.now().toISOString();
      const document = parseDocument({
        schemaVersion: MODEL_CONFIG_SCHEMA_VERSION,
        savedRevision: 1,
        appliedRevision: 0,
        updatedAt: now,
        migration: input.migration ?? null,
        ...draft,
        secrets,
      }, 'initialize');
      const snapshot = this.compileSnapshot(document, kek, 'initialize');

      await writeModelConfigDocumentAtomic(this.configPath, document, 'initialize');
      return snapshot;
    });
  }

  getAggregate(): ModelConfigAggregate {
    const document = this.requireDocument();
    const snapshot = this.requireRuntimeSnapshot();
    const encryptedSecretRefs = new Set(
      document.secrets.map((secret) => secret.secretRef),
    );
    return {
      schemaVersion: MODEL_CONFIG_SCHEMA_VERSION,
      savedRevision: document.savedRevision,
      appliedRevision: document.appliedRevision,
      pending: document.savedRevision !== document.appliedRevision,
      pendingReason: document.savedRevision !== document.appliedRevision
        ? 'saved_revision_not_applied'
        : null,
      updatedAt: document.updatedAt,
      migration: document.migration,
      connections: document.connections.map((connection) => (
        redactConnection(connection, encryptedSecretRefs)
      )),
      models: document.models.map((model) => deepFreezeClone(model)),
      bindings: document.bindings.map((binding) => deepFreezeClone(binding)),
      liveBindings: redactStaticBindings(snapshot),
    };
  }

  async put(input: ModelConfigPutInput): Promise<ModelConfigAggregate> {
    return this.runMutation(async () => {
      const request = parsePutInput(input);
      if (this.applyReservation) {
        throw new ModelConfigError({
          code: 'apply_in_progress',
          operation: 'save',
          stage: 'compare',
          path: this.configPath,
          expectedRevision: request.expectedRevision,
          actualRevision: this.applyReservation.revision,
          message: `model config revision ${this.applyReservation.revision} is reserved for apply`,
        });
      }
      const loadedDocument = await readModelConfigDocument(this.configPath, 'save');
      const runtimeSnapshot = this.requireRuntimeSnapshot();
      if (request.expectedRevision !== loadedDocument.savedRevision) {
        throw new ModelConfigError({
          code: 'revision_conflict',
          operation: 'save',
          stage: 'compare',
          path: this.configPath,
          expectedRevision: request.expectedRevision,
          actualRevision: loadedDocument.savedRevision,
          message: `model config revision conflict: expected ${request.expectedRevision}, actual ${loadedDocument.savedRevision}`,
        });
      }
      if (runtimeSnapshot.revision !== loadedDocument.appliedRevision) {
        throw new ModelConfigError({
          code: 'revision_conflict',
          operation: 'save',
          stage: 'compare',
          path: this.configPath,
          expectedRevision: runtimeSnapshot.revision,
          actualRevision: loadedDocument.appliedRevision,
          message: 'model config applied revision changed outside the running owner',
        });
      }

      assertStableIdentities(loadedDocument, request.draft);
      const kek = this.kek ?? await this.loadKek('save');
      const secrets = this.applySecretOperations(
        loadedDocument,
        request.draft,
        request.secretOperations,
        kek,
      );
      const nextDocument = parseDocument({
        schemaVersion: MODEL_CONFIG_SCHEMA_VERSION,
        savedRevision: loadedDocument.savedRevision + 1,
        appliedRevision: loadedDocument.appliedRevision,
        updatedAt: this.now().toISOString(),
        migration: loadedDocument.migration,
        ...request.draft,
        secrets,
      }, 'save');

      this.compileSnapshot(nextDocument, kek, 'save');
      await writeModelConfigDocumentAtomic(this.configPath, nextDocument);
      this.document = deepFreezeClone(nextDocument);
      this.kek = kek;
      return this.getAggregate();
    });
  }

  async reserveApply(expectedRevision: number): Promise<ModelConfigApplyReservation> {
    return this.runMutation(async () => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new ModelConfigError({
          code: 'schema_invalid',
          operation: 'apply',
          stage: 'validate',
          path: this.configPath,
          expectedRevision,
          message: 'model config apply revision must be a positive integer',
        });
      }
      if (this.applyReservation) {
        throw new ModelConfigError({
          code: 'apply_in_progress',
          operation: 'apply',
          stage: 'compare',
          path: this.configPath,
          expectedRevision,
          actualRevision: this.applyReservation.revision,
          message: `model config revision ${this.applyReservation.revision} is already reserved for apply`,
        });
      }

      const document = await readModelConfigDocument(this.configPath, 'apply');
      const runtimeSnapshot = this.requireRuntimeSnapshot();
      if (document.savedRevision !== expectedRevision) {
        throw new ModelConfigError({
          code: 'revision_conflict',
          operation: 'apply',
          stage: 'compare',
          path: this.configPath,
          expectedRevision,
          actualRevision: document.savedRevision,
          message: `model config apply revision conflict: expected ${expectedRevision}, actual ${document.savedRevision}`,
        });
      }
      if (document.savedRevision === document.appliedRevision) {
        throw new ModelConfigError({
          code: 'revision_conflict',
          operation: 'apply',
          stage: 'compare',
          path: this.configPath,
          expectedRevision,
          actualRevision: document.appliedRevision,
          message: `model config revision ${expectedRevision} is already applied`,
        });
      }
      if (runtimeSnapshot.revision !== document.appliedRevision) {
        throw new ModelConfigError({
          code: 'revision_conflict',
          operation: 'apply',
          stage: 'compare',
          path: this.configPath,
          expectedRevision: runtimeSnapshot.revision,
          actualRevision: document.appliedRevision,
          message: 'model config applied revision changed outside the running owner',
        });
      }

      const token = Symbol(`model-config-apply-${expectedRevision}`);
      this.applyReservation = {
        revision: expectedRevision,
        token,
      };
      let released = false;
      return {
        savedRevision: document.savedRevision,
        appliedRevision: document.appliedRevision,
        release: async () => {
          if (released) return;
          released = true;
          await this.releaseApplyReservation(token);
        },
      };
    });
  }

  getRuntimeSnapshot(): ModelRuntimeSnapshot {
    return this.requireRuntimeSnapshot();
  }

  getRedactedRuntimeSnapshot(): RedactedModelRuntimeSnapshot {
    const snapshot = this.requireRuntimeSnapshot();
    return {
      revision: snapshot.revision,
      connections: snapshot.connections.map((connection) => ({
        ...stripRuntimeCredential(connection),
        credentialState: connection.auth.kind === 'oauth'
          ? 'external'
          : connection.auth.kind === 'apiKey' && connection.apiKey === null
            ? 'missing'
            : 'configured',
        hasSecret: connection.apiKey !== null,
      })),
      models: snapshot.models.map((model) => deepFreezeClone(model)),
      bindings: snapshot.bindings.map((binding) => deepFreezeClone(binding)),
      resolvedBindings: redactStaticBindings(snapshot),
    };
  }

  getConnectionRuntime(connectionId: string): ConnectionRuntimeView {
    const document = this.requireDocument();
    const kek = this.requireKek();
    const secrets = this.decryptSecrets(document, kek, 'read');
    const connection = document.connections.find((candidate) => candidate.id === connectionId);
    if (!connection) {
      throw new ModelConfigError({
        code: 'connection_not_found',
        operation: 'read',
        stage: 'lookup',
        connectionId,
        message: `model connection does not exist: ${connectionId}`,
      });
    }
    const runtimeConnection = createRuntimeConnection(
      connection,
      connection.auth.kind === 'apiKey'
        ? secrets.get(connection.auth.secretRef) ?? null
        : null,
    );
    return deepFreeze({
      revision: document.savedRevision,
      connection: runtimeConnection,
      models: document.models
        .filter((model) => model.connectionId === connectionId)
        .map((model) => deepFreezeClone(model)),
    });
  }

  private async loadKek(
    operation: 'initialize' | 'load' | 'save' | 'apply',
  ): Promise<CredentialKek> {
    let kek: CredentialKek;
    try {
      kek = loadOrCreateKek(this.kekPath);
      await chmod(this.kekPath, 0o600);
    } catch (error) {
      throw asModelConfigError(error, {
        code: 'credential_invalid',
        operation,
        stage: 'credential',
        path: this.kekPath,
        message: `model config KEK is invalid: ${this.kekPath}`,
      });
    }
    return kek;
  }

  private compileSnapshot(
    document: ModelConfigDocument,
    kek: CredentialKek,
    operation: 'initialize' | 'save' | 'apply',
  ): ModelRuntimeSnapshot {
    const secrets = this.decryptSecrets(document, kek, operation);
    const runtimeConnections = document.connections.map((connection) => (
      createRuntimeConnection(
        connection,
        connection.auth.kind === 'apiKey'
          ? secrets.get(connection.auth.secretRef) ?? null
          : null,
      )
    ));
    const runtimeConnectionsById = new Map(
      runtimeConnections.map((connection) => [connection.id, connection]),
    );
    for (const binding of document.bindings) {
      if (binding.mode !== 'dedicated') continue;
      const connection = runtimeConnectionsById.get(binding.connectionId);
      if (
        connection?.auth.kind === 'apiKey'
        && connection.apiKey === null
      ) {
        throw new ModelConfigError({
          code: 'credential_invalid',
          operation,
          stage: 'compile',
          path: this.configPath,
          connectionId: connection.id,
          modelId: binding.modelId,
          workload: binding.workload,
          httpStatus: operation === 'apply' ? 500 : 400,
          message: `dedicated binding ${binding.workload} references a connection without an API key`,
        });
      }
    }
    return deepFreeze({
      revision: document.savedRevision,
      connections: runtimeConnections,
      models: document.models.map((model) => deepFreezeClone(model)),
      bindings: document.bindings.map((binding) => deepFreezeClone(binding)),
    });
  }

  private decryptSecrets(
    document: ModelConfigDocument,
    kek: CredentialKek,
    operation: 'initialize' | 'load' | 'save' | 'apply' | 'read',
  ): ReadonlyMap<string, string> {
    const values = new Map<string, string>();
    for (const secret of document.secrets) {
      let value: unknown;
      try {
        value = decryptEnvelopeJson<unknown>(
          secret.cipherText,
          secret.meta,
          secretAad(secret.connectionId, secret.secretRef),
          kek,
        );
      } catch (error) {
        throw new ModelConfigError({
          code: 'credential_invalid',
          operation,
          stage: 'credential',
          path: this.configPath,
          connectionId: secret.connectionId,
          message: `failed to decrypt credential for connection ${secret.connectionId}`,
          cause: error,
        });
      }
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new ModelConfigError({
          code: 'credential_invalid',
          operation,
          stage: 'credential',
          path: this.configPath,
          connectionId: secret.connectionId,
          message: `decrypted credential for connection ${secret.connectionId} is invalid`,
        });
      }
      values.set(secret.secretRef, value);
    }
    return values;
  }

  private encryptInitialSecrets(
    draft: ModelConfigDraft,
    apiKeys: Readonly<Record<string, string>>,
    kek: CredentialKek,
  ): EncryptedModelSecret[] {
    const connectionIds = new Set(draft.connections.map((connection) => connection.id));
    for (const connectionId of Object.keys(apiKeys)) {
      if (!connectionIds.has(connectionId)) {
        throw new ModelConfigError({
          code: 'secret_operation_invalid',
          operation: 'initialize',
          stage: 'credential',
          connectionId,
          message: `initial API key references missing connection: ${connectionId}`,
        });
      }
    }

    const secrets: EncryptedModelSecret[] = [];
    for (const connection of draft.connections) {
      const value = apiKeys[connection.id];
      if (value === undefined) continue;
      if (connection.auth.kind !== 'apiKey') {
        throw new ModelConfigError({
          code: 'secret_operation_invalid',
          operation: 'initialize',
          stage: 'credential',
          connectionId: connection.id,
          message: `connection ${connection.id} does not accept an API key`,
        });
      }
      secrets.push(encryptSecret(connection, value, kek, 'initialize'));
    }
    return secrets;
  }

  private applySecretOperations(
    current: ModelConfigDocument,
    draft: ModelConfigDraft,
    operations: readonly SecretOperation[],
    kek: CredentialKek,
  ): EncryptedModelSecret[] {
    const operationByConnection = new Map<string, SecretOperation>();
    for (const operation of operations) {
      if (operationByConnection.has(operation.connectionId)) {
        throw new ModelConfigError({
          code: 'secret_operation_invalid',
          operation: 'save',
          stage: 'credential',
          connectionId: operation.connectionId,
          message: `duplicate secret operation for connection ${operation.connectionId}`,
        });
      }
      operationByConnection.set(operation.connectionId, operation);
    }

    const currentConnectionById = new Map(
      current.connections.map((connection) => [connection.id, connection]),
    );
    const currentSecretByRef = new Map(
      current.secrets.map((secret) => [secret.secretRef, secret]),
    );
    const result: EncryptedModelSecret[] = [];
    for (const connection of draft.connections) {
      if (connection.auth.kind !== 'apiKey') {
        if (operationByConnection.has(connection.id)) {
          throw new ModelConfigError({
            code: 'secret_operation_invalid',
            operation: 'save',
            stage: 'credential',
            connectionId: connection.id,
            message: `connection ${connection.id} does not accept a secret operation`,
          });
        }
        continue;
      }

      const operation = operationByConnection.get(connection.id);
      if (!operation) {
        throw new ModelConfigError({
          code: 'secret_operation_invalid',
          operation: 'save',
          stage: 'credential',
          connectionId: connection.id,
          message: `missing explicit secret operation for connection ${connection.id}`,
        });
      }
      operationByConnection.delete(connection.id);
      if (operation.operation === 'clear') continue;
      if (operation.operation === 'set') {
        result.push(encryptSecret(connection, operation.value, kek, 'save'));
        continue;
      }

      const previousConnection = currentConnectionById.get(connection.id);
      if (
        previousConnection?.auth.kind !== 'apiKey'
        || previousConnection.auth.secretRef !== connection.auth.secretRef
      ) {
        throw new ModelConfigError({
          code: 'secret_operation_invalid',
          operation: 'save',
          stage: 'credential',
          connectionId: connection.id,
          message: `cannot retain a credential after changing its secret reference`,
        });
      }
      if (previousConnection.baseUrl !== connection.baseUrl) {
        throw new ModelConfigError({
          code: 'secret_operation_invalid',
          operation: 'save',
          stage: 'credential',
          connectionId: connection.id,
          message: `cannot retain a credential after changing connection ${connection.id} base URL`,
        });
      }
      const retained = currentSecretByRef.get(connection.auth.secretRef);
      if (retained) result.push(retained);
    }

    const [unexpected] = operationByConnection.values();
    if (unexpected) {
      throw new ModelConfigError({
        code: 'secret_operation_invalid',
        operation: 'save',
        stage: 'credential',
        connectionId: unexpected.connectionId,
        message: `secret operation references missing connection: ${unexpected.connectionId}`,
      });
    }
    return result;
  }

  private requireDocument(): ModelConfigDocument {
    if (!this.document) {
      throw new ModelConfigError({
        code: 'not_initialized',
        operation: 'read',
        stage: 'lookup',
        path: this.configPath,
        message: 'model config service has not completed startup',
      });
    }
    return this.document;
  }

  private requireRuntimeSnapshot(): ModelRuntimeSnapshot {
    if (!this.runtimeSnapshot) {
      throw new ModelConfigError({
        code: 'not_initialized',
        operation: 'read',
        stage: 'lookup',
        path: this.configPath,
        message: 'model runtime snapshot has not been published',
      });
    }
    return this.runtimeSnapshot;
  }

  private requireKek(): CredentialKek {
    if (!this.kek) {
      throw new ModelConfigError({
        code: 'not_initialized',
        operation: 'read',
        stage: 'credential',
        path: this.kekPath,
        message: 'model config KEK has not been loaded',
      });
    }
    return this.kek;
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.mutationTail.then(operation, operation);
    this.mutationTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private releaseApplyReservation(token: symbol): Promise<void> {
    return this.runMutation(async () => {
      if (this.applyReservation?.token === token) {
        this.applyReservation = null;
      }
    });
  }
}

function parseDraft(value: unknown, operation: 'initialize' | 'save'): ModelConfigDraft {
  try {
    return modelConfigDraftSchema.parse(value);
  } catch (error) {
    throw schemaError(error, operation);
  }
}

function parsePutInput(value: unknown): ModelConfigPutInput {
  try {
    return modelConfigPutSchema.parse(value);
  } catch (error) {
    throw schemaError(error, 'save');
  }
}

function parseDocument(
  value: unknown,
  operation: 'initialize' | 'save',
): ModelConfigDocument {
  try {
    return modelConfigDocumentSchema.parse(value);
  } catch (error) {
    throw schemaError(error, operation);
  }
}

function schemaError(
  error: unknown,
  operation: 'initialize' | 'save',
): ModelConfigError {
  if (error instanceof ModelConfigError) return error;
  if (error instanceof ZodError) {
    const [issue] = error.issues;
    const location = issue?.path.length ? issue.path.join('.') : '<document>';
    return new ModelConfigError({
      code: 'schema_invalid',
      operation,
      stage: 'validate',
      message: `model config validation failed at ${location}: ${issue?.message ?? 'unknown schema error'}`,
      cause: error,
    });
  }
  return new ModelConfigError({
    code: 'schema_invalid',
    operation,
    stage: 'validate',
    message: 'model config validation failed',
    cause: error,
  });
}

function encryptSecret(
  connection: ConnectionDefinition,
  value: string,
  kek: CredentialKek,
  operation: 'initialize' | 'save',
): EncryptedModelSecret {
  if (connection.auth.kind !== 'apiKey') {
    throw new ModelConfigError({
      code: 'secret_operation_invalid',
      operation,
      stage: 'credential',
      connectionId: connection.id,
      message: `connection ${connection.id} does not accept an API key`,
    });
  }
  if (value.trim().length === 0) {
    throw new ModelConfigError({
      code: 'secret_operation_invalid',
      operation,
      stage: 'credential',
      connectionId: connection.id,
      message: `API key for connection ${connection.id} cannot be empty`,
    });
  }
  const encrypted = encryptEnvelopeJson(
    value,
    secretAad(connection.id, connection.auth.secretRef),
    kek,
  );
  return {
    secretRef: connection.auth.secretRef,
    connectionId: connection.id,
    cipherText: encrypted.cipherText,
    meta: encrypted.meta,
  };
}

function secretAad(connectionId: string, secretRef: string): string {
  return `qqbot:model-config:v1:${connectionId}:${secretRef}`;
}

function assertStableIdentities(
  current: ModelConfigDocument,
  draft: ModelConfigDraft,
): void {
  const currentConnections = new Map(
    current.connections.map((connection) => [connection.id, connection]),
  );
  for (const connection of draft.connections) {
    const previous = currentConnections.get(connection.id);
    if (previous && previous.adapter !== connection.adapter) {
      throw new ModelConfigError({
        code: 'immutable_identity',
        operation: 'save',
        stage: 'validate',
        connectionId: connection.id,
        message: `connection ${connection.id} cannot change adapter type`,
      });
    }
  }

  const currentModels = new Map(
    current.models.map((model) => [
      modelIdentity(model.connectionId, model.id),
      model,
    ]),
  );
  for (const model of draft.models) {
    const previous = currentModels.get(
      modelIdentity(model.connectionId, model.id),
    );
    if (previous && previous.modelType !== model.modelType) {
      throw new ModelConfigError({
        code: 'immutable_identity',
        operation: 'save',
        stage: 'validate',
        connectionId: model.connectionId,
        modelId: model.id,
        message: `model ${model.connectionId}/${model.id} cannot change model type`,
      });
    }
  }
}

function modelIdentity(connectionId: string, modelId: string): string {
  return `${connectionId}/${modelId}`;
}

function redactConnection(
  connection: ConnectionDefinition,
  encryptedSecretRefs: ReadonlySet<string>,
): RedactedConnection {
  const hasSecret = connection.auth.kind === 'apiKey'
    && encryptedSecretRefs.has(connection.auth.secretRef);
  return {
    ...deepFreezeClone(connection),
    credentialState: connection.auth.kind === 'oauth'
      ? 'external'
      : connection.auth.kind === 'apiKey' && !hasSecret
        ? 'missing'
        : 'configured',
    hasSecret,
  };
}

function stripRuntimeCredential(connection: RuntimeConnection): ConnectionDefinition {
  const {
    apiKey: _apiKey,
    ...definition
  } = connection;
  return definition;
}

function createRuntimeConnection(
  connection: ConnectionDefinition,
  apiKey: string | null,
): RuntimeConnection {
  const runtimeConnection = structuredClone(connection) as RuntimeConnection;
  Object.defineProperty(runtimeConnection, 'apiKey', {
    value: apiKey,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return deepFreeze(runtimeConnection);
}

function deepFreezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
