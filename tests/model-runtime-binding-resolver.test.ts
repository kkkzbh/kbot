import { describe, expect, it } from 'vitest';
import { createChatLunaResolver } from '../src/plugins/model-runtime/binding-resolver.js';
import type { ModelRuntimeSnapshot } from '../src/plugins/model-config/index.js';
import { createValidModelConfigDraft } from './model-config/fixtures.js';

function createSnapshot(): ModelRuntimeSnapshot {
  const draft = createValidModelConfigDraft();
  return {
    revision: 7,
    connections: draft.connections.map((connection) => ({
      ...connection,
      apiKey: null,
    })),
    models: draft.models,
    bindings: draft.bindings,
  };
}

describe('ChatLuna model binding resolver', () => {
  it('publishes the upstream optional embedding workload as explicitly disabled', async () => {
    const resolver = createChatLunaResolver(createSnapshot());

    expect(await resolver({
      workload: 'chatluna.defaultEmbedding',
    })).toEqual({
      mode: 'disabled',
      revision: 7,
    });
  });

  it('continues to resolve canonical QQBot workloads from Model Config V3', async () => {
    const resolver = createChatLunaResolver(createSnapshot());

    expect(await resolver({
      workload: 'main.chat',
    })).toEqual({
      mode: 'dedicated',
      model: 'qqbot-primary/primary-chat',
      revision: 7,
    });
  });
});
