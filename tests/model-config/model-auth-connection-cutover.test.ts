import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ModelConfigService,
  modelConfigDocumentSchema,
  type ModelConfigDraft,
} from '../../src/plugins/model-config/index.js';
import {
  runModelAuthConnectionCutover,
  type ModelAuthConnectionCutoverOptions,
} from '../../src/tools/model-auth-connection-cutover.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDraft(): ModelConfigDraft {
  return {
    connections: [
      {
        id: 'codex',
        displayName: 'Codex OAuth',
        adapter: 'codexBridge',
        baseUrl: null,
        auth: { kind: 'oauth', provider: 'codex' },
        catalogDriver: 'codexBridge',
      },
      {
        id: 'siliconflow-api-key',
        displayName: 'SiliconFlow API Key',
        adapter: 'openaiCompatible',
        baseUrl: 'https://api.siliconflow.cn/v1',
        auth: { kind: 'apiKey', secretRef: 'connection:siliconflow-api-key:api-key' },
        catalogDriver: 'openaiModels',
      },
      {
        id: 'memory-embedding',
        displayName: 'Memory embedding',
        adapter: 'openaiCompatible',
        baseUrl: 'https://api.siliconflow.cn/v1',
        auth: { kind: 'apiKey', secretRef: 'connection:memory-embedding:api-key' },
        catalogDriver: 'static',
      },
      {
        id: 'memory-extraction',
        displayName: 'Memory extraction',
        adapter: 'openaiCompatible',
        baseUrl: 'https://api.siliconflow.cn/v1',
        auth: { kind: 'apiKey', secretRef: 'connection:memory-extraction:api-key' },
        catalogDriver: 'static',
      },
      {
        id: 'sticker-indexer',
        displayName: 'Sticker indexer',
        adapter: 'openaiCompatible',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        auth: { kind: 'apiKey', secretRef: 'connection:sticker-indexer:api-key' },
        catalogDriver: 'static',
      },
    ],
    models: [
      {
        id: 'gpt-main',
        connectionId: 'codex',
        displayName: 'GPT main',
        transportModel: 'gpt-main',
        modelType: 'chat',
        contextSize: 128_000,
        requestMode: 'responses',
        structuredOutputProtocol: 'native_responses_json_schema',
        capabilities: {
          chat: true,
          embedding: false,
          vision: true,
          tools: true,
          structuredOutput: true,
        },
        timeoutMs: 180_000,
        requestDefaults: {},
      },
      {
        id: 'qwen-embedding',
        connectionId: 'memory-embedding',
        displayName: 'Qwen embedding',
        transportModel: 'Qwen/Qwen3-Embedding-8B',
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
        timeoutMs: 12_000,
        requestDefaults: {},
      },
      {
        id: 'qwen-extract',
        connectionId: 'memory-extraction',
        displayName: 'Qwen extract',
        transportModel: 'Qwen/Qwen3.5-35B-A3B',
        modelType: 'chat',
        contextSize: 128_000,
        requestMode: 'chat_completions',
        structuredOutputProtocol: 'native_chat_json_schema',
        capabilities: {
          chat: true,
          embedding: false,
          vision: false,
          tools: false,
          structuredOutput: true,
        },
        timeoutMs: 90_000,
        requestDefaults: {},
      },
      {
        id: 'doubao-vision',
        connectionId: 'sticker-indexer',
        displayName: 'Doubao vision',
        transportModel: 'doubao-vision',
        modelType: 'chat',
        contextSize: 128_000,
        requestMode: 'chat_completions',
        structuredOutputProtocol: 'native_chat_json_schema',
        capabilities: {
          chat: true,
          embedding: false,
          vision: true,
          tools: false,
          structuredOutput: true,
        },
        timeoutMs: 60_000,
        requestDefaults: {},
      },
    ],
    bindings: [
      {
        workload: 'main.chat',
        mode: 'dedicated',
        connectionId: 'codex',
        modelId: 'gpt-main',
      },
      {
        workload: 'memory.embedding',
        mode: 'dedicated',
        connectionId: 'memory-embedding',
        modelId: 'qwen-embedding',
      },
      {
        workload: 'memory.extract',
        mode: 'dedicated',
        connectionId: 'memory-extraction',
        modelId: 'qwen-extract',
      },
      {
        workload: 'affinity.analysis',
        mode: 'inheritMain',
      },
      {
        workload: 'naturalTrigger.decision',
        mode: 'disabled',
      },
      {
        workload: 'agent.subagent.default',
        mode: 'inheritInvocation',
      },
      {
        workload: 'sticker.index',
        mode: 'dedicated',
        connectionId: 'sticker-indexer',
        modelId: 'doubao-vision',
      },
    ],
  };
}

describe('model auth connection cutover', () => {
  it('moves workload-named credentials into neutral auth connections', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-model-auth-cutover-'));
    temporaryDirectories.push(root);
    const configPath = join(root, 'model-config.json');
    const kekPath = join(root, 'model-config.kek');
    const backupPath = join(root, 'backup/model-config.json');
    const reportPath = join(root, 'backup/report.json');
    const systemctl = join(root, 'systemctl');
    writeFileSync(systemctl, '#!/usr/bin/env bash\nprintf "inactive\\n"\n', 'utf8');
    chmodSync(systemctl, 0o700);

    const service = new ModelConfigService({ configPath, kekPath });
    await service.createInitial({
      draft: createDraft(),
      apiKeys: {
        'siliconflow-api-key': 'siliconflow-main-secret',
        'memory-embedding': 'embedding-secret',
        'memory-extraction': 'extraction-secret',
        'sticker-indexer': 'sticker-secret',
      },
    });
    await service.loadAndApply(() => undefined);

    const options: ModelAuthConnectionCutoverOptions = {
      command: 'preflight',
      configPath,
      kekPath,
      backupPath: null,
      reportPath: null,
      systemctl,
      confirmServiceStopped: false,
      now: () => new Date('2026-07-27T10:00:00.000Z'),
    };
    const preflight = await runModelAuthConnectionCutover(options);
    expect(preflight.changed).toBe(true);
    expect(preflight.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        oldId: 'memory-embedding',
        newId: 'siliconflow',
        newDisplayName: 'SiliconFlow',
        credentialDisposition: 'discarded',
      }),
      expect.objectContaining({
        oldId: 'memory-extraction',
        newId: 'siliconflow',
        newDisplayName: 'SiliconFlow',
        credentialDisposition: 'discarded',
      }),
      expect.objectContaining({
        oldId: 'siliconflow-api-key',
        newId: 'siliconflow',
        credentialDisposition: 'retained',
      }),
      expect.objectContaining({
        oldId: 'sticker-indexer',
        newId: 'volcengine-ark-api-key',
        newDisplayName: 'Volcengine Ark API Key',
      }),
    ]));
    expect(JSON.stringify(preflight)).not.toContain('embedding-secret');

    const applied = await runModelAuthConnectionCutover({
      ...options,
      command: 'apply',
      backupPath,
      reportPath,
      confirmServiceStopped: true,
    });
    expect(applied.applied).toBe(true);
    expect(existsSync(backupPath)).toBe(true);
    expect(existsSync(reportPath)).toBe(true);

    const document = modelConfigDocumentSchema.parse(
      JSON.parse(readFileSync(configPath, 'utf8')),
    );
    expect(document.savedRevision).toBe(2);
    expect(document.appliedRevision).toBe(1);
    expect(document.connections.map((connection) => connection.displayName)).not.toEqual(
      expect.arrayContaining(['Memory embedding', 'Memory extraction', 'Sticker indexer']),
    );
    expect(document.bindings).toContainEqual(expect.objectContaining({
      workload: 'memory.embedding',
      connectionId: 'siliconflow',
      modelId: 'qwen-embedding',
    }));
    expect(document.bindings).toContainEqual(expect.objectContaining({
      workload: 'memory.extract',
      connectionId: 'siliconflow',
      modelId: 'qwen-extract',
    }));
    expect(document.connections.filter((connection) => (
      connection.baseUrl === 'https://api.siliconflow.cn/v1'
    ))).toHaveLength(1);

    const reloaded = new ModelConfigService({ configPath, kekPath });
    await reloaded.loadAndApply(() => undefined);
    expect(
      reloaded.getConnectionRuntime('siliconflow').connection.apiKey,
    ).toBe('siliconflow-main-secret');
    expect(
      reloaded.getConnectionRuntime('volcengine-ark-api-key').connection.apiKey,
    ).toBe('sticker-secret');
  });
});
