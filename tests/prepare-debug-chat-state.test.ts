import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-prepare-debug-room-'));
  tempDirs.push(dir);
  return dir;
}

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim();
}

function createBaseSchema(dbPath: string): void {
  execFileSync(
    'sqlite3',
    [
      dbPath,
      `
create table chathub_room (
  roomId integer primary key,
  roomName text null default '',
  conversationId text null,
  roomMasterId text null,
  visibility text null,
  preset text null,
  model text null,
  chatMode text null,
  password text null,
  autoUpdate integer null default 0,
  updatedTime integer not null default 0
);
create table chatluna_conversation (
  id text primary key,
  title text null,
  model text null,
  preset text null,
  chatMode text null,
  createdBy text null,
  createdAt integer null,
  updatedAt integer null,
  lastChatAt integer null,
  status text null,
  latestMessageId text null,
  autoTitle integer null
);
create table chathub_room_member (
  userId text null,
  roomId integer null,
  roomPermission text null,
  mute integer null default 0
);
create table chathub_user (
  userId text null,
  defaultRoomId integer null,
  groupId text null
);
      `,
    ],
    { encoding: 'utf8' },
  );
}

function writeEnvFile(path: string, content: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${content.trim()}\n`, 'utf8');
}

describe('prepare-debug-chat-state.sh', () => {
  it('creates a probe room using the active built-in tab runtime model instead of cloning an old room model', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    const envPath = join(dir, '.env.local');
    createBaseSchema(dbPath);

    sqlite(
      dbPath,
      `
insert into chathub_room (roomId, roomName, conversationId, roomMasterId, visibility, preset, model, chatMode, password, autoUpdate, updatedTime)
values (1, 'template-room', 'template-conv', '0', 'private', 'sakiko', 'Pro/moonshotai/Kimi-K2.5', 'plugin', 'pw', 0, 1);
insert into chatluna_conversation (id, latestMessageId, updatedAt)
values ('template-conv', null, 1);
      `,
    );

    writeEnvFile(
      envPath,
      `
CHATLUNA_ACTIVE_TAB=openai
CHATLUNA_DEFAULT_PRESET=sakiko
CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5
CHATLUNA_OPENAI_DEFAULT_MODEL=openai/gpt-5.4-medium-thinking
      `,
    );

    const output = execFileSync('bash', [resolve(process.cwd(), 'scripts/prepare-debug-chat-state.sh'), 'plugin'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        QQBOT_KOISHI_DB_PATH: dbPath,
        QQBOT_ENV_FILE: envPath,
        FAKE_USER_ID: '91000999',
      },
    });

    expect(output).toContain('model=openai/gpt-5.4-medium-thinking');
    expect(
      sqlite(
        dbPath,
        "select roomName || '|' || preset || '|' || model || '|' || chatMode from chathub_room where roomMasterId = '91000999';",
      ),
    ).toBe('codex-debug-91000999|sakiko|openai/gpt-5.4-medium-thinking|plugin');
    expect(
      sqlite(
        dbPath,
        "select title || '|' || preset || '|' || model || '|' || chatMode || '|' || status from chatluna_conversation where id = 'codex-debug:91000999';",
      ),
    ).toBe('codex-debug-91000999|sakiko|openai/gpt-5.4-medium-thinking|plugin|active');
  });

  it('updates an existing probe room to the current runtime model when the active tab changes', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    const envPath = join(dir, '.env.local');
    createBaseSchema(dbPath);

    sqlite(
      dbPath,
      `
insert into chathub_room (roomId, roomName, conversationId, roomMasterId, visibility, preset, model, chatMode, password, autoUpdate, updatedTime)
values (125, 'codex-debug-91000999', 'codex-debug:91000999', '91000999', 'private', 'sakiko', 'Pro/moonshotai/Kimi-K2.5', 'tool_research_then_reply', 'pw', 1, 1);
insert into chatluna_conversation (id, latestMessageId, updatedAt)
values ('codex-debug:91000999', null, 1);
insert into chathub_user (userId, defaultRoomId, groupId)
values ('91000999', 125, null);
      `,
    );

    writeEnvFile(
      envPath,
      `
CHATLUNA_ACTIVE_TAB=openai
CHATLUNA_DEFAULT_PRESET=sakiko
CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5
CHATLUNA_OPENAI_DEFAULT_MODEL=openai/gpt-5.4-medium-thinking
      `,
    );

    execFileSync('bash', [resolve(process.cwd(), 'scripts/prepare-debug-chat-state.sh'), 'plugin'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        QQBOT_KOISHI_DB_PATH: dbPath,
        QQBOT_ENV_FILE: envPath,
        FAKE_USER_ID: '91000999',
      },
    });

    expect(
      sqlite(
        dbPath,
        "select preset || '|' || model || '|' || chatMode || '|' || autoUpdate from chathub_room where roomId = 125;",
      ),
    ).toBe('sakiko|openai/gpt-5.4-medium-thinking|plugin|0');
    expect(
      sqlite(
        dbPath,
        "select title || '|' || preset || '|' || model || '|' || chatMode || '|' || coalesce(latestMessageId, '') from chatluna_conversation where id = 'codex-debug:91000999';",
      ),
    ).toBe('codex-debug-91000999:125|sakiko|openai/gpt-5.4-medium-thinking|plugin|');
  });

  it('uses the copilot tab model when copilot is the active built-in tab', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    const envPath = join(dir, '.env.local');
    createBaseSchema(dbPath);

    sqlite(
      dbPath,
      `
insert into chathub_room (roomId, roomName, conversationId, roomMasterId, visibility, preset, model, chatMode, password, autoUpdate, updatedTime)
values (1, 'template-room', 'template-conv', '0', 'private', 'sakiko', 'Pro/moonshotai/Kimi-K2.5', 'plugin', 'pw', 0, 1);
insert into chatluna_conversation (id, latestMessageId, updatedAt)
values ('template-conv', null, 1);
      `,
    );

    writeEnvFile(
      envPath,
      `
CHATLUNA_ACTIVE_TAB=copilot
CHATLUNA_DEFAULT_PRESET=sakiko
CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5
CHATLUNA_COPILOT_DEFAULT_MODEL=openai/gpt-4.1
      `,
    );

    const output = execFileSync('bash', [resolve(process.cwd(), 'scripts/prepare-debug-chat-state.sh'), 'plugin'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        QQBOT_KOISHI_DB_PATH: dbPath,
        QQBOT_ENV_FILE: envPath,
        FAKE_USER_ID: '91000999',
      },
    });

    expect(output).toContain('model=openai/gpt-4.1');
    expect(
      sqlite(
        dbPath,
        "select roomName || '|' || preset || '|' || model || '|' || chatMode from chathub_room where roomMasterId = '91000999';",
      ),
    ).toBe('codex-debug-91000999|sakiko|openai/gpt-4.1|plugin');
  });

  it('normalizes non-openai Copilot models into the probe room model when copilot is active', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    const envPath = join(dir, '.env.local');
    createBaseSchema(dbPath);

    sqlite(
      dbPath,
      `
insert into chathub_room (roomId, roomName, conversationId, roomMasterId, visibility, preset, model, chatMode, password, autoUpdate, updatedTime)
values (1, 'template-room', 'template-conv', '0', 'private', 'sakiko', 'Pro/moonshotai/Kimi-K2.5', 'plugin', 'pw', 0, 1);
insert into chatluna_conversation (id, latestMessageId, updatedAt)
values ('template-conv', null, 1);
      `,
    );

    writeEnvFile(
      envPath,
      `
CHATLUNA_ACTIVE_TAB=copilot
CHATLUNA_DEFAULT_PRESET=sakiko
CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5
CHATLUNA_COPILOT_DEFAULT_MODEL=gpt-4o
      `,
    );

    const output = execFileSync('bash', [resolve(process.cwd(), 'scripts/prepare-debug-chat-state.sh'), 'plugin'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        QQBOT_KOISHI_DB_PATH: dbPath,
        QQBOT_ENV_FILE: envPath,
        FAKE_USER_ID: '91000999',
      },
    });

    expect(output).toContain('model=openai/gpt-4o');
    expect(
      sqlite(
        dbPath,
        "select roomName || '|' || preset || '|' || model || '|' || chatMode from chathub_room where roomMasterId = '91000999';",
      ),
    ).toBe('codex-debug-91000999|sakiko|openai/gpt-4o|plugin');
  });

  it('prefers layered runtime env overrides when resolving the probe room model', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    const baseEnvPath = join(dir, '.env.local');
    const overrideEnvPath = join(dir, '.runtime/.env.runtime');
    createBaseSchema(dbPath);

    sqlite(
      dbPath,
      `
insert into chathub_room (roomId, roomName, conversationId, roomMasterId, visibility, preset, model, chatMode, password, autoUpdate, updatedTime)
values (1, 'template-room', 'template-conv', '0', 'private', 'sakiko', 'openai/gpt-4.1', 'plugin', 'pw', 0, 1);
insert into chatluna_conversation (id, latestMessageId, updatedAt)
values ('template-conv', null, 1);
      `,
    );

    writeEnvFile(
      baseEnvPath,
      `
CHATLUNA_ACTIVE_TAB=copilot
CHATLUNA_DEFAULT_PRESET=sakiko
CHATLUNA_COPILOT_DEFAULT_MODEL=openai/gpt-4.1
CHATLUNA_OPENAI_DEFAULT_MODEL=openai/gpt-5.4-medium-thinking
      `,
    );
    writeEnvFile(
      overrideEnvPath,
      `
CHATLUNA_ACTIVE_TAB=openai
CHATLUNA_DEFAULT_MODEL=openai/gpt-5.4-medium-thinking
      `,
    );

    const output = execFileSync('bash', [resolve(process.cwd(), 'scripts/prepare-debug-chat-state.sh'), 'plugin'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        QQBOT_KOISHI_DB_PATH: dbPath,
        QQBOT_ENV_BASE_FILE: baseEnvPath,
        QQBOT_ENV_OVERRIDE_FILE: overrideEnvPath,
        FAKE_USER_ID: '91000999',
      },
    });

    expect(output).toContain('model=openai/gpt-5.4-medium-thinking');
    expect(
      sqlite(
        dbPath,
        "select roomName || '|' || preset || '|' || model || '|' || chatMode from chathub_room where roomMasterId = '91000999';",
      ),
    ).toBe('codex-debug-91000999|sakiko|openai/gpt-5.4-medium-thinking|plugin');
  });
});
