import { formatAnswerDraft } from './answer-service.js';
import { Logger } from 'koishi';
import type { ChaoxingAuthService } from './auth-service.js';
import type { ChaoxingOwnerCoordinator } from './owner-coordinator.js';
import { filterPendingSigns, isAutomaticallyExecutable, signActionInstruction, signTypeLabel, type ChaoxingSignService, type DetectedSign } from './sign-service.js';
import { JobCancelledError, type ChaoxingAnswerJobProgress, type ChaoxingStudyRunner } from './study-runner.js';
import type { ChaoxingTaskStore } from './store.js';
import {
  ChaoxingCaptchaRequiredError,
  ChaoxingAuthError,
  ChaoxingProtocolError,
  ChaoxingUserError,
  type ChaoxingJob,
  type OwnerIdentity,
} from './types.js';

export interface ChaoxingNotifier {
  send(identity: OwnerIdentity, message: string): Promise<void>;
}

export interface ChaoxingWorkerConfig {
  pollIntervalMs: number;
  signWatchIntervalMs: number;
}

interface SignWatchProgress {
  seenActivityIds: string[];
  scanCount: number;
  lastScannedAt?: number;
}

const logger = new Logger('chaoxing-worker');

export class ChaoxingWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private stopped = true;

  constructor(
    private readonly store: ChaoxingTaskStore,
    private readonly studyRunner: ChaoxingStudyRunner,
    private readonly signService: ChaoxingSignService,
    private readonly authService: ChaoxingAuthService,
    private readonly notifier: ChaoxingNotifier,
    private readonly coordinator: ChaoxingOwnerCoordinator,
    private readonly config: ChaoxingWorkerConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  wake(): void {
    if (this.stopped || this.busy) return;
    if (this.timer) clearTimeout(this.timer);
    this.schedule(0);
  }

  async runOnce(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const queued = await this.store.nextQueuedJob(this.now());
      if (!queued) return false;
      await this.store.markJobRunning(queued.id, this.now());
      const job = await this.store.getJob(queued.id);
      if (!job || job.status !== 'running') return true;
      await this.coordinator.run(job.ownerKey, () => this.dispatch(job));
      return true;
    } finally {
      this.busy = false;
    }
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      const worked = await this.runOnce();
      if (!this.stopped) this.schedule(worked ? 0 : this.config.pollIntervalMs);
    } catch (error) {
      logger.warn('worker tick failed: %s', error instanceof Error ? error.message : String(error));
      if (!this.stopped) this.schedule(this.config.pollIntervalMs);
    }
  }

  private async dispatch(job: ChaoxingJob): Promise<void> {
    const identity = jobIdentity(job);
    try {
      if (job.type === 'study') {
        const progress = await this.studyRunner.runStudy(job);
        await this.store.finishJob(job.id, 'succeeded', { progress, result: progress }, this.now());
        await this.sendNotification(job, identity, `学习通刷课任务 #${job.id} 已完成：处理 ${progress.completedTasks} 项，跳过 ${progress.skippedTasks} 项。`);
        return;
      }
      if (job.type === 'answer') {
        const progress = await this.studyRunner.prepareAnswer(job);
        if (!progress) {
          await this.store.finishJob(job.id, 'succeeded', { result: { message: '没有未完成的章节测验。' } }, this.now());
          await this.sendNotification(job, identity, `学习通答题任务 #${job.id}：没有找到未完成的章节测验。`);
          return;
        }
        await this.store.finishJob(job.id, 'waiting_input', { progress }, this.now());
        await this.sendNotification(job, identity, formatAnswerDraft(job.id, progress.draft));
        return;
      }
      if (job.type === 'sign_watch') {
        await this.runSignWatch(job, identity);
        return;
      }
      throw new Error(`unsupported chaoxing job type: ${job.type}`);
    } catch (error) {
      if (error instanceof JobCancelledError) return;
      const current = await this.store.getJob(job.id);
      if (!current || current.status === 'cancelled') return;
      let failure = error;
      if (error instanceof ChaoxingAuthError) {
        try {
          await this.authService.refreshAfterAuthError(identity);
          const progress = JSON.parse(current.progressJson) as unknown;
          await this.store.rescheduleJob(job.id, progress, this.now(), this.now());
          await this.store.appendJobEvent(job.id, job.ownerKey, 'session_refreshed', { reason: error.message }, this.now());
          return;
        } catch (refreshError) {
          failure = refreshError;
        }
      }
      const message = errorMessage(failure);
      const waiting = failure instanceof ChaoxingCaptchaRequiredError || /人脸|验证码/u.test(message);
      await this.store.finishJob(job.id, waiting ? 'waiting_input' : 'failed', { errorMessage: message }, this.now());
      await this.store.appendJobEvent(job.id, job.ownerKey, waiting ? 'waiting_input' : 'failed', errorDetail(failure), this.now());
      await this.sendNotification(job, identity, `学习通${jobTypeLabel(job.type)}任务 #${job.id}${waiting ? '已暂停' : '失败'}：${message}`);
    }
  }

  private async runSignWatch(job: ChaoxingJob, identity: OwnerIdentity): Promise<void> {
    const payload = parseObject(job.payloadJson, 'sign watch payload');
    const courseQuery = typeof payload.courseQuery === 'string' && payload.courseQuery.trim() ? payload.courseQuery.trim() : undefined;
    const progress = parseSignWatchProgress(job.progressJson);
    const seen = new Set(progress.seenActivityIds);
    const signs = filterPendingSigns(await this.signService.scanOpenSigns(identity, courseQuery));
    for (const sign of signs) {
      if (seen.has(sign.activity.activityId)) continue;
      await this.handleNewSign(job, identity, sign);
      seen.add(sign.activity.activityId);
    }
    const next: SignWatchProgress = { seenActivityIds: [...seen], scanCount: progress.scanCount + 1, lastScannedAt: this.now() };
    await this.store.rescheduleJob(job.id, next, this.now() + this.config.signWatchIntervalMs, this.now());
  }

  private async handleNewSign(job: ChaoxingJob, identity: OwnerIdentity, sign: DetectedSign): Promise<void> {
    if (isAutomaticallyExecutable(sign)) {
      const result = await this.signService.execute(identity, sign, undefined, job.id);
      await this.store.appendJobEvent(job.id, job.ownerKey, 'sign_executed', {
        activityId: sign.activity.activityId, signType: sign.signType, status: result.status,
      }, this.now());
      await this.sendNotification(job, identity, result.message);
      return;
    }
    const label = signTypeLabel(sign.signType);
    await this.store.appendJobEvent(job.id, job.ownerKey, 'sign_input_required', {
      activityId: sign.activity.activityId, signType: sign.signType,
    }, this.now());
    const instruction = signActionInstruction(sign);
    await this.sendNotification(job, identity, `检测到 ${label}：${sign.course.name} / ${sign.activity.title}（活动ID ${sign.activity.activityId}）\n${instruction}`);
  }

  private async sendNotification(job: ChaoxingJob, identity: OwnerIdentity, message: string): Promise<void> {
    try {
      await this.notifier.send(identity, message);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('notification failed: job=%s owner=%s reason=%s', job.id, job.ownerKey, reason);
      await this.store.appendJobEvent(job.id, job.ownerKey, 'notification_failed', { channelId: identity.channelId, reason }, this.now());
    }
  }
}

export function formatJobStatus(job: ChaoxingJob): string {
  const status = {
    queued: '排队中', running: '执行中', waiting_input: '等待输入', succeeded: '已完成', failed: '失败', cancelled: '已取消',
  }[job.status];
  let detail = '';
  if (job.type === 'study') {
    const progress = parseObject(job.progressJson, 'study progress');
    const completed = typeof progress.completedTasks === 'number' ? progress.completedTasks : 0;
    const skipped = typeof progress.skippedTasks === 'number' ? progress.skippedTasks : 0;
    const current = typeof progress.currentChapter === 'string' ? `，当前 ${progress.currentChapter}` : '';
    detail = `，完成 ${completed}，跳过 ${skipped}${current}`;
  }
  const error = job.errorMessage ? `\n原因：${job.errorMessage}` : '';
  return `任务 #${job.id} · ${jobTypeLabel(job.type)} · ${status}${detail}${error}`;
}

export function parseAnswerJobProgress(value: string): ChaoxingAnswerJobProgress {
  const parsed = parseObject(value, 'answer job progress') as unknown as ChaoxingAnswerJobProgress;
  if (parsed.phase !== 'prepared' || !parsed.draft?.workId || !Array.isArray(parsed.draft.entries)) {
    throw new Error('stored chaoxing answer progress is invalid.');
  }
  return parsed;
}

function parseSignWatchProgress(value: string): SignWatchProgress {
  if (!value || value === '{}') return { seenActivityIds: [], scanCount: 0 };
  const parsed = parseObject(value, 'sign watch progress');
  if (!Array.isArray(parsed.seenActivityIds) || !parsed.seenActivityIds.every((item) => typeof item === 'string') || !Number.isInteger(parsed.scanCount)) {
    throw new Error('stored chaoxing sign watch progress is invalid.');
  }
  return { seenActivityIds: parsed.seenActivityIds as string[], scanCount: parsed.scanCount as number, lastScannedAt: typeof parsed.lastScannedAt === 'number' ? parsed.lastScannedAt : undefined };
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`stored chaoxing ${label} is invalid.`);
  return parsed as Record<string, unknown>;
}

function jobIdentity(job: ChaoxingJob): OwnerIdentity {
  return { ownerKey: job.ownerKey, platform: job.platform, qqUserId: job.qqUserId, channelId: job.channelId };
}

function errorMessage(error: unknown): string {
  if (error instanceof ChaoxingUserError || error instanceof ChaoxingProtocolError) return error.message;
  return '任务执行时发生内部错误。';
}

function errorDetail(error: unknown): Record<string, unknown> {
  if (error instanceof ChaoxingProtocolError) return { name: error.name, code: error.code, message: error.message, responseExcerpt: error.responseExcerpt };
  if (error instanceof ChaoxingCaptchaRequiredError) return { name: error.name, message: error.message, responseExcerpt: error.responseExcerpt };
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { message: String(error) };
}

function jobTypeLabel(type: ChaoxingJob['type']): string {
  return type === 'study' ? '刷课' : type === 'answer' ? '答题' : '签到监听';
}
