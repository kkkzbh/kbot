/**
 * @deprecated 旧版 group-chat 链路的测试。
 * 该文件仅保留用于回滚/参考。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  GroupInFlightLimiter,
  MemoryConversationStore,
  UserCooldownTracker,
  decideChatPolicy,
  extractMentionText,
  normalizeModelContent,
  resolveSystemPrompt,
  trimConversation,
} from '../src/plugins/group-chat-core.js';
import type { OpenAIMessage } from '../src/types/chat.js';

describe('extractMentionText', () => {
  it('parses CQ mention format', () => {
    expect(extractMentionText('[CQ:at,qq=123456] 你好', '123456')).toBe('你好');
  });

  it('parses CQ mention id field', () => {
    expect(extractMentionText('[CQ:at,id=123456] hello', '123456')).toBe('hello');
  });

  it('returns null for unsupported mention syntax', () => {
    expect(extractMentionText('<at id="123456"/> hello', '123456')).toBeNull();
  });

  it('returns null when no mention', () => {
    expect(extractMentionText('hello', '123456')).toBeNull();
  });
});

describe('trimConversation', () => {
  it('keeps latest maxContextTurns * 2 messages', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: '1' },
      { role: 'assistant', content: '2' },
      { role: 'user', content: '3' },
      { role: 'assistant', content: '4' },
      { role: 'user', content: '5' },
      { role: 'assistant', content: '6' },
    ];

    expect(trimConversation(messages, 2)).toEqual([
      { role: 'user', content: '3' },
      { role: 'assistant', content: '4' },
      { role: 'user', content: '5' },
      { role: 'assistant', content: '6' },
    ]);
  });
});

describe('MemoryConversationStore', () => {
  it('expires stale context by ttl', () => {
    const store = new MemoryConversationStore();
    const key = '10001:20001';

    store.set(key, [{ role: 'user', content: 'hello' }], 1000);
    expect(store.get(key, 1000 + 60_000, 20 * 60_000)).toHaveLength(1);
    expect(store.get(key, 1000 + 21 * 60_000, 20 * 60_000)).toHaveLength(0);
  });
});

describe('UserCooldownTracker', () => {
  it('enforces cooldown per user key', () => {
    const tracker = new UserCooldownTracker();

    expect(tracker.checkAndTouch('group:user', 1000, 8000).allowed).toBe(true);
    const blocked = tracker.checkAndTouch('group:user', 3000, 8000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(6000);
    expect(tracker.checkAndTouch('group:user', 9001, 8000).allowed).toBe(true);
  });
});

describe('GroupInFlightLimiter', () => {
  it('limits per-group in-flight requests', () => {
    const limiter = new GroupInFlightLimiter();

    expect(limiter.tryAcquire('10001', 1)).toBe(true);
    expect(limiter.tryAcquire('10001', 1)).toBe(false);
    limiter.release('10001');
    expect(limiter.tryAcquire('10001', 1)).toBe(true);
  });
});

describe('decideChatPolicy', () => {
  const groups = new Set(['10001']);

  it('rejects non-whitelisted groups', () => {
    expect(
      decideChatPolicy({
        groupId: '10002',
        mentionText: 'hi',
        enabledGroups: groups,
        cooldownResult: { allowed: true },
        acquiredGroupSlot: true,
      }),
    ).toEqual({ allowed: false, reason: 'group-not-enabled' });
  });

  it('rejects non-mention triggers', () => {
    expect(
      decideChatPolicy({
        groupId: '10001',
        mentionText: null,
        enabledGroups: groups,
        cooldownResult: { allowed: true },
        acquiredGroupSlot: true,
      }),
    ).toEqual({ allowed: false, reason: 'not-mention-trigger' });
  });

  it('returns cooldown status', () => {
    expect(
      decideChatPolicy({
        groupId: '10001',
        mentionText: 'hello',
        enabledGroups: groups,
        cooldownResult: { allowed: false, retryAfterMs: 5000 },
        acquiredGroupSlot: true,
      }),
    ).toEqual({ allowed: false, reason: 'cooldown', retryAfterMs: 5000 });
  });

  it('allows when optional cooldown and slot checks are omitted', () => {
    expect(
      decideChatPolicy({
        groupId: '10001',
        mentionText: 'hello',
        enabledGroups: groups,
      }),
    ).toEqual({ allowed: true, reason: 'ok' });
  });
});

describe('normalizeModelContent', () => {
  it('normalizes string response', () => {
    expect(normalizeModelContent(' hello ')).toBe('hello');
  });

  it('normalizes array response', () => {
    expect(normalizeModelContent([{ text: 'hello' }, { text: ' world' }])).toBe('hello world');
  });
});

describe('resolveSystemPrompt', () => {
  it('uses prompt file when configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-prompt-'));
    const promptFile = join(dir, 'prompt.md');

    writeFileSync(promptFile, '你是测试助手。\n请多行输出。\n', 'utf8');

    expect(
      resolveSystemPrompt({
        systemPrompt: 'inline prompt should be ignored',
        systemPromptFile: promptFile,
      }),
    ).toBe('你是测试助手。\n请多行输出。');

    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to inline prompt when file is not configured', () => {
    expect(resolveSystemPrompt({ systemPrompt: 'inline prompt' })).toBe('inline prompt');
  });

  it('throws when configured prompt file is missing', () => {
    expect(() => resolveSystemPrompt({ systemPromptFile: '/tmp/not-exists-prompt.md' })).toThrow(
      /Failed to load system prompt file/,
    );
  });
});
