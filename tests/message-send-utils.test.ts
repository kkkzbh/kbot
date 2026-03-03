import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateSmartSendDelayMs,
  createKeyedStrandRunner,
  resolveSessionStrandKey,
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

  it('runs same-key tasks in strict order', async () => {
    const strand = createKeyedStrandRunner();
    const events: string[] = [];
    let releaseFirst: () => void = () => {};

    const first = strand.run('room-1', async () => {
      events.push('first-start');
      await new Promise<void>((resolve) => {
        releaseFirst = () => resolve();
      });
      events.push('first-end');
    });

    const second = strand.run('room-1', async () => {
      events.push('second-start');
      events.push('second-end');
    });

    await Promise.resolve();
    expect(events).toEqual(['first-start']);

    releaseFirst();
    await first;
    await second;

    expect(events).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });

  it('allows different keys to run independently', async () => {
    const strand = createKeyedStrandRunner();
    const events: string[] = [];
    let releaseFirst: () => void = () => {};

    const first = strand.run('room-1', async () => {
      events.push('room-1-start');
      await new Promise<void>((resolve) => {
        releaseFirst = () => resolve();
      });
      events.push('room-1-end');
    });

    const second = strand.run('room-2', async () => {
      events.push('room-2-start');
      events.push('room-2-end');
    });

    await second;
    expect(events).toContain('room-2-start');
    expect(events).toContain('room-2-end');
    expect(events).not.toContain('room-1-end');

    releaseFirst();
    await first;
  });

  it('builds group and private strand keys by session scope', () => {
    expect(
      resolveSessionStrandKey({
        platform: 'onebot',
        isDirect: false,
        channelId: 'group-100',
        userId: 'u1',
        bot: { selfId: 'bot-1' },
      }),
    ).toBe('onebot:bot-1:group:group-100');

    expect(
      resolveSessionStrandKey({
        platform: 'onebot',
        isDirect: true,
        channelId: 'private-u1',
        userId: 'u1',
        bot: { selfId: 'bot-1' },
      }),
    ).toBe('onebot:bot-1:private:private-u1');
  });

  it('separates different groups and different private users', () => {
    const groupA = resolveSessionStrandKey({
      platform: 'onebot',
      isDirect: false,
      channelId: 'group-100',
      userId: 'u1',
      bot: { selfId: 'bot-1' },
    });
    const groupB = resolveSessionStrandKey({
      platform: 'onebot',
      isDirect: false,
      channelId: 'group-200',
      userId: 'u2',
      bot: { selfId: 'bot-1' },
    });
    const privateU1 = resolveSessionStrandKey({
      platform: 'onebot',
      isDirect: true,
      channelId: 'private-u1',
      userId: 'u1',
      bot: { selfId: 'bot-1' },
    });
    const privateU2 = resolveSessionStrandKey({
      platform: 'onebot',
      isDirect: true,
      channelId: 'private-u2',
      userId: 'u2',
      bot: { selfId: 'bot-1' },
    });

    expect(groupA).not.toBe(groupB);
    expect(groupA).not.toBe(privateU1);
    expect(privateU1).not.toBe(privateU2);
  });
});
