import { resolve } from 'node:path';
import { NaturalTriggerConfigError } from './errors.js';
import {
  readNaturalTriggerConfigDocument,
  writeNaturalTriggerConfigDocumentAtomic,
} from './store.js';
import {
  NATURAL_TRIGGER_CONFIG_SCHEMA_VERSION,
  naturalTriggerConfigDocumentSchema,
  naturalTriggerConfigPutSchema,
  type NaturalTriggerConfig,
  type NaturalTriggerConfigDocument,
  type NaturalTriggerConfigPutInput,
  type NaturalTriggerConfigState,
  type NaturalTriggerRuntimeSnapshot,
} from './types.js';

export const NATURAL_TRIGGER_CONFIG_PATH_ENV = 'QQBOT_NATURAL_TRIGGER_CONFIG_PATH';
export const DEFAULT_NATURAL_TRIGGER_CONFIG_PATH = '/opt/qqbot/data/natural-trigger.json';

export class NaturalTriggerConfigService {
  readonly configPath: string;
  private readonly now: () => Date;
  private document: NaturalTriggerConfigDocument | null = null;
  private runtimeSnapshot: NaturalTriggerRuntimeSnapshot | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: { configPath: string; now?: () => Date }) {
    this.configPath = resolve(options.configPath);
    this.now = options.now ?? (() => new Date());
  }

  static fromEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
    options: { now?: () => Date } = {},
  ): NaturalTriggerConfigService {
    return new NaturalTriggerConfigService({
      configPath: environment[NATURAL_TRIGGER_CONFIG_PATH_ENV]
        ?? DEFAULT_NATURAL_TRIGGER_CONFIG_PATH,
      now: options.now,
    });
  }

  async loadAndApply(): Promise<NaturalTriggerRuntimeSnapshot> {
    return this.runMutation(async () => {
      const loaded = await readNaturalTriggerConfigDocument(this.configPath);
      const applied = loaded.appliedRevision === loaded.savedRevision
        ? loaded
        : naturalTriggerConfigDocumentSchema.parse({
            ...loaded,
            appliedRevision: loaded.savedRevision,
          });
      if (applied !== loaded) {
        await writeNaturalTriggerConfigDocumentAtomic(this.configPath, applied);
      }
      this.document = deepFreezeClone(applied);
      this.runtimeSnapshot = compileRuntimeSnapshot(applied);
      return this.getRuntimeSnapshot();
    });
  }

  getRuntimeSnapshot(): NaturalTriggerRuntimeSnapshot {
    if (!this.runtimeSnapshot) {
      throw new NaturalTriggerConfigError(
        'not_initialized',
        'natural trigger runtime snapshot has not been loaded',
        { path: this.configPath, stage: 'read' },
      );
    }
    return this.runtimeSnapshot;
  }

  getState(): NaturalTriggerConfigState {
    const document = this.requireDocument();
    return {
      schemaVersion: NATURAL_TRIGGER_CONFIG_SCHEMA_VERSION,
      savedRevision: document.savedRevision,
      appliedRevision: document.appliedRevision,
      pending: document.savedRevision !== document.appliedRevision,
      updatedAt: document.updatedAt,
      config: deepFreezeClone(document.config),
    };
  }

  async put(input: NaturalTriggerConfigPutInput): Promise<NaturalTriggerConfigState> {
    return this.runMutation(async () => {
      const request = naturalTriggerConfigPutSchema.parse(input);
      const loaded = await readNaturalTriggerConfigDocument(this.configPath);
      const runtime = this.getRuntimeSnapshot();
      if (request.expectedRevision !== loaded.savedRevision) {
        throw new NaturalTriggerConfigError(
          'revision_conflict',
          `natural trigger config revision conflict: expected ${request.expectedRevision}, actual ${loaded.savedRevision}`,
          {
            path: this.configPath,
            stage: 'compare',
            expectedRevision: request.expectedRevision,
            actualRevision: loaded.savedRevision,
          },
        );
      }
      if (runtime.revision !== loaded.appliedRevision) {
        throw new NaturalTriggerConfigError(
          'revision_conflict',
          'natural trigger applied revision changed outside the running owner',
          {
            path: this.configPath,
            stage: 'compare',
            expectedRevision: runtime.revision,
            actualRevision: loaded.appliedRevision,
          },
        );
      }

      const nextDocument = naturalTriggerConfigDocumentSchema.parse({
        schemaVersion: NATURAL_TRIGGER_CONFIG_SCHEMA_VERSION,
        savedRevision: loaded.savedRevision + 1,
        appliedRevision: loaded.appliedRevision,
        updatedAt: this.now().toISOString(),
        config: request.config,
      });
      await writeNaturalTriggerConfigDocumentAtomic(this.configPath, nextDocument);
      this.document = deepFreezeClone(nextDocument);
      return this.getState();
    });
  }

  private requireDocument(): NaturalTriggerConfigDocument {
    if (!this.document) {
      throw new NaturalTriggerConfigError(
        'not_initialized',
        'natural trigger config service has not been loaded',
        { path: this.configPath, stage: 'read' },
      );
    }
    return this.document;
  }

  private async runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release: () => void = () => undefined;
    this.mutationTail = new Promise<void>((resolveTail) => {
      release = resolveTail;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function compileRuntimeSnapshot(
  document: NaturalTriggerConfigDocument,
): NaturalTriggerRuntimeSnapshot {
  const config = deepFreezeClone(document.config);
  return Object.freeze({
    revision: document.savedRevision,
    config,
    allowedGroupIds: new Set(config.allowedGroupIds),
  });
}

function deepFreezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
  }
  return value;
}

export function naturalTriggerConfigForRuntime(
  snapshot: NaturalTriggerRuntimeSnapshot,
): NaturalTriggerConfig {
  return snapshot.config;
}
