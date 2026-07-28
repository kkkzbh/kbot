import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  applyNaturalTriggerCutover,
  preflightNaturalTriggerCutover,
} from '../src/tools/natural-trigger-cutover.js';
import { naturalTriggerConfigDocumentSchema } from '../src/plugins/natural-trigger-config/types.js';

const LEGACY_ENV = `CHAT_NATURAL_TRIGGER_ENABLED=true
CHAT_NATURAL_TRIGGER_GROUPS=100,200
CHAT_NATURAL_TRIGGER_ALIASES=祥子,saki,Saki
CHAT_NATURAL_TRIGGER_DIRECT_PROBABILITY=0.25
CHAT_NATURAL_TRIGGER_FOCUS_WINDOW_MS=300000
CHAT_NATURAL_TRIGGER_REPLY_INTERVAL_MS=2000
CHAT_NATURAL_TRIGGER_SPAM_WINDOW_MS=10000
CHAT_NATURAL_TRIGGER_SPAM_THRESHOLD=10
CHAT_NATURAL_TRIGGER_SPAM_MUTE_MS=180000
CHAT_NATURAL_TRIGGER_DECISION_MIN_CONFIDENCE=0.62
CHAT_NATURAL_TRIGGER_DECISION_API_KEY=secret
UNCHANGED_KEY=kept
`;

describe('natural trigger cutover', () => {
  it('preserves behavior, removes disabled groups, and cleans legacy ownership', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-natural-cutover-'));
    const envPath = join(directory, '.env.server');
    const overrideEnvPath = join(directory, '.env.runtime');
    const databasePath = join(directory, 'koishi.db');
    const configPath = join(directory, 'natural-trigger.json');
    await writeFile(envPath, LEGACY_ENV);
    await writeFile(
      overrideEnvPath,
      'CHAT_NATURAL_TRIGGER_DIRECT_PROBABILITY=0.1\nRUNTIME_KEY=kept\n',
    );
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE feature_scope_override (
        id INTEGER PRIMARY KEY,
        featureKey TEXT NOT NULL,
        scopeKind TEXT NOT NULL,
        scopeId TEXT NOT NULL,
        enabled INTEGER NOT NULL
      );
      INSERT INTO feature_scope_override
        (featureKey, scopeKind, scopeId, enabled)
      VALUES
        ('CHAT_NATURAL_TRIGGER_ENABLED', 'group', '200', 0),
        ('QQ_VOICE_INPUT_ENABLED', 'group', '200', 0);
    `);
    database.close();

    const report = await preflightNaturalTriggerCutover({
      envPath,
      overrideEnvPath,
      databasePath,
      configPath,
    });
    expect(report.mode).toBe('create');
    expect(report.config.allowedGroupIds).toEqual(['100']);
    expect(report.config.mechanisms.alias.aliases).toEqual(['祥子', 'saki']);

    await applyNaturalTriggerCutover({
      envPath,
      overrideEnvPath,
      databasePath,
      configPath,
      report,
    });
    const document = naturalTriggerConfigDocumentSchema.parse(
      JSON.parse(await readFile(configPath, 'utf8')),
    );
    expect(document).toEqual(expect.objectContaining({
      savedRevision: 1,
      appliedRevision: 0,
    }));
    expect(document.config.mechanisms.random).toEqual({
      enabled: true,
      probability: 0.1,
    });

    const env = await readFile(envPath, 'utf8');
    expect(env).toContain(`QQBOT_NATURAL_TRIGGER_CONFIG_PATH=${configPath}`);
    expect(env).toContain('HBU_JW_NATURAL_TRIGGER_ENABLED=true');
    expect(env).toContain('CHAOXING_NATURAL_TRIGGER_GROUPS=100,200');
    expect(env).toContain('GENSHIN_NATURAL_TRIGGER_GROUPS=100,200');
    expect(env).toContain('UNCHANGED_KEY=kept');
    expect(env).not.toContain('CHAT_NATURAL_TRIGGER_');
    expect(env).not.toContain('secret');
    const overrideEnv = await readFile(overrideEnvPath, 'utf8');
    expect(overrideEnv).toBe('RUNTIME_KEY=kept\n');

    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    expect(migrated.prepare(
      'SELECT featureKey FROM feature_scope_override ORDER BY id',
    ).all()).toEqual([{ featureKey: 'QQ_VOICE_INPUT_ENABLED' }]);
    migrated.close();

    const secondReport = await preflightNaturalTriggerCutover({
      envPath,
      overrideEnvPath,
      databasePath,
      configPath,
    });
    expect(secondReport.mode).toBe('validate');
    await expect(applyNaturalTriggerCutover({
      envPath,
      overrideEnvPath,
      databasePath,
      configPath,
      report: secondReport,
    })).resolves.toEqual(document);
  });
});
