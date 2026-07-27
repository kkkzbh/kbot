import type SQLiteDriver from '@koishijs/plugin-database-sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Context } from 'koishi';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRuntimeError } from '../src/plugins/memory/errors.js';
import {
  SqliteMemorySearchIndex,
} from '../src/plugins/memory/search-index.js';
import {
  MEMORY_LEDGER_SQLITE_DDL,
  MEMORY_LEDGER_SCHEMA_VERSION,
  MEMORY_LEDGER_TABLES,
  registerMemoryLedgerModels,
} from '../src/plugins/memory/schema.js';
import {
  MemoryStore,
  type MemoryDatabaseLike,
} from '../src/plugins/memory/store.js';

const temporaryDirectories: string[] = [];
const requireFromApplication = createRequire(join(process.cwd(), 'package.json'));

type SqliteDriverLike = {
  _all(sql: string, params?: unknown[]): unknown[];
  _run(sql: string, params?: unknown[]): unknown;
};

type Runtime = {
  context: Context;
  database: MemoryDatabaseLike;
  driver: SqliteDriverLike;
  directory: string;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function createRuntime(): Promise<Runtime> {
  const directory = await mkdtemp('/var/tmp/qqbot-memory-search-index-');
  temporaryDirectories.push(directory);
  const databasePath = join(directory, 'memory.sqlite');
  const canonical = new DatabaseSync(databasePath);
  try {
    canonical.exec('BEGIN IMMEDIATE');
    for (const statement of MEMORY_LEDGER_SQLITE_DDL) canonical.exec(statement);
    canonical.prepare(
      `INSERT INTO "memory_v2_meta" ("key", "value", "updatedAt") VALUES (?, ?, ?)`,
    ).run('schemaVersion', String(MEMORY_LEDGER_SCHEMA_VERSION), Date.now());
    canonical.exec('COMMIT');
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
  context.plugin(sqliteDriver, {
    path: databasePath,
  });
  await context.start();
  const database = context.database as unknown as MemoryDatabaseLike;
  registerMemoryLedgerModels(context, database);
  await (
    context.model as unknown as { prepared(): Promise<void> }
  ).prepared();
  const driver = (
    database as unknown as { _driver: SqliteDriverLike }
  )._driver;
  return {
    context,
    database,
    driver,
    directory,
  };
}

async function createUnregisteredRuntime(
  setup: (database: DatabaseSync) => void,
): Promise<Runtime> {
  const directory = await mkdtemp('/var/tmp/qqbot-memory-startup-gate-');
  temporaryDirectories.push(directory);
  const databasePath = join(directory, 'memory.sqlite');
  const seed = new DatabaseSync(databasePath);
  try {
    setup(seed);
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
  context.plugin(sqliteDriver, {
    path: databasePath,
  });
  await context.start();
  const database = context.database as unknown as MemoryDatabaseLike;
  const driver = (
    database as unknown as { _driver: SqliteDriverLike }
  )._driver;
  return {
    context,
    database,
    driver,
    directory,
  };
}

async function closeRuntime(runtime: Runtime): Promise<void> {
  await runtime.context.stop();
  await rm(runtime.directory, { recursive: true, force: true });
  const index = temporaryDirectories.indexOf(runtime.directory);
  if (index >= 0) temporaryDirectories.splice(index, 1);
}

function sqliteMasterSchema(driver: SqliteDriverLike): {
  serialized: string;
  digest: string;
} {
  const serialized = JSON.stringify(driver._all(
    `SELECT "type", "name", "tbl_name", "sql"
       FROM "sqlite_master"
      ORDER BY "type", "name"`,
  ));
  return {
    serialized,
    digest: createHash('sha256').update(serialized).digest('hex'),
  };
}

describe('Memory V2 persistent lexical projection on production SQLite driver', () => {
  it('installs without FTS5 and performs deterministic, policy-scoped BM25 search', async () => {
    const runtime = await createRuntime();
    try {
      const index = new SqliteMemorySearchIndex();
      await expect(index.assertReady(runtime.database)).resolves.toBeUndefined();
      await expect(new MemoryStore(runtime.database).assertSchemaVersion()).resolves.toBeUndefined();
      const schema = runtime.driver._all(
        `SELECT "sql" FROM "sqlite_master" WHERE "name" = ?`,
        [MEMORY_LEDGER_TABLES.fts],
      ) as Array<{ sql: string }>;
      expect(schema[0]?.sql).not.toMatch(/virtual\s+table|fts5/iu);

      await runtime.database.withTransaction(async (database) => {
        await index.insert(database, {
          streamId: 'stream:apple',
          eventId: 'event:apple:1',
          revision: 1,
          contentHash: 'hash:apple',
          canonicalText: 'alpha apple apple',
        });
        await index.insert(database, {
          streamId: 'stream:banana',
          eventId: 'event:banana:1',
          revision: 1,
          contentHash: 'hash:banana',
          canonicalText: 'alpha banana',
        });
        await index.insert(database, {
          streamId: 'stream:music',
          eventId: 'event:music:1',
          revision: 1,
          contentHash: 'hash:music',
          canonicalText: '小祥喜欢古典音乐',
        });
      });

      const ranked = await index.search(
        runtime.database,
        'alpha apple',
        ['stream:apple', 'stream:banana'],
        10,
      );
      expect([...ranked.keys()]).toEqual(['stream:apple', 'stream:banana']);
      expect(ranked.get('stream:apple')).toBe(1);
      expect(ranked.get('stream:banana')).toBeLessThan(1);
      await expect(index.search(
        runtime.database,
        '古典',
        ['stream:music'],
        10,
      )).resolves.toEqual(new Map([['stream:music', 1]]));
      await expect(index.search(
        runtime.database,
        'apple',
        ['stream:banana'],
        10,
      )).resolves.toEqual(new Map());

      await index.updateIdentity(runtime.database, {
        streamId: 'stream:apple',
        eventId: 'event:apple:2',
        revision: 2,
        contentHash: 'hash:apple',
      });
      await expect(index.get(runtime.database, 'stream:apple')).resolves.toMatchObject([{
        eventId: 'event:apple:2',
        revision: 2,
      }]);
    } finally {
      await closeRuntime(runtime);
    }
  });

  it('keeps projection writes inside the Memory UnitOfWork transaction', async () => {
    const runtime = await createRuntime();
    try {
      const index = new SqliteMemorySearchIndex();
      await expect(runtime.database.withTransaction(async (database) => {
        await index.insert(database, {
          streamId: 'stream:rollback',
          eventId: 'event:rollback:1',
          revision: 1,
          contentHash: 'hash:rollback',
          canonicalText: 'transaction rollback',
        });
        throw new Error('injected rollback');
      })).rejects.toThrow('injected rollback');
      await expect(index.get(runtime.database, 'stream:rollback')).resolves.toEqual([]);
    } finally {
      await closeRuntime(runtime);
    }
  });

  it('rejects corrupt rows and the removed four-column FTS schema', async () => {
    const runtime = await createRuntime();
    try {
      const index = new SqliteMemorySearchIndex();
      await index.insert(runtime.database, {
        streamId: 'stream:corrupt',
        eventId: 'event:corrupt:1',
        revision: 1,
        contentHash: 'hash:corrupt',
        canonicalText: 'projection integrity',
      });
      runtime.driver._run(
        `UPDATE "memory_v2_fts" SET "termFrequencies" = '{}' WHERE "streamId" = ?`,
        ['stream:corrupt'],
      );
      await expect(index.search(
        runtime.database,
        'integrity',
        ['stream:corrupt'],
        10,
      )).rejects.toMatchObject({
        code: 'memory_lexical_projection_invalid',
      } satisfies Partial<MemoryRuntimeError>);

      runtime.driver._run(`DROP TABLE "memory_v2_fts"`);
      runtime.driver._run(
        `CREATE TABLE "memory_v2_fts" (
          "streamId" TEXT,
          "eventId" TEXT,
          "content" TEXT,
          "contentHash" TEXT
        )`,
      );
      await expect(index.assertReady(runtime.database)).rejects.toMatchObject({
        code: 'memory_lexical_columns_invalid',
      } satisfies Partial<MemoryRuntimeError>);
    } finally {
      await closeRuntime(runtime);
    }
  });

  it('rejects missing indexes and mutated relations', async () => {
    const runtime = await createRuntime();
    try {
      const store = new MemoryStore(runtime.database);
      runtime.driver._run(`DROP INDEX "memory_v2_work_due_idx"`);
      await expect(store.assertSchemaVersion()).rejects.toMatchObject({
        code: 'memory_schema_contract_invalid',
        message: expect.stringContaining('missing=memory_v2_work_due_idx'),
      });
    } finally {
      await closeRuntime(runtime);
    }
  });
});

describe('Memory V2 strict startup schema gate on production SQLite driver', () => {
  const invalidSchemas: Array<{
    name: string;
    expectedCode: string;
    setup: (database: DatabaseSync) => void;
  }> = [
    {
      name: 'legacy-only',
      expectedCode: 'memory_schema_contract_invalid',
      setup: (database) => {
        database.exec(
          `CREATE TABLE "memory_fact" (
            "id" INTEGER PRIMARY KEY AUTOINCREMENT,
            "content" TEXT NOT NULL
          )`,
        );
      },
    },
    {
      name: 'partial V2',
      expectedCode: 'memory_schema_contract_invalid',
      setup: (database) => {
        for (const statement of MEMORY_LEDGER_SQLITE_DDL.slice(0, 3)) {
          database.exec(statement);
        }
        database.prepare(
          `INSERT INTO "memory_v2_meta" ("key", "value", "updatedAt") VALUES (?, ?, ?)`,
        ).run('schemaVersion', String(MEMORY_LEDGER_SCHEMA_VERSION), 1);
      },
    },
    {
      name: 'mutated V2',
      expectedCode: 'memory_schema_contract_invalid',
      setup: (database) => {
        for (const statement of MEMORY_LEDGER_SQLITE_DDL) {
          database.exec(statement);
        }
        database.prepare(
          `INSERT INTO "memory_v2_meta" ("key", "value", "updatedAt") VALUES (?, ?, ?)`,
        ).run('schemaVersion', String(MEMORY_LEDGER_SCHEMA_VERSION), 1);
        database.exec(
          `DROP INDEX "memory_v2_work_due_idx";
           CREATE INDEX "memory_v2_work_due_idx"
             ON "memory_v2_work" ("status", "nextRunAt")`,
        );
      },
    },
    {
      name: 'mixed legacy and V2',
      expectedCode: 'memory_schema_contract_invalid',
      setup: (database) => {
        for (const statement of MEMORY_LEDGER_SQLITE_DDL) {
          database.exec(statement);
        }
        database.prepare(
          `INSERT INTO "memory_v2_meta" ("key", "value", "updatedAt") VALUES (?, ?, ?)`,
        ).run('schemaVersion', String(MEMORY_LEDGER_SCHEMA_VERSION), 1);
        database.exec(
          `CREATE TABLE "memory_fact" (
            "id" INTEGER PRIMARY KEY AUTOINCREMENT,
            "content" TEXT NOT NULL
          )`,
        );
      },
    },
    {
      name: 'unexpected trigger attached to a V2 relation',
      expectedCode: 'memory_schema_contract_invalid',
      setup: (database) => {
        for (const statement of MEMORY_LEDGER_SQLITE_DDL) {
          database.exec(statement);
        }
        database.prepare(
          `INSERT INTO "memory_v2_meta" ("key", "value", "updatedAt") VALUES (?, ?, ?)`,
        ).run('schemaVersion', String(MEMORY_LEDGER_SCHEMA_VERSION), 1);
        database.exec(
          `CREATE TRIGGER "unexpected_insert_guard"
             AFTER INSERT ON "memory_v2_head"
             BEGIN
               SELECT 1;
             END`,
        );
      },
    },
    {
      name: 'unexpected view over a V2 relation',
      expectedCode: 'memory_schema_contract_invalid',
      setup: (database) => {
        for (const statement of MEMORY_LEDGER_SQLITE_DDL) {
          database.exec(statement);
        }
        database.prepare(
          `INSERT INTO "memory_v2_meta" ("key", "value", "updatedAt") VALUES (?, ?, ?)`,
        ).run('schemaVersion', String(MEMORY_LEDGER_SCHEMA_VERSION), 1);
        database.exec(
          `CREATE VIEW "unexpected_projection" AS
             SELECT "streamId" FROM "memory_v2_head"`,
        );
      },
    },
    {
      name: 'wrong V2 schema version',
      expectedCode: 'memory_schema_version_invalid',
      setup: (database) => {
        for (const statement of MEMORY_LEDGER_SQLITE_DDL) {
          database.exec(statement);
        }
        database.prepare(
          `INSERT INTO "memory_v2_meta" ("key", "value", "updatedAt") VALUES (?, ?, ?)`,
        ).run('schemaVersion', '1', 1);
      },
    },
  ];

  it.each(invalidSchemas)(
    'rejects $name before model registration without changing sqlite_master',
    async ({ expectedCode, setup }) => {
      const runtime = await createUnregisteredRuntime(setup);
      try {
        const before = sqliteMasterSchema(runtime.driver);
        let startupError: unknown;
        try {
          registerMemoryLedgerModels(runtime.context, runtime.database);
        } catch (error) {
          startupError = error;
        }
        expect(startupError).toMatchObject({
          code: expectedCode,
          operation: 'startup',
          stage: 'schema',
        } satisfies Partial<MemoryRuntimeError>);
        expect(
          Object.keys((
            runtime.context.model as unknown as {
              tables: Record<string, unknown>;
            }
          ).tables).filter((name) => name.startsWith('memory_v2_')),
        ).toEqual([]);
        await (
          runtime.context.model as unknown as { prepared(): Promise<void> }
        ).prepared();
        const after = sqliteMasterSchema(runtime.driver);
        expect(after.serialized).toBe(before.serialized);
        expect(after.digest).toBe(before.digest);
      } finally {
        await closeRuntime(runtime);
      }
    },
  );
});
