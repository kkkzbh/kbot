import { Context, Logger, Schema, type Fragment, type Session } from 'koishi';
import type { NativeFeatureChatServiceLike } from '../../types/native-feature-chat.js';
import '../../types/native-feature-chat.js';
import { normalizeGroupId, parseGroupSet } from '../shared/group-id.js';
import { ChaoxingAnswerService, formatAnswerDraft, formatWrongAnswers } from './answer-service.js';
import { ChaoxingAuthService } from './auth-service.js';
import { ChaoxingCatalogService, formatChapterList, formatCourseList } from './catalog-service.js';
import { ChaoxingClient } from './client.js';
import { parseChaoxingCommand, type ChaoxingCommand } from './commands.js';
import { loadOrCreateKek, resolveKekPath } from './crypto.js';
import { ChaoxingDeadlineService, formatTaskList } from './deadline-service.js';
import { ChaoxingMenuService, type ChaoxingMenuPuppeteerLike } from './menu.js';
import { ChaoxingSignService, formatDetectedSigns } from './sign-service.js';
import { ChaoxingOwnerCoordinator } from './owner-coordinator.js';
import { ChaoxingTaskStore, ensureChaoxingTables } from './store.js';
import { ChaoxingStudyRunner } from './study-runner.js';
import { ChaoxingUserError, type ChaoxingJobType, type DatabaseLike, type OwnerIdentity } from './types.js';
import { renderChaoxingBindPage } from './web/bind-page.js';
import { ChaoxingWorker, formatJobStatus, parseAnswerJobProgress, type ChaoxingNotifier } from './worker.js';

export const name = 'chaoxing';
export const inject = { required: ['server', 'database', 'nativeFeatureChat', 'puppeteer'] } as const;

const logger = new Logger(name);
const DEFAULT_BIND_PAGE_PATH = '/chaoxing/bind';

export interface Config {
  bindPagePath?: string;
  publicBaseUrl?: string;
  bindTokenTtlMs?: number;
  credentialKekPath?: string;
  autoReloginEnabled?: boolean;
  sessionValidationTtlMs?: number;
  allowedGroups?: string[] | string;
  naturalTriggerEnabled?: boolean;
  naturalTriggerGroups?: string[] | string;
  requestIntervalMs?: number;
  workerPollIntervalMs?: number;
  signWatchIntervalMs?: number;
  deadlineSyncIntervalMs?: number;
  deadlineReminderLeadMs?: number;
  studyPlaybackRate?: number;
  maximumVideoReportIntervalMs?: number;
  answerProviderUrl?: string;
  answerProviderApiKey?: string;
  answerProviderTimeoutMs?: number;
}

export const Config: Schema<Config> = Schema.object({
  bindPagePath: Schema.string().default(DEFAULT_BIND_PAGE_PATH).description('学习通绑定页路径，必须以 / 开头。'),
  publicBaseUrl: Schema.string().description('QQ 回复中使用的外部可访问基础 URL。'),
  bindTokenTtlMs: Schema.natural().role('time').default(600_000).description('绑定链接有效期。'),
  credentialKekPath: Schema.string().description('学习通凭据 KEK 文件路径，文件权限必须为 0600。'),
  autoReloginEnabled: Schema.boolean().default(true).description('登录态失效后是否使用已授权保存的密码自动续期。'),
  sessionValidationTtlMs: Schema.natural().role('time').default(600_000).description('登录态验证缓存时间。'),
  allowedGroups: Schema.union([
    Schema.array(Schema.string()).role('table').description('允许使用学习通功能的群号。私聊始终允许。'),
    Schema.string().description('允许使用学习通功能的群号，多个群号用英文逗号分隔。'),
  ]),
  naturalTriggerEnabled: Schema.boolean().default(false).description('是否允许白名单群聊直接发送学习通命令。'),
  naturalTriggerGroups: Schema.union([
    Schema.array(Schema.string()).role('table'),
    Schema.string(),
  ]).description('允许直接触发学习通命令的群号。'),
  requestIntervalMs: Schema.natural().role('time').default(1_200).description('学习通普通接口请求间隔。'),
  workerPollIntervalMs: Schema.natural().role('time').default(5_000).description('持久化任务队列轮询间隔。'),
  signWatchIntervalMs: Schema.natural().role('time').default(15_000).description('签到监听间隔。'),
  deadlineSyncIntervalMs: Schema.natural().role('time').default(900_000).description('作业、考试、活动同步间隔。'),
  deadlineReminderLeadMs: Schema.natural().role('time').default(86_400_000).description('截止提醒提前量。'),
  studyPlaybackRate: Schema.number().min(0.1).max(2).default(1).description('视频任务计时倍率，默认按真实时间。'),
  maximumVideoReportIntervalMs: Schema.natural().role('time').default(60_000).description('视频进度最大上报间隔。'),
  answerProviderUrl: Schema.string().description('可选的外部答案源 HTTP API。'),
  answerProviderApiKey: Schema.string().role('secret').description('可选答案源 API Key。'),
  answerProviderTimeoutMs: Schema.natural().role('time').default(15_000).description('答案源请求超时。'),
});

interface ChaoxingServicesContext {
  database: DatabaseLike;
  nativeFeatureChat: NativeFeatureChatServiceLike;
  puppeteer: ChaoxingMenuPuppeteerLike;
  server: {
    get(path: string, handler: (koaCtx: any) => unknown): void;
    post(path: string, handler: (koaCtx: any) => unknown): void;
  };
  bots: Array<{
    platform: string;
    sendMessage(channelId: string, content: Fragment): Promise<unknown>;
  }>;
}

interface RuntimeConfig {
  bindPagePath: string;
  bindStatusPath: string;
  passwordSubmitPath: string;
  publicBaseUrl: string;
  bindTokenTtlMs: number;
  credentialKekPath: string;
  autoReloginEnabled: boolean;
  sessionValidationTtlMs: number;
  allowedGroups: Set<string>;
  naturalTriggerEnabled: boolean;
  naturalTriggerGroups: Set<string>;
  requestIntervalMs: number;
  workerPollIntervalMs: number;
  signWatchIntervalMs: number;
  deadlineSyncIntervalMs: number;
  deadlineReminderLeadMs: number;
  studyPlaybackRate: number;
  maximumVideoReportIntervalMs: number;
  answerProviderUrl?: string;
  answerProviderApiKey?: string;
  answerProviderTimeoutMs: number;
}

interface Services {
  auth: ChaoxingAuthService;
  catalog: ChaoxingCatalogService;
  deadline: ChaoxingDeadlineService;
  sign: ChaoxingSignService;
  answer: ChaoxingAnswerService;
  store: ChaoxingTaskStore;
  worker: ChaoxingWorker;
  coordinator: ChaoxingOwnerCoordinator;
  menu: ChaoxingMenuService;
}

export function apply(ctx: Context, config: Config): void {
  const runtime = resolveRuntimeConfig(ctx, config);
  const serviceCtx = ctx as unknown as ChaoxingServicesContext;
  ensureChaoxingTables(ctx);
  const store = new ChaoxingTaskStore(serviceCtx.database);
  const coordinator = new ChaoxingOwnerCoordinator();
  const client = new ChaoxingClient();
  const auth = new ChaoxingAuthService(store, client, loadOrCreateKek(runtime.credentialKekPath), {
    bindPagePath: runtime.bindPagePath,
    publicBaseUrl: runtime.publicBaseUrl,
    bindTokenTtlMs: runtime.bindTokenTtlMs,
    autoReloginEnabled: runtime.autoReloginEnabled,
    sessionValidationTtlMs: runtime.sessionValidationTtlMs,
  });
  const catalog = new ChaoxingCatalogService(auth, client, store);
  const notifier = createNotifier(serviceCtx);
  const deadline = new ChaoxingDeadlineService(auth, catalog, client, store, notifier, {
    requestIntervalMs: runtime.requestIntervalMs,
    reminderLeadMs: runtime.deadlineReminderLeadMs,
  });
  const sign = new ChaoxingSignService(auth, catalog, client, store, { requestIntervalMs: runtime.requestIntervalMs });
  const answer = new ChaoxingAnswerService(auth, client, store, {
    providerUrl: runtime.answerProviderUrl,
    providerApiKey: runtime.answerProviderApiKey,
    providerTimeoutMs: runtime.answerProviderTimeoutMs,
  });
  const runner = new ChaoxingStudyRunner(auth, catalog, client, answer, store, {
    requestIntervalMs: runtime.requestIntervalMs,
    playbackRate: runtime.studyPlaybackRate,
    maximumReportIntervalMs: runtime.maximumVideoReportIntervalMs,
  });
  const worker = new ChaoxingWorker(store, runner, sign, auth, notifier, coordinator, {
    pollIntervalMs: runtime.workerPollIntervalMs,
    signWatchIntervalMs: runtime.signWatchIntervalMs,
  });
  const menu = new ChaoxingMenuService(serviceCtx.puppeteer);
  const services: Services = { auth, catalog, deadline, sign, answer, store, worker, coordinator, menu };

  registerWebRoutes(serviceCtx, auth, runtime);
  registerCommands(ctx, serviceCtx.nativeFeatureChat, services, runtime);
  const unregister = serviceCtx.nativeFeatureChat.registerCapability({
    id: 'chaoxing',
    isRelevant: shouldExposeChaoxingCapabilityReference,
    buildReference: (session) => buildChaoxingCapabilityReference(session, runtime),
  });
  ctx.on('dispose', unregister);

  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let initialSyncTimer: ReturnType<typeof setTimeout> | null = null;
  ctx.on('ready', async () => {
    await store.cleanupExpiredChallenges(Date.now());
    await store.recoverInterruptedJobs(Date.now());
    worker.start();
    const sync = (): void => { void syncDeadlines(store, deadline, coordinator); };
    initialSyncTimer = setTimeout(sync, Math.min(10_000, runtime.deadlineSyncIntervalMs));
    syncTimer = setInterval(sync, runtime.deadlineSyncIntervalMs);
  });
  ctx.on('dispose', () => {
    worker.stop();
    if (initialSyncTimer) clearTimeout(initialSyncTimer);
    if (syncTimer) clearInterval(syncTimer);
  });
  logger.info('Chaoxing bind page registered at %s.', runtime.bindPagePath);
}

function registerCommands(ctx: Context, nativeFeatureChat: NativeFeatureChatServiceLike, services: Services, runtime: RuntimeConfig): void {
  ctx.middleware(async (session, next) => {
    const text = normalizeCommandText(session);
    const command = parseChaoxingCommand(text);
    if (!command) return next();
    if (!canInvoke(session, runtime)) return next();
    if (!canUse(session, runtime.allowedGroups)) {
      await sendReply(nativeFeatureChat, session, command, text, '当前群未开启学习通功能。', false);
      return;
    }
    try {
      const identity = resolveOwnerIdentity(session);
      const reply = await services.coordinator.run(identity.ownerKey, () => executeCommand(command, identity, services));
      await sendReply(nativeFeatureChat, session, command, text, reply, true);
    } catch (error) {
      const message = toUserMessage(error);
      await sendReply(nativeFeatureChat, session, command, text, message, false);
    }
  });
}

async function executeCommand(command: ChaoxingCommand, identity: OwnerIdentity, services: Services): Promise<Fragment> {
  if (command.kind === 'menu') return services.menu.queryMenu(identity.qqUserId);
  if (command.kind === 'bind') {
    const result = await services.auth.startBinding(identity);
    const validMinutes = Math.max(1, Math.ceil((result.expiresAt - Date.now()) / 60_000));
    return `请打开链接绑定学习通：\n${result.link}\n链接 ${validMinutes} 分钟内有效。扫码或密码登录成功后，请回到这里发送“学习通确认 <6位确认码>”。`;
  }
  if (command.kind === 'confirm_help') return '请发送：学习通确认 <6位确认码>。';
  if (command.kind === 'confirm') {
    await services.auth.confirmBinding(identity, command.code);
    return '学习通绑定完成。';
  }
  if (command.kind === 'status') return services.auth.status(identity);
  if (command.kind === 'unbind') {
    await services.auth.unbind(identity);
    return '学习通账号、会话、任务和记录已解绑并清除。';
  }
  if (command.kind === 'courses') return formatCourseList(await services.catalog.listCourses(identity));
  if (command.kind === 'chapters') {
    const result = await services.catalog.listChapters(identity, command.courseQuery);
    return formatChapterList(result.course, result.chapters);
  }
  if (command.kind === 'todo' || command.kind === 'works' || command.kind === 'exams') {
    const kind = command.kind === 'works' ? 'work' : command.kind === 'exams' ? 'exam' : undefined;
    const title = command.kind === 'works' ? '学习通作业' : command.kind === 'exams' ? '学习通考试' : '学习通待办';
    return formatTaskList(await services.deadline.query(identity, kind), title);
  }
  if (command.kind === 'sign_list') return formatDetectedSigns(await services.sign.scanOpenSigns(identity));
  if (command.kind === 'sign_execute') {
    const detected = await services.sign.resolveDetectedSign(identity, command.activityId);
    return (await services.sign.execute(identity, detected, command.code)).message;
  }
  if (command.kind === 'sign_watch') {
    if (await services.store.findActiveJob(identity.ownerKey, 'sign_watch')) throw new ChaoxingUserError('已有签到监听任务，请先发送“学习通停止签到”。');
    if (command.courseQuery) await services.catalog.resolveCourse(identity, command.courseQuery);
    const job = await services.store.createJob(identity, 'sign_watch', { payload: { courseQuery: command.courseQuery } }, Date.now());
    services.worker.wake();
    return `签到监听任务 #${job.id} 已启动。普通签到会自动执行；签到码和手势签到会通知你输入。`;
  }
  if (command.kind === 'sign_stop') {
    await services.store.cancelJobs(identity.ownerKey, 'sign_watch', Date.now());
    return '学习通签到监听已停止。';
  }
  if (command.kind === 'study_start' || command.kind === 'answer_start') {
    await assertNoActiveLearningJob(services.store, identity.ownerKey);
    const course = await services.catalog.resolveCourse(identity, command.courseQuery);
    const type: ChaoxingJobType = command.kind === 'study_start' ? 'study' : 'answer';
    if (type === 'study') {
      const resumable = (await services.store.listJobs(identity.ownerKey))
        .filter((job) => job.type === 'study' && job.courseId === course.courseId && job.classId === course.classId && ['waiting_input', 'failed', 'cancelled'].includes(job.status))
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (resumable) {
        await services.store.resumeJob(resumable.id, Date.now());
        services.worker.wake();
        return `学习通刷课任务 #${resumable.id} 已从持久化断点恢复：${course.name}。`;
      }
    }
    const job = await services.store.createJob(identity, type, {
      courseId: course.courseId, classId: course.classId, courseQuery: course.name,
    }, Date.now());
    services.worker.wake();
    return type === 'study'
      ? `学习通刷课任务 #${job.id} 已排队：${course.name}。`
      : `学习通答题任务 #${job.id} 已排队：${course.name}。答案准备完成后会发送预览。`;
  }
  if (command.kind === 'job_status' || command.kind === 'study_status') {
    const allJobs = await services.store.listJobs(identity.ownerKey);
    const jobs = (command.kind === 'study_status' ? allJobs.filter((job) => job.type === 'study') : allJobs)
      .sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 10);
    return jobs.length > 0 ? jobs.map(formatJobStatus).join('\n') : command.kind === 'study_status' ? '当前没有学习通刷课任务。' : '当前没有学习通长任务。';
  }
  if (command.kind === 'study_stop') {
    await services.store.cancelJobs(identity.ownerKey, 'study', Date.now());
    return '学习通刷课任务已停止，进度已保留。';
  }
  if (command.kind === 'answer_stop') {
    await services.store.cancelJobs(identity.ownerKey, 'answer', Date.now());
    return '学习通答题任务已停止。';
  }
  if (command.kind === 'wrong_answers') {
    const rows = (await services.store.listWrongAnswers(identity.ownerKey)).sort((left, right) => right.createdAt - left.createdAt);
    return formatWrongAnswers(rows);
  }
  if (command.kind === 'answer_supplement') {
    const job = await requireOwnedWaitingAnswerJob(services.store, identity.ownerKey, command.jobId);
    const progress = parseAnswerJobProgress(job.progressJson);
    progress.draft = await services.answer.supplementDraft(progress.draft, command.questionPosition, command.answer);
    await services.store.updateWaitingJobProgress(job.id, progress, Date.now());
    return formatAnswerDraft(job.id, progress.draft);
  }
  if (command.kind === 'answer_save' || command.kind === 'answer_submit') {
    const job = await requireOwnedWaitingAnswerJob(services.store, identity.ownerKey, command.jobId);
    const progress = parseAnswerJobProgress(job.progressJson);
    const mode = command.kind === 'answer_save' ? 'save' : 'submit';
    const result = await services.answer.submitDraft(identity, job.id, progress.draft, mode);
    await services.store.appendJobEvent(job.id, identity.ownerKey, `answer_${mode}`, result, Date.now());
    if (mode === 'submit') await services.store.finishJob(job.id, 'succeeded', { progress, result }, Date.now());
    return mode === 'save' ? `答题任务 #${job.id} 已只填答案并保存：${result.message}` : `答题任务 #${job.id} 已确认提交：${result.message}`;
  }
  throw new Error(`unhandled chaoxing command: ${(command as { kind: string }).kind}`);
}

function registerWebRoutes(ctx: ChaoxingServicesContext, auth: ChaoxingAuthService, runtime: RuntimeConfig): void {
  ctx.server.get(runtime.bindPagePath, async (koaCtx: any) => {
    const token = requestToken(koaCtx);
    try {
      const state = await auth.resolveBindPage(token);
      writeHtml(koaCtx, 200, renderChaoxingBindPage({
        qq: state.qqUserId, token, state: state.state, imageDataUrl: state.imageDataUrl,
        statusPath: `${runtime.bindStatusPath}?token=${encodeURIComponent(token)}`,
        passwordSubmitPath: runtime.passwordSubmitPath, confirmCode: state.confirmCode,
        message: state.errorMessage ?? undefined,
      }));
    } catch (error) {
      writeHtml(koaCtx, 400, renderChaoxingBindPage({ qq: '', state: 'invalid', message: toUserMessage(error) }));
    }
  });
  ctx.server.get(runtime.bindStatusPath, async (koaCtx: any) => {
    try {
      writeJson(koaCtx, 200, await auth.pollQrLogin(requestToken(koaCtx)));
    } catch (error) {
      writeJson(koaCtx, 400, { kind: 'error', message: toUserMessage(error) });
    }
  });
  ctx.server.post(runtime.passwordSubmitPath, async (koaCtx: any) => {
    const body = await readRequestBody(koaCtx);
    const token = String(body.token ?? '').trim();
    try {
      const result = await auth.submitPassword({
        token,
        username: String(body.username ?? ''),
        password: String(body.password ?? ''),
        persistCredentialConsent: body.persistCredentialConsent === 'yes' || body.persistCredentialConsent === true,
      });
      writeHtml(koaCtx, 200, renderChaoxingBindPage({ qq: '', token, state: 'success', confirmCode: result.confirmCode }));
    } catch (error) {
      writeHtml(koaCtx, 400, renderChaoxingBindPage({
        qq: '', token, state: 'error', passwordSubmitPath: runtime.passwordSubmitPath, message: toUserMessage(error),
      }));
    }
  });
}

function resolveRuntimeConfig(ctx: Context, config: Config): RuntimeConfig {
  const bindPagePath = absolutePath(config.bindPagePath ?? DEFAULT_BIND_PAGE_PATH, 'chaoxing.bindPagePath');
  const baseDir = String((ctx as { baseDir?: string }).baseDir ?? process.cwd());
  return {
    bindPagePath,
    bindStatusPath: `${bindPagePath}/status`,
    passwordSubmitPath: `${bindPagePath}/password`,
    publicBaseUrl: baseUrl(config.publicBaseUrl ?? `http://127.0.0.1:${process.env.KOISHI_PORT || '5140'}`),
    bindTokenTtlMs: positiveInteger(config.bindTokenTtlMs ?? 600_000, 'chaoxing.bindTokenTtlMs'),
    credentialKekPath: resolveKekPath(baseDir, config.credentialKekPath ?? './.runtime/chaoxing/credential-kek.key'),
    autoReloginEnabled: config.autoReloginEnabled ?? true,
    sessionValidationTtlMs: positiveInteger(config.sessionValidationTtlMs ?? 600_000, 'chaoxing.sessionValidationTtlMs'),
    allowedGroups: requiredGroups(config.allowedGroups, 'chaoxing.allowedGroups'),
    naturalTriggerEnabled: config.naturalTriggerEnabled === true,
    naturalTriggerGroups: parseGroupSet(config.naturalTriggerGroups ?? ''),
    requestIntervalMs: nonNegativeInteger(config.requestIntervalMs ?? 1_200, 'chaoxing.requestIntervalMs'),
    workerPollIntervalMs: positiveInteger(config.workerPollIntervalMs ?? 5_000, 'chaoxing.workerPollIntervalMs'),
    signWatchIntervalMs: positiveInteger(config.signWatchIntervalMs ?? 15_000, 'chaoxing.signWatchIntervalMs'),
    deadlineSyncIntervalMs: positiveInteger(config.deadlineSyncIntervalMs ?? 900_000, 'chaoxing.deadlineSyncIntervalMs'),
    deadlineReminderLeadMs: positiveInteger(config.deadlineReminderLeadMs ?? 86_400_000, 'chaoxing.deadlineReminderLeadMs'),
    studyPlaybackRate: boundedNumber(config.studyPlaybackRate ?? 1, 0.1, 2, 'chaoxing.studyPlaybackRate'),
    maximumVideoReportIntervalMs: positiveInteger(config.maximumVideoReportIntervalMs ?? 60_000, 'chaoxing.maximumVideoReportIntervalMs'),
    answerProviderUrl: optionalHttpUrl(config.answerProviderUrl, 'chaoxing.answerProviderUrl'),
    answerProviderApiKey: config.answerProviderApiKey?.trim() || undefined,
    answerProviderTimeoutMs: positiveInteger(config.answerProviderTimeoutMs ?? 15_000, 'chaoxing.answerProviderTimeoutMs'),
  };
}

export function buildChaoxingCapabilityReference(session: Session, runtime: Pick<RuntimeConfig, 'allowedGroups' | 'naturalTriggerEnabled' | 'naturalTriggerGroups'>): string {
  const enabled = canUse(session, runtime.allowedGroups);
  return [
    `学习通功能（当前会话${enabled ? '可用' : '未启用'}）：`,
    '- 账号：学习通绑定、学习通确认 <确认码>、学习通状态、学习通解绑。',
    '- 查询：学习通课程、学习通章节 <课程>、学习通待办、学习通作业、学习通考试。',
    '- 签到：学习通签到、学习通签到 <活动ID> [签到码]、学习通签到监听 [课程]、学习通停止签到。',
    '- 刷课：学习通刷课 <课程>、学习通刷课状态、学习通停止刷课。',
    '- 答题：学习通答题 <课程>，收到预览后使用补充、保存、提交或停止命令；学习通错题查看记录。',
    enabled ? '- 命令参数缺失时给出正确格式。' : '- 当前群未开启学习通功能。',
  ].join('\n');
}

const CHAOXING_USAGE_INTENT_PATTERN = /(?:(?:怎么|如何|怎样|咋).{0,4}(?:查|看|用|签到|刷课|答题)|查询|查看|使用|发送|输入|命令|格式|入口|菜单|功能|失败|报错)/;

export function shouldExposeChaoxingCapabilityReference(session: Session): boolean {
  const text = normalizeCommandText(session);
  if (!text) return false;
  if (parseChaoxingCommand(text)) return true;
  if (/^学习通确认\d{6}$/.test(text)) return true;
  if (/^学习通(?:章节|签到监听|签到|刷课|答题(?:补充|保存|提交)?)\S+/.test(text)) return true;
  return text.includes('学习通') && CHAOXING_USAGE_INTENT_PATTERN.test(text);
}

function createNotifier(ctx: ChaoxingServicesContext): ChaoxingNotifier {
  return {
    async send(identity, message) {
      const bot = ctx.bots.find((candidate) => candidate.platform === identity.platform);
      if (!bot) throw new Error(`no bot available for platform ${identity.platform}.`);
      await bot.sendMessage(identity.channelId, message);
    },
  };
}

async function syncDeadlines(store: ChaoxingTaskStore, deadline: ChaoxingDeadlineService, coordinator: ChaoxingOwnerCoordinator): Promise<void> {
  for (const session of await store.listActiveSessions()) {
    const identity = { ownerKey: session.ownerKey, platform: session.platform, qqUserId: session.qqUserId, channelId: session.channelId };
    try {
      await coordinator.run(identity.ownerKey, () => deadline.syncIdentity(identity, true));
    } catch (error) {
      logger.warn('deadline sync failed: owner=%s reason=%s', identity.ownerKey, error instanceof Error ? error.message : String(error));
    }
  }
}

async function assertNoActiveLearningJob(store: ChaoxingTaskStore, ownerKey: string): Promise<void> {
  const active = (await store.listJobs(ownerKey)).find((job) => (job.type === 'study' || job.type === 'answer') && ['queued', 'running', 'waiting_input'].includes(job.status));
  if (active) throw new ChaoxingUserError(`已有学习任务 #${active.id}（${active.status}），请先处理或停止。`);
}

async function requireOwnedWaitingAnswerJob(store: ChaoxingTaskStore, ownerKey: string, jobId: number) {
  const job = await store.getJob(jobId);
  if (!job || job.ownerKey !== ownerKey || job.type !== 'answer') throw new ChaoxingUserError(`答题任务 #${jobId} 不存在。`);
  if (job.status !== 'waiting_input') throw new ChaoxingUserError(`答题任务 #${jobId} 当前状态为 ${job.status}，不能执行该操作。`);
  return job;
}

async function sendReply(nativeFeatureChat: NativeFeatureChatServiceLike, session: Session, command: ChaoxingCommand, text: string, reply: Fragment, success: boolean): Promise<void> {
  const sensitive = command.kind === 'confirm';
  await nativeFeatureChat.sendReply(session, {
    featureId: 'chaoxing',
    commandId: command.kind,
    userText: sensitive ? '学习通确认 <确认码已隐藏>' : text,
    reply,
    summary: success ? '机器人完成学习通功能请求。' : `学习通功能未完成：${String(reply)}`,
    success,
    includeReplyPayload: !sensitive && command.kind !== 'bind',
  });
}

function canUse(session: Session, allowedGroups: Set<string>): boolean {
  if (session.isDirect === true) return true;
  const groupId = normalizeGroupId(session.guildId) ?? normalizeGroupId(session.channelId);
  return Boolean(groupId && allowedGroups.has(groupId));
}

function canInvoke(session: Session, runtime: RuntimeConfig): boolean {
  if (session.isDirect === true || (session as Session & { stripped?: { atSelf?: unknown } }).stripped?.atSelf === true) return true;
  if (!runtime.naturalTriggerEnabled) return false;
  const groupId = normalizeGroupId(session.guildId) ?? normalizeGroupId(session.channelId);
  return Boolean(groupId && runtime.naturalTriggerGroups.has(groupId));
}

function resolveOwnerIdentity(session: Session): OwnerIdentity {
  const platform = String(session.platform ?? '').trim();
  const qqUserId = String(session.userId ?? '').trim();
  const channelId = String(session.channelId ?? '').trim();
  if (!platform || !qqUserId || !channelId) throw new ChaoxingUserError('当前会话缺少 QQ 身份信息。');
  return { ownerKey: `${platform}:${qqUserId}`, platform, qqUserId, channelId };
}

function normalizeCommandText(session: Session): string {
  const carrier = session as Session & { stripped?: { content?: unknown }; content?: unknown };
  return String(carrier.stripped?.content ?? carrier.content ?? '').trim();
}

function toUserMessage(error: unknown): string {
  if (error instanceof ChaoxingUserError) return error.message;
  logger.warn('chaoxing operation failed: %s', error instanceof Error ? error.message : String(error));
  return '学习通操作失败，请稍后重试。';
}

function requestToken(koaCtx: any): string {
  return String(koaCtx.query?.token ?? koaCtx.request?.query?.token ?? '').trim();
}

function writeHtml(koaCtx: any, status: number, html: string): void {
  koaCtx.status = status;
  koaCtx.set('content-type', 'text/html; charset=utf-8');
  koaCtx.set('cache-control', 'no-store');
  koaCtx.body = html;
}

function writeJson(koaCtx: any, status: number, payload: unknown): void {
  koaCtx.status = status;
  koaCtx.set('content-type', 'application/json; charset=utf-8');
  koaCtx.set('cache-control', 'no-store');
  koaCtx.body = payload;
}

async function readRequestBody(koaCtx: any): Promise<Record<string, unknown>> {
  const body = koaCtx.request?.body;
  if (body && typeof body === 'object') return body as Record<string, unknown>;
  const chunks: Buffer[] = [];
  let byteLength = 0;
  if (koaCtx.req) {
    for await (const chunk of koaCtx.req as AsyncIterable<Buffer | string>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.length;
      if (byteLength > 16_384) throw new ChaoxingUserError('请求数据过大。');
      chunks.push(buffer);
    }
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const contentType = String(koaCtx.get?.('content-type') ?? koaCtx.request?.headers?.['content-type'] ?? '');
  if (contentType.includes('application/json')) {
    const parsed = JSON.parse(raw || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ChaoxingUserError('请求数据格式无效。');
    return parsed as Record<string, unknown>;
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function absolutePath(value: string, key: string): string {
  const normalized = value.trim();
  if (!normalized.startsWith('/') || normalized.includes('?') || normalized.includes('#')) throw new Error(`${key} 必须是绝对路径。`);
  return normalized.replace(/\/+$/u, '') || '/';
}

function baseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('chaoxing.publicBaseUrl 必须使用 HTTPS；本机地址允许 HTTP。');
  }
  return url.href.replace(/\/+$/u, '');
}

function optionalHttpUrl(value: string | undefined, key: string): string | undefined {
  if (!value?.trim()) return undefined;
  const url = new URL(value.trim());
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) throw new Error(`${key} 必须使用 HTTPS；本机地址允许 HTTP。`);
  return url.href;
}

function requiredGroups(value: string[] | string | undefined, key: string): Set<string> {
  if (value == null) throw new Error(`${key} 必须显式配置。`);
  return parseGroupSet(value);
}

function positiveInteger(value: number, key: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${key} 必须是正整数。`);
  return value;
}

function nonNegativeInteger(value: number, key: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${key} 必须是非负整数。`);
  return value;
}

function boundedNumber(value: number, minimum: number, maximum: number, key: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${key} 必须位于 ${minimum} 到 ${maximum}。`);
  return value;
}
