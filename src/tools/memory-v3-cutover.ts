#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  MEMORY_LEDGER_SCHEMA_VERSION,
  MEMORY_LEDGER_SQLITE_DDL,
} from '../plugins/memory/schema.js';

const relationSchema = z.object({
  type: z.enum(['table', 'index', 'view', 'trigger']),
  name: z.string().regex(/^memory_[a-zA-Z0-9_]+$/),
  rowCount: z.number().int().nonnegative().nullable(),
}).strict();

const reportSchema = z.object({
  schemaVersion: z.literal(1),
  operation: z.literal('memory-v2-purge-to-v3'),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceBytes: z.number().int().nonnegative(),
  relations: z.array(relationSchema),
  v2ActiveHeads: z.number().int().nonnegative(),
  v2WorkRows: z.number().int().nonnegative(),
  v2AuditRows: z.number().int().nonnegative(),
  generatedAt: z.string().datetime(),
}).strict();

export type MemoryV3CutoverReport = z.infer<typeof reportSchema>;

async function readDatabaseImage(databasePath: string): Promise<{
  digest: string;
  bytes: number;
}> {
  const hash = createHash('sha256');
  let bytes = 0;
  for (const suffix of ['', '-wal', '-journal']) {
    const path = `${databasePath}${suffix}`;
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const identity = Buffer.from(`${suffix || 'main'}\0${content.length}\0`, 'utf8');
    hash.update(identity);
    hash.update(content);
    bytes += content.length;
  }
  return { digest: hash.digest('hex'), bytes };
}

function quoteIdentifier(value: string): string {
  if (!/^memory_[a-zA-Z0-9_]+$/.test(value)) {
    throw new Error(`unsafe SQLite relation name: ${value}`);
  }
  return `"${value}"`;
}

function assertTargetStopped(): void {
  const result = spawnSync('systemctl', ['is-active', '--quiet', 'qqbot.target'], {
    stdio: 'ignore',
  });
  if (result.status === 0) {
    throw new Error('qqbot.target must be stopped before applying Memory Ledger V3.');
  }
}

function listMemoryRelations(database: DatabaseSync): z.infer<typeof relationSchema>[] {
  const rows = database.prepare(
    `SELECT "type", "name"
       FROM "sqlite_master"
      WHERE ("name" LIKE 'memory\\_%' ESCAPE '\\'
         OR "tbl_name" LIKE 'memory\\_%' ESCAPE '\\')
        AND "name" NOT LIKE 'sqlite_autoindex_%'
      ORDER BY CASE "type"
        WHEN 'trigger' THEN 0
        WHEN 'view' THEN 1
        WHEN 'index' THEN 2
        ELSE 3
      END, "name"`,
  ).all() as Array<{ type: string; name: string }>;
  return rows.map((row) => {
    const base = relationSchema.omit({ rowCount: true }).parse(row);
    const rowCount = base.type === 'table'
      ? Number((database.prepare(
          `SELECT COUNT(*) AS "count" FROM ${quoteIdentifier(base.name)}`,
        ).get() as { count: number }).count)
      : null;
    return { ...base, rowCount };
  });
}

function rowCount(relations: readonly z.infer<typeof relationSchema>[], name: string): number {
  return relations.find((relation) => relation.name === name)?.rowCount ?? 0;
}

export async function preflightMemoryV3(databasePath: string): Promise<MemoryV3CutoverReport> {
  const image = await readDatabaseImage(databasePath);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const relations = listMemoryRelations(database);
    const hasV2 = relations.some((relation) => relation.name.startsWith('memory_v2_'));
    if (!hasV2) {
      throw new Error('Memory V3 preflight requires an existing Memory V2 schema.');
    }
    const unsupported = relations.filter((relation) => !relation.name.startsWith('memory_v2_'));
    if (unsupported.length) {
      throw new Error(
        `Memory V3 preflight rejects mixed or unknown memory relations: ${unsupported.map((relation) => relation.name).join(', ')}`,
      );
    }
    return {
      schemaVersion: 1,
      operation: 'memory-v2-purge-to-v3',
      sourceDigest: image.digest,
      sourceBytes: image.bytes,
      relations,
      v2ActiveHeads: Number((database.prepare(
        `SELECT COUNT(*) AS "count" FROM "memory_v2_head" WHERE "state" = 'active'`,
      ).get() as { count: number }).count),
      v2WorkRows: rowCount(relations, 'memory_v2_work'),
      v2AuditRows: rowCount(relations, 'memory_v2_audit'),
      generatedAt: new Date().toISOString(),
    };
  } finally {
    database.close();
  }
}

function verifyReport(actual: MemoryV3CutoverReport, expected: MemoryV3CutoverReport): void {
  if (
    actual.sourceDigest !== expected.sourceDigest
    || actual.sourceBytes !== expected.sourceBytes
    || actual.v2ActiveHeads !== expected.v2ActiveHeads
    || actual.v2WorkRows !== expected.v2WorkRows
    || actual.v2AuditRows !== expected.v2AuditRows
    || JSON.stringify(actual.relations) !== JSON.stringify(expected.relations)
  ) {
    throw new Error('Memory database changed after V3 preflight.');
  }
}

function buildEmptyV3(database: DatabaseSync): void {
  database.exec('PRAGMA secure_delete = ON');
  database.exec('BEGIN IMMEDIATE');
  try {
    const relations = listMemoryRelations(database);
    for (const relation of relations) {
      database.exec(`DROP ${relation.type.toUpperCase()} IF EXISTS ${quoteIdentifier(relation.name)}`);
    }
    for (const statement of MEMORY_LEDGER_SQLITE_DDL) database.exec(statement);
    database.prepare(
      `INSERT INTO "memory_v3_meta" ("key", "value", "updatedAt") VALUES (?, ?, ?)`,
    ).run('schemaVersion', String(MEMORY_LEDGER_SCHEMA_VERSION), Date.now());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  const integrity = database.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error('Memory V3 staging database failed integrity_check.');
  }
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  database.exec('VACUUM');
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

export async function initializeMemoryV3(databasePath: string): Promise<void> {
  assertTargetStopped();
  const stagedPath = join(
    dirname(databasePath),
    `.${basename(databasePath)}.memory-v3.${process.pid}.${randomUUID()}.staged`,
  );
  let stagedExists = false;
  try {
    try {
      await copyFile(databasePath, stagedPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const empty = new DatabaseSync(stagedPath);
      empty.close();
    }
    stagedExists = true;
    await chmod(stagedPath, 0o600);
    const staged = new DatabaseSync(stagedPath);
    try {
      const relations = listMemoryRelations(staged);
      if (relations.length > 0) {
        throw new Error('Memory V3 initialization requires a database without memory relations.');
      }
      buildEmptyV3(staged);
    } finally {
      staged.close();
    }
    const handle = await open(stagedPath, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(stagedPath, databasePath);
    stagedExists = false;
    const directory = await open(dirname(databasePath), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (stagedExists) await unlink(stagedPath);
  }
}

export async function applyMemoryV3(
  databasePath: string,
  expected: MemoryV3CutoverReport,
): Promise<void> {
  assertTargetStopped();
  verifyReport(await preflightMemoryV3(databasePath), expected);

  const source = new DatabaseSync(databasePath);
  try {
    source.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    source.close();
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      await unlink(`${databasePath}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const stagedPath = join(
    dirname(databasePath),
    `.${basename(databasePath)}.memory-v3.${process.pid}.${randomUUID()}.staged`,
  );
  let stagedExists = false;
  try {
    await copyFile(databasePath, stagedPath, constants.COPYFILE_EXCL);
    stagedExists = true;
    await chmod(stagedPath, 0o600);
    const staged = new DatabaseSync(stagedPath);
    try {
      buildEmptyV3(staged);
    } finally {
      staged.close();
    }
    const handle = await open(stagedPath, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(stagedPath, databasePath);
    stagedExists = false;
    const directory = await open(dirname(databasePath), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (stagedExists) await unlink(stagedPath);
  }
}

function parseArgs(argv: string[]): {
  command: 'preflight' | 'apply' | 'initialize';
  databasePath: string;
  reportPath: string;
} {
  const [command, ...rest] = argv;
  if (command !== 'preflight' && command !== 'apply' && command !== 'initialize') {
    throw new Error('Usage: memory-v3-cutover.mjs <preflight|apply|initialize> --database <path> [--report <path>]');
  }
  let databasePath = '';
  let reportPath = '';
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index];
    const value = rest[index + 1];
    if (!value) throw new Error(`${option} requires a value`);
    if (option === '--database') databasePath = resolve(value);
    else if (option === '--report') reportPath = resolve(value);
    else throw new Error(`unknown option: ${option}`);
  }
  if (!databasePath || (command !== 'initialize' && !reportPath)) {
    throw new Error('--database is required; preflight/apply also require --report');
  }
  return { command, databasePath, reportPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'initialize') {
    await initializeMemoryV3(args.databasePath);
    process.stdout.write(`${JSON.stringify({
      schemaVersion: MEMORY_LEDGER_SCHEMA_VERSION,
      active: 0,
      stranded: 0,
    })}\n`);
    return;
  }
  if (args.command === 'preflight') {
    const report = await preflightMemoryV3(args.databasePath);
    await writeFile(args.reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  const report = reportSchema.parse(JSON.parse(await readFile(args.reportPath, 'utf8')));
  await applyMemoryV3(args.databasePath, report);
  const info = await stat(args.databasePath);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: MEMORY_LEDGER_SCHEMA_VERSION,
    bytes: info.size,
    active: 0,
    stranded: 0,
  })}\n`);
}

if (process.argv[1] && /memory-v3-cutover\.(?:mjs|js|ts)$/u.test(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
