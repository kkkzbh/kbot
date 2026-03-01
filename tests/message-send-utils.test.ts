import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateSmartSendDelayMs,
  sendByLinesWithSmartInterval,
  splitMessageByLines,
} from '../src/plugins/message-send-utils.js';

describe('message send utils', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('splits multiline text and removes blank lines', () => {
    expect(splitMessageByLines('第一行\r\n\r\n第二行\n  \n第三行')).toEqual(['第一行', '第二行', '第三行']);
  });

  it('keeps smart delay within 1-4 seconds', () => {
    expect(calculateSmartSendDelayMs('好')).toBe(1000);
    const longLine = '这是一条很长很长很长很长很长很长很长很长很长很长很长很长的消息。';
    expect(calculateSmartSendDelayMs(longLine)).toBeLessThanOrEqual(4000);
    expect(calculateSmartSendDelayMs(longLine)).toBeGreaterThanOrEqual(1000);
  });

  it('sends lines sequentially with smart interval', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const sentAt: number[] = [];

    const pending = sendByLinesWithSmartInterval('第一句\n第二句', async (line) => {
      sent.push(line);
      sentAt.push(Date.now());
    });

    await vi.runAllTimersAsync();
    await pending;

    expect(sent).toEqual(['第一句', '第二句']);
    const delta = sentAt[1] - sentAt[0];
    expect(delta).toBeGreaterThanOrEqual(1000);
    expect(delta).toBeLessThanOrEqual(4000);
  });
});

