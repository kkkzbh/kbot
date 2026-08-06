import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { modelConfigDocumentSchema } from '../../src/plugins/model-config/types.js';
import { applyModelConfigV4, preflightModelConfigV4 } from '../../src/tools/model-config-v4-cutover.js';
import { createValidModelConfigDraft } from './fixtures.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function v3Document() {
  const draft = createValidModelConfigDraft();
  return {
    schemaVersion: 3, savedRevision: 7, appliedRevision: 7, updatedAt: '2026-08-01T00:00:00.000Z', migration: null,
    connections: draft.connections, models: draft.models,
    bindings: draft.bindings.filter((binding) => binding.workload !== 'groupSummary.generate'),
    secrets: [{ secretRef: 'connection:primary:api-key', connectionId: 'primary', cipherText: 'unchanged', meta: 'unchanged-meta' }],
  };
}

describe('Model Config V4 cutover', () => {
  it('adds the group summary workload while preserving existing config and secrets', async () => {
    const directory = await mkdtemp('/var/tmp/model-config-v4-'); directories.push(directory);
    const path = join(directory, 'model-config.json');
    await writeFile(path, `${JSON.stringify(v3Document(), null, 2)}\n`, { mode: 0o600 });
    const report = await preflightModelConfigV4(path);
    await applyModelConfigV4(path, report);
    const migrated = modelConfigDocumentSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    expect(migrated.schemaVersion).toBe(4);
    expect(migrated.savedRevision).toBe(8);
    expect(migrated.bindings).toContainEqual({ workload: 'groupSummary.generate', mode: 'inheritMain' });
    expect(migrated.secrets).toEqual(v3Document().secrets);
  });

  it('rejects drift after preflight', async () => {
    const directory = await mkdtemp('/var/tmp/model-config-v4-drift-'); directories.push(directory);
    const path = join(directory, 'model-config.json');
    await writeFile(path, JSON.stringify(v3Document()), { mode: 0o600 });
    const report = await preflightModelConfigV4(path);
    await writeFile(path, `${JSON.stringify(v3Document())}\n`);
    await expect(applyModelConfigV4(path, report)).rejects.toThrow('changed after V4 preflight');
  });
});
