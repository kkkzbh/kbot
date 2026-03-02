import { describe, expect, it } from 'vitest';
import { formatUserStampedPrompt, injectUserStampedPrompt } from '../src/plugins/chat-time-context.js';
import { inferPlatformFromBaseUrl, normalizeRawModelName, resolvePlatform } from '../src/plugins/model-utils.js';
import { resolveSessionDisplayName } from '../src/plugins/session-user-name.js';

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

  it('uses group card (群名片) when non-empty for group message identification', () => {
    const now = Date.parse('2026-03-01T16:40:16+08:00');
    // Simulates: session.author.nick = '群里的小明' (group card), session.username = '平台昵称'
    const groupNick = '群里的小明';
    const output = formatUserStampedPrompt(groupNick, '今天天气怎么样', now);
    expect(output).toBe('群里的小明, 2026-03-01 16:40:16: 今天天气怎么样');
  });

  it('resolves group nickname with || fallback chain (handles empty string)', () => {
    // Group card (群名片) takes priority
    expect(
      resolveSessionDisplayName({
        author: { nick: '群内昵称', name: 'QQ昵称' },
        username: '平台昵称',
        userId: '123456',
      }),
    ).toBe('群内昵称');
    // Empty group card falls back to username
    expect(
      resolveSessionDisplayName({
        author: { nick: '', name: 'QQ昵称' },
        username: '平台昵称',
        userId: '123456',
      }),
    ).toBe('平台昵称');
    // Whitespace-only group card falls back to username
    expect(
      resolveSessionDisplayName({
        author: { nick: '  ', name: 'QQ昵称' },
        username: '平台昵称',
        userId: '123456',
      }),
    ).toBe('平台昵称');
    // Missing group card falls back through chain
    expect(
      resolveSessionDisplayName({
        author: { name: 'QQ昵称' },
        username: '',
        userId: '123456',
      }),
    ).toBe('QQ昵称');
    // All empty falls back to userId
    expect(
      resolveSessionDisplayName({
        author: { name: '' },
        username: '',
        userId: '123456',
      }),
    ).toBe('123456');
    // Everything missing falls back to '用户'
    expect(
      resolveSessionDisplayName({
        author: { name: '' },
        username: '',
        userId: '',
      }),
    ).toBe('用户');
  });

  it('injects prefix using resolved group display name from production path', () => {
    const now = Date.parse('2026-03-01T16:40:16+08:00');
    const userName = resolveSessionDisplayName({
      author: { nick: '群里的小明', name: 'QQ昵称' },
      username: '平台昵称',
      userId: '123456',
    });
    const output = injectUserStampedPrompt('今天天气怎么样', userName, now);
    expect(output).toBe('群里的小明, 2026-03-01 16:40:16: 今天天气怎么样');
  });
});
