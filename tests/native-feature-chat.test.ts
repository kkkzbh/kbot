import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => {
  const createElement = (type: string, attrs: Record<string, unknown>) => ({
    type,
    attrs,
    children: [],
  });
  const h = {
    at: (id: string) => createElement('at', { id }),
    text: (content: string) => createElement('text', { content }),
    image: (source: Buffer, mime: string) => createElement('img', {
      src: `data:${mime};base64,${source.toString('base64')}`,
    }),
    normalize: (fragment: unknown): Array<{ type: string; attrs: Record<string, unknown>; children: unknown[] }> => {
      const values = Array.isArray(fragment) ? fragment.flat(Infinity) : [fragment];
      return values.flatMap((value) => {
        if (typeof value === 'string') return [createElement('text', { content: value })];
        if (value && typeof value === 'object' && 'type' in value) return [value as any];
        return [];
      });
    },
  };
  return {
    Context: class {},
    Logger: class {
      info(): void {}
      warn(): void {}
    },
    h,
  };
});

vi.mock('koishi-plugin-chatluna/chains', () => ({
  ChainMiddlewareRunStatus: { CONTINUE: 2 },
}));

import { h } from 'koishi';

const historyBatches: unknown[][] = [];
const realtimeMocks = vi.hoisted(() => ({
  discardRealtimeMessageForSession: vi.fn(() => true),
}));

vi.mock('../src/plugins/shared/chatluna-history.js', () => ({
  createChatLunaHistoryWriter: vi.fn(async () => ({
    addMessages: vi.fn(async (messages: unknown[]) => {
      historyBatches.push(messages);
    }),
  })),
}));

vi.mock('../src/plugins/realtime-message/index.js', () => ({
  discardRealtimeMessageForSession: realtimeMocks.discardRealtimeMessageForSession,
}));

import { apply } from '../src/plugins/native-feature-chat/index.js';
import {
  beginPromptAssemblyTurn,
  clearPromptAssemblyTurn,
  peekPromptFragments,
} from '../src/plugins/shared/prompt-context/index.js';
import type { NativeFeatureChatServiceLike } from '../src/types/native-feature-chat.js';

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'onebot',
    selfId: 'bot-1',
    bot: { selfId: 'bot-1' },
    userId: 'u1',
    guildId: '100',
    channelId: '100',
    isDirect: false,
    messageId: 'msg-feature-1',
    content: '课程查询 模式识别 -1',
    stripped: { content: '课程查询 模式识别 -1' },
    author: { nick: '小明' },
    send: vi.fn(async () => ['sent-1']),
    ...overrides,
  };
}

function createHarness() {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const chainMiddlewares = new Map<string, (session: unknown, context: unknown) => Promise<number>>();
  let service: NativeFeatureChatServiceLike | null = null;
  const chainBuilder = {
    after: vi.fn(() => chainBuilder),
    before: vi.fn(() => chainBuilder),
  };
  const resolveConversation = vi.fn(async () => ({
    conversationId: 'conv-native-feature',
    effectiveModel: 'openai/gpt-5.4',
    conversation: {
      id: 'conv-native-feature',
      model: 'openai/gpt-5.4',
    },
  }));
  const transform = vi.fn(async (..._args: unknown[]) => ({
    content: [
      { type: 'text', text: '查询结果正文' },
      { type: 'image_url', image_url: { url: 'https://storage.example/result.png' } },
    ],
  }));
  const ctx = {
    database: {},
    chatluna: {
      config: {
        defaultModel: 'openai/gpt-5.4',
        defaultPreset: 'sakiko',
        defaultChatMode: 'plugin',
      },
      conversation: { resolveConversation },
      messageTransformer: { transform },
      chatChain: {
        middleware: vi.fn((name: string, middleware: (session: unknown, context: unknown) => Promise<number>) => {
          chainMiddlewares.set(name, middleware);
          return chainBuilder;
        }),
      },
    },
    provide: vi.fn(),
    set: vi.fn((name: string, value: unknown) => {
      if (name === 'nativeFeatureChat') service = value as NativeFeatureChatServiceLike;
    }),
    on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
  };

  apply(ctx as never, {});

  return {
    ctx,
    get service(): NativeFeatureChatServiceLike {
      if (!service) throw new Error('native feature chat service was not provided');
      return service;
    },
    resolveConversation,
    transform,
    chainMiddlewares,
    async emit(event: string): Promise<void> {
      for (const handler of handlers.get(event) ?? []) {
        await handler();
      }
    },
  };
}

afterEach(() => {
  historyBatches.length = 0;
  clearPromptAssemblyTurn('conv-native-feature');
  vi.clearAllMocks();
});

describe('native feature chat integration', () => {
  it('stores semantic feature history without transport media and consumes the realtime duplicate', async () => {
    const harness = createHarness();
    const session = createSession();

    const result = await harness.service.sendReply(session as never, {
      featureId: 'hbu-jw',
      commandId: 'course_query',
      userText: '课程查询 模式识别 -1',
      reply: [h.at('u1'), h.text('\n'), h.image(Buffer.from('png'), 'image/png')],
      summary: '机器人返回了“模式识别”的课程分项成绩查询结果图片（学期参数：-1）。',
      success: true,
      includeReplyPayload: true,
    });

    expect(result?.conversationId).toBe('conv-native-feature');
    expect(session.send).toHaveBeenCalledTimes(1);
    expect(harness.resolveConversation).toHaveBeenCalledWith(session, {
      mode: 'active',
      useRoutePresetLane: true,
    });
    expect(harness.transform).toHaveBeenCalledWith(
      session,
      expect.not.arrayContaining([expect.objectContaining({ type: 'at' })]),
      'openai/gpt-5.4',
      undefined,
      { quote: false, includeQuoteReply: false },
    );

    const [human, assistant] = historyBatches[0] as any[];
    expect(human.content).toContain('[speaker_id=u1 speaker_name="小明"] 课程查询 模式识别 -1');
    expect(human.additional_kwargs.qqbot_native_feature).toMatchObject({
      featureId: 'hbu-jw',
      commandId: 'course_query',
      role: 'request',
    });
    expect(assistant.content).toBe(
      '机器人返回了“模式识别”的课程分项成绩查询结果图片（学期参数：-1）。\n查询结果正文',
    );
    expect(JSON.stringify(assistant.content)).not.toContain('storage.example');
    expect(realtimeMocks.discardRealtimeMessageForSession).toHaveBeenCalledWith(session);
  });

  it('removes image markers from semantic history when the transformer emits no text', async () => {
    const harness = createHarness();
    harness.transform.mockImplementationOnce(async (...args: unknown[]) => {
      const elements = args[1];
      const image = (elements as Array<{ type: string; attrs: Record<string, unknown> }>).find(
        (element) => element.type === 'img',
      );
      if (image) {
        image.attrs.src = 'https://storage.example/model-independent.png';
        image.attrs.imageUrl = 'https://storage.example/model-independent.png';
      }
      return {
        content: [{ type: 'text', text: '[image:https://storage.example/model-independent.png]' }],
      };
    });

    await harness.service.recordExchange(createSession() as never, {
      featureId: 'hbu-jw',
      commandId: 'menu',
      userText: '教务',
      reply: h.image(Buffer.from('png'), 'image/png'),
      summary: '机器人返回了教务功能菜单图片。',
      success: true,
      includeReplyPayload: true,
    });

    const assistant = (historyBatches[0] as any[])[1];
    expect(assistant.content).toBe('机器人返回了教务功能菜单图片。');
  });

  it('stores only the sanitized summary when a reply contains a one-time secret', async () => {
    const harness = createHarness();
    const session = createSession({
      messageId: 'msg-secret',
      content: '原神确认 123456',
      stripped: { content: '原神确认 123456' },
    });

    await harness.service.recordExchange(session as never, {
      featureId: 'genshin',
      commandId: 'confirm',
      userText: '原神确认 <确认码已隐藏>',
      reply: '请打开 https://secret.example/bind?token=top-secret',
      summary: '原神绑定完成。',
      success: true,
      includeReplyPayload: false,
    });

    expect(harness.transform).not.toHaveBeenCalled();
    const serialized = JSON.stringify(historyBatches[0]);
    expect(serialized).toContain('原神确认 <确认码已隐藏>');
    expect(serialized).toContain('原神绑定完成。');
    expect(serialized).not.toContain('123456');
    expect(serialized).not.toContain('top-secret');
  });

  it('injects registered native capabilities as trusted Agent reference context', async () => {
    const harness = createHarness();
    harness.service.registerCapability({
      id: 'hbu-jw',
      isRelevant: () => true,
      buildReference: () => '教务总入口：“教务”；课程查询格式：“课程查询 <课程> [学期]”。',
    });
    harness.service.registerCapability({
      id: 'genshin',
      isRelevant: () => true,
      buildReference: () => '原神总入口：“原神”；抽卡统计命令：“抽卡记录”。',
    });
    await harness.emit('ready');

    const middleware = harness.chainMiddlewares.get('qqbot_native_feature_capabilities');
    expect(middleware).toBeTypeOf('function');
    beginPromptAssemblyTurn('conv-native-feature');
    await middleware!(createSession(), {
      options: {
        conversation: {
          conversationId: 'conv-native-feature',
          conversation: {
            id: 'conv-native-feature',
          },
        },
      },
    });

    const [fragment] = peekPromptFragments('conv-native-feature');
    expect(fragment).toMatchObject({
      source: 'qqbot_native_features',
      authority: 'reference',
      trust: 'trusted',
      ttl: 'turn',
    });
    const payload = String(fragment?.payload.value ?? '');
    expect(payload).toContain('自由聊天是默认职责');
    expect(payload).toContain('只有当前消息明确询问、尝试或要求纠正');
    expect(payload).toContain('课程查询 <课程> [学期]');
    expect(payload).toContain('抽卡记录');
  });

  it('injects only the chat boundary when no capability matches the current message', async () => {
    const harness = createHarness();
    harness.service.registerCapability({
      id: 'hbu-jw',
      isRelevant: () => false,
      buildReference: () => '教务总入口：“教务”。',
    });
    harness.service.registerCapability({
      id: 'genshin',
      isRelevant: () => false,
      buildReference: () => '原神总入口：“原神”。',
    });
    await harness.emit('ready');

    beginPromptAssemblyTurn('conv-native-feature');
    const middleware = harness.chainMiddlewares.get('qqbot_native_feature_capabilities');
    await middleware!(createSession({ content: '在', stripped: { content: '在' } }), {
      options: {
        conversation: {
          conversationId: 'conv-native-feature',
          conversation: { id: 'conv-native-feature' },
        },
      },
    });

    const [fragment] = peekPromptFragments('conv-native-feature');
    const payload = String(fragment?.payload.value ?? '');
    expect(payload).toContain('自由聊天是默认职责');
    expect(payload).toContain('历史中的功能查询结果只在当前消息明确引用');
    expect(payload).not.toContain('教务总入口');
    expect(payload).not.toContain('原神总入口');
    expect(payload).not.toContain('当前消息可能涉及的只读命令参考');
  });
});
