import {
  DEFAULT_PROMPT_FRAGMENT_POLICY,
  promptFragmentPolicyConfigSchema,
  type PromptFragmentPolicyConfig,
  type PromptFragmentPolicyPutInput,
  type PromptFragmentPolicyServiceLike,
  type PromptFragmentPolicyState,
} from './types.js';

const PRESET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

type PromptFragmentPolicyRecord = {
  contextPresetId: string;
  revision: number;
  relationshipState: number;
  attachmentReferences: number;
  nativeCapabilities: number;
  updatedAt: number;
};

export type PromptFragmentPolicyDatabase = {
  get(
    table: string,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]>;
  set(
    table: string,
    query: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<unknown>;
  create(
    table: string,
    row: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  remove(
    table: string,
    query: Record<string, unknown>,
  ): Promise<unknown>;
  withTransaction?<T>(
    callback: (database: PromptFragmentPolicyDatabase) => Promise<T>,
  ): Promise<T>;
};

export class PromptFragmentPolicyError extends Error {
  constructor(
    readonly code: 'invalid_preset_id' | 'revision_conflict' | 'storage_failed',
    message: string,
    readonly details: {
      operation: 'read' | 'update' | 'reset';
      stage: 'validation' | 'read' | 'compare' | 'persist';
      contextPresetId: string;
      expectedRevision?: number;
      actualRevision?: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'PromptFragmentPolicyError';
  }
}

export class PromptFragmentPolicyService implements PromptFragmentPolicyServiceLike {
  constructor(
    private readonly database: PromptFragmentPolicyDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  async get(contextPresetId: string): Promise<PromptFragmentPolicyState> {
    const id = normalizeContextPresetId(contextPresetId, 'read');
    try {
      return stateFromRecord(id, await readRecord(this.database, id));
    } catch (error) {
      if (error instanceof PromptFragmentPolicyError) throw error;
      throw new PromptFragmentPolicyError(
        'storage_failed',
        `failed to read prompt fragment policy for ${id}`,
        {
          operation: 'read',
          stage: 'read',
          contextPresetId: id,
          cause: error,
        },
      );
    }
  }

  async put(
    contextPresetId: string,
    input: PromptFragmentPolicyPutInput,
  ): Promise<PromptFragmentPolicyState> {
    const id = normalizeContextPresetId(contextPresetId, 'update');
    const expectedRevision = normalizeRevision(input.expectedRevision, id, 'update');
    const config = promptFragmentPolicyConfigSchema.parse(input.config);

    return this.withTransaction(async (database) => {
      const current = await readRecord(database, id);
      const actualRevision = current?.revision ?? 0;
      assertRevision(id, 'update', expectedRevision, actualRevision);
      const updatedAt = this.now();
      const nextRevision = actualRevision + 1;
      const values = {
        revision: nextRevision,
        relationshipState: Number(config.relationshipState),
        attachmentReferences: Number(config.attachmentReferences),
        nativeCapabilities: Number(config.nativeCapabilities),
        updatedAt,
      };
      try {
        if (current) {
          await database.set(
            'prompt_fragment_policy',
            { contextPresetId: id, revision: actualRevision },
            values,
          );
        } else {
          await database.create('prompt_fragment_policy', {
            contextPresetId: id,
            ...values,
          });
        }
      } catch (error) {
        throw new PromptFragmentPolicyError(
          'storage_failed',
          `failed to persist prompt fragment policy for ${id}`,
          {
            operation: 'update',
            stage: 'persist',
            contextPresetId: id,
            cause: error,
          },
        );
      }
      return stateFromRecord(id, {
        contextPresetId: id,
        ...values,
      });
    });
  }

  async reset(
    contextPresetId: string,
    expectedRevision: number,
  ): Promise<PromptFragmentPolicyState> {
    const id = normalizeContextPresetId(contextPresetId, 'reset');
    const expected = normalizeRevision(expectedRevision, id, 'reset');
    return this.withTransaction(async (database) => {
      const current = await readRecord(database, id);
      const actualRevision = current?.revision ?? 0;
      assertRevision(id, 'reset', expected, actualRevision);
      if (current) {
        try {
          await database.remove('prompt_fragment_policy', {
            contextPresetId: id,
            revision: actualRevision,
          });
        } catch (error) {
          throw new PromptFragmentPolicyError(
            'storage_failed',
            `failed to reset prompt fragment policy for ${id}`,
            {
              operation: 'reset',
              stage: 'persist',
              contextPresetId: id,
              cause: error,
            },
          );
        }
      }
      return defaultState(id);
    });
  }

  private async withTransaction<T>(
    operation: (database: PromptFragmentPolicyDatabase) => Promise<T>,
  ): Promise<T> {
    if (typeof this.database.withTransaction !== 'function') {
      throw new PromptFragmentPolicyError(
        'storage_failed',
        'prompt fragment policy requires transactional database support',
        {
          operation: 'update',
          stage: 'persist',
          contextPresetId: '<transaction>',
        },
      );
    }
    return this.database.withTransaction(operation);
  }
}

function normalizeContextPresetId(
  value: string,
  operation: PromptFragmentPolicyError['details']['operation'],
): string {
  const id = value.trim();
  if (!PRESET_ID_PATTERN.test(id)) {
    throw new PromptFragmentPolicyError(
      'invalid_preset_id',
      `invalid context preset id: ${value}`,
      {
        operation,
        stage: 'validation',
        contextPresetId: value,
      },
    );
  }
  return id;
}

function normalizeRevision(
  value: number,
  contextPresetId: string,
  operation: PromptFragmentPolicyError['details']['operation'],
): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new PromptFragmentPolicyError(
      'revision_conflict',
      `invalid prompt fragment policy revision: ${value}`,
      {
        operation,
        stage: 'validation',
        contextPresetId,
        expectedRevision: value,
      },
    );
  }
  return value;
}

function assertRevision(
  contextPresetId: string,
  operation: PromptFragmentPolicyError['details']['operation'],
  expectedRevision: number,
  actualRevision: number,
): void {
  if (expectedRevision === actualRevision) return;
  throw new PromptFragmentPolicyError(
    'revision_conflict',
    `prompt fragment policy revision conflict: expected ${expectedRevision}, actual ${actualRevision}`,
    {
      operation,
      stage: 'compare',
      contextPresetId,
      expectedRevision,
      actualRevision,
    },
  );
}

async function readRecord(
  database: PromptFragmentPolicyDatabase,
  contextPresetId: string,
): Promise<PromptFragmentPolicyRecord | null> {
  const rows = await database.get('prompt_fragment_policy', { contextPresetId });
  const row = rows[0];
  if (!row) return null;
  return {
    contextPresetId,
    revision: Number(row.revision),
    relationshipState: Number(row.relationshipState),
    attachmentReferences: Number(row.attachmentReferences),
    nativeCapabilities: Number(row.nativeCapabilities),
    updatedAt: Number(row.updatedAt),
  };
}

function stateFromRecord(
  contextPresetId: string,
  record: PromptFragmentPolicyRecord | null,
): PromptFragmentPolicyState {
  if (!record) return defaultState(contextPresetId);
  const config: PromptFragmentPolicyConfig = promptFragmentPolicyConfigSchema.parse({
    relationshipState: record.relationshipState === 1,
    attachmentReferences: record.attachmentReferences === 1,
    nativeCapabilities: record.nativeCapabilities === 1,
  });
  return {
    contextPresetId,
    revision: record.revision,
    source: 'override',
    updatedAt: new Date(record.updatedAt).toISOString(),
    config,
  };
}

function defaultState(contextPresetId: string): PromptFragmentPolicyState {
  return {
    contextPresetId,
    revision: 0,
    source: 'default',
    updatedAt: null,
    config: structuredClone(DEFAULT_PROMPT_FRAGMENT_POLICY),
  };
}
