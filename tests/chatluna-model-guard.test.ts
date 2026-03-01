import { describe, expect, it } from 'vitest';
import { formatUserStampedPrompt, injectUserStampedPrompt } from '../src/plugins/chat-time-context.js';
import { resolvePlatform } from '../src/plugins/model-utils.js';

describe('resolvePlatform', () => {
  it('returns platform from provider/model format', () => {
    expect(resolvePlatform('deepseek/deepseek-chat')).toBe('deepseek');
  });

  it('returns null for invalid model values', () => {
    expect(resolvePlatform(undefined)).toBeNull();
    expect(resolvePlatform('')).toBeNull();
    expect(resolvePlatform('   ')).toBeNull();
    expect(resolvePlatform('deepseek')).toBeNull();
    expect(resolvePlatform('/deepseek-chat')).toBeNull();
  });
});

describe('chatluna user+time prompt injection', () => {
  it('formats username and utc+8 timestamp as prompt prefix', () => {
    const now = Date.parse('2026-03-01T16:40:16+08:00');
    const output = formatUserStampedPrompt('小祥', '现在几点了', now);
    expect(output).toBe('小祥, 2026-03-01 16:40:16: 现在几点了');
  });

  it('injects formatted prefix for generic string content', () => {
    const now = Date.parse('2026-03-01T16:40:16+08:00');
    const output = injectUserStampedPrompt('随便聊聊', '小祥', now);
    expect(output).toBe('小祥, 2026-03-01 16:40:16: 随便聊聊');
  });
});
