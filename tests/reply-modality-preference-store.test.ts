import { describe, expect, it, vi } from 'vitest';

import {
  MODALITY_PREFERENCE_TABLE,
  ModalityPreferenceStore,
  parsePersistentModalityPreference,
  registerModalityPreferenceTable,
  type ModalityPreferenceDatabase,
  type ModalityPreferenceRecord,
  type ModalityPreferenceScope,
} from '../src/plugins/reply/modality/preference-store.js';

function scope(overrides: Partial<ModalityPreferenceScope> = {}): ModalityPreferenceScope {
  return {
    platform: 'onebot',
    botSelfId: 'bot-1',
    userId: 'user-1',
    conversationId: 'conversation-1',
    ...overrides,
  };
}

function createDatabase(): ModalityPreferenceDatabase & {
  records: Map<string, ModalityPreferenceRecord>;
  upsert: ReturnType<typeof vi.fn>;
} {
  const records = new Map<string, ModalityPreferenceRecord>();
  const keyOf = (value: ModalityPreferenceScope) => [
    value.platform,
    value.botSelfId,
    value.userId,
    value.conversationId,
  ].join('\u0000');
  const upsert = vi.fn(async (
    table: typeof MODALITY_PREFERENCE_TABLE,
    rows: ModalityPreferenceRecord[],
  ) => {
    expect(table).toBe(MODALITY_PREFERENCE_TABLE);
    for (const row of rows) records.set(keyOf(row), { ...row });
  });

  return {
    records,
    get: async (table, query) => {
      expect(table).toBe(MODALITY_PREFERENCE_TABLE);
      const record = records.get(keyOf(query));
      return record ? [{ ...record }] : [];
    },
    upsert,
  };
}

describe('modality preference store', () => {
  it('registers one row per bot, user, and conversation', () => {
    const extend = vi.fn();

    registerModalityPreferenceTable({ extend });

    expect(extend).toHaveBeenCalledWith(
      MODALITY_PREFERENCE_TABLE,
      expect.objectContaining({
        voiceAutomatic: 'boolean',
        stickerAutomatic: 'boolean',
      }),
      expect.objectContaining({
        primary: ['platform', 'botSelfId', 'userId', 'conversationId'],
      }),
    );
  });

  it('parses only complete future directive clauses', () => {
    const accepted: Array<[string, ReturnType<typeof parsePersistentModalityPreference>]> = [
      ['以后别发语音', { voiceAutomatic: false }],
      ['以后少发点表情包', { stickerAutomatic: false }],
      ['今后可以继续发语音', { voiceAutomatic: true }],
      ['往后表情包可以正常发', { stickerAutomatic: true }],
      ['以后不要再给我发语音和表情包', {
        voiceAutomatic: false,
        stickerAutomatic: false,
      }],
      ['以后可以继续发语音和表情包', {
        voiceAutomatic: true,
        stickerAutomatic: true,
      }],
      ['麻烦以后语音和表情包都别发了！', {
        voiceAutomatic: false,
        stickerAutomatic: false,
      }],
      ['以后别发语音，也可以发表情包', {
        voiceAutomatic: false,
        stickerAutomatic: true,
      }],
    ];
    for (const [text, expected] of accepted) {
      expect(parsePersistentModalityPreference(text), text).toEqual(expected);
    }

    const rejected = [
      '这次别发语音',
      '以后研究一下语音消息怎么发',
      '以后帮我找表情包制作教程',
      '“以后别发语音”这句话是什么意思',
      '以后别发语音这句话是什么意思',
      '我没有说以后别发语音',
      '以后可以继续发语音吗？',
      '以后别发语音，这句话是什么意思',
      '以后别发语音，也可以发语音',
    ];
    for (const text of rejected) {
      expect(parsePersistentModalityPreference(text), text).toEqual({});
    }
  });

  it('persists a preference only for the addressed user and conversation', async () => {
    const database = createDatabase();
    const store = new ModalityPreferenceStore(database, () => 1_234);

    await expect(store.resolveForTurn(scope(), '以后别发语音')).resolves.toEqual({
      voiceAutomatic: false,
      stickerAutomatic: true,
    });
    await expect(store.load(scope())).resolves.toEqual({
      voiceAutomatic: false,
      stickerAutomatic: true,
    });
    await expect(store.load(scope({ userId: 'user-2' }))).resolves.toEqual({
      voiceAutomatic: true,
      stickerAutomatic: true,
    });
    await expect(store.load(scope({ conversationId: 'conversation-2' }))).resolves.toEqual({
      voiceAutomatic: true,
      stickerAutomatic: true,
    });
    expect([...database.records.values()]).toEqual([
      expect.objectContaining({
        ...scope(),
        voiceAutomatic: false,
        stickerAutomatic: true,
        updatedAt: 1_234,
      }),
    ]);
  });

  it('updates coordinated preferences and skips writes without a state change', async () => {
    const database = createDatabase();
    const store = new ModalityPreferenceStore(database, () => 2_000);

    await expect(store.resolveForTurn(
      scope(),
      '以后不要再给我发语音和表情包',
    )).resolves.toEqual({
      voiceAutomatic: false,
      stickerAutomatic: false,
    });
    expect(database.upsert).toHaveBeenCalledTimes(1);

    await store.resolveForTurn(scope(), '以后不要发语音和表情包');
    expect(database.upsert).toHaveBeenCalledTimes(1);

    await expect(store.resolveForTurn(
      scope(),
      '以后可以继续发语音和表情包',
    )).resolves.toEqual({
      voiceAutomatic: true,
      stickerAutomatic: true,
    });
    expect(database.upsert).toHaveBeenCalledTimes(2);
  });

  it('does not persist current-turn, quoted, or denied directives', async () => {
    const database = createDatabase();
    const store = new ModalityPreferenceStore(database);

    for (const input of [
      '这次别发表情包',
      '“以后别发语音”这句话是什么意思',
      '我没有说以后别发语音',
    ]) {
      await expect(store.resolveForTurn(scope(), input)).resolves.toEqual({
        voiceAutomatic: true,
        stickerAutomatic: true,
      });
    }
    expect(database.upsert).not.toHaveBeenCalled();
  });
});
