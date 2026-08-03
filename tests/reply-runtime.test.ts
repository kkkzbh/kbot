import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplyRuntime } from '../src/plugins/reply/runtime/index.js';
import type { TurnInput } from '../src/plugins/reply/pipeline/types.js';

function createArgs(overrides: Record<string, unknown> = {}) {
  const inputOverrides = (overrides.input ?? {}) as Partial<TurnInput>;
  const { imageParts = [], ...inputRest } = inputOverrides;
  const { input: _input, ...runOverrides } = overrides;
  const input: TurnInput = {
    text: '第一条',
    hasImageInput: false,
    imageCount: 0,
    hasVoiceInput: false,
    displayName: '用户',
    userId: 'u1',
    isDirect: true,
    ...inputRest,
    imageParts,
  };
  return {
    runId: 'run-1',
    queueKey: 'queue:group-1',
    actorKey: 'queue:group-1:user:u1',
    conversationId: 'conv-1',
    room: { conversationId: 'conv-1' },
    input,
    ...runOverrides,
  };
}

describe('ReplyRuntime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues the next run until the previous run finishes in queue mode', async () => {
    const runtime = new ReplyRuntime({
      stopConversationRequest: vi.fn(async () => undefined),
      drainOutbound: vi.fn(async () => undefined),
    });

    const first = await runtime.prepareRun({
      ...createArgs(),
      mode: 'queue',
    });
    expect(first.action).toBe('continue');

    let resolved = false;
    const nextRunPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        input: { text: '第二条', hasImageInput: false, imageCount: 0, displayName: '用户', userId: 'u1', isDirect: true },
      }),
      mode: 'queue',
    }).then((result) => {
      resolved = true;
      return result;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    runtime.finishRun('run-1');
    const nextRun = await nextRunPromise;

    expect(nextRun.action).toBe('continue');
    expect(nextRun.run?.id).toBe('run-2');
    expect(runtime.isCurrentRun('run-2')).toBe(true);
  });

  it('queues a different group speaker instead of interrupting the current run', async () => {
    const stopConversationRequest = vi.fn(async () => undefined);
    const runtime = new ReplyRuntime({
      stopConversationRequest,
      drainOutbound: vi.fn(async () => undefined),
      collectWindowMs: 50,
    });

    const first = await runtime.prepareRun({
      ...createArgs({
        input: { text: 'A', hasImageInput: false, imageCount: 0, displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });
    expect(first.action).toBe('continue');

    let secondResolved = false;
    const secondPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        actorKey: 'queue:group-1:user:u2',
        input: { text: 'B', hasImageInput: false, imageCount: 0, displayName: '乙', userId: 'u2', isDirect: false },
      }),
      mode: 'interrupt',
    }).then((result) => {
      secondResolved = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(60);
    await Promise.resolve();

    expect(stopConversationRequest).not.toHaveBeenCalled();
    expect(secondResolved).toBe(false);

    runtime.finishRun('run-1');
    await expect(secondPromise).resolves.toMatchObject({
      action: 'continue',
      inputText: 'B',
      continuationContext: undefined,
    });
  });

  it('does not enable first-reply quote for single-speaker group runs', async () => {
    const runtime = new ReplyRuntime({
      stopConversationRequest: vi.fn(async () => undefined),
      drainOutbound: vi.fn(async () => undefined),
    });

    const first = await runtime.prepareRun({
      ...createArgs({
        input: {
          text: 'A',
          hasImageInput: false,
          imageCount: 0,
          displayName: '甲',
          userId: 'u1',
          isDirect: false,
          messageId: 'msg-a',
        },
      }),
      mode: 'interrupt',
    });

    expect(first.run?.firstReplyQuote).toEqual({
      enabled: false,
      targetMessageId: 'msg-a',
      consumed: false,
    });
  });

  it('snapshots first-reply quote for queued multi-speaker group runs', async () => {
    const runtime = new ReplyRuntime({
      stopConversationRequest: vi.fn(async () => undefined),
      drainOutbound: vi.fn(async () => undefined),
      collectWindowMs: 50,
    });

    await runtime.prepareRun({
      ...createArgs({
        input: {
          text: 'A',
          hasImageInput: false,
          imageCount: 0,
          displayName: '甲',
          userId: 'u1',
          isDirect: false,
          messageId: 'msg-a',
        },
      }),
      mode: 'interrupt',
    });

    const secondPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        actorKey: 'queue:group-1:user:u2',
        input: {
          text: 'B',
          hasImageInput: false,
          imageCount: 0,
          displayName: '乙',
          userId: 'u2',
          isDirect: false,
          messageId: 'msg-b',
        },
      }),
      mode: 'interrupt',
    });

    runtime.finishRun('run-1');
    await expect(secondPromise).resolves.toMatchObject({
      action: 'continue',
      run: expect.objectContaining({
        firstReplyQuote: {
          enabled: true,
          targetMessageId: 'msg-b',
          consumed: false,
        },
      }),
    });
  });

  it('consumes first-reply quote on the first dispatched segment even when unsupported', async () => {
    const runtime = new ReplyRuntime({
      stopConversationRequest: vi.fn(async () => undefined),
      drainOutbound: vi.fn(async () => undefined),
      collectWindowMs: 50,
    });

    await runtime.prepareRun({
      ...createArgs({
        input: {
          text: 'A',
          hasImageInput: false,
          imageCount: 0,
          displayName: '甲',
          userId: 'u1',
          isDirect: false,
          messageId: 'msg-a',
        },
      }),
      mode: 'interrupt',
    });

    const secondPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        actorKey: 'queue:group-1:user:u2',
        input: {
          text: 'B',
          hasImageInput: false,
          imageCount: 0,
          displayName: '乙',
          userId: 'u2',
          isDirect: false,
          messageId: 'msg-b',
        },
      }),
      mode: 'interrupt',
    });

    runtime.finishRun('run-1');
    const second = await secondPromise;

    const secondRunId = second.run?.id;
    expect(runtime.consumeFirstReplyQuote(secondRunId, false)).toBeNull();
    expect(runtime.consumeFirstReplyQuote(secondRunId, true)).toBeNull();
  });

  it('starts computing the next queued speaker while the previous speaker is sending', async () => {
    const runtime = new ReplyRuntime({
      stopConversationRequest: vi.fn(async () => undefined),
      drainOutbound: vi.fn(async () => undefined),
      collectWindowMs: 50,
    });

    await runtime.prepareRun({
      ...createArgs({
        input: { text: 'A1', hasImageInput: false, imageCount: 0, displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });

    const speakerBPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        actorKey: 'queue:group-1:user:u2',
        input: { text: 'B1', hasImageInput: false, imageCount: 0, displayName: '乙', userId: 'u2', isDirect: false },
      }),
      mode: 'interrupt',
    });

    await vi.advanceTimersByTimeAsync(60);
    expect(runtime.completeCompute('run-1')).toBe(true);

    const sendSignal = runtime.beginSending('run-1');
    expect(sendSignal).not.toBeNull();

    await expect(speakerBPromise).resolves.toMatchObject({
      action: 'continue',
      run: expect.objectContaining({ id: 'run-2' }),
      inputText: 'B1',
    });
  });

  it('drops stale compute results and refreshes the cooldown window for repeated self-interruptions', async () => {
    const stopConversationRequest = vi.fn(async () => undefined);
    const runtime = new ReplyRuntime({
      stopConversationRequest,
      drainOutbound: vi.fn(async () => undefined),
      collectWindowMs: 50,
    });

    await runtime.prepareRun({
      ...createArgs({
        input: { text: 'A1', hasImageInput: false, imageCount: 0, displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });
    expect(runtime.completeCompute('run-1')).toBe(true);
    expect(runtime.beginSending('run-1')).not.toBeNull();

    const speakerB = await runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        actorKey: 'queue:group-1:user:u2',
        input: { text: 'B1', hasImageInput: false, imageCount: 0, displayName: '乙', userId: 'u2', isDirect: false },
      }),
      mode: 'interrupt',
    });
    expect(speakerB).toMatchObject({
      action: 'continue',
      run: expect.objectContaining({ id: 'run-2' }),
      inputText: 'B1',
    });

    let latestResolved = false;
    const earlierPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-3',
        actorKey: 'queue:group-1:user:u2',
        input: { text: 'B2', hasImageInput: false, imageCount: 0, displayName: '乙', userId: 'u2', isDirect: false },
      }),
      mode: 'interrupt',
    });

    expect(stopConversationRequest).toHaveBeenCalledTimes(1);
    expect(runtime.completeCompute('run-2')).toBe(false);

    await vi.advanceTimersByTimeAsync(40);
    await Promise.resolve();

    const latestPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-4',
        actorKey: 'queue:group-1:user:u2',
        input: { text: 'B3', hasImageInput: false, imageCount: 0, displayName: '乙', userId: 'u2', isDirect: false },
      }),
      mode: 'interrupt',
    }).then((result) => {
      latestResolved = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(40);
    await Promise.resolve();
    expect(latestResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(20);
    await expect(earlierPromise).resolves.toEqual({ action: 'stop' });
    await expect(latestPromise).resolves.toMatchObject({
      action: 'continue',
      inputText: 'B1\nB2\nB3',
      continuationContext: undefined,
    });
  });

  it('requeues self-interruption to the group tail behind other queued speakers', async () => {
    const stopConversationRequest = vi.fn(async () => undefined);
    const runtime = new ReplyRuntime({
      stopConversationRequest,
      drainOutbound: vi.fn(async () => undefined),
      collectWindowMs: 50,
    });

    await runtime.prepareRun({
      ...createArgs({
        input: { text: 'A1', hasImageInput: false, imageCount: 0, displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });

    const speakerBPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        actorKey: 'queue:group-1:user:u2',
        input: { text: 'B1', hasImageInput: false, imageCount: 0, displayName: '乙', userId: 'u2', isDirect: false },
      }),
      mode: 'interrupt',
    });

    await vi.advanceTimersByTimeAsync(60);

    let selfRerunResolved = false;
    const selfRerunPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-3',
        input: { text: 'A2', hasImageInput: false, imageCount: 0, displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    }).then((result) => {
      selfRerunResolved = true;
      return result;
    });

    const speakerB = await speakerBPromise;
    expect(speakerB).toMatchObject({
      action: 'continue',
      run: expect.objectContaining({ id: 'run-2' }),
      inputText: 'B1',
    });
    expect(stopConversationRequest).toHaveBeenCalledTimes(1);
    expect(runtime.isCurrentRun('run-1')).toBe(false);
    expect(selfRerunResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(60);
    runtime.finishRun('run-2');
    await expect(selfRerunPromise).resolves.toMatchObject({
      action: 'continue',
      run: expect.objectContaining({ id: 'run-3' }),
      inputText: 'A1\nA2',
      continuationContext: undefined,
    });
  });

  it('merges same-actor queued messages and only lets the latest carrier continue', async () => {
    const runtime = new ReplyRuntime({
      stopConversationRequest: vi.fn(async () => undefined),
      drainOutbound: vi.fn(async () => undefined),
      collectWindowMs: 50,
    });

    await runtime.prepareRun({
      ...createArgs({
        input: { text: 'A1', hasImageInput: false, imageCount: 0, displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });

    const speakerBPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        actorKey: 'queue:group-1:user:u2',
        input: { text: 'B1', hasImageInput: false, imageCount: 0, displayName: '乙', userId: 'u2', isDirect: false },
      }),
      mode: 'interrupt',
    });

    await vi.advanceTimersByTimeAsync(60);

    const earlierSelfPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-3',
        input: { text: 'A2', hasImageInput: false, imageCount: 0, displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });

    const latestSelfPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-4',
        input: { text: 'A3', hasImageInput: false, imageCount: 0, displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });

    await speakerBPromise;
    await vi.advanceTimersByTimeAsync(60);

    runtime.finishRun('run-2');
    await expect(earlierSelfPromise).resolves.toEqual({ action: 'stop' });
    await expect(latestSelfPromise).resolves.toMatchObject({
      action: 'continue',
      inputText: 'A1\nA2\nA3',
      continuationContext: undefined,
    });
  });

  it('builds actor-only continuation context when a sent reply is interrupted and requeued', async () => {
    const stopConversationRequest = vi.fn(async () => undefined);
    const runtime = new ReplyRuntime({
      stopConversationRequest,
      drainOutbound: vi.fn(async () => undefined),
      collectWindowMs: 50,
    });

    await runtime.prepareRun({
      ...createArgs({
        input: { text: '第一条', hasImageInput: false, imageCount: 0, displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });
    runtime.setPlannedUnitHistory('run-1', ['第一句', '第二句', '第三句']);
    expect(runtime.completeCompute('run-1')).toBe(true);
    const sendSignal = runtime.beginSending('run-1');
    runtime.recordCommittedUnit('run-1', '第一句');

    const speakerBPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        actorKey: 'queue:group-1:user:u2',
        input: { text: 'B1', hasImageInput: false, imageCount: 0, displayName: '乙', userId: 'u2', isDirect: false },
      }),
      mode: 'interrupt',
    });

    const earlierSelfPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-3',
        input: { text: '补充一', hasImageInput: false, imageCount: 0, displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });

    const latestSelfPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-4',
        input: { text: '最新问题', hasImageInput: false, imageCount: 0, displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });

    await vi.advanceTimersByTimeAsync(60);

    expect(sendSignal?.aborted).toBe(true);
    expect(stopConversationRequest).not.toHaveBeenCalled();
    await expect(speakerBPromise).resolves.toMatchObject({
      action: 'continue',
      inputText: 'B1',
    });

    await vi.advanceTimersByTimeAsync(60);
    runtime.finishRun('run-2');

    await expect(earlierSelfPromise).resolves.toEqual({ action: 'stop' });
    await expect(latestSelfPromise).resolves.toMatchObject({
      action: 'continue',
      inputText: '最新问题',
      continuationContext: {
        alreadySentText: '第一句',
        pendingUnitTexts: ['第二句', '第三句'],
        supplementalMessages: ['[speaker_id=u1 speaker_name="甲"] 补充一'],
      },
    });
  });

  it('allows forced cleanup to release a blocked queue and stays safe on repeated finishRun calls', async () => {
    const runtime = new ReplyRuntime({
      stopConversationRequest: vi.fn(async () => undefined),
      drainOutbound: vi.fn(async () => undefined),
      collectWindowMs: 50,
    });

    await runtime.prepareRun({
      ...createArgs({
        input: { text: 'A1', hasImageInput: false, imageCount: 0, displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });

    const speakerBPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        actorKey: 'queue:group-1:user:u2',
        input: { text: 'B1', hasImageInput: false, imageCount: 0, displayName: '乙', userId: 'u2', isDirect: false },
      }),
      mode: 'interrupt',
    });

    expect(runtime.finishRun('run-1')).toMatchObject({ id: 'run-1' });
    expect(runtime.finishRun('run-1')).toBeNull();

    await expect(speakerBPromise).resolves.toMatchObject({
      action: 'continue',
      run: expect.objectContaining({ id: 'run-2' }),
      inputText: 'B1',
    });
  });

  it('stops the active ChatLuna conversation and snapshots progress after outbound drain', async () => {
    const stopConversationRequest = vi.fn(async () => undefined);
    let releaseDrain: () => void = () => {};
    const drainOutbound = vi.fn(() => new Promise<void>((resolve) => {
      releaseDrain = resolve;
    }));
    const runtime = new ReplyRuntime({
      stopConversationRequest,
      drainOutbound,
      collectWindowMs: 50,
    });

    await runtime.prepareRun({ ...createArgs(), mode: 'interrupt' });
    const nextPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        input: {
          text: '再补一句',
          hasImageInput: false,
          imageCount: 0,
          hasVoiceInput: false,
          displayName: '用户',
          userId: 'u1',
          isDirect: true,
        },
      }),
      mode: 'interrupt',
    });

    await Promise.resolve();
    expect(stopConversationRequest).toHaveBeenCalledWith('conv-1');
    expect(drainOutbound).toHaveBeenCalledWith('queue:group-1');
    expect(runtime.recordProgressVisibleLine('run-1', '我搜一下。', 123)).toBe(true);
    releaseDrain();
    await vi.advanceTimersByTimeAsync(60);

    await expect(nextPromise).resolves.toMatchObject({
      action: 'continue',
      continuationContext: {
        progressVisibleLines: ['我搜一下。'],
      },
      run: {
        transientProgress: {
          visibleLines: ['我搜一下。'],
          lastSentAt: 123,
        },
      },
    });
  });

  it('does not start the collection window until interrupted outbound work has drained', async () => {
    let releaseDrain: () => void = () => {};
    const runtime = new ReplyRuntime({
      stopConversationRequest: vi.fn(async () => undefined),
      drainOutbound: vi.fn(() => new Promise<void>((resolve) => {
        releaseDrain = resolve;
      })),
      collectWindowMs: 50,
    });

    await runtime.prepareRun({ ...createArgs(), mode: 'interrupt' });
    const secondPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        input: {
          text: '第二条',
          hasImageInput: false,
          imageCount: 0,
          hasVoiceInput: false,
          displayName: '用户',
          userId: 'u1',
          isDirect: true,
        },
      }),
      mode: 'interrupt',
    });
    await Promise.resolve();

    let thirdResolved = false;
    const thirdPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-3',
        input: {
          text: '第三条',
          hasImageInput: false,
          imageCount: 0,
          hasVoiceInput: false,
          displayName: '用户',
          userId: 'u1',
          isDirect: true,
        },
      }),
      mode: 'interrupt',
    }).then((result) => {
      thirdResolved = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(thirdResolved).toBe(false);
    expect(runtime.recordProgressVisibleLine('run-1', '我还在查。', 123)).toBe(true);

    releaseDrain();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(49);
    expect(thirdResolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(secondPromise).resolves.toEqual({ action: 'stop' });
    await expect(thirdPromise).resolves.toMatchObject({
      action: 'continue',
      inputText: '第一条\n第二条\n第三条',
      continuationContext: {
        progressVisibleLines: ['我还在查。'],
      },
    });
  });

  it('preserves voice-input metadata when a text follow-up interrupts before model output', async () => {
    const runtime = new ReplyRuntime({
      stopConversationRequest: vi.fn(async () => undefined),
      drainOutbound: vi.fn(async () => undefined),
      collectWindowMs: 50,
    });

    await runtime.prepareRun({
      ...createArgs({
        input: {
          text: '语音转写内容',
          hasImageInput: false,
          imageCount: 0,
          hasVoiceInput: true,
          displayName: '用户',
          userId: 'u1',
          isDirect: true,
        },
      }),
      mode: 'interrupt',
    });
    const nextPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        input: {
          text: '还有一句',
          hasImageInput: false,
          imageCount: 0,
          hasVoiceInput: false,
          displayName: '用户',
          userId: 'u1',
          isDirect: true,
        },
      }),
      mode: 'interrupt',
    });

    await vi.advanceTimersByTimeAsync(60);
    await expect(nextPromise).resolves.toMatchObject({
      action: 'continue',
      inputText: '语音转写内容\n还有一句',
      run: {
        input: {
          text: '语音转写内容\n还有一句',
          hasVoiceInput: true,
        },
      },
    });
  });

  it('preserves image content owned by an interrupted input when the carrier is text-only', async () => {
    const runtime = new ReplyRuntime({
      stopConversationRequest: vi.fn(async () => undefined),
      drainOutbound: vi.fn(async () => undefined),
      collectWindowMs: 50,
    });
    const imagePart = {
      type: 'image_url' as const,
      image_url: { url: 'https://example.com/interrupted.png', detail: 'high' as const },
    };

    await runtime.prepareRun({
      ...createArgs({
        input: {
          text: '先看这张图',
          imageParts: [imagePart],
          hasImageInput: true,
          imageCount: 1,
          hasVoiceInput: false,
          displayName: '用户',
          userId: 'u1',
          isDirect: true,
        },
      }),
      mode: 'interrupt',
    });
    const nextPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        input: {
          text: '里面是什么？',
          imageParts: [],
          hasImageInput: false,
          imageCount: 0,
          hasVoiceInput: false,
          displayName: '用户',
          userId: 'u1',
          isDirect: true,
        },
      }),
      mode: 'interrupt',
    });

    await vi.advanceTimersByTimeAsync(60);
    await expect(nextPromise).resolves.toMatchObject({
      action: 'continue',
      run: {
        input: {
          text: '先看这张图\n里面是什么？',
          imageParts: [imagePart],
          hasImageInput: true,
          imageCount: 1,
        },
      },
    });
  });
});
