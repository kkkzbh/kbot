import { ModelConfigError } from '../../model-config/index.js';

export function isNonRetryableMemoryProviderError(error: unknown): boolean {
  if (!(error instanceof ModelConfigError)) return false;
  if (error.code === 'runtime_operation_invalid') return true;
  const status = error.upstreamStatus;
  if (status == null) return false;
  return !(
    status === 408
    || status === 409
    || status === 425
    || status === 429
    || status >= 500
  );
}
