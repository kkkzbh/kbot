import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apply,
  GroupReplyScheduler,
  inject,
} from '../src/plugins/triggers/group-natural/index.js';
import type {
  ModelRuntimeClient,
  ModelRuntimeExecutionRequest,
} from '../src/plugins/model-config/index.js';
import type { NaturalTriggerConfig } from '../src/plugins/natural-trigger-config/index.js';
import type { NaturalTriggerState } from '../src/plugins/triggers/group-natural/state.js';
import { createTestModelRuntime } from './model-runtime-fixture.js';

vi.mock('koishi', () => {
  const node = { description: () => node };
  return {
    Context: class {},
    Logger: class {
      info(): void {}
      warn(): void {}
    },
    Schema: { object: () => node },
  };
});

type Middleware = (
  session: Record<string, any>,
  next: () => Promise<unknown>,
) => Promise<unknown>;
type AllowReplyResolver = (arg: {
  session: Record<string, any>;
  context: unknown;
}) => unknown;

function defaultConfig(): NaturalTriggerConfig {
  return {
    enabled: true,
    allowedGroupIds: ['100', '200'],
    voiceAdmission: { enabled: true },
    mechanisms: {
      quote: { enabled: true },
      alias: { enabled: true, aliases: ['祥子'] },
      heuristic: { enabled: true },
      focus: { enabled: true, windowMs: 300_000 },
      random: { enabled: false, probability: 0 },
    },
    modelDecision: { minConfidence: 0.62 },
    pacing: { minReplyIntervalMs: 0 },
    antiSpam: {
      enabled: true,
      windowMs: 10_000,
      threshold: 10,
      muteMs: 180_000,
    },
  };
}

function createHarness(options: {
  mutate?: (config: NaturalTriggerConfig) => void;
  modelRuntime?: ModelRuntimeClient;
} = {}) {
  const config = defaultConfig();
  options.mutate?.(config);
  const middlewares: Middleware[] = [];
  const listeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const disposeResolver = vi.fn();
  const registerAllowReplyResolver = vi.fn(
    (_name: string, _resolver: AllowReplyResolver) => disposeResolver,
  );
  const ctx = {
    middleware: vi.fn((middleware: Middleware) => middlewares.push(middleware)),
    on: vi.fn((name: string, listener: (...args: any[]) => unknown) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    }),
    setInterval: vi.fn(),
    chatluna: { registerAllowReplyResolver },
    modelRuntime: options.modelRuntime
      ?? createTestModelRuntime({ naturalTriggerMode: 'disabled' }).modelRuntime,
    naturalTriggerConfig: {
      getRuntimeSnapshot: () => ({
        revision: 1,
        config,
        allowedGroupIds: new Set(config.allowedGroupIds),
      }),
    },
  };
  apply(ctx as never);
  const runHook = async (name: string): Promise<void> => {
    for (const listener of listeners.get(name) ?? []) await listener();
  };
  return {
    config,
    middleware: middlewares[0]!,
    registerAllowReplyResolver,
    disposeResolver,
    runReady: () => runHook('ready'),
    runDispose: () => runHook('dispose'),
  };
}

function createSession(overrides: Record<string, unknown> = {}): Record<string, any> {
  const content = String(overrides.content ?? '');
  return {
    platform: 'onebot',
    isDirect: false,
    channelId: '100',
    guildId: '100',
    userId: 'u1',
    content,
    stripped: { content },
    bot: { selfId: 'bot-1' },
    elements: [],
    ...overrides,
  };
}

async function runAndCapture(
  middleware: Middleware,
  session: Record<string, any>,
): Promise<NaturalTriggerState | null> {
  let naturalTrigger: NaturalTriggerState | null = null;
  await middleware(session, async () => {
    naturalTrigger = session.qqNaturalTrigger ?? null;
  });
  return naturalTrigger;
}

describe('group natural trigger middleware', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('requires the canonical runtime services', () => {
    expect(inject).toEqual({
      required: ['chatluna', 'modelRuntime', 'naturalTriggerConfig'],
    });
  });

  it('keeps groups outside the configured scope untouched', async () => {
    const { middleware } = createHarness();
    const state = await runAndCapture(
      middleware,
      createSession({ guildId: '999', channelId: '999', content: '祥子 在吗' }),
    );
    expect(state).toBeNull();
  });

  it('uses quote, alias and heuristic priority in that order', async () => {
    const { middleware } = createHarness();
    await expect(runAndCapture(
      middleware,
      createSession({
        content: '祥子 你能帮我吗',
        quote: { user: { id: 'bot-1' } },
      }),
    )).resolves.toEqual({ reason: 'quote', explicit: true });

    await expect(runAndCapture(
      middleware,
      createSession({ content: '祥子 你能帮我吗', userId: 'u2' }),
    )).resolves.toEqual({ reason: 'alias', explicit: true });

    await expect(runAndCapture(
      middleware,
      createSession({ content: '你能帮我吗', userId: 'u3' }),
    )).resolves.toEqual({ reason: 'rule', explicit: true });
  });

  it('allows quoted image-only messages', async () => {
    const { middleware } = createHarness();
    await expect(runAndCapture(
      middleware,
      createSession({
        content: '',
        stripped: { content: '' },
        elements: [{ type: 'img', attrs: { src: 'https://example.com/1.png' } }],
        quote: { user: { id: 'bot-1' } },
      }),
    )).resolves.toEqual({ reason: 'quote', explicit: true });
  });

  it('honors the quote, alias, heuristic and focus switches independently', async () => {
    const quoteDisabled = createHarness({
      mutate: (config) => {
        config.mechanisms.quote.enabled = false;
        config.mechanisms.heuristic.enabled = false;
        config.mechanisms.focus.enabled = false;
      },
    });
    await expect(runAndCapture(
      quoteDisabled.middleware,
      createSession({
        content: '',
        stripped: { content: '' },
        elements: [{ type: 'img', attrs: { src: 'https://example.com/1.png' } }],
        quote: { user: { id: 'bot-1' } },
      }),
    )).resolves.toBeNull();

    const aliasDisabled = createHarness({
      mutate: (config) => {
        config.mechanisms.alias.enabled = false;
        config.mechanisms.heuristic.enabled = false;
        config.mechanisms.focus.enabled = false;
      },
    });
    await expect(runAndCapture(
      aliasDisabled.middleware,
      createSession({ content: '祥子 在吗' }),
    )).resolves.toBeNull();

    const heuristicDisabled = createHarness({
      mutate: (config) => {
        config.mechanisms.heuristic.enabled = false;
        config.mechanisms.focus.enabled = false;
      },
    });
    await expect(runAndCapture(
      heuristicDisabled.middleware,
      createSession({ content: '你能帮我吗' }),
    )).resolves.toBeNull();

    const focusDisabled = createHarness({
      mutate: (config) => {
        config.mechanisms.focus.enabled = false;
      },
    });
    await runAndCapture(focusDisabled.middleware, createSession({ content: '祥子 在吗' }));
    await expect(runAndCapture(
      focusDisabled.middleware,
      createSession({ content: '继续', userId: 'u2' }),
    )).resolves.toBeNull();
  });

  it('shares focus within one group and isolates another group', async () => {
    const { middleware } = createHarness();
    await runAndCapture(middleware, createSession({ content: '祥子 在吗' }));
    await expect(runAndCapture(
      middleware,
      createSession({ content: '继续', userId: 'u2' }),
    )).resolves.toEqual({ reason: 'focus', explicit: false });
    await expect(runAndCapture(
      middleware,
      createSession({
        guildId: '200',
        channelId: '200',
        content: '继续',
        userId: 'u3',
      }),
    )).resolves.toBeNull();
  });

  it('falls through model failure before evaluating random trigger', async () => {
    const execute = vi.fn(async (_request: ModelRuntimeExecutionRequest) => {
      throw new Error('provider unavailable');
    });
    const { modelRuntime } = createTestModelRuntime({
      naturalTriggerMode: 'dedicated',
      executor: { execute },
    });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { middleware } = createHarness({
      modelRuntime,
      mutate: (config) => {
        config.mechanisms.heuristic.enabled = false;
        config.mechanisms.focus.enabled = false;
        config.mechanisms.random = { enabled: true, probability: 0.2 };
      },
    });
    await expect(runAndCapture(
      middleware,
      createSession({ content: '普通闲聊' }),
    )).resolves.toEqual({ reason: 'direct', explicit: false });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('sends only user content to a compatible decision model', async () => {
    const execute = vi.fn(async (_request: ModelRuntimeExecutionRequest) => ({
      text: '{"trigger":true,"confidence":0.9}',
    }));
    const { modelRuntime } = createTestModelRuntime({
      naturalTriggerMode: 'dedicated',
      executor: { execute },
    });
    const { middleware } = createHarness({
      modelRuntime,
      mutate: (config) => {
        config.mechanisms.heuristic.enabled = false;
        config.mechanisms.focus.enabled = false;
      },
    });
    await expect(runAndCapture(
      middleware,
      createSession({ content: '普通闲聊一下' }),
    )).resolves.toEqual({ reason: 'model', explicit: false });
    expect(execute.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      payload: expect.objectContaining({
        messages: expect.arrayContaining([
          { role: 'user', content: '消息: 普通闲聊一下' },
        ]),
      }),
    }));
  });

  it('lets spam-suppressed messages continue through later middleware', async () => {
    const { middleware } = createHarness({
      mutate: (config) => {
        config.antiSpam.threshold = 1;
      },
    });
    let nextCalls = 0;
    const session = createSession({ content: '祥子 在吗' });
    await middleware(session, async () => {
      nextCalls += 1;
      expect(session.qqNaturalTrigger).toBeUndefined();
    });
    expect(nextCalls).toBe(1);
  });

  it('bypasses spam accounting when protection is disabled', async () => {
    const { middleware } = createHarness({
      mutate: (config) => {
        config.antiSpam.enabled = false;
        config.antiSpam.threshold = 1;
      },
    });
    await expect(runAndCapture(
      middleware,
      createSession({ content: '祥子 在吗' }),
    )).resolves.toEqual({ reason: 'alias', explicit: true });
  });

  it('serializes concurrent reservations for the same group', async () => {
    let now = 1_000;
    const waits: number[] = [];
    const scheduler = new GroupReplyScheduler(
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    const [first, second] = await Promise.all([
      scheduler.reserve('onebot:bot:group:100', 2_000),
      scheduler.reserve('onebot:bot:group:100', 2_000),
    ]);
    expect(first).toBe(1_000);
    expect(second).toBe(3_000);
    expect(waits).toEqual([2_000]);
    now = 6_000;
    scheduler.cleanup();
    expect(scheduler.stateSize).toBe(0);
  });

  it('registers and disposes the ChatLuna allow resolver', async () => {
    const harness = createHarness();
    await harness.runReady();
    const resolver = harness.registerAllowReplyResolver.mock.calls[0]?.[1] as
      | AllowReplyResolver
      | undefined;
    expect(resolver).toBeTypeOf('function');
    const session = createSession({ content: '祥子 在吗' });
    let allowed: unknown;
    await harness.middleware(session, async () => {
      allowed = await resolver!({ session, context: {} });
    });
    expect(allowed).toBe(true);
    await harness.runDispose();
    expect(harness.disposeResolver).toHaveBeenCalledOnce();
  });
});
