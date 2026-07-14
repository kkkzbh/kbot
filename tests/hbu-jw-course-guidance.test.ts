import { describe, expect, it, vi } from 'vitest';
import {
  calculateGuidanceProgress,
  HbuJwCourseGuidanceService,
  renderGuidanceHtml,
  selectMaxConflictFreeCreditCombination,
  selectMaxCreditCombination,
  selectNearestFreshTrainingPlan,
  type HbuJwGuidanceContext,
} from '../src/plugins/hbu-jw/course-guidance.js';
import { HbuJwHttpClient } from '../src/plugins/hbu-jw/jw-client.js';
import { HbuJwStore } from '../src/plugins/hbu-jw/store.js';
import type {
  HbuJwCourseSelectionResult,
  HbuJwCourseOffering,
  HbuJwScoreRow,
  HbuJwTrainingPlanSnapshot,
  HbuJwTrainingPlanCacheRow,
  SerializedCookieJar,
  DatabaseLike,
} from '../src/plugins/hbu-jw/types.js';

const EMPTY_JAR: SerializedCookieJar = { cookies: [] };

function snapshot(): HbuJwTrainingPlanSnapshot {
  return {
    planNumber: '10708',
    planName: '计算机科学与技术专业2023版培养方案',
    majorCode: '080901',
    majorName: '计算机科学与技术',
    cohortYear: 2023,
    requiredCredits: 167,
    categories: [
      { code: 'A', name: '专业必修课', requiredCredits: 100 },
      { code: 'B', name: '专业任选课', requiredCredits: 60 },
      { code: 'C', name: '通识通选课', requiredCredits: 7 },
    ],
    courses: [
      { courseNumber: 'CS101', courseName: '程序设计', categoryCode: 'A', categoryName: '专业必修课', attribute: 'required', credits: 4, replacementCourseNumbers: [] },
      { courseNumber: 'CS102', courseName: '数据结构', categoryCode: 'A', categoryName: '专业必修课', attribute: 'required', credits: 4, replacementCourseNumbers: ['CS102X'] },
      { courseNumber: 'CS201', courseName: '机器学习', categoryCode: 'B', categoryName: '专业任选课', attribute: 'elective', credits: 3, replacementCourseNumbers: [] },
    ],
  };
}

function selection(): HbuJwCourseSelectionResult {
  return {
    totalUnits: 3,
    groups: [{
      programPlanCode: '10708',
      programPlanName: '培养方案',
      totalUnits: 3,
      courses: [{
        courseNumber: 'CS201',
        sequenceNumber: '01',
        executiveEducationPlanNumber: '2026-2027-1',
        courseName: '机器学习',
        unit: 3,
        coursePropertiesName: '任选',
        courseCategoryName: '专业任选课',
        examTypeName: '考试',
        teacherName: '教师',
        studyModeName: '正常',
        selectCourseStatusName: '选中',
        restrictedCondition: '',
        courseSelectionTime: '',
        timeAndPlaceList: [],
      }],
    }],
  };
}

describe('hbu-jw course guidance calculation', () => {
  it('atomically replaces a fully serialized shared plan snapshot by official plan number', async () => {
    const rows: Record<string, unknown>[] = [];
    const database: DatabaseLike = {
      get: vi.fn(async (_table, query) => rows.filter((row) => Object.entries(query).every(([key, value]) => row[key] === value))) as DatabaseLike['get'],
      set: vi.fn(async () => undefined),
      create: vi.fn(async (_table, row) => row) as DatabaseLike['create'],
      remove: vi.fn(async () => undefined),
      upsert: vi.fn(async (_table, incoming, keys: string[] = []) => {
        for (const row of incoming) {
          const index = rows.findIndex((existing) => keys.every((key) => existing[key] === row[key]));
          if (index >= 0) rows[index] = { ...rows[index], ...row };
          else rows.push({ id: rows.length + 1, ...row });
        }
      }),
    };
    const store = new HbuJwStore(database);
    const first = snapshot();
    const second = { ...snapshot(), planName: '更新后的方案' };

    await store.upsertTrainingPlan(first, 'hash-1', 100);
    await store.upsertTrainingPlan(second, 'hash-2', 200);

    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]?.snapshotJson))).toEqual(second);
    expect(rows[0]).toMatchObject({ planNumber: '10708', sourceHash: 'hash-2', syncedAt: 200 });
    expect(database.upsert).toHaveBeenLastCalledWith('hbu_jw_training_plan', expect.any(Array), ['planNumber']);
  });

  it('chooses an exact elective credit fill or the largest combination below the cap', () => {
    const options = [
      { courseNumber: 'A', credits: 3 },
      { courseNumber: 'B', credits: 2 },
      { courseNumber: 'C', credits: 1.5 },
      { courseNumber: 'A', credits: 3 },
    ];

    expect(selectMaxCreditCombination(options, 5).map((course) => course.courseNumber)).toEqual(['A', 'B']);
    expect(selectMaxCreditCombination(options, 4).reduce((sum, course) => sum + course.credits, 0)).toBe(3.5);
  });

  it('chooses a maximum-credit section combination without timetable conflicts', () => {
    const meeting = (weekday: number) => [{
      classWeek: '1-16周', weekday, startSection: 1, sectionCount: 2,
      campusName: '', teachingBuildingName: '', classroomName: '',
    }];
    const options = [
      { courseNumber: 'A', sequenceNumber: '01', credits: 2, meetings: meeting(1) },
      { courseNumber: 'B', sequenceNumber: '01', credits: 2, meetings: meeting(1) },
      { courseNumber: 'B', sequenceNumber: '02', credits: 2, meetings: meeting(2) },
      { courseNumber: 'C', sequenceNumber: '01', credits: 1.5, meetings: meeting(3) },
    ];

    expect(selectMaxConflictFreeCreditCombination(options, 4).map((course) => `${course.courseNumber}-${course.sequenceNumber}`))
      .toEqual(['A-01', 'B-02']);
    expect(selectMaxConflictFreeCreditCombination(options, 4, meeting(2)).reduce((sum, course) => sum + course.credits, 0))
      .toBe(3.5);
  });

  it('selects only a fresh exact-major fallback, using the older cohort on an equal distance', () => {
    const now = Date.UTC(2026, 6, 15);
    const row = (planNumber: string, majorName: string, cohortYear: number, syncedAt = now): HbuJwTrainingPlanCacheRow => ({
      id: Number(planNumber), planNumber, majorCode: '080901', majorName, cohortYear,
      planName: `方案${planNumber}`, snapshotJson: '{}', sourceHash: 'hash', syncedAt, createdAt: syncedAt, updatedAt: syncedAt,
    });
    const rows = [
      row('1', '软件工程', 2023),
      row('2', '计算机科学与技术', 2022),
      row('3', '计算机科学与技术', 2024),
      row('4', '计算机科学与技术', 2023, now - 24 * 60 * 60 * 1000),
    ];

    expect(selectNearestFreshTrainingPlan(rows, '计算机科学与技术', 2023, now)?.planNumber).toBe('2');
    expect(selectNearestFreshTrainingPlan(rows, '计算机科学', 2023, now)).toBeNull();
  });

  it('deduplicates passed courses, applies explicit substitutions, separates selections, and warns about unmapped courses', () => {
    const scores: HbuJwScoreRow[] = [
      { id: { courseNumber: 'CS101' }, courseName: '程序设计', credit: 4 },
      { id: { courseNumber: 'CS101' }, courseName: '程序设计', credit: 4 },
      { id: { courseNumber: 'CS102X' }, courseName: '数据结构替代课', credit: 4 },
      { id: { courseNumber: 'OTHER1' }, courseName: '无法映射课程', credit: 2 },
    ];

    const result = calculateGuidanceProgress(snapshot(), scores, selection());

    expect(result.progress.completedCredits).toBe(8);
    expect(result.progress.inProgressCredits).toBe(3);
    expect(result.progress.remainingCredits).toBe(156);
    expect(result.missingRequiredCourses).toEqual([]);
    expect(result.currentSelections).toEqual([expect.objectContaining({ courseNumber: 'CS201', credits: 3 })]);
    expect(result.unmappedCourses).toEqual([{ courseNumber: 'OTHER1', courseName: '无法映射课程', credits: 2 }]);
  });

  it('renders a privacy-safe card without scores, GPA, or student identity fields', () => {
    const calculated = calculateGuidanceProgress(snapshot(), [], selection());
    const context: HbuJwGuidanceContext = {
      plan: {
        planNumber: '10708',
        planName: '计算机科学与技术专业2023版培养方案',
        majorName: '计算机科学与技术',
        cohortYear: 2023,
        requiredCredits: 167,
        match: 'exact',
        syncedAt: '2026-07-15T00:00:00.000Z',
      },
      progress: calculated.progress,
      passedCourses: [],
      currentSelections: calculated.currentSelections,
      currentSemesterCourses: calculated.currentSemesterCourses,
      missingRequiredCourses: calculated.missingRequiredCourses,
      candidateCourses: calculated.candidateCourses,
      unmappedCourses: [],
      dataAsOf: '2026-07-15T00:00:00.000Z',
    };

    const html = renderGuidanceHtml(context);
    expect(html).toContain('167');
    expect(html).toContain('修读 / 选课进行中');
    expect(html).not.toMatch(/GPA|学号|成绩/);
  });
});

describe('hbu-jw official plan and offering contracts', () => {
  it('parses the dynamic plan callback, official 167-credit snapshot, and positive-credit course tree', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/student/rollManagement/rollInfo/index') {
        return new Response(`
          <div class="profile-info-row">
            <div class="profile-info-name">年级</div>
            <div class="profile-info-value">2023级</div>
            <div class="profile-info-name">院系</div>
            <div class="profile-info-value">网络空间安全与计算机学院</div>
          </div>
          <div class="profile-info-row">
            <div class="profile-info-name">专业</div>
            <div class="profile-info-value">计算机科学与技术</div>
            <div class="profile-info-name">专业方向</div>
            <div class="profile-info-value"></div>
          </div>
          <input value="10708" id="zx">
          <script>const url = "/student/rollManagement/project/token-a/10708/1/detail";</script>
        `, { status: 200 });
      }
      if (url.pathname === '/student/rollManagement/project/token-a/10708/1/detail') {
        return Response.json({
          title: '培养方案',
          jhFajhb: { fajhh: '10708', famc: '计算机科学与技术专业2023版培养方案', zyh: '080901', zym: '计算机科学与技术', nj: '2023', yqzxf: 167 },
          treeList: [
            { id: 'A', pId: '0', name: '专业必修课', info1: '/plan/category/A' },
            { id: 'A-1', pId: 'A', name: '程序设计 必修', info1: '/plan/course/@CS101', xf: 4 },
            { id: 'Z', pId: '0', name: '零学分池', info1: '/plan/category/Z' },
            { id: 'Z-1', pId: 'Z', name: '旁听课 任选', info1: '/plan/course/@ZZ1', xf: 1 },
          ],
        });
      }
      if (url.pathname === '/plan/category/A') {
        return Response.json({ flag: true, kz: { id: { fajhh: '10708', kzh: 'A', kzlxm: '002' }, kzm: '专业必修课', zsxf: 167, kczxf: 170 } });
      }
      if (url.pathname === '/plan/category/Z') {
        return Response.json({ flag: true, kz: { id: { fajhh: '10708', kzh: 'Z', kzlxm: '002' }, kzm: '零学分池', zsxf: 0, kczxf: 1000 } });
      }
      throw new Error(`unexpected request ${url.href}`);
    });
    const client = new HbuJwHttpClient({ fetchImpl: fetchImpl as typeof fetch, baseUrl: 'https://jw.example' });

    const profile = await client.getStudentPlanProfile(EMPTY_JAR);
    const plan = await client.getTrainingPlanSnapshot(EMPTY_JAR, profile);

    expect(profile).toEqual({
      majorName: '计算机科学与技术',
      cohortYear: 2023,
      planNumber: '10708',
      planDetailPath: '/student/rollManagement/project/token-a/10708/1/detail',
    });
    expect(plan.requiredCredits).toBe(167);
    expect(plan.categories).toEqual([{ code: 'A', name: '专业必修课', requiredCredits: 167 }]);
    expect(plan.courses).toEqual([expect.objectContaining({ courseNumber: 'CS101', credits: 4, attribute: 'required' })]);
  });

  it('fails directly when the official plan detail response is malformed', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/rollInfo/index')) {
        return new Response(`
          <div class="profile-info-row"><div class="profile-info-name">入学年级</div><div class="profile-info-value">2023级</div></div>
          <div class="profile-info-row"><div class="profile-info-name">专业</div><div class="profile-info-value">计算机科学与技术</div></div>
          <input id="zx" value="10708">
          <script>"/student/rollManagement/project/token-a/10708/1/detail"</script>
        `);
      }
      return new Response('<html>login</html>');
    });
    const client = new HbuJwHttpClient({ fetchImpl: fetchImpl as typeof fetch, baseUrl: 'https://jw.example' });
    const profile = await client.getStudentPlanProfile(EMPTY_JAR);
    await expect(client.getTrainingPlanSnapshot(EMPTY_JAR, profile)).rejects.toThrow('非 JSON');
  });

  it('normalizes plan-course sections with official identifiers, seats, and meeting data', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/planCourse/index')) {
        return new Response(`
          <select id="jhxn">
            <option value="">全部</option>
            <option value="2026-2027-1-2" selected>2026-2027学年秋</option>
            <option value="2025-2026-2-2">2025-2026学年春</option>
          </select>
          <script>const endpoint="/student/courseSelect/planCourse/courseList"</script>
        `);
      }
      if (url.pathname.endsWith('/planCourse/courseList')) {
        expect(new URLSearchParams(String(init?.body)).get('jhxn')).toBe('2026-2027-1-2');
        return Response.json({ rwfalist: [
          {
            schemeNum: '10708', jhxnxqdm: '2026-2027-1-2', courseNum: 'CS301', classNum: '02', kcm: '编译原理', xf: 3,
            kcsxdm: '01', kcsxmc: '必修', kzh: 'A', kzm: '专业必修课', skjs: '张老师',
            bkskrl: 80, bkskyl: 12,
            zcsm: '1-16周', weekNum: 2, courseStartNum: 3, cxjc: 2, kkxqm: '七一路', jxlm: 'A楼', jasm: '101',
          },
          {
            schemeNum: '10708', jhxnxqdm: '2026-2027-1-2', courseNum: 'CS302', classNum: '03', kcm: '已超员课程', xf: 2,
            kcsxdm: '01', kcsxmc: '必修', kzh: 'A', kzm: '专业必修课', skjs: '李老师',
            bkskrl: 50, bkskyl: -3,
            zcsm: '1-16周', weekNum: 3, courseStartNum: 5, cxjc: 2, kkxqm: '七一路', jxlm: 'A楼', jasm: '102',
          },
          {
            schemeNum: '10708', jhxnxqdm: '2026-2027-1-2', courseNum: 'TWE23G0001', classNum: '01', kcm: '网络通识课', xf: 1,
            kcsxdm: '02', kcsxmc: '任选', kzh: 'G', kzm: '网络通识课', skjs: '',
            bkskrl: 5000, bkskyl: 4990,
            zcsm: null, weekNum: null, courseStartNum: null, cxjc: null, kkxqm: '七一路', jxlm: null, jasm: null,
          },
        ] });
      }
      throw new Error(`unexpected request ${url.href}`);
    });
    const client = new HbuJwHttpClient({ fetchImpl: fetchImpl as typeof fetch, baseUrl: 'https://jw.example' });

    await expect(client.getPlanCourseOfferings(EMPTY_JAR, '10708')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        executionPlanNumber: '2026-2027-1-2',
        courseNumber: 'CS301',
        sequenceNumber: '02',
        remainingSeats: 12,
        meetings: [expect.objectContaining({ weekday: 2, startSection: 3, sectionCount: 2 })],
      }),
      expect.objectContaining({ courseNumber: 'CS302', remainingSeats: -3 }),
      expect.objectContaining({ courseNumber: 'TWE23G0001', meetings: [] }),
    ]));
  });

  it('represents asynchronous free courses without a fixed meeting instead of rejecting the course set', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/freeCourse/index')) {
        return new Response('<script>const endpoint="/student/courseSelect/freeCourse/courseList"</script>');
      }
      if (url.pathname.endsWith('/freeCourse/courseList')) {
        return Response.json({ rwRxkZlList: [{
          zxjxjhh: '2026-2027-1-2', kch: 'TWE23G0001', kxh: '01', kcm: '中华诗词之美', xf: 1,
          bkskrl: 5000, bkskyl: 4990, skxq: null, skjc: null, cxjc: null, skzc: null,
        }] });
      }
      throw new Error(`unexpected request ${url.href}`);
    });
    const client = new HbuJwHttpClient({ fetchImpl: fetchImpl as typeof fetch, baseUrl: 'https://jw.example' });

    await expect(client.getFreeCourseOfferings(EMPTY_JAR)).resolves.toEqual([
      expect.objectContaining({
        executionPlanNumber: '2026-2027-1-2',
        courseNumber: 'TWE23G0001',
        remainingSeats: 4990,
        meetings: [],
      }),
    ]);
  });
});

describe('hbu-jw final recommendation validation', () => {
  function guidanceFixture() {
    const plan: HbuJwTrainingPlanSnapshot = {
      planNumber: 'P1', planName: '测试方案', majorCode: 'M1', majorName: '计算机科学与技术', cohortYear: 2023,
      requiredCredits: 5,
      categories: [{ code: 'E', name: '专业任选课', requiredCredits: 5 }],
      courses: [
        { courseNumber: 'E1', courseName: '任选一', categoryCode: 'E', categoryName: '专业任选课', attribute: 'elective', credits: 3, replacementCourseNumbers: [] },
        { courseNumber: 'E2', courseName: '任选二', categoryCode: 'E', categoryName: '专业任选课', attribute: 'elective', credits: 2, replacementCourseNumbers: [] },
      ],
    };
    const offering = (courseNumber: string, credits: number): HbuJwCourseOffering => ({
      executionPlanNumber: '2026-2027-1', courseNumber, sequenceNumber: '01', courseName: courseNumber,
      credits, courseAttributeCode: '02', courseAttributeName: '任选', categoryCode: '', categoryName: '',
      planCategoryCode: 'E', planCategoryName: '专业任选课', teacherName: '教师', capacity: 50, remainingSeats: 10,
      meetings: [{ classWeek: '1-16周', weekday: courseNumber === 'E1' ? 1 : 2, startSection: 1, sectionCount: 2, campusName: '', teachingBuildingName: '', classroomName: '' }],
    });
    let queryCount = 0;
    let fillSecondCourseOnNextQuery = false;
    const client = {
      getStudentPlanProfile: vi.fn(async () => ({ majorName: plan.majorName, cohortYear: 2023, planNumber: 'P1', planDetailPath: '/detail' })),
      getAllPassingScores: vi.fn(async () => []),
      getCourseSelectionResult: vi.fn(async () => ({ totalUnits: 0, groups: [] })),
      getThisSemesterSchedule: vi.fn(async () => ({ executiveEducationPlanNumber: 'current', programPlanName: '当前学期', totalUnits: 0, courses: [] })),
      getPlanCourseOfferings: vi.fn(async () => {
        queryCount += 1;
        const rows = [offering('E1', 3), offering('E2', 2)];
        if (fillSecondCourseOnNextQuery && queryCount >= 2) rows[1]!.remainingSeats = 0;
        return rows;
      }),
      getFreeCourseOfferings: vi.fn(async () => []),
    };
    const now = Date.UTC(2026, 6, 15);
    const store = {
      getTrainingPlan: vi.fn(async () => ({
        id: 1, planNumber: 'P1', majorCode: 'M1', majorName: plan.majorName, cohortYear: 2023, planName: plan.planName,
        snapshotJson: JSON.stringify(plan), sourceHash: 'hash', syncedAt: now, createdAt: now, updatedAt: now,
      })),
    };
    const service = new HbuJwCourseGuidanceService(
      { ensureAuthenticated: vi.fn(async () => ({ kind: 'authenticated' as const, cookieJar: EMPTY_JAR })) },
      client as never,
      store as never,
      {} as never,
      {} as never,
      () => now,
    );
    return {
      service,
      setFillSecondCourseOnNextQuery: () => { fillSecondCourseOnNextQuery = true; },
      identity: { ownerKey: 'onebot:1', platform: 'onebot', qqUserId: '1', channelId: 'private:1' },
      section: (courseNumber: string) => ({ executionPlanNumber: '2026-2027-1', courseNumber, sequenceNumber: '01' }),
    };
  }

  it('rejects a non-maximal elective combination and accepts an exact fill', async () => {
    const fixture = guidanceFixture();
    const partial = await fixture.service.validateRecommendation(fixture.identity, [fixture.section('E1')]);
    expect(partial.valid).toBe(false);
    expect(partial.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'not_maximal_credit_fit' })]));

    const exact = await fixture.service.validateRecommendation(fixture.identity, [fixture.section('E1'), fixture.section('E2')]);
    expect(exact.valid).toBe(true);
    expect(exact.recommendedCredits).toBe(5);
    expect(exact.expectedProgress.remainingCredits).toBe(0);
  });

  it('re-queries live seats and rejects a section that fills after the offering lookup', async () => {
    const fixture = guidanceFixture();
    await fixture.service.getOfferings(fixture.identity, { includeGeneralElectives: false });
    fixture.setFillSecondCourseOnNextQuery();

    const result = await fixture.service.validateRecommendation(fixture.identity, [fixture.section('E2')]);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unavailable' })]));
  });
});
