import { describe, expect, it } from 'vitest';
import { formatUserStampedPrompt, injectUserStampedPrompt } from '../src/plugins/chat-time-context.js';
import { inferPlatformFromBaseUrl, normalizeRawModelName, resolvePlatform } from '../src/plugins/model-utils.js';

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

describe('normalizeRawModelName', () => {
  it('keeps provider/model unchanged', () => {
    expect(normalizeRawModelName('deepseek/deepseek-chat')).toBe('deepseek/deepseek-chat');
  });

  it('resolves plain model by available model suffix', () => {
    expect(
      normalizeRawModelName('deepseek-chat', {
        availableModels: ['deepseek/deepseek-chat', 'openai/gpt-4o-mini'],
      }),
    ).toBe('deepseek/deepseek-chat');
  });

  it('falls back to preferred platform when suffix is ambiguous', () => {
    expect(
      normalizeRawModelName('chat', {
        availableModels: ['deepseek/chat', 'openai/chat'],
        preferredPlatform: 'openai',
      }),
    ).toBe('openai/chat');
  });

  it('fills missing model with default model', () => {
    expect(
      normalizeRawModelName('', {
        defaultModel: 'deepseek/deepseek-chat',
      }),
    ).toBe('deepseek/deepseek-chat');
  });
});

describe('inferPlatformFromBaseUrl', () => {
  it('infers platform from base url', () => {
    expect(inferPlatformFromBaseUrl('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(inferPlatformFromBaseUrl('https://api.openai.com/v1')).toBe('openai');
    expect(inferPlatformFromBaseUrl('https://api.anthropic.com')).toBe('anthropic');
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

  it('injects prefix block for array content and preserves original blocks', () => {
    const now = Date.parse('2026-03-01T16:40:16+08:00');
    const output = injectUserStampedPrompt(
      [{ type: 'text', text: '你好' }],
      '小祥',
      now,
    ) as Array<{ type: string; text?: string }>;
    expect(output[0]).toEqual({ type: 'text', text: '小祥, 2026-03-01 16:40:16:' });
    expect(output[1]).toEqual({ type: 'text', text: '你好' });
  });

  it('keeps non-string non-array content unchanged', () => {
    const original = { type: 'tool', name: 'noop' };
    const output = injectUserStampedPrompt(original, '小祥');
    expect(output).toBe(original);
  });
});
