export type NaturalTriggerConfigErrorCode =
  | 'not_initialized'
  | 'config_not_found'
  | 'schema_invalid'
  | 'revision_conflict'
  | 'storage_failed';

export class NaturalTriggerConfigError extends Error {
  readonly httpStatus: number;

  constructor(
    readonly code: NaturalTriggerConfigErrorCode,
    message: string,
    readonly details: {
      path?: string;
      expectedRevision?: number;
      actualRevision?: number;
      stage?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: details.cause });
    this.name = 'NaturalTriggerConfigError';
    this.httpStatus = code === 'revision_conflict'
      ? 409
      : code === 'schema_invalid'
        ? 400
        : code === 'not_initialized'
          ? 503
          : 500;
  }
}
