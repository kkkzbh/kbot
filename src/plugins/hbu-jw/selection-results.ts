import { h, type Fragment } from 'koishi';
import {
  formatAcademicFallbackNotice,
  hbuJwDatabaseFallbackPolicy,
  type HbuJwAcademicCache,
} from './academic-cache.js';
import type { HbuJwHttpClient } from './jw-client.js';
import {
  buildHbuJwScheduleView,
  renderHbuJwScheduleImage,
  type HbuJwSchedulePuppeteerLike,
} from './schedule.js';
import {
  HbuJwUserError,
  type HbuJwCourseSelectionResult,
  type HbuJwThisSemesterSchedule,
  type OwnerIdentity,
  type SerializedCookieJar,
} from './types.js';

export interface HbuJwSelectionResultAuthServiceLike {
  ensureAuthenticated(identity: OwnerIdentity): Promise<
    | { kind: 'authenticated'; cookieJar: SerializedCookieJar; credentialVersion?: number }
    | { kind: 'needs_binding'; reason: string }
    | { kind: 'invalid'; reason: string }
  >;
}

export class HbuJwSelectionResultService {
  constructor(
    private readonly authService: HbuJwSelectionResultAuthServiceLike,
    private readonly jwClient: Pick<HbuJwHttpClient, 'getCourseSelectionResult'>,
    private readonly puppeteer: HbuJwSchedulePuppeteerLike,
    private readonly academicCache?: Pick<HbuJwAcademicCache, 'getCourseSelectionResult'>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async querySelectionResult(identity: OwnerIdentity): Promise<Fragment> {
    const auth = await this.authService.ensureAuthenticated(identity);
    if (auth.kind !== 'authenticated') throw new HbuJwUserError(auth.reason);

    try {
      const query = this.academicCache
        ? await this.academicCache.getCourseSelectionResult(identity, auth, hbuJwDatabaseFallbackPolicy())
        : { data: await this.jwClient.getCourseSelectionResult(auth.cookieJar), source: 'remote' as const, fetchedAt: this.now() };
      const schedule = buildHbuJwSelectionSchedule(query.data);
      const view = buildHbuJwScheduleView(schedule, 'full-semester', this.now());
      const notice = formatAcademicFallbackNotice([query]);
      return [
        h.at(identity.qqUserId),
        h.text(notice ? `\n${notice}\n` : '\n'),
        await renderHbuJwScheduleImage(this.puppeteer, view, 'gif'),
      ];
    } catch (error) {
      if (error instanceof HbuJwUserError) throw error;
      throw new HbuJwUserError('教务选课结果查询失败，请稍后重试。');
    }
  }
}

export function buildHbuJwSelectionSchedule(result: HbuJwCourseSelectionResult): HbuJwThisSemesterSchedule {
  const courses = result.groups.flatMap((group) => group.courses);
  const firstCourse = courses[0];
  if (!firstCourse) throw new HbuJwUserError('教务系统当前没有选课结果。');

  return {
    executiveEducationPlanNumber: firstCourse.executiveEducationPlanNumber,
    programPlanName: result.groups[0]?.programPlanName || '未归入培养方案',
    totalUnits: result.totalUnits,
    courses: courses.map((course) => ({
      courseNumber: course.courseNumber,
      sequenceNumber: course.sequenceNumber,
      executiveEducationPlanNumber: course.executiveEducationPlanNumber,
      courseName: course.courseName,
      unit: course.unit,
      coursePropertiesName: course.coursePropertiesName,
      courseCategoryName: course.courseCategoryName,
      examTypeName: course.examTypeName,
      teacherName: course.teacherName,
      selectCourseStatusName: course.selectCourseStatusName,
      timeAndPlaceList: course.timeAndPlaceList,
    })),
  };
}
