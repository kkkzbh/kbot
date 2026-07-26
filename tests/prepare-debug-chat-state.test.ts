import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];
const scriptPath = resolve(process.cwd(), 'scripts/prepare-debug-chat-state.sh');

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
create table chatluna_meta (
  key text primary key,
  value text null,
  updatedAt integer not null
);
insert into chatluna_meta (key, value, updatedAt)
values ('globalDefaultPresetId', '"sakiko"', 1);
      `,
    ],
    { encoding: 'utf8' },
  );
}

function seedTemplateRoom(dbPath: string): void {
  sqlite(
    dbPath,
    `
insert into chathub_room (
  roomId, roomName, conversationId, roomMasterId, visibility,
  preset, model, chatMode, password, autoUpdate, updatedTime
) values (
  1, 'template-room', 'template-conv', '0', 'private',
  'sakiko', 'legacy-provider/legacy-model', 'plugin', 'pw', 0, 1
);
insert into chatluna_conversation (id, latestMessageId, updatedAt)
values ('template-conv', null, 1);
    `,
  );
}

function writeEnvFile(path: string, content: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${content.trim()}\n`, 'utf8');
}

function writeCanonicalModelConfig(
  path: string,
  connectionId: string,
  modelId: string,
  mainMode: 'dedicated' | 'disabled' = 'dedicated',
): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  const mainBinding = mainMode === 'dedicated'
    ? {
        workload: 'main.chat',
        mode: 'dedicated',
        connectionId,
        modelId,
      }
    : {
        workload: 'main.chat',
        mode: 'disabled',
      };
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      savedRevision: 1,
      appliedRevision: 1,
      updatedAt: '2026-07-26T00:00:00.000Z',
      migration: null,
      connections: [
        {
          id: connectionId,
          displayName: 'Test connection',
          adapter: 'openaiCompatible',
          baseUrl: 'https://models.example.test/v1',
          auth: { kind: 'none' },
          catalogDriver: 'static',
        },
      ],
      models: [
        {
          id: modelId,
          connectionId,
          displayName: 'Test chat model',
          transportModel: 'provider-model',
          modelType: 'chat',
          contextSize: 131072,
          requestMode: 'chat_completions',
          structuredOutputProtocol: 'native_chat_json_schema',
          capabilities: {
            chat: true,
            embedding: false,
            vision: true,
            tools: true,
            structuredOutput: true,
          },
          timeoutMs: 30000,
          requestDefaults: {},
        },
      ],
      bindings: [
        mainBinding,
        { workload: 'memory.extract', mode: 'disabled' },
        { workload: 'memory.embedding', mode: 'disabled' },
        { workload: 'affinity.analysis', mode: 'inheritMain' },
        { workload: 'naturalTrigger.decision', mode: 'disabled' },
        { workload: 'search.summary', mode: 'inheritInvocation' },
        { workload: 'chatluna.defaultEmbedding', mode: 'disabled' },
        { workload: 'agent.subagent.default', mode: 'inheritInvocation' },
        { workload: 'sticker.index', mode: 'disabled' },
      ],
      secrets: [],
    }, null, 2)}\n`,
    'utf8',
  );
}

function prepareEnv(
  overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    ...overrides,
  };
  delete env.QQBOT_ENV_BASE_FILE;
  delete env.QQBOT_ENV_OVERRIDE_FILE;
  return env;
}

describe('prepare-debug-chat-state.sh', () => {
  it('creates a probe room from an explicit canonical main.chat binding', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    const modelConfigPath = join(dir, 'model-config.json');
    createBaseSchema(dbPath);
    seedTemplateRoom(dbPath);
    writeCanonicalModelConfig(modelConfigPath, 'primary', 'primary-chat');

    const output = execFileSync('bash', [scriptPath, 'plugin'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: prepareEnv({
        QQBOT_KOISHI_DB_PATH: dbPath,
        QQBOT_ENV_FILE: join(dir, 'missing.env'),
        QQBOT_MODEL_CONFIG_PATH: modelConfigPath,
        FAKE_USER_ID: '91000999',
      }),
    });

    expect(output).toContain('model=qqbot-primary/primary-chat');
    expect(
      sqlite(
        dbPath,
        "select roomName || '|' || preset || '|' || model || '|' || chatMode from chathub_room where roomMasterId = '91000999';",
      ),
    ).toBe('codex-debug-91000999|sakiko|qqbot-primary/primary-chat|plugin');
    expect(
      sqlite(
        dbPath,
        "select title || '|' || preset || '|' || model || '|' || chatMode || '|' || status from chatluna_conversation where id = 'codex-debug:91000999';",
      ),
    ).toBe('codex-debug-91000999|sakiko|qqbot-primary/primary-chat|plugin|active');
  });

  it('uses the layered env override model-config when updating an existing probe room', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    const baseEnvPath = join(dir, '.env.local');
    const overrideEnvPath = join(dir, '.runtime/.env.runtime');
    const baseConfigPath = join(dir, 'base-model-config.json');
    const overrideConfigPath = join(dir, 'override-model-config.json');
    createBaseSchema(dbPath);
    writeCanonicalModelConfig(baseConfigPath, 'base', 'base-chat');
    writeCanonicalModelConfig(overrideConfigPath, 'runtime', 'runtime-chat');

    sqlite(
      dbPath,
      `
insert into chathub_room (
  roomId, roomName, conversationId, roomMasterId, visibility,
  preset, model, chatMode, password, autoUpdate, updatedTime
) values (
  125, 'codex-debug-91000999', 'codex-debug:91000999', '91000999', 'private',
  'sakiko', 'qqbot-base/base-chat', 'tool_research_then_reply', 'pw', 1, 1
);
insert into chatluna_conversation (id, latestMessageId, updatedAt)
values ('codex-debug:91000999', null, 1);
insert into chathub_user (userId, defaultRoomId, groupId)
values ('91000999', 125, null);
      `,
    );
    writeEnvFile(baseEnvPath, `QQBOT_MODEL_CONFIG_PATH=${baseConfigPath}`);
    writeEnvFile(
      overrideEnvPath,
      `export QQBOT_MODEL_CONFIG_PATH="${overrideConfigPath}"`,
    );

    const env = prepareEnv({
      QQBOT_KOISHI_DB_PATH: dbPath,
      FAKE_USER_ID: '91000999',
    });
    delete env.QQBOT_MODEL_CONFIG_PATH;
    env.QQBOT_ENV_BASE_FILE = baseEnvPath;
    env.QQBOT_ENV_OVERRIDE_FILE = overrideEnvPath;

    const output = execFileSync('bash', [scriptPath, 'plugin'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env,
    });

    expect(output).toContain('model=qqbot-runtime/runtime-chat');
    expect(
      sqlite(
        dbPath,
        "select preset || '|' || model || '|' || chatMode || '|' || autoUpdate from chathub_room where roomId = 125;",
      ),
    ).toBe('sakiko|qqbot-runtime/runtime-chat|plugin|0');
    expect(
      sqlite(
        dbPath,
        "select title || '|' || preset || '|' || model || '|' || chatMode || '|' || coalesce(latestMessageId, '') from chatluna_conversation where id = 'codex-debug:91000999';",
      ),
    ).toBe('codex-debug-91000999:125|sakiko|qqbot-runtime/runtime-chat|plugin|');
  });

  it('fails directly when canonical main.chat is not dedicated', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    const modelConfigPath = join(dir, 'model-config.json');
    createBaseSchema(dbPath);
    seedTemplateRoom(dbPath);
    writeCanonicalModelConfig(modelConfigPath, 'primary', 'primary-chat', 'disabled');

    const result = spawnSync('bash', [scriptPath, 'plugin'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: prepareEnv({
        QQBOT_KOISHI_DB_PATH: dbPath,
        QQBOT_ENV_FILE: join(dir, 'missing.env'),
        QQBOT_MODEL_CONFIG_PATH: modelConfigPath,
        FAKE_USER_ID: '91000999',
      }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('canonical model-config main.chat binding must use dedicated mode');
    expect(sqlite(dbPath, "select count(*) from chathub_room where roomMasterId = '91000999';")).toBe('0');
  });
});
