import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => {
  const parseAttrs = (input: string) => {
    const attrs: Record<string, string> = {};
    for (const matched of input.matchAll(/(\w+)="([^"]*)"/g)) {
      attrs[matched[1]] = matched[2];
    }
    return attrs;
  };

  const parse = (content: string) => {
    const elements: Array<{ type: string; attrs: Record<string, string>; children: never[] }> = [];
    const pattern = /<(audio|at)\b([\s\S]*?)\/>/gi;
    let lastIndex = 0;
    let matched: RegExpExecArray | null;

    while ((matched = pattern.exec(content))) {
      const text = content.slice(lastIndex, matched.index);
      if (text) {
        elements.push({ type: 'text', attrs: { content: text }, children: [] });
      }
      elements.push({ type: matched[1], attrs: parseAttrs(matched[2] ?? ''), children: [] });
      lastIndex = pattern.lastIndex;
    }

    const tail = content.slice(lastIndex);
    if (tail) {
      elements.push({ type: 'text', attrs: { content: tail }, children: [] });
    }

    return elements;
  };

  return {
    h: { parse },
  };
});
import {
  buildGroupScopeKey,
  buildRealtimeEntryKind,
  parseFlexibleTimestamp,
  queryRealtimeMessageEntries,
  realtimeMessageCache,
  discardRealtimeMessageForSession,
  selectRealtimeMessageWindow,
} from '../src/plugins/realtime-message/cache.js';
import {
  buildRealtimeMessageFallbackContent,
  toRealtimeHistoryMessage,
} from '../src/plugins/realtime-message/media.js';
import type { RealtimeMessageEntry } from '../src/plugins/realtime-message/types.js';

function createEntry(overrides: Partial<RealtimeMessageEntry> = {}): RealtimeMessageEntry {
  return {
    messageId: 'msg-1',
    groupScopeKey: 'onebot:bot-1:group:100',
    userId: 'u1',
    speakerName: '用户1',
    capturedAt: Date.parse('2026-04-05T12:00:00+08:00'),
    modalities: ['text'],
    text: '普通文本',
    imageUrls: [],
    voiceTranscript: null,
    sessionSnapshot: {
      platform: 'onebot',
      isDirect: false,
      guildId: '100',
      channelId: '100',
      userId: 'u1',
      messageId: 'msg-1',
      content: '普通文本',
      stripped: { content: '普通文本' },
      bot: { selfId: 'bot-1' },
      elements: [],
    },
    ...overrides,
  };
}

afterEach(() => {
  realtimeMessageCache.clear();
});

describe('realtime message cache helpers', () => {
  it('builds structured fallback content for image messages instead of placeholders', () => {
    const entry = createEntry({
      text: '帮我看下',
      modalities: ['text', 'image'],
      imageUrls: ['https://example.com/cache.png'],
    });

    expect(buildRealtimeMessageFallbackContent(entry)).toEqual([
      { type: 'text', text: '帮我看下' },
      { type: 'image_url', image_url: { url: 'https://example.com/cache.png' } },
    ]);
  });

  it('formats multimodal history messages with a speaker tag prefix', () => {
    const entry = createEntry({
      userId: 'u9',
      speakerName: '图图',
      modalities: ['image'],
      text: '',
      imageUrls: ['https://example.com/3.png'],
    });

    expect(
      toRealtimeHistoryMessage(entry, {
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/3.png' } }],
      }),
    ).toMatchObject({
      id: 'u9',
      content: [
        { type: 'text', text: '[speaker_id=u9 speaker_name="图图"]' },
        { type: 'image_url', image_url: { url: 'https://example.com/3.png' } },
      ],
    });
  });

  it('selects the latest inject window and excludes the current trigger message', () => {
    const entries = [
      createEntry({ messageId: 'msg-1', userId: 'u1', speakerName: '甲', text: '一' }),
      createEntry({ messageId: 'msg-2', userId: 'u2', speakerName: '乙', text: '二' }),
      createEntry({ messageId: 'msg-3', userId: 'u3', speakerName: '丙', text: '三' }),
      createEntry({ messageId: 'msg-4', userId: 'u4', speakerName: '丁', text: '四' }),
    ];

    expect(
      selectRealtimeMessageWindow(entries, {
        platform: 'onebot',
        isDirect: false,
        guildId: '100',
        channelId: '100',
        userId: 'u4',
        messageId: 'msg-4',
        content: '四',
        stripped: { content: '四' },
        bot: { selfId: 'bot-1' },
      }, 2).map((entry) => entry.messageId),
    ).toEqual(['msg-2', 'msg-3']);
  });

  it('discards a feature command after another history owner commits it', () => {
    const entry = createEntry({ messageId: 'feature-msg', text: '教务' });
    realtimeMessageCache.append(entry.groupScopeKey, entry);
    const session = {
      ...entry.sessionSnapshot,
      messageId: 'feature-msg',
      content: '教务',
      stripped: { content: '教务' },
    };

    expect(discardRealtimeMessageForSession(session)).toBe(true);
    expect(realtimeMessageCache.get(entry.groupScopeKey)).toEqual([]);
    expect(discardRealtimeMessageForSession(session)).toBe(false);
  });

  it('requires complete group session identity for cache scope keys', () => {
    expect(buildGroupScopeKey({
      platform: 'onebot',
      bot: { selfId: 'bot-1' },
      guildId: '100',
      channelId: '100',
      isDirect: false,
    })).toBe('onebot:bot-1:group:100');
    expect(buildGroupScopeKey({
      platform: '',
      bot: { selfId: 'bot-1' },
      guildId: '100',
      isDirect: false,
    })).toBeNull();
    expect(buildGroupScopeKey({
      platform: 'onebot',
      bot: { selfId: '' },
      guildId: '100',
      isDirect: false,
    })).toBeNull();
  });

  it('filters cached entries by order, modality, keyword, speaker, and time', () => {
    const entries = [
      createEntry({
        messageId: 'msg-1',
        userId: 'u1',
        speakerName: '甲',
        text: '今天吃什么',
        capturedAt: Date.parse('2026-04-05T10:00:00+08:00'),
      }),
      createEntry({
        messageId: 'msg-2',
        userId: 'u2',
        speakerName: '乙',
        text: '',
        modalities: ['image'],
        imageUrls: ['https://example.com/2.png'],
        capturedAt: Date.parse('2026-04-05T10:05:00+08:00'),
      }),
      createEntry({
        messageId: 'msg-3',
        userId: 'u1',
        speakerName: '甲',
        text: '补充说明',
        voiceTranscript: '语音转写',
        modalities: ['text', 'voice'],
        capturedAt: Date.parse('2026-04-05T10:10:00+08:00'),
      }),
    ];

    expect(buildRealtimeEntryKind(entries[0])).toBe('text');
    expect(buildRealtimeEntryKind(entries[1])).toBe('image');
    expect(buildRealtimeEntryKind(entries[2])).toBe('mixed');

    const result = queryRealtimeMessageEntries(entries, {
      limit: 10,
      offset: 0,
      order: 'latest_first',
      speakerIds: ['u1'],
      keyword: '语音',
      since: parseFlexibleTimestamp('2026-04-05T10:00:00+08:00'),
      until: parseFlexibleTimestamp('2026-04-05T10:30:00+08:00'),
      modality: 'mixed',
    });

    expect(result.total).toBe(1);
    expect(result.items.map((entry) => entry.messageId)).toEqual(['msg-3']);
  });

  it('builds group scope keys only for group sessions', () => {
    expect(buildGroupScopeKey({
      platform: 'onebot',
      bot: { selfId: 'bot-1' },
      guildId: '100',
      channelId: '100',
      isDirect: false,
    })).toBe('onebot:bot-1:group:100');

    expect(buildGroupScopeKey({
      platform: 'onebot',
      bot: { selfId: 'bot-1' },
      channelId: 'private-u1',
      isDirect: true,
    })).toBeNull();
  });
});
