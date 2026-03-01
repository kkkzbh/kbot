import { describe, expect, it } from 'vitest';
import {
  containsAlias,
  createEmptySpamState,
  DEFAULT_TRIGGER_ALIASES,
  parseAliasList,
  recordSpamMessage,
  shouldTriggerByRule,
} from '../src/plugins/group-natural-trigger-core.js';

describe('group natural trigger aliases', () => {
  it('parses alias list and falls back to defaults', () => {
    expect(parseAliasList('')).toEqual(DEFAULT_TRIGGER_ALIASES.map((item) => item.toLowerCase()));
    expect(parseAliasList('saki, SAKI, sakiko')).toEqual(['saki', 'sakiko']);
  });

  it('detects all required aliases in message content', () => {
    const aliases = parseAliasList('祥子,祥,丰川,丰川祥子,saki,saki酱,sakiko');
    const samples = ['祥子你怎么看', '祥，帮我看看', '丰川在吗', '丰川祥子', 'saki 在吗', 'Saki酱 来一下', 'sakiko帮我写'];

    for (const sample of samples) {
      expect(containsAlias(sample, aliases)).toBe(true);
    }
  });
});

describe('group natural trigger rules', () => {
  const aliases = parseAliasList('祥子,祥,丰川,丰川祥子,saki,saki酱,sakiko');

  it('triggers when likely talking to bot', () => {
    expect(shouldTriggerByRule('你能帮我总结这段话吗？', aliases, false)).toBe(true);
    expect(shouldTriggerByRule('帮我查一下今天的天气', aliases, false)).toBe(true);
    expect(shouldTriggerByRule('普通闲聊一下', aliases, false)).toBe(false);
  });

  it('triggers when quoted to bot', () => {
    expect(shouldTriggerByRule('收到，我补充一下', aliases, true)).toBe(true);
  });
});

describe('group natural trigger spam policy', () => {
  it('mutes user when receiving 10 messages within 10 seconds', () => {
    let state = createEmptySpamState();
    const base = Date.parse('2026-03-01T20:00:00+08:00');

    for (let i = 0; i < 9; i++) {
      const result = recordSpamMessage(state, base + i * 900, {
        windowMs: 10_000,
        threshold: 10,
        muteMs: 180_000,
      });
      state = result.state;
      expect(result.muted).toBe(false);
      expect(result.justMuted).toBe(false);
    }

    const hit = recordSpamMessage(state, base + 9 * 900, {
      windowMs: 10_000,
      threshold: 10,
      muteMs: 180_000,
    });

    expect(hit.muted).toBe(true);
    expect(hit.justMuted).toBe(true);
    expect(hit.state.mutedUntil).toBe(base + 9 * 900 + 180_000);
  });
});
