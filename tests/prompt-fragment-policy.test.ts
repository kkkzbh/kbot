import { describe, expect, it } from 'vitest';
import {
  PromptFragmentPolicyService,
  type PromptFragmentPolicyDatabase,
} from '../src/plugins/prompt-fragment-policy/service.js';

function createDatabase(): PromptFragmentPolicyDatabase {
  const rows = new Map<string, Record<string, unknown>>();
  const database: PromptFragmentPolicyDatabase = {
    async get(_table, query) {
      const id = String(query.contextPresetId);
      const row = rows.get(id);
      return row ? [structuredClone(row)] : [];
    },
    async set(_table, query, data) {
      const id = String(query.contextPresetId);
      const row = rows.get(id);
      if (!row || Number(row.revision) !== Number(query.revision)) return;
      rows.set(id, { ...row, ...structuredClone(data) });
    },
    async create(_table, row) {
      const id = String(row.contextPresetId);
      if (rows.has(id)) throw new Error('duplicate context preset id');
      rows.set(id, structuredClone(row));
      return structuredClone(row);
    },
    async remove(_table, query) {
      const id = String(query.contextPresetId);
      const row = rows.get(id);
      if (row && Number(row.revision) === Number(query.revision)) rows.delete(id);
    },
    async withTransaction(operation) {
      return operation(database);
    },
  };
  return database;
}

describe('prompt fragment policy service', () => {
  it('uses an explicit all-enabled default and persists a per-preset override', async () => {
    const service = new PromptFragmentPolicyService(
      createDatabase(),
      () => Date.parse('2026-07-29T01:02:03.000Z'),
    );

    await expect(service.get('sakiko')).resolves.toEqual({
      contextPresetId: 'sakiko',
      revision: 0,
      source: 'default',
      updatedAt: null,
      config: {
        relationshipState: true,
        attachmentReferences: true,
        nativeCapabilities: true,
      },
    });

    await expect(service.put('sakiko', {
      expectedRevision: 0,
      config: {
        relationshipState: false,
        attachmentReferences: true,
        nativeCapabilities: false,
      },
    })).resolves.toEqual({
      contextPresetId: 'sakiko',
      revision: 1,
      source: 'override',
      updatedAt: '2026-07-29T01:02:03.000Z',
      config: {
        relationshipState: false,
        attachmentReferences: true,
        nativeCapabilities: false,
      },
    });
  });

  it('rejects stale revisions and resets only the requested preset', async () => {
    const service = new PromptFragmentPolicyService(createDatabase());
    await service.put('sakiko', {
      expectedRevision: 0,
      config: {
        relationshipState: false,
        attachmentReferences: false,
        nativeCapabilities: true,
      },
    });
    await service.put('empty', {
      expectedRevision: 0,
      config: {
        relationshipState: true,
        attachmentReferences: false,
        nativeCapabilities: false,
      },
    });

    await expect(service.put('sakiko', {
      expectedRevision: 0,
      config: {
        relationshipState: true,
        attachmentReferences: true,
        nativeCapabilities: true,
      },
    })).rejects.toMatchObject({
      code: 'revision_conflict',
      details: expect.objectContaining({
        expectedRevision: 0,
        actualRevision: 1,
      }),
    });

    await expect(service.reset('sakiko', 1)).resolves.toMatchObject({
      revision: 0,
      source: 'default',
    });
    await expect(service.get('empty')).resolves.toMatchObject({
      revision: 1,
      source: 'override',
    });
  });
});
