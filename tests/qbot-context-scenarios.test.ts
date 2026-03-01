import { describe, expect, it } from 'vitest';
import { injectUserStampedPrompt } from '../src/plugins/chat-time-context.js';
import {
  buildNaturalCreateFallbackReply,
  formatAutomationTimestamp,
  parseAutomationIntentByRule,
} from '../src/plugins/task-automation-core.js';

type SimTask = {
  id: number;
  kind: 'once' | 'cron';
  status: 'active' | 'paused' | 'deleted' | 'done';
  runAt?: number | null;
  cronExpr?: string | null;
  message: string;
};

type SimState = {
  tasks: SimTask[];
  nextId: number;
  pendingOnceGeneration: Array<{ taskId: number; rawMessage: string }>;
};

function preGenerateOnceMessage(raw: string): string {
  if (/1\s*\+\s*1/.test(raw)) return '2';
  return raw;
}

function renderTask(task: SimTask): string {
  if (task.kind === 'cron') {
    return `#${task.id} [${task.status}] cron(${task.cronExpr ?? ''}) ${task.message}`;
  }
  return `#${task.id} [${task.status}] ${formatAutomationTimestamp(task.runAt ?? Date.now())} ${task.message}`;
}

function renderTaskList(tasks: SimTask[]): string {
  const visible = tasks.filter((task) => task.status !== 'deleted');
  if (!visible.length) return '当前没有任务。';
  return ['当前任务：', ...visible.map((task) => `- ${renderTask(task)}`)].join('\n');
}

function handleChatMessage(state: SimState, message: string, now: number): string | null {
  const intent = parseAutomationIntentByRule(message, now);
  if (!intent) return null;

  if (intent.action === 'list') {
    return renderTaskList(state.tasks);
  }

  if (intent.action === 'create-once') {
    if (!intent.runAt || intent.runAt <= now) {
      return '创建失败：时间无效或已过。';
    }
    const rawMessage = intent.message ?? '定时提醒';
    state.tasks.push({
      id: state.nextId++,
      kind: 'once',
      status: 'active',
      runAt: intent.runAt,
      message: rawMessage,
    });
    state.pendingOnceGeneration.push({ taskId: state.nextId - 1, rawMessage });
    return buildNaturalCreateFallbackReply({
      kind: 'once',
      runAt: intent.runAt,
      message: rawMessage,
    }, now);
  }

  if (intent.action === 'create-cron') {
    state.tasks.push({
      id: state.nextId++,
      kind: 'cron',
      status: 'active',
      cronExpr: intent.cronExpr,
      message: intent.message ?? '定时提醒',
    });
    return buildNaturalCreateFallbackReply({
      kind: 'cron',
      cronExpr: intent.cronExpr,
      message: intent.message ?? '定时提醒',
    });
  }

  return null;
}

function runBackgroundOnceGeneration(state: SimState): void {
  for (const pending of state.pendingOnceGeneration.splice(0)) {
    const task = state.tasks.find((item) => item.id === pending.taskId && item.kind === 'once' && item.status === 'active');
    if (!task) continue;
    task.message = preGenerateOnceMessage(pending.rawMessage);
  }
}

function emitDueOnce(state: SimState, now: number): string[] {
  const due = state.tasks.filter((task) => task.kind === 'once' && task.status === 'active' && (task.runAt ?? 0) <= now);
  const outputs: string[] = [];
  for (const task of due) {
    outputs.push(task.message);
    task.status = 'done';
  }
  return outputs;
}

describe('QBOT context scenario regression', () => {
  it('injects user name and UTC+8 time into chat content', () => {
    const now = Date.parse('2026-03-01T16:40:16+08:00');
    const stamped = injectUserStampedPrompt('麻烦你在 10s 后给我打招呼', '小祥', now);
    expect(stamped).toBe('小祥, 2026-03-01 16:40:16: 麻烦你在 10s 后给我打招呼');
  });

  it('replays deterministic user-QBOT conversation without API key', () => {
    const now = Date.parse('2026-03-01T16:40:16+08:00');
    const state: SimState = { tasks: [] as SimTask[], nextId: 1, pendingOnceGeneration: [] };

    const transcript = [
      {
        user: '麻烦你在 10s 后给我发送1+1的计算结果',
        bot: handleChatMessage(state, '麻烦你在 10s 后给我发送1+1的计算结果', now),
      },
      {
        user: '每周一早上9点提醒我交周报',
        bot: handleChatMessage(state, '每周一早上9点提醒我交周报', now),
      },
      {
        event: 'bg.once.generate',
        bot: (() => {
          runBackgroundOnceGeneration(state);
          return 'ok';
        })(),
      },
      {
        event: 'due.once',
        bot: emitDueOnce(state, now + 10_000),
      },
      {
        user: '查看我的任务列表',
        bot: handleChatMessage(state, '查看我的任务列表', now),
      },
      {
        user: '现在16:38了',
        bot: handleChatMessage(state, '现在16:38了', now),
      },
    ];

    expect(transcript).toEqual([
      {
        user: '麻烦你在 10s 后给我发送1+1的计算结果',
        bot: '好，我记住了。到 16:40 我会提醒你：发送1+1的计算结果',
      },
      {
        user: '每周一早上9点提醒我交周报',
        bot: '好，我记住了。这个提醒我会按计划持续发你：交周报',
      },
      {
        event: 'bg.once.generate',
        bot: 'ok',
      },
      {
        event: 'due.once',
        bot: ['2'],
      },
      {
        user: '查看我的任务列表',
        bot: '当前任务：\n- #1 [done] 2026-03-01 16:40 2\n- #2 [active] cron(0 9 * * 1) 交周报',
      },
      {
        user: '现在16:38了',
        bot: null,
      },
    ]);
  });
});
