import { describe, expect, it } from 'vitest';
import {
  buildNaturalCreateFallbackReply,
  formatNaturalRunAtText,
  isValidCronExpr,
  normalizeGroupId,
  parseAutomationIntentByRule,
  parseGroupSet,
  parseOnceRunAt,
  selectDeliveryModelForTaskMessage,
  shouldPreferReasonerForTaskMessage,
  shouldTryAutomationIntent,
} from '../src/plugins/task-automation-core.js';

describe('task automation intent rule parsing', () => {
  it('detects list intent', () => {
    const intent = parseAutomationIntentByRule('查看我的任务列表');
    expect(intent).toEqual({ action: 'list', confidence: 0.98 });
  });

  it('detects delete intent with task id', () => {
    const intent = parseAutomationIntentByRule('删除任务 12');
    expect(intent).toEqual({ action: 'delete', confidence: 0.98, taskId: 12 });
  });

  it('parses once intent from relative time', () => {
    const base = new Date('2026-03-01T08:00:00+08:00').getTime();
    const intent = parseAutomationIntentByRule('30分钟后提醒我开会', base);
    expect(intent?.action).toBe('create-once');
    expect(intent?.runAt).toBe(base + 30 * 60 * 1000);
    expect(intent?.message).toBe('开会');
  });

  it('parses once intent from second-based relative time', () => {
    const base = new Date('2026-03-01T08:00:00+08:00').getTime();
    const intent = parseAutomationIntentByRule('10s后给我打招呼', base);
    expect(intent?.action).toBe('create-once');
    expect(intent?.runAt).toBe(base + 10 * 1000);
    expect(intent?.message).toBe('打招呼');
  });

  it('parses once intent from sentence-middle second-based expression', () => {
    const base = new Date('2026-03-01T08:00:00+08:00').getTime();
    const intent = parseAutomationIntentByRule('麻烦你在 10s 后给我打招呼', base);
    expect(intent?.action).toBe('create-once');
    expect(intent?.runAt).toBe(base + 10 * 1000);
    expect(intent?.message).toBe('打招呼');
  });

  it('parses once intent from plain clock plus delivery action', () => {
    const utc8OffsetMs = 8 * 60 * 60 * 1000;
    const now = Date.UTC(2026, 2, 1, 16, 36, 0, 0) - utc8OffsetMs;
    const intent = parseAutomationIntentByRule('16:38 给我发一条消息', now);
    expect(intent?.action).toBe('create-once');
    expect(intent?.runAt).toBe(Date.UTC(2026, 2, 1, 16, 38, 0, 0) - utc8OffsetMs);
    expect(intent?.message).toBe('发一条消息');
  });

  it('parses once intent from sentence-middle plain clock expression', () => {
    const utc8OffsetMs = 8 * 60 * 60 * 1000;
    const now = Date.UTC(2026, 2, 1, 16, 36, 0, 0) - utc8OffsetMs;
    const intent = parseAutomationIntentByRule('请帮我在16:38的时候给我发一条消息', now);
    expect(intent?.action).toBe('create-once');
    expect(intent?.runAt).toBe(Date.UTC(2026, 2, 1, 16, 38, 0, 0) - utc8OffsetMs);
    expect(intent?.message).toBe('发一条消息');
  });

  it('parses once intent from named relative offsets', () => {
    const base = new Date('2026-03-01T08:00:00+08:00').getTime();
    const halfHour = parseAutomationIntentByRule('半小时后提醒我喝水', base);
    const quarter = parseAutomationIntentByRule('一刻钟后提醒我休息', base);

    expect(halfHour?.action).toBe('create-once');
    expect(halfHour?.runAt).toBe(base + 30 * 60 * 1000);
    expect(quarter?.action).toBe('create-once');
    expect(quarter?.runAt).toBe(base + 15 * 60 * 1000);
  });

  it('does not trigger on plain status text containing only clock time', () => {
    const utc8OffsetMs = 8 * 60 * 60 * 1000;
    const now = Date.UTC(2026, 2, 1, 16, 36, 0, 0) - utc8OffsetMs;
    expect(parseAutomationIntentByRule('现在16:38了', now)).toBeNull();
  });

  it('does not trigger on weather question that only contains relative day words', () => {
    const base = new Date('2026-03-01T19:52:00+08:00').getTime();
    expect(parseAutomationIntentByRule('今天天气怎么样', base)).toBeNull();
  });

  it('parses cron intent from weekly expression', () => {
    const intent = parseAutomationIntentByRule('每周一早上9点提醒我交周报');
    expect(intent?.action).toBe('create-cron');
    expect(intent?.cronExpr).toBe('0 9 * * 1');
  });
});

describe('task automation helpers', () => {
  it('checks candidate text for automation intent', () => {
    expect(shouldTryAutomationIntent('明天提醒我拿快递')).toBe(true);
    expect(shouldTryAutomationIntent('10s后给我打招呼')).toBe(true);
    expect(shouldTryAutomationIntent('请在16:38给我发消息')).toBe(true);
    expect(shouldTryAutomationIntent('半小时后叫我开会')).toBe(true);
    expect(shouldTryAutomationIntent('今天天气怎么样')).toBe(false);
    expect(shouldTryAutomationIntent('天气不错')).toBe(false);
  });

  it('parses once runAt clock in future', () => {
    const utc8OffsetMs = 8 * 60 * 60 * 1000;
    const now = Date.UTC(2026, 2, 1, 8, 0, 0, 0) - utc8OffsetMs;
    const runAt = parseOnceRunAt('今天10:30提醒我喝水', now);
    expect(runAt).toBe(Date.UTC(2026, 2, 1, 10, 30, 0, 0) - utc8OffsetMs);
  });

  it('validates cron expression shape', () => {
    expect(isValidCronExpr('*/5 * * * *')).toBe(true);
    expect(isValidCronExpr('*/5 * * *')).toBe(false);
  });

  it('normalizes group id and parses group set', () => {
    expect(normalizeGroupId('group:123')).toBe('123');
    const groups = parseGroupSet('group:1, 2, guild:3');
    expect([...groups]).toEqual(['1', '2', '3']);
  });

  it('formats concise runAt text for same-day/tomorrow/day-after-tomorrow', () => {
    const base = Date.parse('2026-03-01T20:00:00+08:00');
    const sameDay = Date.parse('2026-03-01T22:30:00+08:00');
    const tomorrow = Date.parse('2026-03-02T09:15:00+08:00');
    const dayAfterTomorrow = Date.parse('2026-03-03T07:05:00+08:00');

    expect(formatNaturalRunAtText(sameDay, base)).toBe('22:30');
    expect(formatNaturalRunAtText(tomorrow, base)).toBe('明天09:15');
    expect(formatNaturalRunAtText(dayAfterTomorrow, base)).toBe('后天07:05');
  });

  it('uses concise time text in natural create fallback reply', () => {
    const base = Date.parse('2026-03-01T20:00:00+08:00');
    const tomorrow = Date.parse('2026-03-02T09:15:00+08:00');
    const reply = buildNaturalCreateFallbackReply(
      {
        kind: 'once',
        runAt: tomorrow,
        message: '交周报',
      },
      base,
    );
    expect(reply).toBe('好，我记住了。到 明天09:15 我会提醒你：交周报');
  });

  it('prefers reasoner model for complex task messages', () => {
    expect(shouldPreferReasonerForTaskMessage('帮我分析一下这段周报并给出优化方案')).toBe(true);
    expect(shouldPreferReasonerForTaskMessage('晚上好')).toBe(false);
    expect(selectDeliveryModelForTaskMessage('晚上好', 'deepseek-reasoner', 'deepseek-chat')).toBe('deepseek-chat');
    expect(selectDeliveryModelForTaskMessage('帮我分析一下并给出优化方案', 'deepseek-reasoner', 'deepseek-chat')).toBe(
      'deepseek-reasoner',
    );
  });
});
