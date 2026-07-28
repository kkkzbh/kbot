export type MemoryOperation =
  | 'startup'
  | 'address'
  | 'enqueue'
  | 'claim'
  | 'extract'
  | 'review'
  | 'archive'
  | 'recall'
  | 'forget'
  | 'maintenance'
  | 'audit';

export type MemoryFailureStage =
  | 'schema'
  | 'validation'
  | 'authorization'
  | 'transaction'
  | 'read'
  | 'decode'
  | 'provider'
  | 'write'
  | 'finalize';

export class MemoryRuntimeError extends Error {
  readonly name = 'MemoryRuntimeError';

  constructor(
    readonly operation: MemoryOperation,
    readonly stage: MemoryFailureStage,
    readonly code: string,
    message: string,
    options: {
      retryable?: boolean;
      upstreamStatus?: number | null;
      providerCode?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.retryable = options.retryable ?? false;
    this.upstreamStatus = options.upstreamStatus ?? null;
    this.providerCode = options.providerCode ?? null;
  }

  readonly retryable: boolean;
  readonly upstreamStatus: number | null;
  readonly providerCode: string | null;
}

export function asMemoryRuntimeError(
  error: unknown,
  operation: MemoryOperation,
  stage: MemoryFailureStage,
  code: string,
  retryable = false,
): MemoryRuntimeError {
  if (error instanceof MemoryRuntimeError) return error;
  const diagnostic = error && typeof error === 'object'
    ? error as { upstreamStatus?: unknown; providerCode?: unknown }
    : {};
  const upstreamStatus = typeof diagnostic.upstreamStatus === 'number'
    && Number.isInteger(diagnostic.upstreamStatus)
    && diagnostic.upstreamStatus >= 100
    && diagnostic.upstreamStatus <= 599
    ? diagnostic.upstreamStatus
    : null;
  const providerCode = typeof diagnostic.providerCode === 'string'
    && /^[A-Za-z0-9._:-]{1,120}$/.test(diagnostic.providerCode)
    ? diagnostic.providerCode
    : null;
  return new MemoryRuntimeError(
    operation,
    stage,
    code,
    `Memory ${operation} failed during ${stage}.`,
    {
    retryable,
    upstreamStatus,
    providerCode,
    cause: error,
    },
  );
}

export function memorySafeErrorMessage(error: unknown): string {
  return error instanceof MemoryRuntimeError
    ? error.message
    : 'Unexpected memory runtime failure.';
}

export function memoryErrorDetail(error: unknown): {
  code: string;
  stage: string;
  retryable: boolean;
  upstreamStatus: number | null;
  providerCode: string | null;
} {
  if (error instanceof MemoryRuntimeError) {
    return {
      code: error.code,
      stage: error.stage,
      retryable: error.retryable,
      upstreamStatus: error.upstreamStatus,
      providerCode: error.providerCode,
    };
  }
  return {
    code: 'unexpected_memory_error',
    stage: 'provider',
    retryable: false,
    upstreamStatus: null,
    providerCode: null,
  };
}
