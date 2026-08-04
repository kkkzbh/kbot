import { randomUUID } from 'node:crypto';
import { parseExpression } from 'cron-parser';
import { AIMessage } from '@langchain/core/messages';
import { StructuredTool } from '@langchain/core/tools';
import { Context, h, Logger, Schema, type Session, type Universal } from 'koishi';
import type { ChatLunaTool, ChatLunaToolRunnable } from 'koishi-plugin-chatluna/llm-core/platform/types';
import { z } from 'zod';
import type { AutomationJob, AutomationJobRun, TaskKind, TaskScope } from '../../types/task-automation.js';
import type { ToolPolicyServiceLike } from '../../types/tool-policy.js';
import {
  applyReplyOutputContract,
  buildReplyTransportPlanFromResolvedActions,
  buildReplyTurnInput,
  buildTurnCapabilitySnapshot,
  createVoiceRuntimeConfigFromEnv,
  createPromptTextFragment,
  deliverStandaloneReplyPlan,
  ensureSupportedStructuredReplyModel,
  DEFAULT_MODALITY_PREFERENCE,
  deriveModalityPolicy,
  assertExplicitModalityInvariant,
  ExplicitModalityInvariantError,
  replyFinalizerRequestRegistry,
  ReplyArtifactRegistry,
  CHATLUNA_AGENT_EVENT,
  ReplyOrchestratorService,
  resolveReplyCapabilitySnapshot,
  type AgentEvent,
  type ChatCallbacksProviderLike,
  type ModalityPolicySnapshot,
  type TurnContext,
  type ReplySessionLike,
} from '../reply/index.js';
import { createOrderedCallbackManager } from '../shared/chatluna-callbacks.js';
import {
  createChatLunaHistoryWriter,
  type ChatLunaHistoryServiceLike,
} from '../shared/chatluna-history.js';
import {
  createBypassLineSplitOptions,
  dispatchNormalizedOutboundMessage,
  dispatchNormalizedOutboundMessageWithMention,
  normalizeOutboundMessage,
  type BotMessageContent,
  type BotMessageSender,
  type NormalizedOutboundMessage,
} from '../shared/outbound/index.js';
import {
  compilePromptEnvelopeFromFragments,
  injectPromptEnvelope,
  type PromptFragment,
} from '../shared/prompt-context/index.js';
import { decodeStoredMessageText } from '../shared/stored-message.js';
import { resolveStickerCapabilityArtifacts } from '../sticker/index.js';
import {
  CanonicalModelBindingResolver,
  type ModelConfigService,
  type ResolvedModelTarget,
} from '../model-config/index.js';
import {
  formatNaturalRunAtText,
  formatAutomationTimestamp,
  isValidCronExpr,
  normalizeGroupId,
  parseCronExpr,
  parseGroupSet,
  parseOnceRunAt,
} from './scheduler.js';

const logger = new Logger('task-automation');
const FIXED_TIMEZONE = 'Asia/Shanghai';
const RECURRING_SCHEDULE_HINT = /每(?:天|日|周|星期|月|隔)/;
const AUTOMATION_RECENT_CONTEXT_LIMIT = 8;
const automationReplyOrchestrator = new ReplyOrchestratorService();

export const name = 'task-automation';
export const inject = {
  required: ['database', 'chatluna', 'toolPolicy', 'modelConfig'],
} as const;
export { normalizeGroupId, parseGroupSet } from './scheduler.js';

export interface Config {
  pollIntervalMs?: number;
  maxJobsPerUser?: number;
}

export const Config: Schema<Config> = Schema.object({
  pollIntervalMs: Schema.natural().role('time').description('一次性任务轮询周期（毫秒）。'),
  maxJobsPerUser: Schema.natural().description('每个用户允许创建的自动化任务上限。'),
});

interface RuntimeConfig {
  pollIntervalMs: number;
  maxJobsPerUser: number;
}

type DatabaseLike = {
  get<T = Record<string, unknown>>(table: string, query: Record<string, unknown>): Promise<T[]>;
  set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<unknown>;
  create<T = Record<string, unknown>>(table: string, row: Record<string, unknown>): Promise<T>;
  remove(table: string, query: Record<string, unknown>): Promise<unknown>;
  upsert?(table: string, rows: Record<string, unknown>[], keys?: string[]): Promise<unknown>;
};

type ToolMask = {
  mode: 'all' | 'allow' | 'deny';
  allow: string[];
  deny: string[];
  toolCallMask?: ToolMask;
};

type AutomationRoomRow = {
  visibility: 'public' | 'private' | 'template_clone';
  roomMasterId: string;
  roomName: string;
  roomId: number;
  preset: string;
  model: string;
  chatMode: string;
  password?: string | null;
  conversationId?: string | null;
  autoUpdate?: boolean;
  updatedTime: Date;
};

type ChatLunaMessage = {
  content: unknown;
  additional_kwargs?: Record<string, unknown>;
};

type ChatLunaBot = BotMessageSender & {
  selfId?: string;
  platform?: string;
  session?: (event?: Record<string, unknown>) => Session;
};

type ChatLunaServiceLike = ChatLunaHistoryServiceLike & {
  chat: (
    session: ReplySessionLike,
    room: AutomationRoomRow,
    message: ChatLunaMessage,
    options: {
      event: Record<string, ((...args: any[]) => Promise<void>) | undefined>;
      stream: boolean;
      variables: Record<string, unknown>;
      requestId: string;
      toolMask: ToolMask;
    },
  ) => Promise<ChatLunaMessage>;
  registerCallbacksProvider: (provider: ChatCallbacksProviderLike) => () => void;
  platform: {
    registerTool: (name: string, tool: ChatLunaTool) => () => void;
  };
  contextManager?: {
    inject: (options: {
      name: string;
      value: unknown;
      once?: boolean;
      conversationId?: string;
      stage?: string;
    }) => void;
  };
};

type AutomationServicesLike = {
  database: DatabaseLike;
  chatluna: ChatLunaServiceLike;
  toolPolicy: ToolPolicyServiceLike;
  modelConfig: ModelConfigService;
  bots: ChatLunaBot[];
};

type ContextWithAutomation = Context & AutomationServicesLike;

function automationServices(ctx: ContextWithAutomation): AutomationServicesLike {
  return ctx as unknown as AutomationServicesLike;
}

function automationDatabase(ctx: ContextWithAutomation): DatabaseLike {
  return automationServices(ctx).database;
}

function automationChatLuna(ctx: ContextWithAutomation): ChatLunaServiceLike {
  return automationServices(ctx).chatluna;
}

function automationToolPolicy(ctx: ContextWithAutomation): ToolPolicyServiceLike {
  return automationServices(ctx).toolPolicy;
}

function automationBots(ctx: ContextWithAutomation): ChatLunaBot[] {
  return automationServices(ctx).bots ?? [];
}

function resolveAutomationModelTarget(
  ctx: ContextWithAutomation,
): ResolvedModelTarget {
  return new CanonicalModelBindingResolver(
    automationServices(ctx).modelConfig.getRuntimeSnapshot(),
  ).resolve('main.chat').target!;
}

type SourceRoomContext = {
  room: AutomationRoomRow;
  session: ReplySessionLike;
};

type ReplyAutomationRoom = Omit<AutomationRoomRow, 'conversationId'> & {
  conversationId?: string;
};

type AutomationCapabilitySnapshot = NonNullable<TurnContext['capabilitySnapshot']>;
type AutomationExecutionContext = {
  capabilitySnapshot: AutomationCapabilitySnapshot;
  modalityPolicy: ModalityPolicySnapshot;
};

type AutomationToolDeps = {
  ctx: ContextWithAutomation;
  runtime: RuntimeConfig;
  lifecycle: {
    registerCronJob: (job: AutomationJob) => void;
    disposeCronJob: (jobId: number) => void;
  };
};

type ToolCurrentRoom = {
  room: AutomationRoomRow;
  session: ReplySessionLike;
  conversationId: string;
};

type ResolvedOnceSchedule = {
  kind: 'once';
  runAt: number;
  scheduleText: string;
};

type ResolvedCronSchedule = {
  kind: 'cron';
  cronExpr: string;
  scheduleText: string;
};

type ResolvedSchedule = ResolvedOnceSchedule | ResolvedCronSchedule;

const AUTOMATION_TOOL_NAMES = {
  create: 'automation_create',
  list: 'automation_list',
  update: 'automation_update',
  pause: 'automation_pause',
  resume: 'automation_resume',
  delete: 'automation_delete',
} as const;

function requireNaturalConfig(config: Config, key: keyof Config): number {
  const parsed = Number(config[key]);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`任务自动化配置缺失或非法：${String(key)}。默认值必须由 koishi.yml 显式传入。`);
  }
  return Math.floor(parsed);
}

function toRuntimeConfig(config: Config): RuntimeConfig {
  return {
    pollIntervalMs: requireNaturalConfig(config, 'pollIntervalMs'),
    maxJobsPerUser: requireNaturalConfig(config, 'maxJobsPerUser'),
  };
}

function ensureTaskTables(ctx: Context): void {
  ctx.model.extend(
    'automation_job',
    {
      id: 'unsigned',
      creatorId: 'string',
      scope: 'string',
      channelId: 'string',
      guildId: 'string',
      platform: 'string',
      botSelfId: 'string',
      sourceRoomId: 'unsigned',
      sourceConversationId: { type: 'char', length: 255, nullable: true },
      kind: 'string',
      runAt: { type: 'double', nullable: true },
      cronExpr: { type: 'text', nullable: true },
      goal: 'text',
      timezone: 'string',
      mentionCreator: 'unsigned',
      event: { type: 'json', nullable: true },
      status: 'string',
      createdAt: 'double',
      updatedAt: 'double',
    },
    {
      autoInc: true,
      indexes: [
        ['creatorId'],
        ['status', 'kind'],
        ['status', 'runAt'],
        ['sourceRoomId'],
      ],
    },
  );

  ctx.model.extend(
    'automation_job_run',
    {
      id: 'unsigned',
      jobId: 'unsigned',
      triggeredAt: 'double',
      startedAt: 'double',
      finishedAt: { type: 'double', nullable: true },
      status: 'string',
      error: { type: 'text', nullable: true },
      outputText: { type: 'text', nullable: true },
      outputPayload: { type: 'json', nullable: true } as any,
      deliveryReceipt: { type: 'text', nullable: true },
      deliveryState: { type: 'string', initial: 'not_started' },
      deliveryAttemptId: { type: 'string', nullable: true },
      deliveryConfirmedAt: { type: 'double', nullable: true },
      deliveryError: { type: 'text', nullable: true },
    },
    {
      autoInc: true,
      indexes: [['jobId'], ['status', 'triggeredAt'], ['deliveryState']],
    },
  );
}

function formatJobSummary(job: Pick<AutomationJob, 'id' | 'kind' | 'status' | 'runAt' | 'cronExpr' | 'goal'>): string {
  const schedule =
    job.kind === 'once'
      ? formatAutomationTimestamp(job.runAt ?? Date.now())
      : `cron(${job.cronExpr ?? ''})`;
  return `#${job.id} [${job.status}] ${schedule} ${job.goal}`;
}

function formatResolvedScheduleDetail(schedule: ResolvedSchedule, now = Date.now()): string {
  if (schedule.kind === 'once') {
    return `${formatNaturalRunAtText(schedule.runAt, now)}（${formatAutomationTimestamp(schedule.runAt)}, ${FIXED_TIMEZONE}）`;
  }
  return `${schedule.scheduleText}（cron: ${schedule.cronExpr}, ${FIXED_TIMEZONE}）`;
}

function formatJobScheduleDetail(job: Pick<AutomationJob, 'kind' | 'runAt' | 'cronExpr'>, now = Date.now()): string {
  if (job.kind === 'once') {
    const runAt = job.runAt ?? Date.now();
    return `${formatNaturalRunAtText(runAt, now)}（${formatAutomationTimestamp(runAt)}, ${FIXED_TIMEZONE}）`;
  }
  return `cron(${job.cronExpr ?? ''}, ${FIXED_TIMEZONE})`;
}

function formatJobCreatedSummary(job: AutomationJob, schedule: ResolvedSchedule): string {
  return `已创建自动化任务 #${job.id}：${formatResolvedScheduleDetail(schedule, job.createdAt)} 执行“${job.goal}”。`;
}

function formatJobUpdatedSummary(
  job: Pick<AutomationJob, 'id' | 'kind' | 'status' | 'runAt' | 'cronExpr' | 'goal' | 'updatedAt'>,
  schedule?: ResolvedSchedule,
): string {
  const detail = schedule ? formatResolvedScheduleDetail(schedule, job.updatedAt) : formatJobScheduleDetail(job, job.updatedAt);
  return `已更新自动化任务 #${job.id}：${detail} 执行“${job.goal}”。`;
}

function normalizeGoal(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

function normalizeScheduleText(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

function serializeToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function sanitizeEventSnapshot(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function createNoopChatEvents() {
  return {
    'llm-new-token': async () => undefined,
    'llm-queue-waiting': async () => undefined,
    'llm-used-token-count': async () => undefined,
    'llm-call-tool': async () => undefined,
    'llm-new-chunk': async () => undefined,
  };
}

function registerAutomationArtifactCallbacks(
  chatluna: ChatLunaServiceLike,
  requestId: string,
  artifactRegistry: ReplyArtifactRegistry,
): () => void {
  const provider: ChatCallbacksProviderLike = ({ requestId: callbackRequestId }) => {
    if (callbackRequestId !== requestId) return undefined;

    return createOrderedCallbackManager({
      handleCustomEvent: async (name, rawPayload) => {
        if (name !== CHATLUNA_AGENT_EVENT) return;
        const payload = rawPayload as {
          context?: { kind?: 'main' | 'subagent'; requestId?: string };
          event?: AgentEvent;
        };
        if (payload.context?.kind !== 'main' || payload.context.requestId !== requestId) return;
        if (payload.event?.type !== 'tool-result') return;
        for (const step of payload.event.steps) {
          artifactRegistry.registerObservation(requestId, step.action.tool, step.observation);
        }
      },
    });
  };

  return chatluna.registerCallbacksProvider(provider);
}

function createAutomationPrompt(job: AutomationJob, triggeredAt: number): string {
  const lines = [
    '你正在执行一个到点触发的自动化任务。',
    `当前时间(UTC+8)：${formatAutomationTimestamp(triggeredAt)}`,
    `任务类型：${job.kind === 'once' ? '一次性任务' : '周期任务'}`,
    `触发会话：${job.scope === 'group' ? '群聊' : '私聊'}`,
    job.kind === 'once'
      ? `原计划执行时间：${formatAutomationTimestamp(job.runAt ?? triggeredAt)}`
      : `cron 表达式：${job.cronExpr ?? ''}`,
    `任务目标：${job.goal}`,
    '请直接完成任务。你可以调用可用工具搜索、查询、整理信息，然后给出最终可发送结果。',
  ];
  return lines.join('\n');
}

async function getJobById(ctx: ContextWithAutomation, id: number): Promise<AutomationJob | null> {
  const rows = await automationDatabase(ctx).get<AutomationJob>('automation_job', { id });
  const job = rows[0];
  return job ?? null;
}

async function createJobRun(ctx: ContextWithAutomation, jobId: number, triggeredAt: number): Promise<AutomationJobRun> {
  const created = await automationDatabase(ctx).create<AutomationJobRun>('automation_job_run', {
    jobId,
    triggeredAt,
    startedAt: Date.now(),
    finishedAt: null,
    status: 'running',
    error: null,
    outputText: null,
    outputPayload: null,
    deliveryReceipt: null,
    deliveryState: 'not_started',
    deliveryAttemptId: null,
    deliveryConfirmedAt: null,
    deliveryError: null,
  });
  return created;
}

async function finishJobRun(
  ctx: ContextWithAutomation,
  runId: number,
  patch: Pick<AutomationJobRun, 'status' | 'error' | 'outputText' | 'outputPayload' | 'deliveryReceipt'>
    & Partial<Pick<AutomationJobRun, 'deliveryState' | 'deliveryAttemptId' | 'deliveryConfirmedAt'>>,
): Promise<void> {
  await automationDatabase(ctx).set(
    'automation_job_run',
    { id: runId },
    {
      ...patch,
      finishedAt: Date.now(),
    },
  );
}

function automationDeliveryAttemptId(run: AutomationJobRun): string {
  return `automation-job-run:${run.jobId}:${run.id}`;
}

async function syncAutomationDeliveryToSourceHistory(args: {
  ctx: ContextWithAutomation;
  job: AutomationJob;
  runId: number;
  outputText: string;
  outputPayload: unknown;
  deliveryReceipt: string;
}): Promise<void> {
  const conversationId = args.job.sourceConversationId?.trim();
  if (!conversationId) return;

  const database = automationDatabase(args.ctx);
  const [conversation] = await database.get<{ id?: string }>('chatluna_conversation', { id: conversationId });
  if (!conversation?.id) {
    throw new Error(`automation source conversation ${conversationId} is unavailable during delivery reconciliation`);
  }
  const recordId = `automation-job-run:${args.runId}`;

  if (!database.upsert) {
    throw new Error('automation delivery reconciliation requires database.upsert.');
  }
  const writer = await createChatLunaHistoryWriter({
    database: database as Parameters<typeof createChatLunaHistoryWriter>[0]['database'],
    logger,
    conversationId,
    chatluna: automationChatLuna(args.ctx),
    lockMode: 'acquire',
  });
  await writer.addMessages([
    new AIMessage({
      id: recordId,
      content: args.outputText,
      response_metadata: {
        chatluna: { recordId },
      },
      additional_kwargs: {
        qqbot_automation_delivery: {
          version: 'v1',
          jobId: args.job.id,
          runId: args.runId,
          deliveryReceipt: parseDeliveryReceipt(args.deliveryReceipt),
          outputPayload: args.outputPayload,
        },
      },
    }),
  ]);
}

async function reconcileConfirmedAutomationRun(
  ctx: ContextWithAutomation,
  job: AutomationJob,
  run: AutomationJobRun,
): Promise<void> {
  const outputText = run.outputText?.trim();
  const deliveryReceipt = run.deliveryReceipt?.trim();
  if (
    !outputText
    || !deliveryReceipt
    || !run.deliveryAttemptId?.trim()
    || !run.deliveryConfirmedAt
    || run.outputPayload == null
  ) {
    await automationDatabase(ctx).set('automation_job_run', { id: run.id }, {
      status: 'failed',
      deliveryState: 'reconciliation_failed',
      error: 'automation confirmed delivery checkpoint is incomplete',
      finishedAt: Date.now(),
    });
    if (job.kind === 'once') {
      await automationDatabase(ctx).set('automation_job', { id: job.id }, { status: 'done', updatedAt: Date.now() });
    }
    return;
  }

  try {
    await syncAutomationDeliveryToSourceHistory({
      ctx,
      job,
      runId: run.id,
      outputText,
      outputPayload: run.outputPayload,
      deliveryReceipt,
    });
  } catch (error) {
    await automationDatabase(ctx).set('automation_job_run', { id: run.id }, {
      deliveryState: 'reconciliation_failed',
      error: `automation delivery reconciliation failed: ${(error as Error).message}`,
      finishedAt: Date.now(),
    });
    if (job.kind === 'once') {
      await automationDatabase(ctx).set('automation_job', { id: job.id }, { status: 'done', updatedAt: Date.now() });
    }
    return;
  }

  await automationDatabase(ctx).set('automation_job_run', { id: run.id }, {
    status: run.deliveryError ? 'failed' : 'succeeded',
    deliveryState: 'reconciled',
    error: run.deliveryError,
    finishedAt: Date.now(),
  });
  if (job.kind === 'once') {
    await automationDatabase(ctx).set('automation_job', { id: job.id }, { status: 'done', updatedAt: Date.now() });
  }
}

async function reconcileOutcomeUnknownAutomationRun(
  ctx: ContextWithAutomation,
  job: AutomationJob,
  run: AutomationJobRun,
): Promise<void> {
  const baseError = run.error?.trim()
    || 'automation delivery outcome is unknown; the attempt will not be resent';
  let reconciliationError: string | null = null;
  const outputText = run.outputText?.trim();
  const deliveryReceipt = run.deliveryReceipt?.trim();

  if (deliveryReceipt) {
    if (!outputText || run.outputPayload == null) {
      reconciliationError = 'confirmed automation delivery units have an incomplete reconciliation checkpoint';
    } else {
      try {
        await syncAutomationDeliveryToSourceHistory({
          ctx,
          job,
          runId: run.id,
          outputText,
          outputPayload: run.outputPayload,
          deliveryReceipt,
        });
      } catch (error) {
        reconciliationError = `confirmed automation delivery unit reconciliation failed: ${(error as Error).message}`;
      }
    }
  }

  await automationDatabase(ctx).set('automation_job_run', { id: run.id }, {
    status: 'failed',
    deliveryState: 'outcome_unknown',
    error: reconciliationError ? `${baseError}; ${reconciliationError}` : baseError,
    finishedAt: Date.now(),
  });
  if (job.kind === 'once') {
    await automationDatabase(ctx).set('automation_job', { id: job.id }, { status: 'done', updatedAt: Date.now() });
  }
}

async function reconcileInterruptedAutomationRuns(ctx: ContextWithAutomation): Promise<void> {
  const runs = await automationDatabase(ctx).get<AutomationJobRun>('automation_job_run', {});
  for (const run of runs) {
    if (run.deliveryState === 'confirmed' || run.deliveryState === 'reconciliation_failed') {
      const job = await getJobById(ctx, run.jobId);
      if (!job) {
        await automationDatabase(ctx).set('automation_job_run', { id: run.id }, {
          status: 'failed',
          deliveryState: 'reconciliation_failed',
          error: `automation job #${run.jobId} is unavailable during delivery reconciliation`,
          finishedAt: Date.now(),
        });
        continue;
      }
      await reconcileConfirmedAutomationRun(ctx, job, run);
      continue;
    }
    if (run.deliveryState === 'outcome_unknown') {
      const job = await getJobById(ctx, run.jobId);
      if (!job) {
        await automationDatabase(ctx).set('automation_job_run', { id: run.id }, {
          status: 'failed',
          error: `automation job #${run.jobId} is unavailable while reconciling confirmed units from an unknown delivery outcome`,
          finishedAt: Date.now(),
        });
        continue;
      }
      await reconcileOutcomeUnknownAutomationRun(ctx, job, run);
      continue;
    }
    if (run.deliveryState !== 'dispatching') continue;
    await automationDatabase(ctx).set('automation_job_run', { id: run.id }, {
      status: 'failed',
      deliveryState: 'outcome_unknown',
      error: 'automation delivery outcome is unknown after process restart; the attempt will not be resent',
      finishedAt: Date.now(),
    });
    const job = await getJobById(ctx, run.jobId);
    if (job?.kind === 'once') {
      await automationDatabase(ctx).set('automation_job', { id: job.id }, { status: 'done', updatedAt: Date.now() });
    }
  }

  const interrupted = runs.filter((run) => run.status === 'running' && run.deliveryState === 'not_started');
  for (const run of interrupted) {
    await automationDatabase(ctx).set('automation_job_run', { id: run.id }, {
      status: 'failed',
      error: 'automation run interrupted by process restart before delivery started',
      finishedAt: Date.now(),
    });
    const job = await getJobById(ctx, run.jobId);
    if (job?.kind === 'once') {
      await automationDatabase(ctx).set('automation_job', { id: job.id }, { status: 'done', updatedAt: Date.now() });
    }
  }
}

async function resolveCurrentRoom(ctx: ContextWithAutomation, conversationId: string): Promise<AutomationRoomRow | null> {
  const rows = await automationDatabase(ctx).get<AutomationRoomRow>('chathub_room', { conversationId });
  return rows[0] ?? null;
}

function assertPluginRoom(room: AutomationRoomRow): void {
  const chatMode = String(room.chatMode ?? '').trim();
  if (chatMode !== 'plugin') {
    throw new Error(`automation tools require room.chatMode=plugin, got ${chatMode || 'unknown'}.`);
  }
}

async function resolveToolCurrentRoom(
  ctx: ContextWithAutomation,
  config: ChatLunaToolRunnable,
): Promise<ToolCurrentRoom> {
  const session = config.configurable.session as unknown as Session;
  const conversationId = String(config.configurable.conversationId ?? '').trim();
  if (!session?.userId || !conversationId) {
    throw new Error('automation tools require session.userId and conversationId.');
  }

  const room = await resolveCurrentRoom(ctx, conversationId);
  if (!room) {
    throw new Error('当前会话房间不存在，无法创建自动化任务。');
  }

  assertPluginRoom(room);
  return { room, session, conversationId };
}

function resolveJobScope(session: Session): TaskScope {
  return session.isDirect ? 'private' : 'group';
}

async function countAliveJobsForUser(ctx: ContextWithAutomation, userId: string): Promise<number> {
  const jobs = await automationDatabase(ctx).get<AutomationJob>('automation_job', { creatorId: userId });
  return jobs.filter((job) => job.status === 'active' || job.status === 'paused').length;
}

async function createAutomationJob(
  deps: AutomationToolDeps,
  args: {
    room: AutomationRoomRow;
    session: Session;
    kind: TaskKind;
    runAt?: number | null;
    cronExpr?: string | null;
    goal: string;
    timezone?: string;
    mentionCreator?: boolean;
  },
): Promise<AutomationJob> {
  const { ctx, runtime } = deps;
  if (!args.session.userId || !args.session.bot?.selfId || !args.session.channelId) {
    throw new Error('当前会话缺少必要上下文，无法创建自动化任务。');
  }

  const aliveCount = await countAliveJobsForUser(ctx, args.session.userId);
  if (aliveCount >= runtime.maxJobsPerUser) {
    throw new Error(`任务创建失败：你已达到上限（${runtime.maxJobsPerUser}）。`);
  }

  const now = Date.now();
  const created = await automationDatabase(ctx).create<AutomationJob>('automation_job', {
    creatorId: args.session.userId,
    scope: resolveJobScope(args.session),
    channelId: args.session.channelId,
    guildId: args.session.guildId ?? '',
    platform: args.session.platform,
    botSelfId: args.session.bot.selfId,
    sourceRoomId: args.room.roomId,
    sourceConversationId: args.room.conversationId?.trim() || null,
    kind: args.kind,
    runAt: args.kind === 'once' ? args.runAt ?? null : null,
    cronExpr: args.kind === 'cron' ? args.cronExpr ?? null : null,
    goal: normalizeGoal(args.goal),
    timezone: args.timezone?.trim() || FIXED_TIMEZONE,
    mentionCreator: resolveJobScope(args.session) === 'group' && args.mentionCreator !== false ? 1 : 0,
    event: sanitizeEventSnapshot(args.session.event),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  if (created.kind === 'cron') {
    deps.lifecycle.registerCronJob(created);
  }

  return created;
}

async function getScopedJobs(ctx: ContextWithAutomation, roomId: number, userId: string): Promise<AutomationJob[]> {
  const jobs = await automationDatabase(ctx).get<AutomationJob>('automation_job', {
    sourceRoomId: roomId,
    creatorId: userId,
  });
  return jobs.filter((job) => job.status !== 'deleted').sort((left, right) => left.id - right.id);
}

async function getScopedJob(ctx: ContextWithAutomation, roomId: number, userId: string, id: number): Promise<AutomationJob | null> {
  const [job] = await automationDatabase(ctx).get<AutomationJob>('automation_job', {
    id,
    sourceRoomId: roomId,
    creatorId: userId,
  });
  return job ?? null;
}

function assertJobCanUpdate(job: AutomationJob): void {
  if (job.status === 'done') {
    throw new Error(`自动化任务 #${job.id} 已完成，不能更新。`);
  }
  if (job.status === 'deleted') {
    throw new Error(`自动化任务 #${job.id} 已删除，不能更新。`);
  }
}

function buildListResult(jobs: AutomationJob[]): string {
  if (!jobs.length) return '当前会话下没有自动化任务。';
  return ['当前会话下的自动化任务：', ...jobs.map((job) => `- ${formatJobSummary(job)}`)].join('\n');
}

function ensureRunAtInFuture(runAt: number | null): number {
  if (!runAt || !Number.isFinite(runAt)) {
    throw new Error('无法解析一次性任务时间。');
  }
  if (runAt <= Date.now()) {
    throw new Error('一次性任务时间必须晚于当前时间。');
  }
  return runAt;
}

function normalizeCronExpression(input: string): string {
  const raw = input.trim();
  if (!raw) {
    throw new Error('无法解析周期任务时间。');
  }
  const parsed = parseCronExpr(raw) ?? raw;
  if (!isValidCronExpr(parsed)) {
    throw new Error(`无效的 cron 表达式：${raw}`);
  }
  return parsed;
}

function resolveScheduleText(raw: string, now = Date.now()): ResolvedSchedule {
  const scheduleText = normalizeScheduleText(raw);
  if (!scheduleText) {
    throw new Error('scheduleText 不能为空。');
  }

  const onceRunAt = parseOnceRunAt(scheduleText, now);
  const cronExpr = parseCronExpr(scheduleText);
  const hasRecurringHint = RECURRING_SCHEDULE_HINT.test(scheduleText);

  if (hasRecurringHint) {
    if (cronExpr) {
      return {
        kind: 'cron',
        cronExpr: normalizeCronExpression(cronExpr),
        scheduleText,
      };
    }
    if (onceRunAt) {
      throw new Error(`无法明确解析时间表达：${scheduleText}。请更明确说明是一次性时间还是周期时间。`);
    }
    throw new Error(`无法解析时间表达：${scheduleText}。`);
  }

  if (onceRunAt && cronExpr) {
    throw new Error(`无法明确解析时间表达：${scheduleText}。请更明确说明是一次性时间还是周期时间。`);
  }

  if (onceRunAt) {
    return {
      kind: 'once',
      runAt: ensureRunAtInFuture(onceRunAt),
      scheduleText,
    };
  }

  if (cronExpr) {
    return {
      kind: 'cron',
      cronExpr: normalizeCronExpression(cronExpr),
      scheduleText,
    };
  }

  throw new Error(`无法解析时间表达：${scheduleText}。`);
}

type AutomationJobPatch = Partial<Pick<AutomationJob, 'runAt' | 'cronExpr' | 'goal' | 'mentionCreator' | 'updatedAt'>>;

function buildAutomationJobUpdatePatch(
  job: AutomationJob,
  input: {
    scheduleText?: string;
    goal?: string;
    mentionCreator?: boolean;
  },
): { patch: AutomationJobPatch; schedule?: ResolvedSchedule } {
  if (input.scheduleText === undefined && input.goal === undefined && input.mentionCreator === undefined) {
    throw new Error('更新失败：至少提供一个可更新字段。');
  }

  const patch: AutomationJobPatch = {};
  let schedule: ResolvedSchedule | undefined;

  if (input.scheduleText !== undefined) {
    schedule = resolveScheduleText(input.scheduleText);
    if (job.kind !== schedule.kind) {
      throw new Error(
        job.kind === 'once'
          ? `更新失败：一次性任务 #${job.id} 不能改成周期任务。`
          : `更新失败：周期任务 #${job.id} 不能改成一次性任务。`,
      );
    }
    if (schedule.kind === 'once') {
      patch.runAt = schedule.runAt;
      patch.cronExpr = null;
    } else {
      patch.cronExpr = schedule.cronExpr;
      patch.runAt = null;
    }
  }

  if (input.goal !== undefined) {
    const goal = normalizeGoal(input.goal);
    if (!goal) {
      throw new Error('更新失败：goal 不能为空。');
    }
    patch.goal = goal;
  }

  if (input.mentionCreator !== undefined) {
    patch.mentionCreator = job.scope === 'group' ? (input.mentionCreator ? 1 : 0) : 0;
  }

  patch.updatedAt = Date.now();
  return { patch, schedule };
}

async function updateAutomationJob(
  deps: AutomationToolDeps,
  current: ToolCurrentRoom,
  input: {
    taskId: number;
    scheduleText?: string;
    goal?: string;
    mentionCreator?: boolean;
  },
): Promise<{ job: AutomationJob; schedule?: ResolvedSchedule }> {
  const job = await getScopedJob(deps.ctx, current.room.roomId, current.session.userId!, input.taskId);
  if (!job) {
    throw new Error(`未找到自动化任务 #${input.taskId}。`);
  }

  assertJobCanUpdate(job);
  const { patch, schedule } = buildAutomationJobUpdatePatch(job, input);
  const updated = { ...job, ...patch } as AutomationJob;

  if (job.kind === 'cron' && job.status === 'active') {
    deps.lifecycle.disposeCronJob(job.id);
  }

  await automationDatabase(deps.ctx).set('automation_job', { id: job.id }, patch);

  if (updated.kind === 'cron' && updated.status === 'active') {
    deps.lifecycle.registerCronJob(updated);
  }

  return { job: updated, schedule };
}

function stringifyReceipt(receipts: unknown[]): string | null {
  const normalized = receipts.flatMap((item) => {
    if (Array.isArray(item)) return item.map((value) => String(value)).filter(Boolean);
    if (item == null) return [];
    return [String(item)];
  });
  if (!normalized.length) return null;
  return JSON.stringify(normalized);
}

function parseDeliveryReceipt(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error('automation delivery receipt must contain valid JSON.', { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('automation delivery receipt must contain at least one message id.');
  }
  return parsed.map((value) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('automation delivery receipt contains an invalid message id.');
    }
    return value.trim();
  });
}

async function getNextRoomId(ctx: ContextWithAutomation): Promise<number> {
  const rooms = await automationDatabase(ctx).get<AutomationRoomRow>('chathub_room', {} as Record<string, never>);
  const maxRoomId = rooms.reduce((current, room) => Math.max(current, Number(room.roomId ?? 0)), 0);
  return maxRoomId + 1;
}

async function createConversationRoomRecord(
  ctx: ContextWithAutomation,
  session: Session,
  room: AutomationRoomRow,
): Promise<void> {
  const database = automationDatabase(ctx);
  await database.create('chathub_room', room);
  await database.create('chathub_room_member', {
    userId: session.userId,
    roomId: room.roomId,
    roomPermission: session.userId === room.roomMasterId ? 'owner' : 'member',
  });
  await database.upsert?.('chathub_user', [
    {
      userId: session.userId,
      defaultRoomId: room.roomId,
      groupId: session.isDirect ? '0' : session.guildId,
    },
  ]);
  if (!session.isDirect && session.guildId) {
    await database.create('chathub_room_group_member', {
      groupId: session.guildId,
      roomId: room.roomId,
      roomVisibility: room.visibility,
    });
  }
}

async function deleteConversationRoomRecord(ctx: ContextWithAutomation, room: AutomationRoomRow): Promise<void> {
  const database = automationDatabase(ctx);
  await database.remove('chathub_room_group_member', { roomId: room.roomId });
  await database.remove('chathub_room_member', { roomId: room.roomId });
  await database.remove('chathub_user', { defaultRoomId: room.roomId });
  if (room.conversationId) {
    await database.remove('chatluna_message', { conversationId: room.conversationId });
    await database.remove('chatluna_conversation', { id: room.conversationId });
  }
  await database.remove('chathub_room', { roomId: room.roomId });
}

export async function sendBotMessageByLines(
  bot: BotMessageSender,
  channelId: string,
  message: string | NormalizedOutboundMessage,
  options: { mentionUserId?: string } = {},
): Promise<string[]> {
  const receipts: string[] = [];
  const normalized = typeof message === 'string' ? normalizeOutboundMessage(message) : message;
  const recordReceipt = (result: unknown): void => {
    if (Array.isArray(result)) {
      receipts.push(...result.map((item) => String(item)));
      return;
    }
    if (result != null) {
      receipts.push(String(result));
    }
  };
  const sendWhole = async (content: BotMessageContent): Promise<unknown> => {
    const result = await bot.sendMessage(
      channelId,
      typeof content === 'string' ? h.text(content) : content,
      undefined,
      createBypassLineSplitOptions(),
    );
    recordReceipt(result);
    return result;
  };
  const sendLine = async (content: BotMessageContent): Promise<unknown> => {
    const result = await bot.sendMessage(
      channelId,
      typeof content === 'string' ? h.text(content) : content,
      undefined,
      createBypassLineSplitOptions(),
    );
    recordReceipt(result);
    return result;
  };

  if (!options.mentionUserId?.trim()) {
    await dispatchNormalizedOutboundMessage(normalized, sendWhole, sendLine);
    return receipts;
  }

  await dispatchNormalizedOutboundMessageWithMention(normalized, options.mentionUserId, sendWhole, sendLine);
  return receipts;
}

function resolveTaskBot(ctx: ContextWithAutomation, job: AutomationJob): ChatLunaBot | null {
  const bots = automationBots(ctx);
  return (
    bots.find((bot) => bot.selfId === job.botSelfId && bot.platform === job.platform) ??
    bots.find((bot) => bot.platform === job.platform) ??
    null
  );
}

function createExecutionSession(bot: ChatLunaBot, job: AutomationJob): ReplySessionLike {
  const event = sanitizeEventSnapshot(job.event) ?? {};
  const created = typeof bot.session === 'function' ? bot.session(event) : ({} as Session);
  const session = created as ReplySessionLike & { event?: Record<string, unknown> };
  Object.assign(session, {
    event,
    platform: job.platform,
    channelId: job.channelId,
    guildId: job.guildId || undefined,
    userId: job.creatorId,
    isDirect: job.scope === 'private',
    bot,
  });
  return session;
}

async function resolveSourceRoomContext(ctx: ContextWithAutomation, job: AutomationJob): Promise<SourceRoomContext> {
  const room = (await getCurrentSourceRoom(ctx, job.sourceRoomId)) as AutomationRoomRow | null;
  if (!room) {
    throw new Error(`source room #${job.sourceRoomId} no longer exists`);
  }
  assertPluginRoom(room);

  const bot = resolveTaskBot(ctx, job);
  if (!bot) {
    throw new Error(`bot ${job.botSelfId}/${job.platform} is unavailable`);
  }

  return {
    room,
    session: createExecutionSession(bot, job),
  };
}

async function getCurrentSourceRoom(ctx: ContextWithAutomation, roomId: number): Promise<AutomationRoomRow | null> {
  const rows = await automationDatabase(ctx).get<AutomationRoomRow>('chathub_room', { roomId });
  return rows[0] ?? null;
}

async function createTemporaryExecutionRoom(
  ctx: ContextWithAutomation,
  sourceRoom: AutomationRoomRow,
  session: ReplySessionLike,
  job: AutomationJob,
  modelTarget: ResolvedModelTarget,
): Promise<AutomationRoomRow> {
  const tempRoom: AutomationRoomRow = {
    ...sourceRoom,
    roomId: await getNextRoomId(ctx),
    roomName: `automation-job-${job.id}`,
    roomMasterId: job.creatorId,
    conversationId: randomUUID(),
    chatMode: 'plugin',
    model: modelTarget.canonicalModel,
    updatedTime: new Date(),
    autoUpdate: false,
  };
  await createConversationRoomRecord(ctx, session, tempRoom);
  return tempRoom;
}

async function resolveAutomationToolMask(
  ctx: ContextWithAutomation,
  session: Session,
  sourceRoom: AutomationRoomRow,
): Promise<ToolMask> {
  const mask = await automationToolPolicy(ctx).resolveToolMask(session, 'automation', {
    roomId: sourceRoom.roomId,
    conversationId: sourceRoom.conversationId?.trim() || null,
    groupId: session.guildId ?? null,
  });
  if (!mask) {
    throw new Error('automation requires an explicit tool mask for every Agent run.');
  }
  return mask;
}

async function loadRecentConversationTurns(
  ctx: ContextWithAutomation,
  conversationId: string | null | undefined,
  maxMessages = AUTOMATION_RECENT_CONTEXT_LIMIT,
): Promise<Array<{ role: 'human' | 'ai'; text: string }>> {
  const normalizedConversationId = conversationId?.trim();
  if (!normalizedConversationId) return [];

  const database = automationDatabase(ctx);
  const [conversation] = await database.get<{
    id?: string;
    latestMessageId?: string | null;
  }>('chatluna_conversation', { id: normalizedConversationId });
  if (!conversation?.id || !conversation.latestMessageId) return [];

  const rows = await database.get<{
    id: string;
    role?: string | null;
    parentId?: string | null;
    content?: unknown;
  }>('chatluna_message', { conversationId: normalizedConversationId });
  const messageMap = new Map(rows.map((row) => [row.id, row]));
  const turns: Array<{ role: 'human' | 'ai'; text: string }> = [];
  let cursor: string | null | undefined = conversation.latestMessageId;
  while (cursor && turns.length < maxMessages) {
    const row = messageMap.get(cursor);
    if (!row) break;
    if (row.role === 'human' || row.role === 'ai') {
      try {
        const text = (await decodeAutomationRecentContextText(row.content)).trim();
        if (text) {
          turns.push({
            role: row.role,
            text,
          });
        }
      } catch (error) {
        logger.warn('failed to decode automation recent context message %s: %s', row.id, (error as Error).message);
      }
    }
    cursor = row.parentId ?? null;
  }
  return turns.reverse();
}

async function decodeAutomationRecentContextText(content: unknown): Promise<string> {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (content && typeof content === 'object' && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text.trim() : '';
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('')
      .trim();
  }

  try {
    return (await decodeStoredMessageText(content)).trim();
  } catch {
    return '';
  }
}

function buildAutomationRecentContextFragment(
  turns: Array<{ role: 'human' | 'ai'; text: string }>,
): PromptFragment | null {
  if (!turns.length) return null;
  const lines = turns.map((turn) => `${turn.role === 'human' ? 'human' : 'assistant'}: ${turn.text}`);
  return createPromptTextFragment(
    'qqbot_automation_recent_context',
    'Automation Recent Conversation Window',
    'reference',
    'turn',
    'required',
    lines.join('\n'),
  );
}

function injectAutomationPromptFragments(
  ctx: ContextWithAutomation,
  conversationId: string | null | undefined,
  fragments: PromptFragment[],
): void {
  const normalizedConversationId = conversationId?.trim();
  if (!normalizedConversationId || !fragments.length) return;
  const envelope = compilePromptEnvelopeFromFragments(fragments);
  if (!envelope?.messages.length) return;
  const contextManager = automationChatLuna(ctx).contextManager;
  if (!contextManager) {
    throw new Error('automation prompt injection requires chatluna.contextManager.');
  }
  injectPromptEnvelope(contextManager, {
    name: 'qqbot_automation_prompt_envelope',
    envelope,
    once: true,
    conversationId: normalizedConversationId,
  });
}

async function prepareAutomationExecutionContext(
  ctx: ContextWithAutomation,
  sourceRoom: AutomationRoomRow,
  tempRoom: AutomationRoomRow,
  session: ReplySessionLike,
  job: AutomationJob,
): Promise<AutomationExecutionContext> {
  const stickerArtifacts = resolveStickerCapabilityArtifacts(sourceRoom.preset?.trim() || null);
  const currentState = ((session as Session & { state?: Record<string, unknown> }).state ?? {}) as Record<string, unknown>;
  currentState.qqSticker = stickerArtifacts.state as unknown as Record<string, unknown>;
  currentState.qqbotExecutionRoute = 'automation';
  (session as Session & { state?: Record<string, unknown> }).state = currentState;

  const voiceRuntime = createVoiceRuntimeConfigFromEnv();
  const replyCapability = await resolveReplyCapabilitySnapshot({
    runtime: voiceRuntime,
    session,
    voiceOutputEnabled: voiceRuntime.outputEnabled,
    requireFreshVoiceCapability: true,
  });
  const requestedPolicy = deriveModalityPolicy(
    buildReplyTurnInput(
      session,
      { conversationId: tempRoom.conversationId ?? undefined },
      { content: job.goal },
    ),
    {
      canVoice: replyCapability.canVoice,
      canSticker: stickerArtifacts.state.availableCount > 0,
      stickerAvailableCount: stickerArtifacts.state.availableCount,
    },
    { stickerReady: true, voiceReady: true },
    DEFAULT_MODALITY_PREFERENCE,
  );
  const capabilitySnapshot = buildTurnCapabilitySnapshot(
    session,
    replyCapability,
    {
      ...requestedPolicy,
      canVoice: requestedPolicy.canVoice && requestedPolicy.voiceReason === 'explicit_request',
      canSticker: requestedPolicy.canSticker && requestedPolicy.stickerReason === 'explicit_request',
    },
    stickerArtifacts.state,
    [],
  );
  const recentContextTurns = await loadRecentConversationTurns(ctx, sourceRoom.conversationId);
  const recentContextFragment = buildAutomationRecentContextFragment(recentContextTurns);
  const fragments = recentContextFragment ? [recentContextFragment] : [];
  injectAutomationPromptFragments(ctx, tempRoom.conversationId, fragments);
  return {
    capabilitySnapshot,
    modalityPolicy: requestedPolicy,
  };
}

function toReplyAutomationRoom(room: AutomationRoomRow): ReplyAutomationRoom {
  return {
    ...room,
    conversationId: room.conversationId?.trim() || undefined,
  };
}

async function executeAutomationJobRun(ctx: ContextWithAutomation, job: AutomationJob, run: AutomationJobRun): Promise<void> {
  let tempRoom: AutomationRoomRow | null = null;
  const finalizerRequestId = `automation-job:${job.id}:${run.id}`;
  const artifactRegistry = new ReplyArtifactRegistry({ maxRuns: 1 });
  let artifactCallbacksDispose: (() => void) | null = null;
  const failureEvidence: Pick<AutomationJobRun, 'outputText' | 'outputPayload' | 'deliveryReceipt'> = {
    outputText: null,
    outputPayload: null,
    deliveryReceipt: null,
  };
  let durableDeliveryState: AutomationJobRun['deliveryState'] = run.deliveryState;
  let deliveryHistoryMaterialized = false;

  try {
    const source = await resolveSourceRoomContext(ctx, job);
    const modelTarget = resolveAutomationModelTarget(ctx);
    tempRoom = await createTemporaryExecutionRoom(
      ctx,
      source.room,
      source.session,
      job,
      modelTarget,
    );
    const replyRoom = toReplyAutomationRoom(tempRoom);
    ensureSupportedStructuredReplyModel(modelTarget);
    const executionContext = await prepareAutomationExecutionContext(
      ctx,
      source.room,
      tempRoom,
      source.session,
      job,
    );
    const { capabilitySnapshot, modalityPolicy } = executionContext;
    const toolMask = await resolveAutomationToolMask(ctx, source.session, source.room);
    const message: ChatLunaMessage = {
      content: createAutomationPrompt(job, run.triggeredAt),
    };
    const replyOutputContract = applyReplyOutputContract(message, {
      modelTarget,
      replyMode: 'automation',
      capabilitySnapshot,
    });

    artifactCallbacksDispose = registerAutomationArtifactCallbacks(
      automationChatLuna(ctx),
      finalizerRequestId,
      artifactRegistry,
    );
    replyFinalizerRequestRegistry.begin(finalizerRequestId, {
      canVoice: capabilitySnapshot.canVoice,
      canMeme: capabilitySnapshot.canSticker,
      explicitVoiceRequested: modalityPolicy.voiceReason === 'explicit_request',
      explicitMemeRequested: modalityPolicy.stickerReason === 'explicit_request',
      hasImageAssetRef: (assetRef) => artifactRegistry.has(finalizerRequestId, assetRef),
    });
    const response = await automationChatLuna(ctx).chat(
      source.session,
      tempRoom,
      message,
      {
        event: createNoopChatEvents(),
        stream: false,
        variables: {},
        requestId: finalizerRequestId,
        toolMask,
      },
    );
    const turnInput = buildReplyTurnInput(source.session, replyRoom, message);
    const deliveryCapabilitySnapshot = {
      ...capabilitySnapshot,
      imageAssetRefs: artifactRegistry.list(finalizerRequestId),
    };
    const orchestration = await automationReplyOrchestrator.handle(turnInput, source.session, {
      responseMessage: response,
      outputProtocol: replyOutputContract?.protocol,
      capabilitySnapshot: deliveryCapabilitySnapshot,
      routeHint: 'automation',
    });
    if (orchestration.status === 'no_reply' || orchestration.status === 'ready') {
      failureEvidence.outputPayload = orchestration.status === 'ready'
        ? orchestration.reply
        : { decision: 'no_reply', outbound_messages: null };
      assertExplicitModalityInvariant(modalityPolicy, {
        stage: 'orchestration',
        reply: orchestration.status === 'ready' ? orchestration.reply : null,
      });
    }
    if (orchestration.status === 'no_reply') {
      await finishJobRun(ctx, run.id, {
        status: 'succeeded',
        error: null,
        outputText: null,
        outputPayload: { decision: 'no_reply' },
        deliveryReceipt: null,
        deliveryState: 'reconciled',
      });
      return;
    }
    if (orchestration.status !== 'ready') {
      throw new Error(`automation structured reply expected ready status, got ${orchestration.status}.`);
    }
    failureEvidence.outputPayload = orchestration.reply;
    if (orchestration.actions.length === 1 && orchestration.actions[0]?.kind === 'no_reply') {
      await finishJobRun(ctx, run.id, {
        status: 'succeeded',
        error: null,
        outputText: null,
        outputPayload: orchestration.reply,
        deliveryReceipt: null,
        deliveryState: 'reconciled',
      });
      return;
    }

    const bot = resolveTaskBot(ctx, job);
    if (!bot) {
      throw new Error(`bot ${job.botSelfId}/${job.platform} is unavailable`);
    }

    const plan = buildReplyTransportPlanFromResolvedActions(orchestration.actions);
    if (!plan.segments.length) {
      await finishJobRun(ctx, run.id, {
        status: 'succeeded',
        error: null,
        outputText: null,
        outputPayload: orchestration.reply,
        deliveryReceipt: null,
        deliveryState: 'reconciled',
      });
      return;
    }

    const deliveryAttemptId = automationDeliveryAttemptId(run);
    await automationDatabase(ctx).set('automation_job_run', { id: run.id }, {
      deliveryState: 'dispatching',
      deliveryAttemptId,
      outputPayload: orchestration.reply,
      deliveryReceipt: null,
      deliveryConfirmedAt: null,
      deliveryError: null,
    });
    durableDeliveryState = 'dispatching';

    const voiceRuntime = createVoiceRuntimeConfigFromEnv();
    const delivery = await deliverStandaloneReplyPlan({
      runtime: voiceRuntime,
      session: source.session,
      plan,
      modalityPolicy,
    });
    failureEvidence.outputText = delivery.historyText.trim() || null;
    failureEvidence.deliveryReceipt = stringifyReceipt(delivery.receipts);
    const deliveryOutcomeUnknown = delivery.status === 'outcome_unknown';
    if (failureEvidence.deliveryReceipt) {
      const deliveryError = delivery.status === 'delivered'
        ? null
        : delivery.status === 'failed_semantic'
          ? delivery.semanticFailure.message
          : `automation structured reply delivery ${delivery.status.replaceAll('_', ' ')}`;
      const confirmedAt = Date.now();
      await automationDatabase(ctx).set('automation_job_run', { id: run.id }, {
        deliveryState: deliveryOutcomeUnknown ? 'outcome_unknown' : 'confirmed',
        deliveryAttemptId,
        deliveryConfirmedAt: confirmedAt,
        deliveryReceipt: failureEvidence.deliveryReceipt,
        outputText: failureEvidence.outputText,
        outputPayload: orchestration.reply,
        error: deliveryError,
        deliveryError,
      });
      durableDeliveryState = deliveryOutcomeUnknown ? 'outcome_unknown' : 'confirmed';

      if (!failureEvidence.outputText) {
        throw new Error('automation confirmed delivery checkpoint has no committed history text');
      }
      await syncAutomationDeliveryToSourceHistory({
        ctx,
        job,
        runId: run.id,
        outputText: failureEvidence.outputText,
        outputPayload: orchestration.reply,
        deliveryReceipt: failureEvidence.deliveryReceipt,
      });
      deliveryHistoryMaterialized = true;
    } else if (deliveryOutcomeUnknown) {
      const deliveryError = 'automation delivery outcome is unknown; the attempt will not be resent';
      await automationDatabase(ctx).set('automation_job_run', { id: run.id }, {
        deliveryState: 'outcome_unknown',
        deliveryAttemptId,
        deliveryConfirmedAt: null,
        outputText: failureEvidence.outputText,
        outputPayload: orchestration.reply,
        error: deliveryError,
        deliveryError,
      });
      durableDeliveryState = 'outcome_unknown';
    } else {
      await automationDatabase(ctx).set('automation_job_run', { id: run.id }, {
        deliveryState: 'not_started',
        deliveryAttemptId: null,
        deliveryConfirmedAt: null,
      });
      durableDeliveryState = 'not_started';
    }
    if (delivery.status === 'interrupted') {
      throw new Error('automation structured reply delivery interrupted');
    }
    if (delivery.status === 'transport_unavailable') {
      throw new Error('automation structured reply delivery failed because onebot rpc transport is unavailable');
    }
    if (delivery.status === 'failed_after_partial_send') {
      throw new Error('automation structured reply delivery failed after partial send');
    }
    if (delivery.status === 'outcome_unknown') {
      throw new Error('automation delivery outcome is unknown; the attempt will not be resent');
    }
    if (delivery.status === 'failed_semantic') {
      throw delivery.semanticFailure;
    }

    if (delivery.status === 'failed_before_send') {
      throw new Error('automation structured reply delivery failed before send');
    }

    await finishJobRun(ctx, run.id, {
      status: 'succeeded',
      error: null,
      outputText: failureEvidence.outputText,
      outputPayload: orchestration.reply,
      deliveryReceipt: failureEvidence.deliveryReceipt,
      deliveryState: 'reconciled',
      deliveryAttemptId,
      deliveryConfirmedAt: Date.now(),
    });
    durableDeliveryState = 'reconciled';
  } catch (error) {
    if (error instanceof ExplicitModalityInvariantError) {
      logger.warn(
        'automation explicit modality invariant failed: jobId=%s runId=%s stage=%s code=%s missing=%s',
        String(job.id),
        String(run.id),
        error.stage,
        error.code,
        error.missingModalities.join(','),
      );
    }
    const outcomeUnknown = durableDeliveryState === 'dispatching' || durableDeliveryState === 'outcome_unknown';
    await finishJobRun(ctx, run.id, {
      status: 'failed',
      error: outcomeUnknown
        ? `automation delivery outcome is unknown; the attempt will not be resent: ${(error as Error).message}`
        : (error as Error).message,
      ...failureEvidence,
      deliveryState: outcomeUnknown
        ? 'outcome_unknown'
        : failureEvidence.deliveryReceipt
          ? (deliveryHistoryMaterialized ? 'reconciled' : 'confirmed')
          : durableDeliveryState,
    });
    throw error;
  } finally {
    artifactCallbacksDispose?.();
    replyFinalizerRequestRegistry.finish(finalizerRequestId);
    artifactRegistry.finishRun(finalizerRequestId);
    if (tempRoom) {
      await deleteConversationRoomRecord(ctx, tempRoom).catch((error: unknown) => {
        logger.warn('failed to delete temporary automation room #%s: %s', String(tempRoom!.roomId), (error as Error).message);
      });
    }
  }
}

async function executeAutomationJob(ctx: ContextWithAutomation, jobId: number): Promise<void> {
  const job = await getJobById(ctx, jobId);
  if (!job || job.status !== 'active') return;

  const run = await createJobRun(ctx, job.id, Date.now());

  try {
    await executeAutomationJobRun(ctx, job, run);
  } catch (error) {
    logger.warn('automation job #%d failed: %s', job.id, (error as Error).message);
  } finally {
    if (job.kind === 'once') {
      await automationDatabase(ctx).set('automation_job', { id: job.id }, { status: 'done', updatedAt: Date.now() });
    }
  }
}

function createAutomationToolEntry(
  toolName: string,
  description: string,
  createTool: () => StructuredTool,
): ChatLunaTool {
  return {
    name: toolName,
    description,
    selector: () => true,
    authorization: (session) => Boolean(session?.userId),
    createTool: () => createTool(),
  };
}

class AutomationCreateTool extends StructuredTool {
  name = AUTOMATION_TOOL_NAMES.create;

  description =
    'Create a new automation job in the current chat room. Use this only when the user wants to add a new timed or scheduled task. Always pass the user schedule as scheduleText in natural language. Do not convert it into ISO time or cron yourself. Do not use this to modify an existing task; use automation_update instead.';

  schema = z.object({
    scheduleText: z
      .string()
      .describe('The user schedule phrase in natural language, for example 今天23:45, 明天早上8点, 半小时后, 每周一早上9点. Copy the schedule meaning directly from the user. Do not convert it into ISO datetime or cron.'),
    goal: z.string().describe('Natural-language task goal to execute when the job triggers.'),
    mentionCreator: z.boolean().optional().describe('Whether to @ the creator when sending group results. Defaults to true.'),
  });

  constructor(private readonly deps: AutomationToolDeps) {
    super({});
  }

  async _call(input: z.infer<typeof this.schema>, _runManager: unknown, config: ChatLunaToolRunnable): Promise<string> {
    const current = await resolveToolCurrentRoom(this.deps.ctx, config);

    const goal = normalizeGoal(input.goal);
    if (!goal) {
      throw new Error('goal 不能为空。');
    }

    const schedule = resolveScheduleText(input.scheduleText);

    const created = await createAutomationJob(this.deps, {
      room: current.room,
      session: current.session,
      kind: schedule.kind,
      runAt: schedule.kind === 'once' ? schedule.runAt : null,
      cronExpr: schedule.kind === 'cron' ? schedule.cronExpr : null,
      goal,
      timezone: FIXED_TIMEZONE,
      mentionCreator: input.mentionCreator,
    });

    return formatJobCreatedSummary(created, schedule);
  }
}

class AutomationListTool extends StructuredTool {
  name = AUTOMATION_TOOL_NAMES.list;

  description = 'List automation jobs created by the current user in the current room.';

  schema = z.object({});

  constructor(private readonly deps: AutomationToolDeps) {
    super({});
  }

  async _call(_input: z.infer<typeof this.schema>, _runManager: unknown, config: ChatLunaToolRunnable): Promise<string> {
    const current = await resolveToolCurrentRoom(this.deps.ctx, config);
    const jobs = await getScopedJobs(this.deps.ctx, current.room.roomId, current.session.userId!);
    return buildListResult(jobs);
  }
}

const AutomationManageSchema = z.object({
  taskId: z.number().int().positive().describe('Automation job id.'),
});

const AutomationUpdateSchema = AutomationManageSchema.extend({
  scheduleText: z
    .string()
    .optional()
    .describe('Updated user schedule phrase in natural language, for example 明天8点 or 每周二晚上7点. Do not convert it into ISO datetime or cron.'),
  goal: z.string().optional().describe('Updated natural-language task goal.'),
  mentionCreator: z.boolean().optional().describe('Whether to @ the creator when sending group results.'),
});

class AutomationUpdateTool extends StructuredTool {
  name = AUTOMATION_TOOL_NAMES.update;

  description =
    'Update fields of an existing automation job created by the current user in the current room. When the user wants to change an existing task, always use this tool instead of deleting and recreating it. Always pass the user schedule as scheduleText in natural language. Do not convert it into ISO time or cron yourself. If this tool succeeds, do not call it again for the same requested change.';

  schema = AutomationUpdateSchema;

  constructor(private readonly deps: AutomationToolDeps) {
    super({});
  }

  async _call(input: z.infer<typeof AutomationUpdateSchema>, _runManager: unknown, config: ChatLunaToolRunnable): Promise<string> {
    const current = await resolveToolCurrentRoom(this.deps.ctx, config);
    const updated = await updateAutomationJob(this.deps, current, input);
    return formatJobUpdatedSummary(updated.job, updated.schedule);
  }
}

class AutomationPauseTool extends StructuredTool {
  name = AUTOMATION_TOOL_NAMES.pause;

  description = 'Pause an automation job created by the current user in the current room.';

  schema = AutomationManageSchema;

  constructor(private readonly deps: AutomationToolDeps) {
    super({});
  }

  async _call(input: z.infer<typeof AutomationManageSchema>, _runManager: unknown, config: ChatLunaToolRunnable): Promise<string> {
    const current = await resolveToolCurrentRoom(this.deps.ctx, config);
    const job = await getScopedJob(this.deps.ctx, current.room.roomId, current.session.userId!, input.taskId);
    if (!job || job.status === 'deleted') {
      throw new Error(`未找到自动化任务 #${input.taskId}。`);
    }

    this.deps.lifecycle.disposeCronJob(job.id);
    await automationDatabase(this.deps.ctx).set('automation_job', { id: job.id }, { status: 'paused', updatedAt: Date.now() });
    return `已暂停自动化任务 #${job.id}。`;
  }
}

class AutomationResumeTool extends StructuredTool {
  name = AUTOMATION_TOOL_NAMES.resume;

  description = 'Resume a paused automation job created by the current user in the current room.';

  schema = AutomationManageSchema;

  constructor(private readonly deps: AutomationToolDeps) {
    super({});
  }

  async _call(input: z.infer<typeof AutomationManageSchema>, _runManager: unknown, config: ChatLunaToolRunnable): Promise<string> {
    const current = await resolveToolCurrentRoom(this.deps.ctx, config);
    const job = await getScopedJob(this.deps.ctx, current.room.roomId, current.session.userId!, input.taskId);
    if (!job || job.status === 'deleted') {
      throw new Error(`未找到自动化任务 #${input.taskId}。`);
    }

    await automationDatabase(this.deps.ctx).set('automation_job', { id: job.id }, { status: 'active', updatedAt: Date.now() });
    if (job.kind === 'cron') {
      this.deps.lifecycle.registerCronJob({ ...job, status: 'active' });
    }
    return `已恢复自动化任务 #${job.id}。`;
  }
}

class AutomationDeleteTool extends StructuredTool {
  name = AUTOMATION_TOOL_NAMES.delete;

  description =
    'Delete an automation job created by the current user in the current room. Use this only when the user explicitly wants to remove a task, not when they want to modify it.';

  schema = AutomationManageSchema;

  constructor(private readonly deps: AutomationToolDeps) {
    super({});
  }

  async _call(input: z.infer<typeof AutomationManageSchema>, _runManager: unknown, config: ChatLunaToolRunnable): Promise<string> {
    const current = await resolveToolCurrentRoom(this.deps.ctx, config);
    const job = await getScopedJob(this.deps.ctx, current.room.roomId, current.session.userId!, input.taskId);
    if (!job || job.status === 'deleted') {
      throw new Error(`未找到自动化任务 #${input.taskId}。`);
    }

    this.deps.lifecycle.disposeCronJob(job.id);
    await automationDatabase(this.deps.ctx).set('automation_job', { id: job.id }, { status: 'deleted', updatedAt: Date.now() });
    return `已删除自动化任务 #${job.id}。`;
  }
}

function registerAutomationTools(ctx: ContextWithAutomation, runtime: RuntimeConfig, lifecycle: AutomationToolDeps['lifecycle']): Array<() => void> {
  const deps: AutomationToolDeps = { ctx, runtime, lifecycle };
  const platform = automationChatLuna(ctx).platform;
  return [
    platform.registerTool(
      AUTOMATION_TOOL_NAMES.create,
      createAutomationToolEntry(
        AUTOMATION_TOOL_NAMES.create,
        'Create an automation job in the current room.',
        () => new AutomationCreateTool(deps),
      ),
    ),
    platform.registerTool(
      AUTOMATION_TOOL_NAMES.list,
      createAutomationToolEntry(
        AUTOMATION_TOOL_NAMES.list,
        'List automation jobs created by the current user in the current room.',
        () => new AutomationListTool(deps),
      ),
    ),
    platform.registerTool(
      AUTOMATION_TOOL_NAMES.update,
      createAutomationToolEntry(
        AUTOMATION_TOOL_NAMES.update,
        'Update an automation job in the current room.',
        () => new AutomationUpdateTool(deps),
      ),
    ),
    platform.registerTool(
      AUTOMATION_TOOL_NAMES.pause,
      createAutomationToolEntry(
        AUTOMATION_TOOL_NAMES.pause,
        'Pause an automation job in the current room.',
        () => new AutomationPauseTool(deps),
      ),
    ),
    platform.registerTool(
      AUTOMATION_TOOL_NAMES.resume,
      createAutomationToolEntry(
        AUTOMATION_TOOL_NAMES.resume,
        'Resume a paused automation job in the current room.',
        () => new AutomationResumeTool(deps),
      ),
    ),
    platform.registerTool(
      AUTOMATION_TOOL_NAMES.delete,
      createAutomationToolEntry(
        AUTOMATION_TOOL_NAMES.delete,
        'Delete an automation job in the current room.',
        () => new AutomationDeleteTool(deps),
      ),
    ),
  ];
}

export function apply(ctx: Context, config: Config): void {
  const runtime = toRuntimeConfig(config);
  const serviceCtx = ctx as ContextWithAutomation;
  ensureTaskTables(ctx);

  const cronDisposers = new Map<number, () => void>();
  const runningJobs = new Set<number>();
  let onceTimer: NodeJS.Timeout | null = null;
  let toolDisposers: Array<() => void> = [];

  const disposeCronJob = (jobId: number): void => {
    const dispose = cronDisposers.get(jobId);
    if (!dispose) return;
    dispose();
    cronDisposers.delete(jobId);
  };

  const runJobIfNeeded = async (jobId: number): Promise<void> => {
    if (runningJobs.has(jobId)) return;
    runningJobs.add(jobId);
    try {
      await executeAutomationJob(serviceCtx, jobId);
    } finally {
      runningJobs.delete(jobId);
    }
  };

  const registerCronJob = (job: AutomationJob): void => {
    if (job.kind !== 'cron' || job.status !== 'active' || !job.cronExpr) return;
    disposeCronJob(job.id);

    try {
      let timer: NodeJS.Timeout | null = null;
      let disposed = false;

      const scheduleNext = () => {
        if (disposed) return;
        const nextAt = parseExpression(job.cronExpr!, { currentDate: new Date(), tz: FIXED_TIMEZONE }).next().getTime();
        const tick = () => {
          if (disposed) return;
          const remaining = nextAt - Date.now();
          if (remaining > 0) {
            timer = setTimeout(tick, Math.min(remaining, 0x7fffffff));
            return;
          }
          scheduleNext();
          void runJobIfNeeded(job.id);
        };
        tick();
      };

      scheduleNext();
      cronDisposers.set(job.id, () => {
        disposed = true;
        if (timer) clearTimeout(timer);
      });
    } catch (error) {
      logger.warn('automation job #%d has invalid cron expression "%s": %s', job.id, job.cronExpr, (error as Error).message);
    }
  };

  const tickOnceJobs = async (): Promise<void> => {
    const dueJobs = await automationDatabase(serviceCtx).get<AutomationJob>('automation_job', {
      kind: 'once',
      status: 'active',
      runAt: { $lte: Date.now() },
    });

    for (const job of dueJobs) {
      await runJobIfNeeded(job.id);
    }
  };

  ctx.on('ready', async () => {
    await reconcileInterruptedAutomationRuns(serviceCtx);
    toolDisposers = registerAutomationTools(serviceCtx, runtime, {
      registerCronJob,
      disposeCronJob,
    });

    const cronJobs = await automationDatabase(serviceCtx).get<AutomationJob>('automation_job', {
      kind: 'cron',
      status: 'active',
    });
    cronJobs.forEach(registerCronJob);

    onceTimer = setInterval(() => {
      void tickOnceJobs();
    }, Math.max(5000, runtime.pollIntervalMs));

    logger.info(
      'task automation loaded: pollIntervalMs=%d, maxJobsPerUser=%d, tools=%s',
      runtime.pollIntervalMs,
      runtime.maxJobsPerUser,
      Object.values(AUTOMATION_TOOL_NAMES).join(','),
    );
  });

  ctx.on('dispose', () => {
    if (onceTimer) {
      clearInterval(onceTimer);
      onceTimer = null;
    }
    cronDisposers.forEach((dispose) => dispose());
    cronDisposers.clear();
    for (const dispose of toolDisposers) {
      dispose();
    }
    toolDisposers = [];
  });
}
