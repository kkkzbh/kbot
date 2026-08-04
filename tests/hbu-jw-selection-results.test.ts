import { readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => {
  const h = ((type: string, attrs: Record<string, unknown> = {}, children: unknown[] = []) => ({ type, attrs, children })) as any;
  h.text = (content: string) => ({ type: 'text', attrs: { content }, children: [], toString: () => content });
  h.at = (id: string) => ({ type: 'at', attrs: { id }, children: [], toString: () => `<at id="${id}"/>` });
  h.image = (buffer: Buffer, mime: string) => ({ type: 'image', attrs: { buffer, mime }, children: [], toString: () => `<image mime="${mime}"/>` });
  return { h };
});

import { HbuJwAcademicCache, hbuJwDatabaseFallbackPolicy } from '../src/plugins/hbu-jw/academic-cache.js';
import { HbuJwHttpClient } from '../src/plugins/hbu-jw/jw-client.js';
import { buildHbuJwMenuView } from '../src/plugins/hbu-jw/menu.js';
import {
  HbuJwSelectionResultService,
  buildHbuJwSelectionSchedule,
} from '../src/plugins/hbu-jw/selection-results.js';
import { buildHbuJwScheduleView, renderHbuJwScheduleHtml } from '../src/plugins/hbu-jw/schedule.js';
import { HbuJwStore } from '../src/plugins/hbu-jw/store.js';
import type {
  DatabaseLike,
  HbuJwCourseSelectionResult,
  OwnerIdentity,
  SerializedCookieJar,
} from '../src/plugins/hbu-jw/types.js';

const COOKIE_JAR: SerializedCookieJar = {
  version: 2,
  transport: 'direct',
  origin: 'https://zhjw.hbu.cn',
  cookies: [{ name: 'JSESSIONID', value: 'abc' }],
};

const EMPTY_COOKIE_JAR: SerializedCookieJar = {
  version: 2,
  transport: 'direct',
  origin: 'https://zhjw.hbu.cn',
  cookies: [],
};

function rawSelectionPayload() {
  return {
    allUnits: 5,
    dateList: [
      {
        programPlanCode: '3201',
        programPlanName: '2023级计算机科学与技术专业人才培养方案',
        totalUnits: 5,
        selectCourseList: [
          {
            id: {
              executiveEducationPlanNumber: '2026-2027-1-2',
              coureNumber: '2023S01007',
              coureSequenceNumber: '01',
            },
            courseName: '计算机网络',
            unit: 3,
            coursePropertiesName: '必修',
            courseCategoryName: '学科(专业)基础课',
            examTypeName: '考试',
            attendClassTeacher: '张老师* ',
            studyModeName: '正常',
            selectCourseStatusName: '选中',
            restrictedCondition: ';',
            courseSelectionTime: '2026-07-14 10:30:00',
            timeAndPlaceList: [
              {
                classDay: 2,
                classSessions: 3,
                continuingSession: 2,
                classWeek: '111100000000000000000000',
                weekDescription: '1-4周',
                campusName: '七一路校区',
                teachingBuildingName: 'A5座',
                classroomName: '312',
              },
            ],
          },
          {
            id: {
              executiveEducationPlanNumber: '2026-2027-1-2',
              coureNumber: '3123G00012',
              coureSequenceNumber: '41',
            },
            courseName: '通识选修课',
            unit: 2,
            coursePropertiesName: '任选',
            courseCategoryName: '通识课',
            examTypeName: '考查',
            attendClassTeacher: '',
            studyModeName: '正常',
            selectCourseStatusName: '置入',
            restrictedCondition: '限本年级学生',
            courseSelectionTime: '',
            timeAndPlaceList: [],
          },
        ],
      },
    ],
  };
}

function selectionResult(): HbuJwCourseSelectionResult {
  return {
    totalUnits: 5,
    groups: [
      {
        programPlanCode: '3201',
        programPlanName: '2023级计算机科学与技术专业人才培养方案',
        totalUnits: 5,
        courses: [
          {
            courseNumber: '2023S01007',
            sequenceNumber: '01',
            executiveEducationPlanNumber: '2026-2027-1-2',
            courseName: '计算机网络',
            unit: 3,
            coursePropertiesName: '必修',
            courseCategoryName: '学科(专业)基础课',
            examTypeName: '考试',
            teacherName: '张老师*',
            studyModeName: '正常',
            selectCourseStatusName: '选中',
            restrictedCondition: '',
            courseSelectionTime: '2026-07-14 10:30:00',
            timeAndPlaceList: [
              {
                classDay: 2,
                classSessions: 3,
                continuingSession: 2,
                classWeek: '111100000000000000000000',
                weekDescription: '1-4周',
                campusName: '七一路校区',
                teachingBuildingName: 'A5座',
                classroomName: '312',
              },
            ],
          },
          {
            courseNumber: '3123G00012',
            sequenceNumber: '41',
            executiveEducationPlanNumber: '2026-2027-1-2',
            courseName: '通识选修课',
            unit: 2,
            coursePropertiesName: '任选',
            courseCategoryName: '通识课',
            examTypeName: '考查',
            teacherName: '',
            studyModeName: '正常',
            selectCourseStatusName: '置入',
            restrictedCondition: '限本年级学生',
            courseSelectionTime: '',
            timeAndPlaceList: [],
          },
        ],
      },
    ],
  };
}

function identity(): OwnerIdentity {
  return {
    ownerKey: 'onebot:1405359129',
    platform: 'onebot',
    qqUserId: '1405359129',
    channelId: 'group:100',
  };
}

function createDatabase() {
  const tables = new Map<string, Record<string, any>[]>();
  let nextId = 1;
  const matches = (row: Record<string, any>, query: Record<string, any>) => Object.entries(query).every(([key, value]) => {
    if (value && typeof value === 'object' && '$in' in value) return value.$in.includes(row[key]);
    return row[key] === value;
  });
  return {
    tables,
    get: vi.fn(async (table: string, query: Record<string, any>) => (tables.get(table) ?? []).filter((row) => matches(row, query))),
    create: vi.fn(async (table: string, row: Record<string, any>) => {
      const created = { id: nextId++, ...row };
      tables.set(table, [...(tables.get(table) ?? []), created]);
      return created;
    }),
    set: vi.fn(async (table: string, query: Record<string, any>, patch: Record<string, any>) => {
      tables.set(table, (tables.get(table) ?? []).map((row) => matches(row, query) ? { ...row, ...patch } : row));
    }),
    remove: vi.fn(async (table: string, query: Record<string, any>) => {
      tables.set(table, (tables.get(table) ?? []).filter((row) => !matches(row, query)));
    }),
  };
}

function createPuppeteerHarness() {
  let html = '';
  const canvas = createCanvas(4, 4);
  const screenshot = canvas.toBuffer('image/png');
  const page = {
    setViewport: vi.fn(async () => undefined),
    goto: vi.fn(async (url: string) => {
      html = readFileSync(new URL(url), 'utf8');
    }),
    waitForSelector: vi.fn(async () => undefined),
    $: vi.fn(async () => ({ boundingBox: vi.fn(async () => ({ x: 0, y: 0, width: 1280, height: 1200 })) })),
    screenshot: vi.fn(async () => screenshot),
    close: vi.fn(async () => undefined),
  };
  return {
    page,
    puppeteer: { page: vi.fn(async () => page) },
    getHtml: () => html,
  };
}

function contentText(content: unknown): string {
  return (Array.isArray(content) ? content : [content]).map((part) => String(part)).join('');
}

afterEach(() => vi.restoreAllMocks());

describe('hbu-jw selection result http contract', () => {
  it('loads the verified selection page callback with GET and normalizes its rows', async () => {
    const payload = rawSelectionPayload();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/student/courseSelect/courseSelectResult/index')) {
        return new Response('<script>url = "/student/courseSelect/thisSemesterCurriculum/callback"; $.get(url)</script>', { status: 200 });
      }
      if (url.endsWith('/student/courseSelect/thisSemesterCurriculum/callback')) {
        expect(init?.method ?? 'GET').toBe('GET');
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      return new Response('', { status: 500 });
    });
    const client = new HbuJwHttpClient({ fetchImpl: fetchImpl as never });

    const result = await client.getCourseSelectionResult(COOKIE_JAR);

    expect(result).toMatchObject({ totalUnits: 5 });
    expect(result.groups[0]).toMatchObject({ programPlanCode: '3201', totalUnits: 5 });
    expect(result.groups[0]?.courses).toHaveLength(2);
    expect(result.groups[0]?.courses[0]).toMatchObject({
      courseNumber: '2023S01007',
      sequenceNumber: '01',
      teacherName: '张老师*',
      selectCourseStatusName: '选中',
    });
    expect(result.groups[0]?.courses[0]?.timeAndPlaceList[0]).toMatchObject({
      classDay: 2,
      classSessions: 3,
      classroomName: '312',
    });
  });

  it('rejects ambiguous callbacks and malformed payloads', async () => {
    const ambiguousClient = new HbuJwHttpClient({
      fetchImpl: vi.fn(async () => new Response([
        '"/student/courseSelect/thisSemesterCurriculum/callback"',
        '"/student/courseSelect/thisSemesterCurriculum/callback"',
      ].join('\n'), { status: 200 })) as never,
    });
    await expect(ambiguousClient.getCourseSelectionResult(EMPTY_COOKIE_JAR)).rejects.toThrow('没有唯一的回调地址');

    const malformedClient = new HbuJwHttpClient({
      fetchImpl: vi.fn(async (url: string) => url.endsWith('/courseSelectResult/index')
        ? new Response('"/student/courseSelect/thisSemesterCurriculum/callback"', { status: 200 })
        : new Response(JSON.stringify({ dateList: [{}] }), { status: 200 })) as never,
    });
    await expect(malformedClient.getCourseSelectionResult(EMPTY_COOKIE_JAR)).rejects.toThrow('异常');
  });
});

describe('hbu-jw selection result module', () => {
  it('adapts selection data into the complete schedule domain model', () => {
    const schedule = buildHbuJwSelectionSchedule(selectionResult());

    expect(schedule).toMatchObject({
      executiveEducationPlanNumber: '2026-2027-1-2',
      programPlanName: '2023级计算机科学与技术专业人才培养方案',
      totalUnits: 5,
    });
    expect(schedule.courses).toHaveLength(2);
    expect(schedule.courses[0]).toMatchObject({
      courseNumber: '2023S01007',
      sequenceNumber: '01',
      courseName: '计算机网络',
      selectCourseStatusName: '选中',
    });
  });

  it('uses the exact complete schedule HTML', () => {
    const schedule = buildHbuJwSelectionSchedule(selectionResult());
    const view = buildHbuJwScheduleView(schedule, 'full-semester', Date.UTC(2026, 6, 15));
    const html = renderHbuJwScheduleHtml(view);

    expect(html).toContain('id="hbu-jw-schedule-card"');
    expect(html).toContain('<h1>河北大学完整课表</h1>');
    expect(html).toContain('2026-2027 秋 · 全学期');
    expect(html).toContain('计算机网络_01');
    expect(html).toContain('七一路校区A5座312');
    expect(html).toContain('<span>未安排课程</span><span class="footer-value">1 门</span>');
    expect(html).not.toContain('hbu-jw-selection-result-card');
  });

  it('authenticates, queries, and returns a mentioned image', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: COOKIE_JAR,
    }));
    const getCourseSelectionResult = vi.fn(async () => selectionResult());
    const { puppeteer } = createPuppeteerHarness();
    const service = new HbuJwSelectionResultService(
      { ensureAuthenticated },
      { getCourseSelectionResult },
      puppeteer,
      undefined,
      () => Date.UTC(2026, 6, 15),
    );

    const reply = await service.querySelectionResult(identity());

    expect(contentText(reply)).toContain('<at id="1405359129"/>');
    expect(contentText(reply)).toContain('image/gif');
    expect(getCourseSelectionResult).toHaveBeenCalledWith(COOKIE_JAR);
  });

  it('includes the selection result command in the academic affairs menu', () => {
    const queryItems = buildHbuJwMenuView().sections.find((section) => section.title === '查询')?.items ?? [];
    expect(queryItems).toContainEqual({
      keyword: '选课结果',
      description: '查看本学期课程、学分与选课状态',
      icon: 'check',
    });
  });

  it('reports an explicit user error for an empty result', () => {
    expect(() => buildHbuJwSelectionSchedule({ totalUnits: 0, groups: [] })).toThrow('教务系统当前没有选课结果');
  });
});

describe('hbu-jw selection result cache', () => {
  it('stores the result as its own academic data kind and falls back to it', async () => {
    const database = createDatabase();
    const store = new HbuJwStore(database as unknown as DatabaseLike);
    const auth = { cookieJar: COOKIE_JAR, credentialVersion: 1 };
    const seedCache = new HbuJwAcademicCache(
      store,
      { getCourseSelectionResult: vi.fn(async () => selectionResult()) } as never,
      () => Date.UTC(2026, 6, 14),
    );
    await seedCache.getCourseSelectionResult(identity(), auth, hbuJwDatabaseFallbackPolicy());

    expect(database.tables.get('hbu_jw_academic_item')?.[0]).toMatchObject({
      dataKind: 'course_selection_result',
      scopeKey: 'current',
    });

    const failing = vi.fn(async () => { throw new Error('jw unavailable'); });
    const fallbackCache = new HbuJwAcademicCache(
      store,
      { getCourseSelectionResult: failing } as never,
      () => Date.UTC(2026, 6, 15),
    );
    const result = await fallbackCache.getCourseSelectionResult(identity(), auth, hbuJwDatabaseFallbackPolicy());

    expect(result).toMatchObject({ source: 'database', data: { totalUnits: 5 } });
    expect(failing).toHaveBeenCalledWith(auth.cookieJar);
  });
});
