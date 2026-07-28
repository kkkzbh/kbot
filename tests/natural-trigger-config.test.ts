import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NaturalTriggerConfigService,
} from '../src/plugins/natural-trigger-config/service.js';
import {
  naturalTriggerConfigDocumentSchema,
  naturalTriggerConfigSchema,
  type NaturalTriggerConfig,
} from '../src/plugins/natural-trigger-config/types.js';
import {
  writeNaturalTriggerConfigDocumentAtomic,
} from '../src/plugins/natural-trigger-config/store.js';

function config(): NaturalTriggerConfig {
  return {
    enabled: true,
    allowedGroupIds: ['100'],
    voiceAdmission: { enabled: true },
    mechanisms: {
      quote: { enabled: true },
      alias: { enabled: true, aliases: ['祥子', 'saki'] },
      heuristic: { enabled: true },
      focus: { enabled: true, windowMs: 300_000 },
      random: { enabled: true, probability: 0.25 },
    },
    modelDecision: { minConfidence: 0.62 },
    pacing: { minReplyIntervalMs: 2_000 },
    antiSpam: {
      enabled: true,
      windowMs: 10_000,
      threshold: 10,
      muteMs: 180_000,
    },
  };
}

describe('natural trigger config domain', () => {
  it('rejects duplicate group ids and case-insensitive aliases', () => {
    const duplicateGroups = config();
    duplicateGroups.allowedGroupIds = ['100', '100'];
    expect(naturalTriggerConfigSchema.safeParse(duplicateGroups).success).toBe(false);

    const duplicateAliases = config();
    duplicateAliases.mechanisms.alias.aliases = ['Saki', 'saki'];
    expect(naturalTriggerConfigSchema.safeParse(duplicateAliases).success).toBe(false);
  });

  it('loads the saved revision, marks it applied, and keeps saves pending', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-natural-trigger-'));
    const path = join(directory, 'natural-trigger.json');
    await writeNaturalTriggerConfigDocumentAtomic(path, {
      schemaVersion: 1,
      savedRevision: 1,
      appliedRevision: 0,
      updatedAt: '2026-07-28T00:00:00.000Z',
      config: config(),
    });
    const service = new NaturalTriggerConfigService({
      configPath: path,
      now: () => new Date('2026-07-28T01:00:00.000Z'),
    });
    const runtime = await service.loadAndApply();
    expect(runtime.revision).toBe(1);
    expect(service.getState()).toEqual(expect.objectContaining({
      savedRevision: 1,
      appliedRevision: 1,
      pending: false,
    }));

    const next = config();
    next.mechanisms.random.probability = 0.1;
    const saved = await service.put({ expectedRevision: 1, config: next });
    expect(saved).toEqual(expect.objectContaining({
      savedRevision: 2,
      appliedRevision: 1,
      pending: true,
    }));
    expect(service.getRuntimeSnapshot().revision).toBe(1);
    expect(service.getRuntimeSnapshot().config.mechanisms.random.probability).toBe(0.25);

    const persisted = naturalTriggerConfigDocumentSchema.parse(
      JSON.parse(await readFile(path, 'utf8')),
    );
    expect(persisted.savedRevision).toBe(2);
    expect(await readdir(directory)).toEqual(['natural-trigger.json']);
  });

  it('returns a typed conflict when expectedRevision is stale', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-natural-trigger-'));
    const path = join(directory, 'natural-trigger.json');
    await writeFile(path, `${JSON.stringify({
      schemaVersion: 1,
      savedRevision: 3,
      appliedRevision: 3,
      updatedAt: '2026-07-28T00:00:00.000Z',
      config: config(),
    })}\n`);
    const service = new NaturalTriggerConfigService({ configPath: path });
    await service.loadAndApply();
    await expect(service.put({ expectedRevision: 2, config: config() }))
      .rejects.toMatchObject({
        code: 'revision_conflict',
        httpStatus: 409,
      });
  });

  it('fails startup for a missing or invalid document', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-natural-trigger-'));
    await expect(
      new NaturalTriggerConfigService({
        configPath: join(directory, 'missing.json'),
      }).loadAndApply(),
    ).rejects.toMatchObject({ code: 'config_not_found' });

    const invalidPath = join(directory, 'invalid.json');
    await writeFile(invalidPath, '{}\n');
    await expect(
      new NaturalTriggerConfigService({ configPath: invalidPath }).loadAndApply(),
    ).rejects.toMatchObject({ code: 'schema_invalid' });
  });
});
