import type SQLiteDriver from '@koishijs/plugin-database-sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Context } from 'koishi';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRuntimeError } from '../src/plugins/memory/errors.js';
import { SqliteMemorySearchIndex } from '../src/plugins/memory/search-index.js';
import {
  MEMORY_LEDGER_SQLITE_DDL,
  MEMORY_LEDGER_SCHEMA_VERSION,
  MEMORY_LEDGER_TABLES,
  assertMemoryLedgerSqlitePreflight,
  registerMemoryLedgerModels,
} from '../src/plugins/memory/schema.js';
import {
  MemoryStore,
  type MemoryDatabaseLike,
} from '../src/plugins/memory/store.js';
import { assertion } from './memory-v3-runtime.js';

const temporaryDirectories: string[] = [];
const requireFromApplication = createRequire(join(process.cwd(), 'package.json'));

type Runtime = {
  context: Context;
  database: MemoryDatabaseLike;
  store: MemoryStore;
  directory: string;
  databasePath: string;
};

async function createRuntime(
  mutateSchema?: (database: DatabaseSync) => void,
  register = true,
): Promise<Runtime> {
  const directory = await mkdtemp('/var/tmp/qqbot-memory-v3-index-');
  temporaryDirectories.push(directory);
  const databasePath = join(directory, 'memory.sqlite');
  const canonical = new DatabaseSync(databasePath);
  try {
    for (const statement of MEMORY_LEDGER_SQLITE_DDL) canonical.exec(statement);
    canonical.prepare(
      `INSERT INTO "memory_v3_meta" ("key", "value", "updatedAt") VALUES (?, ?, ?)`,
    ).run('schemaVersion', String(MEMORY_LEDGER_SCHEMA_VERSION), Date.now());
    mutateSchema?.(canonical);
  } finally {
    canonical.close();
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
  if (register) {
    registerMemoryLedgerModels(context, database);
    await (context.model as unknown as { prepared(): Promise<void> }).prepared();
  }
  return {
    context,
    database,
    store: new MemoryStore(database),
    directory,
    databasePath,
  };
}

async function closeRuntime(runtime: Runtime): Promise<void> {
  await runtime.context.stop();
  await rm(runtime.directory, { recursive: true, force: true });
  const index = temporaryDirectories.indexOf(runtime.directory);
  if (index >= 0) temporaryDirectories.splice(index, 1);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('Memory V3 persistent lexical index', () => {
  it('ranks Latin and Chinese terms without loading unrelated documents', async () => {
    const runtime = await createRuntime();
    try {
      const index = new SqliteMemorySearchIndex();
      await index.assertReady(runtime.database);
      const apple = await runtime.store.appendAssertion(assertion({
        idempotencyKey: 'index:apple',
        topicKey: 'apple',
        content: 'alpha apple apple',
        retrievalText: 'alpha apple apple',
      }));
      const banana = await runtime.store.appendAssertion(assertion({
        idempotencyKey: 'index:banana',
        topicKey: 'banana',
        content: 'alpha banana',
        retrievalText: 'alpha banana',
      }));
      const music = await runtime.store.appendAssertion(assertion({
        idempotencyKey: 'index:music',
        topicKey: 'music',
        content: '小祥喜欢古典音乐',
        retrievalText: '小祥喜欢古典音乐',
      }));

      const ranked = await index.search(
        runtime.database,
        'alpha apple',
        8,
      );
      expect([...ranked.keys()]).toEqual([apple.streamId, banana.streamId]);
      expect(ranked.get(apple.streamId)).toBeGreaterThan(ranked.get(banana.streamId)!);
      await expect(index.search(
        runtime.database,
        '古典',
        8,
      )).resolves.toEqual(new Map([[music.streamId, 1]]));
      await expect(index.count(runtime.database)).resolves.toBe(3);
      await expect(index.countTerms(runtime.database)).resolves.toBeGreaterThan(3);
    } finally {
      await closeRuntime(runtime);
    }
  });

  it('applies assertion type and time filters before candidate limits', async () => {
    const runtime = await createRuntime();
    try {
      const index = new SqliteMemorySearchIndex();
      const now = Date.now();
      for (let offset = 0; offset < 10; offset += 1) {
        await runtime.store.appendAssertion(assertion({
          idempotencyKey: `index:noise:${offset}`,
          topicKey: `noise:${offset}`,
          content: `shared query noise ${offset}`,
          retrievalText: `shared query noise ${offset}`,
          createdAt: now + offset,
          evidence: assertion().evidence.map((row) => ({
            ...row,
            occurredAt: now + offset,
          })),
        }));
      }
      const targetOccurredAt = now - 86_400_000;
      const target = await runtime.store.appendAssertion(assertion({
        idempotencyKey: 'index:target',
        assertionType: 'episode',
        kind: null,
        topicKey: 'target',
        content: 'shared query target',
        retrievalText: 'shared query target',
        createdAt: targetOccurredAt,
        evidence: assertion().evidence.map((row) => ({
          ...row,
          occurredAt: targetOccurredAt,
        })),
      }));

      await expect(index.search(
        runtime.database,
        'shared query',
        1,
        { assertionTypes: ['episode'] },
      )).resolves.toEqual(new Map([[target.streamId, 1]]));
      await expect(index.recent(
        runtime.database,
        1,
        { to: targetOccurredAt + 1 },
      )).resolves.toEqual([target.streamId]);
    } finally {
      await closeRuntime(runtime);
    }
  });

  it('rejects V2 and any non-canonical memory relation at startup', async () => {
    const runtime = await createRuntime((database) => {
      database.exec('CREATE TABLE "memory_v2_head" ("id" INTEGER PRIMARY KEY)');
    }, false);
    try {
      expect(() => assertMemoryLedgerSqlitePreflight(runtime.database)).toThrowError(
        expect.objectContaining({ code: 'memory_schema_contract_invalid' }),
      );
    } finally {
      await closeRuntime(runtime);
    }
  });

  it('detects a missing canonical lexical index', async () => {
    const runtime = await createRuntime((database) => {
      database.exec('DROP INDEX "memory_v3_lexical_term_lookup_idx"');
    }, false);
    try {
      expect(() => assertMemoryLedgerSqlitePreflight(runtime.database)).toThrowError(
        MemoryRuntimeError,
      );
    } finally {
      await closeRuntime(runtime);
    }
  });

  it('keeps document and term projections removable as one unit', async () => {
    const runtime = await createRuntime();
    try {
      const index = new SqliteMemorySearchIndex();
      await index.insert(runtime.database, {
        streamId: 'stream:remove',
        eventId: 'event:remove',
        revision: 1,
        contentHash: 'hash:remove',
        canonicalText: '需要删除的中文索引',
      });
      await index.remove(runtime.database, 'stream:remove');
      await expect(index.get(runtime.database, 'stream:remove')).resolves.toEqual([]);
      await expect(runtime.database.get(
        MEMORY_LEDGER_TABLES.lexicalTerm,
        { streamId: 'stream:remove' },
      )).resolves.toEqual([]);
    } finally {
      await closeRuntime(runtime);
    }
  });
});
