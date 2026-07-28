import { MemoryRuntimeError } from './errors.js';
import { MEMORY_LEDGER_TABLES } from './schema.js';
import type { MemoryAssertionType } from '../../types/memory.js';
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
  id?: number;
  tokenCount: number;
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
  countTerms(database: MemoryDatabaseLike): Promise<number>;
  search(
    database: MemoryDatabaseLike,
    query: string,
    limit: number,
    filters?: MemorySearchCandidateFilters,
  ): Promise<Map<string, number>>;
  recent(
    database: MemoryDatabaseLike,
    limit: number,
    filters?: MemorySearchCandidateFilters,
  ): Promise<string[]>;
}

export interface MemorySearchCandidateFilters {
  assertionTypes?: readonly MemoryAssertionType[];
  from?: number | null;
  to?: number | null;
}

type SqliteDriverLike = {
  _all(sql: string, params?: unknown[]): unknown[];
  _run(sql: string, params?: unknown[]): unknown;
};

function lexicalError(
  operation: 'startup' | 'recall' | 'maintenance',
  stage: 'schema' | 'validation' | 'read' | 'write',
  code: string,
  message: string,
  cause?: unknown,
): MemoryRuntimeError {
  return new MemoryRuntimeError(
    operation,
    stage,
    code,
    message,
    cause === undefined ? {} : { cause },
  );
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
      'Memory Ledger V3 requires the configured SQLite driver.',
    );
  }
  const driver = resolver.call(database, MEMORY_LEDGER_TABLES.lexicalDocument) as Partial<SqliteDriverLike>;
  if (typeof driver?._all !== 'function' || typeof driver?._run !== 'function') {
    throw lexicalError(
      'startup',
      'schema',
      'memory_lexical_driver_invalid',
      'Memory Ledger V3 requires SQLite lexical index operations.',
    );
  }
  return driver as SqliteDriverLike;
}

export function tokenizeMemoryText(input: string): string[] {
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

function frequencies(tokens: readonly string[]): Map<string, number> {
  const output = new Map<string, number>();
  for (const token of tokens) output.set(token, (output.get(token) ?? 0) + 1);
  return output;
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
      'maintenance',
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
      'maintenance',
      'validation',
      'memory_lexical_projection_timestamp_invalid',
      'Lexical projection timestamp is invalid.',
    );
  }
  return {
    ...input,
    tokenCount: tokenizeMemoryText(input.canonicalText).length,
    createdAt: now,
    updatedAt: now,
  };
}

function parseProjectionRow(value: unknown): MemoryLexicalProjectionRow {
  const row = value as Record<string, unknown>;
  return {
    id: Number(row.id),
    streamId: String(row.streamId ?? ''),
    eventId: String(row.eventId ?? ''),
    revision: Number(row.revision),
    contentHash: String(row.contentHash ?? ''),
    canonicalText: String(row.canonicalText ?? ''),
    tokenCount: Number(row.tokenCount),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export function isMemoryLexicalProjectionValid(row: MemoryLexicalProjectionRow): boolean {
  try {
    assertProjectionInput(row);
    return Number.isSafeInteger(row.tokenCount)
      && row.tokenCount >= 0
      && row.tokenCount === tokenizeMemoryText(row.canonicalText).length
      && Number.isFinite(row.createdAt)
      && Number.isFinite(row.updatedAt)
      && row.createdAt >= 0
      && row.updatedAt >= row.createdAt;
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

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function candidateFilterSql(
  filters: MemorySearchCandidateFilters = {},
): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.assertionTypes?.length) {
    clauses.push(`h."assertionType" IN (${placeholders(filters.assertionTypes.length)})`);
    params.push(...filters.assertionTypes);
  }
  if (filters.from != null) {
    clauses.push('e."occurredAt" >= ?');
    params.push(filters.from);
  }
  if (filters.to != null) {
    clauses.push('e."occurredAt" <= ?');
    params.push(filters.to);
  }
  return {
    sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
    params,
  };
}

export class SqliteMemorySearchIndex implements MemorySearchIndex {
  async assertReady(database: MemoryDatabaseLike): Promise<void> {
    const driver = sqliteDriver(database);
    const rows = driver._all(
      `SELECT "name" FROM "sqlite_master"
       WHERE "type" = 'table' AND "name" IN (?, ?)
       ORDER BY "name"`,
      [MEMORY_LEDGER_TABLES.lexicalDocument, MEMORY_LEDGER_TABLES.lexicalTerm],
    ) as Array<{ name?: unknown }>;
    const names = rows.map((row) => String(row.name));
    if (
      names.length !== 2
      || !names.includes(MEMORY_LEDGER_TABLES.lexicalDocument)
      || !names.includes(MEMORY_LEDGER_TABLES.lexicalTerm)
    ) {
      throw lexicalError(
        'startup',
        'schema',
        'memory_lexical_schema_invalid',
        'Memory Ledger V3 lexical document and term tables are required.',
      );
    }
  }

  async insert(database: MemoryDatabaseLike, input: MemoryLexicalProjectionInput): Promise<void> {
    const row = createMemoryLexicalProjection(input);
    const driver = sqliteDriver(database);
    const termFrequencies = frequencies(tokenizeMemoryText(row.canonicalText));
    try {
      driver._run(
        `DELETE FROM "${MEMORY_LEDGER_TABLES.lexicalTerm}" WHERE "streamId" = ?`,
        [row.streamId],
      );
      driver._run(
        `DELETE FROM "${MEMORY_LEDGER_TABLES.lexicalDocument}" WHERE "streamId" = ?`,
        [row.streamId],
      );
      driver._run(
        `INSERT INTO "${MEMORY_LEDGER_TABLES.lexicalDocument}"
          ("streamId", "eventId", "revision", "contentHash", "canonicalText", "tokenCount", "createdAt", "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.streamId,
          row.eventId,
          row.revision,
          row.contentHash,
          row.canonicalText,
          row.tokenCount,
          row.createdAt,
          row.updatedAt,
        ],
      );
      for (const [term, frequency] of termFrequencies) {
        driver._run(
          `INSERT INTO "${MEMORY_LEDGER_TABLES.lexicalTerm}" ("term", "streamId", "frequency")
           VALUES (?, ?, ?)`,
          [term, row.streamId, frequency],
        );
      }
    } catch (error) {
      throw lexicalError(
        'maintenance',
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
        'maintenance',
        'validation',
        'memory_lexical_projection_identity_invalid',
        'Lexical projection identity cannot be advanced from the current head.',
      );
    }
    sqliteDriver(database)._run(
      `UPDATE "${MEMORY_LEDGER_TABLES.lexicalDocument}"
       SET "eventId" = ?, "revision" = ?, "updatedAt" = ?
       WHERE "streamId" = ?`,
      [input.eventId, input.revision, Date.now(), input.streamId],
    );
  }

  async remove(database: MemoryDatabaseLike, streamId: string): Promise<void> {
    const driver = sqliteDriver(database);
    driver._run(
      `DELETE FROM "${MEMORY_LEDGER_TABLES.lexicalTerm}" WHERE "streamId" = ?`,
      [streamId],
    );
    driver._run(
      `DELETE FROM "${MEMORY_LEDGER_TABLES.lexicalDocument}" WHERE "streamId" = ?`,
      [streamId],
    );
  }

  async get(database: MemoryDatabaseLike, streamId: string): Promise<MemoryLexicalProjectionRow[]> {
    return (
      sqliteDriver(database)._all(
        `SELECT * FROM "${MEMORY_LEDGER_TABLES.lexicalDocument}" WHERE "streamId" = ?`,
        [streamId],
      ) as unknown[]
    ).map(parseProjectionRow);
  }

  async list(database: MemoryDatabaseLike): Promise<MemoryLexicalProjectionRow[]> {
    return (
      sqliteDriver(database)._all(
        `SELECT * FROM "${MEMORY_LEDGER_TABLES.lexicalDocument}" ORDER BY "streamId"`,
      ) as unknown[]
    ).map(parseProjectionRow);
  }

  async count(database: MemoryDatabaseLike): Promise<number> {
    const rows = sqliteDriver(database)._all(
      `SELECT COUNT(*) AS "count" FROM "${MEMORY_LEDGER_TABLES.lexicalDocument}"`,
    ) as Array<{ count?: unknown }>;
    return Number(rows[0]?.count ?? 0);
  }

  async countTerms(database: MemoryDatabaseLike): Promise<number> {
    const rows = sqliteDriver(database)._all(
      `SELECT COUNT(*) AS "count" FROM "${MEMORY_LEDGER_TABLES.lexicalTerm}"`,
    ) as Array<{ count?: unknown }>;
    return Number(rows[0]?.count ?? 0);
  }

  async search(
    database: MemoryDatabaseLike,
    query: string,
    limit: number,
    filters: MemorySearchCandidateFilters = {},
  ): Promise<Map<string, number>> {
    const terms = [...new Set(tokenizeMemoryText(query))].slice(0, MAX_QUERY_TERMS);
    const maximum = Math.max(0, Math.floor(limit));
    if (!terms.length || maximum === 0) return new Map();

    const driver = sqliteDriver(database);
    const candidateFilter = candidateFilterSql(filters);
    const postings = (
      driver._all(
        `SELECT t."term", t."streamId", t."frequency",
                MAX(e."occurredAt") AS "lastOccurredAt"
         FROM "${MEMORY_LEDGER_TABLES.lexicalTerm}" t
         JOIN "${MEMORY_LEDGER_TABLES.lexicalDocument}" d
           ON d."streamId" = t."streamId"
         JOIN "${MEMORY_LEDGER_TABLES.head}" h
           ON h."streamId" = d."streamId"
          AND h."eventId" = d."eventId"
          AND h."revision" = d."revision"
          AND h."contentHash" = d."contentHash"
          AND h."state" = 'active'
         JOIN "${MEMORY_LEDGER_TABLES.payload}" p
           ON p."payloadId" = h."payloadId"
          AND p."contentHash" = h."contentHash"
          AND p."payloadKind" = 'assertion'
         JOIN "${MEMORY_LEDGER_TABLES.evidence}" e
           ON e."eventId" = p."eventId"
         WHERE t."term" IN (${placeholders(terms.length)})
         ${candidateFilter.sql}
         GROUP BY t."term", t."streamId", t."frequency"`,
        [...terms, ...candidateFilter.params],
      ) as Array<{
        term?: unknown;
        streamId?: unknown;
        frequency?: unknown;
        lastOccurredAt?: unknown;
      }>
    ).flatMap((row) => {
      const streamId = String(row.streamId ?? '');
      const term = String(row.term ?? '');
      const frequency = Number(row.frequency);
      return streamId && terms.includes(term) && frequency > 0
        ? [{
            streamId,
            term,
            frequency,
            lastOccurredAt: Number(row.lastOccurredAt),
          }]
        : [];
    });
    if (!postings.length) return new Map();

    const candidateIds = [...new Set(postings.map((posting) => posting.streamId))];
    const documents = driver._all(
      `SELECT "streamId", "tokenCount"
       FROM "${MEMORY_LEDGER_TABLES.lexicalDocument}"
       WHERE "streamId" IN (${placeholders(candidateIds.length)})`,
      candidateIds,
    ) as Array<{ streamId?: unknown; tokenCount?: unknown }>;
    const lengthByStream = new Map(documents.map((row) => [
      String(row.streamId ?? ''),
      Number(row.tokenCount),
    ]));
    const [corpus] = driver._all(
      `SELECT COUNT(*) AS "count", AVG("tokenCount") AS "averageLength"
       FROM "${MEMORY_LEDGER_TABLES.lexicalDocument}"`,
    ) as Array<{ count?: unknown; averageLength?: unknown }>;
    const documentCount = Math.max(1, Number(corpus?.count ?? 0));
    const averageLength = Math.max(0, Number(corpus?.averageLength ?? 0));
    const documentFrequency = new Map<string, number>();
    for (const term of terms) {
      documentFrequency.set(term, new Set(
        postings.filter((posting) => posting.term === term).map((posting) => posting.streamId),
      ).size);
    }
    const lexicalScores = new Map<string, number>();
    const lastOccurredAtByStream = new Map<string, number>();
    for (const posting of postings) {
      const docLength = lengthByStream.get(posting.streamId) ?? 0;
      const df = documentFrequency.get(posting.term) ?? 0;
      if (!df) continue;
      const idf = Math.log(
        1 + (documentCount - df + 0.5) / (df + 0.5),
      );
      const lengthNormalization = averageLength > 0
        ? 1 - BM25_B + BM25_B * docLength / averageLength
        : 1;
      const termScore = idf
        * (posting.frequency * (BM25_K1 + 1))
        / (posting.frequency + BM25_K1 * lengthNormalization);
      lexicalScores.set(
        posting.streamId,
        (lexicalScores.get(posting.streamId) ?? 0) + termScore,
      );
      lastOccurredAtByStream.set(
        posting.streamId,
        Math.max(
          lastOccurredAtByStream.get(posting.streamId) ?? 0,
          posting.lastOccurredAt,
        ),
      );
    }
    const now = Date.now();
    const ranked = [...lexicalScores]
      .map(([streamId, lexicalScore]) => {
        const ageDays = Math.max(
          0,
          (now - (lastOccurredAtByStream.get(streamId) ?? 0)) / 86_400_000,
        );
        const recencyMultiplier = 1 + 0.15 / (1 + ageDays / 30);
        return [streamId, lexicalScore * recencyMultiplier] as const;
      })
      .filter(([, score]) => score > 0)
      .sort(([leftId, leftScore], [rightId, rightScore]) => (
        rightScore - leftScore || leftId.localeCompare(rightId)
      ))
      .slice(0, maximum);
    const highest = ranked[0]?.[1] ?? 0;
    return new Map(ranked.map(([streamId, score]) => [
      streamId,
      highest > 0 ? score / highest : 0,
    ]));
  }

  async recent(
    database: MemoryDatabaseLike,
    limit: number,
    filters: MemorySearchCandidateFilters = {},
  ): Promise<string[]> {
    const maximum = Math.max(0, Math.floor(limit));
    if (maximum === 0) return [];
    const candidateFilter = candidateFilterSql(filters);
    const rows = sqliteDriver(database)._all(
      `SELECT h."streamId", MAX(e."occurredAt") AS "lastOccurredAt"
       FROM "${MEMORY_LEDGER_TABLES.head}" h
       JOIN "${MEMORY_LEDGER_TABLES.lexicalDocument}" d
         ON d."streamId" = h."streamId"
        AND d."eventId" = h."eventId"
        AND d."revision" = h."revision"
        AND d."contentHash" = h."contentHash"
       JOIN "${MEMORY_LEDGER_TABLES.payload}" p
         ON p."payloadId" = h."payloadId"
        AND p."contentHash" = h."contentHash"
        AND p."payloadKind" = 'assertion'
       JOIN "${MEMORY_LEDGER_TABLES.evidence}" e
         ON e."eventId" = p."eventId"
       WHERE h."state" = 'active'
       ${candidateFilter.sql}
       GROUP BY h."streamId"
       ORDER BY "lastOccurredAt" DESC, h."updatedAt" DESC, h."streamId"
       LIMIT ?`,
      [...candidateFilter.params, maximum],
    ) as Array<{ streamId?: unknown }>;
    return rows.map((row) => String(row.streamId ?? '')).filter(Boolean);
  }
}
