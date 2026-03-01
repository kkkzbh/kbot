import { describe, expect, it } from 'vitest';
import {
  isValidCronExpr,
  normalizeGroupId,
  parseAutomationIntentByRule,
  parseGroupSet,
  parseOnceRunAt,
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

  it('parses cron intent from weekly expression', () => {
    const intent = parseAutomationIntentByRule('每周一早上9点提醒我交周报');
    expect(intent?.action).toBe('create-cron');
    expect(intent?.cronExpr).toBe('0 9 * * 1');
  });
});

describe('task automation helpers', () => {
  it('checks candidate text for automation intent', () => {
    expect(shouldTryAutomationIntent('明天提醒我拿快递')).toBe(true);
    expect(shouldTryAutomationIntent('天气不错')).toBe(false);
  });

  it('parses once runAt clock in future', () => {
    const now = new Date('2026-03-01T08:00:00+08:00').getTime();
    const runAt = parseOnceRunAt('今天10:30提醒我喝水', now);
    expect(runAt).toBe(new Date('2026-03-01T10:30:00+08:00').getTime());
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
});
