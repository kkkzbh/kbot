import { createHash } from 'node:crypto';
import type { ChaoxingAuthService } from './auth-service.js';
import type { ChaoxingCatalogService } from './catalog-service.js';
import type { ChaoxingClient } from './client.js';
import type { ChaoxingTaskStore } from './store.js';
import type { ChaoxingActivity, ChaoxingCourse, ChaoxingDeadlineItem, ChaoxingTaskKind, ChaoxingTaskRow, OwnerIdentity } from './types.js';

export interface ChaoxingNotifierLike {
  send(identity: OwnerIdentity, message: string): Promise<void>;
}

export interface ChaoxingDeadlineRuntimeConfig {
  requestIntervalMs: number;
  reminderLeadMs: number;
}

export class ChaoxingDeadlineService {
  constructor(
    private readonly authService: ChaoxingAuthService,
    private readonly catalogService: ChaoxingCatalogService,
    private readonly client: ChaoxingClient,
    private readonly store: ChaoxingTaskStore,
    private readonly notifier: ChaoxingNotifierLike,
    private readonly config: ChaoxingDeadlineRuntimeConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async syncIdentity(identity: OwnerIdentity, notify = true): Promise<ChaoxingTaskRow[]> {
    const syncStartedAt = this.now();
    const previous = await this.store.listTasks(identity.ownerKey);
    const courses = (await this.catalogService.listCourses(identity)).filter((course) => course.isRetired === 0);
    let auth = await this.authService.getAuthenticatedSession(identity);
    const items: ChaoxingDeadlineItem[] = [];
    for (const course of courses) {
      const assignments = await this.client.getAssignments(auth.cookieJar, course);
      auth = await this.authService.persistCookies(auth, assignments.cookieJar);
      await delay(this.config.requestIntervalMs);
      const exams = await this.client.getExams(auth.cookieJar, course);
      auth = await this.authService.persistCookies(auth, exams.cookieJar);
      await delay(this.config.requestIntervalMs);
      const activities = await this.client.getActivities(auth.cookieJar, course);
      auth = await this.authService.persistCookies(auth, activities.cookieJar);
      items.push(...assignments.items, ...exams.items, ...activities.activities.map((activity) => activityDeadline(course, activity)));
      await delay(this.config.requestIntervalMs);
    }
    const created = await this.store.replaceTaskSnapshot(identity.ownerKey, auth.credentialVersion, items, sha256, syncStartedAt);
    await this.store.pruneTasks(identity.ownerKey, syncStartedAt);
    if (notify && previous.length > 0 && created.length > 0) {
      const message = `学习通发现 ${created.length} 个新任务：\n${created.slice(0, 8).map(formatTaskLine).join('\n')}`;
      await this.notifier.send(identity, message);
      for (const row of created) await this.store.markTaskNotified(row.id, this.now());
    }
    await this.sendDueReminders(identity);
    return this.store.listTasks(identity.ownerKey);
  }

  async query(identity: OwnerIdentity, kind?: ChaoxingTaskKind): Promise<ChaoxingTaskRow[]> {
    const existing = await this.store.listTasks(identity.ownerKey, kind);
    if (existing.length > 0) return pendingTasks(existing);
    const synced = await this.syncIdentity(identity, false);
    return pendingTasks(kind ? synced.filter((item) => item.kind === kind) : synced);
  }

  private async sendDueReminders(identity: OwnerIdentity): Promise<void> {
    const now = this.now();
    const due = pendingTasks(await this.store.listTasks(identity.ownerKey)).filter((item) =>
      item.endAt != null && item.endAt > now && item.endAt - now <= this.config.reminderLeadMs && item.remindedAt == null,
    );
    if (due.length === 0) return;
    await this.notifier.send(identity, `学习通任务即将截止：\n${due.slice(0, 8).map(formatTaskLine).join('\n')}`);
    for (const item of due) await this.store.markTaskReminded(item.id, now);
  }
}

export function formatTaskList(items: ChaoxingTaskRow[], title = '学习通待办'): string {
  if (items.length === 0) return `${title}：当前没有未完成任务。`;
  return `${title}（${items.length}）：\n${items.slice(0, 30).map(formatTaskLine).join('\n')}`;
}

function activityDeadline(course: ChaoxingCourse, activity: ChaoxingActivity): ChaoxingDeadlineItem {
  const signed = activity.userStatus === 1;
  const status = signed ? '已签到' : activity.status === 1 ? '进行中' : '已结束';
  return {
    recordKey: `sign:${course.courseId}:${course.classId}:${activity.activityId}`,
    kind: 'sign', courseId: course.courseId, classId: course.classId, remoteId: activity.activityId,
    courseName: course.name, title: activity.title || '签到', status, startAt: activity.startAt, endAt: activity.endAt,
    score: null, source: activity.raw,
  };
}

function pendingTasks(items: ChaoxingTaskRow[]): ChaoxingTaskRow[] {
  const done = new Set(['已完成', '已批阅', '已交', '待批阅', '已签到', '已结束']);
  return items.filter((item) => !done.has(item.status)).sort((left, right) => (left.endAt ?? Number.MAX_SAFE_INTEGER) - (right.endAt ?? Number.MAX_SAFE_INTEGER));
}

function formatTaskLine(item: Pick<ChaoxingTaskRow, 'kind' | 'courseName' | 'title' | 'status' | 'endAt'>): string {
  const label = item.kind === 'work' ? '作业' : item.kind === 'exam' ? '考试' : '签到';
  const deadline = item.endAt ? ` · 截止 ${formatDate(item.endAt)}` : '';
  return `- [${label}] ${item.courseName} / ${item.title} · ${item.status || '状态未知'}${deadline}`;
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
