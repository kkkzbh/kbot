import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyMemoryV3,
  initializeMemoryV3,
  preflightMemoryV3,
} from '../src/tools/memory-v3-cutover.js';

const directories: string[] = [];

function seedV2(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE memory_v2_head (
        id INTEGER PRIMARY KEY,
        state TEXT NOT NULL,
        content TEXT
      );
      CREATE TABLE memory_v2_work (
        id INTEGER PRIMARY KEY,
        payload TEXT NOT NULL
      );
      CREATE TABLE memory_v2_audit (
        id INTEGER PRIMARY KEY,
        detailJson TEXT
      );
      INSERT INTO memory_v2_head VALUES (1, 'active', 'secret memory');
      INSERT INTO memory_v2_work VALUES (1, '{"secret":"work"}');
      INSERT INTO memory_v2_audit VALUES (1, '{"secret":"audit"}');
    `);
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('Memory V3 breaking cutover', () => {
  it('reports content-free counts and replaces every V2 relation with an empty V3 ledger', async () => {
    const directory = await mkdtemp('/var/tmp/memory-v3-cutover-');
    directories.push(directory);
    const databasePath = join(directory, 'koishi.db');
    seedV2(databasePath);
    const report = await preflightMemoryV3(databasePath);
    expect(report).toMatchObject({
      v2ActiveHeads: 1,
      v2WorkRows: 1,
      v2AuditRows: 1,
    });
    expect(JSON.stringify(report)).not.toContain('secret memory');

    await applyMemoryV3(databasePath, report);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const relations = database.prepare(
        `SELECT name FROM sqlite_master
          WHERE (name LIKE 'memory\\_%' ESCAPE '\\'
             OR tbl_name LIKE 'memory\\_%' ESCAPE '\\')
            AND name NOT LIKE 'sqlite_autoindex_%'`,
      ).all() as Array<{ name: string }>;
      expect(relations.some((row) => row.name.startsWith('memory_v2_'))).toBe(false);
      expect(relations.some((row) => row.name === 'memory_v3_head')).toBe(true);
      expect(database.prepare('SELECT COUNT(*) AS count FROM memory_v3_head').get()).toEqual({
        count: 0,
      });
      expect(database.prepare(
        `SELECT value FROM memory_v3_meta WHERE key = 'schemaVersion'`,
      ).get()).toEqual({ value: '3' });
      expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      database.close();
    }
  });

  it('detects WAL-backed source drift and initializes a clean database once', async () => {
    const directory = await mkdtemp('/var/tmp/memory-v3-initialize-');
    directories.push(directory);
    const databasePath = join(directory, 'koishi.db');
    seedV2(databasePath);
    const report = await preflightMemoryV3(databasePath);
    const database = new DatabaseSync(databasePath);
    try {
      database.exec('PRAGMA journal_mode = WAL');
      database.exec('CREATE TABLE unrelated_runtime_write (id INTEGER PRIMARY KEY)');
      database.exec('INSERT INTO unrelated_runtime_write VALUES (1)');
      await expect(applyMemoryV3(databasePath, report)).rejects.toThrow(
        'changed after V3 preflight',
      );
    } finally {
      database.close();
    }

    const emptyPath = join(directory, 'empty.db');
    await initializeMemoryV3(emptyPath);
    await expect(initializeMemoryV3(emptyPath)).rejects.toThrow(
      'without memory relations',
    );
  });

  it('rejects mixed or unknown memory relations before deletion', async () => {
    const directory = await mkdtemp('/var/tmp/memory-v3-unknown-');
    directories.push(directory);
    const databasePath = join(directory, 'koishi.db');
    seedV2(databasePath);
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE memory_unknown (id INTEGER PRIMARY KEY)');
    database.close();

    await expect(preflightMemoryV3(databasePath)).rejects.toThrow(
      'rejects mixed or unknown memory relations',
    );
  });
});
