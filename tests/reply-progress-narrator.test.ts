import { describe, expect, it, vi } from 'vitest';

import {
  AgentProgressRun,
  ProgressPhraseBook,
  createAgentProgressCallbacksProvider,
} from '../src/plugins/reply/progress/narrator.js';
import { ReplyRuntime } from '../src/plugins/reply/runtime/index.js';

const CHATLUNA_AGENT_EVENT = 'chatluna-agent-event';

function action(tool: string) {
  return {
    tool,
    toolInput: {},
    log: '',
  };
}

describe('agent progress narrator', () => {
  it('emits one categorized start before the first tool batch', async () => {
    const sent: string[] = [];
    const run = new AgentProgressRun({
      conversationKey: 'conversation-1',
      requestId: 'request-1',
      phraseBook: new ProgressPhraseBook(),
      send: async (text) => {
        sent.push(text);
        return true;
      },
    });

    await run.onAgentEvent({ type: 'tool-call', actions: [action('web_search')] });
    await run.onAgentEvent({ type: 'tool-call', actions: [action('read_document')] });
    await run.onAgentEvent({ type: 'done' });

    expect(sent).toHaveLength(1);
    expect(['我搜一下。', '等我查一下。', '我去翻翻看。']).toContain(sent[0]);
  });

  it('avoids recently used phrases for the same conversation', () => {
    const phraseBook = new ProgressPhraseBook();
    const phrases = [
      phraseBook.pick('start:search', 'conversation-1', 'request-1'),
      phraseBook.pick('start:search', 'conversation-1', 'request-2'),
      phraseBook.pick('start:search', 'conversation-1', 'request-3'),
    ];

    expect(new Set(phrases).size).toBe(3);
  });

  it('bounds phrase history by conversation', () => {
    const phraseBook = new ProgressPhraseBook(2);
    const first = phraseBook.pick('start:search', 'conversation-1', 'request-1');
    phraseBook.pick('start:search', 'conversation-2', 'request-2');
    phraseBook.pick('start:search', 'conversation-3', 'request-3');

    expect(phraseBook.pick('start:search', 'conversation-1', 'request-1')).toBe(first);
  });

  it('emits a neutral continuation only after a result, a continue decision, and the delay', async () => {
    let now = 0;
    const sent: string[] = [];
    const run = new AgentProgressRun({
      conversationKey: 'conversation-1',
      requestId: 'request-1',
      phraseBook: new ProgressPhraseBook(),
      now: () => now,
      continuationDelayMs: 4_500,
      send: async (text) => {
        sent.push(text);
        return true;
      },
    });

    await run.onAgentEvent({ type: 'tool-call', actions: [action('history_lookup')] });
    now = 4_000;
    await run.onAgentEvent({ type: 'round-decision', canContinue: true });
    expect(sent).toHaveLength(1);

    await run.onAgentEvent({
      type: 'tool-result',
      steps: [{ action: action('history_lookup'), observation: 'ERROR: provider unavailable' }],
    });
    now = 4_499;
    await run.onAgentEvent({ type: 'round-decision', canContinue: true });
    expect(sent).toHaveLength(1);

    now = 4_500;
    await run.onAgentEvent({ type: 'round-decision', canContinue: true });
    expect(sent).toHaveLength(2);
    expect(['我再翻一下记录。', '我接着理一下。']).toContain(sent[1]);

    await run.onAgentEvent({ type: 'tool-call', actions: [action('history_lookup')] });
    expect(sent).toHaveLength(2);
    await run.onAgentEvent({ type: 'done' });
  });

  it('reports a genuinely long-running tool without inventing a result', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const run = new AgentProgressRun({
      conversationKey: 'conversation-long-tool',
      requestId: 'request-long-tool',
      phraseBook: new ProgressPhraseBook(),
      waitUpdateDelayMs: 8_000,
      send: async (text) => {
        sent.push(text);
        return true;
      },
    });

    try {
      await run.onAgentEvent({ type: 'tool-call', actions: [action('read_document')] });
      await vi.advanceTimersByTimeAsync(7_999);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatch(/还在看|还没看完/u);
      await run.onAgentEvent({
        type: 'tool-result',
        steps: [{ action: action('read_document'), observation: 'done' }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts events only from the exact main request context', async () => {
    const send = vi.fn(async () => true);
    const provider = createAgentProgressCallbacksProvider({
      resolveReplyRunId: () => 'reply-run-1',
      resolveInitialState: () => ({ messageCount: 0, lastMessageAt: 0 }),
      send,
    });
    const callbacks = await provider({
      session: {
        platform: 'onebot',
        state: { qqReplyV2: { route: 'agent' } },
      },
      conversation: { id: 'conversation-1' },
      requestId: 'request-1',
    } as never);

    expect(callbacks).toBeDefined();
    const event = { type: 'tool-call' as const, actions: [action('web_search')] };
    await callbacks!.handleCustomEvent!(CHATLUNA_AGENT_EVENT, {
      context: { kind: 'subagent', requestId: 'request-1' },
      event,
    }, 'callback-run');
    await callbacks!.handleCustomEvent!(CHATLUNA_AGENT_EVENT, {
      context: { kind: 'main', requestId: 'another-request' },
      event,
    }, 'callback-run');
    await callbacks!.handleCustomEvent!(CHATLUNA_AGENT_EVENT, {
      context: { kind: 'main' },
      event,
    }, 'callback-run');
    await callbacks!.handleCustomEvent!(CHATLUNA_AGENT_EVENT, {
      context: { requestId: 'request-1' },
      event,
    }, 'callback-run');
    expect(send).not.toHaveBeenCalled();

    await callbacks!.handleCustomEvent!(CHATLUNA_AGENT_EVENT, {
      context: { kind: 'main', requestId: 'request-1' },
      event,
    }, 'callback-run');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      replyRunId: 'reply-run-1',
      text: expect.any(String),
    }));
    await callbacks!.handleCustomEvent!(CHATLUNA_AGENT_EVENT, {
      context: { kind: 'main', requestId: 'request-1' },
      event: { type: 'done' },
    }, 'callback-run');
  });

  it('cancels pending wait updates when a reply run or provider is disposed', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => true);
    const provider = createAgentProgressCallbacksProvider({
      resolveReplyRunId: () => 'reply-run-1',
      resolveInitialState: () => ({ messageCount: 0, lastMessageAt: 0 }),
      send,
    });
    const callbacks = await provider({
      session: {
        platform: 'onebot',
        state: { qqReplyV2: { route: 'agent' } },
      },
      conversation: { id: 'conversation-1' },
      requestId: 'request-1',
    } as never);

    try {
      await callbacks!.handleCustomEvent!(CHATLUNA_AGENT_EVENT, {
        context: { kind: 'main', requestId: 'request-1' },
        event: { type: 'tool-call', actions: [action('web_search')] },
      }, 'callback-run');
      expect(send).toHaveBeenCalledTimes(1);
      provider.disposeRun('reply-run-1');
      await vi.advanceTimersByTimeAsync(8_000);
      expect(send).toHaveBeenCalledTimes(1);

      provider.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues progress across an interrupted run without repeating the opening', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const sent: string[] = [];
    const runtime = new ReplyRuntime({
      stopConversationRequest: vi.fn(async () => undefined),
      drainOutbound: vi.fn(async () => undefined),
      collectWindowMs: 50,
    });
    const phraseBook = new ProgressPhraseBook();

    try {
      await runtime.prepareRun({
        runId: 'run-1',
        queueKey: 'queue:private-1',
        actorKey: 'queue:private-1:user:u1',
        conversationId: 'conversation-1',
        room: { conversationId: 'conversation-1' },
        input: {
          text: '帮我查今天的天气',
          imageParts: [],
          hasImageInput: false,
          imageCount: 0,
          hasVoiceInput: false,
          displayName: '用户',
          userId: 'u1',
          isDirect: true,
        },
        mode: 'interrupt',
      });
      const firstNarrator = new AgentProgressRun({
        conversationKey: 'conversation-1',
        requestId: 'request-1',
        phraseBook,
        now: () => now,
        send: async (text) => {
          if (!runtime.isCurrentRun('run-1')) return false;
          sent.push(text);
          expect(runtime.recordProgressVisibleLine('run-1', text, now)).toBe(true);
          return true;
        },
      });
      await firstNarrator.onAgentEvent({ type: 'tool-call', actions: [action('web_search')] });
      expect(sent).toHaveLength(1);
      expect(runtime.getCommittedHistoryText('run-1')).toBe('');

      const nextRunPromise = runtime.prepareRun({
        runId: 'run-2',
        queueKey: 'queue:private-1',
        actorKey: 'queue:private-1:user:u1',
        conversationId: 'conversation-1',
        room: { conversationId: 'conversation-1' },
        input: {
          text: '还有明天的',
          imageParts: [],
          hasImageInput: false,
          imageCount: 0,
          hasVoiceInput: false,
          displayName: '用户',
          userId: 'u1',
          isDirect: true,
        },
        mode: 'interrupt',
      });
      await vi.advanceTimersByTimeAsync(50);
      const next = await nextRunPromise;
      expect(next).toMatchObject({
        action: 'continue',
        inputText: '帮我查今天的天气\n还有明天的',
        continuationContext: {
          alreadySentText: '',
          pendingUnitTexts: [],
          supplementalMessages: [],
          progressVisibleLines: [sent[0]],
        },
      });
      expect(next.run?.transientProgress.visibleLines).toEqual([sent[0]]);
      expect(runtime.getCommittedHistoryText('run-2')).toBe('');

      const inherited = runtime.getProgressState('run-2');
      expect(inherited).not.toBeNull();
      now = 1_100;
      const nextNarrator = new AgentProgressRun({
        conversationKey: 'conversation-1',
        requestId: 'request-2',
        phraseBook,
        now: () => now,
        waitUpdateDelayMs: 8_000,
        initialState: {
          messageCount: inherited!.visibleLines.length,
          lastMessageAt: inherited!.lastSentAt ?? 0,
        },
        send: async (text) => {
          if (!runtime.isCurrentRun('run-2')) return false;
          sent.push(text);
          expect(runtime.recordProgressVisibleLine('run-2', text, now)).toBe(true);
          return true;
        },
      });
      await nextNarrator.onAgentEvent({ type: 'tool-call', actions: [action('weather_search')] });
      expect(sent).toHaveLength(1);

      now = 9_100;
      await vi.advanceTimersByTimeAsync(8_000);
      expect(sent).toHaveLength(2);
      await nextNarrator.onAgentEvent({ type: 'tool-call', actions: [action('weather_search')] });
      expect(sent).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
