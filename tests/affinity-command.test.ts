import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AffinityService, apply, inject as affinityInject, isAffinityPanelCommandSession, registerAffinityPanelCommand } from '../src/plugins/affinity/index.js';
import type { AffinityPanelView, AffinityServiceLike } from '../src/types/affinity.js';
import { createTestModelRuntime } from './model-runtime-fixture.js';

vi.mock('koishi', () => {
  class MockLogger {
    warn(): void {}
    info(): void {}
  }
  const schemaChain = new Proxy(() => schemaChain, {
    get: () => schemaChain,
    apply: () => schemaChain,
  }) as any;
  const Schema = new Proxy({}, {
    get: () => schemaChain,
  }) as any;
  return {
    Context: class {},
    Logger: MockLogger,
    Schema,
    h: {
      image: (buffer: Buffer, mime: string) => ({
        type: 'image',
        attrs: { buffer, mime },
        toString: () => `<image mime="${mime}"/>`,
      }),
    },
  };
});

vi.mock('koishi-plugin-chatluna/chains', () => ({
  ChainMiddlewareRunStatus: { CONTINUE: 0 },
}));

vi.mock('../src/plugins/shared/chatluna-history.js', () => ({
  createChatLunaHistoryWriter: vi.fn(),
}));

function createPanelView(overrides: Partial<AffinityPanelView> = {}): AffinityPanelView {
  return {
    characterId: 'sakiko',
    userKey: 'onebot:alice',
    stage: 'remembered',
    stageName: '被记住的人',
    stageIcon: '◆',
    lastRelationChange: '12分钟前',
    axes: [
      { name: '信赖', value: 43, tone: 'wine', icon: '◆' },
      { name: '熟悉', value: 58, tone: 'teal', icon: '✦' },
      { name: '安心', value: 36, tone: 'blue', icon: '☾' },
      { name: '紧张', value: 18, tone: 'gold', icon: '!' },
    ],
    rhythm: [
      { label: '心情', value: '专注', icon: '◇' },
      { label: '热度', value: '偏高', icon: '▲' },
      { label: '体力', value: '72', icon: '∿' },
    ],
    recentEvents: [{
      time: '12分钟前',
      title: '承接了她主动打开的话题',
      icon: '✦',
      effects: [{ name: '信赖', sign: '+' }],
    }],
    adviceIcon: '◆',
    advice: '低频、认真地回应她已经打开的话题。',
    lineKind: 'remembered',
    fixedLine: '你之前说过的事，我多少还记得一点。',
    ...overrides,
  };
}

function createPuppeteerHarness() {
  let navigatedHtml = '';
  const element = {
    boundingBox: vi.fn(async () => ({ x: 0, y: 0, width: 900, height: 1160 })),
  };
  const page = {
    setViewport: vi.fn(async () => undefined),
    setContent: vi.fn(async (_content: string, _options?: unknown) => undefined),
    goto: vi.fn(async (url: string) => {
      navigatedHtml = readFileSync(fileURLToPath(url), 'utf8');
    }),
    waitForSelector: vi.fn(async () => undefined),
    $: vi.fn(async () => element),
    screenshot: vi.fn(async () => Buffer.from('png')),
    close: vi.fn(async () => undefined),
  };
  return {
    page,
    puppeteer: {
      page: vi.fn(async () => page),
    },
    getNavigatedHtml: () => navigatedHtml,
  };
}

describe('affinity panel command', () => {
  it('requires ChatLuna because affinity prompt and allow-reply hooks are runtime-critical', () => {
    expect(affinityInject.required).toContain('chatluna');
    expect(affinityInject.required).toEqual(expect.arrayContaining([
      'modelConfig',
      'modelRuntime',
    ]));
    expect('optional' in affinityInject ? affinityInject.optional : []).not.toContain('chatluna');
  });

  it('wires the exact 好感 command skip before incoming relationship analysis', () => {
    const source = readFileSync(join(process.cwd(), 'src/plugins/affinity/index.ts'), 'utf8');
    expect(source).toContain('if (!isAffinityPanelCommandSession(session))');
    expect(source).toContain('await service.processIncomingSession(session);');
  });

  it('registers ChatLuna hooks from the chat-chain-added lifecycle event', async () => {
    const listeners = new Map<string, Array<() => unknown>>();
    const middlewares = new Map<string, unknown>();
    const chainConstraints: Array<{ name: string; kind: 'after' | 'before'; target: string }> = [];
    const registerAllowReplyResolver = vi.fn(() => vi.fn());
    const injectPromptForTurn = vi.spyOn(AffinityService.prototype, 'injectPromptForTurn').mockResolvedValue(undefined);
    const chatluna: Record<string, unknown> = {
      registerAllowReplyResolver,
    };
    const chain = {
      middleware: vi.fn((name: string, middleware: unknown) => {
        middlewares.set(name, middleware);
        const builder = {
          after: (target: string) => {
            chainConstraints.push({ name, kind: 'after', target });
            return builder;
          },
          before: (target: string) => {
            chainConstraints.push({ name, kind: 'before', target });
            return builder;
          },
        };
        return builder;
      }),
    };
    const command = vi.fn(() => ({
      action: vi.fn(),
    }));
    const { modelConfig, modelRuntime } = createTestModelRuntime();
    const ctx = {
      model: {
        extend: vi.fn(),
      },
      database: {
        get: vi.fn(async () => []),
        set: vi.fn(async () => undefined),
      },
      puppeteer: {},
      chatluna,
      modelConfig,
      modelRuntime,
      command,
      middleware: vi.fn(),
      on: vi.fn((name: string, listener: () => unknown) => {
        const bucket = listeners.get(name) ?? [];
        bucket.push(listener);
        listeners.set(name, bucket);
      }),
    };
    const runHook = async (name: string) => {
      for (const listener of listeners.get(name) ?? []) {
        await listener();
      }
    };

    try {
      apply(ctx as never, {
        enabled: false,
        proactiveEnabled: false,
        pollIntervalMs: 1000,
        randomWindowStartHour: 0,
        randomWindowEndHour: 1,
      });

      await runHook('ready');

      expect(registerAllowReplyResolver).not.toHaveBeenCalled();
      expect(middlewares.has('qqbot_affinity_prompt_context')).toBe(false);

      chatluna.chatChain = chain;
      await runHook('chatluna/chat-chain-added');

      expect(registerAllowReplyResolver).toHaveBeenCalledWith('qqbot-affinity', expect.any(Function));
      const middleware = middlewares.get('qqbot_affinity_prompt_context') as
        | ((session: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>)
        | undefined;
      expect(middleware).toBeTypeOf('function');

      await middleware?.(
        { userId: '10001', bot: { selfId: '20001' } },
        {
          options: {
            conversation: {
              conversationId: 'conv-effective',
              conversation: {
                id: 'conv-effective',
              },
            },
          },
        },
      );

      expect(injectPromptForTurn).toHaveBeenCalledWith('conv-effective', expect.any(Object));
      expect(chainConstraints).toContainEqual({
        name: 'qqbot_affinity_prompt_context',
        kind: 'after',
        target: 'resolve_conversation',
      });
    } finally {
      injectPromptForTurn.mockRestore();
    }
  });

  it('identifies the exact 好感 command so incoming affinity analysis can skip it', () => {
    expect(isAffinityPanelCommandSession({ content: '好感' } as any)).toBe(true);
    expect(isAffinityPanelCommandSession({ stripped: { content: ' 好感 ' }, content: '<at id="bot"/> 好感' } as any)).toBe(true);
    expect(isAffinityPanelCommandSession({ content: '好感度' } as any)).toBe(false);
    expect(isAffinityPanelCommandSession({ content: '看看好感' } as any)).toBe(false);
  });

  it('registers 好感 and sends panel image before the fixed line', async () => {
    const panelView = createPanelView();
    const service = {
      buildPanelView: vi.fn(async () => panelView),
      syncPanelCommandToChatHistory: vi.fn(async () => ({ synced: true, conversationId: 'conv-affinity' })),
    } as unknown as AffinityServiceLike;
    const { page, puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    let action: ((argv: { session?: any }) => Promise<unknown>) | null = null;
    const command = vi.fn((_name: string) => ({
      action: vi.fn((callback) => {
        action = callback;
      }),
    }));
    const logger = { warn: vi.fn() };
    registerAffinityPanelCommand({ command, puppeteer }, service, logger as any);

    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith('好感', '查看与丰川祥子的关系面板');
    expect(action).toBeTruthy();

    const sent: unknown[] = [];
    const session = {
      userId: 'alice',
      send: vi.fn(async (message: unknown) => {
        sent.push(message);
      }),
    };
    const result = await action!({ session });

    expect(result).toBeUndefined();
    expect(service.buildPanelView).toHaveBeenCalledWith(session);
    expect(page.setContent).not.toHaveBeenCalled();
    expect(page.goto).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\//), { waitUntil: 'networkidle0' });
    expect(getNavigatedHtml()).toContain('承接了她主动打开的话题');
    expect(getNavigatedHtml()).toContain('panel-banner.png');
    expect(sent).toHaveLength(2);
    expect(String(sent[0])).toContain('image');
    expect(sent[1]).toBe(panelView.fixedLine);
    expect(service.syncPanelCommandToChatHistory).toHaveBeenCalledWith(session, panelView);
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not send a line when panel generation fails', async () => {
    const service = {
      buildPanelView: vi.fn(async () => {
        throw new Error('renderer unavailable');
      }),
      syncPanelCommandToChatHistory: vi.fn(async () => ({ synced: true })),
    } as unknown as AffinityServiceLike;
    const { puppeteer } = createPuppeteerHarness();
    let action: ((argv: { session?: any }) => Promise<unknown>) | null = null;
    const command = vi.fn((_name: string) => ({
      action: vi.fn((callback) => {
        action = callback;
      }),
    }));
    const logger = { warn: vi.fn() };
    registerAffinityPanelCommand({ command, puppeteer }, service, logger as any);

    const session = {
      userId: 'alice',
      send: vi.fn(async () => undefined),
    };
    const result = await action!({ session });

    expect(result).toBe('关系面板生成失败。');
    expect(session.send).not.toHaveBeenCalled();
    expect(service.syncPanelCommandToChatHistory).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('affinity panel command failed: %s', 'renderer unavailable');
  });
});
