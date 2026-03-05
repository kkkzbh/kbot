import { describe, expect, it } from 'vitest';
import { injectUserStampedPrompt } from '../src/plugins/chat-time-context.js';
import { sanitizeLeakedReasoningMessage } from '../src/plugins/message-send-utils.js';
import { formatAutomationTimestamp, parseAutomationIntentByRule } from '../src/plugins/task-automation-core.js';

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
  const visible = tasks.filter((task) => task.status === 'active' || task.status === 'paused');
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
    return null;
  }

  if (intent.action === 'create-cron') {
    state.tasks.push({
      id: state.nextId++,
      kind: 'cron',
      status: 'active',
      cronExpr: intent.cronExpr,
      message: intent.message ?? '定时提醒',
    });
    return null;
  }

  return null;
}

function runBackgroundOnceGeneration(state: SimState): void {
  for (const task of state.tasks) {
    if (task.kind !== 'once' || task.status !== 'active') continue;
    task.message = preGenerateOnceMessage(task.message);
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

  it('replays deterministic user-QBOT conversation without API key (create reply passes through)', () => {
    const now = Date.parse('2026-03-01T16:40:16+08:00');
    const state: SimState = { tasks: [] as SimTask[], nextId: 1 };

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
        user: '今天天气怎么样',
        bot: handleChatMessage(state, '今天天气怎么样', now),
      },
      {
        user: '现在16:38了',
        bot: handleChatMessage(state, '现在16:38了', now),
      },
    ];

    expect(transcript).toEqual([
      {
        user: '麻烦你在 10s 后给我发送1+1的计算结果',
        bot: null,
      },
      {
        user: '每周一早上9点提醒我交周报',
        bot: null,
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
        bot: '当前任务：\n- #2 [active] cron(0 9 * * 1) 交周报',
      },
      {
        user: '今天天气怎么样',
        bot: null,
      },
      {
        user: '现在16:38了',
        bot: null,
      },
    ]);
  });

  it('replays guided-search conversation and strips leaked reasoning reply', () => {
    const transcript = [
      {
        user: '祥，你可以上网搜索东西吗？',
        qbot: '可以啊...你想让我搜什么？',
      },
      {
        user: '现在还会出问题吗？你搜一下',
        raw:
          '用户让我搜索东西，但没说具体搜什么。根据之前的对话，用户曾让我搜索“三角初音”和“高康嘉”，但搜索工具似乎有问题。现在用户问“现在还会出问题吗？你搜一下”，但没有指定搜索内容。我需要确认用户想让我搜索什么具体内容。',
        qbot: sanitizeLeakedReasoningMessage(
          '用户让我搜索东西，但没说具体搜什么。根据之前的对话，用户曾让我搜索“三角初音”和“高康嘉”，但搜索工具似乎有问题。现在用户问“现在还会出问题吗？你搜一下”，但没有指定搜索内容。我需要确认用户想让我搜索什么具体内容。',
        ),
      },
      {
        user: '你搜一下 彩叶与绯叶是谁',
        raw: '我先帮你搜了一下，给你整理一版简要结果。',
        qbot: sanitizeLeakedReasoningMessage('我先帮你搜了一下，给你整理一版简要结果。'),
      },
    ];

    expect(transcript).toEqual([
      {
        user: '祥，你可以上网搜索东西吗？',
        qbot: '可以啊...你想让我搜什么？',
      },
      {
        user: '现在还会出问题吗？你搜一下',
        raw:
          '用户让我搜索东西，但没说具体搜什么。根据之前的对话，用户曾让我搜索“三角初音”和“高康嘉”，但搜索工具似乎有问题。现在用户问“现在还会出问题吗？你搜一下”，但没有指定搜索内容。我需要确认用户想让我搜索什么具体内容。',
        qbot: '你想让我搜什么具体内容呢？',
      },
      {
        user: '你搜一下 彩叶与绯叶是谁',
        raw: '我先帮你搜了一下，给你整理一版简要结果。',
        qbot: '我先帮你搜了一下，给你整理一版简要结果。',
      },
    ]);
  });
});
