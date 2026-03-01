import 'koishi-plugin-cron';
import { Context, h, Logger, Schema, Session } from 'koishi';
import { parseExpression } from 'cron-parser';
import type { AutomationTask, TaskScope } from '../types/task-automation.js';
import {
  AutomationIntent,
  isValidCronExpr,
  normalizeGroupId,
  parseAutomationIntentByRule,
  parseCronExpr,
  parseGroupSet,
  parseOnceRunAt,
  selectDeliveryModelForTaskMessage,
  shouldTryAutomationIntent,
} from './task-automation-core.js';
import {
  DEFAULT_CHAT_REPLY_SYSTEM_PROMPT,
  DEFAULT_DELIVERY_SYSTEM_PROMPT,
  buildDeliveryMessageByModel,
  buildNaturalCreateReplyByModel,
  extractMessageText,
  type AutomationLlmRuntime,
} from './task-automation-llm.js';

const logger = new Logger('task-automation');
const SHORT_ONCE_TASK_WINDOW_MS = 60_000;
const SHORT_ONCE_DELIVERY_TIMEOUT_MS = 2500;
const ONCE_PRELOAD_WINDOW_MS = 5 * 60_000;

export const name = 'task-automation';
export const inject = ['database'];

export interface Config {
  enabledGroups?: string[] | string;
  listenPrivate?: boolean;
  permissionMode?: 'all' | 'authority3';
  intentEnabled?: boolean;
  intentMinConfidence?: number;
  intentBaseUrl?: string;
  intentApiKey?: string;
  intentModel?: string;
  intentTimeoutMs?: number;
  pollIntervalMs?: number;
  maxTasksPerUser?: number;
  deliveryBaseUrl?: string;
  deliveryApiKey?: string;
  deliveryModel?: string;
  deliveryFastModel?: string;
  deliveryTimeoutMs?: number;
  deliveryMaxTokens?: number;
  deliverySystemPrompt?: string;
  chatReplyModel?: string;
  chatReplyTimeoutMs?: number;
  chatReplyMaxTokens?: number;
  chatReplySystemPrompt?: string;
}

export const Config: Schema<Config> = Schema.object({
  enabledGroups: Schema.union([
    Schema.array(Schema.string()).role('table').description('允许自动化生效的群号列表。'),
    Schema.string().description('允许自动化生效的群号（逗号分隔）。'),
  ]).description('自动化白名单群。'),
  listenPrivate: Schema.boolean().default(true).description('是否允许私聊智能创建/管理任务。'),
  permissionMode: Schema.union([Schema.const('all'), Schema.const('authority3')])
    .default('all')
    .description('任务权限模式。all=所有成员，authority3=仅 authority>=3。'),
  intentEnabled: Schema.boolean().default(true).description('是否启用自然语言意图判定。'),
  intentMinConfidence: Schema.number().min(0).max(1).default(0.78).description('模型意图最小置信度。'),
  intentBaseUrl: Schema.string()
    .role('link')
    .description('意图判定模型 API Base URL（默认复用 OPENAI_BASE_URL）。'),
  intentApiKey: Schema.string().role('secret').description('意图判定模型 API Key（默认复用 OPENAI_API_KEY）。'),
  intentModel: Schema.string().description('意图判定模型名（默认复用 OPENAI_MODEL）。'),
  intentTimeoutMs: Schema.natural().role('time').default(12000).description('意图模型超时（毫秒）。'),
  pollIntervalMs: Schema.natural().role('time').default(30000).description('一次性任务轮询周期（毫秒）。'),
  maxTasksPerUser: Schema.natural().default(20).description('每个用户允许的任务上限（active+paused）。'),
  deliveryBaseUrl: Schema.string()
    .role('link')
    .description('到点文案生成模型 API Base URL（默认复用 OPENAI_BASE_URL）。'),
  deliveryApiKey: Schema.string().role('secret').description('到点文案生成模型 API Key（默认复用 OPENAI_API_KEY）。'),
  deliveryModel: Schema.string().default('deepseek-reasoner').description('到点文案生成模型（默认 deepseek-reasoner）。'),
  deliveryFastModel: Schema.string().default('deepseek-chat').description('到点文案快速模型（默认 deepseek-chat）。'),
  deliveryTimeoutMs: Schema.natural().role('time').default(18000).description('到点文案生成模型超时（毫秒）。'),
  deliveryMaxTokens: Schema.natural().default(10000).description('到点文案生成模型 max_tokens（默认 10000）。'),
  deliverySystemPrompt: Schema.string().description('到点文案生成 system prompt（可选覆盖默认值）。'),
  chatReplyModel: Schema.string().default('deepseek-reasoner').description('自动化创建回复模型（默认 deepseek-reasoner）。'),
  chatReplyTimeoutMs: Schema.natural().role('time').default(12000).description('自动化创建回复模型超时（毫秒）。'),
  chatReplyMaxTokens: Schema.natural().default(10000).description('自动化创建回复模型 max_tokens（默认 10000）。'),
  chatReplySystemPrompt: Schema.string().description('自动化创建回复 system prompt（可选覆盖默认值）。'),
});

interface RuntimeConfig {
  enabledGroups: Set<string>;
  listenPrivate: boolean;
  permissionMode: 'all' | 'authority3';
  intentEnabled: boolean;
  intentMinConfidence: number;
  intentBaseUrl: string;
  intentApiKey: string;
  intentModel: string;
  intentTimeoutMs: number;
  pollIntervalMs: number;
  maxTasksPerUser: number;
  deliveryBaseUrl: string;
  deliveryApiKey: string;
  deliveryModel: string;
  deliveryFastModel: string;
  deliveryTimeoutMs: number;
  deliveryMaxTokens: number;
  deliverySystemPrompt: string;
  chatReplyModel: string;
  chatReplyTimeoutMs: number;
  chatReplyMaxTokens: number;
  chatReplySystemPrompt: string;
}

interface ScopeContext {
  scope: TaskScope;
  channelId: string;
  guildId: string;
}

interface ModelIntentResponse {
  action?: string;
  confidence?: number;
  runAt?: string | number;
  cronExpr?: string;
  message?: string;
  taskId?: number | string;
  timeText?: string;
}

const FIXED_TIMEZONE = 'Asia/Shanghai';

function toRuntimeConfig(config: Config): RuntimeConfig {
  const configuredIntentModel = config.intentModel?.trim();
  const envIntentModel = process.env.TASK_AUTOMATION_INTENT_MODEL?.trim() || process.env.OPENAI_MODEL?.trim();
  const baseUrl = (config.intentBaseUrl ?? process.env.TASK_AUTOMATION_INTENT_BASE_URL ?? process.env.OPENAI_BASE_URL ?? '')
    .replace(/\/+$/, '');
  const apiKey = config.intentApiKey ?? process.env.TASK_AUTOMATION_INTENT_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
  const model = configuredIntentModel || envIntentModel || '';
  const configuredDeliveryModel = config.deliveryModel?.trim();
  const envDeliveryModel = process.env.TASK_AUTOMATION_DELIVERY_MODEL?.trim();
  const configuredDeliveryFastModel = config.deliveryFastModel?.trim();
  const envDeliveryFastModel = process.env.TASK_AUTOMATION_DELIVERY_FAST_MODEL?.trim();
  const configuredChatReplyModel = config.chatReplyModel?.trim();
  const envChatReplyModel = process.env.TASK_AUTOMATION_CHAT_REPLY_MODEL?.trim();
  const deliveryBaseUrl = (
    config.deliveryBaseUrl ??
    process.env.TASK_AUTOMATION_DELIVERY_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    baseUrl
  ).replace(/\/+$/, '');
  const deliveryApiKey =
    config.deliveryApiKey ??
    process.env.TASK_AUTOMATION_DELIVERY_API_KEY ??
    process.env.OPENAI_API_KEY ??
    apiKey;
  const deliveryModel = configuredDeliveryModel || envDeliveryModel || 'deepseek-reasoner';
  const deliveryFastModel = configuredDeliveryFastModel || envDeliveryFastModel || 'deepseek-chat';
  const chatReplyModel = configuredChatReplyModel || envChatReplyModel || deliveryModel;
  const envDeliveryPrompt = process.env.TASK_AUTOMATION_DELIVERY_SYSTEM_PROMPT?.trim();
  const envChatReplyPrompt = process.env.TASK_AUTOMATION_CHAT_REPLY_SYSTEM_PROMPT?.trim();
  const deliverySystemPrompt = config.deliverySystemPrompt?.trim() || envDeliveryPrompt || DEFAULT_DELIVERY_SYSTEM_PROMPT;
  const chatReplySystemPrompt = config.chatReplySystemPrompt?.trim() || envChatReplyPrompt || DEFAULT_CHAT_REPLY_SYSTEM_PROMPT;

  return {
    enabledGroups: parseGroupSet(config.enabledGroups ?? process.env.CHAT_ENABLED_GROUPS),
    listenPrivate:
      config.listenPrivate ?? String(process.env.TASK_AUTOMATION_LISTEN_PRIVATE ?? 'true').toLowerCase() !== 'false',
    permissionMode:
      (config.permissionMode ?? (process.env.TASK_AUTOMATION_PERMISSION === 'authority3' ? 'authority3' : 'all')) ===
      'authority3'
        ? 'authority3'
        : 'all',
    intentEnabled:
      config.intentEnabled ?? String(process.env.TASK_AUTOMATION_INTENT_ENABLED ?? 'true').toLowerCase() !== 'false',
    intentMinConfidence: config.intentMinConfidence ?? Number(process.env.TASK_AUTOMATION_INTENT_MIN_CONFIDENCE || 0.78),
    intentBaseUrl: baseUrl,
    intentApiKey: apiKey,
    intentModel: model,
    intentTimeoutMs: config.intentTimeoutMs ?? Number(process.env.TASK_AUTOMATION_INTENT_TIMEOUT_MS || 12000),
    pollIntervalMs: config.pollIntervalMs ?? Number(process.env.TASK_AUTOMATION_POLL_MS || 30000),
    maxTasksPerUser: config.maxTasksPerUser ?? Number(process.env.TASK_AUTOMATION_MAX_TASKS_PER_USER || 20),
    deliveryBaseUrl,
    deliveryApiKey,
    deliveryModel,
    deliveryFastModel,
    deliveryTimeoutMs: config.deliveryTimeoutMs ?? Number(process.env.TASK_AUTOMATION_DELIVERY_TIMEOUT_MS || 18000),
    deliveryMaxTokens: config.deliveryMaxTokens ?? Number(process.env.TASK_AUTOMATION_DELIVERY_MAX_TOKENS || 10000),
    deliverySystemPrompt,
    chatReplyModel,
    chatReplyTimeoutMs:
      config.chatReplyTimeoutMs ?? Number(process.env.TASK_AUTOMATION_CHAT_REPLY_TIMEOUT_MS || 12000),
    chatReplyMaxTokens:
      config.chatReplyMaxTokens ?? Number(process.env.TASK_AUTOMATION_CHAT_REPLY_MAX_TOKENS || 10000),
    chatReplySystemPrompt,
  };
}

function formatTimestamp(ts: number): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: FIXED_TIMEZONE,
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

function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) ?? raw.match(/```\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return null;
}

function normalizeMessageContent(session: Session): string {
  const plain = session.stripped?.content?.trim();
  if (plain) return plain;
  return session.content?.trim() ?? '';
}

function toAutomationLlmRuntime(runtime: RuntimeConfig): AutomationLlmRuntime {
  return {
    baseUrl: runtime.deliveryBaseUrl,
    apiKey: runtime.deliveryApiKey,
    deliveryModel: runtime.deliveryModel,
    deliveryTimeoutMs: runtime.deliveryTimeoutMs,
    deliveryMaxTokens: runtime.deliveryMaxTokens,
    deliverySystemPrompt: runtime.deliverySystemPrompt,
    chatReplyModel: runtime.chatReplyModel,
    chatReplyTimeoutMs: runtime.chatReplyTimeoutMs,
    chatReplyMaxTokens: runtime.chatReplyMaxTokens,
    chatReplySystemPrompt: runtime.chatReplySystemPrompt,
  };
}

function resolveScopeContext(session: Session, runtime: RuntimeConfig): ScopeContext | null {
  if (!session.channelId) return null;
  if (session.isDirect) {
    if (!runtime.listenPrivate) return null;
    return { scope: 'private', channelId: session.channelId, guildId: '' };
  }

  const groupId = normalizeGroupId(session.guildId) ?? normalizeGroupId(session.channelId);
  if (!groupId || !runtime.enabledGroups.has(groupId)) return null;
  return { scope: 'group', channelId: session.channelId, guildId: session.guildId ?? '' };
}

async function checkPermission(session: Session, runtime: RuntimeConfig): Promise<boolean> {
  if (runtime.permissionMode === 'all') return true;
  try {
    const user = await session.observeUser(['authority']);
    return (user.authority ?? 0) >= 3;
  } catch {
    return false;
  }
}

function isCommandLike(content: string): boolean {
  return /^[./][\w-]+/.test(content);
}

function taskText(task: AutomationTask): string {
  if (task.kind === 'cron') {
    return `#${task.id} [${task.status}] cron(${task.cronExpr}) ${task.message}`;
  }
  return `#${task.id} [${task.status}] ${formatTimestamp(task.runAt ?? Date.now())} ${task.message}`;
}

function isVisibleInTaskList(task: AutomationTask): boolean {
  return task.status === 'active' || task.status === 'paused';
}

async function buildDeliveryMessage(task: AutomationTask, runtime: RuntimeConfig): Promise<string> {
  const llmRuntime = toAutomationLlmRuntime(runtime);
  llmRuntime.deliveryModel = selectDeliveryModelForTaskMessage(
    task.message,
    runtime.deliveryModel,
    runtime.deliveryFastModel,
  );
  return buildDeliveryMessageByModel(
    llmRuntime,
    {
      kind: task.kind,
      scope: task.scope,
      runAt: task.runAt ?? null,
      cronExpr: task.cronExpr ?? null,
      message: task.message,
    },
    formatTimestamp,
  );
}

async function buildOnceTaskMessage(
  runtime: RuntimeConfig,
  scope: ScopeContext,
  runAt: number,
  rawMessage: string,
): Promise<string> {
  const now = Date.now();
  const remainingMs = runAt - now;
  const llmRuntime = toAutomationLlmRuntime(runtime);
  llmRuntime.deliveryModel = selectDeliveryModelForTaskMessage(rawMessage, runtime.deliveryModel, runtime.deliveryFastModel);
  if (remainingMs > 0 && remainingMs <= SHORT_ONCE_TASK_WINDOW_MS) {
    llmRuntime.deliveryModel = runtime.deliveryFastModel;
    llmRuntime.deliveryTimeoutMs = Math.min(llmRuntime.deliveryTimeoutMs, SHORT_ONCE_DELIVERY_TIMEOUT_MS);
  }
  return buildDeliveryMessageByModel(
    llmRuntime,
    {
      kind: 'once',
      scope: scope.scope,
      runAt,
      cronExpr: null,
      message: rawMessage,
    },
    formatTimestamp,
    now,
  );
}

async function buildNaturalCreateReply(
  runtime: RuntimeConfig,
  payload: { kind: 'once' | 'cron'; runAt?: number | null; cronExpr?: string | null; message: string },
): Promise<string | null> {
  return buildNaturalCreateReplyByModel(toAutomationLlmRuntime(runtime), payload, formatTimestamp);
}

async function parseIntentByModel(content: string, runtime: RuntimeConfig): Promise<AutomationIntent | null> {
  if (!runtime.intentEnabled || !runtime.intentBaseUrl || !runtime.intentApiKey || !runtime.intentModel) {
    return null;
  }

  const now = new Date();
  const systemPrompt =
    '你是任务意图解析器。请仅输出 JSON：' +
    '{"action":"none|create_once|create_cron|list|delete|pause|resume","confidence":0~1,' +
    '"runAt":"ISO8601或null","timeText":"自然语言时间或null","cronExpr":"cron或null","message":"提醒内容或null","taskId":数字或null}。';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.intentTimeoutMs);
  try {
    const response = await fetch(`${runtime.intentBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runtime.intentApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: runtime.intentModel,
        max_tokens: 220,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `当前时间: ${now.toISOString()}\n文本: ${content}`,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) return null;
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };

    const contentText = extractMessageText(payload.choices?.[0]?.message?.content);

    const jsonText = extractJsonObject(contentText);
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText) as ModelIntentResponse;
    const confidence = Number(parsed.confidence ?? 0);
    if (!Number.isFinite(confidence) || confidence < runtime.intentMinConfidence) return null;

    const action = parsed.action?.toLowerCase();
    if (action === 'list') return { action: 'list', confidence };
    if (action === 'delete') {
      const id = Number(parsed.taskId);
      return Number.isFinite(id) && id > 0 ? { action: 'delete', taskId: id, confidence } : null;
    }
    if (action === 'pause') {
      const id = Number(parsed.taskId);
      return Number.isFinite(id) && id > 0 ? { action: 'pause', taskId: id, confidence } : null;
    }
    if (action === 'resume') {
      const id = Number(parsed.taskId);
      return Number.isFinite(id) && id > 0 ? { action: 'resume', taskId: id, confidence } : null;
    }
    if (action === 'create_cron') {
      const cronExpr = (parsed.cronExpr ?? '').trim();
      if (!cronExpr || !isValidCronExpr(cronExpr)) return null;
      return {
        action: 'create-cron',
        cronExpr,
        message: (parsed.message ?? '定时提醒').trim() || '定时提醒',
        confidence,
      };
    }
    if (action === 'create_once') {
      let runAt: number | null = null;
      if (typeof parsed.runAt === 'string') {
        const value = Date.parse(parsed.runAt);
        if (Number.isFinite(value)) runAt = value;
      } else if (typeof parsed.runAt === 'number' && Number.isFinite(parsed.runAt)) {
        runAt = parsed.runAt;
      }
      if (!runAt && typeof parsed.timeText === 'string') {
        runAt = parseOnceRunAt(parsed.timeText);
      }
      if (!runAt) return null;
      return {
        action: 'create-once',
        runAt,
        message: (parsed.message ?? '定时提醒').trim() || '定时提醒',
        confidence,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function ensureTaskTable(ctx: Context): void {
  ctx.model.extend(
    'automation_task',
    {
      id: 'unsigned',
      creatorId: 'string',
      scope: 'string',
      channelId: 'string',
      guildId: 'string',
      platform: 'string',
      botSelfId: 'string',
      kind: 'string',
      runAt: { type: 'double', nullable: true },
      cronExpr: { type: 'text', nullable: true },
      message: 'text',
      status: 'string',
      createdAt: 'double',
      updatedAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['creatorId'], ['status', 'kind'], ['status', 'runAt'], ['scope', 'channelId']],
    },
  );
}

function resolveTaskBot(ctx: Context, task: AutomationTask) {
  return (
    ctx.bots.find((bot) => bot.selfId === task.botSelfId && bot.platform === task.platform) ??
    ctx.bots.find((bot) => bot.platform === task.platform) ??
    ctx.bots[0]
  );
}

function splitMessageByLines(message: string): string[] {
  const normalized = message.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length) return lines;
  const fallback = message.trim();
  return fallback ? [fallback] : [];
}

async function sendSessionMessageByLines(session: Session, message: string): Promise<void> {
  const lines = splitMessageByLines(message);
  for (const line of lines) {
    await session.send(line);
  }
}

async function sendBotMessageByLines(
  bot: { sendMessage: (channelId: string, content: string) => Promise<unknown> },
  channelId: string,
  message: string,
): Promise<void> {
  const lines = splitMessageByLines(message);
  for (const line of lines) {
    await bot.sendMessage(channelId, line);
  }
}

async function sendTaskMessage(ctx: Context, task: AutomationTask, runtime: RuntimeConfig): Promise<boolean> {
  const bot = resolveTaskBot(ctx, task);
  if (!bot) {
    logger.warn('task #%d skipped: no bot available', task.id);
    return false;
  }

  const finalMessage = task.kind === 'once' ? task.message : await buildDeliveryMessage(task, runtime);

  const content = task.scope === 'group' ? `${h.at(task.creatorId)} ${finalMessage}` : finalMessage;
  try {
    await sendBotMessageByLines(bot, task.channelId, content);
    return true;
  } catch (error) {
    logger.warn('task #%d delivery failed: %s', task.id, (error as Error).message);
    return false;
  }
}

async function getScopedTask(
  ctx: Context,
  id: number,
  userId: string,
  scope: ScopeContext,
): Promise<AutomationTask | null> {
  const query = {
    id,
    creatorId: userId,
    scope: scope.scope,
    channelId: scope.channelId,
  };
  const [task] = await ctx.database.get('automation_task', query);
  return task ?? null;
}

export function apply(ctx: Context, config: Config): void {
  const runtime = toRuntimeConfig(config);
  ensureTaskTable(ctx);

  const cronDisposers = new Map<number, () => void>();
  const preloadedOnceTasks = new Set<number>();
  let onceTimer: NodeJS.Timeout | null = null;
  let onceTicking = false;

  const disposeCronTask = (taskId: number) => {
    const dispose = cronDisposers.get(taskId);
    if (!dispose) return;
    dispose();
    cronDisposers.delete(taskId);
  };

  const registerCronTask = (task: AutomationTask) => {
    const MAX_TIMEOUT_MS = 0x7fffffff;
    if (task.kind !== 'cron' || task.status !== 'active' || !task.cronExpr) return;
    disposeCronTask(task.id);
    try {
      let timer: NodeJS.Timeout | null = null;
      let disposed = false;

      const scheduleNext = () => {
        if (disposed) return;
        const nextAt = parseExpression(task.cronExpr!, { currentDate: new Date(), tz: FIXED_TIMEZONE }).next().getTime();
        const tick = () => {
          if (disposed) return;
          const remaining = nextAt - Date.now();
          if (remaining > 0) {
            timer = setTimeout(tick, Math.min(remaining, MAX_TIMEOUT_MS));
            return;
          }

          scheduleNext();
          void (async () => {
            const [latest] = await ctx.database.get('automation_task', { id: task.id });
            if (!latest || latest.status !== 'active' || latest.kind !== 'cron') return;
            await sendTaskMessage(ctx, latest, runtime);
          })();
        };

        tick();
      };

      scheduleNext();
      const dispose = () => {
        disposed = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
      cronDisposers.set(task.id, dispose);
    } catch (error) {
      logger.warn('task #%d invalid cron expression "%s": %s', task.id, task.cronExpr, (error as Error).message);
    }
  };

  const markExpiredOnceTasks = async () => {
    const now = Date.now();
    await ctx.database.set(
      'automation_task',
      {
        kind: 'once',
        status: 'active',
        runAt: { $lte: now },
      },
      {
        status: 'done',
        updatedAt: now,
      },
    );
  };

  const preloadOnceTask = async (task: AutomationTask): Promise<void> => {
    if (task.kind !== 'once' || task.status !== 'active' || !task.runAt) return;
    if (preloadedOnceTasks.has(task.id)) return;
    preloadedOnceTasks.add(task.id);
    try {
      const rawMessage = task.message;
      const finalMessage = await buildOnceTaskMessage(
        runtime,
        {
          scope: task.scope as TaskScope,
          channelId: task.channelId,
          guildId: task.guildId,
        },
        task.runAt,
        rawMessage,
      );
      if (!finalMessage || finalMessage === rawMessage) return;

      const [latest] = await ctx.database.get('automation_task', { id: task.id });
      if (!latest || latest.kind !== 'once' || latest.status !== 'active' || latest.message !== rawMessage) return;

      await ctx.database.set(
        'automation_task',
        { id: task.id },
        {
          message: finalMessage,
          updatedAt: Date.now(),
        },
      );
    } catch (error) {
      preloadedOnceTasks.delete(task.id);
      logger.warn('task #%d preload generation failed: %s', task.id, (error as Error).message);
    }
  };

  const tickOnceTasks = async () => {
    if (onceTicking) return;
    onceTicking = true;
    try {
      const now = Date.now();
      const preloadCandidates = await ctx.database.get('automation_task', {
        kind: 'once',
        status: 'active',
        runAt: {
          $gt: now,
          $lte: now + ONCE_PRELOAD_WINDOW_MS,
        },
      });
      for (const task of preloadCandidates) {
        await preloadOnceTask(task);
      }

      const dueTasks = await ctx.database.get('automation_task', {
        kind: 'once',
        status: 'active',
        runAt: { $lte: now },
      });
      for (const task of dueTasks) {
        await sendTaskMessage(ctx, task, runtime);
        await ctx.database.set('automation_task', { id: task.id }, { status: 'done', updatedAt: Date.now() });
        preloadedOnceTasks.delete(task.id);
      }
    } finally {
      onceTicking = false;
    }
  };

  const createTask = async (
    session: Session,
    scope: ScopeContext,
    payload: Pick<AutomationTask, 'kind' | 'message'> & { runAt?: number; cronExpr?: string },
  ): Promise<AutomationTask | null> => {
    if (!session.userId || !session.bot?.selfId) return null;
    const alive = (await ctx.database.get('automation_task', { creatorId: session.userId })).filter(
      (task) => task.status === 'active' || task.status === 'paused',
    );
    if (alive.length >= runtime.maxTasksPerUser) {
      await sendSessionMessageByLines(session, `任务创建失败：你已达到上限（${runtime.maxTasksPerUser}）。`);
      return null;
    }

    const now = Date.now();
    const created = await ctx.database.create('automation_task', {
      creatorId: session.userId,
      scope: scope.scope,
      channelId: scope.channelId,
      guildId: scope.guildId,
      platform: session.platform,
      botSelfId: session.bot.selfId,
      kind: payload.kind,
      runAt: payload.runAt ?? null,
      cronExpr: payload.cronExpr ?? null,
      message: payload.message,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    if (created.kind === 'cron') {
      registerCronTask(created);
    }
    return created;
  };

  const formatTaskList = (tasks: AutomationTask[]): string => {
    if (!tasks.length) return '当前没有任务。';
    return ['当前任务：', ...tasks.slice(0, 30).map((task) => `- ${taskText(task)}`)].join('\n');
  };

  const handleIntent = async (session: Session, scope: ScopeContext, intent: AutomationIntent): Promise<boolean> => {
    if (!session.userId) return false;

    switch (intent.action) {
      case 'list': {
        const tasks = (
          await ctx.database.get('automation_task', {
            creatorId: session.userId,
            scope: scope.scope,
            channelId: scope.channelId,
          })
        ).filter(isVisibleInTaskList);
        tasks.sort((a, b) => a.id - b.id);
        await sendSessionMessageByLines(session, formatTaskList(tasks));
        return true;
      }
      case 'delete': {
        if (!intent.taskId) {
          await sendSessionMessageByLines(session, '删除失败：请提供任务编号。');
          return true;
        }
        const task = await getScopedTask(ctx, intent.taskId, session.userId, scope);
        if (!task || task.status === 'deleted') {
          await sendSessionMessageByLines(session, `删除失败：未找到任务 #${intent.taskId}。`);
          return true;
        }
        disposeCronTask(task.id);
        preloadedOnceTasks.delete(task.id);
        await ctx.database.set('automation_task', { id: task.id }, { status: 'deleted', updatedAt: Date.now() });
        await sendSessionMessageByLines(session, `已删除任务 #${task.id}。`);
        return true;
      }
      case 'pause': {
        if (!intent.taskId) {
          await sendSessionMessageByLines(session, '暂停失败：请提供任务编号。');
          return true;
        }
        const task = await getScopedTask(ctx, intent.taskId, session.userId, scope);
        if (!task || task.status === 'deleted') {
          await sendSessionMessageByLines(session, `暂停失败：未找到任务 #${intent.taskId}。`);
          return true;
        }
        disposeCronTask(task.id);
        preloadedOnceTasks.delete(task.id);
        await ctx.database.set('automation_task', { id: task.id }, { status: 'paused', updatedAt: Date.now() });
        await sendSessionMessageByLines(session, `已暂停任务 #${task.id}。`);
        return true;
      }
      case 'resume': {
        if (!intent.taskId) {
          await sendSessionMessageByLines(session, '恢复失败：请提供任务编号。');
          return true;
        }
        const task = await getScopedTask(ctx, intent.taskId, session.userId, scope);
        if (!task || task.status === 'deleted') {
          await sendSessionMessageByLines(session, `恢复失败：未找到任务 #${intent.taskId}。`);
          return true;
        }
        await ctx.database.set('automation_task', { id: task.id }, { status: 'active', updatedAt: Date.now() });
        if (task.kind === 'cron') registerCronTask({ ...task, status: 'active' });
        await sendSessionMessageByLines(session, `已恢复任务 #${task.id}。`);
        return true;
      }
      case 'create-cron': {
        const cronExpr = (intent.cronExpr ?? '').trim();
        if (!cronExpr || !isValidCronExpr(cronExpr)) {
          await sendSessionMessageByLines(session, '创建失败：无法识别有效的周期表达式。');
          return true;
        }
        const created = await createTask(session, scope, {
          kind: 'cron',
          cronExpr,
          message: (intent.message ?? '定时提醒').trim() || '定时提醒',
        });
        if (created) {
          const reply = await buildNaturalCreateReply(runtime, {
            kind: 'cron',
            cronExpr,
            message: created.message,
          });
          if (reply) {
            await sendSessionMessageByLines(session, reply);
            return true;
          }
          return false;
        }
        return true;
      }
      case 'create-once': {
        const runAt = intent.runAt;
        if (!runAt || runAt <= Date.now()) {
          await sendSessionMessageByLines(session, '创建失败：时间无效或已过。');
          return true;
        }
        const rawMessage = (intent.message ?? '定时提醒').trim() || '定时提醒';
        const created = await createTask(session, scope, {
          kind: 'once',
          runAt,
          message: rawMessage,
        });
        if (created) {
          const shouldPreloadNow = Boolean(created.runAt && created.runAt - Date.now() < ONCE_PRELOAD_WINDOW_MS);
          if (shouldPreloadNow) {
            void preloadOnceTask(created);
          }
          const reply = await buildNaturalCreateReply(runtime, {
            kind: 'once',
            runAt,
            message: rawMessage,
          });
          if (reply) {
            await sendSessionMessageByLines(session, reply);
            return true;
          }
          return false;
        }
        return true;
      }
      default:
        return false;
    }
  };

  const parseIntent = async (content: string): Promise<AutomationIntent | null> => {
    const ruleIntent = parseAutomationIntentByRule(content);
    if (ruleIntent) return ruleIntent;
    if (!shouldTryAutomationIntent(content)) return null;
    return parseIntentByModel(content, runtime);
  };

  ctx.middleware(
    async (session, next) => {
      if (!runtime.intentEnabled) return next();
      if (!session.userId || !session.content || session.userId === session.bot?.selfId) return next();

      const scope = resolveScopeContext(session, runtime);
      if (!scope) return next();

      const content = normalizeMessageContent(session);
      if (!content || isCommandLike(content)) return next();

      const intent = await parseIntent(content);
      if (!intent) return next();

      if (!(await checkPermission(session, runtime))) {
        await sendSessionMessageByLines(session, '你没有权限管理自动化任务。');
        return;
      }

      try {
        const handled = await handleIntent(session, scope, intent);
        if (handled) return;
      } catch (error) {
        logger.warn('automation intent handling failed: %s', (error as Error).message);
        await sendSessionMessageByLines(session, '自动化任务处理失败，请稍后重试。');
        return;
      }

      return next();
    },
    true,
  );

  ctx.command('task.list', '查看当前会话下的任务').action(async ({ session }) => {
    if (!session?.userId) return '';
    const scope = resolveScopeContext(session, runtime);
    if (!scope) return '当前会话不支持任务管理。';
    if (!(await checkPermission(session, runtime))) return '你没有权限管理自动化任务。';
    const tasks = (
      await ctx.database.get('automation_task', {
        creatorId: session.userId,
        scope: scope.scope,
        channelId: scope.channelId,
      })
    ).filter(isVisibleInTaskList);
    tasks.sort((a, b) => a.id - b.id);
    await sendSessionMessageByLines(session, formatTaskList(tasks));
    return '';
  });

  ctx.command('task.del <id:number>', '删除任务').action(async ({ session }, id) => {
    if (!session?.userId || !id) return '删除失败：请提供任务编号。';
    const scope = resolveScopeContext(session, runtime);
    if (!scope) return '当前会话不支持任务管理。';
    if (!(await checkPermission(session, runtime))) return '你没有权限管理自动化任务。';
    const task = await getScopedTask(ctx, id, session.userId, scope);
    if (!task || task.status === 'deleted') return `删除失败：未找到任务 #${id}。`;
    disposeCronTask(task.id);
    preloadedOnceTasks.delete(task.id);
    await ctx.database.set('automation_task', { id: task.id }, { status: 'deleted', updatedAt: Date.now() });
    return `已删除任务 #${task.id}。`;
  });

  ctx.command('task.pause <id:number>', '暂停任务').action(async ({ session }, id) => {
    if (!session?.userId || !id) return '暂停失败：请提供任务编号。';
    const scope = resolveScopeContext(session, runtime);
    if (!scope) return '当前会话不支持任务管理。';
    if (!(await checkPermission(session, runtime))) return '你没有权限管理自动化任务。';
    const task = await getScopedTask(ctx, id, session.userId, scope);
    if (!task || task.status === 'deleted') return `暂停失败：未找到任务 #${id}。`;
    disposeCronTask(task.id);
    preloadedOnceTasks.delete(task.id);
    await ctx.database.set('automation_task', { id: task.id }, { status: 'paused', updatedAt: Date.now() });
    return `已暂停任务 #${task.id}。`;
  });

  ctx.command('task.resume <id:number>', '恢复任务').action(async ({ session }, id) => {
    if (!session?.userId || !id) return '恢复失败：请提供任务编号。';
    const scope = resolveScopeContext(session, runtime);
    if (!scope) return '当前会话不支持任务管理。';
    if (!(await checkPermission(session, runtime))) return '你没有权限管理自动化任务。';
    const task = await getScopedTask(ctx, id, session.userId, scope);
    if (!task || task.status === 'deleted') return `恢复失败：未找到任务 #${id}。`;
    await ctx.database.set('automation_task', { id: task.id }, { status: 'active', updatedAt: Date.now() });
    if (task.kind === 'cron') registerCronTask({ ...task, status: 'active' });
    return `已恢复任务 #${task.id}。`;
  });

  ctx.command('task.add.once <input:text>', '创建一次性任务（格式：task.add.once <time> -- <message>）').action(
    async ({ session }, input) => {
      if (!session?.userId) return '创建失败：缺少用户信息。';
      const scope = resolveScopeContext(session, runtime);
      if (!scope) return '当前会话不支持任务管理。';
      if (!(await checkPermission(session, runtime))) return '你没有权限管理自动化任务。';
      const [timePart, ...rest] = (input ?? '').split('--');
      const message = rest.join('--').trim();
      if (!timePart?.trim() || !message) {
        return '格式错误：task.add.once <time> -- <message>';
      }
      const runAt = parseOnceRunAt(timePart.trim());
      if (!runAt || runAt <= Date.now()) return '创建失败：无法解析时间或时间已过。';
      const created = await createTask(session, scope, {
        kind: 'once',
        runAt,
        message,
      });
      if (!created) return '创建失败，请稍后重试。';
      const shouldPreloadNow = Boolean(created.runAt && created.runAt - Date.now() < ONCE_PRELOAD_WINDOW_MS);
      if (shouldPreloadNow) {
        void preloadOnceTask(created);
      }
      return `已创建一次性任务 #${created.id}，执行时间：${formatTimestamp(runAt)}。`;
    },
  );

  ctx.command('task.add.cron <input:text>', '创建周期任务（格式：task.add.cron <cron> -- <message>）').action(
    async ({ session }, input) => {
      if (!session?.userId) return '创建失败：缺少用户信息。';
      const scope = resolveScopeContext(session, runtime);
      if (!scope) return '当前会话不支持任务管理。';
      if (!(await checkPermission(session, runtime))) return '你没有权限管理自动化任务。';
      const [cronPart, ...rest] = (input ?? '').split('--');
      const message = rest.join('--').trim();
      if (!cronPart?.trim() || !message) {
        return '格式错误：task.add.cron <cron> -- <message>';
      }
      const cronExpr = parseCronExpr(cronPart.trim()) ?? cronPart.trim();
      if (!cronExpr || !isValidCronExpr(cronExpr)) return '创建失败：无效的 cron 表达式。';
      const created = await createTask(session, scope, {
        kind: 'cron',
        cronExpr,
        message,
      });
      if (!created) return '创建失败，请稍后重试。';
      return `已创建周期任务 #${created.id}（cron: ${cronExpr}）。`;
    },
  );

  ctx.on('ready', async () => {
    await markExpiredOnceTasks();
    const cronTasks = await ctx.database.get('automation_task', { kind: 'cron', status: 'active' });
    cronTasks.forEach(registerCronTask);
    onceTimer = setInterval(() => void tickOnceTasks(), Math.max(5000, runtime.pollIntervalMs));
    logger.info(
      'task automation loaded: groups=%d, listenPrivate=%s, intent=%s, timezone=%s, deliveryModel=%s, replyModel=%s, deliveryMaxTokens=%d, replyMaxTokens=%d',
      runtime.enabledGroups.size,
      runtime.listenPrivate,
      runtime.intentEnabled,
      FIXED_TIMEZONE,
      runtime.deliveryModel,
      runtime.chatReplyModel,
      runtime.deliveryMaxTokens,
      runtime.chatReplyMaxTokens,
    );
  });

  ctx.on('dispose', () => {
    if (onceTimer) {
      clearInterval(onceTimer);
      onceTimer = null;
    }
    preloadedOnceTasks.clear();
    cronDisposers.forEach((dispose) => dispose());
    cronDisposers.clear();
  });
}
