import { describe, expect, it } from 'vitest';
import { retrieveMemoryForContext } from '../src/plugins/memory/recall.js';
import { MemoryStore } from '../src/plugins/memory/store.js';
import type { MemoryAddress, MemoryCandidateRecord, MemoryFactRecord } from '../src/types/memory.js';

class MemoryDbMock {
  tables: Record<string, any[]> = {
    memory_user: [],
    memory_fact: [],
    memory_episode: [],
    memory_profile: [],
    memory_source: [],
    memory_candidate: [],
    memory_provenance: [],
    memory_job: [],
    memory_tombstone: [],
    memory_audit_event: [],
  };

  async get(table: string, query: Record<string, unknown>): Promise<any[]> {
    const rows = this.tables[table] ?? [];
    return rows.filter((row) => Object.entries(query).every(([key, value]) => row[key] === value));
  }

  async set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<void> {
    for (const row of await this.get(table, query)) Object.assign(row, data);
  }

  async create(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>> {
    const rows = this.tables[table] ?? (this.tables[table] = []);
    const created = { id: rows.length + 1, ...row };
    rows.push(created);
    return created;
  }

  async remove(table: string, query: Record<string, unknown>): Promise<void> {
    this.tables[table] = (this.tables[table] ?? []).filter((row) => !Object.entries(query).every(([key, value]) => row[key] === value));
  }
}

const directAddress: MemoryAddress = {
  userKey: 'onebot:user:10001',
  contextKey: 'onebot:bot:20001:dm:10001',
  channelType: 'direct',
  platform: 'onebot',
  botSelfId: '20001',
  userId: '10001',
  groupId: null,
  channelId: 'dm-1',
  rawContextId: '10001',
  conversationId: 'conv-dm',
  observedAt: 1,
};

const groupA: MemoryAddress = {
  ...directAddress,
  contextKey: 'onebot:bot:20001:group:g-a',
  channelType: 'group',
  groupId: 'g-a',
  channelId: 'g-a',
  rawContextId: 'g-a',
  conversationId: 'conv-a',
};

const groupB: MemoryAddress = {
  ...groupA,
  contextKey: 'onebot:bot:20001:group:g-b',
  groupId: 'g-b',
  channelId: 'g-b',
  rawContextId: 'g-b',
  conversationId: 'conv-b',
};

function candidate(
  id: number,
  address: MemoryAddress,
  content: string,
  finalVisibility: MemoryCandidateRecord['finalVisibility'],
): MemoryCandidateRecord {
  return {
    id,
    batchId: `batch-${id}`,
    candidateType: 'fact',
    ownerUserKey: address.userKey,
    contextKey: address.contextKey,
    conversationId: address.conversationId,
    targetSpeakerId: address.userId,
    targetSpeakerName: null,
    messageIds: `["m-${id}"]`,
    evidenceMessageIds: `["m-${id}"]`,
    evidenceSpeakerIds: `["${address.userId}"]`,
    attributionStatus: 'verified',
    payload: JSON.stringify({
      candidateType: 'fact',
      subject: 'target_user',
      ownerSpeakerId: address.userId,
      evidenceMessageIds: [`m-${id}`],
      evidenceSpeakerIds: [address.userId],
      kind: 'preference',
      topicKey: 'answer-style',
      content,
      keywords: ['回答风格'],
      importance: 0.9,
      confidence: 0.92,
      sensitivity: 'low',
      suggestedVisibility: finalVisibility ?? 'global',
    }),
    reviewStatus: 'approved',
    sensitivity: 'low',
    suggestedVisibility: finalVisibility ?? 'global',
    finalVisibility,
    dropReason: null,
    providerRoute: 'native_chat_json_schema',
    rawTextHash: null,
    createdAt: 1,
    reviewedAt: 2,
    consolidatedAt: null,
  };
}

function fact(overrides: Partial<MemoryFactRecord>): MemoryFactRecord {
  return {
    id: 1,
    ownerUserKey: groupA.userKey,
    kind: 'preference',
    topicKey: 'answer-style',
    content: '用户喜欢直接回答',
    keywords: '["回答风格"]',
    importance: 0.9,
    confidence: 0.9,
    sensitivity: 'low',
    visibility: 'global',
    scopeType: 'owner_all_contexts',
    scopeKey: null,
    memoryKey: 'legacy',
    sourceKind: 'direct',
    sourceContextKey: directAddress.contextKey,
    targetSpeakerId: '10001',
    targetSpeakerName: null,
    evidenceMessageIds: '["m-1"]',
    evidenceSpeakerIds: '["10001"]',
    attributionStatus: 'verified',
    allowedContextKeys: null,
    deniedContextKeys: null,
    applicability: null,
    validFrom: null,
    validUntil: null,
    expiresAt: null,
    invalidatedAt: null,
    retrievalText: null,
    lastUsedReason: null,
    firstSeenAt: 1,
    lastSeenAt: 10,
    lastAccessedAt: null,
    embeddingModel: null,
    embedding: null,
    version: 1,
    archived: 0,
    supersedesId: null,
    conflictSetId: null,
    ...overrides,
  };
}

describe('memory scoped memory behavior', () => {
  it('does not overwrite same-topic facts across dm and group scopes', async () => {
    const db = new MemoryDbMock();
    const store = new MemoryStore(db as any);

    await store.consolidateCandidate(candidate(1, directAddress, '用户在私聊里喜欢详细技术回答', 'global'), directAddress);
    await store.consolidateCandidate(candidate(2, groupA, '用户在 A 群里喜欢短一点的回答', 'source_context_only'), groupA);

    expect(db.tables.memory_fact).toHaveLength(2);
    expect(db.tables.memory_fact.map((row) => row.content)).toEqual(
      expect.arrayContaining(['用户在私聊里喜欢详细技术回答', '用户在 A 群里喜欢短一点的回答']),
    );
    expect(new Set(db.tables.memory_fact.map((row) => row.memoryKey)).size).toBe(2);
    expect(db.tables.memory_fact.find((row) => row.sourceContextKey === groupA.contextKey)).toMatchObject({
      scopeType: 'source_context_only',
      scopeKey: groupA.contextKey,
    });
  });

  it('recalls profile and scoped facts, excludes invalidated facts, and audits why detail', async () => {
    const db = new MemoryDbMock();
    db.tables.memory_profile.push({
      id: 12,
      ownerUserKey: groupA.userKey,
      profileKey: 'answer-style',
      kind: 'response_policy',
      content: '用户偏好直接、可落地的技术方案',
      valueJson: null,
      importance: 0.88,
      confidence: 0.91,
      sensitivity: 'low',
      scopeType: 'owner_all_contexts',
      scopeKey: null,
      sourceContextKey: directAddress.contextKey,
      targetSpeakerId: '10001',
      targetSpeakerName: null,
      evidenceMessageIds: '["m-profile"]',
      evidenceSpeakerIds: '["10001"]',
      attributionStatus: 'verified',
      allowedContextKeys: null,
      deniedContextKeys: null,
      validFrom: null,
      validUntil: null,
      expiresAt: null,
      firstSeenAt: 1,
      lastSeenAt: 10,
      lastAccessedAt: null,
      version: 1,
      archived: 0,
      supersedesId: null,
      conflictSetId: null,
    });
    db.tables.memory_fact.push(
      fact({ id: 31, content: '用户的 kbot 项目基于 Koishi + OneBot + ChatLuna', topicKey: 'kbot-stack' }),
      fact({
        id: 32,
        content: '用户已经不用旧记忆方案',
        topicKey: 'old-memory-plan',
        invalidatedAt: 9,
        validUntil: 9,
      }),
      fact({
        id: 33,
        content: '用户在 B 群说的回答风格',
        visibility: 'source_context_only',
        scopeType: 'source_context_only',
        scopeKey: groupB.contextKey,
        sourceContextKey: groupB.contextKey,
      }),
    );

    const result = await retrieveMemoryForContext(new MemoryStore(db as any), groupA, 'kbot 方案怎么写', {
      topK: 8,
      promptBudgetTokens: 1200,
      now: 100,
    });

    expect(result.prompt).toContain('<kbot_user_memory');
    expect(result.prompt).toContain('Profile:');
    expect(result.prompt).toContain('[P12] 用户偏好直接、可落地的技术方案');
    expect(result.prompt).toContain('[F31] 用户的 kbot 项目基于 Koishi + OneBot + ChatLuna');
    expect(result.prompt).not.toContain('旧记忆方案');
    expect(result.prompt).not.toContain('B 群');
    expect(db.tables.memory_audit_event.at(-1)).toMatchObject({
      eventType: 'recall_selected',
      userKey: groupA.userKey,
      contextKey: groupA.contextKey,
    });
    expect(JSON.parse(db.tables.memory_audit_event.at(-1).detail)).toMatchObject({
      profile: [expect.objectContaining({ id: 12, reason: 'profile:answer-style' })],
      facts: [expect.objectContaining({ id: 31 })],
      episodes: [],
    });
  });

  it('updates per-user read/write flags for pause and resume commands', async () => {
    const db = new MemoryDbMock();
    const store = new MemoryStore(db as any);
    await store.upsertAddress(directAddress);

    await store.setUserFlags(directAddress.userKey, { writeEnabled: false });
    expect(await store.getUserFlags(directAddress.userKey)).toEqual({ readEnabled: true, writeEnabled: false });

    await store.setUserFlags(directAddress.userKey, { readEnabled: false, writeEnabled: true });
    expect(await store.getUserFlags(directAddress.userKey)).toEqual({ readEnabled: false, writeEnabled: true });
  });

  it('upserts per-user QQ profile fields without disturbing flags', async () => {
    const db = new MemoryDbMock();
    const store = new MemoryStore(db as any);

    await store.upsertAddress(directAddress, {
      qqNick: '旧昵称',
      avatarUrl: 'https://q.qlogo.cn/headimg_dl?dst_uin=10001&spec=100',
      profileUpdatedAt: 1,
    });
    await store.setUserFlags(directAddress.userKey, { writeEnabled: false });
    await store.upsertAddress({ ...directAddress, observedAt: 20 }, {
      qqNick: '新昵称',
      avatarUrl: 'https://example.com/avatar.png',
      profileUpdatedAt: 20,
    });

    expect(db.tables.memory_user).toHaveLength(1);
    expect(db.tables.memory_user[0]).toMatchObject({
      userKey: directAddress.userKey,
      qqNick: '新昵称',
      avatarUrl: 'https://example.com/avatar.png',
      profileUpdatedAt: 20,
      lastSeenAt: 20,
      readEnabled: 1,
      writeEnabled: 0,
    });
  });
});
