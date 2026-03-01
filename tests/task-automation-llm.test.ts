import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationLlmRuntime, CreateReplyPayload, DeliveryTaskPayload } from '../src/plugins/task-automation-llm.js';
import {
  buildDeliveryMessageByModel,
  buildNaturalCreateReplyByModel,
  extractMessageText,
} from '../src/plugins/task-automation-llm.js';

function formatUtc8Timestamp(ts: number): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts));
  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  return `${lookup.get('year')}-${lookup.get('month')}-${lookup.get('day')} ${lookup.get('hour')}:${lookup.get('minute')}`;
}

function createRuntime(): AutomationLlmRuntime {
  return {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test',
    deliveryModel: 'deepseek-reasoner',
    deliveryTimeoutMs: 18000,
    deliveryMaxTokens: 10000,
    deliverySystemPrompt: 'delivery prompt',
    chatReplyModel: 'deepseek-reasoner',
    chatReplyTimeoutMs: 12000,
    chatReplyMaxTokens: 10000,
    chatReplySystemPrompt: 'reply prompt',
  };
}

describe('task automation model delivery behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts text content from array-style model response', () => {
    const content = extractMessageText([
      { text: '第一段，' },
      { text: '第二段。' },
    ]);
    expect(content).toBe('第一段，第二段。');
  });

  it('builds final delivery text from model output when available', async () => {
    const runtime = createRuntime();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '“1+1 = 2，结果是 2。”' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const task: DeliveryTaskPayload = {
      kind: 'once',
      scope: 'private',
      runAt: new Date('2026-03-01T17:22:00+08:00').getTime(),
      cronExpr: null,
      message: '发送1+1的计算结果',
    };

    const text = await buildDeliveryMessageByModel(runtime, task, formatUtc8Timestamp);
    expect(text).toBe('1+1 = 2，结果是 2。');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, reqInit] = fetchMock.mock.calls[0] ?? [];
    const body =
      reqInit && typeof reqInit === 'object' && 'body' in reqInit && typeof reqInit.body === 'string'
        ? JSON.parse(reqInit.body)
        : null;
    expect(body?.model).toBe('deepseek-reasoner');
    expect(body?.max_tokens).toBe(10000);
    const userPrompt = body?.messages?.[1]?.content as string;
    expect(userPrompt).toContain('用户意图：发送1+1的计算结果');
  });

  it('falls back to raw task message when model request fails', async () => {
    const runtime = createRuntime();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    const task: DeliveryTaskPayload = {
      kind: 'once',
      scope: 'private',
      runAt: new Date('2026-03-01T17:30:00+08:00').getTime(),
      cronExpr: null,
      message: '提醒我喝水',
    };

    const text = await buildDeliveryMessageByModel(runtime, task, formatUtc8Timestamp);
    expect(text).toBe('提醒我喝水');
  });

  it('generates natural create-reply text and keeps fallback on failure', async () => {
    const runtime = createRuntime();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '放心，我记住了，到点就把1+1结果发你。' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response('', { status: 503 }));

    const runAt = new Date('2026-03-01T17:22:00+08:00').getTime();
    const firstPayload: CreateReplyPayload = {
      kind: 'once',
      runAt,
      message: '发送1+1的计算结果',
    };
    const first = await buildNaturalCreateReplyByModel(
      runtime,
      firstPayload,
      formatUtc8Timestamp,
      new Date('2026-03-01T16:00:00+08:00').getTime(),
    );
    expect(first).toBe('放心，我记住了，到点就把1+1结果发你。');

    const secondPayload: CreateReplyPayload = {
      kind: 'once',
      runAt,
      message: '提醒我喝水',
    };
    const second = await buildNaturalCreateReplyByModel(
      runtime,
      secondPayload,
      formatUtc8Timestamp,
      new Date('2026-03-01T16:00:00+08:00').getTime(),
    );
    expect(second).toContain('提醒我喝水');
    expect(second).toContain('17:22');
    expect(second).not.toContain('2026-03-01');

    const firstReq = fetchSpy.mock.calls[0]?.[1];
    const firstBody =
      firstReq && typeof firstReq === 'object' && 'body' in firstReq && typeof firstReq.body === 'string'
        ? JSON.parse(firstReq.body)
        : null;
    expect(firstBody?.max_tokens).toBe(10000);
  });

  it('supports create-once pre-generation then direct send from stored content', async () => {
    const runtime = createRuntime();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '2' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const createdFinalMessage = await buildDeliveryMessageByModel(
      runtime,
      {
        kind: 'once',
        scope: 'private',
        runAt: new Date('2026-03-01T18:00:00+08:00').getTime(),
        cronExpr: null,
        message: '发送1+1的计算结果',
      },
      formatUtc8Timestamp,
    );

    const taskRecord = {
      kind: 'once',
      message: createdFinalMessage,
    };

    const delivered = taskRecord.message;
    expect(delivered).toBe('2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
