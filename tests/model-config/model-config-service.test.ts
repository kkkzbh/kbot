import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ModelConfigError,
  ModelConfigService,
  modelConfigAggregateSchema,
  modelConfigDocumentSchema,
  type SecretOperation,
} from '../../src/plugins/model-config/index.js';
import { createValidModelConfigDraft } from './fixtures.js';

const PRIMARY_API_KEY = 'model-config-test-secret';

describe('ModelConfigService persistence lifecycle', () => {
  it('encrypts credentials, validates before publish, and marks the revision applied after publish', async () => {
    await withHarness(async ({ configPath, kekPath, service }) => {
      const candidate = await service.createInitial({
        draft: createValidModelConfigDraft(),
        apiKeys: { primary: PRIMARY_API_KEY },
      });
      expect(candidate.revision).toBe(1);
      expect(() => service.getRuntimeSnapshot()).toThrowError(
        expect.objectContaining({ code: 'not_initialized' }),
      );

      const stagedText = await readFile(configPath, 'utf8');
      expect(stagedText).not.toContain(PRIMARY_API_KEY);
      expect(modelConfigDocumentSchema.parse(JSON.parse(stagedText))).toMatchObject({
        savedRevision: 1,
        appliedRevision: 0,
      });
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
      expect((await stat(kekPath)).mode & 0o777).toBe(0o600);

      let publishedRevision = 0;
      const runningService = new ModelConfigService({ configPath, kekPath });
      const snapshot = await runningService.loadAndApply((pending) => {
        expect(Object.isFrozen(pending)).toBe(true);
        expect(Object.isFrozen(pending.connections)).toBe(true);
        expect(
          pending.connections.find((connection) => connection.id === 'primary')?.apiKey,
        ).toBe(PRIMARY_API_KEY);
        publishedRevision = pending.revision;
      });

      expect(snapshot.revision).toBe(1);
      expect(publishedRevision).toBe(1);
      expect(JSON.stringify(snapshot)).not.toContain(PRIMARY_API_KEY);
      const aggregate = modelConfigAggregateSchema.parse(runningService.getAggregate());
      expect(aggregate).toMatchObject({
        savedRevision: 1,
        appliedRevision: 1,
        pending: false,
        pendingReason: null,
      });
      const redacted = JSON.stringify(aggregate);
      expect(redacted).not.toContain(PRIMARY_API_KEY);
      expect(redacted).not.toContain('"cipherText"');
      expect(redacted).not.toContain('"meta"');
      const connectionRuntime = runningService.getConnectionRuntime('primary');
      expect(connectionRuntime.connection.apiKey).toBe(PRIMARY_API_KEY);
      expect(JSON.stringify(connectionRuntime)).not.toContain(PRIMARY_API_KEY);
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
        savedRevision: 1,
        appliedRevision: 1,
      });
    });
  });

  it('keeps the canonical file and service runtime unchanged when publication fails', async () => {
    await withHarness(async ({ configPath, kekPath, service }) => {
      await service.createInitial({
        draft: createValidModelConfigDraft(),
        apiKeys: { primary: PRIMARY_API_KEY },
      });
      const runningService = new ModelConfigService({ configPath, kekPath });

      await expect(
        runningService.loadAndApply(() => {
          throw new Error('managed client registration failed');
        }),
      ).rejects.toMatchObject({
        code: 'publish_failed',
        operation: 'apply',
        stage: 'publish',
      });
      expect(() => runningService.getRuntimeSnapshot()).toThrowError(
        expect.objectContaining({ code: 'not_initialized' }),
      );
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
        savedRevision: 1,
        appliedRevision: 0,
      });
    });
  });

  it('fails closed when the configured KEK cannot decrypt the canonical credentials', async () => {
    await withHarness(async ({ configPath, kekPath, service }) => {
      await service.createInitial({
        draft: createValidModelConfigDraft(),
        apiKeys: { primary: PRIMARY_API_KEY },
      });
      const wrongKekPath = `${kekPath}.wrong`;
      const runningService = new ModelConfigService({
        configPath,
        kekPath: wrongKekPath,
      });

      await expect(runningService.loadAndApply(() => {
        throw new Error('publisher must not run');
      })).rejects.toMatchObject({
        code: 'credential_invalid',
        operation: 'apply',
        stage: 'credential',
        connectionId: 'primary',
      });
      expect(() => runningService.getRuntimeSnapshot()).toThrowError(
        expect.objectContaining({ code: 'not_initialized' }),
      );
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
        savedRevision: 1,
        appliedRevision: 0,
      });
    });
  });

  it('persists a full CAS draft as pending while preserving the immutable live snapshot', async () => {
    await withRunningService(async ({ configPath, service }) => {
      const before = service.getRuntimeSnapshot();
      const aggregate = await service.put({
        expectedRevision: 1,
        draft: createValidModelConfigDraft(),
        secretOperations: retainAllApiKeyConnections(),
      });

      expect(aggregate).toMatchObject({
        savedRevision: 2,
        appliedRevision: 1,
        pending: true,
        pendingReason: 'saved_revision_not_applied',
      });
      expect(service.getRuntimeSnapshot()).toBe(before);
      expect(service.getRuntimeSnapshot().revision).toBe(1);
      expect(aggregate.liveBindings.every((binding) => binding.revision === 1)).toBe(true);
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
        savedRevision: 2,
        appliedRevision: 1,
      });
    });
  });

  it('rejects stale concurrent writers with one deterministic 409 conflict', async () => {
    await withRunningService(async ({ service }) => {
      const request = {
        expectedRevision: 1,
        draft: createValidModelConfigDraft(),
        secretOperations: retainAllApiKeyConnections(),
      };
      const results = await Promise.allSettled([
        service.put(structuredClone(request)),
        service.put(structuredClone(request)),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const [rejected] = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(rejected.reason).toBeInstanceOf(ModelConfigError);
      expect(rejected.reason).toMatchObject({
        code: 'revision_conflict',
        httpStatus: 409,
        expectedRevision: 1,
        actualRevision: 2,
      });
    });
  });

  it('reserves one exact pending revision while restart is being scheduled', async () => {
    await withRunningService(async ({ service }) => {
      await service.put({
        expectedRevision: 1,
        draft: createValidModelConfigDraft(),
        secretOperations: retainAllApiKeyConnections(),
      });

      await expect(service.reserveApply(1)).rejects.toMatchObject({
        code: 'revision_conflict',
        operation: 'apply',
        expectedRevision: 1,
        actualRevision: 2,
      });

      const reservation = await service.reserveApply(2);
      expect(reservation).toMatchObject({
        savedRevision: 2,
        appliedRevision: 1,
      });
      await expect(service.put({
        expectedRevision: 2,
        draft: createValidModelConfigDraft(),
        secretOperations: retainAllApiKeyConnections(),
      })).rejects.toMatchObject({
        code: 'apply_in_progress',
        operation: 'save',
        actualRevision: 2,
      });

      await reservation.release();
      await expect(service.put({
        expectedRevision: 2,
        draft: createValidModelConfigDraft(),
        secretOperations: retainAllApiKeyConnections(),
      })).resolves.toMatchObject({
        savedRevision: 3,
        appliedRevision: 1,
        pending: true,
      });
    });
  });

  it('requires an explicit credential decision when an API-key endpoint changes', async () => {
    await withRunningService(async ({ service }) => {
      const changedEndpoint = createValidModelConfigDraft();
      changedEndpoint.connections[0].baseUrl = 'https://different.example.test/v1';

      await expect(service.put({
        expectedRevision: 1,
        draft: changedEndpoint,
        secretOperations: retainAllApiKeyConnections(),
      })).rejects.toMatchObject({
        code: 'secret_operation_invalid',
        operation: 'save',
        stage: 'credential',
        connectionId: 'primary',
      });
      expect(service.getAggregate()).toMatchObject({
        savedRevision: 1,
        appliedRevision: 1,
      });
      expect(service.getConnectionRuntime('primary').connection).toMatchObject({
        baseUrl: 'https://models.example.test/v1',
        apiKey: PRIMARY_API_KEY,
      });

      await expect(service.put({
        expectedRevision: 1,
        draft: changedEndpoint,
        secretOperations: [
          { connectionId: 'primary', operation: 'set', value: 'different-endpoint-secret' },
          { connectionId: 'repairable', operation: 'retain' },
        ],
      })).resolves.toMatchObject({
        savedRevision: 2,
        appliedRevision: 1,
      });
      expect(service.getConnectionRuntime('primary').connection).toMatchObject({
        baseUrl: 'https://different.example.test/v1',
        apiKey: 'different-endpoint-secret',
      });
    });
  });

  it('supports explicit set and clear for an unbound credential without leaking it', async () => {
    await withRunningService(async ({ configPath, service }) => {
      const configured = await service.put({
        expectedRevision: 1,
        draft: createValidModelConfigDraft(),
        secretOperations: [
          { connectionId: 'primary', operation: 'retain' },
          {
            connectionId: 'repairable',
            operation: 'set',
            value: 'repairable-secret',
          },
        ],
      });
      expect(
        configured.connections.find((connection) => connection.id === 'repairable'),
      ).toMatchObject({
        credentialState: 'configured',
        hasSecret: true,
      });
      expect(JSON.stringify(configured)).not.toContain('repairable-secret');
      const connectionRuntime = service.getConnectionRuntime('repairable');
      expect(connectionRuntime.connection.apiKey).toBe('repairable-secret');
      expect(JSON.stringify(connectionRuntime)).not.toContain('repairable-secret');

      const cleared = await service.put({
        expectedRevision: 2,
        draft: createValidModelConfigDraft(),
        secretOperations: [
          { connectionId: 'primary', operation: 'retain' },
          { connectionId: 'repairable', operation: 'clear' },
        ],
      });
      expect(
        cleared.connections.find((connection) => connection.id === 'repairable'),
      ).toMatchObject({
        credentialState: 'missing',
        hasSecret: false,
      });
      expect(await readFile(configPath, 'utf8')).not.toContain('repairable-secret');
    });
  });

  it('rejects a missing credential used by a dedicated binding without a partial commit', async () => {
    await withRunningService(async ({ configPath, service }) => {
      await expect(service.put({
        expectedRevision: 1,
        draft: createValidModelConfigDraft(),
        secretOperations: [
          { connectionId: 'primary', operation: 'clear' },
          { connectionId: 'repairable', operation: 'retain' },
        ],
      })).rejects.toMatchObject({
        code: 'credential_invalid',
        operation: 'save',
        stage: 'compile',
        connectionId: 'primary',
      });

      expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
        savedRevision: 1,
        appliedRevision: 1,
      });
      expect(service.getAggregate()).toMatchObject({
        savedRevision: 1,
        appliedRevision: 1,
      });
    });
  });

  it('rejects a non-HTTP connection endpoint before writing a new revision', async () => {
    await withRunningService(async ({ configPath, service }) => {
      const before = await readFile(configPath, 'utf8');
      const draft = createValidModelConfigDraft();
      draft.connections[0].baseUrl = 'ftp://models.example.test/v1';

      await expect(service.put({
        expectedRevision: 1,
        draft,
        secretOperations: retainAllApiKeyConnections(),
      })).rejects.toMatchObject({
        code: 'schema_invalid',
        operation: 'save',
        stage: 'validate',
      });

      expect(await readFile(configPath, 'utf8')).toBe(before);
      expect(service.getAggregate()).toMatchObject({
        savedRevision: 1,
        appliedRevision: 1,
      });
    });
  });

  it('rejects connection adapter mutation', async () => {
    await withRunningService(async ({ service }) => {
      const changedConnection = createValidModelConfigDraft();
      changedConnection.connections[1].adapter = 'copilotBridge';
      changedConnection.connections[1].baseUrl = null;
      changedConnection.connections[1].auth = {
        kind: 'oauth',
        provider: 'copilot',
      };
      changedConnection.connections[1].catalogDriver = 'copilotBridge';
      await expect(service.put({
        expectedRevision: 1,
        draft: changedConnection,
        secretOperations: [
          { connectionId: 'primary', operation: 'retain' },
        ],
      })).rejects.toMatchObject({
        code: 'immutable_identity',
        connectionId: 'repairable',
      });

    });
  });
});

async function withRunningService(
  run: (context: {
    configPath: string;
    kekPath: string;
    service: ModelConfigService;
  }) => Promise<void>,
): Promise<void> {
  return withHarness(async ({ configPath, kekPath, service }) => {
    await service.createInitial({
      draft: createValidModelConfigDraft(),
      apiKeys: { primary: PRIMARY_API_KEY },
    });
    const runningService = new ModelConfigService({ configPath, kekPath });
    await runningService.loadAndApply(() => undefined);
    await run({ configPath, kekPath, service: runningService });
  });
}

async function withHarness(
  run: (context: {
    configPath: string;
    kekPath: string;
    service: ModelConfigService;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'qqbot-model-config-'));
  const configPath = join(directory, 'model-config.json');
  const kekPath = join(directory, 'model-config.kek');
  try {
    await run({
      configPath,
      kekPath,
      service: new ModelConfigService({ configPath, kekPath }),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function retainAllApiKeyConnections(): SecretOperation[] {
  return [
    { connectionId: 'primary', operation: 'retain' },
    { connectionId: 'repairable', operation: 'retain' },
  ];
}
