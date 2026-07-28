import type SQLiteDriver from '@koishijs/plugin-database-sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Context } from 'koishi';
import type { MemoryAddress } from '../src/types/memory.js';
import {
  MEMORY_LEDGER_SCHEMA_VERSION,
  MEMORY_LEDGER_SQLITE_DDL,
  registerMemoryLedgerModels,
} from '../src/plugins/memory/schema.js';
import {
  MemoryStore,
  type AppendAssertionInput,
  type MemoryDatabaseLike,
} from '../src/plugins/memory/store.js';

const requireFromApplication = createRequire(join(process.cwd(), 'package.json'));

export interface MemoryV3TestRuntime {
  context: Context;
  database: MemoryDatabaseLike;
  store: MemoryStore;
  directory: string;
  databasePath: string;
}

export async function createMemoryV3TestRuntime(): Promise<MemoryV3TestRuntime> {
  const directory = await mkdtemp('/var/tmp/qqbot-memory-v3-test-');
  const databasePath = join(directory, 'memory.sqlite');
  const seed = new DatabaseSync(databasePath);
  try {
    for (const statement of MEMORY_LEDGER_SQLITE_DDL) seed.exec(statement);
    seed.prepare(
      `INSERT INTO "memory_v3_meta" ("key", "value", "updatedAt") VALUES (?, ?, ?)`,
    ).run('schemaVersion', String(MEMORY_LEDGER_SCHEMA_VERSION), Date.now());
  } finally {
    seed.close();
  }
  const { Context: KoishiContext } = requireFromApplication('koishi') as {
    Context: new () => Context;
  };
  const sqliteDriver = (
    requireFromApplication('@koishijs/plugin-database-sqlite') as {
      default: typeof SQLiteDriver;
    }
  ).default;
  const context = new KoishiContext();
  context.plugin(sqliteDriver, { path: databasePath });
  await context.start();
  const database = context.database as unknown as MemoryDatabaseLike;
  registerMemoryLedgerModels(context, database);
  await (context.model as unknown as { prepared(): Promise<void> }).prepared();
  const store = new MemoryStore(database);
  await store.assertSchemaVersion();
  return { context, database, store, directory, databasePath };
}

export async function closeMemoryV3TestRuntime(
  runtime: MemoryV3TestRuntime,
): Promise<void> {
  await runtime.context.stop();
  await rm(runtime.directory, { recursive: true, force: true });
}

export function directAddress(userId = '10001', observedAt = Date.now()): MemoryAddress {
  return {
    userKey: `onebot:user:${userId}`,
    contextKey: `onebot:bot:bot:dm:${userId}`,
    channelType: 'direct',
    platform: 'onebot',
    botSelfId: 'bot',
    userId,
    groupId: null,
    channelId: userId,
    rawContextId: userId,
    conversationId: `conversation:dm:${userId}`,
    requestId: `request:dm:${userId}:${observedAt}`,
    currentAudienceSubjectKeys: [`onebot:user:${userId}`],
    observedAt,
  };
}

export function groupAddress(
  groupId: string,
  userId = '10001',
  audience = [`onebot:user:${userId}`, 'onebot:user:10002'],
  observedAt = Date.now(),
): MemoryAddress {
  return {
    userKey: `onebot:user:${userId}`,
    contextKey: `onebot:bot:bot:group:${groupId}`,
    channelType: 'group',
    platform: 'onebot',
    botSelfId: 'bot',
    userId,
    groupId,
    channelId: groupId,
    rawContextId: groupId,
    conversationId: `conversation:group:${groupId}`,
    requestId: `request:group:${groupId}:${observedAt}`,
    currentAudienceSubjectKeys: audience,
    observedAt,
  };
}

export function assertion(
  overrides: Partial<AppendAssertionInput> = {},
): AppendAssertionInput {
  const now = Date.now();
  return {
    idempotencyKey: `assertion:${crypto.randomUUID()}`,
    assertionType: 'userAssertion',
    kind: 'preference',
    topicKey: 'music',
    subjectType: 'user',
    subjectKey: 'onebot:user:10001',
    actorKey: 'memory.test',
    sourceContextKey: 'onebot:bot:bot:group:group-a',
    audiencePolicy: 'captureAudience',
    audienceContextKeys: ['onebot:bot:bot:group:group-a'],
    audienceSnapshots: {
      'onebot:bot:bot:group:group-a': [
        'onebot:user:10001',
        'onebot:user:10002',
      ],
    },
    sensitivity: 'low',
    state: 'active',
    content: '小祥喜欢古典音乐。',
    retrievalText: 'preference music 小祥喜欢古典音乐',
    importance: 0.8,
    confidence: 0.95,
    evidence: [{
      messageId: `message:${crypto.randomUUID()}`,
      speakerId: '10001',
      contextKey: 'onebot:bot:bot:group:group-a',
      threadId: 'conversation:group:group-a',
      captureAudienceSubjectKeys: [
        'onebot:user:10001',
        'onebot:user:10002',
      ],
      replyToMessageId: null,
      excerpt: '小祥喜欢古典音乐。',
      occurredAt: now,
    }],
    createdAt: now,
    ...overrides,
  };
}
