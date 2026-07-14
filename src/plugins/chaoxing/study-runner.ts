import type { ChaoxingAnswerDraft, ChaoxingAnswerService } from './answer-service.js';
import type { ChaoxingAuthService, ChaoxingAuthenticatedSession } from './auth-service.js';
import type { ChaoxingCatalogService } from './catalog-service.js';
import type { ChaoxingClient, ChaoxingTaskAttachment, ChaoxingTaskCardDefaults } from './client.js';
import type { ChaoxingTaskStore } from './store.js';
import {
  ChaoxingProtocolError,
  ChaoxingUserError,
  type ChaoxingChapter,
  type ChaoxingCourse,
  type ChaoxingJob,
  type OwnerIdentity,
} from './types.js';

export interface ChaoxingStudyRuntimeConfig {
  requestIntervalMs: number;
  playbackRate: number;
  maximumReportIntervalMs: number;
}

export interface ChaoxingStudyProgress {
  courseName: string;
  chapterIndex: number;
  attachmentIndex: number;
  completedTasks: number;
  skippedTasks: number;
  currentChapter?: string;
  currentTask?: string;
  currentVideoTime?: number;
  currentVideoDuration?: number;
}

export interface ChaoxingAnswerJobProgress {
  phase: 'prepared';
  courseName: string;
  draft: ChaoxingAnswerDraft;
}

export class ChaoxingStudyRunner {
  constructor(
    private readonly authService: ChaoxingAuthService,
    private readonly catalogService: ChaoxingCatalogService,
    private readonly client: ChaoxingClient,
    private readonly answerService: ChaoxingAnswerService,
    private readonly store: ChaoxingTaskStore,
    private readonly config: ChaoxingStudyRuntimeConfig,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (milliseconds: number) => Promise<void> = delay,
  ) {}

  async runStudy(job: ChaoxingJob): Promise<ChaoxingStudyProgress> {
    const identity = jobIdentity(job);
    const course = await this.resolveJobCourse(identity, job);
    const chapterResult = await this.catalogService.listChapters(identity, course.courseId);
    const restored = parseStudyProgress(job.progressJson, course.name);
    let progress = { ...restored, courseName: course.name };
    let auth = await this.authService.getAuthenticatedSession(identity);

    for (let chapterIndex = progress.chapterIndex; chapterIndex < chapterResult.chapters.length; chapterIndex += 1) {
      await this.assertRunning(job.id);
      const chapter = chapterResult.chapters[chapterIndex]!;
      const cardResult = await this.client.getChapterTasks(auth.cookieJar, course, chapter);
      auth = await this.authService.persistCookies(auth, cardResult.cookieJar);
      if (cardResult.card.notOpen) {
        progress = await this.skipChapter(job, progress, chapterIndex, chapter, '章节尚未开放');
        await this.sleepWithCancellation(job.id, this.config.requestIntervalMs);
        continue;
      }
      if (cardResult.card.faceRequired) {
        throw new ChaoxingUserError(`${chapter.title} 要求人脸采集，刷课任务已暂停。`);
      }
      const startAttachment = chapterIndex === progress.chapterIndex ? progress.attachmentIndex : 0;
      for (let attachmentIndex = startAttachment; attachmentIndex < cardResult.card.attachments.length; attachmentIndex += 1) {
        await this.assertRunning(job.id);
        const attachment = cardResult.card.attachments[attachmentIndex]!;
        progress = {
          ...progress,
          chapterIndex,
          attachmentIndex,
          currentChapter: chapter.title,
          currentTask: attachment.type,
          currentVideoTime: undefined,
          currentVideoDuration: undefined,
        };
        await this.store.updateJobProgress(job.id, progress, this.now());
        if (!attachment.job || attachment.isPassed) {
          progress = await this.advance(job, progress, chapterIndex, attachmentIndex, attachment.isPassed ? 'already_passed' : 'non_job');
          continue;
        }
        if (attachment.type === 'video') {
          auth = await this.runVideo(job, auth, course, chapter, cardResult.card.defaults, attachment, progress);
        } else if (attachment.type === 'document') {
          auth = await this.runDocument(auth, course, chapter, attachment);
        } else if (attachment.type === 'read') {
          auth = await this.runRead(auth, course, chapter, attachment);
        } else {
          progress = await this.skipAttachment(job, progress, chapterIndex, attachmentIndex, attachment.type);
          continue;
        }
        auth = await this.verifyPassed(auth, course, chapter, attachment);
        progress = await this.advance(job, progress, chapterIndex, attachmentIndex, 'completed');
        await this.sleep(this.config.requestIntervalMs);
      }
      progress = { ...progress, chapterIndex: chapterIndex + 1, attachmentIndex: 0, currentChapter: undefined, currentTask: undefined };
      await this.store.updateJobProgress(job.id, progress, this.now());
      await this.sleepWithCancellation(job.id, this.config.requestIntervalMs);
    }
    return progress;
  }

  async prepareAnswer(job: ChaoxingJob): Promise<ChaoxingAnswerJobProgress | null> {
    const identity = jobIdentity(job);
    const course = await this.resolveJobCourse(identity, job);
    const { chapters } = await this.catalogService.listChapters(identity, course.courseId);
    let auth = await this.authService.getAuthenticatedSession(identity);
    for (const chapter of chapters) {
      await this.assertRunning(job.id);
      const cardResult = await this.client.getChapterTasks(auth.cookieJar, course, chapter);
      auth = await this.authService.persistCookies(auth, cardResult.cookieJar);
      if (cardResult.card.notOpen || cardResult.card.faceRequired) {
        await this.sleepWithCancellation(job.id, this.config.requestIntervalMs);
        continue;
      }
      const work = cardResult.card.attachments.find((attachment) => attachment.job && !attachment.isPassed && attachment.type === 'workid');
      if (!work) {
        await this.sleepWithCancellation(job.id, this.config.requestIntervalMs);
        continue;
      }
      const draft = await this.answerService.prepareDraft(identity, {
        course,
        chapterId: chapter.chapterId,
        chapterOrigin: chapter.courseOrigin,
        attachment: work,
        defaults: cardResult.card.defaults,
      });
      return { phase: 'prepared', courseName: course.name, draft };
    }
    return null;
  }

  private async resolveJobCourse(identity: OwnerIdentity, job: ChaoxingJob): Promise<ChaoxingCourse> {
    const query = job.courseId || job.courseQuery;
    if (!query) throw new Error(`chaoxing job ${job.id} has no course.`);
    const course = await this.catalogService.resolveCourse(identity, query);
    if (job.classId && course.classId !== job.classId) throw new ChaoxingUserError('课程班级已经变化，请重新创建任务。');
    return course;
  }

  private async runVideo(
    job: ChaoxingJob,
    initialAuth: ChaoxingAuthenticatedSession,
    course: ChaoxingCourse,
    chapter: ChaoxingChapter,
    defaults: ChaoxingTaskCardDefaults,
    attachment: ChaoxingTaskAttachment,
    baseProgress: ChaoxingStudyProgress,
  ): Promise<ChaoxingAuthenticatedSession> {
    if (!attachment.objectId || !attachment.jobid || !defaults.reportUrl || !defaults.userid) {
      throw new ChaoxingProtocolError('video_attachment_fields', `${chapter.title} 的视频任务缺少上报字段。`);
    }
    let auth = initialAuth;
    const statusResult = await this.client.getVideoStatus(auth.cookieJar, {
      objectId: attachment.objectId,
      fid: defaults.fid,
      refererUrl: attachment.refererUrl,
    });
    auth = await this.authService.persistCookies(auth, statusResult.cookieJar);
    const duration = statusResult.status.duration;
    let playingTime = Math.max(0, Math.min(duration, Math.floor(attachment.playTime)));
    const intervalSeconds = Math.max(1, Math.min(
      Math.floor(this.config.maximumReportIntervalMs / 1000),
      Math.floor(defaults.reportTimeInterval || 60),
    ));
    const rt = videoRate(attachment);
    let passed = false;
    while (playingTime < duration || !passed) {
      await this.assertRunning(job.id);
      if (playingTime < duration) {
        const increment = Math.min(intervalSeconds, duration - playingTime);
        await this.sleepWithCancellation(job.id, Math.ceil((increment * 1000) / this.config.playbackRate));
        playingTime += increment;
      }
      const report = await this.client.reportVideoProgress(auth.cookieJar, {
        reportUrl: defaults.reportUrl,
        dtoken: statusResult.status.dtoken,
        classId: course.classId,
        userId: defaults.userid,
        jobId: attachment.jobid,
        objectId: attachment.objectId,
        otherInfo: attachment.otherInfo,
        playingTime,
        duration,
        rt,
        startTime: attachment.startTime,
        endTime: attachment.endTime,
        refererUrl: attachment.refererUrl,
        courseEngineInfo: defaults.courseEngineInfo,
        attDuration: attachment.attDuration,
        attDurationEnc: attachment.attDurationEnc,
        videoFaceCaptureEnc: attachment.videoFaceCaptureEnc,
      });
      auth = await this.authService.persistCookies(auth, report.cookieJar);
      passed = report.passed;
      const progress = { ...baseProgress, currentVideoTime: playingTime, currentVideoDuration: duration };
      await this.store.updateJobProgress(job.id, progress, this.now());
      await this.store.appendJobEvent(job.id, job.ownerKey, 'video_progress', {
        chapterId: chapter.chapterId, jobId: attachment.jobid, playingTime, duration, passed, response: report.response,
      }, this.now());
      if (playingTime >= duration && !passed) break;
    }
    if (!passed) {
      const verification = await this.client.getChapterTasks(auth.cookieJar, course, chapter);
      auth = await this.authService.persistCookies(auth, verification.cookieJar);
      const verified = verification.card.attachments.find((item) => item.jobid === attachment.jobid)?.isPassed === true;
      if (!verified) throw new ChaoxingProtocolError('video_not_passed', `${chapter.title} 的视频已上报到结尾，学习通仍未标记完成。`);
    }
    return auth;
  }

  private async runDocument(auth: ChaoxingAuthenticatedSession, course: ChaoxingCourse, chapter: ChaoxingChapter, attachment: ChaoxingTaskAttachment): Promise<ChaoxingAuthenticatedSession> {
    if (!attachment.jobid || !attachment.jtoken) throw new ChaoxingProtocolError('document_attachment_fields', `${chapter.title} 的文档任务缺少令牌。`);
    const cookies = await this.client.completeDocument(auth.cookieJar, {
      origin: chapter.courseOrigin, course, chapterId: chapter.chapterId, jobId: attachment.jobid, jtoken: attachment.jtoken,
      refererUrl: attachment.refererUrl,
    });
    return this.authService.persistCookies(auth, cookies);
  }

  private async runRead(auth: ChaoxingAuthenticatedSession, course: ChaoxingCourse, chapter: ChaoxingChapter, attachment: ChaoxingTaskAttachment): Promise<ChaoxingAuthenticatedSession> {
    if (!attachment.jobid || !attachment.jtoken) throw new ChaoxingProtocolError('read_attachment_fields', `${chapter.title} 的阅读任务缺少令牌。`);
    const cookies = await this.client.completeRead(auth.cookieJar, {
      origin: chapter.courseOrigin, course, chapterId: chapter.chapterId, jobId: attachment.jobid, jtoken: attachment.jtoken,
      refererUrl: attachment.refererUrl,
    });
    return this.authService.persistCookies(auth, cookies);
  }

  private async verifyPassed(auth: ChaoxingAuthenticatedSession, course: ChaoxingCourse, chapter: ChaoxingChapter, attachment: ChaoxingTaskAttachment): Promise<ChaoxingAuthenticatedSession> {
    const result = await this.client.getChapterTasks(auth.cookieJar, course, chapter);
    const updated = await this.authService.persistCookies(auth, result.cookieJar);
    const current = result.card.attachments.find((item) => item.jobid === attachment.jobid);
    if (!current?.isPassed) {
      throw new ChaoxingProtocolError('task_not_passed', `${chapter.title} 的 ${attachment.type} 任务执行后仍未通过。`);
    }
    return updated;
  }

  private async advance(job: ChaoxingJob, progress: ChaoxingStudyProgress, chapterIndex: number, attachmentIndex: number, reason: string): Promise<ChaoxingStudyProgress> {
    const next = {
      ...progress,
      chapterIndex,
      attachmentIndex: attachmentIndex + 1,
      completedTasks: reason === 'completed' || reason === 'already_passed' ? progress.completedTasks + 1 : progress.completedTasks,
      skippedTasks: reason === 'non_job' ? progress.skippedTasks + 1 : progress.skippedTasks,
      currentVideoTime: undefined,
      currentVideoDuration: undefined,
    };
    await this.store.updateJobProgress(job.id, next, this.now());
    await this.store.appendJobEvent(job.id, job.ownerKey, reason, { chapterIndex, attachmentIndex }, this.now());
    return next;
  }

  private async skipAttachment(job: ChaoxingJob, progress: ChaoxingStudyProgress, chapterIndex: number, attachmentIndex: number, type: string): Promise<ChaoxingStudyProgress> {
    const next = { ...progress, chapterIndex, attachmentIndex: attachmentIndex + 1, skippedTasks: progress.skippedTasks + 1 };
    await this.store.updateJobProgress(job.id, next, this.now());
    await this.store.appendJobEvent(job.id, job.ownerKey, 'unsupported_task_skipped', { chapterIndex, attachmentIndex, type }, this.now());
    return next;
  }

  private async skipChapter(job: ChaoxingJob, progress: ChaoxingStudyProgress, chapterIndex: number, chapter: ChaoxingChapter, reason: string): Promise<ChaoxingStudyProgress> {
    const next = { ...progress, chapterIndex: chapterIndex + 1, attachmentIndex: 0, skippedTasks: progress.skippedTasks + 1 };
    await this.store.updateJobProgress(job.id, next, this.now());
    await this.store.appendJobEvent(job.id, job.ownerKey, 'chapter_skipped', { chapterId: chapter.chapterId, title: chapter.title, reason }, this.now());
    return next;
  }

  private async assertRunning(jobId: number): Promise<void> {
    const current = await this.store.getJob(jobId);
    if (!current || current.status !== 'running') throw new JobCancelledError();
  }

  private async sleepWithCancellation(jobId: number, milliseconds: number): Promise<void> {
    let remaining = milliseconds;
    while (remaining > 0) {
      const interval = Math.min(1_000, remaining);
      await this.sleep(interval);
      remaining -= interval;
      await this.assertRunning(jobId);
    }
  }
}

export class JobCancelledError extends Error {
  constructor() {
    super('job cancelled');
    this.name = 'JobCancelledError';
  }
}

export function parseStudyProgress(value: string, courseName: string): ChaoxingStudyProgress {
  if (!value || value === '{}') return { courseName, chapterIndex: 0, attachmentIndex: 0, completedTasks: 0, skippedTasks: 0 };
  const parsed = JSON.parse(value) as Partial<ChaoxingStudyProgress>;
  if (!Number.isInteger(parsed.chapterIndex) || !Number.isInteger(parsed.attachmentIndex) || !Number.isInteger(parsed.completedTasks) || !Number.isInteger(parsed.skippedTasks)) {
    throw new Error('stored chaoxing study progress is invalid.');
  }
  return parsed as ChaoxingStudyProgress;
}

export function selectResumableStudyJob(jobs: ChaoxingJob[], course: Pick<ChaoxingCourse, 'courseId' | 'classId'>): ChaoxingJob | undefined {
  return jobs
    .filter((job) => job.type === 'study'
      && job.courseId === course.courseId
      && job.classId === course.classId
      && ['waiting_input', 'failed', 'cancelled'].includes(job.status))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function videoRate(attachment: ChaoxingTaskAttachment): number {
  const propertyRate = Number(attachment.property.rt);
  if (Number.isFinite(propertyRate) && propertyRate > 0) return propertyRate;
  if (attachment.otherInfo.includes('-rt_d')) return 0.9;
  const match = attachment.otherInfo.match(/(?:^|[?&-])rt[_=-]([0-9.]+)/u);
  if (match && Number(match[1]) > 0) return Number(match[1]);
  return 1;
}

function jobIdentity(job: ChaoxingJob): OwnerIdentity {
  return { ownerKey: job.ownerKey, platform: job.platform, qqUserId: job.qqUserId, channelId: job.channelId };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
