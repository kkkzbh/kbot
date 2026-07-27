import type { Context } from 'koishi';
import { MEMORY_LEDGER_SCHEMA_VERSION } from '../../types/memory.js';
import { MemoryRuntimeError } from './errors.js';

export { MEMORY_LEDGER_SCHEMA_VERSION };

export const MEMORY_LEDGER_TABLES = {
  meta: 'memory_v2_meta',
  principal: 'memory_v2_principal',
  context: 'memory_v2_context',
  event: 'memory_v2_event',
  payload: 'memory_v2_payload',
  evidence: 'memory_v2_evidence',
  head: 'memory_v2_head',
  embedding: 'memory_v2_embedding',
  fts: 'memory_v2_fts',
  work: 'memory_v2_work',
  cursor: 'memory_v2_cursor',
  suppression: 'memory_v2_suppression',
  audit: 'memory_v2_audit',
} as const;

export const MEMORY_LEDGER_TABLE_NAMES = Object.freeze(Object.values(MEMORY_LEDGER_TABLES));

export const MEMORY_LEDGER_SQLITE_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS "memory_v2_meta" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" REAL NOT NULL,
    UNIQUE ("key")
  )`,
  `CREATE TABLE IF NOT EXISTS "memory_v2_principal" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "userKey" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "readEnabled" INTEGER NOT NULL,
    "writeEnabled" INTEGER NOT NULL,
    "firstSeenAt" REAL NOT NULL,
    "lastSeenAt" REAL NOT NULL,
    UNIQUE ("userKey")
  )`,
  `CREATE TABLE IF NOT EXISTS "memory_v2_context" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "contextKey" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "botSelfId" TEXT NOT NULL,
    "channelType" TEXT NOT NULL CHECK ("channelType" IN ('direct', 'group')),
    "groupId" TEXT,
    "channelId" TEXT,
    "rawContextId" TEXT,
    "firstSeenAt" REAL NOT NULL,
    "lastSeenAt" REAL NOT NULL,
    UNIQUE ("contextKey")
  )`,
  `CREATE TABLE IF NOT EXISTS "memory_v2_event" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "eventId" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL CHECK ("eventType" IN ('asserted', 'reviewed', 'superseded', 'visibilityChanged', 'retracted', 'forgotten', 'archived')),
    "assertionType" TEXT NOT NULL CHECK ("assertionType" IN ('userAssertion', 'groupArtifact', 'assistantCommitment', 'episode')),
    "subjectType" TEXT NOT NULL CHECK ("subjectType" IN ('user', 'group', 'assistant')),
    "subjectKey" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "sourceContextKey" TEXT NOT NULL,
    "audiencePolicy" TEXT NOT NULL CHECK ("audiencePolicy" IN ('subjectPrivate', 'sourceContext', 'captureAudience', 'subjectAllContexts', 'explicitContexts')),
    "audienceContextKeys" TEXT NOT NULL,
    "audienceSnapshots" TEXT NOT NULL,
    "sensitivity" TEXT NOT NULL CHECK ("sensitivity" IN ('low', 'personal', 'sensitive', 'secret')),
    "payloadId" TEXT,
    "causationId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" REAL NOT NULL,
    UNIQUE ("eventId"),
    UNIQUE ("streamId", "revision"),
    UNIQUE ("idempotencyKey")
  )`,
  `CREATE TABLE IF NOT EXISTS "memory_v2_payload" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "payloadId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "payloadKind" TEXT NOT NULL CHECK ("payloadKind" IN ('assertion', 'evidenceExcerpt')),
    "content" TEXT NOT NULL,
    "retrievalText" TEXT,
    "contentHash" TEXT NOT NULL,
    "createdAt" REAL NOT NULL,
    UNIQUE ("payloadId")
  )`,
  `CREATE TABLE IF NOT EXISTS "memory_v2_evidence" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "evidenceId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "speakerId" TEXT NOT NULL,
    "contextKey" TEXT NOT NULL,
    "threadId" TEXT,
    "captureAudienceSubjectKeys" TEXT NOT NULL,
    "replyToMessageId" TEXT,
    "excerptPayloadId" TEXT,
    "occurredAt" REAL NOT NULL,
    UNIQUE ("evidenceId"),
    UNIQUE ("eventId", "messageId")
  )`,
  `CREATE TABLE IF NOT EXISTS "memory_v2_head" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "streamId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "state" TEXT NOT NULL CHECK ("state" IN ('active', 'pendingReview', 'archived', 'retracted', 'forgotten')),
    "assertionType" TEXT NOT NULL CHECK ("assertionType" IN ('userAssertion', 'groupArtifact', 'assistantCommitment', 'episode')),
    "subjectType" TEXT NOT NULL CHECK ("subjectType" IN ('user', 'group', 'assistant')),
    "subjectKey" TEXT NOT NULL,
    "sourceContextKey" TEXT NOT NULL,
    "audiencePolicy" TEXT NOT NULL CHECK ("audiencePolicy" IN ('subjectPrivate', 'sourceContext', 'captureAudience', 'subjectAllContexts', 'explicitContexts')),
    "audienceContextKeys" TEXT NOT NULL,
    "audienceSnapshots" TEXT NOT NULL,
    "sensitivity" TEXT NOT NULL CHECK ("sensitivity" IN ('low', 'personal', 'sensitive', 'secret')),
    "payloadId" TEXT,
    "contentHash" TEXT,
    "importance" REAL NOT NULL,
    "confidence" REAL NOT NULL,
    "validFrom" REAL,
    "validUntil" REAL,
    "expiresAt" REAL,
    "deletionGeneration" INTEGER NOT NULL,
    "createdAt" REAL NOT NULL,
    "updatedAt" REAL NOT NULL,
    UNIQUE ("streamId")
  )`,
  `CREATE TABLE IF NOT EXISTS "memory_v2_embedding" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "embeddingKey" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "canonicalModel" TEXT NOT NULL,
    "modelRevision" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "vector" TEXT NOT NULL,
    "createdAt" REAL NOT NULL,
    UNIQUE ("embeddingKey"),
    UNIQUE ("streamId", "revision", "canonicalModel", "modelRevision", "contentHash")
  )`,
  `CREATE TABLE IF NOT EXISTS "memory_v2_fts" (
    "streamId" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL CHECK ("revision" > 0),
    "contentHash" TEXT NOT NULL,
    "canonicalText" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL CHECK ("tokenCount" >= 0),
    "termFrequencies" TEXT NOT NULL,
    "createdAt" REAL NOT NULL,
    "updatedAt" REAL NOT NULL,
    UNIQUE ("eventId")
  )`,
  `CREATE TABLE IF NOT EXISTS "memory_v2_work" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "workKey" TEXT NOT NULL,
    "workType" TEXT NOT NULL CHECK ("workType" IN ('extract', 'embed', 'backfill', 'maintenance')),
    "status" TEXT NOT NULL CHECK ("status" IN ('pending', 'leased', 'succeeded', 'failed', 'deadLetter', 'cancelled')),
    "subjectKey" TEXT,
    "contextKey" TEXT,
    "streamId" TEXT,
    "laneKey" TEXT,
    "payload" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "targetRevision" INTEGER,
    "deletionGeneration" INTEGER NOT NULL,
    "retryCount" INTEGER NOT NULL,
    "nextRunAt" REAL NOT NULL,
    "leaseToken" TEXT,
    "leaseExpiresAt" REAL,
    "lastErrorCode" TEXT,
    "lastErrorStage" TEXT,
    "upstreamStatus" INTEGER,
    "providerCode" TEXT,
    "createdAt" REAL NOT NULL,
    "updatedAt" REAL NOT NULL,
    "completedAt" REAL,
    UNIQUE ("workKey")
  )`,
  `CREATE TABLE IF NOT EXISTS "memory_v2_cursor" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "laneKey" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "contextKey" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "lastMessageId" TEXT,
    "lastMessageAt" REAL,
    "lastWindowHash" TEXT,
    "discardBeforeMessageId" TEXT,
    "firstSeenAt" REAL NOT NULL,
    "updatedAt" REAL NOT NULL,
    UNIQUE ("laneKey")
  )`,
  `CREATE TABLE IF NOT EXISTS "memory_v2_suppression" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "suppressionKey" TEXT NOT NULL,
    "subjectKey" TEXT,
    "contextKey" TEXT,
    "streamId" TEXT,
    "sourceMessageDigest" TEXT,
    "cutoffAt" REAL,
    "generation" INTEGER NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "createdAt" REAL NOT NULL,
    UNIQUE ("suppressionKey")
  )`,
  `CREATE TABLE IF NOT EXISTS "memory_v2_audit" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "auditId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "subjectKey" TEXT,
    "contextKey" TEXT,
    "eventType" TEXT NOT NULL,
    "streamId" TEXT,
    "eventId" TEXT,
    "workKey" TEXT,
    "detailJson" TEXT,
    "createdAt" REAL NOT NULL,
    UNIQUE ("auditId"),
    UNIQUE ("idempotencyKey")
  )`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_event_subject_idx" ON "memory_v2_event" ("subjectKey", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_event_stream_idx" ON "memory_v2_event" ("streamId", "revision")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_principal_platform_idx" ON "memory_v2_principal" ("platform", "userId")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_context_platform_idx" ON "memory_v2_context" ("platform", "channelType")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_payload_event_idx" ON "memory_v2_payload" ("eventId", "payloadKind")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_payload_hash_idx" ON "memory_v2_payload" ("contentHash")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_evidence_context_idx" ON "memory_v2_evidence" ("contextKey", "occurredAt")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_evidence_event_idx" ON "memory_v2_evidence" ("eventId")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_head_subject_idx" ON "memory_v2_head" ("subjectKey", "state", "updatedAt")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_head_context_idx" ON "memory_v2_head" ("sourceContextKey", "state", "updatedAt")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_embedding_stream_idx" ON "memory_v2_embedding" ("streamId", "revision")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_fts_hash_idx" ON "memory_v2_fts" ("contentHash")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_work_due_idx" ON "memory_v2_work" ("workType", "status", "nextRunAt")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_work_lease_idx" ON "memory_v2_work" ("status", "leaseExpiresAt")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_work_subject_idx" ON "memory_v2_work" ("subjectKey", "contextKey", "status")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_work_stream_idx" ON "memory_v2_work" ("streamId", "status")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_cursor_subject_idx" ON "memory_v2_cursor" ("subjectKey", "contextKey")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_cursor_conversation_idx" ON "memory_v2_cursor" ("conversationId")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_suppression_subject_idx" ON "memory_v2_suppression" ("subjectKey", "contextKey", "generation")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_suppression_stream_idx" ON "memory_v2_suppression" ("streamId", "generation")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_suppression_source_idx" ON "memory_v2_suppression" ("contextKey", "sourceMessageDigest")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_audit_subject_idx" ON "memory_v2_audit" ("subjectKey", "contextKey", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "memory_v2_audit_work_idx" ON "memory_v2_audit" ("workKey", "createdAt")`,
] as const);

type MemorySchemaDatabaseLike = {
  _driver?: unknown;
};

type MemorySchemaDriverLike = {
  _all(sql: string, params?: unknown[]): unknown[];
};

interface MemorySchemaRelation {
  type: string;
  name: string;
  sql: string;
}

function normalizeSchemaSql(input: string): string {
  return input
    .trim()
    .replace(/;\s*$/u, '')
    .replace(
      /^CREATE\s+(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS/iu,
      'CREATE $1',
    )
    .replace(/\s+/gu, ' ');
}

function canonicalMemoryRelations(): ReadonlyMap<string, MemorySchemaRelation> {
  const relations = new Map<string, MemorySchemaRelation>();
  for (const statement of MEMORY_LEDGER_SQLITE_DDL) {
    const match = statement.match(
      /^CREATE\s+(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"/iu,
    );
    if (!match) {
      throw new Error('Memory Ledger DDL contains an unrecognized relation statement.');
    }
    const type = match[1]!.toLowerCase() as 'table' | 'index';
    const name = match[2]!;
    if (relations.has(name)) {
      throw new Error(`Memory Ledger DDL contains duplicate relation ${name}.`);
    }
    relations.set(name, {
      type,
      name,
      sql: normalizeSchemaSql(statement),
    });
  }
  return relations;
}

const CANONICAL_MEMORY_RELATIONS = canonicalMemoryRelations();

function isMemorySchemaObject(row: {
  name: string;
  tableName: string;
  sql: string;
}): boolean {
  if (
    row.name.startsWith('memory_')
    || row.tableName.startsWith('memory_')
  ) {
    return true;
  }
  return MEMORY_LEDGER_TABLE_NAMES.some((table) => (
    row.sql.includes(`"${table}"`)
    || new RegExp(`\\b${table}\\b`, 'u').test(row.sql)
  ));
}

function memoryLedgerSqliteDriver(databaseValue: unknown): MemorySchemaDriverLike {
  const database = databaseValue as MemorySchemaDatabaseLike;
  const driver = database?._driver as Partial<MemorySchemaDriverLike> | undefined;
  if (typeof driver?._all !== 'function') {
    throw new MemoryRuntimeError(
      'startup',
      'schema',
      'memory_schema_driver_unavailable',
      'Memory Ledger V2 requires direct access to the configured SQLite driver before model registration.',
    );
  }
  return driver as MemorySchemaDriverLike;
}

function assertMemoryLedgerSqliteSchemaWithDriver(
  driver: MemorySchemaDriverLike,
): void {
  const actualRows = driver._all(
    `SELECT "type", "name", "tbl_name" AS "tableName", "sql"
       FROM "sqlite_master"
      WHERE "name" NOT LIKE 'sqlite_autoindex_%'
      ORDER BY "name"`,
  ) as Array<{
    type?: unknown;
    name?: unknown;
    tableName?: unknown;
    sql?: unknown;
  }>;
  const actual = new Map<string, MemorySchemaRelation>();
  for (const row of actualRows) {
    const hasMemoryIdentity = (
      typeof row.name === 'string'
      && row.name.startsWith('memory_')
    ) || (
      typeof row.tableName === 'string'
      && row.tableName.startsWith('memory_')
    );
    if (
      typeof row.type !== 'string'
      || typeof row.name !== 'string'
      || typeof row.tableName !== 'string'
      || typeof row.sql !== 'string'
    ) {
      if (hasMemoryIdentity) {
        throw new MemoryRuntimeError(
          'startup',
          'schema',
          'memory_schema_relation_invalid',
          'Memory Ledger V2 contains an invalid schema relation.',
        );
      }
      continue;
    }
    if (!isMemorySchemaObject({
      name: row.name,
      tableName: row.tableName,
      sql: row.sql,
    })) {
      continue;
    }
    actual.set(row.name, {
      type: row.type,
      name: row.name,
      sql: normalizeSchemaSql(row.sql),
    });
  }

  const missing = [...CANONICAL_MEMORY_RELATIONS.keys()].filter((name) => !actual.has(name));
  const extra = [...actual.keys()].filter((name) => !CANONICAL_MEMORY_RELATIONS.has(name));
  const mutated = [...CANONICAL_MEMORY_RELATIONS.entries()]
    .filter(([name, expected]) => {
      const relation = actual.get(name);
      return relation != null
        && (relation.type !== expected.type || relation.sql !== expected.sql);
    })
    .map(([name]) => name);
  if (missing.length || extra.length || mutated.length) {
    throw new MemoryRuntimeError(
      'startup',
      'schema',
      'memory_schema_contract_invalid',
      `Memory Ledger V2 schema contract failed: missing=${missing.join(',') || '-'}; `
      + `extra=${extra.join(',') || '-'}; mutated=${mutated.join(',') || '-'}.`,
    );
  }
}

export function assertMemoryLedgerSqliteSchema(
  databaseValue: unknown,
): void {
  assertMemoryLedgerSqliteSchemaWithDriver(memoryLedgerSqliteDriver(databaseValue));
}

export function assertMemoryLedgerSqlitePreflight(
  databaseValue: unknown,
): void {
  const driver = memoryLedgerSqliteDriver(databaseValue);
  assertMemoryLedgerSqliteSchemaWithDriver(driver);
  const rows = driver._all(
    `SELECT "value"
       FROM "memory_v2_meta"
      WHERE "key" = ?
      ORDER BY "id"`,
    ['schemaVersion'],
  ) as Array<{ value?: unknown }>;
  if (
    rows.length !== 1
    || String(rows[0]?.value) !== String(MEMORY_LEDGER_SCHEMA_VERSION)
  ) {
    throw new MemoryRuntimeError(
      'startup',
      'schema',
      'memory_schema_version_invalid',
      `Memory Ledger schemaVersion=${MEMORY_LEDGER_SCHEMA_VERSION} is required.`,
    );
  }
}

function registerMemoryModels(ctx: Context): void {
  ctx.model.extend('memory_v2_meta', {
    id: 'unsigned',
    key: 'string',
    value: 'text',
    updatedAt: 'double',
  }, { autoInc: true, unique: ['key'] });

  ctx.model.extend('memory_v2_principal', {
    id: 'unsigned',
    userKey: 'string',
    platform: 'string',
    userId: 'string',
    displayName: { type: 'string', nullable: true },
    avatarUrl: { type: 'string', nullable: true },
    readEnabled: 'unsigned',
    writeEnabled: 'unsigned',
    firstSeenAt: 'double',
    lastSeenAt: 'double',
  }, { autoInc: true, unique: ['userKey'] });

  ctx.model.extend('memory_v2_context', {
    id: 'unsigned',
    contextKey: 'string',
    platform: 'string',
    botSelfId: 'string',
    channelType: 'string',
    groupId: { type: 'string', nullable: true },
    channelId: { type: 'string', nullable: true },
    rawContextId: { type: 'string', nullable: true },
    firstSeenAt: 'double',
    lastSeenAt: 'double',
  }, { autoInc: true, unique: ['contextKey'] });

  ctx.model.extend('memory_v2_event', {
    id: 'unsigned',
    eventId: 'string',
    streamId: 'string',
    revision: 'unsigned',
    eventType: 'string',
    assertionType: 'string',
    subjectType: 'string',
    subjectKey: 'string',
    actorKey: 'string',
    sourceContextKey: 'string',
    audiencePolicy: 'string',
    audienceContextKeys: 'text',
    audienceSnapshots: 'text',
    sensitivity: 'string',
    payloadId: { type: 'string', nullable: true },
    causationId: { type: 'string', nullable: true },
    idempotencyKey: 'string',
    createdAt: 'double',
  }, {
    autoInc: true,
    unique: ['eventId', 'idempotencyKey', ['streamId', 'revision']],
  });

  ctx.model.extend('memory_v2_payload', {
    id: 'unsigned',
    payloadId: 'string',
    eventId: 'string',
    payloadKind: 'string',
    content: 'text',
    retrievalText: { type: 'text', nullable: true },
    contentHash: 'string',
    createdAt: 'double',
  }, { autoInc: true, unique: ['payloadId'] });

  ctx.model.extend('memory_v2_evidence', {
    id: 'unsigned',
    evidenceId: 'string',
    eventId: 'string',
    messageId: 'string',
    speakerId: 'string',
    contextKey: 'string',
    threadId: { type: 'string', nullable: true },
    captureAudienceSubjectKeys: 'text',
    replyToMessageId: { type: 'string', nullable: true },
    excerptPayloadId: { type: 'string', nullable: true },
    occurredAt: 'double',
  }, {
    autoInc: true,
    unique: ['evidenceId', ['eventId', 'messageId']],
  });

  ctx.model.extend('memory_v2_head', {
    id: 'unsigned',
    streamId: 'string',
    eventId: 'string',
    revision: 'unsigned',
    state: 'string',
    assertionType: 'string',
    subjectType: 'string',
    subjectKey: 'string',
    sourceContextKey: 'string',
    audiencePolicy: 'string',
    audienceContextKeys: 'text',
    audienceSnapshots: 'text',
    sensitivity: 'string',
    payloadId: { type: 'string', nullable: true },
    contentHash: { type: 'string', nullable: true },
    importance: 'double',
    confidence: 'double',
    validFrom: { type: 'double', nullable: true },
    validUntil: { type: 'double', nullable: true },
    expiresAt: { type: 'double', nullable: true },
    deletionGeneration: 'unsigned',
    createdAt: 'double',
    updatedAt: 'double',
  }, {
    autoInc: true,
    unique: ['streamId'],
  });

  ctx.model.extend('memory_v2_embedding', {
    id: 'unsigned',
    embeddingKey: 'string',
    streamId: 'string',
    eventId: 'string',
    revision: 'unsigned',
    canonicalModel: 'string',
    modelRevision: 'unsigned',
    contentHash: 'string',
    dimensions: 'unsigned',
    vector: 'text',
    createdAt: 'double',
  }, {
    autoInc: true,
    unique: ['embeddingKey', ['streamId', 'revision', 'canonicalModel', 'modelRevision', 'contentHash']],
  });

  ctx.model.extend('memory_v2_work', {
    id: 'unsigned',
    workKey: 'string',
    workType: 'string',
    status: 'string',
    subjectKey: { type: 'string', nullable: true },
    contextKey: { type: 'string', nullable: true },
    streamId: { type: 'string', nullable: true },
    laneKey: { type: 'string', nullable: true },
    payload: 'text',
    inputHash: 'string',
    targetRevision: { type: 'unsigned', nullable: true },
    deletionGeneration: 'unsigned',
    retryCount: 'unsigned',
    nextRunAt: 'double',
    leaseToken: { type: 'string', nullable: true },
    leaseExpiresAt: { type: 'double', nullable: true },
    lastErrorCode: { type: 'string', nullable: true },
    lastErrorStage: { type: 'string', nullable: true },
    upstreamStatus: { type: 'integer', nullable: true },
    providerCode: { type: 'string', nullable: true },
    createdAt: 'double',
    updatedAt: 'double',
    completedAt: { type: 'double', nullable: true },
  }, {
    autoInc: true,
    unique: ['workKey'],
  });

  ctx.model.extend('memory_v2_cursor', {
    id: 'unsigned',
    laneKey: 'string',
    subjectKey: 'string',
    contextKey: 'string',
    conversationId: 'string',
    lastMessageId: { type: 'string', nullable: true },
    lastMessageAt: { type: 'double', nullable: true },
    lastWindowHash: { type: 'string', nullable: true },
    discardBeforeMessageId: { type: 'string', nullable: true },
    firstSeenAt: 'double',
    updatedAt: 'double',
  }, { autoInc: true, unique: ['laneKey'] });

  ctx.model.extend('memory_v2_suppression', {
    id: 'unsigned',
    suppressionKey: 'string',
    subjectKey: { type: 'string', nullable: true },
    contextKey: { type: 'string', nullable: true },
    streamId: { type: 'string', nullable: true },
    sourceMessageDigest: { type: 'string', nullable: true },
    cutoffAt: { type: 'double', nullable: true },
    generation: 'unsigned',
    reasonCode: 'string',
    createdAt: 'double',
  }, {
    autoInc: true,
    unique: ['suppressionKey'],
  });

  ctx.model.extend('memory_v2_audit', {
    id: 'unsigned',
    auditId: 'string',
    idempotencyKey: 'string',
    subjectKey: { type: 'string', nullable: true },
    contextKey: { type: 'string', nullable: true },
    eventType: 'string',
    streamId: { type: 'string', nullable: true },
    eventId: { type: 'string', nullable: true },
    workKey: { type: 'string', nullable: true },
    detailJson: { type: 'text', nullable: true },
    createdAt: 'double',
  }, {
    autoInc: true,
    unique: ['auditId', 'idempotencyKey'],
  });
}

export function registerMemoryLedgerModels(
  ctx: Context,
  databaseValue: unknown,
): void {
  assertMemoryLedgerSqlitePreflight(databaseValue);
  registerMemoryModels(ctx);
}
