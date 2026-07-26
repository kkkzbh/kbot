export type ModelConfigErrorCode =
  | 'not_initialized'
  | 'config_not_found'
  | 'config_already_exists'
  | 'schema_invalid'
  | 'revision_conflict'
  | 'apply_in_progress'
  | 'immutable_identity'
  | 'secret_operation_invalid'
  | 'credential_invalid'
  | 'binding_invalid'
  | 'connection_not_found'
  | 'model_not_found'
  | 'runtime_executor_missing'
  | 'runtime_operation_invalid'
  | 'publish_failed'
  | 'upstream_failed'
  | 'storage_failed';

export type ModelConfigOperation =
  | 'initialize'
  | 'load'
  | 'save'
  | 'apply'
  | 'read'
  | 'resolve'
  | 'execute';

export type ModelConfigStage =
  | 'read'
  | 'parse'
  | 'validate'
  | 'credential'
  | 'compile'
  | 'compare'
  | 'persist'
  | 'publish'
  | 'lookup'
  | 'transport';

export interface ModelConfigErrorDetails {
  code: ModelConfigErrorCode;
  operation: ModelConfigOperation;
  stage: ModelConfigStage;
  message: string;
  httpStatus?: number;
  path?: string;
  connectionId?: string;
  modelId?: string;
  workload?: string;
  expectedRevision?: number;
  actualRevision?: number;
  upstreamStatus?: number;
  providerCode?: string;
  cause?: unknown;
}

export interface SerializedModelConfigError {
  name: 'ModelConfigError';
  code: ModelConfigErrorCode;
  operation: ModelConfigOperation;
  stage: ModelConfigStage;
  message: string;
  httpStatus: number;
  path?: string;
  connectionId?: string;
  modelId?: string;
  workload?: string;
  expectedRevision?: number;
  actualRevision?: number;
  upstreamStatus?: number;
  providerCode?: string;
}

export class ModelConfigError extends Error {
  readonly code: ModelConfigErrorCode;
  readonly operation: ModelConfigOperation;
  readonly stage: ModelConfigStage;
  readonly httpStatus: number;
  readonly path?: string;
  readonly connectionId?: string;
  readonly modelId?: string;
  readonly workload?: string;
  readonly expectedRevision?: number;
  readonly actualRevision?: number;
  readonly upstreamStatus?: number;
  readonly providerCode?: string;

  constructor(details: ModelConfigErrorDetails) {
    super(details.message, { cause: details.cause });
    this.name = 'ModelConfigError';
    this.code = details.code;
    this.operation = details.operation;
    this.stage = details.stage;
    this.httpStatus = details.httpStatus ?? defaultHttpStatus(details.code);
    this.path = details.path;
    this.connectionId = details.connectionId;
    this.modelId = details.modelId;
    this.workload = details.workload;
    this.expectedRevision = details.expectedRevision;
    this.actualRevision = details.actualRevision;
    this.upstreamStatus = details.upstreamStatus;
    this.providerCode = sanitizeProviderCode(details.providerCode);
  }

  toJSON(): SerializedModelConfigError {
    return compact({
      name: 'ModelConfigError' as const,
      code: this.code,
      operation: this.operation,
      stage: this.stage,
      message: this.message,
      httpStatus: this.httpStatus,
      path: this.path,
      connectionId: this.connectionId,
      modelId: this.modelId,
      workload: this.workload,
      expectedRevision: this.expectedRevision,
      actualRevision: this.actualRevision,
      upstreamStatus: this.upstreamStatus,
      providerCode: this.providerCode,
    });
  }
}

export function asModelConfigError(
  error: unknown,
  details: Omit<ModelConfigErrorDetails, 'message' | 'cause'> & { message: string },
): ModelConfigError {
  if (error instanceof ModelConfigError) return error;
  return new ModelConfigError({ ...details, cause: error });
}

export function serializeModelConfigDiagnostic(
  error: unknown,
): SerializedModelConfigError | { name: string } {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (visited.has(current)) break;
    visited.add(current);
    if (current instanceof ModelConfigError) return current.toJSON();
    current = current.cause;
  }
  const name = error instanceof Error && /^[a-zA-Z0-9._:-]{1,120}$/.test(error.name)
    ? error.name
    : 'UnknownModelError';
  return { name };
}

function defaultHttpStatus(code: ModelConfigErrorCode): number {
  switch (code) {
    case 'revision_conflict':
    case 'apply_in_progress':
      return 409;
    case 'schema_invalid':
    case 'immutable_identity':
    case 'secret_operation_invalid':
    case 'binding_invalid':
    case 'runtime_operation_invalid':
      return 400;
    case 'connection_not_found':
    case 'model_not_found':
      return 404;
    case 'not_initialized':
      return 503;
    case 'publish_failed':
      return 503;
    case 'upstream_failed':
      return 502;
    default:
      return 500;
  }
}

function sanitizeProviderCode(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /^[a-zA-Z0-9._:-]{1,120}$/.test(value) ? value : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}
