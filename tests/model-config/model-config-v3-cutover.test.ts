import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { modelConfigDocumentSchema } from '../../src/plugins/model-config/types.js';
import {
  applyModelConfigV3,
  modelConfigV3DocumentSchema,
  preflightModelConfigV3,
} from '../../src/tools/model-config-v3-cutover.js';

const directories: string[] = [];

function v2Document(): Record<string, unknown> {
  const chatModel = {
    id: 'chat',
    connectionId: 'provider',
    displayName: 'Chat',
    transportModel: 'chat',
    modelType: 'chat',
    contextSize: 65_536,
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'native_chat_json_schema',
    capabilities: {
      chat: true,
      embedding: false,
      vision: true,
      tools: true,
      structuredOutput: true,
    },
    timeoutMs: 60_000,
    requestDefaults: {},
  };
  return {
    schemaVersion: 2,
    savedRevision: 5,
    appliedRevision: 5,
    updatedAt: new Date(0).toISOString(),
    migration: null,
    connections: [{
      id: 'provider',
      displayName: 'Provider',
      adapter: 'openaiCompatible',
      baseUrl: 'https://models.example.test/v1',
      auth: { kind: 'apiKey', secretRef: 'connection:provider:api-key' },
      catalogDriver: 'openaiModels',
    }],
    models: [
      chatModel,
      {
        id: 'embedding',
        connectionId: 'provider',
        displayName: 'Embedding',
        transportModel: 'embedding',
        modelType: 'embedding',
        contextSize: 8_192,
        requestMode: null,
        structuredOutputProtocol: null,
        capabilities: {
          chat: false,
          embedding: true,
          vision: false,
          tools: false,
          structuredOutput: false,
        },
        timeoutMs: 30_000,
        requestDefaults: {},
      },
    ],
    bindings: [
      { workload: 'main.chat', mode: 'dedicated', connectionId: 'provider', modelId: 'chat' },
      { workload: 'memory.extract', mode: 'inheritMain' },
      { workload: 'memory.embedding', mode: 'dedicated', connectionId: 'provider', modelId: 'embedding' },
      { workload: 'affinity.analysis', mode: 'inheritMain' },
      { workload: 'naturalTrigger.decision', mode: 'disabled' },
      { workload: 'agent.subagent.default', mode: 'inheritInvocation' },
      { workload: 'sticker.index', mode: 'dedicated', connectionId: 'provider', modelId: 'chat' },
    ],
    secrets: [{
      secretRef: 'connection:provider:api-key',
      connectionId: 'provider',
      cipherText: 'unchanged-ciphertext',
      meta: 'unchanged-meta',
    }],
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('Model Config V3 cutover', () => {
  it('removes embedding profiles and binding while retaining encrypted secrets byte-for-byte', async () => {
    const directory = await mkdtemp('/var/tmp/model-config-v3-');
    directories.push(directory);
    const configPath = join(directory, 'model-config.json');
    await writeFile(configPath, `${JSON.stringify(v2Document(), null, 2)}\n`, { mode: 0o600 });
    const report = await preflightModelConfigV3(configPath);
    expect(report).toMatchObject({
      sourceRevision: 5,
      targetRevision: 6,
      removedEmbeddingModels: ['provider/embedding'],
      removedWorkloads: ['memory.embedding'],
    });

    const migrated = await applyModelConfigV3(configPath, report);
    expect(modelConfigV3DocumentSchema.parse(migrated)).toBeTruthy();
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.savedRevision).toBe(6);
    expect(migrated.appliedRevision).toBe(5);
    expect(migrated.models.map((model) => model.id)).toEqual(['chat']);
    expect(migrated.bindings.some((binding) => binding.workload === 'memory.embedding')).toBe(false);
    expect(migrated.secrets).toEqual([{
      secretRef: 'connection:provider:api-key',
      connectionId: 'provider',
      cipherText: 'unchanged-ciphertext',
      meta: 'unchanged-meta',
    }]);
  });

  it('rejects V3 input and detects changes after preflight', async () => {
    const directory = await mkdtemp('/var/tmp/model-config-v3-drift-');
    directories.push(directory);
    const configPath = join(directory, 'model-config.json');
    await writeFile(configPath, `${JSON.stringify(v2Document())}\n`, { mode: 0o600 });
    const report = await preflightModelConfigV3(configPath);
    const changed = v2Document();
    (changed as { savedRevision: number }).savedRevision = 6;
    await writeFile(configPath, `${JSON.stringify(changed)}\n`, { mode: 0o600 });
    await expect(applyModelConfigV3(configPath, report)).rejects.toThrow(
      'changed after V3 preflight',
    );
    const source = JSON.parse(await readFile(configPath, 'utf8')) as { schemaVersion: number };
    source.schemaVersion = 3;
    await writeFile(configPath, JSON.stringify(source));
    await expect(preflightModelConfigV3(configPath)).rejects.toThrow();
  });
});
