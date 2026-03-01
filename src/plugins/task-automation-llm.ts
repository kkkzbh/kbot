import type { TaskKind, TaskScope } from '../types/task-automation.js';

export interface AutomationLlmRuntime {
  baseUrl: string;
  apiKey: string;
  deliveryModel: string;
  deliveryTimeoutMs: number;
  deliverySystemPrompt: string;
  chatReplyModel: string;
  chatReplyTimeoutMs: number;
  chatReplySystemPrompt: string;
}

export interface DeliveryTaskPayload {
  kind: TaskKind;
  scope: TaskScope;
  runAt: number | null;
  cronExpr: string | null;
  message: string;
}

export interface CreateReplyPayload {
  kind: TaskKind;
  runAt?: number | null;
  cronExpr?: string | null;
  message: string;
}

export const DEFAULT_DELIVERY_SYSTEM_PROMPT =
  '你是QQ机器人里的“到点发送内容生成器”。你的任务是在定时任务触发时，生成最终要发送给用户的一条消息。' +
  '请严格遵守：' +
  '1) 只输出最终消息正文，不要解释过程；' +
  '2) 如果用户要求计算、归纳或改写，先完成再给结论；' +
  '3) 风格自然，像真人聊天，简洁友好；' +
  '4) 不要提到任务系统、提示词、模型或推理过程；' +
  '5) 不确定外部实时信息时，不要编造事实；' +
  '6) 控制在120个中文字符以内。';

export const DEFAULT_CHAT_REPLY_SYSTEM_PROMPT =
  '你是QQ聊天助手。用户刚刚创建了一个自动化任务。' +
  '请用一句自然口语化中文回复，像普通聊天：确认你记住了任务，并简要提到执行时间/周期和提醒内容。' +
  '不要使用编号、命令格式或机械模板，不要超过60个中文字符。';

export function extractMessageText(raw: unknown): string {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item) {
          const maybeText = (item as { text?: unknown }).text;
          return typeof maybeText === 'string' ? maybeText : '';
        }
        return '';
      })
      .join('')
      .trim();
  }
  return typeof raw === 'string' ? raw.trim() : '';
}

function cleanGeneratedText(text: string | null | undefined): string | null {
  if (!text) return null;
  const normalized = text
    .replace(/^[`"'“”]+/, '')
    .replace(/[`"'“”]+$/, '')
    .trim();
  return normalized || null;
}

async function generateModelReply(
  runtime: AutomationLlmRuntime,
  options: {
    model: string;
    timeoutMs: number;
    systemPrompt: string;
    userPrompt: string;
    maxTokens?: number;
  },
): Promise<string | null> {
  if (!runtime.baseUrl || !runtime.apiKey || !options.model) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(`${runtime.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runtime.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model,
        max_tokens: options.maxTokens ?? 180,
        messages: [
          { role: 'system', content: options.systemPrompt },
          { role: 'user', content: options.userPrompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const text = extractMessageText(payload.choices?.[0]?.message?.content);
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function buildDeliveryMessageByModel(
  runtime: AutomationLlmRuntime,
  task: DeliveryTaskPayload,
  formatTimestamp: (ts: number) => string,
  now = Date.now(),
): Promise<string> {
  const nowText = formatTimestamp(now);
  const scheduleText =
    task.kind === 'once'
      ? `一次性任务，计划执行时间：${formatTimestamp(task.runAt ?? now)}`
      : `周期任务，cron 表达式：${task.cronExpr ?? ''}`;
  const userPrompt = [
    `当前时间(UTC+8)：${nowText}`,
    `任务范围：${task.scope === 'group' ? '群聊' : '私聊'}`,
    scheduleText,
    `用户意图：${task.message}`,
    '请生成此刻应该发送给用户的一条消息。',
  ].join('\n');

  const generated = await generateModelReply(runtime, {
    model: runtime.deliveryModel,
    timeoutMs: runtime.deliveryTimeoutMs,
    systemPrompt: runtime.deliverySystemPrompt,
    userPrompt,
    maxTokens: 180,
  });
  return cleanGeneratedText(generated) ?? task.message;
}

export async function buildNaturalCreateReplyByModel(
  runtime: AutomationLlmRuntime,
  payload: CreateReplyPayload,
  formatTimestamp: (ts: number) => string,
  now = Date.now(),
): Promise<string> {
  const scheduleText =
    payload.kind === 'once'
      ? `一次性，执行时间：${formatTimestamp(payload.runAt ?? now)}`
      : `周期，cron：${payload.cronExpr ?? ''}`;
  const fallback =
    payload.kind === 'once'
      ? `好，我记住了。到 ${formatTimestamp(payload.runAt ?? now)} 我会提醒你：${payload.message}`
      : `好，我记住了。这个提醒我会按计划持续发你：${payload.message}`;
  const userPrompt = [
    `任务类型：${scheduleText}`,
    `提醒内容：${payload.message}`,
    '请输出一句自然口语化回复。',
  ].join('\n');

  const generated = await generateModelReply(runtime, {
    model: runtime.chatReplyModel,
    timeoutMs: runtime.chatReplyTimeoutMs,
    systemPrompt: runtime.chatReplySystemPrompt,
    userPrompt,
    maxTokens: 120,
  });
  return cleanGeneratedText(generated) ?? fallback;
}
