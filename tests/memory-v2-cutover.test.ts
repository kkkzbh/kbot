import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type SQLiteDriver from '@koishijs/plugin-database-sqlite';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Context } from 'koishi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import {
  applyMemoryV2Cutover,
  buildMemoryV2MigrationPlan,
  EXPECTED_MEMORY_V2_BASELINE,
  initializeMemoryV2Ledger,
  inspectMemoryV2Status,
  runMemoryV2ProbeGate,
  runMemoryV2Cutover,
  verifyMemoryV2Cutover,
  type MemoryV2CutoverOptions,
} from '../src/tools/memory-v2-cutover.js';
import { createMemoryExtractLaneKey } from '../src/plugins/memory/identity.js';
import {
  MEMORY_LEDGER_TABLES,
  registerMemoryLedgerModels,
} from '../src/plugins/memory/schema.js';
import {
  MemoryStore,
  type ExtractWorkPayload,
  type MemoryDatabaseLike,
} from '../src/plugins/memory/store.js';

const tempDirectories: string[] = [];
const REVIEWED_MISSING_ANCHOR_IDS = Object.freeze([
  '0cc5a6d7-ad9a-48b1-94ab-34047570f6a5',
  '22faa95c-63f2-4fa5-8025-ab21db461560',
  '24480f61-fbed-4345-a8cc-0ce1672cf425',
  '3137075a-93e9-4779-b61f-dd048a38df97',
  '4c2b8f4a-a57b-45e2-a25b-8e7b31bf5c2e',
  '73d03d86-38fd-4b38-9518-62c2bda162ad',
  '949ec480-78ef-464b-9494-3cdeeed9f5a4',
  '9a649bb8-5330-41c9-a026-c8c7c4abb1ac',
  '9e3c56e5-422e-472c-b433-41967bd88f6a',
  'b151b8a1-d9e3-4b01-9b80-795b1e4aea72',
  'ed12dbdc-ffbf-4898-8c25-2634c68817b8',
  'native-feature:chaoxing:0a154a5f-4b15-4ffc-8e04-eff36317fe2e:assistant',
  'native-feature:chaoxing:875038b6-4c98-43cd-aac0-574f9e67c439:assistant',
  'native-feature:chaoxing:88bcb5d4-1d66-442e-839f-87cfb704fa20:assistant',
  'native-feature:chaoxing:fc725108-b6d9-400f-8a9b-3f62ad07815a:assistant',
  'native-feature:hbu-jw:af990b88-4097-4f37-9bf3-7bd05fa27b57:assistant',
  'native-feature:hbu-second-class:1b38a017-a633-4070-b34d-4b1c99fefea1:assistant',
  'native-feature:hbu-second-class:b1b3ffa9-e24f-4ec0-a2ee-21261622fd86:assistant',
  'native-feature:zyh:34006a53-ff00-4590-a77c-767b526a4f82:assistant',
  'native-feature:zyh:e7050e59-4daa-421e-93ea-59248db9c9af:assistant',
] as const);

function reviewedMissingAnchorId(window: number): string | undefined {
  if (window === 0 || window === 1) return REVIEWED_MISSING_ANCHOR_IDS[window];
  if (window >= 6 && window <= 23) {
    return REVIEWED_MISSING_ANCHOR_IDS[window - 4];
  }
  return undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qqbot-memory-v2-cutover-'));
  tempDirectories.push(directory);
  return directory;
}

function insertMarkers(database: DatabaseSync, table: string, count: number): void {
  const insert = database.prepare(`INSERT INTO "${table}" ("marker") VALUES (?)`);
  for (let index = 0; index < count; index += 1) insert.run(`marker-${index}`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function leaveCommittedWalOnlyRow(
  databasePath: string,
  marker: string,
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS power_loss_marker (
        value TEXT PRIMARY KEY
      )
    `);
  } finally {
    database.close();
  }
  const child = spawnSync('python3', ['-c', `
import os
import sqlite3
import sys
connection = sqlite3.connect(sys.argv[1])
connection.execute("PRAGMA journal_mode=WAL")
connection.execute("PRAGMA wal_autocheckpoint=0")
connection.execute("INSERT INTO power_loss_marker(value) VALUES (?)", (sys.argv[2],))
connection.commit()
os._exit(0)
`, databasePath, marker], {
    encoding: 'utf8',
  });
  if (child.status !== 0) {
    throw new Error(
      `Failed to create committed WAL fixture: ${child.stderr || child.stdout}`,
    );
  }
  if (!existsSync(`${databasePath}-wal`) || statSync(`${databasePath}-wal`).size === 0) {
    throw new Error('Committed WAL fixture did not retain a WAL sidecar.');
  }
}

function completeBackfill(path: string): void {
  const database = new DatabaseSync(path);
  try {
    const rows = database.prepare(
      `SELECT id, workKey, payload FROM memory_v2_work
        WHERE workType = 'backfill' ORDER BY id`,
    ).all() as Array<{ id: number; workKey: string; payload: string }>;
    const insert = database.prepare(
      `INSERT INTO memory_v2_embedding (
        embeddingKey, streamId, eventId, revision, canonicalModel,
        modelRevision, contentHash, dimensions, vector, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 3, '[0.1,0.2,0.3]', ?)`,
    );
    const finish = database.prepare(
      `UPDATE memory_v2_work
          SET status = 'succeeded', payload = '{}', leaseToken = NULL,
              leaseExpiresAt = NULL, updatedAt = ?, completedAt = ?
        WHERE id = ?`,
    );
    for (const [index, row] of rows.entries()) {
      const payload = JSON.parse(row.payload) as {
        streamId: string;
        eventId: string;
        revision: number;
        canonicalModel: string;
        modelRevision: number;
        contentHash: string;
      };
      const identity = JSON.stringify([
        payload.streamId,
        payload.eventId,
        payload.revision,
        payload.canonicalModel,
        payload.modelRevision,
        payload.contentHash,
      ]);
      if (row.workKey !== `backfill:${sha256(identity)}`) {
        throw new Error(`Unexpected backfill work identity: ${row.workKey}`);
      }
      insert.run(
        sha256(identity),
        payload.streamId,
        payload.eventId,
        payload.revision,
        payload.canonicalModel,
        payload.modelRevision,
        payload.contentHash,
        70_000 + index,
      );
      finish.run(70_000 + index, 70_000 + index, row.id);
    }
  } finally {
    database.close();
  }
}

function markModelRevisionApplied(path: string): void {
  const model = JSON.parse(readFileSync(path, 'utf8')) as {
    savedRevision: number;
    appliedRevision: number;
  };
  model.appliedRevision = model.savedRevision;
  writeFileSync(path, `${JSON.stringify(model, null, 2)}\n`, { mode: 0o600 });
}

function simulateOperationalRuntimeMutation(
  path: string,
  phase: 'bootstrap' | 'final',
): void {
  const database = new DatabaseSync(path);
  try {
    const preserved = database.prepare(
      `SELECT "id"
         FROM "admin_operational_event"
        WHERE "sourceKey" = 'runtime:1'`,
    ).get() as { id: number };
    const now = phase === 'bootstrap' ? 80_000 : 90_000;
    database.prepare(
      `UPDATE "admin_operational_event"
          SET "severity" = 'error',
              "status" = ?,
              "resolution" = ?,
              "summary" = ?,
              "unit" = 'qqbot-koishi.service',
              "invocationId" = 'runtime-invocation',
              "occurredAt" = 59_000,
              "acknowledgedAt" = ?,
              "resolvedAt" = ?,
              "updatedAt" = ?,
              "fingerprint" = 'runtime-fingerprint-v3',
              "details" = ?,
              "occurrenceCount" = ?,
              "lastOccurredAt" = ?
        WHERE "id" = ?`,
    ).run(
      phase === 'bootstrap' ? 'acknowledged' : 'resolved',
      phase === 'bootstrap' ? null : 'recovered',
      `Runtime ${phase} summary`,
      80_000,
      phase === 'bootstrap' ? null : now,
      now,
      `Runtime ${phase} details`,
      phase === 'bootstrap' ? 2 : 3,
      now,
      preserved.id,
    );
    database.prepare(
      `UPDATE "admin_operational_event_occurrence"
          SET "summary" = ?,
              "details" = ?,
              "occurrenceCount" = ?,
              "unit" = 'qqbot-koishi.service',
              "invocationId" = 'runtime-invocation',
              "firstOccurredAt" = 59_000,
              "lastOccurredAt" = ?,
              "updatedAt" = ?
        WHERE "eventId" = ?`,
    ).run(
      `Occurrence ${phase} summary`,
      `Occurrence ${phase} details`,
      phase === 'bootstrap' ? 2 : 3,
      now,
      now,
      preserved.id,
    );
    if (phase === 'bootstrap') {
      const created = database.prepare(
        `INSERT INTO "admin_operational_event" (
          "sourceKey", "source", "type", "severity", "status", "resolution",
          "title", "summary", "unit", "invocationId", "occurredAt",
          "acknowledgedAt", "resolvedAt", "updatedAt", "component",
          "fingerprint", "details", "occurrenceCount", "lastOccurredAt"
        ) VALUES (
          'runtime:post-cutover', 'runtime', 'runtime_warning', 'warning',
          'open', NULL, 'Post-cutover runtime warning', 'Runtime created row',
          NULL, NULL, ?, NULL, NULL, ?, 'runtime', 'post-cutover-fingerprint',
          'Runtime created details', 1, ?
        ) RETURNING "id"`,
      ).get(now, now, now) as { id: number };
      database.prepare(
        `INSERT INTO "admin_operational_event_occurrence" (
          "sourceKey", "eventId", "summary", "details", "occurrenceCount",
          "unit", "invocationId", "firstOccurredAt", "lastOccurredAt",
          "updatedAt"
        ) VALUES (
          'runtime:post-cutover:occurrence', ?, 'Runtime created occurrence',
          'Runtime created occurrence details', 1, NULL, NULL, ?, ?, ?
        )`,
      ).run(created.id, now, now, now);
    } else {
      database.prepare(
        `UPDATE "admin_operational_event"
            SET "status" = 'resolved',
                "resolution" = 'recovered',
                "resolvedAt" = ?,
                "updatedAt" = ?
          WHERE "sourceKey" = 'runtime:post-cutover'`,
      ).run(now, now);
    }
  } finally {
    database.close();
  }
}

function replaceOccurrenceAllocatorSchema(
  database: DatabaseSync,
  spoof: 'comment' | 'literal' | 'other-column' | 'shadow-default' | 'generated',
): void {
  const idDefinition = spoof === 'other-column' || spoof === 'shadow-default'
    ? spoof === 'shadow-default'
      ? `"id" INTEGER NOT NULL DEFAULT 1000001,
       "allocatorId" INTEGER PRIMARY KEY AUTOINCREMENT,`
      : `"id" INTEGER NOT NULL,
       "allocatorId" INTEGER PRIMARY KEY AUTOINCREMENT,`
    : spoof === 'generated'
      ? `"id" INTEGER PRIMARY KEY AUTOINCREMENT,
       "allocatorShadow" INTEGER GENERATED ALWAYS AS ("id" + 1) VIRTUAL,`
      : `"id" INTEGER PRIMARY KEY${spoof === 'comment' ? ' /* AUTOINCREMENT */' : ''},`;
  const literalColumn = spoof === 'literal'
    ? `"allocatorLiteral" TEXT NOT NULL DEFAULT 'AUTOINCREMENT',`
    : '';
  database.exec(`
    ALTER TABLE "admin_operational_event_occurrence"
      RENAME TO "_allocator_spoof_occurrence";
    CREATE TABLE "admin_operational_event_occurrence" (
      ${idDefinition}
      ${literalColumn}
      "sourceKey" TEXT NOT NULL UNIQUE,
      "eventId" INTEGER NOT NULL,
      "summary" TEXT NOT NULL,
      "details" TEXT NOT NULL,
      "occurrenceCount" INTEGER NOT NULL,
      "unit" TEXT,
      "invocationId" TEXT,
      "firstOccurredAt" REAL NOT NULL,
      "lastOccurredAt" REAL NOT NULL,
      "updatedAt" REAL NOT NULL
    );
    INSERT INTO "admin_operational_event_occurrence" (
      "id", "sourceKey", "eventId", "summary", "details", "occurrenceCount",
      "unit", "invocationId", "firstOccurredAt", "lastOccurredAt", "updatedAt"
    )
    SELECT
      "id", "sourceKey", "eventId", "summary", "details", "occurrenceCount",
      "unit", "invocationId", "firstOccurredAt", "lastOccurredAt", "updatedAt"
    FROM "_allocator_spoof_occurrence";
    DROP TABLE "_allocator_spoof_occurrence";
  `);
  if (
    spoof !== 'other-column'
    && spoof !== 'shadow-default'
    && spoof !== 'generated'
  ) {
    database.prepare(
      `INSERT INTO "sqlite_sequence" ("name", "seq")
       VALUES ('admin_operational_event_occurrence', 2)`,
    ).run();
  }
}

function createLegacyDatabase(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE memory_user (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userKey TEXT NOT NULL,
        platform TEXT NOT NULL,
        userId TEXT NOT NULL,
        qqNick TEXT,
        avatarUrl TEXT,
        readEnabled INTEGER NOT NULL,
        writeEnabled INTEGER NOT NULL,
        firstSeenAt REAL NOT NULL,
        lastSeenAt REAL NOT NULL
      );
      CREATE TABLE memory_context (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contextKey TEXT NOT NULL,
        platform TEXT NOT NULL,
        botSelfId TEXT NOT NULL,
        channelType TEXT NOT NULL,
        groupId TEXT,
        channelId TEXT,
        rawContextId TEXT,
        firstSeenAt REAL NOT NULL,
        lastSeenAt REAL NOT NULL
      );
      CREATE TABLE memory_extract_cursor (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ownerUserKey TEXT NOT NULL,
        contextKey TEXT NOT NULL,
        conversationId TEXT NOT NULL,
        lastExtractedMessageId TEXT,
        lastExtractedAt REAL,
        firstSeenAt REAL NOT NULL,
        updatedAt REAL NOT NULL
      );
      CREATE TABLE memory_candidate (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        marker TEXT NOT NULL
      );
      CREATE TABLE memory_fact (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ownerUserKey TEXT NOT NULL,
        sourceContextKey TEXT NOT NULL,
        targetSpeakerId TEXT,
        targetSpeakerName TEXT,
        evidenceMessageIds TEXT,
        evidenceSpeakerIds TEXT,
        attributionStatus TEXT NOT NULL,
        visibility TEXT NOT NULL,
        scopeType TEXT,
        scopeKey TEXT,
        memoryKey TEXT,
        sensitivity TEXT NOT NULL,
        retrievalText TEXT,
        importance REAL NOT NULL,
        confidence REAL NOT NULL,
        validFrom REAL,
        validUntil REAL,
        expiresAt REAL,
        firstSeenAt REAL NOT NULL,
        lastSeenAt REAL NOT NULL,
        version INTEGER NOT NULL,
        archived INTEGER NOT NULL,
        content TEXT NOT NULL
      );
      CREATE TABLE memory_episode (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ownerUserKey TEXT NOT NULL,
        sourceContextKey TEXT NOT NULL,
        targetSpeakerId TEXT,
        targetSpeakerName TEXT,
        evidenceMessageIds TEXT,
        evidenceSpeakerIds TEXT,
        attributionStatus TEXT NOT NULL,
        visibility TEXT NOT NULL,
        scopeType TEXT,
        scopeKey TEXT,
        memoryKey TEXT,
        sensitivity TEXT NOT NULL,
        retrievalText TEXT,
        importance REAL NOT NULL,
        confidence REAL NOT NULL,
        validFrom REAL,
        validUntil REAL,
        expiresAt REAL,
        firstSeenAt REAL NOT NULL,
        lastSeenAt REAL NOT NULL,
        version INTEGER NOT NULL,
        archived INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        periodStart REAL
      );
      CREATE TABLE memory_profile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ownerUserKey TEXT NOT NULL,
        sourceContextKey TEXT NOT NULL,
        lastSeenAt REAL NOT NULL,
        content TEXT NOT NULL
      );
      CREATE TABLE memory_session (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        marker TEXT NOT NULL
      );
      CREATE TABLE memory_source (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        marker TEXT NOT NULL
      );
      CREATE TABLE memory_provenance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userKey TEXT NOT NULL,
        contextKey TEXT NOT NULL,
        memoryType TEXT NOT NULL,
        memoryId INTEGER NOT NULL,
        candidateId INTEGER,
        conversationId TEXT,
        messageIds TEXT NOT NULL,
        source TEXT NOT NULL,
        createdAt REAL NOT NULL,
        ownerUserKey TEXT NOT NULL,
        evidenceMessageIds TEXT NOT NULL,
        evidenceSpeakerIds TEXT NOT NULL,
        attributionStatus TEXT NOT NULL
      );
      CREATE TABLE memory_job (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jobKey TEXT NOT NULL,
        jobType TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        createdAt REAL NOT NULL,
        updatedAt REAL NOT NULL
      );
      CREATE TABLE memory_audit_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        marker TEXT NOT NULL
      );
      CREATE TABLE memory_tombstone (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        marker TEXT NOT NULL
      );
      CREATE TABLE memory_fact_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        marker TEXT NOT NULL
      );
      CREATE TABLE memory_episode_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        marker TEXT NOT NULL
      );
      CREATE TABLE memory_candidate_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        createdAt REAL NOT NULL
      );
      CREATE TABLE memory_profile_v4 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        marker TEXT NOT NULL
      );
      CREATE TABLE memory_job_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        marker TEXT NOT NULL,
        updatedAt REAL NOT NULL
      );
      CREATE TABLE chatluna_docstore (
        key TEXT PRIMARY KEY,
        pageContent TEXT
      );
      CREATE TABLE chatluna_message (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        parentId TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        name TEXT,
        createdAt REAL NOT NULL
      );
      CREATE TABLE admin_operational_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceKey TEXT,
        source TEXT,
        type TEXT,
        severity TEXT,
        status TEXT,
        resolution TEXT,
        title TEXT,
        summary TEXT,
        unit TEXT,
        invocationId TEXT,
        memoryJobId INTEGER,
        memoryCandidateId INTEGER,
        occurredAt REAL,
        acknowledgedAt REAL,
        resolvedAt REAL,
        updatedAt REAL,
        component TEXT,
        fingerprint TEXT,
        details TEXT,
        occurrenceCount INTEGER,
        lastOccurredAt REAL,
        UNIQUE (sourceKey)
      );
      CREATE TABLE admin_operational_event_occurrence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceKey TEXT NOT NULL,
        eventId INTEGER NOT NULL,
        summary TEXT NOT NULL,
        details TEXT NOT NULL,
        occurrenceCount INTEGER NOT NULL,
        unit TEXT,
        invocationId TEXT,
        firstOccurredAt REAL NOT NULL,
        lastOccurredAt REAL NOT NULL,
        updatedAt REAL NOT NULL
      );
    `);

    const insertUser = database.prepare(`
      INSERT INTO memory_user
        (userKey, platform, userId, qqNick, avatarUrl, readEnabled, writeEnabled,
         firstSeenAt, lastSeenAt)
      VALUES (?, 'onebot', ?, ?, NULL, 1, 1, ?, ?)
    `);
    for (let index = 1; index <= EXPECTED_MEMORY_V2_BASELINE.users; index += 1) {
      insertUser.run(`user-${index}`, String(index), `User ${index}`, index, 1_000 + index);
    }

    const insertContext = database.prepare(`
      INSERT INTO memory_context
        (contextKey, platform, botSelfId, channelType, groupId, channelId,
         rawContextId, firstSeenAt, lastSeenAt)
      VALUES (?, 'onebot', 'bot', ?, ?, ?, ?, ?, ?)
    `);
    for (let index = 1; index <= EXPECTED_MEMORY_V2_BASELINE.contexts; index += 1) {
      const direct = index > 10;
      insertContext.run(
        `ctx-${index}`,
        direct ? 'direct' : 'group',
        direct ? null : `group-${index}`,
        direct ? `private:${index}` : `group-${index}`,
        direct ? `private:${index}` : `raw-${index}`,
        index,
        2_000 + index,
      );
    }

    const cursorPairs: Array<[string, string]> = [];
    for (let index = 1; index <= 9; index += 1) {
      cursorPairs.push([`user-${index}`, `ctx-${index}`]);
    }
    outer: for (let user = 1; user <= 23; user += 1) {
      for (let context = 1; context <= 15; context += 1) {
        const pair: [string, string] = [`user-${user}`, `ctx-${context}`];
        if (cursorPairs.some(([left, right]) => left === pair[0] && right === pair[1])) continue;
        cursorPairs.push(pair);
        if (cursorPairs.length === EXPECTED_MEMORY_V2_BASELINE.cursors) break outer;
      }
    }
    const insertCursor = database.prepare(`
      INSERT INTO memory_extract_cursor
        (ownerUserKey, contextKey, conversationId, lastExtractedMessageId,
         lastExtractedAt, firstSeenAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [index, [subject, context]] of cursorPairs.entries()) {
      insertCursor.run(
        subject,
        context,
        `conversation-${context}`,
        `cursor-${index}`,
        3_000 + index,
        2_500 + index,
        3_000 + index,
      );
    }
    const insertMessage = database.prepare(`
      INSERT INTO chatluna_message
        (id, conversationId, parentId, role, content, name, createdAt)
      VALUES (?, ?, ?, 'human', 'fixture-message', 'Fixture user', ?)
    `);
    for (const [index, [, context]] of cursorPairs.entries()) {
      insertMessage.run(
        `cursor-${index}`,
        `conversation-${context}`,
        null,
        3_000 + index,
      );
    }

    const insertFact = database.prepare(`
      INSERT INTO memory_fact
        (ownerUserKey, sourceContextKey, targetSpeakerId, targetSpeakerName,
         evidenceMessageIds, evidenceSpeakerIds, attributionStatus, visibility,
         scopeType, scopeKey, memoryKey, sensitivity, retrievalText, importance,
         confidence, validFrom, validUntil, expiresAt, firstSeenAt, lastSeenAt,
         version, archived, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'low', ?, 0.8, 0.9,
              NULL, NULL, NULL, ?, ?, 1, 0, ?)
    `);
    let sequence = 0;
    for (let index = 0; index < EXPECTED_MEMORY_V2_BASELINE.activeFactsSourceContext; index += 1) {
      const user = (index % 7) + 1;
      const context = (index % 3) + 1;
      const content = `SECRET_MEMORY_CONTENT_fact-${sequence}`;
      insertFact.run(
        `user-${user}`,
        `ctx-${context}`,
        String(user),
        `User ${user}`,
        JSON.stringify([`fact-message-${sequence}`]),
        JSON.stringify([String(user)]),
        'verified',
        'source_context_only',
        'source_context_only',
        `ctx-${context}`,
        `fact-stream-${sequence}`,
        `fact retrieval ${sequence}`,
        10_000 + sequence,
        11_000 + sequence,
        content,
      );
      sequence += 1;
    }
    for (let index = 0; index < EXPECTED_MEMORY_V2_BASELINE.activeFactsPrivate; index += 1) {
      const user = index + 1;
      const content = `SECRET_MEMORY_CONTENT_fact-${sequence}`;
      insertFact.run(
        `user-${user}`,
        'ctx-11',
        String(user),
        `User ${user}`,
        JSON.stringify([`fact-message-${sequence}`]),
        JSON.stringify([String(user)]),
        'verified',
        'private_only',
        'dm_only',
        null,
        `fact-stream-${sequence}`,
        `fact retrieval ${sequence}`,
        10_000 + sequence,
        11_000 + sequence,
        content,
      );
      sequence += 1;
    }
    for (let index = 0; index < EXPECTED_MEMORY_V2_BASELINE.purgedFactsUserGroup; index += 1) {
      const user = (index % EXPECTED_MEMORY_V2_BASELINE.users) + 1;
      const group = (index % 10) + 1;
      insertFact.run(
        '',
        '',
        null,
        null,
        null,
        null,
        '',
        '',
        'user_group',
        `onebot:bot:group:group-${group}:user:${user}`,
        null,
        `legacy fact ${index}`,
        12_000 + index,
        13_000 + index,
        `legacy fact ${index}`,
      );
    }
    for (let index = 0; index < EXPECTED_MEMORY_V2_BASELINE.purgedFactsUser; index += 1) {
      const user = 11 + (index % 5);
      insertFact.run(
        '',
        '',
        null,
        null,
        null,
        null,
        '',
        '',
        'user',
        `onebot:bot:user:${user}`,
        null,
        `legacy private fact ${index}`,
        14_000 + index,
        15_000 + index,
        `legacy private fact ${index}`,
      );
    }

    const insertEpisode = database.prepare(`
      INSERT INTO memory_episode
        (ownerUserKey, sourceContextKey, targetSpeakerId, targetSpeakerName,
         evidenceMessageIds, evidenceSpeakerIds, attributionStatus, visibility,
         scopeType, scopeKey, memoryKey, sensitivity, retrievalText, importance,
         confidence, validFrom, validUntil, expiresAt, firstSeenAt, lastSeenAt,
         version, archived, title, summary, periodStart)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'low', ?, 0.8, 0.9,
              NULL, NULL, NULL, ?, ?, 1, 0, ?, ?, ?)
    `);
    for (let index = 0; index < EXPECTED_MEMORY_V2_BASELINE.activeEpisodesSourceContext; index += 1) {
      const user = (index % 4) + 1;
      const context = (index % 4) + 1;
      insertEpisode.run(
        `user-${user}`,
        `ctx-${context}`,
        String(user),
        `User ${user}`,
        JSON.stringify([`episode-message-${index}`]),
        JSON.stringify([String(user)]),
        'verified',
        'source_context_only',
        'source_context_only',
        `ctx-${context}`,
        `episode-stream-${index}`,
        `episode retrieval ${index}`,
        20_000 + index,
        21_000 + index,
        `Episode ${index}`,
        `SECRET_MEMORY_CONTENT_episode-${index}`,
        19_000 + index,
      );
    }
    for (let index = 0; index < EXPECTED_MEMORY_V2_BASELINE.purgedEpisodesUserGroup; index += 1) {
      const user = (index % EXPECTED_MEMORY_V2_BASELINE.users) + 1;
      const group = (index % 10) + 1;
      insertEpisode.run(
        '',
        '',
        null,
        null,
        null,
        null,
        '',
        '',
        'user_group',
        `onebot:bot:group:group-${group}:user:${user}`,
        null,
        `legacy episode ${index}`,
        22_000 + index,
        23_000 + index,
        `Legacy Episode ${index}`,
        `legacy episode ${index}`,
        null,
      );
    }
    for (let index = 0; index < EXPECTED_MEMORY_V2_BASELINE.purgedEpisodesUser; index += 1) {
      const user = 11 + (index % 5);
      insertEpisode.run(
        '',
        '',
        null,
        null,
        null,
        null,
        '',
        '',
        'user',
        `onebot:bot:user:${user}`,
        null,
        `legacy private episode ${index}`,
        24_000 + index,
        25_000 + index,
        `Legacy Private Episode ${index}`,
        `legacy private episode ${index}`,
        null,
      );
    }

    const insertProfile = database.prepare(`
      INSERT INTO memory_profile
        (ownerUserKey, sourceContextKey, lastSeenAt, content)
      VALUES (?, ?, ?, ?)
    `);
    for (let index = 0; index < EXPECTED_MEMORY_V2_BASELINE.profiles; index += 1) {
      insertProfile.run(`user-${index + 1}`, `ctx-${index + 1}`, 30_000 + index, `profile-${index}`);
    }

    insertMarkers(database, 'memory_candidate', EXPECTED_MEMORY_V2_BASELINE.candidates);
    insertMarkers(database, 'memory_source', EXPECTED_MEMORY_V2_BASELINE.sources);
    const insertProvenance = database.prepare(`
      INSERT INTO memory_provenance
        (userKey, contextKey, memoryType, memoryId, candidateId,
         conversationId, messageIds, source, createdAt, ownerUserKey,
         evidenceMessageIds, evidenceSpeakerIds, attributionStatus)
      VALUES (?, ?, ?, ?, NULL, ?, ?, 'legacy-memory', ?, ?, ?, ?, ?)
    `);
    for (const memoryType of ['fact', 'episode'] as const) {
      const table = memoryType === 'fact' ? 'memory_fact' : 'memory_episode';
      const activeRows = database.prepare(
        `SELECT id, ownerUserKey, sourceContextKey, evidenceMessageIds,
                evidenceSpeakerIds, firstSeenAt
           FROM ${table}
          WHERE attributionStatus = 'verified'
          ORDER BY id`,
      ).all() as Array<{
        id: number;
        ownerUserKey: string;
        sourceContextKey: string;
        evidenceMessageIds: string;
        evidenceSpeakerIds: string;
        firstSeenAt: number;
      }>;
      for (const row of activeRows) {
        insertProvenance.run(
          row.ownerUserKey,
          row.sourceContextKey,
          memoryType,
          row.id,
          `conversation-${row.sourceContextKey}`,
          row.evidenceMessageIds,
          row.firstSeenAt,
          row.ownerUserKey,
          row.evidenceMessageIds,
          row.evidenceSpeakerIds,
          'verified',
        );
      }
    }
    for (
      let index = EXPECTED_MEMORY_V2_BASELINE.active;
      index < EXPECTED_MEMORY_V2_BASELINE.provenance;
      index += 1
    ) {
      insertProvenance.run(
        'legacy-unknown',
        'legacy-unknown',
        'candidate',
        index,
        'legacy-conversation',
        '[]',
        30_000 + index,
        'legacy-unknown',
        '[]',
        '[]',
        'unknown',
      );
    }
    insertMarkers(database, 'memory_audit_event', EXPECTED_MEMORY_V2_BASELINE.auditEvents);
    const insertCandidateV3 = database.prepare(`
      INSERT INTO memory_candidate_v3 (payload, createdAt) VALUES (?, ?)
    `);
    for (
      let index = 0;
      index < EXPECTED_MEMORY_V2_BASELINE.legacyCandidateV3;
      index += 1
    ) {
      insertCandidateV3.run(`SECRET_V3_CANDIDATE_${index}`, 39_000 + index);
    }

    const insertJob = database.prepare(`
      INSERT INTO memory_job
        (jobKey, jobType, status, payload, createdAt, updatedAt)
      VALUES (?, 'extract', 'dead_letter', ?, ?, ?)
    `);
    const anchorParents = new Map<number, string>();
    const latestAnchorByLane = new Map<number, string>(
      Array.from(
        { length: EXPECTED_MEMORY_V2_BASELINE.deadLetterLanes },
        (_, index) => [index + 1, `cursor-${index}`],
      ),
    );
    for (
      let window = 0;
      window < EXPECTED_MEMORY_V2_BASELINE.deadLetterWindows;
      window += 1
    ) {
      const lane = (window % EXPECTED_MEMORY_V2_BASELINE.deadLetterLanes) + 1;
      const context = `ctx-${lane}`;
      const parentId = latestAnchorByLane.get(lane);
      if (!parentId) throw new Error(`Missing fixture parent for lane ${lane}.`);
      anchorParents.set(window, parentId);
      const missingAnchorId = reviewedMissingAnchorId(window);
      const anchorId = missingAnchorId ?? `anchor-${window}`;
      if (!missingAnchorId) {
        insertMessage.run(
          anchorId,
          `conversation-${context}`,
          parentId,
          45_000 + window,
        );
        latestAnchorByLane.set(lane, anchorId);
      }
    }
    for (let index = 0; index < EXPECTED_MEMORY_V2_BASELINE.jobs; index += 1) {
      const window = index < EXPECTED_MEMORY_V2_BASELINE.deadLetterWindows
        ? index
        : index - EXPECTED_MEMORY_V2_BASELINE.deadLetterWindows;
      const lane = (window % EXPECTED_MEMORY_V2_BASELINE.deadLetterLanes) + 1;
      const subject = `user-${lane}`;
      const context = `ctx-${lane}`;
      const anchorId = reviewedMissingAnchorId(window) ?? `anchor-${window}`;
      insertJob.run(
        `extract:${context}:${subject}`,
        JSON.stringify({
          ownerUserKey: subject,
          contextKey: context,
          conversationId: `conversation-${context}`,
          rangeStartAfterMessageId: anchorParents.get(window),
          latestAnchorMessageId: anchorId,
          address: {
            userKey: subject,
            contextKey: context,
            conversationId: `conversation-${context}`,
            observedAt: 45_000 + window,
          },
        }),
        40_000 + index,
        41_000 + index,
      );
    }
    database.prepare(
      `INSERT INTO memory_job_v3 (marker, updatedAt) VALUES ('obsolete', 42000)`,
    ).run();
    const insertOperationalEvent = database.prepare(`
      INSERT INTO admin_operational_event (
        sourceKey, source, type, severity, status, resolution, title, summary,
        unit, invocationId, memoryJobId, memoryCandidateId, occurredAt,
        acknowledgedAt, resolvedAt, updatedAt, component, fingerprint,
        details, occurrenceCount, lastOccurredAt
      ) VALUES (?, ?, ?, 'error', 'open', NULL, ?, ?, NULL, NULL, ?, NULL, ?,
        NULL, NULL, ?, ?, NULL, NULL, 1, ?)
    `);
    for (
      let index = 1;
      index <= EXPECTED_MEMORY_V2_BASELINE.operationalMemoryEvents;
      index += 1
    ) {
      insertOperationalEvent.run(
        `memory:job:${index}`,
        'memory',
        'memory_job_dead_letter',
        'Legacy memory dead letter',
        `Legacy memory job ${index} failed`,
        index,
        50_000 + index,
        50_000 + index,
        'memory',
        50_000 + index,
      );
    }
    for (let index = 1; index <= 2; index += 1) {
      insertOperationalEvent.run(
        `runtime:${index}`,
        'runtime',
        'runtime_issue',
        `Runtime issue ${index}`,
        `Preserved runtime event ${index}`,
        null,
        60_000 + index,
        60_000 + index,
        'runtime',
        60_000 + index,
      );
    }
    const runtimeEvents = database.prepare(
      `SELECT id, sourceKey
         FROM admin_operational_event
        WHERE source = 'runtime'
        ORDER BY id`,
    ).all() as Array<{ id: number; sourceKey: string }>;
    const insertOccurrence = database.prepare(
      `INSERT INTO admin_operational_event_occurrence (
        sourceKey, eventId, summary, details, occurrenceCount, unit,
        invocationId, firstOccurredAt, lastOccurredAt, updatedAt
      ) VALUES (?, ?, ?, ?, 1, NULL, NULL, ?, ?, ?)`,
    );
    for (const [index, event] of runtimeEvents.entries()) {
      insertOccurrence.run(
        `${event.sourceKey}:occurrence:${index + 1}`,
        event.id,
        `Preserved occurrence ${index + 1}`,
        JSON.stringify({ code: `runtime-${index + 1}` }),
        61_000 + index,
        61_000 + index,
        61_000 + index,
      );
    }
  } finally {
    database.close();
  }
  chmodSync(path, 0o600);
}

function writeModelConfig(path: string): void {
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 2,
    savedRevision: 4,
    appliedRevision: 4,
    updatedAt: '2026-07-27T00:00:00.000Z',
    connections: [
      {
        id: 'codex',
        displayName: 'Codex OAuth',
        adapter: 'codexBridge',
        baseUrl: null,
        auth: { kind: 'oauth', provider: 'codex' },
        catalogDriver: 'codexBridge',
      },
      {
        id: 'siliconflow',
        displayName: 'SiliconFlow',
        adapter: 'openaiCompatible',
        baseUrl: 'https://api.siliconflow.cn/v1',
        auth: {
          kind: 'apiKey',
          secretRef: 'connection:siliconflow:api-key',
        },
        catalogDriver: 'openaiModels',
      },
    ],
    models: [
      {
        id: 'gpt-5.6-luna',
        connectionId: 'codex',
        displayName: 'GPT-5.6 Luna',
        transportModel: 'gpt-5.6-luna',
        modelType: 'chat',
        contextSize: 128_000,
        requestMode: 'responses',
        capabilities: {
          chat: true,
          embedding: false,
          vision: true,
          tools: true,
          structuredOutput: true,
        },
        structuredOutputProtocol: 'native_responses_json_schema',
        timeoutMs: 120_000,
        requestDefaults: {},
      },
      {
        id: 'qwen-qwen3.5-35b-a3b',
        connectionId: 'siliconflow',
        displayName: 'Qwen3.5 35B A3B',
        transportModel: 'Qwen/Qwen3.5-35B-A3B',
        modelType: 'chat',
        contextSize: 32_768,
        requestMode: 'chat_completions',
        capabilities: {
          chat: true,
          embedding: false,
          vision: false,
          tools: false,
          structuredOutput: true,
        },
        structuredOutputProtocol: 'native_chat_json_schema',
        timeoutMs: 120_000,
        requestDefaults: {},
      },
      {
        id: 'qwen-qwen3-embedding-8b',
        connectionId: 'siliconflow',
        displayName: 'Qwen3 Embedding 8B',
        transportModel: 'Qwen/Qwen3-Embedding-8B',
        modelType: 'embedding',
        contextSize: 32_768,
        requestMode: null,
        capabilities: {
          chat: false,
          embedding: true,
          vision: false,
          tools: false,
          structuredOutput: false,
        },
        structuredOutputProtocol: null,
        timeoutMs: 120_000,
        requestDefaults: {},
      },
    ],
    bindings: [
      {
        workload: 'main.chat',
        mode: 'dedicated',
        connectionId: 'codex',
        modelId: 'gpt-5.6-luna',
      },
      {
        workload: 'memory.extract',
        mode: 'dedicated',
        connectionId: 'siliconflow',
        modelId: 'qwen-qwen3.5-35b-a3b',
      },
      {
        workload: 'memory.embedding',
        mode: 'dedicated',
        connectionId: 'siliconflow',
        modelId: 'qwen-qwen3-embedding-8b',
      },
      {
        workload: 'chatluna.defaultEmbedding',
        mode: 'dedicated',
        connectionId: 'siliconflow',
        modelId: 'qwen-qwen3-embedding-8b',
      },
      {
        workload: 'affinity.analysis',
        mode: 'inheritMain',
      },
      {
        workload: 'naturalTrigger.decision',
        mode: 'disabled',
      },
      {
        workload: 'agent.subagent.default',
        mode: 'inheritInvocation',
      },
      {
        workload: 'sticker.index',
        mode: 'disabled',
      },
    ],
    secrets: [],
    migration: null,
  }, null, 2)}\n`, { mode: 0o600 });
}

function contextPreset(withLongMemory: boolean): string {
  const blocks: Array<Record<string, unknown>> = [
    { id: 'role', type: 'role', rolePresetId: 'empty' },
  ];
  if (withLongMemory) {
    blocks.push({
      id: 'long-memory',
      type: 'longMemory',
      enabled: true,
      budgetPriority: 200,
      maxTokens: null,
      prompt: null,
      extractPrompt: null,
      newQuestionPrompt: null,
    });
  }
  blocks.push(
    { id: 'current-input', type: 'currentInput', inputFormat: null },
    { id: 'model-output', type: 'modelOutput', maxOutputTokens: 1024, postHandler: null },
  );
  return YAML.stringify({
    schemaVersion: 1,
    id: 'empty',
    displayName: 'Empty',
    aliases: [],
    blocks,
  });
}

interface Fixture {
  root: string;
  database: string;
  modelConfig: string;
  koishiConfig: string;
  bundledContextDir: string;
  runtimeContextDir: string;
  systemctl: string;
  preflightReport: string;
  applyReport: string;
  backupDir: string;
}

function createFixture(activeService = false): Fixture {
  const root = tempDirectory();
  const database = join(root, 'koishi.db');
  const modelConfig = join(root, 'model-config.json');
  const koishiConfig = join(root, 'koishi.yml');
  const bundledContextDir = join(root, 'bundled-context-presets');
  const runtimeContextDir = join(root, 'runtime-context-presets');
  const systemctl = join(root, 'systemctl');
  mkdirSync(bundledContextDir);
  mkdirSync(runtimeContextDir);
  createLegacyDatabase(database);
  writeModelConfig(modelConfig);
  writeFileSync(koishiConfig, 'plugins: {}\n', 'utf8');
  writeFileSync(join(bundledContextDir, 'empty.yml'), contextPreset(false), 'utf8');
  writeFileSync(join(runtimeContextDir, 'empty.yml'), contextPreset(true), 'utf8');
  writeFileSync(
    systemctl,
    `#!/usr/bin/env bash\nprintf '%s\\n' '${activeService ? 'active' : 'inactive'}'\n`,
    'utf8',
  );
  chmodSync(systemctl, 0o700);
  return {
    root,
    database,
    modelConfig,
    koishiConfig,
    bundledContextDir,
    runtimeContextDir,
    systemctl,
    preflightReport: join(root, 'preflight.json'),
    applyReport: join(root, 'applied.json'),
    backupDir: join(root, 'backup'),
  };
}

function canonicalizeFixtureUserOne(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  const legacySubjectKey = 'user-1';
  const canonicalSubjectKey = 'onebot:user:1';
  try {
    database.exec('BEGIN IMMEDIATE');
    database.prepare(
      'UPDATE memory_user SET userKey = ? WHERE userKey = ?',
    ).run(canonicalSubjectKey, legacySubjectKey);
    for (const [table, column] of [
      ['memory_extract_cursor', 'ownerUserKey'],
      ['memory_fact', 'ownerUserKey'],
      ['memory_episode', 'ownerUserKey'],
      ['memory_profile', 'ownerUserKey'],
      ['memory_provenance', 'userKey'],
      ['memory_provenance', 'ownerUserKey'],
    ] as const) {
      database.prepare(
        `UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`,
      ).run(canonicalSubjectKey, legacySubjectKey);
    }
    const jobs = database.prepare(
      `SELECT id, payload FROM memory_job WHERE jobKey = 'extract:ctx-1:user-1'`,
    ).all() as Array<{ id: number; payload: string }>;
    const updateJob = database.prepare(
      'UPDATE memory_job SET jobKey = ?, payload = ? WHERE id = ?',
    );
    for (const job of jobs) {
      const payload = JSON.parse(job.payload) as {
        ownerUserKey: string;
        address: { userKey: string };
      };
      payload.ownerUserKey = canonicalSubjectKey;
      payload.address.userKey = canonicalSubjectKey;
      updateJob.run(
        `extract:ctx-1:${canonicalSubjectKey}`,
        JSON.stringify(payload),
        job.id,
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
}

function options(
  fixture: Fixture,
  command: MemoryV2CutoverOptions['command'],
): MemoryV2CutoverOptions {
  return {
    command,
    database: fixture.database,
    modelConfig: fixture.modelConfig,
    koishiConfig: fixture.koishiConfig,
    bundledContextDir: fixture.bundledContextDir,
    runtimeContextDir: fixture.runtimeContextDir,
    report: command === 'preflight' ? fixture.preflightReport : fixture.applyReport,
    preflightReport: command === 'apply'
      || command === 'bootstrap-verify'
      || command === 'probe-gate'
      || command === 'verify'
      ? fixture.preflightReport
      : null,
    backupDir: command === 'apply' ? fixture.backupDir : null,
    adminOrigin: null,
    systemctl: fixture.systemctl,
    confirmServiceStopped: command === 'apply' || command === 'initialize',
    now: () => new Date('2026-07-28T00:00:00.000Z'),
  };
}

async function preflight(fixture: Fixture) {
  return runMemoryV2Cutover(options(fixture, 'preflight'));
}

async function withMemoryRuntime<T>(
  databasePath: string,
  callback: (
    database: MemoryDatabaseLike,
    store: MemoryStore,
  ) => Promise<T>,
): Promise<T> {
  const requireFromApplication = createRequire(join(process.cwd(), 'package.json'));
  const { Context: KoishiContext } = requireFromApplication('koishi') as {
    Context: new () => Context;
  };
  const databaseSqlite = (
    requireFromApplication('@koishijs/plugin-database-sqlite') as {
      default: typeof SQLiteDriver;
    }
  ).default;
  const context = new KoishiContext();
  const model = context.model as unknown as {
    extend(
      name: string,
      fields: Record<string, unknown>,
      config: Record<string, unknown>,
    ): void;
  };
  model.extend('chatluna_conversation', {
    id: 'string',
    latestMessageId: { type: 'string', nullable: true },
  }, { primary: 'id' });
  model.extend('chatluna_message', {
    id: 'string',
    conversationId: 'string',
    parentId: { type: 'string', nullable: true },
    role: 'string',
    content: 'text',
    name: { type: 'string', nullable: true },
    createdAt: 'double',
  }, { primary: 'id' });
  context.plugin(databaseSqlite, { path: databasePath });
  await context.start();
  try {
    const database = context.database as unknown as MemoryDatabaseLike;
    registerMemoryLedgerModels(context, database);
    const store = new MemoryStore(database);
    await store.assertSchemaVersion();
    return await callback(database, store);
  } finally {
    await context.stop();
  }
}

describe('Memory Ledger V2 one-shot cutover', () => {
  it('rejects unknown tables that imitate an FTS auxiliary name', async () => {
    const fixture = createFixture();
    rmSync(fixture.database);
    const database = new DatabaseSync(fixture.database);
    database.exec(`CREATE TABLE memory_v2_fts_shadow (value TEXT)`);
    database.close();
    await expect(inspectMemoryV2Status(fixture.database)).rejects.toThrow(
      'Unknown memory tables block cutover: memory_v2_fts_shadow',
    );
  });

  it('initializes a deterministic empty V2 ledger while preserving non-memory tables', async () => {
    const fixture = createFixture();
    rmSync(fixture.database);
    const database = new DatabaseSync(fixture.database);
    database.exec(`
      CREATE TABLE unrelated_runtime_state (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO unrelated_runtime_state (id, value) VALUES (1, 'preserved');
    `);
    database.close();

    await expect(
      initializeMemoryV2Ledger(options(fixture, 'initialize')),
    ).resolves.toEqual({
      state: 'v2',
      schemaVersion: 2,
      initialized: true,
      tables: 13,
    });
    expect(await inspectMemoryV2Status(fixture.database)).toEqual({
      state: 'v2',
      schemaVersion: 2,
    });
    const initialized = new DatabaseSync(fixture.database, { readOnly: true });
    try {
      expect(initialized.prepare(
        `SELECT value FROM unrelated_runtime_state WHERE id = 1`,
      ).get()).toEqual({ value: 'preserved' });
      expect(initialized.prepare(
        `SELECT value FROM memory_v2_meta WHERE key = 'schemaVersion'`,
      ).get()).toEqual({ value: '2' });
      expect(initialized.prepare(
        `SELECT value FROM memory_v2_meta WHERE key = 'initializationMode'`,
      ).get()).toEqual({ value: 'fresh' });
      expect(initialized.prepare(
        `SELECT COUNT(*) count FROM memory_v2_head`,
      ).get()).toEqual({ count: 0 });
    } finally {
      initialized.close();
    }
  });

  it('rolls back empty V2 initialization after database rename', async () => {
    const fixture = createFixture();
    rmSync(fixture.database);
    const database = new DatabaseSync(fixture.database);
    database.exec(`CREATE TABLE unrelated_runtime_state (id INTEGER PRIMARY KEY)`);
    database.close();
    const initializeOptions = options(fixture, 'initialize');
    initializeOptions.injectFault = (point) => {
      if (point === 'after-database-rename-before-fsync') {
        throw new Error('injected-initialize-rename');
      }
    };
    await expect(initializeMemoryV2Ledger(initializeOptions)).rejects.toThrow(
      'injected-initialize-rename',
    );
    expect(await inspectMemoryV2Status(fixture.database)).toEqual({
      state: 'empty',
      schemaVersion: null,
    });
    const restored = new DatabaseSync(fixture.database, { readOnly: true });
    try {
      expect(restored.prepare(
        `SELECT COUNT(*) count FROM unrelated_runtime_state`,
      ).get()).toEqual({ count: 0 });
    } finally {
      restored.close();
    }
  });

  it('initializes V2 when the SQLite database does not exist yet', async () => {
    const fixture = createFixture();
    rmSync(fixture.database);
    await expect(
      initializeMemoryV2Ledger(options(fixture, 'initialize')),
    ).resolves.toMatchObject({
      state: 'v2',
      initialized: true,
    });
    expect(statSync(fixture.database).mode & 0o777).toBe(0o600);
  });

  it('durably checkpoints committed WAL state before live sidecar cleanup', async () => {
    const fixture = createFixture();
    leaveCommittedWalOnlyRow(fixture.database, 'committed-before-cutover');
    await preflight(fixture);
    const crashImage = join(tempDirectory(), 'power-loss-active.db');
    const applyOptions = options(fixture, 'apply');
    applyOptions.injectFault = (point) => {
      if (point !== 'after-database-sidecar-cleanup') return;
      expect(existsSync(`${fixture.database}-wal`)).toBe(false);
      expect(existsSync(`${fixture.database}-shm`)).toBe(false);
      copyFileSync(fixture.database, crashImage);
      throw new Error('simulated-power-loss-before-rename');
    };
    await expect(applyMemoryV2Cutover(applyOptions)).rejects.toThrow(
      'simulated-power-loss-before-rename',
    );

    const durableActiveImage = new DatabaseSync(crashImage, { readOnly: true });
    try {
      expect(durableActiveImage.prepare(
        `SELECT value FROM power_loss_marker`,
      ).get()).toEqual({ value: 'committed-before-cutover' });
      expect(durableActiveImage.prepare(
        `SELECT COUNT(*) AS count FROM memory_fact`,
      ).get()).toEqual({ count: EXPECTED_MEMORY_V2_BASELINE.facts });
    } finally {
      durableActiveImage.close();
    }
  });

  it('durably checkpoints committed WAL state before initialization cleanup', async () => {
    const fixture = createFixture();
    rmSync(fixture.database);
    leaveCommittedWalOnlyRow(fixture.database, 'committed-before-initialize');
    const crashImage = join(tempDirectory(), 'initialize-power-loss-active.db');
    const initializeOptions = options(fixture, 'initialize');
    initializeOptions.injectFault = (point) => {
      if (point !== 'after-database-sidecar-cleanup') return;
      expect(existsSync(`${fixture.database}-wal`)).toBe(false);
      expect(existsSync(`${fixture.database}-shm`)).toBe(false);
      copyFileSync(fixture.database, crashImage);
      throw new Error('simulated-initialize-power-loss-before-rename');
    };
    await expect(initializeMemoryV2Ledger(initializeOptions)).rejects.toThrow(
      'simulated-initialize-power-loss-before-rename',
    );

    const durableActiveImage = new DatabaseSync(crashImage, { readOnly: true });
    try {
      expect(durableActiveImage.prepare(
        `SELECT value FROM power_loss_marker`,
      ).get()).toEqual({ value: 'committed-before-initialize' });
      expect(durableActiveImage.prepare(
        `SELECT COUNT(*) AS count
           FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'memory_%'`,
      ).get()).toEqual({ count: 0 });
    } finally {
      durableActiveImage.close();
    }
  });

  it('emits a deterministic content-free 0600 preflight with the exact production baseline', async () => {
    const fixture = createFixture();
    const plan = await buildMemoryV2MigrationPlan(options(fixture, 'preflight'));
    expect(plan.report.decisions).toMatchObject({
      active: 59,
      purged: 314,
      profilesDerivedOnRead: 4,
      profileDerivationMode: 'active-heads-on-read',
      profileSubjectContexts: 4,
      legacyCandidatesPurged: 6,
      legacyJobRemnantsPurged: 1,
      deadLettersDiscarded: 43,
      deadLetterLogicalWindows: 37,
      deadLetterLanes: 9,
      deadLetterMissingAnchorRecords: 22,
      deadLetterMissingAnchors: 20,
      deadLetterMissingAnchorDigest:
        '52efe1d0da8d95d2c38a5cce7168e76efc13153ec82756de00569268667c0f16',
      purgeScopeCatalog: {
        resolved: 314,
        missingUser: 0,
        missingContext: 0,
        missingUserAndContext: 0,
        unresolvedDigest: sha256('[]'),
      },
      backfillQueued: 59,
    });
    expect(plan.report.decisions.profileSourceActiveHeads).toBeGreaterThanOrEqual(4);
    expect(plan.report.modelConfig).toMatchObject({
      schemaVersion: 2,
      removedWorkloads: ['chatluna.defaultEmbedding'],
      sourceSavedRevision: 4,
      sourceAppliedRevision: 4,
      stagedSavedRevision: 5,
      stagedAppliedRevision: 4,
      startupAppliedRevision: 5,
      extractionSourceMode: 'dedicated',
      extractionMode: 'inheritMain',
    });
    expect(plan.report.contextPresets.migrated).toEqual([
      expect.objectContaining({ id: 'empty', removedBlockId: 'long-memory' }),
    ]);
    expect(plan.report.database.operationalEvents).toMatchObject({
      memoryLinkedRemoved: 43,
      memoryCandidateLinkedRemoved: 0,
      preservedEventCount: 2,
      preservedOccurrenceCount: 2,
      sourceEventBoundaryId: 45,
      sourceOccurrenceBoundaryId: 2,
      preservedEventIdentityDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      preservedOccurrenceIdentityDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(plan.report.decisions.audienceDecisions).toHaveLength(59);
    expect(
      plan.report.decisions.audienceDecisions.filter(
        (decision) => decision.reasonCode === 'legacy-capture-audience-unavailable',
      ),
    ).toHaveLength(55);

    await preflight(fixture);
    const report = readFileSync(fixture.preflightReport, 'utf8');
    expect(report).not.toContain('SECRET_MEMORY_CONTENT');
    expect(report).not.toContain('SECRET_V3_CANDIDATE');
    expect(report).not.toContain('Qwen/Qwen3.5-35B-A3B');
    expect(statSync(fixture.preflightReport).mode & 0o777).toBe(0o600);
    expect(JSON.parse(report).planHash).toBe(plan.report.planHash);
  });

  it('migrates 59 active records, purges legacy content, accounts dead letters, and stages model revision 5', async () => {
    const fixture = createFixture();
    const plan = await buildMemoryV2MigrationPlan(options(fixture, 'preflight'));
    await preflight(fixture);
    const result = await applyMemoryV2Cutover(options(fixture, 'apply'), plan);
    expect(result.applied).toBe(true);

    const database = new DatabaseSync(fixture.database, { readOnly: true });
    try {
      expect(database.prepare(`SELECT COUNT(*) count FROM memory_v2_head`).get()).toEqual({ count: 59 });
      expect(database.prepare(`SELECT COUNT(*) count FROM memory_v2_head WHERE audiencePolicy = 'subjectPrivate'`).get()).toEqual({ count: 59 });
      expect(database.prepare(`SELECT COUNT(*) count FROM memory_v2_payload`).get()).toEqual({ count: 59 });
      expect(database.prepare(`SELECT COUNT(*) count FROM memory_v2_fts`).get()).toEqual({ count: 59 });
      expect(database.prepare(`SELECT COUNT(*) count FROM memory_v2_work WHERE workType = 'backfill'`).get()).toEqual({ count: 59 });
      expect(database.prepare(`
        SELECT COUNT(*) count
          FROM memory_v2_cursor
         WHERE discardBeforeMessageId IS NULL
           AND lastWindowHash IS NOT NULL
           AND lastMessageAt >= 45000
      `).get()).toEqual({ count: 9 });
      const migratedCursors = new Map(
        (database.prepare(`
          SELECT laneKey, lastMessageId, lastMessageAt, lastWindowHash,
                 discardBeforeMessageId
            FROM memory_v2_cursor
           WHERE lastWindowHash IS NOT NULL
        `).all() as Array<{
          laneKey: string;
          lastMessageId: string | null;
          lastMessageAt: number;
          lastWindowHash: string;
          discardBeforeMessageId: string | null;
        }>).map((cursor) => [cursor.laneKey, cursor]),
      );
      for (const discarded of plan.deadLetters) {
        const cursor = migratedCursors.get(discarded.laneKey);
        expect(cursor).toBeDefined();
        if (discarded.anchorMessageAt != null) {
          expect(cursor?.lastMessageAt).toBeGreaterThanOrEqual(discarded.anchorMessageAt);
        }
        expect(cursor?.lastMessageId).toMatch(/^cursor-\d+$/u);
        expect(cursor?.discardBeforeMessageId).toBeNull();
      }
      expect(database.prepare(`
        SELECT conversationId
          FROM memory_v2_cursor
         WHERE laneKey = ?
      `).get(createMemoryExtractLaneKey('user-1', 'ctx-1'))).toEqual({
        conversationId: 'conversation-ctx-1',
      });
      expect(database.prepare(`SELECT COUNT(*) count FROM memory_v2_audit WHERE eventType = 'migration-purged'`).get()).toEqual({ count: 314 });
      expect(database.prepare(`SELECT COUNT(*) count FROM memory_v2_audit WHERE eventType = 'operator-discarded'`).get()).toEqual({ count: 43 });
      expect(database.prepare(`
        SELECT COUNT(*) count
          FROM memory_v2_audit audit
         WHERE audit.eventType = 'migration-profile-derived-on-read'
           AND EXISTS (
             SELECT 1
               FROM memory_v2_head head
              WHERE head.state = 'active'
                AND head.subjectKey = audit.subjectKey
                AND head.sourceContextKey = audit.contextKey
           )
      `).get()).toEqual({ count: 4 });
      expect(database.prepare(`SELECT COUNT(*) count FROM sqlite_master WHERE type = 'table' AND name = 'memory_fact'`).get()).toEqual({ count: 0 });
      expect(database.prepare(`SELECT COUNT(*) count FROM sqlite_master WHERE type = 'table' AND name = 'memory_candidate_v3'`).get()).toEqual({ count: 0 });
      expect(database.prepare(`SELECT COUNT(*) count FROM sqlite_master WHERE type = 'table' AND name = 'chatluna_docstore'`).get()).toEqual({ count: 0 });
      expect(database.prepare(`SELECT COUNT(*) count FROM admin_operational_event`).get()).toEqual({ count: 2 });
      expect(database.prepare(`SELECT COUNT(*) count FROM admin_operational_event_occurrence`).get()).toEqual({ count: 2 });
      expect(database.prepare(`
        SELECT COUNT(*) count
          FROM admin_operational_event_occurrence occurrence
          JOIN admin_operational_event event
            ON event.id = occurrence.eventId
      `).get()).toEqual({ count: 2 });
      expect(database.prepare(`SELECT COUNT(*) count FROM pragma_table_info('admin_operational_event') WHERE name IN ('memoryJobId', 'memoryCandidateId')`).get()).toEqual({ count: 0 });
      expect(database.prepare(`PRAGMA integrity_check`).get()).toEqual({ integrity_check: 'ok' });
    } finally {
      database.close();
    }
    const pendingModel = JSON.parse(readFileSync(fixture.modelConfig, 'utf8'));
    expect(pendingModel).toMatchObject({ schemaVersion: 2, savedRevision: 5, appliedRevision: 4 });
    expect(pendingModel.bindings.find((binding: { workload: string }) => binding.workload === 'memory.extract')).toEqual({
      workload: 'memory.extract',
      mode: 'inheritMain',
    });
    expect(pendingModel.bindings.some(
      (binding: { workload: string }) => binding.workload === 'chatluna.defaultEmbedding',
    )).toBe(false);
    expect(readFileSync(join(fixture.runtimeContextDir, 'empty.yml'), 'utf8')).not.toContain('longMemory');
    expect(await inspectMemoryV2Status(fixture.database)).toEqual({ state: 'v2', schemaVersion: 2 });
    expect(readFileSync(join(fixture.backupDir, 'model-config.json'), 'utf8')).toContain('"savedRevision": 4');
    for (const backupPath of [
      join(fixture.backupDir, 'koishi.db'),
      join(fixture.backupDir, 'model-config.json'),
      join(fixture.backupDir, 'preflight-report.json'),
      join(fixture.backupDir, 'runtime-context-presets', 'empty.yml'),
    ]) {
      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    }
  });

  it('ignores a forged future missing-anchor observation and processes a newer message', async () => {
    const fixture = createFixture();
    canonicalizeFixtureUserOne(fixture.database);
    const legacy = new DatabaseSync(fixture.database);
    try {
      const row = legacy.prepare(
        `SELECT id, payload
           FROM memory_job
          WHERE payload LIKE ?
          ORDER BY id
          LIMIT 1`,
      ).get(`%${REVIEWED_MISSING_ANCHOR_IDS[0]}%`) as {
        id: number;
        payload: string;
      };
      const payload = JSON.parse(row.payload) as {
        address: { observedAt: number };
      };
      payload.address.observedAt = 9_000_000_000_000_000;
      legacy.prepare(
        'UPDATE memory_job SET payload = ? WHERE id = ?',
      ).run(JSON.stringify(payload), row.id);
    } finally {
      legacy.close();
    }
    const plan = await buildMemoryV2MigrationPlan(options(fixture, 'preflight'));
    await preflight(fixture);
    await applyMemoryV2Cutover(options(fixture, 'apply'), plan);

    const laneKey = createMemoryExtractLaneKey('onebot:user:1', 'ctx-1');
    const latestTrustedAnchor = plan.deadLetters
      .filter((record) => (
        record.laneKey === laneKey && record.anchorMessageAt != null
      ))
      .sort((left, right) => (
        left.anchorMessageAt! - right.anchorMessageAt!
        || left.legacyId - right.legacyId
      ))
      .at(-1);
    expect(latestTrustedAnchor).toBeDefined();
    const postCutoverMessageId = 'post-cutover-anchor';
    const observedAt = latestTrustedAnchor!.anchorMessageAt! + 1_000;

    await withMemoryRuntime(fixture.database, async (database, store) => {
      await database.create('chatluna_conversation', {
        id: 'conversation-ctx-1',
        latestMessageId: postCutoverMessageId,
      });
      await database.create('chatluna_message', {
        id: postCutoverMessageId,
        conversationId: 'conversation-ctx-1',
        parentId: latestTrustedAnchor!.latestAnchorMessageId,
        role: 'human',
        content: 'only-the-post-cutover-message',
        name: 'User 1',
        createdAt: observedAt,
      });
      const address = {
        userKey: 'onebot:user:1',
        contextKey: 'ctx-1',
        channelType: 'group' as const,
        platform: 'onebot',
        botSelfId: 'bot',
        userId: '1',
        groupId: 'group-1',
        channelId: 'group-1',
        rawContextId: 'raw-1',
        conversationId: 'conversation-ctx-1',
        currentAudienceSubjectKeys: ['onebot:user:1'],
        observedAt,
      };

      await expect(store.queueExtractWork({
        address,
        targetSpeakerId: '1',
        targetSpeakerName: 'User 1',
        maxMessages: 10,
        nextRunAt: 0,
      })).resolves.toBe(true);
      const claimed = await store.claimDueWork('extract', Date.now(), 60_000);
      expect(claimed?.work.laneKey).toBe(laneKey);
      const payload = store.parseWorkPayload<ExtractWorkPayload>(claimed!.work);
      const window = await store.readConversationWindow(payload);
      expect(window.map((turn) => turn.id)).toEqual([postCutoverMessageId]);

      await store.completeEmptyExtraction(
        claimed!.work,
        claimed!.leaseToken,
        payload,
        'post-cutover-window',
      );
      const cursors = await database.get(MEMORY_LEDGER_TABLES.cursor, { laneKey });
      expect(cursors).toHaveLength(1);
      expect(cursors[0]).toMatchObject({
        lastMessageId: postCutoverMessageId,
        discardBeforeMessageId: null,
      });
      await expect(store.queueExtractWork({
        address,
        targetSpeakerId: '1',
        targetSpeakerName: 'User 1',
        maxMessages: 10,
        nextRunAt: 0,
      })).resolves.toBe(false);
      expect(await database.get(MEMORY_LEDGER_TABLES.cursor, { laneKey }))
        .toHaveLength(1);
    });
  });

  it('verifies startup only after the pending model revision becomes applied', async () => {
    const fixture = createFixture();
    await preflight(fixture);
    await applyMemoryV2Cutover(options(fixture, 'apply'));
    await expect(verifyMemoryV2Cutover(options(fixture, 'verify'))).rejects.toThrow(
      'is not applied',
    );
    markModelRevisionApplied(fixture.modelConfig);
    await expect(
      verifyMemoryV2Cutover(options(fixture, 'bootstrap-verify')),
    ).resolves.toMatchObject({
      savedRevision: 5,
      appliedRevision: 5,
      extractionMode: 'inheritMain',
      active: 59,
      fts: 59,
      embeddings: 0,
      backfillPending: 59,
      strandedBeforeBackfill: 59,
    });
    await expect(verifyMemoryV2Cutover(options(fixture, 'verify'))).rejects.toThrow(
      'final gate is incomplete',
    );
    completeBackfill(fixture.database);
    await expect(verifyMemoryV2Cutover(options(fixture, 'verify'))).resolves.toMatchObject({
      savedRevision: 5,
      appliedRevision: 5,
      extractionMode: 'inheritMain',
      active: 59,
      fts: 59,
      embeddings: 59,
      backfillSucceeded: 59,
      backfillIncomplete: 0,
      stranded: 0,
    });
  });

  it('allows ChatLuna core to recreate an empty shared docstore after cutover', async () => {
    const fixture = createFixture();
    await preflight(fixture);
    await applyMemoryV2Cutover(options(fixture, 'apply'));
    markModelRevisionApplied(fixture.modelConfig);
    const database = new DatabaseSync(fixture.database);
    try {
      database.exec(`
        CREATE TABLE "chatluna_docstore" (
          "key" TEXT,
          "id" TEXT,
          "pageContent" TEXT DEFAULT '',
          "metadata" TEXT DEFAULT '{}',
          "createdAt" INTEGER,
          PRIMARY KEY ("key", "id")
        )
      `);
    } finally {
      database.close();
    }

    await expect(
      verifyMemoryV2Cutover(options(fixture, 'bootstrap-verify')),
    ).resolves.toMatchObject({
      active: 59,
      backfillPending: 59,
    });

    const populated = new DatabaseSync(fixture.database);
    try {
      populated.prepare(`
        INSERT INTO "chatluna_docstore" (
          "key", "id", "pageContent", "metadata", "createdAt"
        ) VALUES (?, ?, ?, ?, ?)
      `).run('long-memory', 'legacy', 'legacy memory', '{}', 1);
    } finally {
      populated.close();
    }
    await expect(
      verifyMemoryV2Cutover(options(fixture, 'bootstrap-verify')),
    ).rejects.toThrow('ChatLuna docstore must be empty after cutover');
  });

  it('allows runtime operational event create, update, and resolve across both verification phases', async () => {
    const fixture = createFixture();
    await preflight(fixture);
    await applyMemoryV2Cutover(options(fixture, 'apply'));
    markModelRevisionApplied(fixture.modelConfig);

    simulateOperationalRuntimeMutation(fixture.database, 'bootstrap');
    await expect(
      verifyMemoryV2Cutover(options(fixture, 'bootstrap-verify')),
    ).resolves.toMatchObject({
      active: 59,
      backfillPending: 59,
    });

    completeBackfill(fixture.database);
    simulateOperationalRuntimeMutation(fixture.database, 'final');
    await expect(
      verifyMemoryV2Cutover(options(fixture, 'verify')),
    ).resolves.toMatchObject({
      active: 59,
      backfillSucceeded: 59,
      stranded: 0,
    });
  });

  it('preserves allocator high-water marks above MAX(id) and allocates runtime rows above them', async () => {
    const fixture = createFixture();
    const source = new DatabaseSync(fixture.database);
    try {
      source.prepare(
        `UPDATE "sqlite_sequence"
            SET "seq" = 1000
          WHERE "name" = 'admin_operational_event'`,
      ).run();
      source.prepare(
        `UPDATE "sqlite_sequence"
            SET "seq" = 2000
          WHERE "name" = 'admin_operational_event_occurrence'`,
      ).run();
    } finally {
      source.close();
    }
    const plan = await buildMemoryV2MigrationPlan(options(fixture, 'preflight'));
    expect(plan.report.database.operationalEvents).toMatchObject({
      sourceEventBoundaryId: 1000,
      sourceOccurrenceBoundaryId: 2000,
    });
    await preflight(fixture);
    await applyMemoryV2Cutover(options(fixture, 'apply'));
    markModelRevisionApplied(fixture.modelConfig);

    const applied = new DatabaseSync(fixture.database);
    try {
      expect(applied.prepare(
        `SELECT "name", "seq"
           FROM "sqlite_sequence"
          WHERE "name" IN (
            'admin_operational_event',
            'admin_operational_event_occurrence'
          )
          ORDER BY "name"`,
      ).all()).toEqual([
        { name: 'admin_operational_event', seq: 1000 },
        { name: 'admin_operational_event_occurrence', seq: 2000 },
      ]);
    } finally {
      applied.close();
    }

    simulateOperationalRuntimeMutation(fixture.database, 'bootstrap');
    const runtime = new DatabaseSync(fixture.database, { readOnly: true });
    try {
      const event = runtime.prepare(
        `SELECT "id"
           FROM "admin_operational_event"
          WHERE "sourceKey" = 'runtime:post-cutover'`,
      ).get() as { id: number };
      const occurrence = runtime.prepare(
        `SELECT "id"
           FROM "admin_operational_event_occurrence"
          WHERE "sourceKey" = 'runtime:post-cutover:occurrence'`,
      ).get() as { id: number };
      expect(event.id).toBeGreaterThan(1000);
      expect(occurrence.id).toBeGreaterThan(2000);
    } finally {
      runtime.close();
    }
    await expect(
      verifyMemoryV2Cutover(options(fixture, 'bootstrap-verify')),
    ).resolves.toMatchObject({
      active: 59,
      backfillPending: 59,
    });
  });

  it.each([
    [
      'missing sequence row',
      (database: DatabaseSync) => {
        database.prepare(
          `DELETE FROM "sqlite_sequence"
            WHERE "name" = 'admin_operational_event'`,
        ).run();
      },
      /allocator state is missing or duplicated/u,
    ],
    [
      'non-AUTOINCREMENT occurrence table',
      (database: DatabaseSync) => {
        database.exec(`
          ALTER TABLE "admin_operational_event_occurrence"
            RENAME TO "_non_autoincrement_occurrence";
          CREATE TABLE "admin_operational_event_occurrence" (
            "id" INTEGER PRIMARY KEY,
            "sourceKey" TEXT NOT NULL UNIQUE,
            "eventId" INTEGER NOT NULL,
            "summary" TEXT NOT NULL,
            "details" TEXT NOT NULL,
            "occurrenceCount" INTEGER NOT NULL,
            "unit" TEXT,
            "invocationId" TEXT,
            "firstOccurredAt" REAL NOT NULL,
            "lastOccurredAt" REAL NOT NULL,
            "updatedAt" REAL NOT NULL
          );
          INSERT INTO "admin_operational_event_occurrence"
          SELECT * FROM "_non_autoincrement_occurrence";
          DROP TABLE "_non_autoincrement_occurrence";
        `);
      },
      /failed isolated allocator probe/u,
    ],
  ])('rejects invalid source allocator state: %s', async (
    _case,
    mutate,
    expected,
  ) => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.database);
    try {
      mutate(database);
    } finally {
      database.close();
    }

    await expect(
      buildMemoryV2MigrationPlan(options(fixture, 'preflight')),
    ).rejects.toThrow(expected);
  });

  it.each([
    ['comment token', 'comment'],
    ['string literal', 'literal'],
    ['different AUTOINCREMENT column', 'other-column'],
    ['fixed id default with a shadow allocator', 'shadow-default'],
    ['generated shadow column', 'generated'],
  ] as const)('rejects an allocator DDL spoof using a %s', async (
    _case,
    spoof,
  ) => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.database);
    try {
      replaceOccurrenceAllocatorSchema(database, spoof);
    } finally {
      database.close();
    }

    await expect(
      buildMemoryV2MigrationPlan(options(fixture, 'preflight')),
    ).rejects.toThrow('failed isolated allocator probe');
  });

  it('rejects a post-start operational event injected into a historical low-ID gap', async () => {
    const fixture = createFixture();
    await preflight(fixture);
    await applyMemoryV2Cutover(options(fixture, 'apply'));
    markModelRevisionApplied(fixture.modelConfig);
    const database = new DatabaseSync(fixture.database);
    try {
      database.prepare(
        `INSERT INTO "admin_operational_event" (
          "id", "sourceKey", "source", "type", "severity", "status",
          "resolution", "title", "summary", "unit", "invocationId",
          "occurredAt", "acknowledgedAt", "resolvedAt", "updatedAt",
          "component", "fingerprint", "details", "occurrenceCount",
          "lastOccurredAt"
        ) VALUES (
          1, 'tampered:historical-gap', 'runtime', 'runtime_warning',
          'warning', 'open', NULL, 'Injected historical row',
          'Injected historical row', NULL, NULL, 70000, NULL, NULL, 70000,
          'runtime', NULL, 'Injected historical row', 1, 70000
        )`,
      ).run();
    } finally {
      database.close();
    }

    await expect(
      verifyMemoryV2Cutover(options(fixture, 'bootstrap-verify')),
    ).rejects.toThrow('preservation identities changed');
  });

  it('rejects a post-start orphan operational occurrence', async () => {
    const fixture = createFixture();
    await preflight(fixture);
    await applyMemoryV2Cutover(options(fixture, 'apply'));
    markModelRevisionApplied(fixture.modelConfig);
    const database = new DatabaseSync(fixture.database);
    try {
      database.prepare(
        `INSERT INTO "admin_operational_event_occurrence" (
          "sourceKey", "eventId", "summary", "details", "occurrenceCount",
          "unit", "invocationId", "firstOccurredAt", "lastOccurredAt",
          "updatedAt"
        ) VALUES (
          'tampered:orphan', 999999, 'Orphan', 'Orphan', 1, NULL, NULL,
          70000, 70000, 70000
        )`,
      ).run();
    } finally {
      database.close();
    }

    await expect(
      verifyMemoryV2Cutover(options(fixture, 'bootstrap-verify')),
    ).rejects.toThrow('contain orphan event references');
  });

  it('rejects deletion of a preserved occurrence while its event remains', async () => {
    const fixture = createFixture();
    await preflight(fixture);
    await applyMemoryV2Cutover(options(fixture, 'apply'));
    markModelRevisionApplied(fixture.modelConfig);
    const database = new DatabaseSync(fixture.database);
    try {
      database.prepare(
        `DELETE FROM "admin_operational_event_occurrence"
          WHERE "sourceKey" = 'runtime:1:occurrence:1'`,
      ).run();
    } finally {
      database.close();
    }

    await expect(
      verifyMemoryV2Cutover(options(fixture, 'bootstrap-verify')),
    ).rejects.toThrow('lost preserved records');
  });

  it.each([
    [
      'event sequence deletion',
      `DELETE FROM "sqlite_sequence"
        WHERE "name" = 'admin_operational_event'`,
    ],
    [
      'occurrence sequence rollback',
      `UPDATE "sqlite_sequence"
          SET "seq" = 0
        WHERE "name" = 'admin_operational_event_occurrence'`,
    ],
  ])('rejects post-start allocator state tampering: %s', async (_case, sql) => {
    const fixture = createFixture();
    await preflight(fixture);
    await applyMemoryV2Cutover(options(fixture, 'apply'));
    markModelRevisionApplied(fixture.modelConfig);
    const database = new DatabaseSync(fixture.database);
    try {
      database.exec(sql);
    } finally {
      database.close();
    }

    await expect(
      verifyMemoryV2Cutover(options(fixture, 'bootstrap-verify')),
    ).rejects.toThrow('runtime ID boundary regressed');
  });

  it('rejects post-start replacement with a spoofed allocator table', async () => {
    const fixture = createFixture();
    await preflight(fixture);
    await applyMemoryV2Cutover(options(fixture, 'apply'));
    markModelRevisionApplied(fixture.modelConfig);
    const database = new DatabaseSync(fixture.database);
    try {
      replaceOccurrenceAllocatorSchema(database, 'shadow-default');
    } finally {
      database.close();
    }

    await expect(
      verifyMemoryV2Cutover(options(fixture, 'bootstrap-verify')),
    ).rejects.toThrow('failed isolated allocator probe');
  });

  it.each([
    [
      'deletion',
      (database: DatabaseSync) => {
        const event = database.prepare(
          `SELECT "id" FROM "admin_operational_event" WHERE "sourceKey" = 'runtime:1'`,
        ).get() as { id: number };
        database.prepare(
          `DELETE FROM "admin_operational_event_occurrence" WHERE "eventId" = ?`,
        ).run(event.id);
        database.prepare(
          `DELETE FROM "admin_operational_event" WHERE "id" = ?`,
        ).run(event.id);
      },
    ],
    [
      'identity corruption',
      (database: DatabaseSync) => {
        database.prepare(
          `UPDATE "admin_operational_event"
              SET "title" = 'tampered preserved title'
            WHERE "sourceKey" = 'runtime:1'`,
        ).run();
        database.prepare(
          `UPDATE "admin_operational_event_occurrence"
              SET "sourceKey" = 'tampered:occurrence'
            WHERE "sourceKey" = 'runtime:1:occurrence:1'`,
        ).run();
      },
    ],
  ])('rejects preserved operational event %s after runtime starts', async (
    _case,
    tamper,
  ) => {
    const fixture = createFixture();
    await preflight(fixture);
    await applyMemoryV2Cutover(options(fixture, 'apply'));
    markModelRevisionApplied(fixture.modelConfig);
    const database = new DatabaseSync(fixture.database);
    try {
      tamper(database);
    } finally {
      database.close();
    }

    await expect(
      verifyMemoryV2Cutover(options(fixture, 'bootstrap-verify')),
    ).rejects.toThrow(/lost preserved records|preservation identities changed/u);
  });

  it('requires three semantic probes per workload while memory read and write stay closed', async () => {
    const fixture = createFixture();
    await preflight(fixture);
    const requests: Array<{ target: string; origin: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const target = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      const origin = new Headers(init?.headers).get('origin');
      requests.push({ target, origin });
      const embedding = target === 'memory.embedding';
      return new Response(JSON.stringify({
        target,
        ok: true,
        checkedAt: Date.now(),
        latencyMs: 1,
        canonicalModel: embedding
          ? 'qqbot-siliconflow/qwen-qwen3-embedding-8b'
          : 'qqbot-codex/gpt-5.6-luna',
        schemaValid: true,
        dimensions: embedding ? 4_096 : null,
        error: null,
        snapshot: {
          schemaVersion: 2,
          available: true,
          enabled: true,
          maintenance: false,
          readEnabled: false,
          writeEnabled: false,
          extractConfigured: true,
          embedConfigured: true,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const probeOptions = options(fixture, 'probe-gate');
    probeOptions.adminOrigin = 'http://127.0.0.1:5140';
    await expect(runMemoryV2ProbeGate(probeOptions)).resolves.toEqual({
      state: 'ready',
      attemptsPerWorkload: 3,
      extraction: {
        canonicalModel: 'qqbot-codex/gpt-5.6-luna',
        schemaValid: true,
      },
      embedding: {
        canonicalModel: 'qqbot-siliconflow/qwen-qwen3-embedding-8b',
        schemaValid: true,
        dimensions: 4_096,
      },
      runtime: {
        enabled: true,
        maintenance: false,
        readEnabled: false,
        writeEnabled: false,
      },
    });
    expect(requests).toEqual([
      { target: 'memory.extract', origin: 'http://127.0.0.1:5140' },
      { target: 'memory.extract', origin: 'http://127.0.0.1:5140' },
      { target: 'memory.extract', origin: 'http://127.0.0.1:5140' },
      { target: 'memory.embedding', origin: 'http://127.0.0.1:5140' },
      { target: 'memory.embedding', origin: 'http://127.0.0.1:5140' },
      { target: 'memory.embedding', origin: 'http://127.0.0.1:5140' },
    ]);
  });

  it('rejects semantic probes if recall is already open', async () => {
    const fixture = createFixture();
    await preflight(fixture);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      target: 'memory.extract',
      ok: true,
      checkedAt: Date.now(),
      latencyMs: 1,
      canonicalModel: 'qqbot-codex/gpt-5.6-luna',
      schemaValid: true,
      dimensions: null,
      error: null,
      snapshot: {
        schemaVersion: 2,
        available: true,
        enabled: true,
        maintenance: false,
        readEnabled: true,
        writeEnabled: false,
        extractConfigured: true,
        embedConfigured: true,
      },
    }), { status: 200 })));
    const probeOptions = options(fixture, 'probe-gate');
    probeOptions.adminOrigin = 'http://127.0.0.1:5140';
    await expect(runMemoryV2ProbeGate(probeOptions)).rejects.toThrow(
      'failed the release contract',
    );
  });

  it('rejects count drift before stopping or changing production files', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.database);
    database.prepare(`DELETE FROM memory_fact WHERE id = 1`).run();
    database.close();
    await expect(buildMemoryV2MigrationPlan(options(fixture, 'preflight'))).rejects.toThrow(
      'memory_fact count drifted',
    );
    expect(JSON.parse(readFileSync(fixture.modelConfig, 'utf8')).savedRevision).toBe(4);
  });

  it.each([
    ['targetSpeakerName', 'recoverable-speaker'],
    ['evidenceSpeakerIds', '["23"]'],
    ['memoryKey', 'recoverable-stream'],
    ['scopeKey', 'onebot:bot:group:group-1:unexpected:1'],
  ] as const)(
    'rejects a purge row that retains or invents %s without changing baseline counts',
    async (column, value) => {
      const fixture = createFixture();
      const database = new DatabaseSync(fixture.database);
      database.prepare(
        `UPDATE memory_fact
            SET "${column}" = ?
          WHERE id = (
            SELECT id
              FROM memory_fact
             WHERE attributionStatus = ''
             ORDER BY id
             LIMIT 1
          )`,
      ).run(value);
      database.close();
      await expect(
        buildMemoryV2MigrationPlan(options(fixture, 'preflight')),
      ).rejects.toThrow(/approved permanent-purge|canonical legacy|approved legacy/u);
    },
  );

  it('allows a canonical missing catalog identity only in the purge classification', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.database);
    database.prepare(
      `UPDATE memory_fact
          SET scopeKey = 'onebot:bot:group:missing-group:user:missing-user'
        WHERE id = (
          SELECT id
            FROM memory_fact
           WHERE attributionStatus = ''
           ORDER BY id
           LIMIT 1
        )`,
    ).run();
    database.close();

    const plan = await buildMemoryV2MigrationPlan(options(fixture, 'preflight'));
    expect(plan.report.decisions.purgeScopeCatalog).toMatchObject({
      resolved: 313,
      missingUserAndContext: 1,
    });
    expect(plan.report.decisions.purgeScopeCatalog.unresolvedDigest).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(JSON.stringify(plan.report)).not.toContain('missing-user');
    expect(JSON.stringify(plan.report)).not.toContain('missing-group');
  });

  it('rejects a syntactically valid purge scope with an unknown runtime identity', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.database);
    database.prepare(
      `UPDATE memory_fact
          SET scopeKey = 'unknown:unknown:group:group-1:user:1'
        WHERE id = (
          SELECT id
            FROM memory_fact
           WHERE attributionStatus = ''
           ORDER BY id
           LIMIT 1
        )`,
    ).run();
    database.close();
    await expect(
      buildMemoryV2MigrationPlan(options(fixture, 'preflight')),
    ).rejects.toThrow('uses an unknown runtime identity');
  });

  it('accepts only the exact frozen reviewed missing-anchor baseline', async () => {
    const fixture = createFixture();
    const plan = await buildMemoryV2MigrationPlan(options(fixture, 'preflight'));
    expect(plan.report.decisions).toMatchObject({
      deadLetterMissingAnchorRecords: 22,
      deadLetterMissingAnchors: 20,
      deadLetterMissingAnchorDigest:
        '52efe1d0da8d95d2c38a5cce7168e76efc13153ec82756de00569268667c0f16',
    });

    const database = new DatabaseSync(fixture.database);
    database.prepare(`DELETE FROM chatluna_message WHERE id = 'anchor-36'`).run();
    database.close();

    await expect(
      buildMemoryV2MigrationPlan(options(fixture, 'preflight')),
    ).rejects.toThrow('frozen reviewed production baseline');
  });

  it('rejects a dead-letter anchor from another conversation', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.database);
    database.prepare(
      `UPDATE chatluna_message
          SET conversationId = 'conversation-ctx-2'
        WHERE id = 'anchor-36'`,
    ).run();
    database.close();
    await expect(
      buildMemoryV2MigrationPlan(options(fixture, 'preflight')),
    ).rejects.toThrow('anchor belongs to a different conversation');
  });

  it('rejects dead-letter anchors that fork within one extraction lane', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.database);
    database.prepare(
      `UPDATE chatluna_message SET parentId = 'cursor-0' WHERE id = 'anchor-36'`,
    ).run();
    const jobs = database.prepare(
      `SELECT id, payload FROM memory_job ORDER BY id`,
    ).all() as Array<{ id: number; payload: string }>;
    const update = database.prepare(`UPDATE memory_job SET payload = ? WHERE id = ?`);
    for (const row of jobs) {
      const payload = JSON.parse(row.payload) as {
        latestAnchorMessageId: string;
        rangeStartAfterMessageId: string | null;
      };
      if (payload.latestAnchorMessageId !== 'anchor-36') continue;
      payload.rangeStartAfterMessageId = 'cursor-0';
      update.run(JSON.stringify(payload), row.id);
    }
    database.close();
    await expect(
      buildMemoryV2MigrationPlan(options(fixture, 'preflight')),
    ).rejects.toThrow('anchors form a fork');
  });

  it('never regresses a legacy cursor newer than all discarded windows', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.database);
    database.prepare(
      `UPDATE memory_extract_cursor
          SET lastExtractedAt = 90000
        WHERE ownerUserKey = 'user-1' AND contextKey = 'ctx-1'`,
    ).run();
    database.close();
    await preflight(fixture);
    await applyMemoryV2Cutover(options(fixture, 'apply'));

    const migrated = new DatabaseSync(fixture.database, { readOnly: true });
    try {
      expect(migrated.prepare(
        `SELECT conversationId, lastMessageId, lastMessageAt,
                lastWindowHash, discardBeforeMessageId
           FROM memory_v2_cursor
          WHERE laneKey = ?`,
      ).get(createMemoryExtractLaneKey('user-1', 'ctx-1'))).toMatchObject({
        conversationId: 'conversation-ctx-1',
        lastMessageId: 'cursor-0',
        lastMessageAt: 90000,
        discardBeforeMessageId: null,
        lastWindowHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
    } finally {
      migrated.close();
    }
  });

  it('rejects a legacy derived profile without active assertion sources', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.database);
    database.prepare(
      `UPDATE memory_profile
          SET ownerUserKey = 'user-23', sourceContextKey = 'ctx-15'
        WHERE id = 1`,
    ).run();
    database.close();
    await expect(buildMemoryV2MigrationPlan(options(fixture, 'preflight'))).rejects.toThrow(
      'has no active assertion source for derived-on-read reconstruction',
    );
  });

  it('rejects verified evidence attributed to a different immutable principal', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.database);
    database.prepare(
      `UPDATE memory_fact
          SET targetSpeakerId = '23', evidenceSpeakerIds = '["23"]'
        WHERE id = 1`,
    ).run();
    database.close();
    await expect(buildMemoryV2MigrationPlan(options(fixture, 'preflight'))).rejects.toThrow(
      'evidence speaker does not match the immutable principal userId',
    );
  });

  it('rejects duplicate immutable platform principal identities', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.database);
    database.prepare(
      `UPDATE memory_user SET userId = '1' WHERE userKey = 'user-2'`,
    ).run();
    database.close();
    await expect(buildMemoryV2MigrationPlan(options(fixture, 'preflight'))).rejects.toThrow(
      'duplicate immutable platform user identities',
    );
  });

  it('rejects an active assertion without exact verified provenance', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.database);
    database.prepare(
      `UPDATE memory_provenance
          SET attributionStatus = 'unknown'
        WHERE memoryType = 'fact' AND memoryId = 1`,
    ).run();
    database.close();
    await expect(buildMemoryV2MigrationPlan(options(fixture, 'preflight'))).rejects.toThrow(
      'fact 1 has no exact verified provenance',
    );
  });

  it('rejects source drift between preflight and apply', async () => {
    const fixture = createFixture();
    await preflight(fixture);
    const database = new DatabaseSync(fixture.database);
    database.prepare(`UPDATE memory_fact SET content = 'drifted' WHERE id = 1`).run();
    database.close();
    await expect(applyMemoryV2Cutover(options(fixture, 'apply'))).rejects.toThrow(
      'changed after preflight',
    );
    expect(await inspectMemoryV2Status(fixture.database)).toEqual({ state: 'legacy', schemaVersion: null });
    expect(JSON.parse(readFileSync(fixture.modelConfig, 'utf8')).savedRevision).toBe(4);
  });

  it.each([
    [
      'index',
      `CREATE INDEX unexpected_memory_fact_index
         ON memory_fact (ownerUserKey)`,
    ],
    [
      'trigger',
      `CREATE TRIGGER unexpected_memory_fact_trigger
         AFTER UPDATE ON memory_fact
         BEGIN
           SELECT 1;
         END`,
    ],
    [
      'view',
      `CREATE VIEW unexpected_memory_fact_view AS
         SELECT id FROM memory_fact`,
    ],
  ])('rejects an unknown relevant SQLite %s', async (_type, sql) => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.database);
    database.exec(sql);
    database.close();

    await expect(
      buildMemoryV2MigrationPlan(options(fixture, 'preflight')),
    ).rejects.toThrow(/Unknown relevant SQLite (?:index|trigger|view) blocks cutover/u);
  });

  it('rejects relevant SQLite schema drift between preflight and apply', async () => {
    const fixture = createFixture();
    await preflight(fixture);
    const database = new DatabaseSync(fixture.database);
    database.exec(
      `CREATE INDEX "index:memory_user:userKey"
         ON memory_user (userKey ASC)`,
    );
    database.close();

    await expect(
      applyMemoryV2Cutover(options(fixture, 'apply')),
    ).rejects.toThrow('changed after preflight');
    expect(await inspectMemoryV2Status(fixture.database)).toEqual({
      state: 'legacy',
      schemaVersion: null,
    });
  });

  it('rejects preserved Admin event or occurrence drift before publish', async () => {
    const fixture = createFixture();
    await preflight(fixture);
    const database = new DatabaseSync(fixture.database);
    database.prepare(
      `UPDATE admin_operational_event_occurrence
          SET summary = 'concurrent operator update'
        WHERE id = 1`,
    ).run();
    database.close();
    await expect(applyMemoryV2Cutover(options(fixture, 'apply'))).rejects.toThrow(
      'changed after preflight',
    );
    expect(await inspectMemoryV2Status(fixture.database)).toEqual({
      state: 'legacy',
      schemaVersion: null,
    });
  });

  it('uses a model-config CAS and preserves a concurrent stopped-state edit', async () => {
    const fixture = createFixture();
    await preflight(fixture);
    const applyOptions = options(fixture, 'apply');
    applyOptions.injectFault = (point) => {
      if (point !== 'after-preset-publish') return;
      const model = JSON.parse(readFileSync(fixture.modelConfig, 'utf8'));
      model.connections[0].displayName = 'Concurrent operator edit';
      writeFileSync(
        fixture.modelConfig,
        `${JSON.stringify(model, null, 2)}\n`,
        { mode: 0o600 },
      );
    };
    await expect(applyMemoryV2Cutover(applyOptions)).rejects.toThrow(
      'changed after Memory V2 preflight',
    );
    expect(await inspectMemoryV2Status(fixture.database)).toEqual({
      state: 'legacy',
      schemaVersion: null,
    });
    expect(readFileSync(join(fixture.runtimeContextDir, 'empty.yml'), 'utf8'))
      .toContain('longMemory');
    expect(JSON.parse(readFileSync(fixture.modelConfig, 'utf8')).connections[0].displayName)
      .toBe('Concurrent operator edit');
  });

  it.each([
    'after-schema',
    'after-active-records',
    'before-commit',
    'after-commit',
    'before-publish',
    'after-preset-rename-before-fsync',
    'after-preset-publish',
    'after-model-rename-before-fsync',
    'after-model-publish',
    'after-database-sidecar-cleanup',
    'after-database-rename-before-fsync',
    'after-database-publish',
  ] as const)('rolls back an injected %s fault without partial V2 state', async (faultPoint) => {
    const fixture = createFixture();
    await preflight(fixture);
    const applyOptions = options(fixture, 'apply');
    applyOptions.injectFault = (point) => {
      if (point === faultPoint) throw new Error(`injected-${faultPoint}`);
    };
    await expect(applyMemoryV2Cutover(applyOptions)).rejects.toThrow(
      `injected-${faultPoint}`,
    );
    expect(await inspectMemoryV2Status(fixture.database)).toEqual({ state: 'legacy', schemaVersion: null });
    expect(readFileSync(join(fixture.runtimeContextDir, 'empty.yml'), 'utf8')).toContain('longMemory');
    expect(JSON.parse(readFileSync(fixture.modelConfig, 'utf8')).savedRevision).toBe(4);
  });

  it('refuses apply while either production service is active', async () => {
    const fixture = createFixture(true);
    await preflight(fixture);
    await expect(applyMemoryV2Cutover(options(fixture, 'apply'))).rejects.toThrow(
      'must be inactive',
    );
    expect(await inspectMemoryV2Status(fixture.database)).toEqual({ state: 'legacy', schemaVersion: null });
  });

  it('rejects a non-canonical embedding binding and a bundled longMemory block', async () => {
    const fixture = createFixture();
    const model = JSON.parse(readFileSync(fixture.modelConfig, 'utf8'));
    const embedding = model.bindings.find(
      (binding: { workload: string }) => binding.workload === 'memory.embedding',
    );
    const embeddingProfile = model.models.find(
      (profile: { id: string }) => profile.id === embedding.modelId,
    );
    embedding.modelId = 'wrong-model';
    embeddingProfile.id = 'wrong-model';
    for (const binding of model.bindings) {
      if (
        binding.connectionId === 'siliconflow'
        && binding.modelId === 'qwen-qwen3-embedding-8b'
      ) {
        binding.modelId = 'wrong-model';
      }
    }
    writeFileSync(fixture.modelConfig, `${JSON.stringify(model, null, 2)}\n`, 'utf8');
    await expect(buildMemoryV2MigrationPlan(options(fixture, 'preflight'))).rejects.toThrow(
      'must resolve to siliconflow/qwen-qwen3-embedding-8b',
    );

    writeModelConfig(fixture.modelConfig);
    writeFileSync(join(fixture.bundledContextDir, 'empty.yml'), contextPreset(true), 'utf8');
    await expect(buildMemoryV2MigrationPlan(options(fixture, 'preflight'))).rejects.toThrow(
      'still contains a longMemory block',
    );
  });

  it('requires the obsolete ChatLuna embedding workload only as explicit cutover input', async () => {
    const fixture = createFixture();
    const model = JSON.parse(readFileSync(fixture.modelConfig, 'utf8'));
    model.bindings = model.bindings.filter(
      (binding: { workload: string }) => binding.workload !== 'chatluna.defaultEmbedding',
    );
    writeFileSync(fixture.modelConfig, `${JSON.stringify(model, null, 2)}\n`, 'utf8');
    await expect(buildMemoryV2MigrationPlan(options(fixture, 'preflight'))).rejects.toThrow(
      'requires exactly one chatluna.defaultEmbedding source binding',
    );

    writeModelConfig(fixture.modelConfig);
    const malformed = JSON.parse(readFileSync(fixture.modelConfig, 'utf8'));
    const removedBinding = malformed.bindings.find(
      (binding: { workload: string }) => binding.workload === 'chatluna.defaultEmbedding',
    );
    removedBinding.unexpected = true;
    writeFileSync(fixture.modelConfig, `${JSON.stringify(malformed, null, 2)}\n`, 'utf8');
    await expect(buildMemoryV2MigrationPlan(options(fixture, 'preflight'))).rejects.toThrow(
      'chatluna.defaultEmbedding source binding failed validation',
    );
  });
});
