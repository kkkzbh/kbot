import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const shared = require('../scripts/lib/probe-local-bot-shared.cjs') as {
  DEFAULT_PROBE_GROUP_ID: string;
  normalizeVisibleContent: (content: unknown) => string;
  serializePayload: (content: unknown) => unknown;
};

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-probe-test-'));
  tempDirs.push(dir);
  return dir;
}

async function cleanupTempDirs() {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim();
}

afterEach(async () => {
  await cleanupTempDirs();
});

describe('probe-local-bot.sh', () => {
  it('documents group-only probing and the fixed default test group', () => {
    const output = execFileSync('bash', [resolve(process.cwd(), 'scripts/probe-local-bot.sh'), '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(output).toContain('This probe is group-only');
    expect(output).toContain(`default: ${shared.DEFAULT_PROBE_GROUP_ID}`);
    expect(output).toContain('$qqbot-group-probe');
    expect(output).toContain('PROBE_TRIGGER_PREFIX');
    expect(output).toContain('PROBE_ASSERT_FAILURES');
    expect(output).not.toContain('PROBE_TAB');
    expect(output).not.toContain('PROBE_ROOM_MODEL');
  });

  it('resolves room and main models from the canonical model-config service', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/probe-local-bot.sh'), 'utf8');

    expect(content).not.toContain('send_private_msg');
    expect(content).not.toContain('/trace/api/traces');
    expect(content).not.toContain('finalReplyPreview');
    expect(content).toContain('visibleMessages');
    expect(content).toContain('payloadCaptures');
    expect(content).toContain('Another group probe is already running');
    expect(content).toContain('originalInput');
    expect(content).toContain('dispatchedInput');
    expect(content).toContain('this.app.modelConfig');
    expect(content).toContain('getRedactedRuntimeSnapshot');
    expect(content).toContain("binding.workload === 'main.chat'");
    expect(content).toContain("'qqbot-' + model.connectionId + '/' + model.id");
    expect(content).toContain('modelSource: resolvedModelSource');
    expect(content).toContain('firstErrorSignature');
    expect(content).toContain("db.create('chatluna_conversation'");
    expect(content).toContain("db.upsert('chatluna_binding'");
    expect(content).toContain("PROBE_ASSERT_FAILURES");
    expect(content).toContain('(saki|祥)');
    expect(content).not.toContain('main-chat-tabs');
    expect(content).not.toContain('buildMainChatRuntimeEnvPatch');
    expect(content).not.toContain('envRestoreEntries');
  });

  it.each(['PROBE_TAB', 'PROBE_ROOM_MODEL'])('rejects the removed %s override before probing', (key) => {
    const result = spawnSync(
      'bash',
      [resolve(process.cwd(), 'scripts/probe-local-bot.sh'), 'saki test'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          [key]: 'legacy-override',
        },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'PROBE_TAB and PROBE_ROOM_MODEL are no longer supported',
    );
  });
});

describe('probe-local-bot shared helpers', () => {
  it('renders normal text as visible text instead of element json', () => {
    const visible = shared.normalizeVisibleContent({
      type: 'text',
      attrs: { content: 'hello' },
      data: { content: 'hello' },
      children: [],
    });

    expect(visible).toBe('hello');
  });

  it('renders mentions and media placeholders for visible output', () => {
    const visible = shared.normalizeVisibleContent([
      { type: 'at', attrs: { id: '123456' }, children: [] },
      { type: 'text', attrs: { content: ' hi' }, children: [] },
      { type: 'image', attrs: { url: 'https://example.com/a.png' }, children: [] },
      { type: 'voice', attrs: {}, children: [] },
    ]);

    expect(visible).toBe('@123456 hi（图片）（语音）');
  });

  it('serializes payloads into plain json-safe values', () => {
    const payload = shared.serializePayload({
      type: 'text',
      attrs: { content: 'hello' },
      fn: () => 'ignored',
      children: [],
    }) as { type: string; attrs: { content: string }; fn?: unknown };

    expect(payload).toEqual({
      type: 'text',
      attrs: { content: 'hello' },
      children: [],
    });
    expect(payload.fn).toBeUndefined();
  });
});

describe('cleanup-probe-chat-state.sh', () => {
  it('removes non-default probe room state from the local koishi db', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    writeFileSync(dbPath, '');
    execFileSync(
      'sqlite3',
      [
        dbPath,
        `
create table chathub_room (roomId integer primary key, roomName text, conversationId text, roomMasterId text, visibility text, preset text, model text, chatMode text, password text, autoUpdate integer, updatedTime integer);
create table chatluna_conversation (id text primary key, latestMessageId text, updatedAt integer);
create table chathub_room_member (userId text, roomId integer, roomPermission text, mute integer, primary key (userId, roomId));
create table chathub_user (userId text, defaultRoomId integer, groupId text, primary key (userId, groupId));
create table chatluna_message (id text primary key, parentId text, role text, conversationId text, content blob);
create table memory_v3_principal (id integer primary key, userKey text, platform text, userId text);
create table memory_v3_context (id integer primary key, contextKey text, platform text, channelType text, groupId text);
insert into chathub_room values (147, 'codex-probe 的模版克隆房间', 'conv-147', '9177543101', 'template_clone', '', '', '', '', 0, 0);
insert into chatluna_conversation values ('conv-147', null, 0);
insert into chathub_room_member values ('9177543101', 147, 'owner', 0);
insert into chathub_user values ('9177543101', 147, '839573671');
insert into chatluna_message values ('msg-1', null, 'human', 'conv-147', 'hello');
insert into memory_v3_principal values (1, 'onebot:user:9177543101', 'onebot', '9177543101');
insert into memory_v3_principal values (2, 'onebot:user:10001', 'onebot', '10001');
insert into memory_v3_context values (1, 'onebot:bot:2219854433:group:839573671', 'onebot', 'group', '839573671');
insert into memory_v3_context values (2, 'onebot:bot:2219854433:group:10002', 'onebot', 'group', '10002');
        `,
      ],
      { encoding: 'utf8' },
    );

    execFileSync('bash', [resolve(process.cwd(), 'scripts/cleanup-probe-chat-state.sh'), '9177543101', '839573671'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        QQBOT_KOISHI_DB_PATH: dbPath,
      },
    });

    expect(sqlite(dbPath, "select count(*) from chathub_room where roomId = 147;")).toBe('0');
    expect(sqlite(dbPath, "select count(*) from chatluna_conversation where id = 'conv-147';")).toBe('0');
    expect(sqlite(dbPath, "select count(*) from chatluna_message where conversationId = 'conv-147';")).toBe('0');
    expect(sqlite(dbPath, "select count(*) from chathub_room_member where roomId = 147;")).toBe('0');
    expect(sqlite(dbPath, "select count(*) from chathub_user where userId = '9177543101' and groupId = '839573671';")).toBe('0');
    expect(sqlite(dbPath, "select count(*) from memory_v3_principal where userKey = 'onebot:user:9177543101';")).toBe('0');
    expect(sqlite(dbPath, "select count(*) from memory_v3_context where groupId = '839573671';")).toBe('0');
    expect(sqlite(dbPath, 'select count(*) from memory_v3_principal;')).toBe('1');
    expect(sqlite(dbPath, 'select count(*) from memory_v3_context;')).toBe('1');
  });

  it('rejects a partial Memory V3 identity schema', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    writeFileSync(dbPath, '');
    execFileSync(
      'sqlite3',
      [
        dbPath,
        `
create table chathub_user (userId text, defaultRoomId integer, groupId text, primary key (userId, groupId));
create table memory_v3_principal (id integer primary key, userKey text, platform text, userId text);
insert into memory_v3_principal values (1, 'onebot:user:9177543101', 'onebot', '9177543101');
        `,
      ],
      { encoding: 'utf8' },
    );

    expect(() => execFileSync(
      'bash',
      [resolve(process.cwd(), 'scripts/cleanup-probe-chat-state.sh'), '9177543101', '839573671'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          QQBOT_KOISHI_DB_PATH: dbPath,
        },
      },
    )).toThrow();
    expect(sqlite(dbPath, 'select count(*) from memory_v3_principal;')).toBe('1');
  });
});
