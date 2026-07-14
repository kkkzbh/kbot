import type { ChaoxingAuthService, ChaoxingAuthenticatedSession } from './auth-service.js';
import type { ChaoxingClient } from './client.js';
import type { ChaoxingTaskStore } from './store.js';
import { ChaoxingAuthError, ChaoxingUserError, type ChaoxingChapter, type ChaoxingCourse, type OwnerIdentity } from './types.js';

export class ChaoxingCatalogService {
  constructor(
    private readonly authService: ChaoxingAuthService,
    private readonly client: ChaoxingClient,
    private readonly store: ChaoxingTaskStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async listCourses(identity: OwnerIdentity): Promise<ChaoxingCourse[]> {
    return this.withAuth(identity, async (auth) => {
      const result = await this.client.getCourses(auth.cookieJar);
      const updatedAuth = await this.authService.persistCookies(auth, result.cookieJar);
      await this.store.upsertCourses(identity.ownerKey, updatedAuth.credentialVersion, result.courses, this.now());
      return result.courses;
    });
  }

  async resolveCourse(identity: OwnerIdentity, query: string): Promise<ChaoxingCourse> {
    const normalized = query.trim();
    if (!normalized) throw new ChaoxingUserError('请提供课程名关键词或课程 ID。');
    const courses = await this.listCourses(identity);
    const exactId = courses.filter((course) => course.courseId === normalized || course.classId === normalized);
    if (exactId.length === 1) return exactId[0]!;
    const exactName = courses.filter((course) => course.name === normalized || course.className === normalized);
    if (exactName.length === 1) return exactName[0]!;
    const lowered = normalized.toLocaleLowerCase('zh-CN');
    const matches = courses.filter((course) => `${course.name} ${course.className} ${course.teacherName}`.toLocaleLowerCase('zh-CN').includes(lowered));
    if (matches.length === 0) throw new ChaoxingUserError(`没有找到匹配“${normalized}”的学习通课程。`);
    if (matches.length > 1) {
      const names = matches.slice(0, 8).map((course) => `${course.name}（${course.className || course.classId}，ID ${course.courseId}）`).join('\n');
      throw new ChaoxingUserError(`匹配到多门课程，请使用课程 ID 或更完整名称：\n${names}`);
    }
    return matches[0]!;
  }

  async listChapters(identity: OwnerIdentity, query: string): Promise<{ course: ChaoxingCourse; chapters: ChaoxingChapter[] }> {
    const course = await this.resolveCourse(identity, query);
    const chapters = await this.withAuth(identity, async (auth) => {
      const result = await this.client.getChapters(auth.cookieJar, course);
      await this.authService.persistCookies(auth, result.cookieJar);
      return result.chapters;
    });
    return { course, chapters };
  }

  async withAuth<T>(identity: OwnerIdentity, operation: (auth: ChaoxingAuthenticatedSession) => Promise<T>): Promise<T> {
    let auth = await this.authService.getAuthenticatedSession(identity);
    try {
      return await operation(auth);
    } catch (error) {
      if (!(error instanceof ChaoxingAuthError)) throw error;
      auth = await this.authService.refreshAfterAuthError(identity);
      return operation(auth);
    }
  }
}

export function formatCourseList(courses: ChaoxingCourse[]): string {
  if (courses.length === 0) return '学习通没有返回课程。';
  const active = courses.filter((course) => course.isRetired === 0);
  const selected = active.length > 0 ? active : courses;
  return selected.slice(0, 30).map((course, index) => {
    const teacher = course.teacherName ? ` · ${course.teacherName}` : '';
    const className = course.className && course.className !== course.name ? ` · ${course.className}` : '';
    return `${index + 1}. ${course.name}${className}${teacher}\n   课程ID ${course.courseId} / 班级ID ${course.classId}`;
  }).join('\n');
}

export function formatChapterList(course: ChaoxingCourse, chapters: ChaoxingChapter[]): string {
  if (chapters.length === 0) return `${course.name} 暂无章节。`;
  return `${course.name}：\n${chapters.slice(0, 60).map((chapter, index) => `${index + 1}. ${chapter.title}（${chapter.chapterId}）`).join('\n')}`;
}
