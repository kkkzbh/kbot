import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => {
  type Element = {
    type: string;
    attrs: Record<string, string>;
    toString(): string;
  };
  const element = (type: string, attrs: Record<string, string>): Element => ({
    type,
    attrs,
    toString: () => type === 'text'
      ? attrs.content ?? ''
      : `<${type} ${Object.entries(attrs).map(([key, value]) => `${key}="${value}"`).join(' ')}/>` ,
  });
  const parse = (content: string): Element[] => {
    const quote = content.match(/^<quote id="([^"]+)"\/>/u);
    if (!quote) return [element('text', { content })];
    const result = [element('quote', { id: quote[1] })];
    const body = content.slice(quote[0].length);
    if (body) result.push(element('text', { content: body }));
    return result;
  };
  const schema = { description: () => schema, role: () => schema };
  return {
    Context: class {},
    Logger: class { info(): void {} },
    Schema: {
      object: () => schema,
      boolean: () => schema,
      string: () => schema,
      array: () => schema,
      union: () => schema,
    },
    h: {
      image: (src: string) => element('img', { src }),
      text: (content: string) => element('text', { content }),
      parse,
    },
  };
});

import {
  apply,
  buildAntiRecallNotice,
  isAntiRecallAllowedGroup,
  qqAvatarUrl,
} from '../src/plugins/anti-recall/index.js';
import { AntiRecallMessageCache } from '../src/plugins/anti-recall/cache.js';

type Handler = (...args: any[]) => unknown;

function message(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'onebot',
    bot: { selfId: 'bot-1' },
    channelId: 'group:100',
    messageId: 'message-1',
    userId: '123456',
    content: '不能被撤回的内容',
    ...overrides,
  };
}

function createHarness(enabled = true, allowedGroups: string[] | string = '100') {
  const events = new Map<string, Handler[]>();
  let middleware: Handler | undefined;
  const ctx = {
    middleware: vi.fn((handler: Handler) => {
      middleware = handler;
    }),
    on: vi.fn((event: string, handler: Handler) => {
      events.set(event, [...(events.get(event) ?? []), handler]);
    }),
  };
  apply(ctx as never, { enabled, allowedGroups });
  return {
    middleware,
    async emit(event: string, session?: unknown) {
      for (const handler of events.get(event) ?? []) await handler(session);
    },
  };
}

describe('anti-recall', () => {
  it('publishes the cached original message once when OneBot reports a recall', async () => {
    const harness = createHarness();
    const next = vi.fn(async () => undefined);
    await harness.middleware?.(message(), next);

    const send = vi.fn(async (_fragment: unknown) => ['sent-message']);
    await harness.emit('message-deleted', message({ content: undefined, send }));

    expect(next).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    const fragment = send.mock.calls[0][0] as Array<{ toString(): string }>;
    expect(fragment.map((element) => element.toString()).join('')).toBe(
      `<img src="${qqAvatarUrl('123456')}"/>[123456]撤回了一条消息: 不能被撤回的内容`,
    );

    await harness.emit('message-deleted', message({ content: undefined, send }));
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not register message processing when disabled', () => {
    const harness = createHarness(false);
    expect(harness.middleware).toBeUndefined();
  });

  it('only captures and publishes recalls from allowed groups', async () => {
    const harness = createHarness(true, '100,200');
    const next = vi.fn(async () => undefined);
    const send = vi.fn(async (_fragment: unknown) => ['sent-message']);

    await harness.middleware?.(message({ channelId: 'group:300' }), next);
    await harness.emit('message-deleted', message({ channelId: 'group:300', content: undefined, send }));
    await harness.middleware?.(message({ channelId: 'group:100', isDirect: true }), next);
    await harness.emit('message-deleted', message({ channelId: 'group:100', isDirect: true, content: undefined, send }));

    expect(next).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });

  it('treats an empty allowlist as disabled for every group', () => {
    const harness = createHarness(true, '');
    expect(harness.middleware).toBeUndefined();
  });

  it('matches normalized OneBot group identifiers', () => {
    expect(isAntiRecallAllowedGroup(
      message({ guildId: 'group:100' }) as never,
      new Set(['100']),
    )).toBe(true);
    expect(isAntiRecallAllowedGroup(
      message({ guildId: 'group:200' }) as never,
      new Set(['100']),
    )).toBe(false);
  });

  it('rejects invalid group identifiers in configuration', () => {
    expect(() => createHarness(true, '100,not-a-group')).toThrow(
      '防撤回群白名单包含无效 QQ 群号：not-a-group',
    );
  });

  it('removes quote semantics while preserving the recalled body', () => {
    const notice = buildAntiRecallNotice({
      key: 'key',
      userId: '42',
      content: '<quote id="old"/>回答正文',
      capturedAt: 1,
    });
    expect(notice.some((element) => element.type === 'quote')).toBe(false);
    expect(notice.map((element) => element.toString()).join('')).toContain('回答正文');
  });

  it('evicts expired and oldest messages at the cache boundary', () => {
    let now = 1_000;
    const cache = new AntiRecallMessageCache(1, 100, () => now);
    expect(cache.capture(message())).toBe(true);
    expect(cache.find(message())?.content).toBe('不能被撤回的内容');

    cache.capture(message({ messageId: 'message-2', content: '第二条' }));
    expect(cache.find(message())).toBeNull();
    expect(cache.find(message({ messageId: 'message-2' }))?.content).toBe('第二条');

    now += 101;
    expect(cache.find(message({ messageId: 'message-2' }))).toBeNull();
  });
});
