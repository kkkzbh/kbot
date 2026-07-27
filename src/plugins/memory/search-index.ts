import { MemoryRuntimeError } from './errors.js';
import { MEMORY_LEDGER_TABLES } from './schema.js';
import type { MemoryDatabaseLike } from './store.js';

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const MAX_QUERY_TERMS = 64;

export interface MemoryLexicalProjectionInput {
  streamId: string;
  eventId: string;
  revision: number;
  contentHash: string;
  canonicalText: string;
}

export interface MemoryLexicalProjectionRow extends MemoryLexicalProjectionInput {
  tokenCount: number;
  termFrequencies: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySearchIndex {
  assertReady(database: MemoryDatabaseLike): Promise<void>;
  insert(database: MemoryDatabaseLike, input: MemoryLexicalProjectionInput): Promise<void>;
  updateIdentity(
    database: MemoryDatabaseLike,
    input: Omit<MemoryLexicalProjectionInput, 'canonicalText'>,
  ): Promise<void>;
  remove(database: MemoryDatabaseLike, streamId: string): Promise<void>;
  get(database: MemoryDatabaseLike, streamId: string): Promise<MemoryLexicalProjectionRow[]>;
  list(database: MemoryDatabaseLike): Promise<MemoryLexicalProjectionRow[]>;
  count(database: MemoryDatabaseLike): Promise<number>;
  search(
    database: MemoryDatabaseLike,
    query: string,
    allowedStreamIds: readonly string[],
    limit: number,
  ): Promise<Map<string, number>>;
}

type SqliteDriverLike = {
  _all(sql: string, params?: unknown[]): unknown[];
  _run(sql: string, params?: unknown[]): unknown;
};

type SqliteMasterRow = {
  sql?: unknown;
};

type SqliteTableInfoRow = {
  name?: unknown;
  type?: unknown;
  notnull?: unknown;
  pk?: unknown;
};

type SqliteIndexListRow = {
  name?: unknown;
  unique?: unknown;
};

type SqliteIndexInfoRow = {
  name?: unknown;
};

function lexicalError(
  operation: 'startup' | 'recall' | 'backfill',
  stage: 'schema' | 'validation' | 'read' | 'write',
  code: string,
  message: string,
  cause?: unknown,
): MemoryRuntimeError {
  return new MemoryRuntimeError(operation, stage, code, message, cause === undefined ? {} : { cause });
}

function sqliteDriver(database: MemoryDatabaseLike): SqliteDriverLike {
  const resolver = (database as unknown as {
    getDriver?: (table: string) => unknown;
  }).getDriver;
  if (typeof resolver !== 'function') {
    throw lexicalError(
      'startup',
      'schema',
      'memory_lexical_driver_unavailable',
      'Memory Ledger V2 requires the configured SQLite driver.',
    );
  }
  const driver = resolver.call(database, MEMORY_LEDGER_TABLES.head) as Partial<SqliteDriverLike>;
  if (typeof driver?._all !== 'function' || typeof driver?._run !== 'function') {
    throw lexicalError(
      'startup',
      'schema',
      'memory_lexical_driver_invalid',
      'Memory Ledger V2 requires SQLite projection operations.',
    );
  }
  return driver as SqliteDriverLike;
}

function normalizedTokens(input: string): string[] {
  const normalized = input.normalize('NFKC').toLowerCase();
  const lexemes = normalized.match(/\p{Script=Han}|[\p{L}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  for (let index = 0; index < lexemes.length; index += 1) {
    const token = lexemes[index]!;
    tokens.push(token);
    if (
      /\p{Script=Han}/u.test(token)
      && index + 1 < lexemes.length
      && /\p{Script=Han}/u.test(lexemes[index + 1]!)
    ) {
      tokens.push(`${token}${lexemes[index + 1]}`);
    }
  }
  return tokens;
}

function canonicalTermFrequencies(tokens: readonly string[]): string {
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return JSON.stringify(Object.fromEntries(
    [...frequencies.entries()].sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function assertProjectionInput(input: MemoryLexicalProjectionInput): void {
  if (
    !input.streamId
    || !input.eventId
    || !Number.isSafeInteger(input.revision)
    || input.revision < 1
    || !input.contentHash
    || !input.canonicalText
    || input.canonicalText.trim() !== input.canonicalText
  ) {
    throw lexicalError(
      'backfill',
      'validation',
      'memory_lexical_projection_input_invalid',
      'Lexical projection identity and canonical text are required.',
    );
  }
}

export function createMemoryLexicalProjection(
  input: MemoryLexicalProjectionInput,
  now = Date.now(),
): MemoryLexicalProjectionRow {
  assertProjectionInput(input);
  if (!Number.isFinite(now) || now < 0) {
    throw lexicalError(
      'backfill',
      'validation',
      'memory_lexical_projection_timestamp_invalid',
      'Lexical projection timestamp is invalid.',
    );
  }
  const tokens = normalizedTokens(input.canonicalText);
  return {
    ...input,
    tokenCount: tokens.length,
    termFrequencies: canonicalTermFrequencies(tokens),
    createdAt: now,
    updatedAt: now,
  };
}

function parseProjectionRow(value: unknown): MemoryLexicalProjectionRow {
  const row = value as Partial<Record<keyof MemoryLexicalProjectionRow, unknown>>;
  const parsed: MemoryLexicalProjectionRow = {
    streamId: typeof row.streamId === 'string' ? row.streamId : '',
    eventId: typeof row.eventId === 'string' ? row.eventId : '',
    revision: Number(row.revision),
    contentHash: typeof row.contentHash === 'string' ? row.contentHash : '',
    canonicalText: typeof row.canonicalText === 'string' ? row.canonicalText : '',
    tokenCount: Number(row.tokenCount),
    termFrequencies: typeof row.termFrequencies === 'string' ? row.termFrequencies : '',
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
  return parsed;
}

export function isMemoryLexicalProjectionValid(row: MemoryLexicalProjectionRow): boolean {
  try {
    assertProjectionInput(row);
    if (
      !Number.isSafeInteger(row.tokenCount)
      || row.tokenCount < 0
      || !Number.isFinite(row.createdAt)
      || row.createdAt < 0
      || !Number.isFinite(row.updatedAt)
      || row.updatedAt < row.createdAt
    ) {
      return false;
    }
    const tokens = normalizedTokens(row.canonicalText);
    return row.tokenCount === tokens.length
      && row.termFrequencies === canonicalTermFrequencies(tokens);
  } catch {
    return false;
  }
}

export function memoryLexicalProjectionMatches(
  row: MemoryLexicalProjectionRow,
  input: MemoryLexicalProjectionInput,
): boolean {
  return isMemoryLexicalProjectionValid(row)
    && row.streamId === input.streamId
    && row.eventId === input.eventId
    && row.revision === input.revision
    && row.contentHash === input.contentHash
    && row.canonicalText === input.canonicalText;
}

function parseTermFrequencies(row: MemoryLexicalProjectionRow): ReadonlyMap<string, number> {
  if (!isMemoryLexicalProjectionValid(row)) {
    throw lexicalError(
      'recall',
      'validation',
      'memory_lexical_projection_invalid',
      'A lexical projection is corrupt and must be rebuilt before recall.',
    );
  }
  const value = JSON.parse(row.termFrequencies) as Record<string, number>;
  return new Map(Object.entries(value));
}

function quoteSqliteIdentifier(input: string): string {
  return `"${input.replaceAll('"', '""')}"`;
}

function assertCanonicalSchema(driver: SqliteDriverLike): void {
  const rows = driver._all(
    `SELECT "sql" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = ?`,
    [MEMORY_LEDGER_TABLES.fts],
  ) as SqliteMasterRow[];
  const sql = typeof rows[0]?.sql === 'string' ? rows[0].sql : '';
  if (
    rows.length !== 1
    || /\bvirtual\s+table\b/iu.test(sql)
    || /\bfts[345]\b/iu.test(sql)
  ) {
    throw lexicalError(
      'startup',
      'schema',
      'memory_lexical_schema_invalid',
      'memory_v2_fts must be the canonical persistent lexical projection table.',
    );
  }

  const expected = [
    ['streamId', 'TEXT', 1, 1],
    ['eventId', 'TEXT', 1, 0],
    ['revision', 'INTEGER', 1, 0],
    ['contentHash', 'TEXT', 1, 0],
    ['canonicalText', 'TEXT', 1, 0],
    ['tokenCount', 'INTEGER', 1, 0],
    ['termFrequencies', 'TEXT', 1, 0],
    ['createdAt', 'REAL', 1, 0],
    ['updatedAt', 'REAL', 1, 0],
  ] as const;
  const columns = driver._all(
    `PRAGMA table_info(${quoteSqliteIdentifier(MEMORY_LEDGER_TABLES.fts)})`,
  ) as SqliteTableInfoRow[];
  const canonicalColumns = columns.length === expected.length
    && expected.every(([name, type, notnull, pk], index) => {
      const column = columns[index];
      return column?.name === name
        && String(column.type ?? '').toUpperCase() === type
        && Number(column.notnull) === notnull
        && Number(column.pk) === pk;
    });
  if (!canonicalColumns) {
    throw lexicalError(
      'startup',
      'schema',
      'memory_lexical_columns_invalid',
      'memory_v2_fts columns do not match the canonical Memory Ledger V2 schema.',
    );
  }

  const indexes = driver._all(
    `PRAGMA index_list(${quoteSqliteIdentifier(MEMORY_LEDGER_TABLES.fts)})`,
  ) as SqliteIndexListRow[];
  const uniqueColumnSets = indexes
    .filter((index) => Number(index.unique) === 1 && typeof index.name === 'string')
    .map((index) => (
      driver._all(
        `PRAGMA index_info(${quoteSqliteIdentifier(String(index.name))})`,
      ) as SqliteIndexInfoRow[]
    ).map((column) => String(column.name ?? '')).join(','));
  if (!uniqueColumnSets.includes('streamId') || !uniqueColumnSets.includes('eventId')) {
    throw lexicalError(
      'startup',
      'schema',
      'memory_lexical_identity_constraint_missing',
      'memory_v2_fts requires unique stream and event identities.',
    );
  }
}

export class SqliteMemorySearchIndex implements MemorySearchIndex {
  async assertReady(database: MemoryDatabaseLike): Promise<void> {
    assertCanonicalSchema(sqliteDriver(database));
  }

  async insert(database: MemoryDatabaseLike, input: MemoryLexicalProjectionInput): Promise<void> {
    const row = createMemoryLexicalProjection(input);
    try {
      sqliteDriver(database)._run(
        `INSERT INTO "memory_v2_fts"
          ("streamId", "eventId", "revision", "contentHash", "canonicalText", "tokenCount",
           "termFrequencies", "createdAt", "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.streamId,
          row.eventId,
          row.revision,
          row.contentHash,
          row.canonicalText,
          row.tokenCount,
          row.termFrequencies,
          row.createdAt,
          row.updatedAt,
        ],
      );
    } catch (error) {
      throw lexicalError(
        'backfill',
        'write',
        'memory_lexical_projection_insert_failed',
        'Failed to persist the lexical projection.',
        error,
      );
    }
  }

  async updateIdentity(
    database: MemoryDatabaseLike,
    input: Omit<MemoryLexicalProjectionInput, 'canonicalText'>,
  ): Promise<void> {
    const [current] = await this.get(database, input.streamId);
    if (
      !current
      || !isMemoryLexicalProjectionValid(current)
      || current.contentHash !== input.contentHash
      || !input.eventId
      || !Number.isSafeInteger(input.revision)
      || input.revision < 1
    ) {
      throw lexicalError(
        'backfill',
        'validation',
        'memory_lexical_projection_identity_invalid',
        'Lexical projection identity cannot be advanced from the current head.',
      );
    }
    try {
      sqliteDriver(database)._run(
        `UPDATE "memory_v2_fts"
         SET "eventId" = ?, "revision" = ?, "contentHash" = ?, "updatedAt" = ?
         WHERE "streamId" = ?`,
        [input.eventId, input.revision, input.contentHash, Date.now(), input.streamId],
      );
    } catch (error) {
      throw lexicalError(
        'backfill',
        'write',
        'memory_lexical_projection_update_failed',
        'Failed to update the lexical projection identity.',
        error,
      );
    }
  }

  async remove(database: MemoryDatabaseLike, streamId: string): Promise<void> {
    sqliteDriver(database)._run(
      `DELETE FROM "memory_v2_fts" WHERE "streamId" = ?`,
      [streamId],
    );
  }

  async get(database: MemoryDatabaseLike, streamId: string): Promise<MemoryLexicalProjectionRow[]> {
    return (
      sqliteDriver(database)._all(
        `SELECT "streamId", "eventId", "revision", "contentHash", "canonicalText",
                "tokenCount", "termFrequencies", "createdAt", "updatedAt"
         FROM "memory_v2_fts"
         WHERE "streamId" = ?`,
        [streamId],
      ) as unknown[]
    ).map(parseProjectionRow);
  }

  async list(database: MemoryDatabaseLike): Promise<MemoryLexicalProjectionRow[]> {
    return (
      sqliteDriver(database)._all(
        `SELECT "streamId", "eventId", "revision", "contentHash", "canonicalText",
                "tokenCount", "termFrequencies", "createdAt", "updatedAt"
         FROM "memory_v2_fts"
         ORDER BY "streamId" ASC`,
      ) as unknown[]
    ).map(parseProjectionRow);
  }

  async count(database: MemoryDatabaseLike): Promise<number> {
    const rows = sqliteDriver(database)._all(
      `SELECT COUNT(*) AS "count" FROM "memory_v2_fts"`,
    ) as Array<{ count?: unknown }>;
    return Number(rows[0]?.count ?? 0);
  }

  async search(
    database: MemoryDatabaseLike,
    query: string,
    allowedStreamIds: readonly string[],
    limit: number,
  ): Promise<Map<string, number>> {
    const queryTokens = normalizedTokens(query).slice(0, MAX_QUERY_TERMS);
    const maximum = Math.max(0, Math.floor(limit));
    if (!queryTokens.length || !allowedStreamIds.length || maximum === 0) return new Map();

    const allowed = new Set(allowedStreamIds);
    const rows = (await this.list(database)).filter((row) => allowed.has(row.streamId));
    if (!rows.length) return new Map();
    const documents = rows.map((row) => ({
      row,
      frequencies: parseTermFrequencies(row),
    }));
    const queryTerms = [...new Set(queryTokens)];
    const averageLength = documents.reduce((sum, document) => sum + document.row.tokenCount, 0)
      / documents.length;
    const scores = documents.map((document) => {
      let score = 0;
      for (const term of queryTerms) {
        const documentFrequency = documents.reduce(
          (count, candidate) => count + (candidate.frequencies.has(term) ? 1 : 0),
          0,
        );
        const termFrequency = document.frequencies.get(term) ?? 0;
        if (termFrequency === 0 || documentFrequency === 0) continue;
        const inverseDocumentFrequency = Math.log(
          1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5),
        );
        const lengthNormalization = averageLength > 0
          ? 1 - BM25_B + BM25_B * document.row.tokenCount / averageLength
          : 1;
        score += inverseDocumentFrequency
          * (termFrequency * (BM25_K1 + 1))
          / (termFrequency + BM25_K1 * lengthNormalization);
      }
      return {
        streamId: document.row.streamId,
        score,
      };
    })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.streamId.localeCompare(right.streamId))
      .slice(0, maximum);
    const maximumScore = scores[0]?.score ?? 0;
    return new Map(scores.map((entry) => [
      entry.streamId,
      maximumScore > 0 ? entry.score / maximumScore : 0,
    ]));
  }
}
