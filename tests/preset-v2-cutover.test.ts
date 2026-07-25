import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = resolve(process.cwd(), 'scripts/preset-v2-cutover.mjs');
const SQLITE_HELPER_PATH = resolve(process.cwd(), 'scripts/preset-v2-sqlite.py');
const TOOL_BUILDER_PATH = resolve(process.cwd(), 'scripts/build-preset-v2-cutover-tools.mjs');
const BUNDLED_DIR = resolve(process.cwd(), 'data/chathub/presets');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function createFixture(): {
  root: string;
  database: string;
  runtimeDir: string;
  archiveSourceRoot: string;
  archiveTargetRoot: string;
  archiveDir: string;
  archiveTargetDir: string;
  systemctl: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-preset-v2-cutover-'));
  tempDirs.push(root);
  const database = join(root, 'koishi.db');
  const runtimeDir = join(root, 'runtime-presets');
  const archiveSourceRoot = join(root, 'legacy-app-archive');
  const archiveTargetRoot = join(root, 'persistent-archive');
  const archiveDir = join(archiveSourceRoot, 'conversation-1');
  const archiveTargetDir = join(archiveTargetRoot, 'conversation-1');
  const systemctl = join(root, 'systemctl');
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(archiveTargetRoot, { recursive: true });
  writeSystemctl(systemctl, 'inactive');

  execFileSync('sqlite3', [
    database,
    `
create table chatluna_conversation (
  id text primary key,
  seq integer null,
  bindingKey text not null,
  preset text not null,
  createdAt integer not null,
  updatedAt integer not null
);
create table chatluna_binding (
  bindingKey text primary key,
  activeConversationId text null,
  lastConversationId text null,
  updatedAt integer not null
);
create table chatluna_constraint (
  id integer primary key,
  activePresetLane text null,
  defaultPreset text null,
  fixedPreset text null
);
create table chatluna_meta (
  key text primary key,
  value text null,
  updatedAt integer not null
);
create table chathub_room (
  roomId integer primary key,
  preset text null
);
create table chatluna_archive (
  id text primary key,
  path text not null,
  state text not null
);
insert into chatluna_conversation values
  ('conversation-1', 1, 'personal:onebot:1:direct:2:preset:小祥', 'saki', 1000, 1000);
insert into chatluna_binding values
  ('personal:onebot:1:direct:2:preset:祥', 'conversation-1', null, 1000);
insert into chatluna_constraint values
  (1, '小祥', 'saki', 'sakiko');
insert into chathub_room values
  (1, 'Oblivionis');
insert into chatluna_archive values
  ('archive-1', '${archiveDir.replaceAll("'", "''")}', 'ready');
    `,
  ]);

  writeFileSync(
    join(archiveDir, 'conversation.json'),
    `${JSON.stringify({
      id: 'conversation-1',
      bindingKey: 'personal:onebot:1:direct:2:preset:saki',
      preset: '小祥',
    }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(runtimeDir, 'legacy.txt'),
    YAML.stringify({
      keywords: ['legacy', 'Legacy Alias', 'legacy alias'],
      prompts: [{ role: 'system', type: 'description', content: 'Legacy runtime preset.' }],
    }),
    'utf8',
  );
  return {
    root,
    database,
    runtimeDir,
    archiveSourceRoot,
    archiveTargetRoot,
    archiveDir,
    archiveTargetDir,
    systemctl,
  };
}

function writeSystemctl(path: string, activeState: 'active' | 'inactive'): void {
  writeFileSync(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" != "show" || "$3" != "--value" ]]; then
  exit 2
fi
case "$2" in
  --property=LoadState) printf 'loaded\\n' ;;
  --property=ActiveState) printf '${activeState}\\n' ;;
  *) exit 2 ;;
esac
`,
    { encoding: 'utf8', mode: 0o700 },
  );
}

function sqlite(database: string, sql: string): string {
  return execFileSync('sqlite3', [database, sql], { encoding: 'utf8' }).trim();
}

function baseArgs(fixture: ReturnType<typeof createFixture>): string[] {
  return [
    '--database',
    fixture.database,
    '--bundled-dir',
    BUNDLED_DIR,
    '--runtime-dir',
    fixture.runtimeDir,
    '--archive-source-root',
    fixture.archiveSourceRoot,
    '--archive-target-root',
    fixture.archiveTargetRoot,
    '--global-default',
    'saki',
    '--systemctl',
    fixture.systemctl,
  ];
}

describe('Preset V2 cutover tool', () => {
  it('preflights and atomically applies canonical references, archives, and runtime YAML', () => {
    const fixture = createFixture();
    const preflight = JSON.parse(execFileSync(
      process.execPath,
      [SCRIPT_PATH, 'preflight', ...baseArgs(fixture)],
      { encoding: 'utf8' },
    )) as {
      globalDefaultPresetId: string;
      summary: {
        migratedV1FileCount: number;
        databaseChangeCount: number;
        bindingMergeCount: number;
        conversationSeqRenumberCount: number;
        archiveChangeCount: number;
      };
    };

    expect(preflight.globalDefaultPresetId).toBe('sakiko');
    expect(preflight.summary).toMatchObject({
      migratedV1FileCount: 1,
      databaseChangeCount: 6,
      bindingMergeCount: 0,
      conversationSeqRenumberCount: 0,
      archiveChangeCount: 1,
    });

    const backupDir = join(fixture.root, 'backup');
    const sourceArchiveBefore = readFileSync(
      join(fixture.archiveDir, 'conversation.json'),
      'utf8',
    );
    const report = JSON.parse(execFileSync(
      process.execPath,
      [
        SCRIPT_PATH,
        'apply',
        ...baseArgs(fixture),
        '--backup-dir',
        backupDir,
        '--confirm-service-stopped',
      ],
      { encoding: 'utf8' },
    )) as {
      rollbackRuntimeDir: string;
      finalize: {
        required: boolean;
        legacyArchiveSourceRoot: string;
        legacyArchiveRetentionRoot: string;
        action: string;
      };
    };

    expect(sqlite(
      fixture.database,
      "select preset || '|' || bindingKey from chatluna_conversation where id = 'conversation-1';",
    )).toBe('sakiko|personal:onebot:1:direct:2:preset:sakiko');
    expect(sqlite(
      fixture.database,
      'select bindingKey from chatluna_binding;',
    )).toBe('personal:onebot:1:direct:2:preset:sakiko');
    expect(sqlite(
      fixture.database,
      "select activePresetLane || '|' || defaultPreset || '|' || fixedPreset from chatluna_constraint;",
    )).toBe('sakiko|sakiko|sakiko');
    expect(sqlite(fixture.database, 'select preset from chathub_room;')).toBe('sakiko');
    expect(sqlite(
      fixture.database,
      "select value from chatluna_meta where key = 'globalDefaultPresetId';",
    )).toBe('"sakiko"');
    expect(sqlite(
      fixture.database,
      "select path from chatluna_archive where id = 'archive-1';",
    )).toBe(fixture.archiveTargetDir);

    const archive = JSON.parse(
      readFileSync(join(fixture.archiveTargetDir, 'conversation.json'), 'utf8'),
    ) as {
      preset: string;
      bindingKey: string;
    };
    expect(archive).toMatchObject({
      preset: 'sakiko',
      bindingKey: 'personal:onebot:1:direct:2:preset:sakiko',
    });
    expect(readFileSync(join(fixture.archiveDir, 'conversation.json'), 'utf8')).toBe(
      sourceArchiveBefore,
    );

    const runtimePreset = YAML.parse(readFileSync(join(fixture.runtimeDir, 'legacy.yml'), 'utf8')) as {
      schemaVersion: number;
      id: string;
      aliases: string[];
    };
    expect(runtimePreset).toMatchObject({
      schemaVersion: 2,
      id: 'legacy',
      aliases: ['Legacy Alias'],
    });
    expect(existsSync(join(backupDir, 'koishi.db'))).toBe(true);
    expect(existsSync(join(backupDir, 'preflight-report.json'))).toBe(true);
    expect(existsSync(report.rollbackRuntimeDir)).toBe(true);
    expect(statSync(backupDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(backupDir, 'koishi.db')).mode & 0o777).toBe(0o600);
    expect(statSync(join(backupDir, 'preflight-report.json')).mode & 0o777).toBe(0o600);
    expect(report.finalize).toEqual({
      required: true,
      legacyArchiveSourceRoot: fixture.archiveSourceRoot,
      legacyArchiveRetentionRoot: join(backupDir, 'legacy-archive-source'),
      action: 'Retain the legacy source until the documented post-cutover finalize step.',
    });
    expect(readFileSync(
      join(backupDir, 'legacy-archive-source/conversation-1/conversation.json'),
      'utf8',
    )).toBe(sourceArchiveBefore);
  });

  it('merges saki, 小祥, and 祥 bindings and deterministically repairs colliding sequences', () => {
    const fixture = createFixture();
    execFileSync('sqlite3', [
      fixture.database,
      `
delete from chatluna_conversation;
delete from chatluna_binding;
insert into chatluna_conversation values
  ('c-saki', 1, 'personal:onebot:1:direct:2:preset:saki', 'saki', 100, 1000),
  ('c-xiaoxiang', 1, 'personal:onebot:1:direct:2:preset:小祥', '小祥', 200, 2000),
  ('c-xiang', 2, 'personal:onebot:1:direct:2:preset:祥', '祥', 300, 3000),
  ('c-extra', 3, 'personal:onebot:1:direct:2:preset:祥', 'sakiko', 400, 4000);
insert into chatluna_binding values
  ('personal:onebot:1:direct:2:preset:saki', 'c-saki', 'c-xiang', 1000),
  ('personal:onebot:1:direct:2:preset:小祥', 'c-xiaoxiang', 'c-saki', 3000),
  ('personal:onebot:1:direct:2:preset:祥', 'c-xiang', 'c-extra', 2000);
      `,
    ]);

    const preflight = JSON.parse(execFileSync(
      process.execPath,
      [SCRIPT_PATH, 'preflight', ...baseArgs(fixture)],
      { encoding: 'utf8' },
    )) as {
      bindingMerges: Array<{
        targetBindingKey: string;
        sourceBindingKeys: string[];
        removedSourceBindingKeys: string[];
        activeConversationId: string;
        lastConversationId: string;
        updatedAt: number;
      }>;
      conversationSeqRenumbers: Array<{
        targetBindingKey: string;
        conversationId: string;
        from: number;
        to: number;
      }>;
      summary: {
        bindingMergeCount: number;
        bindingRowsRemovedCount: number;
        conversationSeqRenumberCount: number;
      };
    };

    const canonicalBinding = 'personal:onebot:1:direct:2:preset:sakiko';
    expect(preflight.bindingMerges).toEqual([{
      targetBindingKey: canonicalBinding,
      sourceBindingKeys: [
        'personal:onebot:1:direct:2:preset:saki',
        'personal:onebot:1:direct:2:preset:小祥',
        'personal:onebot:1:direct:2:preset:祥',
      ],
      keeperSourceBindingKey: 'personal:onebot:1:direct:2:preset:saki',
      removedSourceBindingKeys: [
        'personal:onebot:1:direct:2:preset:小祥',
        'personal:onebot:1:direct:2:preset:祥',
      ],
      activeConversationId: 'c-xiaoxiang',
      lastConversationId: 'c-saki',
      updatedAt: 3000,
      excludedCandidates: [],
    }]);
    expect(preflight.conversationSeqRenumbers).toEqual([{
      targetBindingKey: canonicalBinding,
      conversationId: 'c-xiaoxiang',
      sourceBindingKey: 'personal:onebot:1:direct:2:preset:小祥',
      from: 1,
      to: 4,
      createdAt: 200,
    }]);
    expect(preflight.summary).toMatchObject({
      bindingMergeCount: 1,
      bindingRowsRemovedCount: 2,
      conversationSeqRenumberCount: 1,
    });

    execFileSync(process.execPath, [
      SCRIPT_PATH,
      'apply',
      ...baseArgs(fixture),
      '--backup-dir',
      join(fixture.root, 'backup-merged-bindings'),
      '--confirm-service-stopped',
    ]);

    expect(sqlite(
      fixture.database,
      'select count(*) from chatluna_conversation;',
    )).toBe('4');
    expect(sqlite(
      fixture.database,
      `select count(*) || '|' || count(distinct seq) || '|' || min(seq)
       from chatluna_conversation where bindingKey = '${canonicalBinding}';`,
    )).toBe('4|4|1');
    expect(sqlite(
      fixture.database,
      'select id || \':\' || seq from chatluna_conversation order by seq;',
    )).toBe('c-saki:1\nc-xiang:2\nc-extra:3\nc-xiaoxiang:4');
    expect(sqlite(
      fixture.database,
      `select bindingKey || '|' || activeConversationId || '|'
        || lastConversationId || '|' || updatedAt from chatluna_binding;`,
    )).toBe(`${canonicalBinding}|c-xiaoxiang|c-saki|3000`);
    expect(sqlite(
      fixture.database,
      'select count(*) from chatluna_binding;',
    )).toBe('1');
  });

  it('fails preflight on an unknown persisted preset identity without changing data', () => {
    const fixture = createFixture();
    execFileSync(
      'sqlite3',
      [fixture.database, "update chatluna_conversation set preset = 'unknown-preset';"],
    );

    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, 'preflight', ...baseArgs(fixture)],
      { encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('chatluna_conversation(conversation-1).preset');
    expect(result.stderr).toContain('Unknown preset reference: unknown-preset');
    expect(sqlite(
      fixture.database,
      "select preset from chatluna_conversation where id = 'conversation-1';",
    )).toBe('unknown-preset');
  });

  it('fails preflight when an alias collision has no explicit owner', () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.runtimeDir, 'rival.yml'),
      YAML.stringify({
        keywords: ['rival', '猫娘'],
        prompts: [{ role: 'system', content: 'Conflicting runtime preset.' }],
      }),
      'utf8',
    );

    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, 'preflight', ...baseArgs(fixture)],
      { encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Preset identity is ambiguous');
    expect(result.stderr).toContain('猫娘');
  });

  it('fails preflight when one source layer declares a duplicate canonical ID', () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.runtimeDir, 'legacy.yml'),
      YAML.stringify({
        schemaVersion: 2,
        id: 'legacy',
        displayName: 'Duplicate Legacy',
        aliases: [],
        messages: [],
        inputFormat: null,
        lore: { defaults: {}, entries: [] },
        authorsNote: null,
        knowledge: null,
        promptConfig: {},
      }),
      'utf8',
    );

    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, 'preflight', ...baseArgs(fixture)],
      { encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Duplicate canonical preset ID');
    expect(result.stderr).toContain('legacy');
  });

  it('migrates a recoverable single-file gzip archive', () => {
    const fixture = createFixture();
    const gzipArchive = join(fixture.archiveSourceRoot, 'conversation-1.gz');
    const targetGzipArchive = join(fixture.archiveTargetRoot, 'conversation-1.gz');
    writeFileSync(gzipArchive, gzipSync(JSON.stringify({
      formatVersion: 1,
      exportedAt: '2026-07-25T00:00:00.000Z',
      conversation: {
        id: 'conversation-1',
        bindingKey: 'personal:onebot:1:direct:2:preset:saki',
        preset: '小祥',
      },
      messages: [],
    })));
    execFileSync('sqlite3', [
      fixture.database,
      `update chatluna_archive set path = '${gzipArchive.replaceAll("'", "''")}';`,
    ]);
    rmSync(fixture.archiveDir, { recursive: true });

    execFileSync(process.execPath, [
      SCRIPT_PATH,
      'apply',
      ...baseArgs(fixture),
      '--backup-dir',
      join(fixture.root, 'backup-gzip'),
      '--confirm-service-stopped',
    ]);

    const payload = JSON.parse(
      gunzipSync(readFileSync(targetGzipArchive)).toString('utf8'),
    ) as {
      conversation: { preset: string; bindingKey: string };
    };
    expect(payload.conversation).toMatchObject({
      preset: 'sakiko',
      bindingKey: 'personal:onebot:1:direct:2:preset:sakiko',
    });
    const sourcePayload = JSON.parse(gunzipSync(readFileSync(gzipArchive)).toString('utf8')) as {
      conversation: { preset: string };
    };
    expect(sourcePayload.conversation.preset).toBe('小祥');
    expect(sqlite(
      fixture.database,
      "select path from chatluna_archive where id = 'archive-1';",
    )).toBe(targetGzipArchive);
  });

  it('rejects archive paths containing symlinks or escaping the trusted root', () => {
    const fixture = createFixture();
    const outside = join(fixture.root, 'outside-archive');
    mkdirSync(outside);
    writeFileSync(
      join(outside, 'conversation.json'),
      JSON.stringify({
        id: 'conversation-1',
        bindingKey: 'personal:onebot:1:direct:2:preset:saki',
        preset: '小祥',
      }),
      'utf8',
    );
    rmSync(fixture.archiveDir, { recursive: true });
    symlinkSync(outside, fixture.archiveDir);

    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, 'preflight', ...baseArgs(fixture)],
      { encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/symlink|trusted archive root/u);
  });

  it('rejects overlapping cutover paths before writing any artifact', () => {
    const fixture = createFixture();
    const reportOverDatabase = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        'preflight',
        ...baseArgs(fixture),
        '--report',
        fixture.database,
      ],
      { encoding: 'utf8' },
    );
    expect(reportOverDatabase.status).not.toBe(0);
    expect(reportOverDatabase.stderr).toContain('must use separate paths');
    expect(sqlite(
      fixture.database,
      "select preset from chatluna_conversation where id = 'conversation-1';",
    )).toBe('saki');

    const backupInsideRuntime = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        'apply',
        ...baseArgs(fixture),
        '--backup-dir',
        join(fixture.runtimeDir, 'backup'),
        '--confirm-service-stopped',
      ],
      { encoding: 'utf8' },
    );
    expect(backupInsideRuntime.status).not.toBe(0);
    expect(backupInsideRuntime.stderr).toContain('must use separate paths');
    expect(existsSync(join(fixture.runtimeDir, 'legacy.txt'))).toBe(true);
  });

  it('rejects symlinked preset entries during preflight', () => {
    const fixture = createFixture();
    const outside = join(fixture.root, 'outside-preset.yml');
    writeFileSync(outside, 'keywords: [outside]\nprompts: []\n', 'utf8');
    symlinkSync(outside, join(fixture.runtimeDir, 'outside.yml'));

    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, 'preflight', ...baseArgs(fixture)],
      { encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Preset entry must be a real regular file');
  });

  it('requires the real systemd units to be inactive before apply', () => {
    const fixture = createFixture();
    writeSystemctl(fixture.systemctl, 'active');

    const result = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        'apply',
        ...baseArgs(fixture),
        '--backup-dir',
        join(fixture.root, 'backup-active'),
        '--confirm-service-stopped',
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must be inactive');
    expect(existsSync(join(fixture.root, 'backup-active'))).toBe(false);
    expect(sqlite(
      fixture.database,
      "select preset from chatluna_conversation where id = 'conversation-1';",
    )).toBe('saki');
  });

  it('preserves a pre-existing preset staging directory when apply rejects it', () => {
    const fixture = createFixture();
    const stagingDir = `${fixture.runtimeDir}.v2-staging`;
    const sentinel = join(stagingDir, 'owned-by-operator.txt');
    mkdirSync(stagingDir, { recursive: false });
    writeFileSync(sentinel, 'keep\n', 'utf8');

    const result = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        'apply',
        ...baseArgs(fixture),
        '--backup-dir',
        join(fixture.root, 'backup-existing-staging'),
        '--confirm-service-stopped',
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Staging directory already exists');
    expect(readFileSync(sentinel, 'utf8')).toBe('keep\n');
    expect(sqlite(
      fixture.database,
      "select preset from chatluna_conversation where id = 'conversation-1';",
    )).toBe('saki');
  });

  it('preserves database drift rejected by the top-level apply CAS check', () => {
    const fixture = createFixture();
    const fakeBin = join(fixture.root, 'fake-bin');
    const pythonWrapper = join(fakeBin, 'python3');
    const realPython = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();
    mkdirSync(fakeBin, { recursive: false });
    writeFileSync(
      pythonWrapper,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$2" == "apply" ]]; then
  sqlite3 "$3" "update chatluna_conversation set seq = 9 where id = 'conversation-1';"
fi
exec ${JSON.stringify(realPython)} "$@"
`,
      { encoding: 'utf8', mode: 0o700 },
    );

    const result = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        'apply',
        ...baseArgs(fixture),
        '--backup-dir',
        join(fixture.root, 'backup-drift'),
        '--confirm-service-stopped',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('database preset state changed after preflight');
    expect(sqlite(
      fixture.database,
      "select seq || '|' || preset from chatluna_conversation where id = 'conversation-1';",
    )).toBe('9|saki');
    expect(sqlite(
      fixture.database,
      "select value from chatluna_meta where key = 'globalDefaultPresetId';",
    )).toBe('');
    expect(existsSync(fixture.archiveTargetDir)).toBe(false);
    expect(existsSync(`${fixture.runtimeDir}.v2-staging`)).toBe(false);
  });

  it('restores the database and removes relocated archives after a post-database fault', () => {
    const fixture = createFixture();
    const sourceArchiveBefore = readFileSync(
      join(fixture.archiveDir, 'conversation.json'),
      'utf8',
    );
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        'apply',
        ...baseArgs(fixture),
        '--backup-dir',
        join(fixture.root, 'backup-fault'),
        '--confirm-service-stopped',
        '--fault-after-database-apply',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          QQBOT_PRESET_V2_ENABLE_FAULT_INJECTION: '1',
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Injected failure after database apply');
    expect(sqlite(
      fixture.database,
      "select preset || '|' || bindingKey from chatluna_conversation where id = 'conversation-1';",
    )).toBe('saki|personal:onebot:1:direct:2:preset:小祥');
    expect(sqlite(
      fixture.database,
      "select path from chatluna_archive where id = 'archive-1';",
    )).toBe(fixture.archiveDir);
    expect(sqlite(
      fixture.database,
      "select value from chatluna_meta where key = 'globalDefaultPresetId';",
    )).toBe('');
    expect(existsSync(fixture.archiveTargetDir)).toBe(false);
    expect(readFileSync(join(fixture.archiveDir, 'conversation.json'), 'utf8')).toBe(
      sourceArchiveBefore,
    );
    expect(existsSync(join(fixture.runtimeDir, 'legacy.txt'))).toBe(true);
    expect(existsSync(`${fixture.runtimeDir}.v2-staging`)).toBe(false);
    expect(existsSync(`${fixture.archiveTargetRoot}.v2-staging`)).toBe(false);
  });

  it('retains the activated V2 filesystem state when database restore fails', () => {
    const fixture = createFixture();
    const fakeBin = join(fixture.root, 'restore-failure-bin');
    const pythonWrapper = join(fakeBin, 'python3');
    const realPython = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();
    const blockedReportPath = join(fixture.root, 'blocked-report');
    mkdirSync(fakeBin, { recursive: false });
    mkdirSync(blockedReportPath, { recursive: false });
    writeFileSync(
      pythonWrapper,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$2" == "restore" ]]; then
  printf '{"error":"injected database restore failure"}\\n'
  exit 1
fi
exec ${JSON.stringify(realPython)} "$@"
`,
      { encoding: 'utf8', mode: 0o700 },
    );

    const result = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        'apply',
        ...baseArgs(fixture),
        '--backup-dir',
        join(fixture.root, 'backup-restore-failure'),
        '--report',
        blockedReportPath,
        '--confirm-service-stopped',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Preset V2 apply failed and rollback was incomplete. Keep qqbot.target stopped.',
    );
    expect(result.stderr).toContain('injected database restore failure');
    expect(sqlite(
      fixture.database,
      "select preset || '|' || bindingKey from chatluna_conversation where id = 'conversation-1';",
    )).toBe('sakiko|personal:onebot:1:direct:2:preset:sakiko');
    expect(sqlite(
      fixture.database,
      "select value from chatluna_meta where key = 'globalDefaultPresetId';",
    )).toBe('"sakiko"');
    expect(existsSync(join(fixture.runtimeDir, 'legacy.yml'))).toBe(true);
    expect(existsSync(join(fixture.runtimeDir, 'legacy.txt'))).toBe(false);
    expect(existsSync(join(fixture.archiveTargetDir, 'conversation.json'))).toBe(true);
  });

  it('checks the archive path snapshot inside BEGIN IMMEDIATE', () => {
    const fixture = createFixture();
    const expectedState = JSON.parse(execFileSync(
      'python3',
      [SQLITE_HELPER_PATH, 'inspect', fixture.database],
      { encoding: 'utf8' },
    )) as Record<string, unknown>;
    const driftedPath = join(fixture.archiveSourceRoot, 'drifted-archive');
    execFileSync('sqlite3', [
      fixture.database,
      `update chatluna_archive set path = '${driftedPath.replaceAll("'", "''")}';`,
    ]);

    const result = spawnSync(
      'python3',
      [SQLITE_HELPER_PATH, 'apply', fixture.database],
      {
        encoding: 'utf8',
        input: JSON.stringify({
          changes: [],
          bindingPlans: [],
          archivePathChanges: [{
            id: 'archive-1',
            from: fixture.archiveDir,
            to: fixture.archiveTargetDir,
            state: 'ready',
          }],
          globalDefaultPresetId: 'sakiko',
          expectedState,
        }),
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('database preset state changed after preflight');
    expect(sqlite(
      fixture.database,
      "select path from chatluna_archive where id = 'archive-1';",
    )).toBe(driftedPath);
    expect(sqlite(
      fixture.database,
      "select value from chatluna_meta where key = 'globalDefaultPresetId';",
    )).toBe('');
  });

  it('checks binding pointers and conversation sequences inside BEGIN IMMEDIATE', () => {
    const fixture = createFixture();
    const expectedState = JSON.parse(execFileSync(
      'python3',
      [SQLITE_HELPER_PATH, 'inspect', fixture.database],
      { encoding: 'utf8' },
    )) as Record<string, unknown>;
    execFileSync('sqlite3', [
      fixture.database,
      `
update chatluna_conversation set seq = 9 where id = 'conversation-1';
update chatluna_binding set activeConversationId = null;
      `,
    ]);

    const result = spawnSync(
      'python3',
      [SQLITE_HELPER_PATH, 'apply', fixture.database],
      {
        encoding: 'utf8',
        input: JSON.stringify({
          changes: [],
          bindingPlans: [],
          archivePathChanges: [],
          globalDefaultPresetId: 'sakiko',
          expectedState,
        }),
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('database preset state changed after preflight');
    expect(sqlite(
      fixture.database,
      "select seq from chatluna_conversation where id = 'conversation-1';",
    )).toBe('9');
    expect(sqlite(
      fixture.database,
      "select value from chatluna_meta where key = 'globalDefaultPresetId';",
    )).toBe('');
  });

  it('fails preflight on empty required preset references and compile errors', () => {
    const emptyFixture = createFixture();
    execFileSync('sqlite3', [
      emptyFixture.database,
      "update chatluna_conversation set preset = '';",
    ]);
    const emptyResult = spawnSync(
      process.execPath,
      [SCRIPT_PATH, 'preflight', ...baseArgs(emptyFixture)],
      { encoding: 'utf8' },
    );
    expect(emptyResult.status).not.toBe(0);
    expect(emptyResult.stderr).toContain('preset reference must be a canonical ID or unique alias');

    const compileFixture = createFixture();
    writeFileSync(
      join(compileFixture.runtimeDir, 'missing-handler.yml'),
      YAML.stringify({
        schemaVersion: 2,
        id: 'missing-handler',
        displayName: 'Missing handler',
        aliases: [],
        messages: [],
        inputFormat: null,
        lore: { defaults: {}, entries: [] },
        authorsNote: null,
        knowledge: null,
        promptConfig: {
          postHandler: {
            id: 'unregistered',
            prefix: '',
            postfix: '',
            variables: {},
          },
        },
      }),
      'utf8',
    );
    const compileResult = spawnSync(
      process.execPath,
      [SCRIPT_PATH, 'preflight', ...baseArgs(compileFixture)],
      { encoding: 'utf8' },
    );
    expect(compileResult.status).not.toBe(0);
    expect(compileResult.stderr).toContain('Preset post handler is not registered');
  });

  it('builds a standalone tool that runs outside the repository dependency tree', () => {
    const fixture = createFixture();
    const toolDir = join(fixture.root, 'standalone-tools');
    execFileSync(process.execPath, [
      TOOL_BUILDER_PATH,
      '--out-dir',
      toolDir,
    ]);

    const result = spawnSync(
      process.execPath,
      [
        join(toolDir, 'preset-v2-cutover.mjs'),
        'preflight',
        ...baseArgs(fixture),
      ],
      {
        cwd: fixture.root,
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      globalDefaultPresetId: 'sakiko',
    });
    expect(existsSync(join(toolDir, 'preset-v2-sqlite.py'))).toBe(true);
  });

  it('refuses to recursively replace an unowned output directory', () => {
    const fixture = createFixture();
    const result = spawnSync(
      process.execPath,
      [TOOL_BUILDER_PATH, '--out-dir', fixture.root],
      { encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unowned non-empty output directory');
    expect(existsSync(fixture.database)).toBe(true);
  });
});
