import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

const SCRIPT = resolve(process.cwd(), 'scripts/context-preset-cutover.mjs');
const BUILDER = resolve(
  process.cwd(),
  'scripts/build-context-preset-cutover-tools.mjs',
);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

function legacyPreset(id: string) {
  return {
    schemaVersion: 2,
    id,
    displayName: `Display ${id}`,
    aliases: [`alias-${id}`],
    messages: [{
      role: 'system',
      purpose: 'description',
      content: `role-${id}`,
    }],
    inputFormat: 'User: {prompt}',
    lore: {
      defaults: {
        tokenLimit: 640,
        scanDepth: 3,
        insertPosition: 'afterCharacterDefinitions',
      },
      entries: [{
        keywords: ['alpha'],
        content: 'after character',
      }, {
        keywords: ['beta'],
        content: 'before scenario',
        insertPosition: 'beforeScenario',
      }],
    },
    authorsNote: {
      content: 'author note',
      insertPosition: 'inChat',
      insertDepth: 2,
      insertFrequency: 3,
    },
    knowledge: {
      sources: ['memory://facts'],
      prompt: 'knowledge prompt',
    },
    promptConfig: {
      maxOutputToken: 2048,
      longMemoryPrompt: 'long memory',
      loreBooksPrompt: 'lore prompt',
      longMemoryExtractPrompt: 'extract memory',
      longMemoryNewQuestionPrompt: 'new question',
      reActInstruction: 'reason and act',
      postHandler: {
        id: 'reply',
        prefix: '<reply>',
        postfix: '</reply>',
        variables: {},
      },
    },
  };
}

function expectedRole(preset: ReturnType<typeof legacyPreset>) {
  return {
    schemaVersion: 1,
    id: preset.id,
    displayName: preset.displayName,
    messages: preset.messages,
  };
}

function expectedContext(preset: ReturnType<typeof legacyPreset>) {
  return {
    schemaVersion: 1,
    id: preset.id,
    displayName: preset.displayName,
    aliases: preset.aliases,
    blocks: [
      { id: 'role', type: 'role', rolePresetId: preset.id },
      {
        id: 'chat-history',
        type: 'chatHistory',
        enabled: true,
        budgetPriority: 100,
        maxTokens: null,
      },
      {
        id: 'request-documents',
        type: 'requestDocuments',
        enabled: true,
        budgetPriority: 50,
        maxTokens: null,
      },
      {
        id: 'lore-after-character-definitions',
        type: 'lore',
        enabled: true,
        budgetPriority: 310,
        maxTokens: 320,
        anchor: { type: 'role', position: 'afterCharacterDefinitions' },
        prompt: 'lore prompt',
        defaults: { scanDepth: 3 },
        entries: [{ keywords: ['alpha'], content: 'after character' }],
      },
      {
        id: 'lore-before-scenario',
        type: 'lore',
        enabled: true,
        budgetPriority: 311,
        maxTokens: 320,
        anchor: { type: 'role', position: 'beforeScenario' },
        prompt: 'lore prompt',
        defaults: { scanDepth: 3 },
        entries: [{ keywords: ['beta'], content: 'before scenario' }],
      },
      {
        id: 'authors-note',
        type: 'authorsNote',
        enabled: true,
        budgetPriority: 330,
        maxTokens: null,
        anchor: { type: 'chatHistory', depth: 2 },
        content: 'author note',
        insertFrequency: 3,
      },
      {
        id: 'knowledge',
        type: 'knowledge',
        enabled: true,
        budgetPriority: 340,
        maxTokens: null,
        sources: ['memory://facts'],
        prompt: 'knowledge prompt',
      },
      { id: 'current-input', type: 'currentInput', inputFormat: 'User: {prompt}' },
      {
        id: 'agent-scratchpad',
        type: 'agentScratchpad',
        enabled: true,
        budgetPriority: 400,
        maxTokens: null,
        reActInstruction: 'reason and act',
      },
      {
        id: 'model-output',
        type: 'modelOutput',
        maxOutputTokens: 2048,
        postHandler: {
          id: 'reply',
          prefix: '<reply>',
          postfix: '</reply>',
          variables: {},
        },
      },
    ],
  };
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-context-preset-cutover-'));
  roots.push(root);
  const paths = {
    root,
    database: join(root, 'koishi.db'),
    legacyBundled: join(root, 'legacy-bundled'),
    legacyRuntime: join(root, 'legacy-runtime'),
    bundledRole: join(root, 'new-bundled-role'),
    bundledContext: join(root, 'new-bundled-context'),
    runtimeRole: join(root, 'runtime-role'),
    runtimeContext: join(root, 'runtime-context'),
    backup: join(root, 'backup'),
    report: join(root, 'report.json'),
    systemctl: join(root, 'systemctl'),
  };
  for (const directory of [
    paths.legacyBundled,
    paths.legacyRuntime,
    paths.bundledRole,
    paths.bundledContext,
    paths.runtimeRole,
    paths.runtimeContext,
  ]) mkdirSync(directory, { recursive: true });
  const database = spawnSync('python3', ['-c', `
import json
import sqlite3
import sys
db = sqlite3.connect(sys.argv[1])
db.executescript("""
CREATE TABLE chatluna_conversation (id TEXT, bindingKey TEXT, preset TEXT);
CREATE TABLE chatluna_binding (bindingKey TEXT);
CREATE TABLE chatluna_constraint (
  activePresetLane TEXT,
  defaultPreset TEXT,
  fixedPreset TEXT
);
CREATE TABLE chatluna_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE chathub_room (roomId INTEGER, preset TEXT);
""")
db.execute(
  "INSERT INTO chatluna_conversation VALUES (?, ?, ?)",
  ("conversation-1", "shared:test:preset:runtime", "runtime"),
)
db.execute(
  "INSERT INTO chatluna_binding VALUES (?)",
  ("shared:test:preset:runtime",),
)
db.execute(
  "INSERT INTO chatluna_constraint VALUES (?, ?, ?)",
  ("runtime", "bundled", None),
)
db.execute(
  "INSERT INTO chatluna_meta VALUES (?, ?)",
  ("globalDefaultPresetId", json.dumps("bundled")),
)
db.execute("INSERT INTO chathub_room VALUES (?, ?)", (1, "bundled"))
db.commit()
db.close()
`, paths.database], { encoding: 'utf8' });
  if (database.status !== 0) throw new Error(database.stderr);
  writeFileSync(paths.systemctl, '#!/usr/bin/env bash\nexit 3\n', 'utf8');
  chmodSync(paths.systemctl, 0o700);
  const bundled = legacyPreset('bundled');
  const runtime = legacyPreset('runtime');
  writeFileSync(join(paths.legacyBundled, 'bundled.yml'), YAML.stringify(bundled));
  writeFileSync(join(paths.legacyRuntime, 'runtime.yml'), YAML.stringify(runtime));
  writeFileSync(join(paths.bundledRole, 'bundled.yml'), YAML.stringify(expectedRole(bundled)));
  writeFileSync(
    join(paths.bundledContext, 'bundled.yml'),
    YAML.stringify(expectedContext(bundled)),
  );
  return { paths, runtime };
}

function run(
  command: 'preflight' | 'apply',
  fixture: ReturnType<typeof createFixture>,
) {
  const { paths } = fixture;
  return spawnSync(process.execPath, [
    SCRIPT,
    command,
    '--database', paths.database,
    '--legacy-bundled-dir', paths.legacyBundled,
    '--legacy-runtime-dir', paths.legacyRuntime,
    '--bundled-role-dir', paths.bundledRole,
    '--bundled-context-dir', paths.bundledContext,
    '--runtime-role-dir', paths.runtimeRole,
    '--runtime-context-dir', paths.runtimeContext,
    '--report', paths.report,
    '--systemctl', paths.systemctl,
    ...(command === 'apply'
      ? ['--backup-dir', paths.backup, '--confirm-service-stopped']
      : []),
  ], { encoding: 'utf8' });
}

describe('context preset cutover', () => {
  it('preserves the legacy global Lore budget across every anchored block', async () => {
    const { migratePresetDefinition } = await import(pathToFileURL(SCRIPT).href);
    const configured = migratePresetDefinition(legacyPreset('configured')).contextPreset;
    const configuredLore = configured.blocks.filter((block: { type: string }) => (
      block.type === 'lore'
    ));
    expect(configuredLore).toHaveLength(2);
    expect(configuredLore.reduce((
      total: number,
      block: { maxTokens: number },
    ) => total + block.maxTokens, 0)).toBe(640);

    const defaulted = legacyPreset('defaulted');
    Reflect.deleteProperty(defaulted.lore.defaults, 'tokenLimit');
    const migratedDefault = migratePresetDefinition(defaulted).contextPreset;
    const defaultLore = migratedDefault.blocks.filter((block: { type: string }) => (
      block.type === 'lore'
    ));
    expect(defaultLore).toHaveLength(2);
    expect(defaultLore.map((block: { maxTokens: number }) => block.maxTokens))
      .toEqual([150, 150]);
  });

  it('builds a self-contained Node entrypoint with its SQLite backup helper', () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-context-preset-builder-'));
    roots.push(root);
    const output = join(root, 'tools');
    const result = spawnSync(process.execPath, [
      BUILDER,
      '--out-dir',
      output,
    ], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(output, 'context-preset-cutover.mjs'))).toBe(true);
    expect(existsSync(join(output, 'context-preset-sqlite.py'))).toBe(true);
  });

  it('preflights exact bundled migration without changing data', () => {
    const fixture = createFixture();
    const result = run('preflight', fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'preflight',
      bundledPresetCount: 1,
      runtimePresetCount: 1,
      databaseReferencesChanged: false,
      applied: false,
    });
    expect(existsSync(join(fixture.paths.runtimeRole, 'runtime.yml'))).toBe(false);
    expect(JSON.parse(readFileSync(fixture.paths.report, 'utf8'))).toMatchObject({
      database: {
        globalDefaultContextPresetId: 'bundled',
        unresolvedReferences: [],
        canonicalReferencesUnchanged: true,
      },
    });
  });

  it('backs up the database and legacy catalogs before installing both runtime catalogs', () => {
    const fixture = createFixture();
    const result = run('apply', fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(YAML.parse(readFileSync(
      join(fixture.paths.runtimeRole, 'runtime.yml'),
      'utf8',
    ))).toEqual(expectedRole(fixture.runtime));
    expect(YAML.parse(readFileSync(
      join(fixture.paths.runtimeContext, 'runtime.yml'),
      'utf8',
    ))).toEqual(expectedContext(fixture.runtime));
    const backup = spawnSync('python3', ['-c', `
import sqlite3
import sys
db = sqlite3.connect(sys.argv[1])
print(db.execute("SELECT preset FROM chatluna_conversation").fetchone()[0])
`, join(fixture.paths.backup, 'koishi.db')], { encoding: 'utf8' });
    expect(backup.status, backup.stderr).toBe(0);
    expect(backup.stdout.trim()).toBe('runtime');
    expect(existsSync(join(
      fixture.paths.backup,
      'legacy-runtime-presets',
      'runtime.yml',
    ))).toBe(true);
    expect(existsSync(join(fixture.paths.legacyRuntime, 'runtime.yml'))).toBe(true);
  });

  it('fails before writes when the bundled V1 catalogs lose migrated data', () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.paths.bundledRole, 'bundled.yml'),
      YAML.stringify({ ...expectedRole(legacyPreset('bundled')), messages: [] }),
    );
    const result = run('preflight', fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Bundled role migration mismatch: bundled');
    expect(existsSync(fixture.paths.report)).toBe(false);
  });

  it('rejects unsupported catalog entries instead of silently ignoring them', () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.paths.legacyRuntime, '.preset-order.json'), '{}\n');
    const result = run('preflight', fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'legacy runtime catalog contains an unsupported entry: .preset-order.json',
    );
  });

  it('refuses apply while qqbot.target is active', () => {
    const fixture = createFixture();
    writeFileSync(fixture.paths.systemctl, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
    const result = run('apply', fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('qqbot.target must be stopped');
    expect(existsSync(fixture.paths.backup)).toBe(false);
    expect(existsSync(join(fixture.paths.runtimeRole, 'runtime.yml'))).toBe(false);
  });

  it('refuses apply while qqbot-koishi.service is active', () => {
    const fixture = createFixture();
    writeFileSync(fixture.paths.systemctl, [
      '#!/usr/bin/env bash',
      'if [[ "${@: -1}" == "qqbot-koishi.service" ]]; then exit 0; fi',
      'exit 3',
      '',
    ].join('\n'), 'utf8');
    const result = run('apply', fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('qqbot-koishi.service must be stopped');
    expect(existsSync(fixture.paths.backup)).toBe(false);
  });

  it('rejects unresolved or persisted alias references', () => {
    const fixture = createFixture();
    const change = spawnSync('python3', ['-c', `
import sqlite3
import sys
db = sqlite3.connect(sys.argv[1])
db.execute("UPDATE chatluna_conversation SET preset = ?", ("alias-runtime",))
db.commit()
db.close()
`, fixture.paths.database], { encoding: 'utf8' });
    expect(change.status, change.stderr).toBe(0);
    const result = run('preflight', fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('persisted alias "alias-runtime" must be canonical "runtime"');
  });

  it('keeps a durable transaction and resumes when report persistence fails', async () => {
    const fixture = createFixture();
    writeFileSync(fixture.paths.report, 'occupied', 'utf8');
    const result = run('apply', fixture);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(fixture.paths.runtimeRole, 'runtime.yml'))).toBe(true);
    expect(existsSync(join(fixture.paths.runtimeContext, 'runtime.yml'))).toBe(true);
    expect(existsSync(join(fixture.paths.backup, 'koishi.db'))).toBe(true);
    await rm(fixture.paths.report);
    const resumed = run('apply', fixture);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(readFileSync(
      join(fixture.paths.root, '.context-role-v1-cutover.json'),
      'utf8',
    ))).toMatchObject({ phase: 'completed' });
  });

  it('recovers after the process is terminated between the two catalog installs', () => {
    const fixture = createFixture();
    const options = {
      command: 'apply',
      database: fixture.paths.database,
      legacyBundledDir: fixture.paths.legacyBundled,
      legacyRuntimeDir: fixture.paths.legacyRuntime,
      bundledRoleDir: fixture.paths.bundledRole,
      bundledContextDir: fixture.paths.bundledContext,
      runtimeRoleDir: fixture.paths.runtimeRole,
      runtimeContextDir: fixture.paths.runtimeContext,
      backupDir: fixture.paths.backup,
      report: fixture.paths.report,
      systemctl: fixture.paths.systemctl,
      confirmServiceStopped: true,
    };
    const terminated = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `
import { buildPlan, applyPlan } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
const options = JSON.parse(process.env.CUTOVER_OPTIONS);
const plan = await buildPlan(options);
const report = {
  ...plan.report,
  command: 'apply',
  applied: true,
  backupDir: options.backupDir,
};
await applyPlan(options, plan, report, {
  afterRoleInstall() {
    process.kill(process.pid, 'SIGKILL');
  },
});
`,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CUTOVER_OPTIONS: JSON.stringify(options),
      },
    });
    expect(terminated.signal).toBe('SIGKILL');
    expect(existsSync(join(fixture.paths.runtimeRole, 'runtime.yml'))).toBe(true);
    expect(existsSync(join(fixture.paths.runtimeContext, 'runtime.yml'))).toBe(false);

    const resumed = run('apply', fixture);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(existsSync(join(fixture.paths.runtimeContext, 'runtime.yml'))).toBe(true);
    expect(JSON.parse(readFileSync(
      join(fixture.paths.root, '.context-role-v1-cutover.json'),
      'utf8',
    ))).toMatchObject({ phase: 'completed' });
  });

  it('reinstalls completed catalogs after a surrounding deploy rollback restores empty targets', async () => {
    const fixture = createFixture();
    const applied = run('apply', fixture);
    expect(applied.status, applied.stderr).toBe(0);
    await rm(fixture.paths.runtimeRole, { recursive: true });
    await rm(fixture.paths.runtimeContext, { recursive: true });
    mkdirSync(fixture.paths.runtimeRole);
    mkdirSync(fixture.paths.runtimeContext);

    const resumed = run('apply', fixture);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(existsSync(join(fixture.paths.runtimeRole, 'runtime.yml'))).toBe(true);
    expect(existsSync(join(fixture.paths.runtimeContext, 'runtime.yml'))).toBe(true);
  });

  it('backs up committed WAL content through the SQLite backup API', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-context-preset-wal-'));
    roots.push(root);
    const source = join(root, 'source.db');
    const destination = join(root, 'backup.db');
    const writer = spawn('python3', ['-c', `
import sqlite3
import sys
import time
db = sqlite3.connect(sys.argv[1])
db.execute("PRAGMA journal_mode = WAL")
db.execute("PRAGMA wal_autocheckpoint = 0")
db.execute("CREATE TABLE values_table (value TEXT)")
db.execute("INSERT INTO values_table VALUES ('wal-row')")
db.commit()
print("ready", flush=True)
time.sleep(30)
`, source], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolveReady, reject) => {
      writer.stdout.once('data', () => resolveReady());
      writer.once('error', reject);
      writer.once('exit', (code) => {
        if (code !== null && code !== 0) reject(new Error(`writer exited ${code}`));
      });
    });
    try {
      const backup = spawnSync('python3', [
        resolve(process.cwd(), 'scripts/context-preset-sqlite.py'),
        'backup',
        source,
        destination,
      ], { encoding: 'utf8' });
      expect(backup.status, backup.stderr).toBe(0);
      const check = spawnSync('python3', ['-c', `
import sqlite3
import sys
db = sqlite3.connect(sys.argv[1])
print(db.execute("SELECT value FROM values_table").fetchone()[0])
`, destination], { encoding: 'utf8' });
      expect(check.status, check.stderr).toBe(0);
      expect(check.stdout.trim()).toBe('wal-row');
    } finally {
      writer.kill('SIGTERM');
    }
  });
});
