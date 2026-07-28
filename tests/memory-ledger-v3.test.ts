import { afterEach, describe, expect, it } from 'vitest';
import {
  MEMORY_LEDGER_TABLES,
} from '../src/plugins/memory/schema.js';
import type {
  MemoryV3EventRecord,
  MemoryV3HeadRecord,
  MemoryV3PayloadRecord,
} from '../src/types/memory.js';
import {
  assertion,
  closeMemoryV3TestRuntime,
  createMemoryV3TestRuntime,
  groupAddress,
  type MemoryV3TestRuntime,
} from './memory-v3-runtime.js';

const runtimes: MemoryV3TestRuntime[] = [];

async function runtime(): Promise<MemoryV3TestRuntime> {
  const value = await createMemoryV3TestRuntime();
  runtimes.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(closeMemoryV3TestRuntime));
});

describe('Memory Ledger V3', () => {
  it('deduplicates identical content and supersedes the same structured identity', async () => {
    const { store, database } = await runtime();
    const firstInput = assertion({ idempotencyKey: 'first' });
    const first = await store.appendAssertion(firstInput);
    const duplicate = await store.appendAssertion({
      ...firstInput,
      idempotencyKey: 'duplicate',
      evidence: assertion().evidence,
    });
    expect(duplicate.streamId).toBe(first.streamId);
    expect(duplicate.revision).toBe(1);

    const superseded = await store.appendAssertion({
      ...firstInput,
      idempotencyKey: 'changed',
      content: '小祥现在更喜欢爵士乐。',
      retrievalText: 'preference music 小祥现在更喜欢爵士乐',
      evidence: assertion().evidence,
    });
    expect(superseded.streamId).toBe(first.streamId);
    expect(superseded.revision).toBe(2);
    const events = await database.get(
      MEMORY_LEDGER_TABLES.event,
      { streamId: first.streamId },
    ) as MemoryV3EventRecord[];
    expect(events.map((event) => event.eventType)).toEqual(['asserted', 'superseded']);
    await expect(store.listForContext(
      groupAddress('group-a'),
      Date.now(),
      '爵士',
      8,
    )).resolves.toMatchObject([{ content: '小祥现在更喜欢爵士乐。' }]);
  });

  it('keeps conflicting candidates pending until an explicit review decision', async () => {
    const { store } = await runtime();
    const pending = await store.appendAssertion(assertion({
      idempotencyKey: 'pending',
      state: 'pendingReview',
      content: '小祥讨厌所有音乐。',
      retrievalText: 'trait music 小祥讨厌所有音乐',
    }));
    expect(pending.state).toBe('pendingReview');
    await expect(store.listForContext(
      groupAddress('group-a'),
      Date.now(),
      '音乐',
      8,
    )).resolves.toEqual([]);
    await store.review({
      streamId: pending.streamId,
      actor: { userKey: 'admin', isDirect: false, isAdmin: true },
      decision: 'approve',
    });
    await expect(store.listForContext(
      groupAddress('group-a'),
      Date.now(),
      '音乐',
      8,
    )).resolves.toHaveLength(1);
  });

  it('rolls back payload, head, event and lexical projection together', async () => {
    const { store, database } = await runtime();
    const originalCreate = database.create.bind(database);
    database.create = async (table, row) => {
      if (table === MEMORY_LEDGER_TABLES.evidence) {
        throw new Error('injected evidence failure');
      }
      return originalCreate(table, row);
    };
    await expect(store.appendAssertion(assertion())).rejects.toMatchObject({
      code: 'memory_transaction_failed',
    });
    for (const table of [
      MEMORY_LEDGER_TABLES.event,
      MEMORY_LEDGER_TABLES.payload,
      MEMORY_LEDGER_TABLES.evidence,
      MEMORY_LEDGER_TABLES.head,
      MEMORY_LEDGER_TABLES.lexicalDocument,
      MEMORY_LEDGER_TABLES.lexicalTerm,
    ]) {
      await expect(database.get(table, {})).resolves.toEqual([]);
    }
  });

  it('physically clears payload and evidence and leaves an irreversible suppression barrier', async () => {
    const { store, database } = await runtime();
    const head = await store.appendAssertion(assertion({ idempotencyKey: 'forget-me' }));
    const now = Date.now();
    await database.create(MEMORY_LEDGER_TABLES.work, {
      workKey: 'extract:forget-in-flight',
      workType: 'extract',
      status: 'pending',
      subjectKey: head.subjectKey,
      contextKey: head.sourceContextKey,
      streamId: null,
      laneKey: 'lane:forget-in-flight',
      payload: '{}',
      inputHash: 'forget-in-flight',
      targetRevision: null,
      deletionGeneration: head.deletionGeneration,
      retryCount: 0,
      nextRunAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorStage: null,
      upstreamStatus: null,
      providerCode: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    const claimed = await store.claimDueWork('extract', now, 60_000);
    expect(claimed).not.toBeNull();
    await expect(store.forget({
      actor: { userKey: 'admin', isDirect: false, isAdmin: true },
      streamId: head.streamId,
      reasonCode: 'operator-delete',
    })).resolves.toBe(1);

    const [forgotten] = await database.get(
      MEMORY_LEDGER_TABLES.head,
      { streamId: head.streamId },
    ) as MemoryV3HeadRecord[];
    expect(forgotten).toMatchObject({
      state: 'forgotten',
      payloadId: null,
      contentHash: null,
    });
    await expect(database.get(
      MEMORY_LEDGER_TABLES.payload,
      {},
    ) as Promise<MemoryV3PayloadRecord[]>).resolves.toEqual([]);
    await expect(database.get(MEMORY_LEDGER_TABLES.evidence, {})).resolves.toEqual([]);
    await expect(database.get(
      MEMORY_LEDGER_TABLES.suppression,
      { streamId: head.streamId },
    )).resolves.not.toHaveLength(0);
    await expect(store.listForContext(
      groupAddress('group-a'),
      Date.now(),
      '古典',
      8,
    )).resolves.toEqual([]);
    await expect(store.cancelWork(
      claimed!.work,
      claimed!.leaseToken,
      'late-worker',
    )).rejects.toMatchObject({ code: 'memory_lease_lost' });
  });

  it('allows exactly one concurrent worker to claim a work item', async () => {
    const { store, database } = await runtime();
    const now = Date.now();
    await database.create(MEMORY_LEDGER_TABLES.work, {
      workKey: 'extract:single-claim',
      workType: 'extract',
      status: 'pending',
      subjectKey: 'onebot:user:10001',
      contextKey: 'onebot:bot:bot:group:group-a',
      streamId: null,
      laneKey: 'lane:single-claim',
      payload: '{}',
      inputHash: 'single-claim',
      targetRevision: null,
      deletionGeneration: 0,
      retryCount: 0,
      nextRunAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorStage: null,
      upstreamStatus: null,
      providerCode: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    const claims = await Promise.all([
      store.claimDueWork('extract', now, 60_000),
      store.claimDueWork('extract', now, 60_000),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(new Set(
      claims.flatMap((claim) => claim ? [claim.leaseToken] : []),
    )).toHaveLength(1);
  });

  it('archives expired episodes and removes their lexical documents', async () => {
    const { store, database } = await runtime();
    const head = await store.appendAssertion(assertion({
      idempotencyKey: 'episode',
      assertionType: 'episode',
      kind: null,
      topicKey: 'event:concert',
      expiresAt: 2_000,
      createdAt: 1_000,
    }));
    await expect(store.archiveExpired(2_001)).resolves.toBe(1);
    await expect(database.get(
      MEMORY_LEDGER_TABLES.lexicalDocument,
      { streamId: head.streamId },
    )).resolves.toEqual([]);
  });

  it('rekeys identity when the subject promotes audience and rejects collisions', async () => {
    const { store, database } = await runtime();
    const global = await store.appendAssertion(assertion({
      idempotencyKey: 'global-identity',
      audiencePolicy: 'subjectAllContexts',
      content: '小祥长期喜欢爵士乐。',
      retrievalText: 'preference music 小祥长期喜欢爵士乐',
    }));
    const captured = await store.appendAssertion(assertion({
      idempotencyKey: 'captured-identity',
      content: '小祥在这个群喜欢古典音乐。',
      retrievalText: 'preference music 小祥在这个群喜欢古典音乐',
    }));
    expect(captured.memoryKey).not.toBe(global.memoryKey);

    await expect(store.promoteAudience({
      streamId: captured.streamId,
      actor: {
        userKey: captured.subjectKey,
        isDirect: true,
      },
      audiencePolicy: 'subjectAllContexts',
      audienceContextKeys: [],
      audienceSnapshots: {},
    })).rejects.toMatchObject({
      code: 'memory_promotion_identity_conflict',
    });

    const [unchanged] = await database.get(
      MEMORY_LEDGER_TABLES.head,
      { streamId: captured.streamId },
    ) as MemoryV3HeadRecord[];
    expect(unchanged?.memoryKey).toBe(captured.memoryKey);

    const independent = await store.appendAssertion(assertion({
      idempotencyKey: 'independent-identity',
      topicKey: 'food',
      content: '小祥喜欢巧克力。',
      retrievalText: 'preference food 小祥喜欢巧克力',
    }));
    await store.promoteAudience({
      streamId: independent.streamId,
      actor: {
        userKey: independent.subjectKey,
        isDirect: true,
      },
      audiencePolicy: 'subjectAllContexts',
      audienceContextKeys: [],
      audienceSnapshots: {},
    });
    const [promoted] = await database.get(
      MEMORY_LEDGER_TABLES.head,
      { streamId: independent.streamId },
    ) as MemoryV3HeadRecord[];
    expect(promoted?.memoryKey).not.toBe(independent.memoryKey);
    expect(promoted?.audiencePolicy).toBe('subjectAllContexts');
  });
});

describe('Memory V3 group privacy', () => {
  it('allows another group only when its complete current audience is a captured subset', async () => {
    const { store } = await runtime();
    await store.appendAssertion(assertion());
    await expect(store.listForContext(
      groupAddress('group-b', '10001', ['onebot:user:10001', 'onebot:user:10002']),
      Date.now(),
      '古典',
      8,
    )).resolves.toHaveLength(1);
    await expect(store.listForContext(
      groupAddress('group-new-member', '10001', [
        'onebot:user:10001',
        'onebot:user:10002',
        'onebot:user:10003',
      ]),
      Date.now(),
      '古典',
      8,
    )).resolves.toEqual([]);
  });

  it('rejects group reads when the memory subject is absent or sensitivity is not low', async () => {
    const { store } = await runtime();
    await store.appendAssertion(assertion());
    await store.appendAssertion(assertion({
      idempotencyKey: 'private',
      topicKey: 'private-topic',
      content: '小祥的私人信息。',
      retrievalText: 'private-topic 小祥的私人信息',
      sensitivity: 'personal',
    }));
    await expect(store.listForContext(
      groupAddress('group-b', '10002', ['onebot:user:10002']),
      Date.now(),
      '',
      8,
    )).resolves.toEqual([]);
    const visible = await store.listForContext(
      groupAddress('group-a'),
      Date.now(),
      '',
      8,
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]?.sensitivity).toBe('low');
  });

  it('keeps direct-only and source-context memories inside their authorized boundary', async () => {
    const { store } = await runtime();
    await store.appendAssertion(assertion({
      idempotencyKey: 'direct-only',
      topicKey: 'direct-only',
      content: '仅主体私聊可见。',
      retrievalText: 'direct-only 仅主体私聊可见',
      audiencePolicy: 'subjectPrivate',
      audienceContextKeys: ['onebot:bot:bot:dm:10001'],
      audienceSnapshots: {
        'onebot:bot:bot:dm:10001': ['onebot:user:10001'],
      },
    }));
    await store.appendAssertion(assertion({
      idempotencyKey: 'group-artifact',
      assertionType: 'groupArtifact',
      kind: 'plan',
      topicKey: 'group-plan',
      subjectType: 'group',
      subjectKey: 'onebot:group:group-a',
      actorKey: 'onebot:user:10001',
      content: '群 A 的公开计划。',
      retrievalText: 'group plan 群 A 的公开计划',
      audiencePolicy: 'sourceContext',
    }));

    await expect(store.listForContext(
      groupAddress('group-a'),
      Date.now(),
      '',
      8,
    )).resolves.toMatchObject([{ assertionType: 'groupArtifact' }]);
    await expect(store.listForContext(
      groupAddress('group-b'),
      Date.now(),
      '',
      8,
    )).resolves.toEqual([]);
  });
});
