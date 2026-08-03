import { describe, expect, it } from 'vitest';

import {
  resolveStickerMatches,
  resolveStickerSelection,
  type LoadedStickerCatalog,
} from '../src/plugins/sticker/selection.js';

function createCatalog(): LoadedStickerCatalog {
  const entries = [
    {
      id: 'bored',
      file: 'images/personas/sakiko/bored.png',
      hash: 'hash-bored',
      mime: 'image/png',
      scopes: ['persona:sakiko'],
      caption: '银发二次元少女配六个省略号的无语表情包',
      keywords: ['省略号', '面无表情'],
      moods: ['无语', '茫然'],
      scenes: ['聊天互动'],
      historyLabel: '省略号无语少女',
      confidence: 0.95,
      buffer: Buffer.from('bored'),
    },
    {
      id: 'embarrassed',
      file: 'images/personas/sakiko/embarrassed.gif',
      hash: 'hash-embarrassed',
      mime: 'image/gif',
      scopes: ['persona:sakiko'],
      caption: '蓝发二次元少女愤怒噘嘴的表情包',
      keywords: ['生气表情', '噘嘴'],
      moods: ['愤怒', '气恼', '不满'],
      scenes: ['情绪表达'],
      historyLabel: '生气噘嘴少女',
      confidence: 0.94,
      buffer: Buffer.from('embarrassed'),
    },
    {
      id: 'cold',
      file: 'images/personas/sakiko/cold.png',
      hash: 'hash-cold',
      mime: 'image/png',
      scopes: ['persona:sakiko'],
      caption: '蓝发二次元校服少女举手表态我有意见的聊天表情包',
      keywords: ['我有意见', '举手发言'],
      moods: ['提出异议', '调侃吐槽'],
      scenes: ['线上聊天'],
      historyLabel: '举手提意见',
      confidence: 0.95,
      buffer: Buffer.from('cold'),
    },
  ];

  return {
    version: 1,
    generatedAt: '2026-03-16T00:00:00.000Z',
    model: 'doubao-seed-2-0-mini-260215',
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry])),
  };
}

describe('chatluna sticker core', () => {
  it('abstains when the natural-language intent has no semantic match', () => {
    expect(resolveStickerSelection(createCatalog(), '帮我算一下二次函数的导数', 'sakiko')).toBeNull();
  });

  it('maps narrow per-sticker intents to different sticker assets', () => {
    const catalog = createCatalog();

    expect(resolveStickerSelection(catalog, '无语地看对方一眼', 'sakiko')?.id).toBe('bored');
    expect(resolveStickerSelection(catalog, '生气地噘嘴表达不满', 'sakiko')?.id).toBe('embarrassed');
  });

  it('scores natural Chinese intent phrases against keyword fragments', () => {
    const catalog = createCatalog();

    expect(resolveStickerMatches(catalog, '冷淡一点、像在提意见的表情包', 'sakiko')[0]?.entry.id).toBe('cold');
    expect(resolveStickerMatches(catalog, '生气一点，像是在噘嘴表达不满', 'sakiko')[0]?.entry.id).toBe('embarrassed');
  });

  it('prefers an unused nearby match for multi-sticker delivery', () => {
    const catalog = createCatalog();

    expect(
      resolveStickerSelection(catalog, '连续发两张表情包，先无语，再生气', 'sakiko', {
        usedIds: new Set(['bored']),
      })?.id,
    ).toBe('embarrassed');
    expect(
      resolveStickerSelection(catalog, '无语地看对方一眼', 'sakiko', {
        usedIds: new Set(['bored']),
      })?.id,
    ).toBe('bored');
  });
});
