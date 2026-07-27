import { describe, expect, it } from 'vitest';
import type {
  MemoryAddress,
  MemoryV2HeadRecord,
  MemoryV2WorkRecord,
} from '../src/types/memory.js';
import {
  asMemoryRuntimeError,
  MemoryRuntimeError,
} from '../src/plugins/memory/errors.js';
import {
  runDeterministicCaptureGuard,
  type ExtractedMemoryCandidate,
} from '../src/plugins/memory/gates.js';
import { MemoryPolicyService } from '../src/plugins/memory/policy.js';
import { retrieveMemoryForContext } from '../src/plugins/memory/recall.js';
import { MemoryAdminService } from '../src/plugins/memory/admin.js';
import { buildPrivateMemoryExport } from '../src/plugins/memory/commands.js';
import {
  createMemoryLexicalProjection,
  memoryLexicalProjectionMatches,
  type MemoryLexicalProjectionInput,
  type MemoryLexicalProjectionRow,
  type MemorySearchIndex,
} from '../src/plugins/memory/search-index.js';
import {
  MEMORY_LEDGER_TABLE_NAMES,
  MEMORY_LEDGER_TABLES,
} from '../src/plugins/memory/schema.js';
import {
  MemoryStore,
  type AppendAssertionInput,
  type EmbeddingWorkPayload,
  type ExtractWorkPayload,
  type MemoryDatabaseLike,
} from '../src/plugins/memory/store.js';

type TableState = Record<string, Array<Record<string, any>>>;

function matches(row: Record<string, any>, query: Record<string, unknown>): boolean {
  return Object.entries(query).every(([key, value]) => row[key] === value);
}

class MemoryTestDatabase implements MemoryDatabaseLike {
  private transactionTail: Promise<void> = Promise.resolve();
  failOnCreateTable: string | null = null;

  constructor(
    readonly tables: TableState = Object.fromEntries(
      MEMORY_LEDGER_TABLE_NAMES.map((table) => [table, []]),
    ),
    private readonly transactional = false,
  ) {}

  async get(table: string, query: Record<string, unknown>): Promise<any[]> {
    return (this.tables[table] ?? []).filter((row) => matches(row, query)).map((row) => structuredClone(row));
  }

  async set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<unknown> {
    for (const row of this.tables[table] ?? []) {
      if (matches(row, query)) Object.assign(row, structuredClone(data));
    }
    return undefined;
  }

  async create(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.failOnCreateTable === table) throw new Error(`injected create failure: ${table}`);
    const rows = this.tables[table] ??= [];
    const created = {
      ...structuredClone(row),
      ...('id' in row ? {} : table === MEMORY_LEDGER_TABLES.fts ? {} : { id: rows.length + 1 }),
    };
    rows.push(created);
    return structuredClone(created);
  }

  async remove(table: string, query: Record<string, unknown>): Promise<unknown> {
    this.tables[table] = (this.tables[table] ?? []).filter((row) => !matches(row, query));
    return undefined;
  }

  async withTransaction<T>(callback: (database: MemoryDatabaseLike) => Promise<T>): Promise<T> {
    if (this.transactional) throw new Error('nested transactions are forbidden');
    let resolveTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    const previous = this.transactionTail;
    this.transactionTail = previous.then(() => turn);
    await previous;
    const draft = structuredClone(this.tables);
    const transaction = new MemoryTestDatabase(draft, true);
    transaction.failOnCreateTable = this.failOnCreateTable;
    try {
      const result = await callback(transaction);
      for (const key of Object.keys(this.tables)) delete this.tables[key];
      Object.assign(this.tables, draft);
      return result;
    } finally {
      resolveTurn();
    }
  }
}

class MemoryTestSearchIndex implements MemorySearchIndex {
  async assertReady(): Promise<void> {}

  async insert(database: MemoryDatabaseLike, input: MemoryLexicalProjectionInput): Promise<void> {
    await database.create(
      MEMORY_LEDGER_TABLES.fts,
      { ...createMemoryLexicalProjection(input) },
    );
  }

  async updateIdentity(
    database: MemoryDatabaseLike,
    input: Omit<MemoryLexicalProjectionInput, 'canonicalText'>,
  ): Promise<void> {
    await database.set(MEMORY_LEDGER_TABLES.fts, { streamId: input.streamId }, {
      eventId: input.eventId,
      revision: input.revision,
      contentHash: input.contentHash,
      updatedAt: Date.now(),
    });
  }

  async remove(database: MemoryDatabaseLike, streamId: string): Promise<void> {
    await database.remove(MEMORY_LEDGER_TABLES.fts, { streamId });
  }

  async get(database: MemoryDatabaseLike, streamId: string): Promise<MemoryLexicalProjectionRow[]> {
    return database.get(
      MEMORY_LEDGER_TABLES.fts,
      { streamId },
    ) as Promise<MemoryLexicalProjectionRow[]>;
  }

  async list(database: MemoryDatabaseLike): Promise<MemoryLexicalProjectionRow[]> {
    return database.get(
      MEMORY_LEDGER_TABLES.fts,
      {},
    ) as Promise<MemoryLexicalProjectionRow[]>;
  }

  async count(database: MemoryDatabaseLike): Promise<number> {
    return (await database.get(MEMORY_LEDGER_TABLES.fts, {})).length;
  }

  async search(
    database: MemoryDatabaseLike,
    query: string,
    allowedStreamIds: readonly string[],
  ): Promise<Map<string, number>> {
    const allowed = new Set(allowedStreamIds);
    const rows = await database.get(
      MEMORY_LEDGER_TABLES.fts,
      {},
    ) as MemoryLexicalProjectionRow[];
    return new Map(rows
      .filter((row) => (
        allowed.has(row.streamId)
        && row.canonicalText.toLowerCase().includes(query.toLowerCase())
      ))
      .map((row) => [row.streamId, 1]));
  }
}

function memoryStore(
  database: MemoryTestDatabase,
  policy = new MemoryPolicyService(),
): MemoryStore {
  return new MemoryStore(database, policy, new MemoryTestSearchIndex());
}

function directAddress(userId = '10001'): MemoryAddress {
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
    conversationId: `conversation:${userId}`,
    currentAudienceSubjectKeys: [`onebot:user:${userId}`],
    observedAt: 1_000,
  };
}

function groupAddress(groupId: string, userId = '10001'): MemoryAddress {
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
    conversationId: `conversation:${groupId}`,
    currentAudienceSubjectKeys: [`onebot:user:${userId}`],
    observedAt: 1_000,
  };
}

function assertion(
  overrides: Partial<AppendAssertionInput> = {},
): AppendAssertionInput {
  return {
    idempotencyKey: `assertion:${Math.random()}`,
    assertionType: 'userAssertion',
    subjectType: 'user',
    subjectKey: 'onebot:user:10001',
    actorKey: 'memory.test',
    sourceContextKey: 'onebot:bot:bot:group:group-a',
    audiencePolicy: 'sourceContext',
    audienceContextKeys: ['onebot:bot:bot:group:group-a'],
    audienceSnapshots: {
      'onebot:bot:bot:group:group-a': ['onebot:user:10001'],
    },
    sensitivity: 'low',
    state: 'active',
    content: '用户喜欢爵士乐。',
    retrievalText: 'preference\n音乐\n用户喜欢爵士乐。',
    importance: 0.8,
    confidence: 0.9,
    evidence: [{
      messageId: 'message-1',
      speakerId: '10001',
      contextKey: 'onebot:bot:bot:group:group-a',
      captureAudienceSubjectKeys: ['onebot:user:10001'],
      occurredAt: 900,
      excerpt: '我喜欢爵士乐。',
    }],
    ...overrides,
  };
}

function extractionCandidate(messageId: string): ExtractedMemoryCandidate {
  return {
    candidateType: 'fact',
    subject: 'target_user',
    ownerSpeakerId: '10001',
    kind: 'preference',
    topicKey: 'music',
    content: '用户喜欢古典音乐。',
    keywords: ['古典音乐'],
    importance: 0.7,
    confidence: 0.9,
    sensitivity: 'low',
    applicability: null,
    evidence: null,
    evidenceMessageIds: [messageId],
    evidenceSpeakerIds: ['10001'],
    conflictHint: null,
    validFrom: null,
    validUntil: null,
    expiresAt: null,
  };
}

function domainFact(
  subject: 'group_shared' | 'assistant',
  evidenceMessageIds: string[],
  evidenceSpeakerIds: string[],
): ExtractedMemoryCandidate {
  return {
    candidateType: 'fact',
    subject,
    ownerSpeakerId: subject === 'group_shared' ? 'group' : 'bot',
    kind: 'plan',
    topicKey: subject === 'group_shared' ? 'book-club' : 'reminder',
    content: subject === 'group_shared'
      ? '群读书会固定在每周六举行。'
      : '助手承诺下周一提醒提交材料。',
    keywords: subject === 'group_shared' ? ['读书会', '每周六'] : ['提醒', '下周一'],
    importance: 0.8,
    confidence: 0.95,
    sensitivity: 'low',
    applicability: null,
    evidence: null,
    evidenceMessageIds,
    evidenceSpeakerIds,
    conflictHint: null,
    validFrom: null,
    validUntil: null,
    expiresAt: null,
  };
}

function seedSchema(database: MemoryTestDatabase): void {
  database.tables[MEMORY_LEDGER_TABLES.meta].push({
    id: 1,
    key: 'schemaVersion',
    value: '2',
    updatedAt: 1,
  });
}

describe('Memory Ledger V2', () => {
  it('preserves typed diagnostics without exposing arbitrary upstream messages', () => {
    const upstream = Object.assign(
      new Error('Bearer secret-token provider response body'),
      {
        upstreamStatus: 401,
        providerCode: 'unsafe\nprovider-code',
      },
    );
    const error = asMemoryRuntimeError(
      upstream,
      'extract',
      'provider',
      'memory_extract_failed',
      true,
    );

    expect(error.message).toBe('Memory extract failed during provider.');
    expect(error.message).not.toContain('secret-token');
    expect(error.upstreamStatus).toBe(401);
    expect(error.providerCode).toBeNull();
    expect(error.cause).toBe(upstream);
  });

  it('keeps provider and operator reasons content-free', async () => {
    const providerDrop = runDeterministicCaptureGuard({
      candidateType: 'drop',
      subject: 'unknown',
      keywords: [],
      importance: 0,
      confidence: 0,
      sensitivity: 'low',
      dropReason: 'Bearer secret-token user supplied provider text',
    }, directAddress());
    expect(providerDrop.reasonCode).toBe('provider_drop');

    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const head = await store.appendAssertion(assertion());
    await expect(store.archive({
      streamId: head.streamId,
      actor: { userKey: 'admin', isDirect: false, isAdmin: true },
      reasonCode: 'Bearer secret-token provider body',
    })).rejects.toMatchObject({
      code: 'memory_reason_code_invalid',
      operation: 'archive',
    });
    await expect(store.forget({
      streamId: head.streamId,
      actor: { userKey: 'admin', isDirect: false, isAdmin: true },
      reasonCode: '用户说请删除这段正文',
    })).rejects.toMatchObject({
      code: 'memory_reason_code_invalid',
      operation: 'forget',
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.head][0]).toMatchObject({
      state: 'active',
      revision: 1,
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.event]).toHaveLength(1);
    expect(database.tables[MEMORY_LEDGER_TABLES.suppression]).toHaveLength(0);
    expect(JSON.stringify(database.tables[MEMORY_LEDGER_TABLES.audit]))
      .not.toContain('secret-token');
  });

  it('fails startup when the one-time cutover has not installed schemaVersion=2', async () => {
    const store = memoryStore(new MemoryTestDatabase());
    await expect(store.assertSchemaVersion()).rejects.toMatchObject({
      code: 'memory_schema_version_invalid',
      operation: 'startup',
      stage: 'schema',
    });
  });

  it('exports subject memory without group roster, context, or message identifiers', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    await store.appendAssertion(assertion({
      audienceSnapshots: {
        'onebot:bot:bot:group:group-secret': [
          'onebot:user:10001',
          'onebot:user:10002',
        ],
      },
      audienceContextKeys: ['onebot:bot:bot:group:group-secret'],
      evidence: [{
        messageId: 'internal-message-id',
        speakerId: '10001',
        contextKey: 'onebot:bot:bot:group:group-secret',
        captureAudienceSubjectKeys: [
          'onebot:user:10001',
          'onebot:user:10002',
        ],
        occurredAt: 900,
      }],
    }));
    const exported = buildPrivateMemoryExport(
      'onebot:user:10001',
      await store.listForOwner(directAddress(), true),
    );
    expect(JSON.parse(exported)).toMatchObject({
      subjectKey: 'onebot:user:10001',
      assertions: [{
        audienceContextCount: 1,
        captureAudienceSizes: [2],
        evidenceCount: 1,
      }],
    });
    expect(exported).not.toContain('onebot:user:10002');
    expect(exported).not.toContain('group-secret');
    expect(exported).not.toContain('internal-message-id');
  });

  it('enforces owner and audience visibility across groups and direct chat', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const policy = new MemoryPolicyService();
    const store = memoryStore(database, policy);
    await store.appendAssertion(assertion());
    const directCapture = policy.capturePolicy(directAddress(), 'low');
    expect(directCapture).toEqual({
      audiencePolicy: 'subjectPrivate',
      audienceContextKeys: [directAddress().contextKey],
      audienceSnapshots: {
        [directAddress().contextKey]: ['onebot:user:10001'],
      },
    });
    await store.appendAssertion(assertion({
      idempotencyKey: 'private',
      sourceContextKey: directAddress().contextKey,
      ...directCapture,
      content: '用户的私密偏好。',
      retrievalText: '用户的私密偏好。',
      evidence: [{
        messageId: 'message-private',
        speakerId: '10001',
        contextKey: directAddress().contextKey,
        captureAudienceSubjectKeys: ['onebot:user:10001'],
        occurredAt: 901,
      }],
    }));

    expect(await store.listForContext(groupAddress('group-a'), null)).toHaveLength(1);
    expect(await store.listForContext(groupAddress('group-b'), null)).toHaveLength(0);
    expect(await store.listForContext(directAddress(), null)).toHaveLength(1);
    expect(await store.listForContext(directAddress('10002'), null)).toHaveLength(0);
  });

  it('allows only the subject in direct chat to approve pending memory', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const pending = await store.appendAssertion(assertion({
      state: 'pendingReview',
      idempotencyKey: 'pending',
    }));

    await expect(store.review({
      streamId: pending.streamId,
      actor: { userKey: 'onebot:user:10002', isDirect: true },
      decision: 'approve',
    })).rejects.toMatchObject({ code: 'memory_review_owner_mismatch' });
    await expect(store.review({
      streamId: pending.streamId,
      actor: { userKey: 'onebot:user:10001', isDirect: false },
      decision: 'approve',
    })).rejects.toMatchObject({ code: 'memory_review_requires_direct' });

    await store.review({
      streamId: pending.streamId,
      actor: { userKey: 'onebot:user:10001', isDirect: true },
      decision: 'approve',
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.head][0]).toMatchObject({
      state: 'active',
      revision: 2,
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.event].map((row) => row.eventType)).toEqual([
      'asserted',
      'reviewed',
    ]);
  });

  it.each([
    MEMORY_LEDGER_TABLES.event,
    MEMORY_LEDGER_TABLES.payload,
    MEMORY_LEDGER_TABLES.evidence,
    MEMORY_LEDGER_TABLES.head,
    MEMORY_LEDGER_TABLES.fts,
    MEMORY_LEDGER_TABLES.work,
  ])('rolls back every ledger projection when %s creation fails', async (failedTable) => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    database.failOnCreateTable = failedTable;
    const store = memoryStore(database);

    await expect(store.appendAssertion(assertion({
      embeddingIdentity: {
        canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
        modelRevision: 7,
      },
    }))).rejects.toBeInstanceOf(MemoryRuntimeError);
    expect(database.tables[MEMORY_LEDGER_TABLES.event]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.payload]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.evidence]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.head]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.fts]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.work]).toHaveLength(0);
  });

  it('grants a due work item to only one concurrent claimant', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    database.tables[MEMORY_LEDGER_TABLES.work].push({
      id: 1,
      workKey: 'extract:lane:anchor',
      workType: 'extract',
      status: 'pending',
      subjectKey: 'onebot:user:10001',
      contextKey: 'onebot:bot:bot:group:group-a',
      streamId: null,
      laneKey: 'lane',
      payload: '{}',
      inputHash: 'hash',
      targetRevision: null,
      deletionGeneration: 0,
      retryCount: 0,
      nextRunAt: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorStage: null,
      upstreamStatus: null,
      providerCode: null,
      createdAt: 0,
      updatedAt: 0,
      completedAt: null,
    } satisfies MemoryV2WorkRecord);
    const store = memoryStore(database);

    const results = await Promise.all([
      store.claimDueWork('extract', 100, 1_000),
      store.claimDueWork('extract', 100, 1_000),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(database.tables[MEMORY_LEDGER_TABLES.work][0]?.status).toBe('leased');
  });

  it('coalesces rapid messages into one bounded pending extraction lane', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const base = {
      ...groupAddress('group-a'),
      conversationId: 'conversation:coalesced',
      currentAudienceSubjectKeys: [
        'onebot:user:10001',
        'onebot:user:10002',
      ],
      observedAt: 1_000,
    };
    database.tables.chatluna_conversation = [{
      id: base.conversationId,
      latestMessageId: 'M1',
    }];
    await expect(store.queueExtractWork({
      address: base,
      targetSpeakerId: base.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 2,
      nextRunAt: 10,
    })).resolves.toBe(true);

    database.tables.chatluna_conversation[0]!.latestMessageId = 'M2';
    await expect(store.queueExtractWork({
      address: {
        ...base,
        currentAudienceSubjectKeys: [
          'onebot:user:10001',
          'onebot:user:10002',
          'onebot:user:10003',
        ],
        observedAt: 2_000,
      },
      targetSpeakerId: base.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 2,
      nextRunAt: 20,
    })).resolves.toBe(true);

    database.tables.chatluna_conversation[0]!.latestMessageId = 'M3';
    await expect(store.queueExtractWork({
      address: {
        ...base,
        currentAudienceSubjectKeys: [
          'onebot:user:10001',
          'onebot:user:10002',
          'onebot:user:10003',
        ],
        observedAt: 3_000,
      },
      targetSpeakerId: base.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 2,
      nextRunAt: 30,
    })).resolves.toBe(true);

    expect(database.tables[MEMORY_LEDGER_TABLES.work]).toHaveLength(1);
    const work = database.tables[MEMORY_LEDGER_TABLES.work][0]!;
    const payload = JSON.parse(String(work.payload)) as ExtractWorkPayload;
    expect(work).toMatchObject({ status: 'pending', nextRunAt: 30 });
    expect(payload.latestAnchorMessageId).toBe('M3');
    expect(payload.capturedAudiences.map((capture) => capture.messageId))
      .toEqual(['M2', 'M3']);
    expect(await store.queueExtractWork({
      address: {
        ...base,
        observedAt: 3_001,
      },
      targetSpeakerId: base.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 2,
      nextRunAt: 40,
    })).toBe(false);
  });

  it('serializes extraction work per lane and reads the next window from the live cursor', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const address = {
      ...directAddress(),
      conversationId: 'conversation:lane-serial',
      observedAt: 1_000,
    };
    database.tables.chatluna_conversation = [{
      id: address.conversationId,
      latestMessageId: 'M1',
    }];
    database.tables.chatluna_message = [{
      id: 'M1',
      role: 'human',
      parentId: null,
      conversationId: address.conversationId,
      content: '第一条。',
      createdAt: 900,
    }, {
      id: 'M2',
      role: 'human',
      parentId: 'M1',
      conversationId: address.conversationId,
      content: '第二条。',
      createdAt: 1_900,
    }];
    await store.queueExtractWork({
      address,
      targetSpeakerId: address.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    });
    const first = await store.claimDueWork('extract', Date.now(), 60_000);
    expect(first).not.toBeNull();

    database.tables.chatluna_conversation[0]!.latestMessageId = 'M2';
    await store.queueExtractWork({
      address: { ...address, observedAt: 2_000 },
      targetSpeakerId: address.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    });
    await expect(store.claimDueWork('extract', Date.now(), 60_000))
      .resolves.toBeNull();

    await store.completeEmptyExtraction(
      first!.work,
      first!.leaseToken,
      store.parseWorkPayload(first!.work),
      null,
    );
    const second = await store.claimDueWork('extract', Date.now(), 60_000);
    expect(second).not.toBeNull();
    const secondPayload = store.parseWorkPayload<ExtractWorkPayload>(second!.work);
    expect((await store.readConversationWindow(secondPayload)).map((turn) => turn.id))
      .toEqual(['M2']);
    await store.completeEmptyExtraction(
      second!.work,
      second!.leaseToken,
      secondPayload,
      null,
    );
    expect(database.tables[MEMORY_LEDGER_TABLES.cursor][0]).toMatchObject({
      lastMessageId: 'M2',
      lastMessageAt: 2_000,
    });
  });

  it('re-coalesces an expired lease with the pending successor before a new anchor', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const address = {
      ...directAddress(),
      conversationId: 'conversation:expired-coalescing',
      observedAt: 1_000,
    };
    database.tables.chatluna_conversation = [{
      id: address.conversationId,
      latestMessageId: 'M1',
    }];
    await store.queueExtractWork({
      address,
      targetSpeakerId: address.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    });
    expect(await store.claimDueWork('extract', 0, 1)).not.toBeNull();

    database.tables.chatluna_conversation[0]!.latestMessageId = 'M2';
    await store.queueExtractWork({
      address: { ...address, observedAt: 2_000 },
      targetSpeakerId: address.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    });
    await store.requeueExpiredLeases(2);
    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .filter((row) => row.status === 'pending')).toHaveLength(2);

    database.tables.chatluna_conversation[0]!.latestMessageId = 'M3';
    await store.queueExtractWork({
      address: { ...address, observedAt: 3_000 },
      targetSpeakerId: address.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    });
    const pending = database.tables[MEMORY_LEDGER_TABLES.work]
      .filter((row) => row.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .filter((row) => row.status === 'cancelled')).toHaveLength(1);
    expect(
      (JSON.parse(String(pending[0]!.payload)) as ExtractWorkPayload)
        .capturedAudiences
        .map((capture) => capture.messageId),
    ).toEqual(['M1', 'M2', 'M3']);
  });

  it('keeps message-time audiences and blocks new members from old evidence', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const address = {
      ...groupAddress('group-a'),
      conversationId: 'conversation:membership-change',
      currentAudienceSubjectKeys: [
        'onebot:user:10001',
        'onebot:user:10002',
      ],
      observedAt: 1_000,
    };
    database.tables.chatluna_conversation = [{
      id: address.conversationId,
      latestMessageId: 'M1',
    }];
    database.tables.chatluna_message = [{
      id: 'M1',
      role: 'human',
      parentId: null,
      conversationId: address.conversationId,
      content: '我喜欢古典音乐。',
      additional_kwargs: JSON.stringify({
        qqbot_speaker_format: {
          version: 'speaker_id_v1',
          speakerId: '10001',
          speakerName: 'Alice',
        },
      }),
      createdAt: 900,
    }, {
      id: 'M2',
      role: 'human',
      parentId: 'M1',
      conversationId: address.conversationId,
      content: '再补充一条。',
      additional_kwargs: JSON.stringify({
        qqbot_speaker_format: {
          version: 'speaker_id_v1',
          speakerId: '10001',
          speakerName: 'Alice',
        },
      }),
      createdAt: 1_900,
    }];
    await store.queueExtractWork({
      address,
      targetSpeakerId: address.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    });
    database.tables.chatluna_conversation[0]!.latestMessageId = 'M2';
    const expandedAudience = [
      ...address.currentAudienceSubjectKeys,
      'onebot:user:10003',
    ];
    await store.queueExtractWork({
      address: {
        ...address,
        currentAudienceSubjectKeys: expandedAudience,
        observedAt: 2_000,
      },
      targetSpeakerId: address.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    });
    const claimed = await store.claimDueWork('extract', Date.now(), 60_000);
    expect(claimed).not.toBeNull();
    const payload = store.parseWorkPayload<ExtractWorkPayload>(claimed!.work);
    const turns = await store.readConversationWindow(payload);
    await store.finalizeExtraction({
      work: claimed!.work,
      leaseToken: claimed!.leaseToken,
      payload,
      turns,
      candidates: [extractionCandidate('M1')],
      providerRoute: 'native_chat_json_schema',
      rawTextHash: 'membership-change',
      embeddingIdentity: null,
    });

    expect(JSON.parse(String(
      database.tables[MEMORY_LEDGER_TABLES.head][0]!.audienceSnapshots,
    ))).toEqual({
      [address.contextKey]: [
        'onebot:user:10001',
        'onebot:user:10002',
      ],
    });
    expect(JSON.parse(String(
      database.tables[MEMORY_LEDGER_TABLES.evidence][0]!
        .captureAudienceSubjectKeys,
    ))).toEqual([
      'onebot:user:10001',
      'onebot:user:10002',
    ]);
    expect(await store.listForContext({
      ...address,
      currentAudienceSubjectKeys: expandedAudience,
    }, null)).toHaveLength(0);

    const duplicateWork = {
      ...claimed!.work,
      id: 2,
      workKey: 'extract:overlapping-retry',
      status: 'leased' as const,
      inputHash: 'overlapping-retry-input',
      leaseToken: 'overlapping-retry-lease',
      leaseExpiresAt: Date.now() + 60_000,
      payload: JSON.stringify(payload),
      updatedAt: Date.now(),
      completedAt: null,
    };
    database.tables[MEMORY_LEDGER_TABLES.work].push(duplicateWork);
    await store.finalizeExtraction({
      work: duplicateWork,
      leaseToken: 'overlapping-retry-lease',
      payload,
      turns,
      candidates: [extractionCandidate('M1')],
      providerRoute: 'native_chat_json_schema',
      rawTextHash: 'overlapping-retry',
      embeddingIdentity: null,
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.event]).toHaveLength(1);
    expect(database.tables[MEMORY_LEDGER_TABLES.head]).toHaveLength(1);
    expect(database.tables[MEMORY_LEDGER_TABLES.evidence]).toHaveLength(1);
  });

  it('does not regress a lane cursor when an older provider result arrives late', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const address = {
      ...directAddress(),
      conversationId: 'conversation:stale-cursor',
      observedAt: 1_000,
    };
    database.tables.chatluna_conversation = [{
      id: address.conversationId,
      latestMessageId: 'M1',
    }];
    database.tables.chatluna_message = [{
      id: 'M1',
      role: 'human',
      parentId: null,
      conversationId: address.conversationId,
      content: '较早的消息。',
      createdAt: 900,
    }, {
      id: 'M2',
      role: 'human',
      parentId: 'M1',
      conversationId: address.conversationId,
      content: '较新的消息。',
      createdAt: 1_900,
    }];
    await store.queueExtractWork({
      address,
      targetSpeakerId: address.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    });
    const claimed = await store.claimDueWork('extract', Date.now(), 60_000);
    expect(claimed).not.toBeNull();
    const payload = store.parseWorkPayload<ExtractWorkPayload>(claimed!.work);
    database.tables[MEMORY_LEDGER_TABLES.cursor].push({
      id: 1,
      laneKey: claimed!.work.laneKey,
      subjectKey: address.userKey,
      contextKey: address.contextKey,
      conversationId: address.conversationId,
      lastMessageId: 'M2',
      lastMessageAt: 2_000,
      lastWindowHash: 'newer',
      discardBeforeMessageId: null,
      firstSeenAt: 2_000,
      updatedAt: 2_000,
    });
    await store.completeEmptyExtraction(
      claimed!.work,
      claimed!.leaseToken,
      payload,
      'older',
    );
    expect(database.tables[MEMORY_LEDGER_TABLES.cursor][0]).toMatchObject({
      lastMessageId: 'M2',
      lastMessageAt: 2_000,
      lastWindowHash: 'newer',
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.work][0]).toMatchObject({
      status: 'cancelled',
      payload: '{}',
      lastErrorCode: 'memory_extract_anchor_superseded',
    });
    expect(await store.queueExtractWork({
      address,
      targetSpeakerId: address.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    })).toBe(false);
  });

  it('cancels an in-flight extraction lane before forgotten content can be recreated', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const address = {
      ...groupAddress('group-a'),
      conversationId: 'conversation:forget-race',
      observedAt: 10_000,
    };
    database.tables.chatluna_conversation = [{
      id: address.conversationId,
      latestMessageId: 'M10',
    }];
    expect(await store.queueExtractWork({
      address,
      targetSpeakerId: address.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    })).toBe(true);
    const claimed = await store.claimDueWork('extract', Date.now(), 60_000);
    expect(claimed).not.toBeNull();
    const payload = store.parseWorkPayload<ExtractWorkPayload>(claimed!.work);
    const head = await store.appendAssertion(assertion({
      idempotencyKey: 'forget-race-existing',
    }));

    await store.forget({
      actor: { userKey: address.userKey, isDirect: true },
      streamId: head.streamId,
    });

    await expect(store.finalizeExtraction({
      work: claimed!.work,
      leaseToken: claimed!.leaseToken,
      payload,
      turns: [{
        id: 'M10',
        role: 'human',
        text: '我喜欢古典音乐。',
        speakerId: '10001',
        speakerName: 'Alice',
        ownerUserKey: address.userKey,
        isTarget: true,
        attributionSource: 'additional_kwargs',
        parentId: 'M9',
        occurredAt: 9_900,
      }],
      candidates: [extractionCandidate('M10')],
      providerRoute: 'native_chat_json_schema',
      rawTextHash: 'provider-output-hash',
      embeddingIdentity: null,
    })).rejects.toMatchObject({ code: 'memory_lease_lost' });

    expect(database.tables[MEMORY_LEDGER_TABLES.head]).toHaveLength(1);
    expect(database.tables[MEMORY_LEDGER_TABLES.head][0]).toMatchObject({
      streamId: head.streamId,
      state: 'forgotten',
      payloadId: null,
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.payload]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.work][0]).toMatchObject({
      status: 'cancelled',
      payload: '{}',
    });
    expect(await store.getQueueSummary()).toMatchObject({
      pending: 0,
      leased: 0,
    });

    database.tables.chatluna_conversation[0]!.latestMessageId = 'M11';
    const nextAddress = { ...address, observedAt: 11_000, requestId: 'M11' };
    expect(await store.queueExtractWork({
      address: nextAddress,
      targetSpeakerId: nextAddress.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    })).toBe(true);
    const nextWork = database.tables[MEMORY_LEDGER_TABLES.work].find((row) => row.status === 'pending');
    const nextPayload = JSON.parse(String(nextWork?.payload)) as ExtractWorkPayload;
    expect(nextPayload).toMatchObject({
      latestAnchorMessageId: 'M11',
    });
  });

  it('creates a lane barrier and discard watermark even when no assertion head exists', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const address = {
      ...groupAddress('group-a'),
      conversationId: 'conversation:queued-only',
      observedAt: 20_000,
    };
    database.tables.chatluna_conversation = [{
      id: address.conversationId,
      latestMessageId: 'M20',
    }];
    await store.queueExtractWork({
      address,
      targetSpeakerId: address.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    });
    const claimed = await store.claimDueWork('extract', Date.now(), 60_000);
    expect(claimed).not.toBeNull();

    await expect(store.forget({
      actor: { userKey: address.userKey, isDirect: false },
      contextKey: address.contextKey,
    })).resolves.toBe(0);

    expect(database.tables[MEMORY_LEDGER_TABLES.suppression]).toEqual([
      expect.objectContaining({
        subjectKey: address.userKey,
        contextKey: address.contextKey,
        streamId: null,
        sourceMessageDigest: null,
      }),
    ]);
    expect(database.tables[MEMORY_LEDGER_TABLES.work][0]).toMatchObject({
      status: 'cancelled',
      payload: '{}',
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.cursor][0]).toMatchObject({
      lastMessageId: 'M20',
      discardBeforeMessageId: 'M20',
    });
  });

  it('uses the forget barrier time as a deterministic cutoff after paused writes', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const address = {
      ...groupAddress('group-a'),
      conversationId: 'conversation:paused-window',
      observedAt: Date.now() + 10,
    };
    const oldTime = Date.now() - 1_000;
    await expect(store.forget({
      actor: { userKey: address.userKey, isDirect: false },
      contextKey: address.contextKey,
    })).resolves.toBe(0);
    const cutoff = Number(database.tables[MEMORY_LEDGER_TABLES.suppression][0]!.cutoffAt);
    database.tables.chatluna_conversation = [{
      id: address.conversationId,
      latestMessageId: 'M42',
    }];
    database.tables.chatluna_message = [
      {
        id: 'M40',
        role: 'human',
        parentId: null,
        conversationId: address.conversationId,
        content: '忘记前积累的一条消息。',
        additional_kwargs: JSON.stringify({ userId: '10001' }),
        createdAt: oldTime,
      },
      {
        id: 'M41',
        role: 'ai',
        parentId: 'M40',
        conversationId: address.conversationId,
        content: '忘记前的回复。',
        createdAt: cutoff,
      },
      {
        id: 'M42',
        role: 'human',
        parentId: 'M41',
        conversationId: address.conversationId,
        content: '忘记后的新消息。',
        additional_kwargs: JSON.stringify({ userId: '10001' }),
        createdAt: cutoff + 1,
      },
    ];
    await store.queueExtractWork({
      address: { ...address, observedAt: cutoff + 1 },
      targetSpeakerId: address.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    });
    const claimed = await store.claimDueWork('extract', Date.now(), 60_000);
    expect(claimed).not.toBeNull();
    const payload = store.parseWorkPayload<ExtractWorkPayload>(claimed!.work);
    const turns = await store.filterSuppressedTurns(
      address.userKey,
      address.contextKey,
      await store.readConversationWindow(payload),
    );
    expect(turns.map((turn) => turn.id)).toEqual(['M42']);
  });

  it('requeues an expired slow provider lease without losing its extraction anchor', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const address = {
      ...groupAddress('group-a'),
      conversationId: 'conversation:expired',
      observedAt: 30_000,
    };
    database.tables.chatluna_conversation = [{
      id: address.conversationId,
      latestMessageId: 'M30',
    }];
    await store.queueExtractWork({
      address,
      targetSpeakerId: address.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    });
    const claimedAt = Date.now();
    const claimed = await store.claimDueWork('extract', claimedAt, 1);
    expect(claimed).not.toBeNull();
    const payload = store.parseWorkPayload<ExtractWorkPayload>(claimed!.work);
    const expiredAt = claimed!.work.leaseExpiresAt! + 1;

    await expect(store.requeueExpiredLeases(expiredAt, 2)).resolves.toBe(1);
    const retried = await store.claimDueWork('extract', expiredAt, 60_000);
    expect(retried).not.toBeNull();

    await expect(store.completeEmptyExtraction(
      claimed!.work,
      claimed!.leaseToken,
      payload,
      null,
    )).rejects.toMatchObject({ code: 'memory_lease_lost' });
    expect(database.tables[MEMORY_LEDGER_TABLES.work][0]).toMatchObject({
      status: 'leased',
      payload: claimed!.work.payload,
      lastErrorCode: 'memory_lease_expired',
      leaseToken: retried!.leaseToken,
      retryCount: 1,
    });

    await expect(store.completeEmptyExtraction(
      retried!.work,
      retried!.leaseToken,
      store.parseWorkPayload(retried!.work),
      'retried-provider-output',
    )).resolves.toBeUndefined();
    expect(database.tables[MEMORY_LEDGER_TABLES.work][0]).toMatchObject({
      status: 'succeeded',
      payload: '{}',
      retryCount: 1,
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.cursor][0]).toMatchObject({
      lastMessageId: 'M30',
      lastWindowHash: 'retried-provider-output',
    });
  });

  it('persists no active memory for unknown or conflicting speaker attribution', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const address = {
      ...groupAddress('group-a'),
      conversationId: 'conversation:attribution',
      observedAt: 40_000,
    };
    database.tables.chatluna_conversation = [{
      id: address.conversationId,
      latestMessageId: 'M40',
    }];
    await store.queueExtractWork({
      address,
      targetSpeakerId: address.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    });
    const claimed = await store.claimDueWork('extract', Date.now(), 60_000);
    expect(claimed).not.toBeNull();
    const payload = store.parseWorkPayload<ExtractWorkPayload>(claimed!.work);
    const unknown = {
      ...extractionCandidate('M40'),
      subject: 'unknown' as const,
    };
    const conflicting = {
      ...extractionCandidate('M40'),
      ownerSpeakerId: '10002',
    };
    const result = await store.finalizeExtraction({
      work: claimed!.work,
      leaseToken: claimed!.leaseToken,
      payload,
      turns: [{
        id: 'M40',
        role: 'human',
        text: '我喜欢古典音乐。',
        speakerId: '10001',
        speakerName: 'Alice',
        ownerUserKey: address.userKey,
        isTarget: true,
        attributionSource: 'additional_kwargs',
        parentId: null,
        occurredAt: 39_900,
      }],
      candidates: [unknown, conflicting],
      providerRoute: 'native_chat_json_schema',
      rawTextHash: 'attribution-output-hash',
      embeddingIdentity: null,
    });
    expect(result).toEqual({ active: 0, pendingReview: 0, rejected: 2 });
    expect(database.tables[MEMORY_LEDGER_TABLES.head]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.payload]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.evidence]).toHaveLength(0);
  });

  it('prevents a leased embedding from reviving forgotten memory', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const head = await store.appendAssertion(assertion({
      embeddingIdentity: {
        canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
        modelRevision: 7,
      },
    }));
    const claimed = await store.claimDueWork('embed', Date.now(), 10_000);
    expect(claimed).not.toBeNull();

    await store.forget({
      actor: { userKey: 'onebot:user:10001', isDirect: true },
      streamId: head.streamId,
    });
    await expect(store.finalizeEmbedding({
      work: claimed!.work,
      leaseToken: claimed!.leaseToken,
      payload: store.parseWorkPayload(claimed!.work),
      vector: [0.1, 0.2],
    })).rejects.toMatchObject({ code: 'memory_lease_lost' });
    expect(database.tables[MEMORY_LEDGER_TABLES.payload]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.evidence]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.embedding]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.fts]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.head][0]).toMatchObject({
      state: 'forgotten',
      payloadId: null,
      audiencePolicy: 'subjectPrivate',
      audienceContextKeys: '[]',
      audienceSnapshots: '{}',
    });
    const sourceSuppression = database.tables[MEMORY_LEDGER_TABLES.suppression]
      .find((row) => row.sourceMessageDigest);
    expect(sourceSuppression?.sourceMessageDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(database.tables[MEMORY_LEDGER_TABLES.suppression]))
      .not.toContain('message-1');
  });

  it('ignores erased dead-letter payloads and preserves another user work during stream forget', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const alice = {
      ...groupAddress('shared-work', '10001'),
      conversationId: 'conversation:shared-work',
      currentAudienceSubjectKeys: [
        'onebot:user:10001',
        'onebot:user:10002',
      ],
      observedAt: 1_000,
    };
    const bob = {
      ...alice,
      userKey: 'onebot:user:10002',
      userId: '10002',
    };
    database.tables.chatluna_conversation = [{
      id: alice.conversationId,
      latestMessageId: 'shared-anchor',
    }];
    await store.queueExtractWork({
      address: alice,
      targetSpeakerId: alice.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    });
    await store.queueExtractWork({
      address: bob,
      targetSpeakerId: bob.userId,
      targetSpeakerName: 'Bob',
      maxMessages: 10,
      nextRunAt: 0,
    });
    const bobWork = database.tables[MEMORY_LEDGER_TABLES.work]
      .find((row) => row.subjectKey === bob.userKey)!;
    Object.assign(bobWork, {
      status: 'deadLetter',
      payload: '{}',
      completedAt: 2_000,
      lastErrorCode: 'memory_extract_provider_failed',
    });
    const head = await store.appendAssertion(assertion({
      idempotencyKey: 'alice-stream-forget-with-bob-dead-letter',
      subjectKey: alice.userKey,
      sourceContextKey: alice.contextKey,
      evidence: [{
        messageId: 'alice-source',
        speakerId: alice.userId,
        contextKey: alice.contextKey,
        captureAudienceSubjectKeys: [alice.userKey],
        occurredAt: 900,
      }],
    }));

    await expect(store.forget({
      actor: { userKey: alice.userKey, isDirect: true },
      streamId: head.streamId,
    })).resolves.toBe(1);

    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .find((row) => row.subjectKey === alice.userKey)).toMatchObject({
      status: 'cancelled',
      payload: '{}',
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .find((row) => row.subjectKey === bob.userKey)).toMatchObject({
      status: 'deadLetter',
      payload: '{}',
      completedAt: 2_000,
    });
  });

  it('forgets every pre-existing evidence sibling without crossing context identity', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const contextKey = 'onebot:bot:bot:group:evidence-closure';
    const sharedEvidence = [{
      messageId: 'shared-message-id',
      speakerId: '10001',
      contextKey,
      captureAudienceSubjectKeys: ['onebot:user:10001'],
      occurredAt: 900,
    }];
    const embeddingIdentity = {
      canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
      modelRevision: 7,
    };
    const initial = await store.appendAssertion(assertion({
      idempotencyKey: 'closure-initial',
      sourceContextKey: contextKey,
      content: '初始证据变体。',
      retrievalText: '初始证据变体',
      evidence: sharedEvidence,
      embeddingIdentity,
    }));
    const activeSibling = await store.appendAssertion(assertion({
      idempotencyKey: 'closure-active-sibling',
      sourceContextKey: contextKey,
      content: '同一证据的活跃变体。',
      retrievalText: '同一证据 活跃变体',
      evidence: sharedEvidence,
      embeddingIdentity,
    }));
    const pendingSibling = await store.appendAssertion(assertion({
      idempotencyKey: 'closure-pending-sibling',
      sourceContextKey: contextKey,
      state: 'pendingReview',
      content: '同一证据的待审核变体。',
      retrievalText: '同一证据 待审核变体',
      evidence: sharedEvidence,
    }));
    const otherContext = await store.appendAssertion(assertion({
      idempotencyKey: 'closure-other-context',
      sourceContextKey: 'discord:bot:other:group:evidence-closure',
      content: '另一上下文中的相同消息编号。',
      retrievalText: '另一上下文 相同消息编号',
      evidence: [{
        ...sharedEvidence[0]!,
        contextKey: 'discord:bot:other:group:evidence-closure',
      }],
    }));
    const otherMessage = await store.appendAssertion(assertion({
      idempotencyKey: 'closure-other-message',
      sourceContextKey: contextKey,
      content: '相同上下文中的另一条消息。',
      retrievalText: '相同上下文 另一消息',
      evidence: [{
        ...sharedEvidence[0]!,
        messageId: 'different-message-id',
      }],
    }));
    for (const head of [initial, activeSibling]) {
      database.tables[MEMORY_LEDGER_TABLES.embedding].push({
        embeddingKey: `embedding:${head.streamId}`,
        streamId: head.streamId,
        eventId: head.eventId,
        revision: head.revision,
        canonicalModel: embeddingIdentity.canonicalModel,
        modelRevision: embeddingIdentity.modelRevision,
        contentHash: head.contentHash,
        dimensions: 2,
        vector: '[0.1,0.2]',
        createdAt: 1_000,
      });
    }

    await expect(store.forget({
      actor: { userKey: 'onebot:user:10001', isDirect: true },
      streamId: initial.streamId,
    })).resolves.toBe(3);

    const forgottenStreamIds = new Set([
      initial.streamId,
      activeSibling.streamId,
      pendingSibling.streamId,
    ]);
    for (const head of database.tables[MEMORY_LEDGER_TABLES.head]
      .filter((row) => forgottenStreamIds.has(row.streamId))) {
      expect(head).toMatchObject({
        state: 'forgotten',
        payloadId: null,
        contentHash: null,
      });
    }
    const forgottenEventIds = new Set(
      database.tables[MEMORY_LEDGER_TABLES.event]
        .filter((row) => forgottenStreamIds.has(row.streamId))
        .map((row) => row.eventId),
    );
    expect(database.tables[MEMORY_LEDGER_TABLES.payload]
      .some((row) => forgottenEventIds.has(row.eventId))).toBe(false);
    expect(database.tables[MEMORY_LEDGER_TABLES.evidence]
      .some((row) => forgottenEventIds.has(row.eventId))).toBe(false);
    expect(database.tables[MEMORY_LEDGER_TABLES.embedding]
      .some((row) => forgottenStreamIds.has(row.streamId))).toBe(false);
    expect(database.tables[MEMORY_LEDGER_TABLES.fts]
      .some((row) => forgottenStreamIds.has(row.streamId))).toBe(false);
    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .filter((row) => forgottenStreamIds.has(row.streamId)))
      .toEqual([
        expect.objectContaining({ status: 'cancelled', payload: '{}' }),
        expect.objectContaining({ status: 'cancelled', payload: '{}' }),
      ]);
    expect(database.tables[MEMORY_LEDGER_TABLES.head]
      .find((row) => row.streamId === otherContext.streamId)).toMatchObject({
      state: 'active',
      payloadId: expect.any(String),
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.head]
      .find((row) => row.streamId === otherMessage.streamId)).toMatchObject({
      state: 'active',
      payloadId: expect.any(String),
    });

    await expect(store.forget({
      actor: { userKey: 'onebot:user:10001', isDirect: true },
      streamId: initial.streamId,
    })).resolves.toBe(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.head]
      .filter((row) => row.state === 'forgotten')).toHaveLength(3);
  });

  it('keeps Bob pending and leased work while stream, context, and all scopes clear only Alice lanes', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const alice = {
      ...groupAddress('scoped-forget', '10001'),
      conversationId: 'conversation:scoped-forget',
      currentAudienceSubjectKeys: [
        'onebot:user:10001',
        'onebot:user:10002',
      ],
      observedAt: 1_000,
    };
    const bob = {
      ...alice,
      userKey: 'onebot:user:10002',
      userId: '10002',
    };
    const direct = {
      ...directAddress('10001'),
      conversationId: 'conversation:scoped-forget-direct',
      observedAt: 1_000,
    };
    database.tables.chatluna_conversation = [{
      id: alice.conversationId,
      latestMessageId: 'A1',
    }, {
      id: direct.conversationId,
      latestMessageId: 'D1',
    }];
    await store.queueExtractWork({
      address: alice,
      targetSpeakerId: alice.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    });
    database.tables.chatluna_conversation[0]!.latestMessageId = 'B1';
    await store.queueExtractWork({
      address: bob,
      targetSpeakerId: bob.userId,
      targetSpeakerName: 'Bob',
      maxMessages: 10,
      nextRunAt: 0,
    });
    expect(await store.claimDueWork('extract', Date.now(), 60_000)).not.toBeNull();
    expect(await store.claimDueWork('extract', Date.now(), 60_000)).not.toBeNull();
    database.tables.chatluna_conversation[0]!.latestMessageId = 'A2';
    await store.queueExtractWork({
      address: { ...alice, observedAt: 2_000 },
      targetSpeakerId: alice.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    });
    database.tables.chatluna_conversation[0]!.latestMessageId = 'B2';
    await store.queueExtractWork({
      address: { ...bob, observedAt: 2_000 },
      targetSpeakerId: bob.userId,
      targetSpeakerName: 'Bob',
      maxMessages: 10,
      nextRunAt: 0,
    });
    await store.queueExtractWork({
      address: direct,
      targetSpeakerId: direct.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    });
    const head = await store.appendAssertion(assertion({
      idempotencyKey: 'scoped-forget-alice-head',
      subjectKey: alice.userKey,
      sourceContextKey: alice.contextKey,
      evidence: [{
        messageId: 'alice-head-source',
        speakerId: alice.userId,
        contextKey: alice.contextKey,
        captureAudienceSubjectKeys: [alice.userKey],
        occurredAt: 800,
      }],
    }));

    await expect(store.forget({
      actor: { userKey: alice.userKey, isDirect: true },
      streamId: head.streamId,
    })).resolves.toBe(1);
    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .filter((row) => row.subjectKey === alice.userKey && row.contextKey === alice.contextKey)
      .map((row) => row.status)).toEqual(['cancelled', 'cancelled']);
    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .filter((row) => row.subjectKey === bob.userKey)
      .map((row) => row.status)).toEqual(['leased', 'pending']);
    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .find((row) => row.contextKey === direct.contextKey)).toMatchObject({
      status: 'pending',
    });

    database.tables.chatluna_conversation[0]!.latestMessageId = 'A3';
    await store.queueExtractWork({
      address: { ...alice, observedAt: 3_000 },
      targetSpeakerId: alice.userId,
      targetSpeakerName: 'Alice',
      maxMessages: 10,
      nextRunAt: 0,
    });
    await expect(store.forget({
      actor: { userKey: alice.userKey, isDirect: false },
      contextKey: alice.contextKey,
    })).resolves.toBe(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .find((row) => row.subjectKey === alice.userKey && row.status === 'pending'
        && row.contextKey === alice.contextKey)).toBeUndefined();
    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .filter((row) => row.subjectKey === bob.userKey)
      .map((row) => row.status)).toEqual(['leased', 'pending']);

    await expect(store.forget({
      actor: { userKey: alice.userKey, isDirect: true },
      all: true,
    })).resolves.toBe(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .find((row) => row.contextKey === direct.contextKey)).toMatchObject({
      status: 'cancelled',
      payload: '{}',
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .filter((row) => row.subjectKey === bob.userKey)
      .map((row) => row.status)).toEqual(['leased', 'pending']);
  });

  it('rolls back the entire forget transaction when its audit write fails', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const head = await store.appendAssertion(assertion({
      idempotencyKey: 'forget-rollback',
    }));
    const payloadCount = database.tables[MEMORY_LEDGER_TABLES.payload].length;
    const evidenceCount = database.tables[MEMORY_LEDGER_TABLES.evidence].length;
    database.failOnCreateTable = MEMORY_LEDGER_TABLES.audit;

    await expect(store.forget({
      actor: { userKey: 'onebot:user:10001', isDirect: true },
      streamId: head.streamId,
    })).rejects.toBeInstanceOf(MemoryRuntimeError);
    expect(database.tables[MEMORY_LEDGER_TABLES.head][0]).toMatchObject({
      streamId: head.streamId,
      state: 'active',
      revision: 1,
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.payload]).toHaveLength(payloadCount);
    expect(database.tables[MEMORY_LEDGER_TABLES.evidence]).toHaveLength(evidenceCount);
    expect(database.tables[MEMORY_LEDGER_TABLES.suppression]).toHaveLength(0);
  });

  it('queues backfill and recall only for active assertions', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const active = await store.appendAssertion(assertion({ idempotencyKey: 'active' }));
    await store.appendAssertion(assertion({
      idempotencyKey: 'pending',
      state: 'pendingReview',
      content: '待审核内容。',
      retrievalText: '待审核内容。',
      evidence: [{
        messageId: 'message-2',
        speakerId: '10001',
        contextKey: 'onebot:bot:bot:group:group-a',
        captureAudienceSubjectKeys: ['onebot:user:10001'],
        occurredAt: 902,
      }],
    }));
    const identity = {
      canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
      modelRevision: 7,
    };

    expect(await store.queueBackfill(identity)).toBe(1);
    const backfill = database.tables[MEMORY_LEDGER_TABLES.work].filter((row) => row.workType === 'backfill');
    expect(backfill).toHaveLength(1);
    expect(backfill[0]).toMatchObject({ streamId: active.streamId, targetRevision: 1 });
    const recalled = await store.listForContext(groupAddress('group-a'), identity);
    expect(recalled.map((item) => item.streamId)).toEqual([active.streamId]);
    expect(database.tables[MEMORY_LEDGER_TABLES.fts]).toHaveLength(1);
  });

  it('supersedes a leased backfill when the canonical embedding revision changes', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    await store.appendAssertion(assertion({
      idempotencyKey: 'embedding-revision-change',
    }));
    const revision7 = {
      canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
      modelRevision: 7,
    };
    const revision8 = {
      ...revision7,
      modelRevision: 8,
    };
    expect(await store.queueBackfill(revision7)).toBe(1);
    const claimed = await store.claimDueWork('backfill', Date.now(), 60_000);
    expect(claimed).not.toBeNull();
    const oldPayload = store.parseWorkPayload<EmbeddingWorkPayload>(claimed!.work);

    expect(await store.resolveEmbeddingWork(claimed!.work, revision8)).toEqual({
      state: 'obsolete',
      reasonCode: 'memory_embedding_identity_superseded',
    });
    expect(await store.queueBackfill(revision8)).toBe(1);

    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .find((row) => row.id === claimed!.work.id)).toMatchObject({
        status: 'cancelled',
        payload: '{}',
        leaseToken: null,
        lastErrorCode: 'memory_embedding_superseded',
      });
    expect(database.tables[MEMORY_LEDGER_TABLES.work]).toContainEqual(
      expect.objectContaining({
        workType: 'backfill',
        status: 'pending',
        payload: expect.stringContaining('"modelRevision":8'),
      }),
    );
    await expect(store.finalizeEmbedding({
      work: claimed!.work,
      leaseToken: claimed!.leaseToken,
      payload: oldPayload,
      vector: [0.1, 0.2],
    })).rejects.toMatchObject({ code: 'memory_lease_lost' });
    expect(database.tables[MEMORY_LEDGER_TABLES.embedding]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .filter((row) => row.status === 'deadLetter')).toHaveLength(0);
  });

  it('supersedes leased embedding work when audience promotion changes the event revision', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const identity = {
      canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
      modelRevision: 7,
    };
    const head = await store.appendAssertion(assertion({
      idempotencyKey: 'embedding-promotion-race',
      embeddingIdentity: identity,
    }));
    const claimed = await store.claimDueWork('embed', Date.now(), 60_000);
    expect(claimed).not.toBeNull();
    const oldPayload = store.parseWorkPayload<EmbeddingWorkPayload>(claimed!.work);

    await store.promoteAudience({
      streamId: head.streamId,
      actor: { userKey: 'onebot:user:10001', isDirect: true },
      audiencePolicy: 'subjectAllContexts',
      audienceContextKeys: [],
      audienceSnapshots: {},
      embeddingIdentity: identity,
    });

    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .find((row) => row.id === claimed!.work.id)).toMatchObject({
        status: 'cancelled',
        payload: '{}',
        leaseToken: null,
        lastErrorCode: 'memory_embedding_target_superseded',
      });
    expect(database.tables[MEMORY_LEDGER_TABLES.work]).toContainEqual(
      expect.objectContaining({
        workType: 'embed',
        status: 'pending',
        targetRevision: 2,
      }),
    );
    await expect(store.finalizeEmbedding({
      work: claimed!.work,
      leaseToken: claimed!.leaseToken,
      payload: oldPayload,
      vector: [0.1, 0.2],
    })).rejects.toMatchObject({ code: 'memory_lease_lost' });
    expect(database.tables[MEMORY_LEDGER_TABLES.embedding]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .filter((row) => row.status === 'deadLetter')).toHaveLength(0);
  });

  it('cancels a leased embedding result when its target changed after provider work', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const identity = {
      canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
      modelRevision: 7,
    };
    await store.appendAssertion(assertion({
      idempotencyKey: 'embedding-target-change',
      embeddingIdentity: identity,
    }));
    const claimed = await store.claimDueWork('embed', Date.now(), 60_000);
    expect(claimed).not.toBeNull();
    const payload = store.parseWorkPayload<EmbeddingWorkPayload>(claimed!.work);
    Object.assign(database.tables[MEMORY_LEDGER_TABLES.head][0]!, {
      eventId: 'newer-event',
      revision: 2,
      updatedAt: Date.now(),
    });

    await expect(store.finalizeEmbedding({
      work: claimed!.work,
      leaseToken: claimed!.leaseToken,
      payload,
      vector: [0.1, 0.2],
    })).resolves.toBeUndefined();

    expect(database.tables[MEMORY_LEDGER_TABLES.embedding]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.work][0]).toMatchObject({
      status: 'cancelled',
      payload: '{}',
      leaseToken: null,
      lastErrorCode: 'memory_embedding_target_superseded',
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.audit]).toContainEqual(
      expect.objectContaining({
        eventType: 'embedding_work_superseded',
        workKey: claimed!.work.workKey,
      }),
    );
  });

  it('repairs stale lexical projections and requeues terminal backfill work', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const active = await store.appendAssertion(assertion({
      idempotencyKey: 'repair-active',
    }));
    const pending = await store.appendAssertion(assertion({
      idempotencyKey: 'repair-pending',
      state: 'pendingReview',
      content: '待审核内容。',
      retrievalText: '待审核内容。',
      evidence: [{
        messageId: 'message-repair-pending',
        speakerId: '10001',
        contextKey: 'onebot:bot:bot:group:group-a',
        captureAudienceSubjectKeys: ['onebot:user:10001'],
        occurredAt: 904,
      }],
    }));
    const identity = {
      canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
      modelRevision: 7,
    };
    expect(await store.queueBackfill(identity)).toBe(1);
    const existingWork = database.tables[MEMORY_LEDGER_TABLES.work].find(
      (row) => row.workType === 'backfill',
    )!;
    Object.assign(existingWork, {
      status: 'deadLetter',
      retryCount: 3,
      completedAt: Date.now(),
    });
    Object.assign(database.tables[MEMORY_LEDGER_TABLES.fts][0]!, {
      eventId: 'event:stale',
      revision: 99,
    });
    database.tables[MEMORY_LEDGER_TABLES.fts].push({
      ...createMemoryLexicalProjection({
        streamId: pending.streamId,
        eventId: pending.eventId,
        revision: pending.revision,
        contentHash: pending.contentHash!,
        canonicalText: '待审核内容。',
      }),
    });
    database.tables[MEMORY_LEDGER_TABLES.embedding].push(
      {
        id: 1,
        embeddingKey: 'embedding:stale',
        streamId: active.streamId,
        eventId: 'event:stale',
        revision: active.revision,
        canonicalModel: identity.canonicalModel,
        modelRevision: 6,
        contentHash: active.contentHash,
        dimensions: 2,
        vector: '[1,0]',
        createdAt: Date.now(),
      },
      {
        id: 2,
        embeddingKey: 'embedding:inactive',
        streamId: pending.streamId,
        eventId: pending.eventId,
        revision: pending.revision,
        canonicalModel: identity.canonicalModel,
        modelRevision: identity.modelRevision,
        contentHash: pending.contentHash,
        dimensions: 2,
        vector: '[0,1]',
        createdAt: Date.now(),
      },
    );

    await expect(store.getLedgerCounts(identity)).resolves.toMatchObject({
      staleFts: 1,
      inactiveFts: 1,
      staleEmbedding: 1,
      inactiveEmbedding: 1,
    });
    expect(await store.queueBackfill(identity)).toBe(1);
    const [projection] = database.tables[MEMORY_LEDGER_TABLES.fts];
    expect(database.tables[MEMORY_LEDGER_TABLES.fts]).toHaveLength(1);
    expect(memoryLexicalProjectionMatches(
      projection as MemoryLexicalProjectionRow,
      {
        streamId: active.streamId,
        eventId: active.eventId,
        revision: active.revision,
        contentHash: active.contentHash!,
        canonicalText: 'preference\n音乐\n用户喜欢爵士乐。',
      },
    )).toBe(true);
    const repairedWork = database.tables[MEMORY_LEDGER_TABLES.work].find(
      (row) => row.workKey === existingWork.workKey,
    );
    expect(repairedWork).toMatchObject({
      status: 'pending',
      retryCount: 0,
      completedAt: null,
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.embedding]).toHaveLength(0);
    await expect(store.getLedgerCounts(identity)).resolves.toMatchObject({
      staleFts: 0,
      inactiveFts: 0,
      staleEmbedding: 0,
      inactiveEmbedding: 0,
      strandedByReason: {
        fts: 0,
        embedding: 1,
      },
    });
  });

  it('writes one content-free recall audit per request in a long-lived conversation', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const jazz = await store.appendAssertion(assertion({
      idempotencyKey: 'audit-jazz',
      content: '用户喜欢爵士乐。',
      retrievalText: '音乐偏好 爵士乐',
    }));
    const hiking = await store.appendAssertion(assertion({
      idempotencyKey: 'audit-hiking',
      content: '用户喜欢登山。',
      retrievalText: '运动偏好 登山',
      evidence: [{
        messageId: 'message-hiking',
        speakerId: '10001',
        contextKey: 'onebot:bot:bot:group:group-a',
        captureAudienceSubjectKeys: ['onebot:user:10001'],
        occurredAt: 903,
      }],
    }));
    const firstAddress = {
      ...groupAddress('group-a'),
      conversationId: 'conversation:long-lived',
      requestId: 'request-1',
      observedAt: 10_000,
    };
    await retrieveMemoryForContext(store, firstAddress, '爵士乐', {
      topK: 1,
      promptBudgetTokens: 800,
      embeddingIdentity: null,
    });
    const secondAddress = {
      ...firstAddress,
      requestId: 'request-2',
      observedAt: 20_000,
    };
    await retrieveMemoryForContext(store, secondAddress, '登山', {
      topK: 1,
      promptBudgetTokens: 800,
      embeddingIdentity: null,
    });

    const audits = database.tables[MEMORY_LEDGER_TABLES.audit]
      .filter((row) => row.eventType === 'recall_selected');
    expect(audits).toHaveLength(2);
    expect(audits.map((row) => row.idempotencyKey)).toEqual([
      'recall:conversation:long-lived:request-1',
      'recall:conversation:long-lived:request-2',
    ]);
    const latest = await store.getLatestRecallAudit(
      secondAddress.userKey,
      secondAddress.contextKey,
    );
    expect(JSON.parse(String(latest?.detailJson))).toMatchObject({
      selected: [expect.objectContaining({ streamId: hiking.streamId })],
    });
    expect(JSON.parse(String(audits[0]!.detailJson))).toMatchObject({
      selected: [expect.objectContaining({ streamId: jazz.streamId })],
    });
  });

  it('uses one explicit reference time for policy and temporal ranking', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const referenceNow = 1_000_000_000_000;
    await store.appendAssertion(assertion({
      streamId: 'a-older',
      idempotencyKey: 'temporal-older',
      content: '登山计划。',
      retrievalText: '登山 计划',
      createdAt: referenceNow - 365 * 86_400_000,
    }));
    await store.appendAssertion(assertion({
      streamId: 'z-newer',
      idempotencyKey: 'temporal-newer',
      content: '登山计划。',
      retrievalText: '登山 计划',
      createdAt: referenceNow - 86_400_000,
    }));

    const result = await retrieveMemoryForContext(
      store,
      {
        ...groupAddress('group-a'),
        observedAt: referenceNow,
        requestId: 'temporal-ranking',
      },
      '登山',
      {
        topK: 1,
        promptBudgetTokens: 800,
        embeddingIdentity: null,
        now: referenceNow,
      },
    );

    expect(result.items.map((item) => item.streamId)).toEqual(['z-newer']);
  });

  it('does not recall high-quality memory without lexical or semantic evidence', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    await store.appendAssertion(assertion({
      idempotencyKey: 'abstention-unrelated',
      content: '用户喜欢爵士乐。',
      retrievalText: '音乐偏好 爵士乐',
      importance: 1,
      confidence: 1,
    }));

    const result = await retrieveMemoryForContext(
      store,
      {
        ...groupAddress('group-a'),
        requestId: 'abstention-unrelated',
      },
      'xylophonomicon',
      {
        topK: 10,
        promptBudgetTokens: 800,
        embeddingIdentity: null,
      },
    );

    expect(result).toEqual({ prompt: null, items: [] });
    expect(database.tables[MEMORY_LEDGER_TABLES.audit]
      .filter((row) => row.eventType === 'recall_selected')).toHaveLength(0);
  });

  it('blocks group recall when a new member was not in the capture audience', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const policy = new MemoryPolicyService();
    const store = memoryStore(database, policy);
    const originalAudience = ['onebot:user:10001', 'onebot:user:10002'];
    const captureAddress = {
      ...groupAddress('group-a'),
      currentAudienceSubjectKeys: originalAudience,
    };
    const capture = policy.capturePolicy(captureAddress, 'low');
    expect(capture).toEqual({
      audiencePolicy: 'captureAudience',
      audienceContextKeys: [captureAddress.contextKey],
      audienceSnapshots: {
        [captureAddress.contextKey]: originalAudience,
      },
    });
    await store.appendAssertion(assertion({
      idempotencyKey: 'captured-before-join',
      ...capture,
      evidence: [{
        messageId: 'message-before-join',
        speakerId: '10001',
        contextKey: captureAddress.contextKey,
        captureAudienceSubjectKeys: originalAudience,
        occurredAt: 904,
      }],
    }));

    expect(await store.listForContext(captureAddress, null)).toHaveLength(1);
    expect(await store.listForContext({
      ...captureAddress,
      currentAudienceSubjectKeys: [...originalAudience, 'onebot:user:10003'],
    }, null)).toHaveLength(0);
    expect(await store.listForContext({
      ...captureAddress,
      currentAudienceSubjectKeys: null,
    }, null)).toHaveLength(0);
  });

  it('keeps all content and mutation Admin APIs closed during maintenance', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const pending = await store.appendAssertion(assertion({
      idempotencyKey: 'maintenance-pending',
      state: 'pendingReview',
    }));
    const admin = new MemoryAdminService(database, store, { maintenance: true });

    await expect(admin.getAssertionsPage({ page: 1, pageSize: 20 }))
      .rejects.toMatchObject({ code: 'memory_maintenance_mode', operation: 'recall' });
    await expect(admin.getReviewsPage({ page: 1, pageSize: 20 }))
      .rejects.toMatchObject({ code: 'memory_maintenance_mode' });
    await expect(admin.review({ streamId: pending.streamId, decision: 'reject' }))
      .rejects.toMatchObject({ code: 'memory_maintenance_mode', operation: 'review' });
    await expect(admin.archive({ streamId: pending.streamId }))
      .rejects.toMatchObject({ code: 'memory_maintenance_mode', operation: 'archive' });
    await expect(admin.backfill({
      canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
      modelRevision: 7,
    })).rejects.toMatchObject({ code: 'memory_maintenance_mode', operation: 'backfill' });
    await expect(admin.forget({
      streamId: pending.streamId,
      reasonCode: 'operator-delete',
    })).rejects.toMatchObject({
      code: 'memory_maintenance_mode',
      operation: 'forget',
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.head][0]).toMatchObject({
      streamId: pending.streamId,
      state: 'pendingReview',
      revision: 1,
    });
  });

  it('records cross-context promotion only from explicit subject consent', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const head = await store.appendAssertion(assertion());
    await expect(store.promoteAudience({
      streamId: head.streamId,
      actor: { userKey: 'admin', isDirect: false, isAdmin: true },
      audiencePolicy: 'subjectAllContexts',
      audienceContextKeys: [],
      audienceSnapshots: {},
      embeddingIdentity: {
        canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
        modelRevision: 7,
      },
    })).rejects.toMatchObject({ code: 'memory_promotion_requires_subject_consent' });
    await store.promoteAudience({
      streamId: head.streamId,
      actor: { userKey: 'onebot:user:10001', isDirect: true },
      audiencePolicy: 'subjectAllContexts',
      audienceContextKeys: [],
      audienceSnapshots: {},
      embeddingIdentity: {
        canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
        modelRevision: 7,
      },
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.event].at(-1)).toMatchObject({
      eventType: 'visibilityChanged',
      actorKey: 'onebot:user:10001',
      audiencePolicy: 'subjectAllContexts',
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.head][0]).toMatchObject({
      revision: 2,
      audiencePolicy: 'subjectAllContexts',
    } satisfies Partial<MemoryV2HeadRecord>);
    expect(await store.listForOwner(directAddress(), false)).toHaveLength(1);
    expect(await store.listForContext(groupAddress('group-b'), null)).toHaveLength(0);

    const groupA = groupAddress('group-a');
    const groupB = groupAddress('group-b');
    await store.promoteAudience({
      streamId: head.streamId,
      actor: { userKey: 'onebot:user:10001', isDirect: true },
      audiencePolicy: 'explicitContexts',
      audienceContextKeys: [groupA.contextKey, groupB.contextKey],
      audienceSnapshots: {
        [groupA.contextKey]: ['onebot:user:10001', 'onebot:user:10002'],
        [groupB.contextKey]: ['onebot:user:10001', 'onebot:user:10003'],
      },
      embeddingIdentity: {
        canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
        modelRevision: 7,
      },
    });
    expect(await store.listForContext({
      ...groupA,
      currentAudienceSubjectKeys: ['onebot:user:10001', 'onebot:user:10002'],
    }, null)).toHaveLength(1);
    expect(await store.listForContext({
      ...groupB,
      currentAudienceSubjectKeys: ['onebot:user:10001', 'onebot:user:10003'],
    }, null)).toHaveLength(1);
    expect(await store.listForContext({
      ...groupB,
      currentAudienceSubjectKeys: [
        'onebot:user:10001',
        'onebot:user:10002',
        'onebot:user:10003',
      ],
    }, null)).toHaveLength(0);
  });

  it('archives through one transaction while retaining clearable source content', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const head = await store.appendAssertion(assertion());
    await store.queueBackfill({
      canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
      modelRevision: 7,
    });
    database.tables[MEMORY_LEDGER_TABLES.embedding].push({
      id: 1,
      embeddingKey: 'archive-test-embedding',
      streamId: head.streamId,
      eventId: head.eventId,
      revision: head.revision,
      canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
      modelRevision: 7,
      contentHash: head.contentHash,
      dimensions: 2,
      vector: '[0.1,0.2]',
      createdAt: 1,
    });
    const payloadCount = database.tables[MEMORY_LEDGER_TABLES.payload].length;
    const evidenceCount = database.tables[MEMORY_LEDGER_TABLES.evidence].length;

    const admin = new MemoryAdminService(database, store, { maintenance: false });
    await admin.archive({
      streamId: head.streamId,
      reasonCode: 'operator-archive',
    });

    expect(database.tables[MEMORY_LEDGER_TABLES.head][0]).toMatchObject({
      streamId: head.streamId,
      revision: 2,
      state: 'archived',
      payloadId: head.payloadId,
      contentHash: head.contentHash,
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.event].at(-1)).toMatchObject({
      streamId: head.streamId,
      revision: 2,
      eventType: 'archived',
      payloadId: head.payloadId,
      actorKey: 'admin',
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.payload]).toHaveLength(payloadCount);
    expect(database.tables[MEMORY_LEDGER_TABLES.evidence]).toHaveLength(evidenceCount);
    expect(database.tables[MEMORY_LEDGER_TABLES.embedding]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.fts]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.work][0]).toMatchObject({
      status: 'cancelled',
      payload: '{}',
      lastErrorCode: 'memory_archived',
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.audit].at(-1)).toMatchObject({
      eventType: 'memory_archived',
      streamId: head.streamId,
    });
  });

  it('archives only low-risk old episodes at the configured retention boundary', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const now = 200 * 86_400_000;
    const old = now - 91 * 86_400_000;
    const oldEpisode = await store.appendAssertion(assertion({
      idempotencyKey: 'retention-old-episode',
      assertionType: 'episode',
      content: '一次普通群聊事件。',
      retrievalText: '普通 群聊 事件',
      importance: 0.5,
      sensitivity: 'low',
      createdAt: old,
    }));
    const importantEpisode = await store.appendAssertion(assertion({
      idempotencyKey: 'retention-important-episode',
      assertionType: 'episode',
      content: '一次重要群聊事件。',
      retrievalText: '重要 群聊 事件',
      importance: 0.9,
      sensitivity: 'low',
      createdAt: old,
    }));
    const recentEpisode = await store.appendAssertion(assertion({
      idempotencyKey: 'retention-recent-episode',
      assertionType: 'episode',
      content: '一次最近群聊事件。',
      retrievalText: '最近 群聊 事件',
      importance: 0.5,
      sensitivity: 'low',
      createdAt: now - 6 * 86_400_000,
    }));

    await expect(store.archiveLowRiskOldEpisodes(90, now)).resolves.toBe(1);
    expect(database.tables[MEMORY_LEDGER_TABLES.head].find(
      (row) => row.streamId === oldEpisode.streamId,
    )).toMatchObject({ state: 'archived', revision: 2 });
    expect(database.tables[MEMORY_LEDGER_TABLES.head].find(
      (row) => row.streamId === importantEpisode.streamId,
    )).toMatchObject({ state: 'active', revision: 1 });
    expect(database.tables[MEMORY_LEDGER_TABLES.head].find(
      (row) => row.streamId === recentEpisode.streamId,
    )).toMatchObject({ state: 'active', revision: 1 });
    expect(database.tables[MEMORY_LEDGER_TABLES.event].at(-1)).toMatchObject({
      streamId: oldEpisode.streamId,
      eventType: 'archived',
      actorKey: 'memory.maintenance',
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.audit].at(-1)).toMatchObject({
      eventType: 'memory_archived',
      detailJson: JSON.stringify({
        reasonCode: 'retention-policy',
        previousState: 'active',
      }),
    });
  });

  it('deduplicates production group extraction across user lanes while completing both works', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const audience = ['onebot:user:10001', 'onebot:user:10002'];
    const addressA = {
      ...groupAddress('group-a', '10001'),
      conversationId: 'conversation:group-domain',
      currentAudienceSubjectKeys: audience,
    };
    const addressB = {
      ...groupAddress('group-a', '10002'),
      conversationId: addressA.conversationId,
      currentAudienceSubjectKeys: audience,
    };
    database.tables.chatluna_conversation = [{
      id: addressA.conversationId,
      latestMessageId: 'G1',
    }];
    database.tables.chatluna_message = [{
      id: 'G1',
      role: 'human',
      parentId: null,
      conversationId: addressA.conversationId,
      content: '读书会固定在每周六。',
      additional_kwargs: JSON.stringify({
        qqbot_speaker_format: {
          version: 'speaker_id_v1',
          speakerId: '10001',
          speakerName: '甲',
        },
      }),
      createdAt: 900,
    }];
    for (const address of [addressA, addressB]) {
      await store.queueExtractWork({
        address,
        targetSpeakerId: address.userId,
        targetSpeakerName: null,
        maxMessages: 10,
        nextRunAt: 0,
      });
    }
    const first = await store.claimDueWork('extract', Date.now(), 60_000);
    const second = await store.claimDueWork('extract', Date.now(), 60_000);
    const firstPayload = store.parseWorkPayload<ExtractWorkPayload>(first!.work);
    const secondPayload = store.parseWorkPayload<ExtractWorkPayload>(second!.work);
    const firstTurns = await store.readConversationWindow(firstPayload);
    const secondTurns = await store.readConversationWindow(secondPayload);
    const candidate = domainFact('group_shared', ['G1'], ['10001']);

    for (const [claimed, payload, turns, rawTextHash] of [
      [first!, firstPayload, firstTurns, 'group-domain-a'],
      [second!, secondPayload, secondTurns, 'group-domain-b'],
    ] as const) {
      await store.finalizeExtraction({
        work: claimed.work,
        leaseToken: claimed.leaseToken,
        payload,
        turns,
        candidates: [candidate],
        providerRoute: 'native_chat_json_schema',
        rawTextHash,
        embeddingIdentity: null,
      });
    }

    expect(database.tables[MEMORY_LEDGER_TABLES.event]).toHaveLength(1);
    expect(database.tables[MEMORY_LEDGER_TABLES.head]).toHaveLength(1);
    expect(database.tables[MEMORY_LEDGER_TABLES.evidence]).toHaveLength(1);
    expect(database.tables[MEMORY_LEDGER_TABLES.head][0]).toMatchObject({
      assertionType: 'groupArtifact',
      subjectType: 'group',
      subjectKey: 'onebot:group:group-a',
      state: 'active',
      sensitivity: 'low',
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .filter((row) => row.status === 'succeeded')).toHaveLength(2);
    expect(database.tables[MEMORY_LEDGER_TABLES.cursor]).toHaveLength(2);
  });

  it('derives assistant evidence audience from its causal parent capture', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const initialAudience = ['onebot:user:10001', 'onebot:user:10002'];
    const address = {
      ...groupAddress('group-a'),
      conversationId: 'conversation:assistant-domain',
      currentAudienceSubjectKeys: initialAudience,
      observedAt: 1_000,
    };
    database.tables.chatluna_conversation = [{
      id: address.conversationId,
      latestMessageId: 'H1',
    }];
    database.tables.chatluna_message = [{
      id: 'H1',
      role: 'human',
      parentId: null,
      conversationId: address.conversationId,
      content: '下周一提醒我提交材料。',
      additional_kwargs: JSON.stringify({
        qqbot_speaker_format: {
          version: 'speaker_id_v1',
          speakerId: '10001',
          speakerName: '甲',
        },
      }),
      createdAt: 900,
    }, {
      id: 'A1',
      role: 'ai',
      parentId: 'H1',
      conversationId: address.conversationId,
      content: '我会在下周一提醒你提交材料。',
      createdAt: 950,
    }, {
      id: 'H2',
      role: 'human',
      parentId: 'A1',
      conversationId: address.conversationId,
      content: '谢谢。',
      additional_kwargs: JSON.stringify({
        qqbot_speaker_format: {
          version: 'speaker_id_v1',
          speakerId: '10001',
          speakerName: '甲',
        },
      }),
      createdAt: 1_900,
    }];
    await store.queueExtractWork({
      address,
      targetSpeakerId: address.userId,
      targetSpeakerName: '甲',
      maxMessages: 10,
      nextRunAt: 0,
    });
    database.tables.chatluna_conversation[0]!.latestMessageId = 'H2';
    await store.queueExtractWork({
      address: {
        ...address,
        currentAudienceSubjectKeys: [...initialAudience, 'onebot:user:10003'],
        observedAt: 2_000,
      },
      targetSpeakerId: address.userId,
      targetSpeakerName: '甲',
      maxMessages: 10,
      nextRunAt: 0,
    });
    const claimed = await store.claimDueWork('extract', Date.now(), 60_000);
    const payload = store.parseWorkPayload<ExtractWorkPayload>(claimed!.work);
    await store.finalizeExtraction({
      work: claimed!.work,
      leaseToken: claimed!.leaseToken,
      payload,
      turns: await store.readConversationWindow(payload),
      candidates: [domainFact('assistant', ['A1'], ['bot'])],
      providerRoute: 'native_chat_json_schema',
      rawTextHash: 'assistant-domain',
      embeddingIdentity: null,
    });

    expect(JSON.parse(String(
      database.tables[MEMORY_LEDGER_TABLES.evidence][0]!
        .captureAudienceSubjectKeys,
    ))).toEqual(initialAudience);
    expect(database.tables[MEMORY_LEDGER_TABLES.evidence][0]).toMatchObject({
      messageId: 'A1',
      speakerId: 'bot',
      replyToMessageId: 'H1',
    });
    expect(JSON.parse(String(
      database.tables[MEMORY_LEDGER_TABLES.head][0]!.audienceSnapshots,
    ))).toEqual({ [address.contextKey]: initialAudience });
    expect(database.tables[MEMORY_LEDGER_TABLES.head][0]).toMatchObject({
      assertionType: 'assistantCommitment',
      subjectType: 'assistant',
      subjectKey: 'onebot:bot:bot',
      state: 'active',
      sensitivity: 'low',
    });
  });

  it('prevents every user lane and replay variant from reviving a forgotten group artifact', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const audience = ['onebot:user:10001', 'onebot:user:10002'];
    const addressA = {
      ...groupAddress('group-forget', '10001'),
      conversationId: 'conversation:group-forget',
      currentAudienceSubjectKeys: audience,
      observedAt: 1_000,
    };
    const addressB = {
      ...addressA,
      userKey: 'onebot:user:10002',
      userId: '10002',
    };
    const sourceTurn = {
      id: 'group-source',
      role: 'human' as const,
      text: '读书会固定在每周六。',
      speakerId: '10001',
      speakerName: '甲',
      ownerUserKey: addressA.userKey,
      isTarget: true,
      attributionSource: 'additional_kwargs' as const,
      parentId: null,
      occurredAt: 900,
    };
    const domainInput = {
      address: addressA,
      content: '群读书会固定在每周六举行。',
      retrievalText: '群活动\n读书会\n每周六',
      evidenceMessageIds: [sourceTurn.id],
      capturedAudiences: [{
        messageId: sourceTurn.id,
        observedAt: sourceTurn.occurredAt,
        audienceSubjectKeys: audience,
      }],
      turns: [sourceTurn],
      sensitivity: 'low' as const,
      importance: 0.8,
      confidence: 0.95,
      embeddingIdentity: {
        canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
        modelRevision: 7,
      },
    };
    const ingested = await store.ingestGroupArtifact(domainInput);
    database.tables.chatluna_conversation = [{
      id: addressA.conversationId,
      latestMessageId: 'group-anchor',
    }];
    for (const address of [addressA, addressB]) {
      await store.queueExtractWork({
        address,
        targetSpeakerId: address.userId,
        targetSpeakerName: null,
        maxMessages: 10,
        nextRunAt: 0,
      });
    }
    const leased = [
      await store.claimDueWork('extract', Date.now(), 60_000),
      await store.claimDueWork('extract', Date.now(), 60_000),
    ];
    expect(leased.every(Boolean)).toBe(true);

    await store.forget({
      actor: { userKey: 'admin', isDirect: false, isAdmin: true },
      streamId: ingested.head.streamId,
    });

    for (const claimed of leased) {
      const payload = store.parseWorkPayload<ExtractWorkPayload>(claimed!.work);
      await expect(store.finalizeExtraction({
        work: claimed!.work,
        leaseToken: claimed!.leaseToken,
        payload,
        turns: [sourceTurn],
        candidates: [domainFact('group_shared', [sourceTurn.id], ['10001'])],
        providerRoute: 'native_chat_json_schema',
        rawTextHash: 'late-group-provider-result',
        embeddingIdentity: null,
      })).resolves.toEqual({
        active: 0,
        pendingReview: 0,
        rejected: 1,
      });
    }
    await expect(store.ingestGroupArtifact({
      ...domainInput,
      content: '换一种措辞：周六仍然举行群读书会。',
      retrievalText: '读书会 周六 变体',
    })).rejects.toMatchObject({ code: 'memory_source_suppressed' });

    const unrelatedTurn = {
      ...sourceTurn,
      id: 'group-anchor-2',
      text: '我喜欢古典音乐。',
      occurredAt: 1_100,
    };
    database.tables.chatluna_conversation[0]!.latestMessageId = unrelatedTurn.id;
    database.tables.chatluna_message = [{
      id: 'group-anchor',
      role: 'human',
      parentId: null,
      conversationId: addressA.conversationId,
      content: '前一条群消息。',
      createdAt: 1_000,
    }, {
      id: unrelatedTurn.id,
      role: 'human',
      parentId: 'group-anchor',
      conversationId: addressA.conversationId,
      content: unrelatedTurn.text,
      createdAt: unrelatedTurn.occurredAt,
    }];
    expect(await store.queueExtractWork({
      address: { ...addressA, observedAt: unrelatedTurn.occurredAt },
      targetSpeakerId: addressA.userId,
      targetSpeakerName: '甲',
      maxMessages: 10,
      nextRunAt: 0,
    })).toBe(true);
    const safeReplay = await store.claimDueWork('extract', Date.now(), 60_000);
    expect(safeReplay).not.toBeNull();
    const safePayload = store.parseWorkPayload<ExtractWorkPayload>(
      safeReplay!.work,
    );
    await expect(store.finalizeExtraction({
      work: safeReplay!.work,
      leaseToken: safeReplay!.leaseToken,
      payload: safePayload,
      turns: [sourceTurn, unrelatedTurn],
      candidates: [
        {
          ...domainFact('group_shared', [sourceTurn.id], ['10001']),
          content: '变体内容仍试图复活已删除群记忆。',
        },
        extractionCandidate(unrelatedTurn.id),
      ],
      providerRoute: 'native_chat_json_schema',
      rawTextHash: 'safe-generation-replay',
      embeddingIdentity: null,
    })).resolves.toEqual({
      active: 1,
      pendingReview: 0,
      rejected: 1,
    });

    const forgottenHead = database.tables[MEMORY_LEDGER_TABLES.head]
      .find((row) => row.streamId === ingested.head.streamId);
    expect(forgottenHead).toMatchObject({
      state: 'forgotten',
      payloadId: null,
      contentHash: null,
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.payload]
      .some((row) => row.eventId === forgottenHead!.eventId)).toBe(false);
    expect(database.tables[MEMORY_LEDGER_TABLES.evidence]
      .some((row) => row.messageId === sourceTurn.id)).toBe(false);
    expect(database.tables[MEMORY_LEDGER_TABLES.embedding]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.fts]
      .some((row) => row.streamId === ingested.head.streamId)).toBe(false);
    expect(database.tables[MEMORY_LEDGER_TABLES.head]).toContainEqual(
      expect.objectContaining({
        assertionType: 'userAssertion',
        state: 'active',
      }),
    );
    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .filter((row) => row.status === 'pending'
        || row.status === 'leased'
        || row.status === 'deadLetter')).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.suppression]).toContainEqual(
      expect.objectContaining({
        subjectKey: null,
        contextKey: addressA.contextKey,
        streamId: null,
        sourceMessageDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it('prevents every user lane and replay variant from reviving a forgotten assistant commitment', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const audience = ['onebot:user:10001', 'onebot:user:10002'];
    const addressA = {
      ...groupAddress('assistant-forget', '10001'),
      conversationId: 'conversation:assistant-forget',
      currentAudienceSubjectKeys: audience,
      observedAt: 2_000,
    };
    const addressB = {
      ...addressA,
      userKey: 'onebot:user:10002',
      userId: '10002',
    };
    const requestTurn = {
      id: 'assistant-request',
      role: 'human' as const,
      text: '下周一提醒我提交材料。',
      speakerId: '10001',
      speakerName: '甲',
      ownerUserKey: addressA.userKey,
      isTarget: true,
      attributionSource: 'additional_kwargs' as const,
      parentId: null,
      occurredAt: 1_800,
    };
    const sourceTurn = {
      id: 'assistant-source',
      role: 'ai' as const,
      text: '我会在下周一提醒你提交材料。',
      speakerId: null,
      speakerName: 'QQBot',
      ownerUserKey: null,
      isTarget: false,
      attributionSource: 'assistant' as const,
      parentId: requestTurn.id,
      occurredAt: 1_900,
    };
    const domainInput = {
      address: addressA,
      content: '助手承诺在下周一提醒提交材料。',
      retrievalText: '助手承诺\n下周一\n提醒提交材料',
      evidenceMessageIds: [sourceTurn.id],
      capturedAudiences: [{
        messageId: requestTurn.id,
        observedAt: requestTurn.occurredAt,
        audienceSubjectKeys: audience,
      }],
      turns: [requestTurn, sourceTurn],
      sensitivity: 'low' as const,
      importance: 0.8,
      confidence: 0.95,
      embeddingIdentity: {
        canonicalModel: 'qqbot-siliconflow/Qwen3-Embedding-8B',
        modelRevision: 7,
      },
    };
    const ingested = await store.ingestAssistantCommitment(domainInput);
    database.tables.chatluna_conversation = [{
      id: addressA.conversationId,
      latestMessageId: 'assistant-anchor',
    }];
    for (const address of [addressA, addressB]) {
      await store.queueExtractWork({
        address,
        targetSpeakerId: address.userId,
        targetSpeakerName: null,
        maxMessages: 10,
        nextRunAt: 0,
      });
    }
    const leased = [
      await store.claimDueWork('extract', Date.now(), 60_000),
      await store.claimDueWork('extract', Date.now(), 60_000),
    ];
    expect(leased.every(Boolean)).toBe(true);

    await store.forget({
      actor: { userKey: 'admin', isDirect: false, isAdmin: true },
      streamId: ingested.head.streamId,
    });

    for (const claimed of leased) {
      const payload = store.parseWorkPayload<ExtractWorkPayload>(claimed!.work);
      await expect(store.finalizeExtraction({
        work: claimed!.work,
        leaseToken: claimed!.leaseToken,
        payload,
        turns: [requestTurn, sourceTurn],
        candidates: [domainFact('assistant', [sourceTurn.id], ['bot'])],
        providerRoute: 'native_chat_json_schema',
        rawTextHash: 'late-assistant-provider-result',
        embeddingIdentity: null,
      })).resolves.toEqual({
        active: 0,
        pendingReview: 0,
        rejected: 1,
      });
    }
    await expect(store.ingestAssistantCommitment({
      ...domainInput,
      content: '换一种措辞：助手会在周一进行提醒。',
      retrievalText: '助手提醒 周一 变体',
    })).rejects.toMatchObject({ code: 'memory_source_suppressed' });

    expect(database.tables[MEMORY_LEDGER_TABLES.head]).toEqual([
      expect.objectContaining({
        streamId: ingested.head.streamId,
        state: 'forgotten',
        payloadId: null,
        contentHash: null,
      }),
    ]);
    expect(database.tables[MEMORY_LEDGER_TABLES.payload]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.evidence]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.embedding]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.fts]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.work]
      .filter((row) => row.status === 'pending'
        || row.status === 'leased'
        || row.status === 'deadLetter')).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.suppression]).toContainEqual(
      expect.objectContaining({
        subjectKey: null,
        contextKey: addressA.contextKey,
        streamId: null,
        sourceMessageDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it('rolls back domain extraction and lease completion as one transaction', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const address = {
      ...groupAddress('group-a'),
      currentAudienceSubjectKeys: ['onebot:user:10001'],
    };
    database.tables.chatluna_conversation = [{
      id: address.conversationId,
      latestMessageId: 'G-rollback',
    }];
    await store.queueExtractWork({
      address,
      targetSpeakerId: address.userId,
      targetSpeakerName: '甲',
      maxMessages: 10,
      nextRunAt: 0,
    });
    const claimed = await store.claimDueWork('extract', Date.now(), 60_000);
    const payload = store.parseWorkPayload<ExtractWorkPayload>(claimed!.work);
    database.failOnCreateTable = MEMORY_LEDGER_TABLES.head;
    await expect(store.finalizeExtraction({
      work: claimed!.work,
      leaseToken: claimed!.leaseToken,
      payload,
      turns: [{
        id: 'G-rollback',
        role: 'human',
        text: '读书会固定在每周六。',
        speakerId: '10001',
        speakerName: '甲',
        ownerUserKey: 'onebot:user:10001',
        isTarget: true,
        attributionSource: 'additional_kwargs',
        parentId: null,
        occurredAt: 900,
      }],
      candidates: [domainFact('group_shared', ['G-rollback'], ['10001'])],
      providerRoute: 'native_chat_json_schema',
      rawTextHash: 'rollback',
      embeddingIdentity: null,
    })).rejects.toBeInstanceOf(MemoryRuntimeError);
    expect(database.tables[MEMORY_LEDGER_TABLES.event]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.payload]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.evidence]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.head]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.cursor]).toHaveLength(0);
    expect(database.tables[MEMORY_LEDGER_TABLES.work][0]).toMatchObject({
      status: 'leased',
      completedAt: null,
    });
  });

  it('ingests group artifacts through a deterministic group-owned lane', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const address = {
      ...groupAddress('group-a'),
      groupId: 'group-a',
      currentAudienceSubjectKeys: [
        'onebot:user:10001',
        'onebot:user:10002',
      ],
    };
    const turns = [
      {
        id: 'group-evidence-1',
        role: 'human' as const,
        text: '读书会固定在每周六。',
        speakerId: '10001',
        speakerName: '甲',
        ownerUserKey: 'onebot:user:10001',
        isTarget: true,
        attributionSource: 'additional_kwargs' as const,
        occurredAt: 900,
      },
      {
        id: 'group-evidence-2',
        role: 'human' as const,
        text: '确认，地点仍是图书馆。',
        speakerId: '10002',
        speakerName: '乙',
        ownerUserKey: 'onebot:user:10002',
        isTarget: false,
        attributionSource: 'additional_kwargs' as const,
        occurredAt: 910,
      },
    ];
    const input = {
      address,
      content: '群读书会固定于每周六在图书馆举行。',
      retrievalText: '群活动\n读书会\n每周六 图书馆',
      evidenceMessageIds: turns.map((turn) => turn.id),
      capturedAudiences: turns.map((turn) => ({
        messageId: turn.id,
        observedAt: turn.occurredAt,
        audienceSubjectKeys: address.currentAudienceSubjectKeys,
      })),
      turns,
      sensitivity: 'low' as const,
      importance: 0.8,
      confidence: 0.95,
    };

    const first = await store.ingestGroupArtifact(input);
    const duplicate = await store.ingestGroupArtifact(input);

    expect(duplicate).toMatchObject({
      laneKey: first.laneKey,
      workKey: first.workKey,
      idempotencyKey: first.idempotencyKey,
      head: { streamId: first.head.streamId },
    });
    expect(first.laneKey).toBe(
      'domain:groupArtifact:onebot:group:group-a:onebot:bot:bot:group:group-a',
    );
    expect(database.tables[MEMORY_LEDGER_TABLES.event]).toHaveLength(1);
    expect(database.tables[MEMORY_LEDGER_TABLES.head][0]).toMatchObject({
      assertionType: 'groupArtifact',
      subjectType: 'group',
      subjectKey: 'onebot:group:group-a',
      audiencePolicy: 'captureAudience',
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.evidence]).toHaveLength(2);
    expect(database.tables[MEMORY_LEDGER_TABLES.audit][0]).toMatchObject({
      workKey: first.workKey,
      eventType: 'assertion_activated',
    });
    expect(await store.listForContext(address, null)).toHaveLength(1);
    expect(await store.listForContext({
      ...address,
      currentAudienceSubjectKeys: [
        ...address.currentAudienceSubjectKeys,
        'onebot:user:10003',
      ],
    }, null)).toHaveLength(0);

    await expect(store.ingestGroupArtifact({
      ...input,
      evidenceMessageIds: ['untrusted-group-evidence'],
      turns: [{
        ...turns[0],
        id: 'untrusted-group-evidence',
        attributionSource: 'speaker_tag',
      }],
    })).rejects.toMatchObject({
      code: 'memory_group_artifact_evidence_untrusted',
    });
  });

  it('ingests assistant commitments only from assistant evidence', async () => {
    const database = new MemoryTestDatabase();
    seedSchema(database);
    const store = memoryStore(database);
    const address = directAddress();
    const requestTurn = {
      id: 'assistant-request-1',
      role: 'human' as const,
      text: '请在下周一提醒我提交材料。',
      speakerId: '10001',
      speakerName: 'Alice',
      ownerUserKey: address.userKey,
      isTarget: true,
      attributionSource: 'direct_session' as const,
      occurredAt: 900,
    };
    const assistantTurn = {
      id: 'assistant-evidence-1',
      role: 'ai' as const,
      text: '我会在下周一提醒你提交材料。',
      speakerId: null,
      speakerName: 'QQBot',
      ownerUserKey: null,
      isTarget: false,
      attributionSource: 'assistant' as const,
      parentId: requestTurn.id,
      occurredAt: 920,
    };
    const result = await store.ingestAssistantCommitment({
      address,
      content: '助手承诺在下周一提醒提交材料。',
      retrievalText: '助手承诺\n下周一\n提醒提交材料',
      evidenceMessageIds: [assistantTurn.id],
      capturedAudiences: [{
        messageId: requestTurn.id,
        observedAt: requestTurn.occurredAt,
        audienceSubjectKeys: address.currentAudienceSubjectKeys!,
      }],
      turns: [requestTurn, assistantTurn],
      sensitivity: 'low',
      importance: 0.7,
      confidence: 1,
    });

    expect(result.laneKey).toBe(
      'domain:assistantCommitment:onebot:bot:bot:onebot:bot:bot:dm:10001',
    );
    expect(database.tables[MEMORY_LEDGER_TABLES.head][0]).toMatchObject({
      assertionType: 'assistantCommitment',
      subjectType: 'assistant',
      subjectKey: 'onebot:bot:bot',
      audiencePolicy: 'sourceContext',
    });
    expect(database.tables[MEMORY_LEDGER_TABLES.evidence][0]).toMatchObject({
      speakerId: 'bot',
      messageId: assistantTurn.id,
    });
    expect(await store.listForContext(address, null)).toHaveLength(1);

    await expect(store.ingestAssistantCommitment({
      address,
      content: '伪造的助手承诺。',
      retrievalText: '伪造承诺',
      evidenceMessageIds: ['human-evidence'],
      capturedAudiences: [{
        messageId: requestTurn.id,
        observedAt: requestTurn.occurredAt,
        audienceSubjectKeys: address.currentAudienceSubjectKeys!,
      }],
      turns: [{
        ...assistantTurn,
        id: 'human-evidence',
        role: 'human',
        speakerId: '10001',
        ownerUserKey: 'onebot:user:10001',
        attributionSource: 'direct_session',
      }],
      sensitivity: 'low',
      importance: 0.5,
      confidence: 0.5,
    })).rejects.toMatchObject({
      code: 'memory_assistant_commitment_evidence_untrusted',
    });

    await expect(store.appendAssertion(assertion({
      assertionType: 'groupArtifact',
      subjectType: 'group',
      subjectKey: 'onebot:group:group-a',
    }))).rejects.toMatchObject({
      code: 'memory_user_assertion_domain_invalid',
    });
  });
});
