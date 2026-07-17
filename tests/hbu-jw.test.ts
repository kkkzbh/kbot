import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCanvas } from '@napi-rs/canvas';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => {
  type MockSchemaNode = {
    default: () => MockSchemaNode;
    description: () => MockSchemaNode;
    role: () => MockSchemaNode;
    min: () => MockSchemaNode;
    max: () => MockSchemaNode;
  };

  const createSchemaNode = (): MockSchemaNode => ({
    default: () => createSchemaNode(),
    description: () => createSchemaNode(),
    role: () => createSchemaNode(),
    min: () => createSchemaNode(),
    max: () => createSchemaNode(),
  });

  class MockLogger {
    info(): void {}
    warn(): void {}
    error(): void {}
  }

  const hFactory = ((type: string, attrs: Record<string, unknown> = {}, children: unknown[] = []) => ({
    type,
    attrs,
    children,
  })) as unknown as {
    (type: string, attrs?: Record<string, unknown>, children?: unknown[]): Record<string, unknown>;
    text: (content: string) => Record<string, unknown>;
    at: (id: string) => Record<string, unknown>;
    image: (buffer: Buffer, mime: string) => Record<string, unknown>;
  };
  hFactory.text = (content: string) => ({
    type: 'text',
    attrs: { content },
    children: [],
    toString: () => content,
  });
  hFactory.at = (id: string) => ({
    type: 'at',
    attrs: { id },
    children: [],
    toString: () => `<at id="${id}"/>`,
  });
  hFactory.image = (buffer: Buffer, mime: string) => ({
    type: 'image',
    attrs: { buffer, mime },
    children: [],
    toString: () => `<image mime="${mime}"/>`,
  });

  return {
    Context: class {},
    Logger: MockLogger,
    Schema: {
      object: () => createSchemaNode(),
      boolean: () => createSchemaNode(),
      string: () => createSchemaNode(),
      natural: () => createSchemaNode(),
      array: () => createSchemaNode(),
      union: () => createSchemaNode(),
      number: () => createSchemaNode(),
    },
    h: hFactory,
  };
});

import {
  apply as applyHbuJwPlugin,
  buildHbuJwCapabilityReference,
  shouldExposeHbuJwCapabilityReference,
} from '../src/plugins/hbu-jw/index.js';
import { HbuJwCourseGuidanceService } from '../src/plugins/hbu-jw/course-guidance.js';
import {
  HbuJwAcademicCache,
  hbuJwDatabaseFallbackPolicy,
} from '../src/plugins/hbu-jw/academic-cache.js';
import {
  HbuJwCourseQueryService,
  buildHbuJwCourseQueryResultViews,
  matchCourseCandidates,
  renderHbuJwCourseQueryHelpImage,
  renderHbuJwCourseQueryResultHtml,
  resolveCourseQueryTerm,
} from '../src/plugins/hbu-jw/course-query.js';
import { loadOrCreateKek } from '../src/plugins/hbu-jw/crypto.js';
import {
  HbuJwExamScheduleService,
  buildHbuJwExamScheduleView,
  renderHbuJwExamScheduleImage,
} from '../src/plugins/hbu-jw/exams.js';
import {
  HbuJwGpaService,
  buildHbuJwGpaView,
  calculateHbuJwGpa,
  renderHbuJwGpaHtml,
  renderHbuJwGpaImage,
} from '../src/plugins/hbu-jw/gpa.js';
import {
  HbuJwHttpClient,
  HbuJwLoginError,
  buildSubitemScoreLookParamsFromScoreRow,
  buildSubitemScoreLookParamsFromThisTermRow,
} from '../src/plugins/hbu-jw/jw-client.js';
import {
  HbuJwMenuService,
  buildHbuJwMenuView,
  renderHbuJwMenuImage,
} from '../src/plugins/hbu-jw/menu.js';
import {
  HbuJwScheduleService,
  buildHbuJwScheduleView,
  calculateHbuJwScheduleGifFrameCount,
  calculateTeachingWeek,
  renderHbuJwScheduleHtml,
  renderHbuJwScheduleImage,
} from '../src/plugins/hbu-jw/schedule.js';
import { HbuJwService } from '../src/plugins/hbu-jw/service.js';
import { HbuJwStore } from '../src/plugins/hbu-jw/store.js';
import {
  HbuJwTermScoresService,
  buildHbuJwTermScoresView,
  renderHbuJwTermScoresImage,
} from '../src/plugins/hbu-jw/term-scores.js';
import { HbuJwUserError } from '../src/plugins/hbu-jw/types.js';
import type {
  DatabaseLike,
  HbuJwExamPlanEvent,
  HbuJwScoreRow,
  HbuJwThisSemesterSchedule,
  HbuJwThisTermScoreRow,
  OwnerIdentity,
  SerializedCookieJar,
} from '../src/plugins/hbu-jw/types.js';
import { renderBindPage } from '../src/plugins/hbu-jw/web/bind-page.js';

const tempDirs: string[] = [];

function apply(ctx: Record<string, any>, config: Parameters<typeof applyHbuJwPlugin>[1]): void {
  ctx.nativeFeatureChat ??= {
    registerCapability: vi.fn(() => () => undefined),
    sendReply: vi.fn(async (session, input) => {
      await session.send(input.reply);
      return null;
    }),
  };
  ctx.chatluna ??= {
    platform: { registerTool: vi.fn(() => () => undefined) },
    registerAllowReplyResolver: vi.fn(() => () => undefined),
  };
  ctx.chatluna_storage ??= {
    createTempFile: vi.fn(async () => ({ id: 'test-asset', url: 'asset://test-guidance-card' })),
  };
  applyHbuJwPlugin(ctx as never, config);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-hbu-jw-'));
  tempDirs.push(dir);
  return dir;
}

function createDatabase(seed: Record<string, Record<string, any>[]> = {}) {
  const tables = new Map<string, Record<string, any>[]>(Object.entries(seed).map(([table, rows]) => [table, [...rows]]));
  const autoIds = new Map<string, number>();
  const getRows = (table: string) => tables.get(table) ?? [];
  const setRows = (table: string, rows: Record<string, any>[]) => tables.set(table, rows);
  const matches = (row: Record<string, any>, query: Record<string, any>) =>
    Object.entries(query).every(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if ('$lte' in value) return Number(row[key]) <= Number((value as any).$lte);
        if ('$in' in value) return Array.isArray((value as any).$in) && (value as any).$in.includes(row[key]);
      }
      return row[key] === value;
    });
  return {
    tables,
    get: vi.fn(async (table: string, query: Record<string, any>) => getRows(table).filter((row) => matches(row, query))),
    create: vi.fn(async (table: string, row: Record<string, any>) => {
      const nextId = (autoIds.get(table) ?? 0) + 1;
      autoIds.set(table, nextId);
      const created = row.id == null ? { id: nextId, ...row } : { ...row };
      setRows(table, [...getRows(table), created]);
      return created;
    }),
    set: vi.fn(async (table: string, query: Record<string, any>, patch: Record<string, any>) => {
      setRows(table, getRows(table).map((row) => (matches(row, query) ? { ...row, ...patch } : row)));
    }),
    remove: vi.fn(async (table: string, query: Record<string, any>) => {
      setRows(table, getRows(table).filter((row) => !matches(row, query)));
    }),
  };
}

function renderMessageContent(content: unknown): string {
  if (Array.isArray(content)) return content.map((part) => String(part)).join('');
  return String(content ?? '');
}

function extractAtIds(content: unknown): string[] {
  const elements = Array.isArray(content) ? content : [content];
  return elements
    .filter((element): element is { type: string; attrs?: { id?: unknown } } =>
      Boolean(element && typeof element === 'object' && (element as { type?: unknown }).type === 'at'))
    .map((element) => String(element.attrs?.id ?? ''));
}

function identity(overrides: Partial<OwnerIdentity> = {}): OwnerIdentity {
  return {
    ownerKey: 'onebot:1405359129',
    platform: 'onebot',
    qqUserId: '1405359129',
    channelId: 'group:100',
    ...overrides,
  };
}

function extractToken(link: string): string {
  return new URL(link).searchParams.get('token') ?? '';
}

function cookieJar(sessionId: string | null = 'abc'): SerializedCookieJar {
  return {
    version: 1,
    transport: 'direct',
    cookies: sessionId === null ? [] : [{ name: 'JSESSIONID', value: sessionId }],
  };
}

function createService(options: {
  database?: ReturnType<typeof createDatabase>;
  now?: () => number;
  validate?: (cookieJar: SerializedCookieJar) => Promise<boolean>;
  login?: (username: string, password: string) => Promise<{ cookieJar: SerializedCookieJar }>;
} = {}) {
  const dir = createTempDir();
  const database = options.database ?? createDatabase();
  const login = vi.fn(options.login ?? (async () => ({ cookieJar: cookieJar() })));
  const validate = vi.fn(options.validate ?? (async () => true));
  const prepareSession = vi.fn((cookieJar: SerializedCookieJar) => cookieJar);
  const service = new HbuJwService(
    new HbuJwStore(database as unknown as DatabaseLike),
    { login, validate, prepareSession } as never,
    loadOrCreateKek(join(dir, 'kek.key')),
    {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      bindTokenTtlMs: 600_000,
      autoReloginEnabled: true,
    },
    options.now ?? (() => 1_000),
  );
  return { service, database, login, validate, prepareSession };
}

function scoreRow(overrides: Partial<HbuJwScoreRow> = {}): HbuJwScoreRow {
  return {
    id: { courseNumber: '2023D00001' },
    courseName: '程序设计',
    credit: '3',
    gradePointScore: 4.5,
    courseAttributeCode: '001',
    courseAttributeName: '必修',
    academicYearCode: '2023-2024',
    termName: '秋',
    ...overrides,
  };
}

function allPassingScoresPayload(rows: HbuJwScoreRow[]) {
  return {
    lnList: [
      {
        cjList: rows,
      },
    ],
    state: 'ok',
    zxjxjhh: '2023',
  };
}

function thisTermScoreRow(overrides: Partial<HbuJwThisTermScoreRow> = {}): HbuJwThisTermScoreRow {
  return {
    id: {
      courseNumber: '2023S01003',
      executiveEducationPlanNumber: '2025-2026-2-2',
      examtime: '1',
      studentNumber: '20231202051',
    },
    coureSequenceNumber: '01',
    courseName: '软件工程',
    credit: 3,
    coursePropertyCode: '001',
    coursePropertyName: '必修',
    courseScore: '97',
    gradePoint: 4.5,
    examTypeName: '考试',
    inputStatusCode: '05',
    inputStatusExplain: '确定',
    avgcj: '88.2',
    rank: '3/78',
    maxcj: '99',
    mincj: '61',
    unpassedReasonExplain: '',
    englishCourseName: 'Software Engineering',
    termName: '春',
    ...overrides,
  };
}

function thisTermScoresPayload(rows: HbuJwThisTermScoreRow[]) {
  return [
    {
      state: '0',
      list: rows,
    },
  ];
}

function examPlanEvent(overrides: Partial<HbuJwExamPlanEvent> = {}): HbuJwExamPlanEvent {
  return {
    title: '软件工程\n09:30-11:00\n七一路校区\n七一路校区A5座\n101\n',
    start: '2026-06-29',
    color: '#ABBAC3',
    ...overrides,
  };
}

function thisSemesterSchedulePayload() {
  return {
    allUnits: 22.3,
    dateList: [
      {
        programPlanName: '2023级计算机科学与技术专业人才培养方案',
        totalUnits: 22.3,
        selectCourseList: [
          {
            id: {
              executiveEducationPlanNumber: '2025-2026-2-2',
              coureNumber: '2023S01003',
              coureSequenceNumber: '01',
            },
            courseName: '软件工程',
            unit: 2,
            coursePropertiesName: '必修',
            courseCategoryName: '学科(专业)基础课',
            examTypeName: '考试',
            attendClassTeacher: '罗文劼* ',
            selectCourseStatusName: '选中',
            timeAndPlaceList: [
              {
                classDay: 1,
                classSessions: 1,
                continuingSession: 2,
                classWeek: '110000000000000000000000',
                weekDescription: '1-2周',
                campusName: '七一路校区',
                teachingBuildingName: 'A5座',
                classroomName: '312',
              },
              {
                classDay: 2,
                classSessions: 7,
                continuingSession: 2,
                classWeek: '010000000000000000000000',
                weekDescription: '第2周',
                campusName: '七一路校区',
                teachingBuildingName: 'A5座',
                classroomName: '312',
              },
            ],
          },
          {
            id: {
              executiveEducationPlanNumber: '2025-2026-2-2',
              coureNumber: '2023S01004',
              coureSequenceNumber: '01',
            },
            courseName: '编译原理',
            unit: 3,
            coursePropertiesName: '必修',
            courseCategoryName: '学科(专业)基础课',
            examTypeName: '考试',
            attendClassTeacher: '刘海博* ',
            selectCourseStatusName: '选中',
            timeAndPlaceList: [
              {
                classDay: 4,
                classSessions: 1,
                continuingSession: 2,
                classWeek: '001000000000000000000000',
                weekDescription: '第3周',
                campusName: '七一路校区',
                teachingBuildingName: 'A2座',
                classroomName: '104',
              },
            ],
          },
          {
            id: {
              executiveEducationPlanNumber: '2025-2026-2-2',
              coureNumber: '2023S09999',
              coureSequenceNumber: '01',
            },
            courseName: '未安排课程',
            unit: 1,
            coursePropertiesName: '任选',
            courseCategoryName: '通识课',
            examTypeName: '',
            attendClassTeacher: '王老师* ',
            selectCourseStatusName: '选中',
            timeAndPlaceList: [],
          },
        ],
      },
    ],
  };
}

function thisSemesterSchedule(): HbuJwThisSemesterSchedule {
  return {
    executiveEducationPlanNumber: '2025-2026-2-2',
    programPlanName: '2023级计算机科学与技术专业人才培养方案',
    totalUnits: 22.3,
    courses: [
      {
        courseNumber: '2023S01003',
        sequenceNumber: '01',
        executiveEducationPlanNumber: '2025-2026-2-2',
        courseName: '软件工程',
        unit: 2,
        coursePropertiesName: '必修',
        courseCategoryName: '学科(专业)基础课',
        examTypeName: '考试',
        teacherName: '罗文劼*',
        selectCourseStatusName: '选中',
        timeAndPlaceList: [
          {
            classDay: 1,
            classSessions: 1,
            continuingSession: 2,
            classWeek: '110000000000000000000000',
            weekDescription: '1-2周',
            campusName: '七一路校区',
            teachingBuildingName: 'A5座',
            classroomName: '312',
          },
          {
            classDay: 2,
            classSessions: 7,
            continuingSession: 2,
            classWeek: '010000000000000000000000',
            weekDescription: '第2周',
            campusName: '七一路校区',
            teachingBuildingName: 'A5座',
            classroomName: '312',
          },
        ],
      },
      {
        courseNumber: '2023S01004',
        sequenceNumber: '01',
        executiveEducationPlanNumber: '2025-2026-2-2',
        courseName: '编译原理',
        unit: 3,
        coursePropertiesName: '必修',
        courseCategoryName: '学科(专业)基础课',
        examTypeName: '考试',
        teacherName: '刘海博*',
        selectCourseStatusName: '选中',
        timeAndPlaceList: [
          {
            classDay: 4,
            classSessions: 1,
            continuingSession: 2,
            classWeek: '001000000000000000000000',
            weekDescription: '第3周',
            campusName: '七一路校区',
            teachingBuildingName: 'A2座',
            classroomName: '104',
          },
        ],
      },
      {
        courseNumber: '2023S09999',
        sequenceNumber: '01',
        executiveEducationPlanNumber: '2025-2026-2-2',
        courseName: '未安排课程',
        unit: 1,
        coursePropertiesName: '任选',
        courseCategoryName: '通识课',
        examTypeName: '',
        teacherName: '王老师*',
        selectCourseStatusName: '选中',
        timeAndPlaceList: [],
      },
    ],
  };
}

function crowdedSemesterSchedule(): HbuJwThisSemesterSchedule {
  return {
    executiveEducationPlanNumber: '2025-2026-2-2',
    programPlanName: '2023级计算机科学与技术专业人才培养方案',
    totalUnits: 5,
    courses: [
      {
        courseNumber: '2023S02001',
        sequenceNumber: '02',
        executiveEducationPlanNumber: '2025-2026-2-2',
        courseName: '模式识别与机器学习',
        unit: 2,
        coursePropertiesName: '必修',
        courseCategoryName: '学科(专业)基础课',
        examTypeName: '考试',
        teacherName: '彭锦佳*',
        selectCourseStatusName: '选中',
        timeAndPlaceList: [
          {
            classDay: 1,
            classSessions: 3,
            continuingSession: 2,
            classWeek: '111111111111111110000000',
            weekDescription: '1-17周',
            campusName: '七一路校区',
            teachingBuildingName: 'C1座',
            classroomName: '32',
          },
        ],
      },
      {
        courseNumber: '2023S02002',
        sequenceNumber: '01',
        executiveEducationPlanNumber: '2025-2026-2-2',
        courseName: '数字图像处理实验',
        unit: 3,
        coursePropertiesName: '必修',
        courseCategoryName: '学科(专业)基础课',
        examTypeName: '考查',
        teacherName: '杨文柱*',
        selectCourseStatusName: '选中',
        timeAndPlaceList: [
          {
            classDay: 1,
            classSessions: 3,
            continuingSession: 2,
            classWeek: '111111111111111110000000',
            weekDescription: '1-17周',
            campusName: '七一路校区',
            teachingBuildingName: 'C1座',
            classroomName: '32',
          },
        ],
      },
    ],
  };
}

function mixedCrowdedSemesterSchedule(): HbuJwThisSemesterSchedule {
  const schedule = crowdedSemesterSchedule();
  return {
    ...schedule,
    courses: [
      ...schedule.courses,
      {
        courseNumber: '2023S03001',
        sequenceNumber: '01',
        executiveEducationPlanNumber: '2025-2026-2-2',
        courseName: '课程甲',
        unit: 1,
        coursePropertiesName: '必修',
        courseCategoryName: '学科(专业)基础课',
        examTypeName: '考查',
        teacherName: '甲老师*',
        selectCourseStatusName: '选中',
        timeAndPlaceList: [
          {
            classDay: 2,
            classSessions: 5,
            continuingSession: 2,
            classWeek: '111111111111111110000000',
            weekDescription: '1-17周',
            campusName: '七一路校区',
            teachingBuildingName: 'A1座',
            classroomName: '101',
          },
        ],
      },
      {
        courseNumber: '2023S03002',
        sequenceNumber: '01',
        executiveEducationPlanNumber: '2025-2026-2-2',
        courseName: '课程乙',
        unit: 1,
        coursePropertiesName: '必修',
        courseCategoryName: '学科(专业)基础课',
        examTypeName: '考查',
        teacherName: '乙老师*',
        selectCourseStatusName: '选中',
        timeAndPlaceList: [
          {
            classDay: 2,
            classSessions: 5,
            continuingSession: 2,
            classWeek: '111111111111111110000000',
            weekDescription: '1-17周',
            campusName: '七一路校区',
            teachingBuildingName: 'A1座',
            classroomName: '101',
          },
        ],
      },
      {
        courseNumber: '2023S03003',
        sequenceNumber: '01',
        executiveEducationPlanNumber: '2025-2026-2-2',
        courseName: '课程丙',
        unit: 1,
        coursePropertiesName: '必修',
        courseCategoryName: '学科(专业)基础课',
        examTypeName: '考查',
        teacherName: '丙老师*',
        selectCourseStatusName: '选中',
        timeAndPlaceList: [
          {
            classDay: 2,
            classSessions: 5,
            continuingSession: 2,
            classWeek: '111111111111111110000000',
            weekDescription: '1-17周',
            campusName: '七一路校区',
            teachingBuildingName: 'A1座',
            classroomName: '101',
          },
        ],
      },
    ],
  };
}

function createPuppeteerHarness() {
  let navigatedHtml = '';
  const screenshotPng = createHarnessPng();
  const element = {
    boundingBox: vi.fn(async () => ({ x: 0, y: 0, width: 1536, height: 1008 })),
  };
  const page = {
    setViewport: vi.fn(async () => undefined),
    goto: vi.fn(async (url: string) => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      navigatedHtml = readFileSync(fileURLToPath(url), 'utf8');
    }),
    waitForSelector: vi.fn(async () => undefined),
    $: vi.fn(async () => element),
    screenshot: vi.fn(async () => screenshotPng),
    close: vi.fn(async () => undefined),
  };
  return {
    page,
    puppeteer: {
      page: vi.fn(async () => page),
    },
    getNavigatedHtml: () => navigatedHtml,
  };
}

function createHarnessPng(): Buffer {
  const canvas = createCanvas(4, 4);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, 4, 4);
  return canvas.toBuffer('image/png');
}

describe('hbu-jw binding service', () => {
  it('creates one active challenge and cancels the previous one for the same QQ', async () => {
    const { service, database } = createService();

    await service.startBinding(identity());
    await service.startBinding(identity());

    expect(database.tables.get('hbu_jw_bind_challenge')).toMatchObject([
      { ownerKey: 'onebot:1405359129', status: 'cancelled' },
      { ownerKey: 'onebot:1405359129', status: 'created' },
    ]);
  });

  it('submits credentials once, stores encrypted pending state, and reuses the completed result', async () => {
    const { service, database, login } = createService();
    const started = await service.startBinding(identity());
    const token = extractToken(started.link);

    const result = await service.submitCredentials({
      token,
      username: 'student-1',
      password: 'secret-password',
      persistCredentialConsent: true,
    });

    expect(result).toMatchObject({ qqUserId: '1405359129' });
    const [challenge] = database.tables.get('hbu_jw_bind_challenge') ?? [];
    expect(challenge).toMatchObject({ status: 'login_succeeded' });
    expect(JSON.stringify(challenge)).not.toContain('secret-password');
    const repeated = await service.submitCredentials({
      token,
      username: 'student-2',
      password: 'other-password',
      persistCredentialConsent: true,
    });
    expect(repeated).toEqual(result);
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('resolves a submitted challenge as a reusable GET success page', async () => {
    const { service, database } = createService();
    const started = await service.startBinding(identity());
    const token = extractToken(started.link);

    const result = await service.submitCredentials({
      token,
      username: 'student-1',
      password: 'secret-password',
      persistCredentialConsent: true,
    });

    const challenge = await service.resolveBindPageChallenge(token);
    expect(challenge).toMatchObject({
      qqUserId: '1405359129',
      state: 'success',
      confirmCode: result.confirmCode,
    });
    const [row] = database.tables.get('hbu_jw_bind_challenge') ?? [];
    expect(row.pendingConfirmCodeCipher).toEqual(expect.any(String));
    expect(row.pendingConfirmCodeMeta).toEqual(expect.any(String));
    expect(JSON.stringify(row)).not.toContain(result.confirmCode);
  });

  it('resolves an in-flight submission as a pending GET page', async () => {
    let markLoginStarted!: () => void;
    const loginStarted = new Promise<void>((resolve) => {
      markLoginStarted = resolve;
    });
    let resolveLogin!: (value: { cookieJar: SerializedCookieJar }) => void;
    const loginResult = new Promise<{ cookieJar: SerializedCookieJar }>((resolve) => {
      resolveLogin = resolve;
    });
    const { service } = createService({
      login: async () => {
        markLoginStarted();
        return loginResult;
      },
    });
    const started = await service.startBinding(identity());
    const token = extractToken(started.link);

    const submit = service.submitCredentials({
      token,
      username: 'student-1',
      password: 'secret-password',
      persistCredentialConsent: true,
    });
    await loginStarted;

    await expect(service.resolveBindPageChallenge(token)).resolves.toMatchObject({
      qqUserId: '1405359129',
      state: 'pending',
    });

    resolveLogin({ cookieJar: cookieJar() });
    await submit;
  });

  it('clears pending encrypted state when a newer binding cancels an old challenge', async () => {
    const { service, database } = createService();
    const started = await service.startBinding(identity());
    await service.submitCredentials({
      token: extractToken(started.link),
      username: 'student-1',
      password: 'secret-password',
      persistCredentialConsent: true,
    });

    await service.startBinding(identity());

    expect(database.tables.get('hbu_jw_bind_challenge')?.[0]).toMatchObject({
      status: 'cancelled',
      confirmCodeHash: null,
      pendingConfirmCodeCipher: null,
      pendingConfirmCodeMeta: null,
      pendingCookieJarCipher: null,
      pendingCredentialCipher: null,
      pendingCredentialMeta: null,
    });
  });

  it('surfaces structured jw login failures without consuming the bind challenge', async () => {
    const { service, database } = createService({
      login: async () => {
        throw new HbuJwLoginError('账号不存在', {
          code: 'login_rejected',
          diagnostic: 'login_submit status=200 redirect=none message=账号不存在',
          category: 'credential',
        });
      },
    });
    const started = await service.startBinding(identity());

    await expect(service.submitCredentials({
      token: extractToken(started.link),
      username: 'student-1',
      password: 'secret-password',
      persistCredentialConsent: true,
    })).rejects.toThrow('账号不存在');

    expect(database.tables.get('hbu_jw_bind_challenge')?.[0]).toMatchObject({
      status: 'created',
      errorMessage: 'login_rejected: login_submit status=200 redirect=none message=账号不存在',
    });
    expect(database.tables.get('hbu_jw_auth_audit')?.at(-1)).toMatchObject({
      eventType: 'jw_login_failed',
      status: 'failed',
      reason: 'login_rejected: login_submit status=200 redirect=none message=账号不存在',
    });
  });

  it('requires same QQ and same channel before finalizing the binding', async () => {
    const { service, database } = createService();
    const started = await service.startBinding(identity());
    const token = extractToken(started.link);
    const submitted = await service.submitCredentials({
      token,
      username: 'student-1',
      password: 'secret-password',
      persistCredentialConsent: true,
    });

    await expect(service.confirmBinding(identity({ ownerKey: 'onebot:2', qqUserId: '2' }), submitted.confirmCode)).rejects.toThrow('没有待确认');
    await expect(service.confirmBinding(identity({ channelId: 'group:200' }), submitted.confirmCode)).rejects.toThrow('原群聊');

    await service.confirmBinding(identity(), submitted.confirmCode);
    expect(database.tables.get('hbu_jw_session')).toHaveLength(1);
    expect(database.tables.get('hbu_jw_credential')).toHaveLength(1);
    expect(JSON.stringify(database.tables.get('hbu_jw_credential'))).not.toContain('secret-password');
    expect(database.tables.get('hbu_jw_bind_challenge')?.[0]).toMatchObject({
      status: 'confirmed',
      confirmCodeHash: null,
      pendingConfirmCodeCipher: null,
      pendingConfirmCodeMeta: null,
      pendingCookieJarCipher: null,
      pendingCredentialCipher: null,
      pendingCredentialMeta: null,
    });
  });

  it('automatically logs in again when the cached session is expired', async () => {
    let validateCalls = 0;
    const { service, login } = createService({
      validate: async () => {
        validateCalls += 1;
        return validateCalls > 1;
      },
      login: async () => ({ cookieJar: cookieJar('fresh') }),
    });
    const started = await service.startBinding(identity());
    const submitted = await service.submitCredentials({
      token: extractToken(started.link),
      username: 'student-1',
      password: 'secret-password',
      persistCredentialConsent: true,
    });
    await service.confirmBinding(identity(), submitted.confirmCode);

    const result = await service.ensureAuthenticated(identity());

    expect(result).toEqual({
      kind: 'authenticated',
      cookieJar: cookieJar('fresh'),
      credentialVersion: 1,
    });
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('keeps saved credentials retryable when automatic login fails upstream', async () => {
    let loginCalls = 0;
    const { service, database } = createService({
      validate: async () => false,
      login: async () => {
        loginCalls += 1;
        if (loginCalls === 1) return { cookieJar: cookieJar('initial') };
        throw new HbuJwLoginError('教务登录入口返回 HTTP 503，自动登录暂时无法完成。', {
          code: 'login_page_failed',
          diagnostic: 'login_page status=503',
          category: 'upstream',
        });
      },
    });
    const started = await service.startBinding(identity());
    const submitted = await service.submitCredentials({
      token: extractToken(started.link),
      username: 'student-1',
      password: 'secret-password',
      persistCredentialConsent: true,
    });
    await service.confirmBinding(identity(), submitted.confirmCode);

    await expect(service.ensureAuthenticated(identity())).resolves.toEqual({
      kind: 'unavailable',
      reason: '教务登录入口返回 HTTP 503，自动登录暂时无法完成。',
    });
    expect(database.tables.get('hbu_jw_session')?.[0]).toMatchObject({
      status: 'expired',
      lastFailureReason: '教务登录入口返回 HTTP 503，自动登录暂时无法完成。',
    });
    expect(database.tables.get('hbu_jw_credential')?.[0]?.lastFailureReason).toBeNull();
    expect(database.tables.get('hbu_jw_auth_audit')?.at(-1)).toMatchObject({
      eventType: 'credential_refresh_failed',
      reason: 'login_page_failed: login_page status=503',
    });
  });

  it('marks saved credentials invalid only when the login provider rejects them', async () => {
    let loginCalls = 0;
    const { service, database } = createService({
      validate: async () => false,
      login: async () => {
        loginCalls += 1;
        if (loginCalls === 1) return { cookieJar: cookieJar('initial') };
        throw new HbuJwLoginError('河北大学 WebVPN 拒绝了账号或密码，请确认统一认证密码后重新绑定。', {
          code: 'webvpn_invalid_account',
          diagnostic: 'webvpn error=INVALID_ACCOUNT',
          category: 'credential',
        });
      },
    });
    const started = await service.startBinding(identity());
    const submitted = await service.submitCredentials({
      token: extractToken(started.link),
      username: 'student-1',
      password: 'secret-password',
      persistCredentialConsent: true,
    });
    await service.confirmBinding(identity(), submitted.confirmCode);

    await expect(service.ensureAuthenticated(identity())).resolves.toEqual({
      kind: 'invalid',
      reason: '河北大学 WebVPN 拒绝了账号或密码，请确认统一认证密码后重新绑定。',
    });
    expect(database.tables.get('hbu_jw_session')?.[0]).toMatchObject({
      status: 'invalid',
      lastFailureReason: '河北大学 WebVPN 拒绝了账号或密码，请确认统一认证密码后重新绑定。',
    });
    expect(database.tables.get('hbu_jw_credential')?.[0]?.lastFailureReason).toBe('webvpn_invalid_account: webvpn error=INVALID_ACCOUNT');
    expect(database.tables.get('hbu_jw_auth_audit')?.at(-1)).toMatchObject({
      eventType: 'credential_refresh_rejected',
    });
  });

  it('unbind revokes credentials and removes the current QQ session only', async () => {
    const { service, database } = createService();
    const started = await service.startBinding(identity());
    const submitted = await service.submitCredentials({
      token: extractToken(started.link),
      username: 'student-1',
      password: 'secret-password',
      persistCredentialConsent: true,
    });
    await service.confirmBinding(identity(), submitted.confirmCode);

    await service.unbind(identity());

    expect(database.tables.get('hbu_jw_session')).toEqual([]);
    expect(database.tables.get('hbu_jw_credential')?.[0]).toMatchObject({
      ownerKey: 'onebot:1405359129',
      credentialCipher: '',
      credentialMeta: '',
      revokedAt: 1_000,
    });
    expect(database.tables.get('hbu_jw_bind_challenge')?.[0]).toMatchObject({
      confirmCodeHash: null,
      pendingCookieJarCipher: null,
      pendingCredentialCipher: null,
      pendingCredentialMeta: null,
    });
  });

  it('allows the same QQ to bind again after unbinding', async () => {
    const { service, database } = createService();
    const first = await service.startBinding(identity());
    const firstSubmitted = await service.submitCredentials({
      token: extractToken(first.link),
      username: 'student-1',
      password: 'secret-password',
      persistCredentialConsent: true,
    });
    await service.confirmBinding(identity(), firstSubmitted.confirmCode);
    await service.unbind(identity());

    const second = await service.startBinding(identity());
    const secondSubmitted = await service.submitCredentials({
      token: extractToken(second.link),
      username: 'student-1',
      password: 'new-secret-password',
      persistCredentialConsent: true,
    });
    await service.confirmBinding(identity(), secondSubmitted.confirmCode);

    expect(database.tables.get('hbu_jw_credential')).toHaveLength(1);
    expect(database.tables.get('hbu_jw_credential')?.[0]).toMatchObject({
      ownerKey: 'onebot:1405359129',
      revokedAt: null,
      version: 2,
    });
  });

  it('clears academic cache when confirming a new binding', async () => {
    const { service, database } = createService();
    const first = await service.startBinding(identity());
    const firstSubmitted = await service.submitCredentials({
      token: extractToken(first.link),
      username: 'student-1',
      password: 'secret-password',
      persistCredentialConsent: true,
    });
    await service.confirmBinding(identity(), firstSubmitted.confirmCode);
    database.tables.set('hbu_jw_academic_item', [
      {
        id: 1,
        recordKey: 'old-score',
        ownerKey: identity().ownerKey,
        credentialVersion: 1,
        dataKind: 'passing_score',
        scopeKey: 'all',
        position: 0,
        rawJson: '{"courseName":"旧缓存"}',
        sourceHash: 'hash',
        fetchedAt: 1_000,
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    ]);
    database.tables.set('hbu_jw_academic_sync_state', [
      {
        id: 1,
        syncKey: `${identity().ownerKey}:1:passing_score:all`,
        ownerKey: identity().ownerKey,
        credentialVersion: 1,
        dataKind: 'passing_score',
        scopeKey: 'all',
        lastAttemptedAt: 1_000,
        lastSucceededAt: 1_000,
        lastFailureReason: null,
        rowCount: 1,
        sourceHash: 'hash',
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    ]);

    const second = await service.startBinding(identity());
    const secondSubmitted = await service.submitCredentials({
      token: extractToken(second.link),
      username: 'student-1',
      password: 'new-secret-password',
      persistCredentialConsent: true,
    });
    await service.confirmBinding(identity(), secondSubmitted.confirmCode);

    expect(database.tables.get('hbu_jw_academic_item')).toEqual([]);
    expect(database.tables.get('hbu_jw_academic_sync_state')).toEqual([]);
    expect(database.tables.get('hbu_jw_credential')?.[0]).toMatchObject({ version: 2 });
  });
});

describe('hbu-jw academic cache', () => {
  const auth = {
    cookieJar: cookieJar(),
    credentialVersion: 1,
  };

  it('falls back to a fresh empty database snapshot', async () => {
    const database = createDatabase();
    const store = new HbuJwStore(database as unknown as DatabaseLike);
    const seedClient = {
      getExamSchedule: vi.fn(async () => []),
    };
    const seedCache = new HbuJwAcademicCache(store, seedClient as never, () => Date.UTC(2026, 6, 1));

    const seeded = await seedCache.getExamSchedule(identity(), auth, hbuJwDatabaseFallbackPolicy());

    expect(seeded).toMatchObject({ source: 'remote', data: [] });
    expect(database.tables.get('hbu_jw_academic_sync_state')?.[0]).toMatchObject({
      dataKind: 'exam_event',
      scopeKey: 'current',
      rowCount: 0,
    });

    const failingClient = {
      getExamSchedule: vi.fn(async () => {
        throw new Error('jw unavailable');
      }),
    };
    const fallbackCache = new HbuJwAcademicCache(store, failingClient as never, () => Date.UTC(2026, 6, 2));

    const fallback = await fallbackCache.getExamSchedule(identity(), auth, hbuJwDatabaseFallbackPolicy());

    expect(fallback).toMatchObject({ source: 'database', data: [] });
    expect(failingClient.getExamSchedule).toHaveBeenCalledWith(auth.cookieJar);
  });

  it('rejects stale database snapshots', async () => {
    const database = createDatabase();
    const store = new HbuJwStore(database as unknown as DatabaseLike);
    const seedCache = new HbuJwAcademicCache(
      store,
      { getExamSchedule: vi.fn(async () => [examPlanEvent()]) } as never,
      () => Date.UTC(2026, 6, 1),
    );
    await seedCache.getExamSchedule(identity(), auth, hbuJwDatabaseFallbackPolicy());
    const staleCache = new HbuJwAcademicCache(
      store,
      {
        getExamSchedule: vi.fn(async () => {
          throw new Error('jw unavailable');
        }),
      } as never,
      () => Date.UTC(2027, 0, 15),
    );

    await expect(staleCache.getExamSchedule(identity(), auth, hbuJwDatabaseFallbackPolicy())).rejects.toThrow('jw unavailable');
  });

  it('updates changed rows and deletes rows missing from the latest remote snapshot', async () => {
    const database = createDatabase();
    const store = new HbuJwStore(database as unknown as DatabaseLike);
    const firstClient = {
      getAllPassingScores: vi.fn(async () => [
        scoreRow({ id: { executiveEducationPlanNumber: '2025-2026-2-2', courseNumber: 'CACHE001' }, courseName: '缓存软件工程', gradePointScore: 4 }),
        scoreRow({ id: { executiveEducationPlanNumber: '2025-2026-2-2', courseNumber: 'CACHE002' }, courseName: '待删除课程', gradePointScore: 3 }),
      ]),
    };
    const firstCache = new HbuJwAcademicCache(store, firstClient as never, () => Date.UTC(2026, 6, 1));
    await firstCache.getAllPassingScores(identity(), auth, hbuJwDatabaseFallbackPolicy());
    const firstRows = database.tables.get('hbu_jw_academic_item') ?? [];
    const stableRecordKey = firstRows.find((row) => String(row.rawJson).includes('缓存软件工程'))?.recordKey;

    const secondClient = {
      getAllPassingScores: vi.fn(async () => [
        scoreRow({ id: { executiveEducationPlanNumber: '2025-2026-2-2', courseNumber: 'CACHE001' }, courseName: '缓存软件工程', gradePointScore: 4.5 }),
      ]),
    };
    const secondCache = new HbuJwAcademicCache(store, secondClient as never, () => Date.UTC(2026, 6, 2));
    await secondCache.getAllPassingScores(identity(), auth, hbuJwDatabaseFallbackPolicy());

    const rows = database.tables.get('hbu_jw_academic_item') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recordKey: stableRecordKey, fetchedAt: Date.UTC(2026, 6, 2) });
    expect(JSON.parse(String(rows[0]?.rawJson))).toMatchObject({
      courseName: '缓存软件工程',
      gradePointScore: 4.5,
    });
    expect(JSON.stringify(rows)).not.toContain('待删除课程');
  });
});

describe('hbu-jw menu module', () => {
  it('only exposes command guidance for likely feature usage', () => {
    const session = (content: string) => ({ content, stripped: { content } }) as never;

    expect(shouldExposeHbuJwCapabilityReference(session('在'))).toBe(false);
    expect(shouldExposeHbuJwCapabilityReference(session('我的成绩有点差，安慰一下我'))).toBe(false);
    expect(shouldExposeHbuJwCapabilityReference(session('你觉得 GPA 重要吗？'))).toBe(false);
    expect(shouldExposeHbuJwCapabilityReference(session('我去教务处拿材料'))).toBe(false);
    expect(shouldExposeHbuJwCapabilityReference(session('课程查询模式识别'))).toBe(true);
    expect(shouldExposeHbuJwCapabilityReference(session('课程查询 模式识别 -1'))).toBe(true);
    expect(shouldExposeHbuJwCapabilityReference(session('GPA 怎么查'))).toBe(true);
    expect(shouldExposeHbuJwCapabilityReference(session('教务功能怎么用'))).toBe(true);
  });

  it('describes the exact course query contract for Agent corrections', () => {
    const reference = buildHbuJwCapabilityReference({
      isDirect: false,
      guildId: '100',
      channelId: '100',
    } as never, {
      allowedGroups: new Set(['100']),
      naturalTriggerEnabled: false,
      naturalTriggerGroups: new Set<string>(),
    } as never);

    expect(reference).toContain('总入口：“教务”');
    expect(reference).toContain('群聊中需要 @机器人');
    expect(reference).toContain('课程查询 <课程名关键词或课程号> [学期]');
    expect(reference).toContain('命令名后必须有空格');
    expect(reference).toContain('0（本学期）');
    expect(reference).toContain('2025-2026-2-2');
    expect(reference).toContain('课程号精确匹配');
    expect(reference).not.toContain('hbu_jw_course_guidance_context');

    const guidanceReference = buildHbuJwCapabilityReference({
      isDirect: true,
      content: '选课指导',
      stripped: { content: '选课指导' },
    } as never, {
      allowedGroups: new Set<string>(),
      naturalTriggerEnabled: false,
      naturalTriggerGroups: new Set<string>(),
    } as never);
    expect(guidanceReference).toContain('hbu_jw_course_guidance_context');

    const routedGuidanceReference = buildHbuJwCapabilityReference({
      isDirect: false,
      content: 'saki 选课指导',
      stripped: { content: 'saki 选课指导' },
    } as never, {
      allowedGroups: new Set(['100']),
      naturalTriggerEnabled: true,
      naturalTriggerGroups: new Set(['100']),
    } as never, true);
    expect(routedGuidanceReference).toContain('hbu_jw_course_guidance_context');
  });

  it('builds the academic affairs menu with all exposed keywords', () => {
    const view = buildHbuJwMenuView();

    expect(view.title).toBe('教务功能菜单');
    expect(view.subtitle).toBe('发送 教务 查看本菜单');
    expect(view.sections.map((section) => [section.title, section.items.map((item) => [item.keyword, item.description])])).toEqual([
      [
        '账号',
        [
          ['教务绑定', '绑定教务账号'],
          ['教务确认 <确认码>', '网页登录成功后确认绑定'],
          ['教务状态', '检查当前绑定状态'],
          ['教务解绑', '解除教务账号与QQ的绑定，相关加密数据也会清除'],
        ],
      ],
      [
        '查询',
        [
          ['GPA', '计算推免相关GPA，排除艺术类等必修课程'],
          ['成绩', '查看本学期成绩'],
          ['匿名成绩', '查看本学期成绩，但不显示敏感数据，可查是否出分'],
          ['课程查询', '查看指定课程的分项成绩接口返回'],
          ['选课结果', '查看本学期课程、学分与选课状态'],
          ['课表', '查看这周的课表'],
          ['完整课表', '查看本学期动态课表'],
          ['考试安排', '查看本学期的考试安排'],
        ],
      ],
    ]);
  });

  it('renders the menu view as a PNG image with two visual panels', async () => {
    const { page, puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const image = await renderHbuJwMenuImage(puppeteer, buildHbuJwMenuView());
    const html = getNavigatedHtml();

    expect(String(image)).toContain('image/png');
    expect(html).toContain('教务功能菜单');
    expect(html).toContain('发送 <strong>教务</strong> 查看本菜单');
    expect(html).toContain('class="campus campus-left"');
    expect(html).toContain('class="campus campus-right"');
    expect(html).toContain('class="panel-title">账号');
    expect(html).toContain('class="panel-title">查询');
    expect(html).toContain('教务绑定');
    expect(html).toContain('教务确认 <span class="param">&lt;确认码&gt;</span>');
    expect(html).toContain('网页登录成功后确认绑定');
    expect(html).toContain('解除教务账号与QQ的绑定，相关加密数据也会清除');
    expect(html).toContain('计算推免相关GPA，排除艺术类等必修课程');
    expect(html).toContain('查看本学期成绩');
    expect(html).toContain('匿名成绩');
    expect(html).toContain('查看本学期成绩，但不显示敏感数据，可查是否出分');
    expect(html).toContain('课程查询');
    expect(html).toContain('选课结果');
    expect(html).toContain('考试安排');
    expect(html).not.toContain('<table>');
    expect(html).not.toContain('提示：');
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'png' }));
  });

  it('returns a mentioned menu image without requiring authentication', async () => {
    const { puppeteer } = createPuppeteerHarness();
    const service = new HbuJwMenuService(puppeteer);

    const reply = await service.queryMenu('1405359129');

    expect(extractAtIds(reply)).toEqual(['1405359129']);
    expect(renderMessageContent(reply)).toContain('image/png');
  });
});

describe('hbu-jw GPA calculation', () => {
  it('calculates required-course GPA and excludes configured non-GPA courses', () => {
    const result = calculateHbuJwGpa([
      scoreRow({ id: { courseNumber: '2023D00003' }, courseName: '程序设计', credit: '3', gradePointScore: 4.5 }),
      scoreRow({ id: { courseNumber: '2023D00104' }, courseName: '算法设计与分析', credit: '3', gradePointScore: 4.8, academicYearCode: '2024-2025', termName: '秋' }),
      scoreRow({ id: { courseNumber: '2023S01002' }, courseName: '操作系统课程设计', credit: '1', gradePointScore: 4.2, academicYearCode: '2025-2026', termName: '秋' }),
      scoreRow({ id: { courseNumber: '3123G0006A' }, courseName: '形势与政策1', credit: '0.25', gradePointScore: 4.0 }),
      scoreRow({ id: { courseNumber: '6423G00002' }, courseName: '创业基础', credit: '2', gradePointScore: 4.1 }),
      scoreRow({ id: { courseNumber: '3723G00003' }, courseName: '大学生心理健康教育', credit: '1', gradePointScore: 4.3 }),
      scoreRow({ id: { courseNumber: '0823GRY017' }, courseName: '燕赵非遗鉴赏与体验', credit: '1', gradePointScore: 4.1 }),
      scoreRow({ id: { courseNumber: '0823GRY019' }, courseName: '坤舆艺术名家讲堂系列', credit: '1', gradePointScore: 4.6 }),
      scoreRow({ id: { courseNumber: 'TWX23G0008' }, courseName: '大学生心理健康', courseAttributeCode: '003', courseAttributeName: '任选' }),
      scoreRow({ id: { courseNumber: '2023D09999' }, courseName: '待录入绩点课程', credit: '2', gradePointScore: null }),
    ]);

    expect(result.gpa).toBeCloseTo((3 * 4.5 + 3 * 4.8 + 1 * 4.2) / 7, 8);
    expect(result.gpaRounded).toBe('4.59');
    expect(result.includedCourseCount).toBe(3);
    expect(result.includedCredits).toBe(7);
    expect(result.excludedNonRequiredCount).toBe(1);
    expect(result.excludedFixedCourses.map((row) => row.courseName)).toEqual(['形势与政策1', '创业基础', '大学生心理健康教育']);
    expect(result.excludedArtCourses.map((row) => row.courseName)).toEqual(['燕赵非遗鉴赏与体验', '坤舆艺术名家讲堂系列']);
    expect(result.skippedNoGradePointCourses.map((row) => row.courseName)).toEqual(['待录入绩点课程']);
    expect(result.coveredTerms).toEqual(['2023-2024 秋', '2024-2025 秋', '2025-2026 秋']);
    expect(result.professional.gpaRounded).toBe('4.59');
    expect(result.professional.includedCredits).toBe(7);
    expect(result.general.gpaRounded).toBeNull();
    expect(result.termTrend.map((point) => point.cumulativeGpaRounded)).toEqual(['4.50', '4.65', '4.59']);
  });

  it('partitions included courses into professional and general masks', () => {
    const result = calculateHbuJwGpa([
      scoreRow({ id: { courseNumber: 'MAJOR02' }, courseName: '程序设计', credit: 3, gradePointScore: 4.8, academicYearCode: '2024-2025', termName: '春' }),
      scoreRow({ id: { courseNumber: 'MAJOR01' }, courseName: '高等数学', credit: 4, gradePointScore: 4.5, academicYearCode: '2023-2024', termName: '秋' }),
      scoreRow({ id: { courseNumber: 'GENERAL01' }, courseName: '大学英语1', credit: 2, gradePointScore: 4, academicYearCode: '2023-2024', termName: '春' }),
      scoreRow({ id: { courseNumber: 'GENERAL02' }, courseName: '大学体育2', credit: 1, gradePointScore: 3.5, academicYearCode: '2024-2025', termName: '秋' }),
      scoreRow({ id: { courseNumber: 'OTHER01' }, courseName: '法学概论', credit: 2, gradePointScore: 4.2, academicYearCode: '2025-2026', termName: '秋' }),
    ]);

    expect(result.professional).toMatchObject({
      gpaRounded: '4.63',
      includedCredits: 7,
      includedCourseCount: 2,
    });
    expect(result.general).toMatchObject({
      gpaRounded: '3.98',
      includedCredits: 5,
      includedCourseCount: 3,
    });
    expect(result.professional.includedCredits + result.general.includedCredits).toBe(result.includedCredits);
    expect(result.termTrend.map((point) => point.label)).toEqual([
      '2023-2024 秋',
      '2023-2024 春',
      '2024-2025 秋',
      '2024-2025 春',
      '2025-2026 秋',
    ]);
    expect(result.termTrend.at(-1)?.cumulativeGpa).toBeCloseTo(result.gpa, 8);
  });

  it('renders the GPA view as a PNG card with category summaries and a trend chart', async () => {
    const result = calculateHbuJwGpa([
      scoreRow({ id: { courseNumber: 'MAJOR01' }, courseName: '高等数学', credit: 4, gradePointScore: 4.5, academicYearCode: '2023-2024', termName: '秋' }),
      scoreRow({ id: { courseNumber: 'GENERAL01' }, courseName: '大学英语1', credit: 2, gradePointScore: 4, academicYearCode: '2023-2024', termName: '春' }),
    ]);
    const view = buildHbuJwGpaView(result);
    const html = renderHbuJwGpaHtml(view);
    const { page, puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const image = await renderHbuJwGpaImage(puppeteer, view);

    expect(String(image)).toContain('image/png');
    expect(html).toContain('累计加权 GPA');
    expect(html).toContain('专业课 GPA');
    expect(html).toContain('公共基础 GPA');
    expect(html).toContain('其他计入必修课程');
    expect(html).toContain('累计 GPA 走势');
    expect(html).toContain('class="chart-grid" x1="68"');
    expect(html).toContain('class="chart-value-label" x="94"');
    expect(html).toContain('class="chart-term-label" x="94"');
    expect(html).not.toContain('当前所有已返回成绩');
    expect(html).not.toContain('必修课口径');
    expect(html).not.toContain('结果仅供参考');
    expect(getNavigatedHtml()).toBe(html);
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'png' }));
  });

  it('uses the authenticated session to query and render a GPA image', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: cookieJar(),
    }));
    const getAllPassingScores = vi.fn(async () => [
      scoreRow({ id: { courseNumber: '2023D00003' }, courseName: '程序设计', credit: '3', gradePointScore: 4.5 }),
    ]);
    const { puppeteer } = createPuppeteerHarness();
    const service = new HbuJwGpaService({ ensureAuthenticated }, { getAllPassingScores }, puppeteer);

    const reply = await service.queryGpa(identity());

    expect(renderMessageContent(reply)).toContain('image/png');
    expect(extractAtIds(reply)).toEqual(['1405359129']);
    expect(ensureAuthenticated).toHaveBeenCalledWith(identity());
    expect(getAllPassingScores).toHaveBeenCalledWith(cookieJar());
  });

  it('writes remote GPA source rows into the academic cache', async () => {
    const database = createDatabase();
    const store = new HbuJwStore(database as unknown as DatabaseLike);
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: cookieJar(),
      credentialVersion: 1,
    }));
    const getAllPassingScores = vi.fn(async () => [
      scoreRow({ id: { courseNumber: '2023D00003' }, courseName: '程序设计', credit: '3', gradePointScore: 4.5 }),
    ]);
    const cache = new HbuJwAcademicCache(store, { getAllPassingScores } as never, () => Date.UTC(2026, 6, 1));
    const service = new HbuJwGpaService(
      { ensureAuthenticated },
      { getAllPassingScores },
      createPuppeteerHarness().puppeteer,
      cache,
    );

    await service.queryGpa(identity());

    expect(database.tables.get('hbu_jw_academic_item')).toMatchObject([
      {
        ownerKey: identity().ownerKey,
        credentialVersion: 1,
        dataKind: 'passing_score',
        scopeKey: 'all',
      },
    ]);
    expect(database.tables.get('hbu_jw_academic_item')?.[0]?.rawJson).toContain('程序设计');
  });

  it('falls back to cached GPA source rows with an explicit database marker', async () => {
    const database = createDatabase();
    const store = new HbuJwStore(database as unknown as DatabaseLike);
    const auth = {
      kind: 'authenticated' as const,
      cookieJar: cookieJar(),
      credentialVersion: 1,
    };
    const seedGetAllPassingScores = vi.fn(async () => [
      scoreRow({ id: { courseNumber: '2023D00003' }, courseName: '程序设计', credit: '3', gradePointScore: 4.5 }),
    ]);
    const seedCache = new HbuJwAcademicCache(store, { getAllPassingScores: seedGetAllPassingScores } as never, () => Date.UTC(2026, 6, 1));
    await new HbuJwGpaService(
      { ensureAuthenticated: vi.fn(async () => auth) },
      { getAllPassingScores: seedGetAllPassingScores },
      createPuppeteerHarness().puppeteer,
      seedCache,
    ).queryGpa(identity());

    const failingGetAllPassingScores = vi.fn(async () => {
      throw new Error('jw unavailable');
    });
    const failingCache = new HbuJwAcademicCache(store, { getAllPassingScores: failingGetAllPassingScores } as never, () => Date.UTC(2026, 6, 2));
    const service = new HbuJwGpaService(
      { ensureAuthenticated: vi.fn(async () => auth) },
      { getAllPassingScores: failingGetAllPassingScores },
      createPuppeteerHarness().puppeteer,
      failingCache,
    );

    const reply = await service.queryGpa(identity());

    expect(renderMessageContent(reply)).toContain('实时查询失败，以下为数据库记录');
    expect(renderMessageContent(reply)).toContain('image/png');
    expect(failingGetAllPassingScores).toHaveBeenCalledWith(cookieJar());
  });

  it('surfaces binding requirements before querying scores', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'needs_binding' as const,
      reason: '请先发送“教务绑定”。',
    }));
    const getAllPassingScores = vi.fn();
    const { puppeteer } = createPuppeteerHarness();
    const service = new HbuJwGpaService({ ensureAuthenticated }, { getAllPassingScores }, puppeteer);

    await expect(service.queryGpa(identity())).rejects.toThrow('请先发送“教务绑定”。');
    expect(getAllPassingScores).not.toHaveBeenCalled();
    expect(puppeteer.page).not.toHaveBeenCalled();
  });
});

describe('hbu-jw term scores module', () => {
  it('builds a concise term score table view with status counts', () => {
    const confirmedRow = thisTermScoreRow();
    const recordedRow = thisTermScoreRow({
      id: { courseNumber: '2023S01004', executiveEducationPlanNumber: '2025-2026-2-2' },
      courseName: '编译原理',
      credit: 3,
      courseScore: '84',
      gradePoint: 4.2,
      inputStatusCode: '04',
      inputStatusExplain: '暂存',
    });
    const pendingRow = thisTermScoreRow({
      id: { courseNumber: '2023S01005', executiveEducationPlanNumber: '2025-2026-2-2' },
      courseName: '网络安全基础实验',
      credit: 1,
      courseScore: '',
      gradePoint: 4.8,
      inputStatusCode: '01',
      inputStatusExplain: '尚未录入',
    });
    const view = buildHbuJwTermScoresView({
      mode: 'full',
      rows: [confirmedRow, recordedRow, pendingRow],
      allPassingRows: [
        scoreRow({
          id: { courseNumber: '2023S01003' },
          courseName: '软件工程',
          credit: 3,
          gradePointScore: 4.5,
        }),
      ],
      statusOverrides: new Map([[recordedRow, { kind: 'recorded', recordedCount: 2 }]]),
    });

    expect(view.subtitle).toBe('2025-2026 春 · 3 门课程 · 7 学分');
    expect(view.confirmedCount).toBe(1);
    expect(view.recordedCount).toBe(1);
    expect(view.pendingCount).toBe(1);
    expect(view.rows.map((row) => [row.courseName, row.statusText, row.timeText, row.scoreText, row.gradePointText, row.gpaDeltaText])).toEqual([
      ['软件工程', '确定', '—', '97', '4.5', '—'],
      ['编译原理', '已录入2', '—', '84', '—', '待确定'],
      ['网络安全基础实验', '尚未录入', '—', '—', '—', '—'],
    ]);
  });

  it('builds anonymous term score rows without exposing sensitive score fields', () => {
    const confirmedRow = thisTermScoreRow({
      avgcj: '88.2',
      rank: '3/78',
    });
    const recordedRow = thisTermScoreRow({
      id: { courseNumber: '2023S01004', executiveEducationPlanNumber: '2025-2026-2-2' },
      courseName: '暂存课程',
      courseScore: '84',
      gradePoint: 4.2,
      inputStatusCode: '04',
      inputStatusExplain: '暂存',
      avgcj: '82.5',
      rank: '10/78',
    });
    const pendingRow = thisTermScoreRow({
      id: { courseNumber: '2023S01005', executiveEducationPlanNumber: '2025-2026-2-2' },
      courseName: '未录入课程',
      courseScore: '',
      gradePoint: '',
      inputStatusCode: '01',
      inputStatusExplain: '尚未录入',
      avgcj: '',
      rank: '',
    });
    const view = buildHbuJwTermScoresView({
      mode: 'anonymous',
      rows: [confirmedRow, recordedRow, pendingRow],
      statusOverrides: new Map([[recordedRow, { kind: 'recorded', recordedCount: 12 }]]),
    });

    expect(view.rows.map((row) => [
      row.courseName,
      row.statusText,
      row.scoreText,
      row.gradePointText,
      row.averageText,
      row.rankText,
      row.gpaDeltaText,
      row.gpaDeltaKind,
    ])).toEqual([
      ['软件工程', '确定', '*', '*', '88.2', '*', '*', 'anonymous'],
      ['暂存课程', '已录入12', '*', '*', '—', '*', '*', 'anonymous'],
      ['未录入课程', '尚未录入', '*', '*', '—', '*', '*', 'anonymous'],
    ]);
  });

  it('sorts term scores by status and time while calculating cumulative GPA deltas', () => {
    const recordedRow = thisTermScoreRow({
      id: { courseNumber: 'TEMP001', executiveEducationPlanNumber: '2025-2026-2-2' },
      courseName: '暂存课程',
      courseScore: '91',
      gradePoint: 4.7,
      inputStatusCode: '04',
      inputStatusExplain: '暂存',
      operatetime: '20260701090000',
    });
    const view = buildHbuJwTermScoresView({
      mode: 'full',
      rows: [
        recordedRow,
        thisTermScoreRow({
          id: { courseNumber: 'CURR_LOW', executiveEducationPlanNumber: '2025-2026-2-2' },
          courseName: '后确定低绩点',
          credit: 3,
          gradePoint: 2,
          courseScore: '70',
          operatetime: '20260701110000',
        }),
        thisTermScoreRow({
          id: { courseNumber: 'PENDING001', executiveEducationPlanNumber: '2025-2026-2-2' },
          courseName: '未录入课程',
          courseScore: '',
          gradePoint: '',
          inputStatusCode: '01',
          inputStatusExplain: '尚未录入',
          operatetime: '20260630120000',
        }),
        thisTermScoreRow({
          id: { courseNumber: 'ELECTIVE001', executiveEducationPlanNumber: '2025-2026-2-2' },
          courseName: '选修课程',
          credit: 2,
          gradePoint: 4.9,
          courseScore: '99',
          coursePropertyCode: '003',
          coursePropertyName: '任选',
          operatetime: '20260701103000',
        }),
        thisTermScoreRow({
          id: { courseNumber: 'CURR_HIGH', executiveEducationPlanNumber: '2025-2026-2-2' },
          courseName: '先确定高绩点',
          credit: 3,
          gradePoint: 5,
          courseScore: '99',
          operatetime: '20260701080000',
        }),
      ],
      allPassingRows: [
        scoreRow({ id: { courseNumber: 'BASE001' }, courseName: '历史课程', credit: 3, gradePointScore: 4 }),
        scoreRow({ id: { courseNumber: 'CURR_HIGH' }, courseName: '先确定高绩点', credit: 3, gradePointScore: 5 }),
        scoreRow({ id: { courseNumber: 'CURR_LOW' }, courseName: '后确定低绩点', credit: 3, gradePointScore: 2 }),
        scoreRow({
          id: { courseNumber: 'ELECTIVE001' },
          courseName: '选修课程',
          credit: 2,
          gradePointScore: 4.9,
          courseAttributeCode: '003',
          courseAttributeName: '任选',
        }),
      ],
      statusOverrides: new Map([[recordedRow, { kind: 'recorded', recordedCount: 3 }]]),
    });

    expect(view.rows.map((row) => row.courseName)).toEqual([
      '先确定高绩点',
      '选修课程',
      '后确定低绩点',
      '暂存课程',
      '未录入课程',
    ]);
    expect(view.rows.map((row) => [row.timeText, row.gpaDeltaText, row.gpaDeltaKind])).toEqual([
      ['07-01 08:00', '+0.500', 'positive'],
      ['07-01 10:30', '不计', 'not-counted'],
      ['07-01 11:00', '-0.833', 'negative'],
      ['07-01 09:00', '待确定', 'pending'],
      ['06-30 12:00', '—', 'missing'],
    ]);
  });

  it('renders the term score view as a PNG image with the core table in the HTML', async () => {
    const { page, puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const recordedRow = thisTermScoreRow({
      id: { courseNumber: '2023S01004', executiveEducationPlanNumber: '2025-2026-2-2' },
      courseName: '编译原理',
      courseScore: '84',
      inputStatusCode: '04',
      inputStatusExplain: '暂存',
    });
    const image = await renderHbuJwTermScoresImage(
      puppeteer,
      buildHbuJwTermScoresView({
        mode: 'full',
        rows: [thisTermScoreRow(), recordedRow],
        allPassingRows: [
          scoreRow({ id: { courseNumber: '2023S01003' }, courseName: '软件工程', credit: 3, gradePointScore: 4.5 }),
        ],
        statusOverrides: new Map([[recordedRow, { kind: 'recorded', recordedCount: 1 }]]),
      }),
    );

    expect(String(image)).toContain('image/png');
    expect(getNavigatedHtml()).toContain('河北大学本学期成绩');
    expect(getNavigatedHtml()).toContain('软件工程');
    expect(getNavigatedHtml()).toContain('编译原理');
    expect(getNavigatedHtml()).toContain('时间');
    expect(getNavigatedHtml()).toContain('GPA增量');
    expect(getNavigatedHtml()).toContain('已录入1');
    expect(getNavigatedHtml()).toContain('status-recorded');
    expect(getNavigatedHtml()).toContain('gpa-missing');
    expect(getNavigatedHtml()).toContain('gpa-pending');
    expect(getNavigatedHtml()).toContain('<table>');
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'png' }));
  });

  it('uses the authenticated session to query and render term scores', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: cookieJar(),
    }));
    const getThisTermScores = vi.fn(async () => [thisTermScoreRow()]);
    const getAllPassingScores = vi.fn(async () => [
      scoreRow({ id: { courseNumber: '2023S01003' }, courseName: '软件工程', credit: 3, gradePointScore: 4.5 }),
    ]);
    const getSubitemScoreDetails = vi.fn();
    const { puppeteer } = createPuppeteerHarness();
    const service = new HbuJwTermScoresService(
      { ensureAuthenticated },
      { getThisTermScores, getAllPassingScores, getSubitemScoreDetails },
      puppeteer,
    );

    const reply = await service.queryTermScores(identity());

    expect(extractAtIds(reply)).toEqual(['1405359129']);
    expect(renderMessageContent(reply)).toContain('image/png');
    expect(ensureAuthenticated).toHaveBeenCalledWith(identity());
    expect(getThisTermScores).toHaveBeenCalledWith(cookieJar());
    expect(getAllPassingScores).toHaveBeenCalledWith(cookieJar());
    expect(getSubitemScoreDetails).not.toHaveBeenCalled();
  });

  it('falls back to cached term score rows with an explicit database marker', async () => {
    const database = createDatabase();
    const store = new HbuJwStore(database as unknown as DatabaseLike);
    const auth = {
      kind: 'authenticated' as const,
      cookieJar: cookieJar(),
      credentialVersion: 1,
    };
    const ensureAuthenticated = vi.fn(async () => auth);
    const seedTermRows = [
      thisTermScoreRow({
        id: { courseNumber: 'CACHE001', executiveEducationPlanNumber: '2025-2026-2-2' },
        courseName: '缓存软件工程',
        credit: 3,
        gradePoint: 4.5,
      }),
    ];
    const seedPassingRows = [
      scoreRow({ id: { courseNumber: 'CACHE001' }, courseName: '缓存软件工程', credit: 3, gradePointScore: 4.5 }),
    ];
    const seedClient = {
      getThisTermScores: vi.fn(async () => seedTermRows),
      getAllPassingScores: vi.fn(async () => seedPassingRows),
      getSubitemScoreDetails: vi.fn(),
    };
    const seedCache = new HbuJwAcademicCache(store, seedClient as never, () => Date.UTC(2026, 6, 1));
    await new HbuJwTermScoresService(
      { ensureAuthenticated },
      seedClient,
      createPuppeteerHarness().puppeteer,
      seedCache,
    ).queryTermScores(identity());

    const failingClient = {
      getThisTermScores: vi.fn(async () => {
        throw new Error('jw term scores unavailable');
      }),
      getAllPassingScores: vi.fn(async () => {
        throw new Error('jw passing scores unavailable');
      }),
      getSubitemScoreDetails: vi.fn(),
    };
    const fallbackCache = new HbuJwAcademicCache(store, failingClient as never, () => Date.UTC(2026, 6, 2));
    const { puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const service = new HbuJwTermScoresService(
      { ensureAuthenticated },
      failingClient,
      puppeteer,
      fallbackCache,
    );

    const reply = await service.queryTermScores(identity());

    expect(renderMessageContent(reply)).toContain('实时查询失败，以下为数据库记录');
    expect(getNavigatedHtml()).toContain('缓存软件工程');
    expect(failingClient.getThisTermScores).toHaveBeenCalledWith(cookieJar());
    expect(failingClient.getAllPassingScores).toHaveBeenCalledWith(cookieJar());
  });

  it('does not use cached term score rows from another credential version', async () => {
    const database = createDatabase();
    const store = new HbuJwStore(database as unknown as DatabaseLike);
    const seedClient = {
      getThisTermScores: vi.fn(async () => [thisTermScoreRow({ courseName: '旧账号课程' })]),
      getAllPassingScores: vi.fn(async () => [scoreRow({ id: { courseNumber: '2023S01003' }, courseName: '旧账号课程', credit: 3, gradePointScore: 4.5 })]),
      getSubitemScoreDetails: vi.fn(),
    };
    const seedCache = new HbuJwAcademicCache(store, seedClient as never, () => Date.UTC(2026, 6, 1));
    await new HbuJwTermScoresService(
      {
        ensureAuthenticated: vi.fn(async () => ({
          kind: 'authenticated' as const,
          cookieJar: cookieJar(),
          credentialVersion: 1,
        })),
      },
      seedClient,
      createPuppeteerHarness().puppeteer,
      seedCache,
    ).queryTermScores(identity());

    const failingClient = {
      getThisTermScores: vi.fn(async () => {
        throw new Error('jw unavailable');
      }),
      getAllPassingScores: vi.fn(async () => {
        throw new Error('jw unavailable');
      }),
      getSubitemScoreDetails: vi.fn(),
    };
    const fallbackCache = new HbuJwAcademicCache(store, failingClient as never, () => Date.UTC(2026, 6, 2));
    const service = new HbuJwTermScoresService(
      {
        ensureAuthenticated: vi.fn(async () => ({
          kind: 'authenticated' as const,
          cookieJar: cookieJar(),
          credentialVersion: 2,
        })),
      },
      failingClient,
      createPuppeteerHarness().puppeteer,
      fallbackCache,
    );

    await expect(service.queryTermScores(identity())).rejects.toThrow('教务成绩查询失败，请稍后重试。');
    expect(database.tables.get('hbu_jw_academic_item')?.some((row) => row.credentialVersion === 1)).toBe(true);
    expect(database.tables.get('hbu_jw_academic_item')?.some((row) => row.credentialVersion === 2)).toBe(false);
  });

  it('uses primary look result row counts for recorded term score status', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: cookieJar(),
    }));
    const getThisTermScores = vi.fn(async () => [
      thisTermScoreRow({
        id: {
          courseNumber: '2023S01004',
          executiveEducationPlanNumber: '2025-2026-2-2',
          examtime: '20260620',
          studentNumber: '20231202051',
        },
        courseName: '编译原理',
        courseScore: '84',
        inputStatusCode: '04',
        inputStatusExplain: '暂存',
      }),
    ]);
    const getAllPassingScores = vi.fn(async () => []);
    const getSubitemScoreDetails = vi.fn(async () => ({
      params: { zxjxjhh: '2025-2026-2-2', kch: '2023S01004', kxh: '01', kssj: '20260620', kcsxdm: '001' },
      message: '',
      rows: [
        { id: { studentNumber: '20231202051', scoreTypeCode: '001' }, zcj: 84 },
        { id: { studentNumber: '20231202051', scoreTypeCode: '002' }, zcj: 84 },
        { id: { studentNumber: '20231202051', scoreTypeCode: '003' }, zcj: 84 },
        { id: { studentNumber: '20231202052', scoreTypeCode: '001' }, zcj: 81 },
        { id: { studentNumber: '20231202052', scoreTypeCode: '002' }, zcj: 81 },
        { id: { studentNumber: '20231202052', scoreTypeCode: '003' }, zcj: 81 },
      ],
    }));
    const { puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const service = new HbuJwTermScoresService(
      { ensureAuthenticated },
      { getThisTermScores, getAllPassingScores, getSubitemScoreDetails },
      puppeteer,
    );

    await service.queryTermScores(identity());

    expect(getSubitemScoreDetails).toHaveBeenCalledWith(
      cookieJar(),
      { zxjxjhh: '2025-2026-2-2', kch: '2023S01004', kxh: '01', kssj: '20260620', kcsxdm: '001' },
    );
    expect(getNavigatedHtml()).toContain('已录入2');
    expect(getNavigatedHtml()).toContain('<td class="score-col score">84</td>');
  });

  it('uses pending raw status look results for recorded term score status', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: cookieJar(),
    }));
    const getThisTermScores = vi.fn(async () => [
      thisTermScoreRow({
        id: {
          courseNumber: '2023S01004',
          executiveEducationPlanNumber: '2025-2026-2-2',
          examtime: '20260620',
          studentNumber: '20231202051',
        },
        courseName: '编译原理',
        courseScore: '',
        inputStatusCode: '01',
        inputStatusExplain: '尚未录入',
      }),
    ]);
    const getAllPassingScores = vi.fn(async () => []);
    const getSubitemScoreDetails = vi.fn(async () => ({
      params: { zxjxjhh: '2025-2026-2-2', kch: '2023S01004', kxh: '01', kssj: '20260620', kcsxdm: '001' },
      message: '',
      rows: [
        { id: { studentNumber: '20231202051', scoreTypeCode: '001' }, zcj: null },
        { id: { studentNumber: '20231202051', scoreTypeCode: '002' }, zcj: null },
        { id: { studentNumber: '20231202051', scoreTypeCode: '003' }, zcj: null },
      ],
    }));
    const { puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const service = new HbuJwTermScoresService(
      { ensureAuthenticated },
      { getThisTermScores, getAllPassingScores, getSubitemScoreDetails },
      puppeteer,
    );

    await service.queryTermScores(identity());

    expect(getSubitemScoreDetails).toHaveBeenCalledTimes(1);
    expect(getNavigatedHtml()).toContain('已录入1');
  });

  it('uses look results without primary score rows as pending term score status', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: cookieJar(),
    }));
    const getThisTermScores = vi.fn(async () => [
      thisTermScoreRow({
        id: {
          courseNumber: '2023S01004',
          executiveEducationPlanNumber: '2025-2026-2-2',
          examtime: '20260620',
          studentNumber: '20231202051',
        },
        courseName: '编译原理',
        courseScore: '',
        inputStatusCode: '04',
        inputStatusExplain: '暂存',
      }),
    ]);
    const getAllPassingScores = vi.fn(async () => []);
    const getSubitemScoreDetails = vi.fn(async () => ({
      params: { zxjxjhh: '2025-2026-2-2', kch: '2023S01004', kxh: '01', kssj: '20260620', kcsxdm: '001' },
      message: '',
      rows: [
        { id: { studentNumber: '20231202051', scoreTypeCode: '002' }, zcj: null },
        { id: { studentNumber: '20231202051', scoreTypeCode: '003' }, zcj: null },
      ],
    }));
    const { puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const service = new HbuJwTermScoresService(
      { ensureAuthenticated },
      { getThisTermScores, getAllPassingScores, getSubitemScoreDetails },
      puppeteer,
    );

    await service.queryTermScores(identity());

    expect(getNavigatedHtml()).toContain('尚未录入');
    expect(getNavigatedHtml()).not.toContain('已录入0');
  });

  it('queries anonymous term scores without loading all passing scores', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: cookieJar(),
    }));
    const getThisTermScores = vi.fn(async () => [
      thisTermScoreRow({
        avgcj: '88.2',
        rank: '3/78',
      }),
      thisTermScoreRow({
        id: {
          courseNumber: '2023S01004',
          executiveEducationPlanNumber: '2025-2026-2-2',
          examtime: '20260620',
          studentNumber: '20231202051',
        },
        courseName: '暂存课程',
        courseScore: '84',
        inputStatusCode: '04',
        inputStatusExplain: '暂存',
      }),
    ]);
    const getAllPassingScores = vi.fn();
    const getSubitemScoreDetails = vi.fn(async () => ({
      params: { zxjxjhh: '2025-2026-2-2', kch: '2023S01004', kxh: '01', kssj: '20260620', kcsxdm: '001' },
      message: '',
      rows: [
        { id: { studentNumber: '20231202051', scoreTypeCode: '001' }, zcj: 84 },
      ],
    }));
    const { puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const service = new HbuJwTermScoresService(
      { ensureAuthenticated },
      { getThisTermScores, getAllPassingScores, getSubitemScoreDetails },
      puppeteer,
    );

    const reply = await service.queryTermScores(identity(), 'anonymous');

    expect(extractAtIds(reply)).toEqual(['1405359129']);
    expect(renderMessageContent(reply)).toContain('image/png');
    expect(getThisTermScores).toHaveBeenCalledWith(cookieJar());
    expect(getAllPassingScores).not.toHaveBeenCalled();
    expect(getSubitemScoreDetails).toHaveBeenCalledTimes(1);
    expect(getNavigatedHtml()).toContain('已录入1');
    expect(getNavigatedHtml()).toContain('<td class="score-col muted">*</td>');
    expect(getNavigatedHtml()).toContain('<td class="point-col muted">*</td>');
    expect(getNavigatedHtml()).toContain('<td class="avg-col num">88.2</td>');
    expect(getNavigatedHtml()).toContain('<td class="rank-col muted">*</td>');
    expect(getNavigatedHtml()).toContain('<td class="delta-col gpa-delta gpa-anonymous">*</td>');
  });

  it('surfaces binding requirements before querying term scores', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'needs_binding' as const,
      reason: '请先发送“教务绑定”。',
    }));
    const getThisTermScores = vi.fn();
    const getAllPassingScores = vi.fn();
    const getSubitemScoreDetails = vi.fn();
    const { puppeteer } = createPuppeteerHarness();
    const service = new HbuJwTermScoresService(
      { ensureAuthenticated },
      { getThisTermScores, getAllPassingScores, getSubitemScoreDetails },
      puppeteer,
    );

    await expect(service.queryTermScores(identity())).rejects.toThrow('请先发送“教务绑定”。');
    expect(getThisTermScores).not.toHaveBeenCalled();
    expect(getAllPassingScores).not.toHaveBeenCalled();
    expect(getSubitemScoreDetails).not.toHaveBeenCalled();
  });
});

describe('hbu-jw exam schedule module', () => {
  it('builds a compact exam table view from fullcalendar events', () => {
    const view = buildHbuJwExamScheduleView([
      examPlanEvent({
        title: '数字图像处理\n09:30-11:00\n七一路校区\n七一路校区A6座\n201\n',
        start: '2026-07-07',
        color: '#6fb3e0',
      }),
      examPlanEvent(),
      examPlanEvent({
        title: '编译原理\n09:30-11:00\n七一路校区\n七一路校区A5座\n101\n',
        start: '2026-07-02',
      }),
    ], new Date('2026-07-01T12:00:00+08:00'));

    expect(view.subtitle).toBe('2025-2026 春 · 共 3 场考试');
    expect(view.nearestExamDateText).toBe('07-02');
    expect(view.totalCount).toBe(3);
    expect(view.upcomingCount).toBe(2);
    expect(view.rows.map((row) => [row.courseName, row.dateText, row.locationText, row.countdownText])).toEqual([
      ['软件工程', '06-29 周一', '七一路校区 A5座 101', '已结束'],
      ['编译原理', '07-02 周四', '七一路校区 A5座 101', '明天'],
      ['数字图像处理', '07-07 周二', '七一路校区 A6座 201', '6 天'],
    ]);
  });

  it('renders the exam schedule view as a PNG image with the core table in the HTML', async () => {
    const { page, puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const image = await renderHbuJwExamScheduleImage(
      puppeteer,
      buildHbuJwExamScheduleView([
        examPlanEvent(),
        examPlanEvent({
          title: '网络安全基础\n09:30-11:00\n七一路校区\n七一路校区A5座\n201\n',
          start: '2026-07-03',
        }),
      ], new Date('2026-07-01T12:00:00+08:00')),
    );

    expect(String(image)).toContain('image/png');
    expect(getNavigatedHtml()).toContain('河北大学考试安排');
    expect(getNavigatedHtml()).toContain('软件工程');
    expect(getNavigatedHtml()).toContain('网络安全基础');
    expect(getNavigatedHtml()).toContain('<table>');
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'png' }));
  });

  it('uses the authenticated session to query and render exam schedule', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: cookieJar(),
    }));
    const getExamSchedule = vi.fn(async () => [examPlanEvent()]);
    const { puppeteer } = createPuppeteerHarness();
    const service = new HbuJwExamScheduleService(
      { ensureAuthenticated },
      { getExamSchedule },
      puppeteer,
      () => new Date('2026-07-01T12:00:00+08:00'),
    );

    const reply = await service.queryExamSchedule(identity());

    expect(extractAtIds(reply)).toEqual(['1405359129']);
    expect(renderMessageContent(reply)).toContain('image/png');
    expect(ensureAuthenticated).toHaveBeenCalledWith(identity());
    expect(getExamSchedule).toHaveBeenCalledWith(cookieJar());
  });

  it('surfaces binding requirements before querying exam schedule', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'needs_binding' as const,
      reason: '请先发送“教务绑定”。',
    }));
    const getExamSchedule = vi.fn();
    const { puppeteer } = createPuppeteerHarness();
    const service = new HbuJwExamScheduleService({ ensureAuthenticated }, { getExamSchedule }, puppeteer);

    await expect(service.queryExamSchedule(identity())).rejects.toThrow('请先发送“教务绑定”。');
    expect(getExamSchedule).not.toHaveBeenCalled();
  });
});

describe('hbu-jw schedule module', () => {
  it('calculates teaching weeks from explicit HBU academic calendars', () => {
    expect(calculateTeachingWeek('2025-2026-2-2', Date.UTC(2026, 2, 1))).toBe(1);
    expect(calculateTeachingWeek('2025-2026-2-2', Date.UTC(2026, 2, 8))).toBe(1);
    expect(calculateTeachingWeek('2025-2026-2-2', Date.UTC(2026, 2, 9))).toBe(2);
    expect(calculateTeachingWeek('2025-2026-2-2', Date.UTC(2026, 2, 15))).toBe(2);
    expect(calculateTeachingWeek('2025-2026-2-2', Date.UTC(2026, 2, 16))).toBe(3);
    expect(calculateTeachingWeek('2025-2026-1-1', Date.UTC(2025, 8, 7))).toBe(1);
    expect(calculateTeachingWeek('2025-2026-1-1', Date.UTC(2025, 8, 8))).toBe(1);
    expect(calculateTeachingWeek('2025-2026-1-1', Date.UTC(2025, 8, 14))).toBe(1);
    expect(calculateTeachingWeek('2025-2026-1-1', Date.UTC(2025, 8, 15))).toBe(2);
  });

  it('rejects unsupported academic calendars instead of guessing term starts', () => {
    expect(() => calculateTeachingWeek('2027-2028-1-1', Date.UTC(2027, 8, 1))).toThrow(HbuJwUserError);
    expect(() => calculateTeachingWeek('2027-2028-1-1', Date.UTC(2027, 8, 1))).toThrow(
      '暂未收录 2027-2028 秋 学期校历，无法计算当前教学周。',
    );
  });

  it('filters current-week slots while complete schedule keeps every arranged slot', () => {
    const current = buildHbuJwScheduleView(thisSemesterSchedule(), 'current-week', Date.UTC(2026, 2, 15));
    const complete = buildHbuJwScheduleView(thisSemesterSchedule(), 'full-semester', Date.UTC(2026, 2, 15));

    expect(current.currentWeek).toBe(2);
    expect(current.weekRangeText).toBe('2026-03-09 ~ 2026-03-15');
    expect(current.cells.flatMap((cell) => cell.entries.map((entry) => entry.courseName))).toEqual(['软件工程_01', '软件工程_01']);
    expect(current.renderedCourseCount).toBe(1);
    expect(current.unarrangedCourseCount).toBe(1);
    expect(complete.cells.flatMap((cell) => cell.entries.map((entry) => entry.courseName))).toEqual(['软件工程_01', '软件工程_01', '编译原理_01']);
    expect(complete.renderedCourseCount).toBe(2);
  });

  it('renders crowded cells as frame-selected color blocks without static merged lists', () => {
    const view = buildHbuJwScheduleView(crowdedSemesterSchedule(), 'full-semester', Date.UTC(2026, 2, 15));

    expect(view.cells).toHaveLength(1);
    expect(view.cells[0]).toEqual(expect.objectContaining({
      kind: 'conflict',
      classDay: 1,
      startSection: 3,
      continuingSession: 2,
      sectionText: '3-4节',
    }));
    expect(view.cells[0]?.entries.map((entry) => entry.courseName)).toEqual(['模式识别与机器学习_02', '数字图像处理实验_01']);

    const firstFrame = renderHbuJwScheduleHtml(view, { animationFrameIndex: 0 });
    const secondFrame = renderHbuJwScheduleHtml(view, { animationFrameIndex: 1 });

    expect(firstFrame).toContain('模式识别与机器学习_02');
    expect(firstFrame).not.toContain('数字图像处理实验_01');
    expect(firstFrame).not.toContain('1/2');
    expect(firstFrame).not.toContain('course-badge');
    expect(firstFrame).not.toContain('course-frame');
    expect(firstFrame).not.toContain('course-entry-index');
    expect(firstFrame).not.toContain('course-merged');
    expect(secondFrame).toContain('数字图像处理实验_01');
    expect(secondFrame).not.toContain('模式识别与机器学习_02');
    expect(secondFrame).not.toContain('2/2');
    expect(secondFrame).not.toContain('course-badge');
    expect(secondFrame).not.toContain('course-frame');
  });

  it('calculates gif frame periods for mixed crowded cells', () => {
    const view = buildHbuJwScheduleView(mixedCrowdedSemesterSchedule(), 'full-semester', Date.UTC(2026, 2, 15));

    expect(view.cells.map((cell) => cell.entries.length).filter((count) => count > 1)).toEqual([2, 3]);
    expect(calculateHbuJwScheduleGifFrameCount(view)).toBe(6);
  });

  it('renders the schedule view as a PNG image with course details in the HTML', async () => {
    const { page, puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const image = await renderHbuJwScheduleImage(
      puppeteer,
      buildHbuJwScheduleView(thisSemesterSchedule(), 'current-week', Date.UTC(2026, 2, 15)),
    );

    expect(String(image)).toContain('image/png');
    expect(getNavigatedHtml()).toContain('河北大学课表 · 第 2 周');
    expect(getNavigatedHtml()).toContain('软件工程_01');
    expect(getNavigatedHtml()).toContain('七一路校区A5座312');
    expect(getNavigatedHtml()).toContain('未安排课程');
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'png' }));
  });

  it('renders the full-semester schedule as a GIF image', async () => {
    const { page, puppeteer } = createPuppeteerHarness();
    const image = await renderHbuJwScheduleImage(
      puppeteer,
      buildHbuJwScheduleView(crowdedSemesterSchedule(), 'full-semester', Date.UTC(2026, 2, 15)),
      'gif',
    );

    expect(String(image)).toContain('image/gif');
    expect(page.screenshot).toHaveBeenCalledTimes(2);
  });

  it('uses the authenticated session to query and render schedules', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: cookieJar(),
    }));
    const getThisSemesterSchedule = vi.fn(async () => thisSemesterSchedule());
    const { puppeteer } = createPuppeteerHarness();
    const service = new HbuJwScheduleService(
      { ensureAuthenticated },
      { getThisSemesterSchedule },
      puppeteer,
      () => Date.UTC(2026, 2, 15),
    );

    const reply = await service.querySchedule(identity(), 'full-semester');

    expect(extractAtIds(reply)).toEqual(['1405359129']);
    expect(renderMessageContent(reply)).toContain('image/gif');
    expect(ensureAuthenticated).toHaveBeenCalledWith(identity());
    expect(getThisSemesterSchedule).toHaveBeenCalledWith(cookieJar());
  });

  it('surfaces binding requirements before querying schedules', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'needs_binding' as const,
      reason: '请先发送“教务绑定”。',
    }));
    const getThisSemesterSchedule = vi.fn();
    const { puppeteer } = createPuppeteerHarness();
    const service = new HbuJwScheduleService({ ensureAuthenticated }, { getThisSemesterSchedule }, puppeteer);

    await expect(service.querySchedule(identity(), 'current-week')).rejects.toThrow('请先发送“教务绑定”。');
    expect(getThisSemesterSchedule).not.toHaveBeenCalled();
  });
});

describe('hbu-jw course query module', () => {
  const terms = [
    { code: '2026-2027-1-2', label: '2026-2027学年秋(三学期)', selected: false },
    { code: '2025-2026-2-2', label: '2025-2026学年春(三学期)', selected: true },
    { code: '2025-2026-1-2', label: '2025-2026学年秋(三学期)', selected: false },
  ];

  it('renders a concise help image for the bare command', async () => {
    const { puppeteer, getNavigatedHtml } = createPuppeteerHarness();

    const image = await renderHbuJwCourseQueryHelpImage(puppeteer);

    expect(String(image)).toContain('image/png');
    expect(getNavigatedHtml()).toContain('课程查询');
    expect(getNavigatedHtml()).toContain('课程查询 &lt;课程&gt; [学期]');
    expect(getNavigatedHtml()).toContain('课程查询 模式识别');
    expect(getNavigatedHtml()).toContain('0 是本学期');
  });

  it('resolves term offsets from the selected term in the academic term list', () => {
    expect(resolveCourseQueryTerm(terms, '0').code).toBe('2025-2026-2-2');
    expect(resolveCourseQueryTerm(terms, '-1').code).toBe('2025-2026-1-2');
    expect(resolveCourseQueryTerm(terms, '2025-2026-2-2').code).toBe('2025-2026-2-2');
    expect(() => resolveCourseQueryTerm(terms, '-2')).toThrow('没有偏移 -2');
    expect(() => resolveCourseQueryTerm(terms, '1')).toThrow('只支持 0 或负数');
  });

  it('matches course numbers exactly before course name fuzzy matches', () => {
    const candidates = [
      {
        courseName: '模式识别与机器学习',
        courseNumber: '2023S01105',
        sequenceNumber: '02',
        propertyName: '任选',
        termCode: '2025-2026-2-2',
        termLabel: '2025-2026学年春(三学期)',
        params: { zxjxjhh: '2025-2026-2-2', kch: '2023S01105', kxh: '02', kssj: '20260620', kcsxdm: '003' },
      },
      {
        courseName: '模式识别与机器学习实验',
        courseNumber: '2023S01106',
        sequenceNumber: '02',
        propertyName: '任选',
        termCode: '2025-2026-2-2',
        termLabel: '2025-2026学年春(三学期)',
        params: { zxjxjhh: '2025-2026-2-2', kch: '2023S01106', kxh: '02', kssj: '20260620', kcsxdm: '003' },
      },
    ];
    const prefixCandidates = [
      {
        courseName: 'AB',
        courseNumber: 'A001',
        sequenceNumber: '01',
        propertyName: '必修',
        termCode: '2025-2026-2-2',
        termLabel: '2025-2026学年春(三学期)',
        params: { zxjxjhh: '2025-2026-2-2', kch: 'A001', kxh: '01', kssj: '20260620', kcsxdm: '001' },
      },
      {
        courseName: 'ABC',
        courseNumber: 'A002',
        sequenceNumber: '01',
        propertyName: '必修',
        termCode: '2025-2026-2-2',
        termLabel: '2025-2026学年春(三学期)',
        params: { zxjxjhh: '2025-2026-2-2', kch: 'A002', kxh: '01', kssj: '20260620', kcsxdm: '001' },
      },
    ];

    expect(matchCourseCandidates(candidates, '2023S01105').map((course) => course.courseName)).toEqual(['模式识别与机器学习']);
    expect(matchCourseCandidates(candidates, '模式识别').map((course) => course.courseName)).toEqual(['模式识别与机器学习']);
    expect(matchCourseCandidates(prefixCandidates, 'A').map((course) => course.courseName)).toEqual(['AB']);
    expect(matchCourseCandidates(prefixCandidates, 'AB').map((course) => course.courseName)).toEqual(['AB']);
  });

  it('uses the authenticated session to query and render one course detail list', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: cookieJar(),
    }));
    const getSubitemScoreTerms = vi.fn(async () => terms);
    const getThisTermScores = vi.fn(async () => [
      thisTermScoreRow({
        id: {
          courseNumber: '2023S01105',
          executiveEducationPlanNumber: '2025-2026-2-2',
          examtime: '20260620',
          studentNumber: '20231202051',
        },
        coureSequenceNumber: '02',
        courseName: '模式识别与机器学习',
        coursePropertyCode: '003',
        coursePropertyName: '任选',
      }),
    ]);
    const getAllPassingScores = vi.fn(async () => []);
    const getSubitemScoreDetails = vi.fn(async () => ({
      params: { zxjxjhh: '2025-2026-2-2', kch: '2023S01105', kxh: '02', kssj: '20260620', kcsxdm: '003' },
      message: '',
      rows: [
        { id: { studentNumber: '20221202009', scoreTypeCode: '001' }, pscj: 68, qzcj: null, qmcj: 0, zcj: 27.2, remark: '2026-04-28' },
        { id: { studentNumber: '20221202010', scoreTypeCode: '002' }, pscj: null, qzcj: null, qmcj: null, zcj: null, remark: '2026-04-28' },
        { id: { studentNumber: '20221202011', scoreTypeCode: '003' }, pscj: null, qzcj: null, qmcj: null, zcj: null, remark: '2026-04-28' },
      ],
    }));
    const { puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const service = new HbuJwCourseQueryService(
      { ensureAuthenticated },
      { getSubitemScoreTerms, getThisTermScores, getAllPassingScores, getSubitemScoreDetails },
      puppeteer,
    );

    const reply = await service.queryCourse(identity(), { courseQuery: '模式识别' });

    expect(extractAtIds(reply)).toEqual(['1405359129']);
    expect(renderMessageContent(reply)).toContain('image/png');
    expect(getThisTermScores).toHaveBeenCalledWith(cookieJar());
    expect(getAllPassingScores).not.toHaveBeenCalled();
    expect(getSubitemScoreDetails).toHaveBeenCalledWith(
      cookieJar(),
      { zxjxjhh: '2025-2026-2-2', kch: '2023S01105', kxh: '02', kssj: '20260620', kcsxdm: '003' },
    );
    expect(getNavigatedHtml()).toContain('模式识别与机器学习');
    expect(getNavigatedHtml()).toContain('20221202009');
    expect(getNavigatedHtml()).toContain('27.2');
    expect(getNavigatedHtml()).toContain('<th class="type-col">类型</th>');
    expect(getNavigatedHtml()).toContain('001');
    expect(getNavigatedHtml()).not.toContain('20221202010');
    expect(getNavigatedHtml()).not.toContain('20221202011');
  });

  it('renders the score type that contains recorded score values', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: cookieJar(),
    }));
    const getSubitemScoreTerms = vi.fn(async () => terms);
    const getThisTermScores = vi.fn(async () => [
      thisTermScoreRow({
        id: {
          courseNumber: '2023S01006',
          executiveEducationPlanNumber: '2025-2026-2-2',
          examtime: '20260620',
          studentNumber: '20231202051',
        },
        coureSequenceNumber: '01',
        courseName: '硬件系统开发实训',
        coursePropertyCode: '001',
        coursePropertyName: '必修',
      }),
    ]);
    const getAllPassingScores = vi.fn(async () => []);
    const getSubitemScoreDetails = vi.fn(async () => ({
      params: { zxjxjhh: '2025-2026-2-2', kch: '2023S01006', kxh: '01', kssj: '20260620', kcsxdm: '001' },
      message: '',
      rows: [
        { id: { studentNumber: '20231202009', scoreTypeCode: '001' }, pscj: null, qzcj: null, qmcj: null, zcj: null, remark: '2026-04-28' },
        { id: { studentNumber: '20231202010', scoreTypeCode: '002' }, pscj: 94, qzcj: null, qmcj: null, zcj: 94, remark: '2026-04-28' },
        { id: { studentNumber: '20231202011', scoreTypeCode: '003' }, pscj: null, qzcj: null, qmcj: null, zcj: null, remark: '2026-04-28' },
      ],
    }));
    const { puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const service = new HbuJwCourseQueryService(
      { ensureAuthenticated },
      { getSubitemScoreTerms, getThisTermScores, getAllPassingScores, getSubitemScoreDetails },
      puppeteer,
    );

    await service.queryCourse(identity(), { courseQuery: '硬件系统开发实训' });

    expect(getNavigatedHtml()).toContain('硬件系统开发实训');
    expect(getNavigatedHtml()).toContain('类型 002');
    expect(getNavigatedHtml()).toContain('20231202010');
    expect(getNavigatedHtml()).toContain('94');
    expect(getNavigatedHtml()).not.toContain('20231202009');
    expect(getNavigatedHtml()).not.toContain('20231202011');
  });

  it('loads historical candidates from all passing scores when a previous term is selected', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: cookieJar(),
    }));
    const getSubitemScoreTerms = vi.fn(async () => terms);
    const getThisTermScores = vi.fn();
    const getAllPassingScores = vi.fn(async () => [
      scoreRow({
        id: {
          courseNumber: '2023D00003',
          executiveEducationPlanNumber: '2025-2026-1-2',
          coureSequenceNumber: '01',
          startTime: '20260105',
        },
        courseName: '程序设计',
        courseAttributeCode: '001',
        courseAttributeName: '必修',
        examTime: '20260105',
        xkcsxdm: '001',
      }),
    ]);
    const getSubitemScoreDetails = vi.fn(async () => ({
      params: { zxjxjhh: '2025-2026-1-2', kch: '2023D00003', kxh: '01', kssj: '20260105', kcsxdm: '001' },
      message: '',
      rows: [],
    }));
    const { puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const service = new HbuJwCourseQueryService(
      { ensureAuthenticated },
      { getSubitemScoreTerms, getThisTermScores, getAllPassingScores, getSubitemScoreDetails },
      puppeteer,
    );

    await service.queryCourse(identity(), { courseQuery: '程序设计', termInput: '-1' });

    expect(getThisTermScores).not.toHaveBeenCalled();
    expect(getAllPassingScores).toHaveBeenCalledWith(cookieJar());
    expect(getSubitemScoreDetails).toHaveBeenCalledWith(
      cookieJar(),
      { zxjxjhh: '2025-2026-1-2', kch: '2023D00003', kxh: '01', kssj: '20260105', kcsxdm: '001' },
    );
    expect(getNavigatedHtml()).toContain('接口返回 0 条分项成绩');
  });

  it('renders a clear empty-score message when detail rows have no score values', () => {
    const pages = buildHbuJwCourseQueryResultViews({
      courseName: '硬件系统开发实训',
      courseNumber: '2023S01006',
      sequenceNumber: '01',
      propertyName: '必修',
      termCode: '2025-2026-2-2',
      termLabel: '2025-2026学年春(三学期)',
      params: { zxjxjhh: '2025-2026-2-2', kch: '2023S01006', kxh: '01', kssj: '20260620', kcsxdm: '001' },
    }, [
      { id: { studentNumber: '20231202009', scoreTypeCode: '001' }, pscj: null, qzcj: null, qmcj: null, zcj: null },
      { id: { studentNumber: '20231202010', scoreTypeCode: '002' }, pscj: null, qzcj: null, qmcj: null, zcj: null },
    ]);

    expect(renderHbuJwCourseQueryResultHtml(pages[0]!)).toContain('接口返回 2 条记录，但成绩字段为空');
  });

  it('sorts course query detail rows by student number before rendering', () => {
    const pages = buildHbuJwCourseQueryResultViews({
      courseName: '硬件系统开发实训',
      courseNumber: '2023S01006',
      sequenceNumber: '01',
      propertyName: '必修',
      termCode: '2025-2026-2-2',
      termLabel: '2025-2026学年春(三学期)',
      params: { zxjxjhh: '2025-2026-2-2', kch: '2023S01006', kxh: '01', kssj: '20260620', kcsxdm: '001' },
    }, [
      { id: { studentNumber: '20231202012', scoreTypeCode: '002' }, pscj: 93, qzcj: null, qmcj: null, zcj: 93 },
      { id: { studentNumber: '20231202010', scoreTypeCode: '002' }, pscj: 94, qzcj: null, qmcj: null, zcj: 94 },
      { id: { studentNumber: '', scoreTypeCode: '002' }, pscj: 91, qzcj: null, qmcj: null, zcj: 91 },
      { id: { studentNumber: '20231202011', scoreTypeCode: '002' }, pscj: 92, qzcj: null, qmcj: null, zcj: 92 },
    ]);

    expect(pages[0]?.rows.map((row) => row.studentNumber)).toEqual([
      '20231202010',
      '20231202011',
      '20231202012',
      '—',
    ]);
  });

  it('renders course query result pages with at most one hundred rows each', () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      id: { studentNumber: `20231202${String(index).padStart(3, '0')}`, scoreTypeCode: '001' },
      pscj: 80,
      qzcj: null,
      qmcj: 70,
      zcj: 74,
      remark: '2026-04-28',
    }));
    const pages = buildHbuJwCourseQueryResultViews({
      courseName: '模式识别与机器学习',
      courseNumber: '2023S01105',
      sequenceNumber: '02',
      propertyName: '任选',
      termCode: '2025-2026-2-2',
      termLabel: '2025-2026学年春(三学期)',
      params: { zxjxjhh: '2025-2026-2-2', kch: '2023S01105', kxh: '02', kssj: '20260620', kcsxdm: '003' },
    }, rows);

    expect(pages).toHaveLength(2);
    expect(pages[0]?.rows).toHaveLength(100);
    expect(pages[1]?.rows).toHaveLength(1);
    expect(renderHbuJwCourseQueryResultHtml(pages[1]!)).toContain('2/2');
  });
});

describe('hbu-jw http client', () => {
  it('routes every account through one broker with isolated JW cookies', async () => {
    const directFetch = vi.fn(async () => {
      throw new Error('direct transport must not be used when the broker is configured');
    });
    const accounts = ['20231202051', '20231202052'];
    const token = Buffer.alloc(32, 7);
    let loginSequence = 0;
    const indexCookies: string[][] = [];
    const brokerFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization');
      expect(authorization).toBe(`Bearer ${token.toString('base64url')}`);

      const request = JSON.parse(String(init?.body)) as {
        targetUrl: string;
        method: string;
        cookies: Array<{ name: string; value: string }>;
        bodyBase64?: string;
      };
      expect(request).not.toHaveProperty('account');
      const target = new URL(request.targetUrl);
      const response = (status: number, body: string, headers: Record<string, string> = {}, setCookies: string[] = []) => new Response(JSON.stringify({
        ok: true,
        status,
        headers,
        setCookies,
        bodyBase64: Buffer.from(body).toString('base64'),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

      if (target.pathname === '/login') {
        loginSequence += 1;
        return response(200, '<form action="/sigin"><input name="password"></form>', {}, [`JSESSIONID=login-${loginSequence}; Path=/`]);
      }
      if (target.pathname === '/sigin') {
        const form = new URLSearchParams(Buffer.from(request.bodyBase64 ?? '', 'base64').toString());
        const username = form.get('username');
        expect(accounts).toContain(username);
        expect(form.get('password')).toBe(accounts.indexOf(username ?? '') === 0 ? 'password-a' : 'password-b');
        expect(request.cookies).toEqual([{ name: 'JSESSIONID', value: `login-${accounts.indexOf(username ?? '') + 1}` }]);
        return response(302, '', { location: 'https://zhjw.hbu.cn/index' }, [`JSESSIONID=session-${username}; Path=/`]);
      }
      if (target.pathname === '/index') {
        indexCookies.push(request.cookies.map((cookie) => `${cookie.name}=${cookie.value}`));
        return response(200, '<html><body>URP综合教务系统首页</body></html>');
      }
      return response(404, 'missing');
    });
    const client = new HbuJwHttpClient({
      fetchImpl: directFetch as never,
      webVpnBroker: {
        url: 'http://127.0.0.1:8789',
        token,
        fetchImpl: brokerFetch as never,
      },
    });

    expect(client.prepareSession({
      cookies: [
        { name: 'webvpn_session', value: 'obsolete' },
        { name: 'JSESSIONID', value: 'obsolete' },
      ],
    })).toEqual({
      version: 1,
      transport: 'broker',
      cookies: [],
    });

    const firstLogin = await client.login(accounts[0]!, 'password-a');
    const secondLogin = await client.login(accounts[1]!, 'password-b');

    expect(firstLogin.cookieJar).toEqual({
      version: 1,
      transport: 'broker',
      cookies: [{ name: 'JSESSIONID', value: `session-${accounts[0]}` }],
    });
    expect(secondLogin.cookieJar).toEqual({
      version: 1,
      transport: 'broker',
      cookies: [{ name: 'JSESSIONID', value: `session-${accounts[1]}` }],
    });
    await expect(client.validate(firstLogin.cookieJar)).resolves.toBe(true);
    await expect(client.validate(secondLogin.cookieJar)).resolves.toBe(true);
    expect(directFetch).not.toHaveBeenCalled();
    expect(indexCookies).toEqual([
      [`JSESSIONID=session-${accounts[0]}`],
      [`JSESSIONID=session-${accounts[1]}`],
      [`JSESSIONID=session-${accounts[0]}`],
      [`JSESSIONID=session-${accounts[1]}`],
    ]);
    expect(brokerFetch).toHaveBeenCalledTimes(8);
  });

  it('rejects cross-origin redirects before sending cookies to the redirected target', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://zhjw.hbu.cn/login') {
        return new Response('<form action="/sigin"><input name="password"></form>', {
          status: 200,
          headers: { 'set-cookie': 'JSESSIONID=abc; Path=/' },
        });
      }
      if (url === 'https://zhjw.hbu.cn/sigin') {
        return new Response('', {
          status: 302,
          headers: { location: 'https://example.com/steal' },
        });
      }
      return new Response('', { status: 500 });
    });
    const client = new HbuJwHttpClient({ fetchImpl: fetchImpl as never });

    await expect(client.login('student', 'password')).rejects.toThrow('非预期跨域');
    expect(fetchImpl.mock.calls.map((call) => call[0])).not.toContain('https://example.com/steal');
  });

  it('logs into WebVPN before submitting the original jw login form', async () => {
    const resourcePrefix = '/http/77726476706e69737468656265737421eaff4b8b69386a45300b87';
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://zhjw.hbu.cn/login') {
        return new Response('', {
          status: 302,
          headers: { location: `https://v.hbu.cn${resourcePrefix}/login` },
        });
      }
      if (url === `https://v.hbu.edu.cn${resourcePrefix}/login`) {
        if (String((init?.headers as Record<string, string> | undefined)?.cookie ?? '').includes('webvpn_session=active')) {
          return new Response('<form action="/sigin"><input name="password"></form>', {
            status: 200,
            headers: { 'set-cookie': 'JSESSIONID=jw-session; Path=/' },
          });
        }
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://v.hbu.cn/login',
            'set-cookie': 'wengine_vpn_ticketv_hbu_cn=ticket; Path=/',
          },
        });
      }
      if (url === 'https://v.hbu.edu.cn/login') {
        return new Response([
          '<html><body>WEBVPN资源访问系统',
          '<form id="form">',
          '<input name="_csrf" value="csrf-token">',
          '<input name="auth_type" value="local">',
          '<input name="needCaptcha" value="false">',
          '<input name="captcha_id" value="captcha-id">',
          '</form>',
          '<script>$.post("/do-login")</script>',
          '</body></html>',
        ].join(''), { status: 200 });
      }
      if (url === 'https://v.hbu.edu.cn/do-login') {
        const body = init?.body as URLSearchParams;
        expect(body.get('_csrf')).toBe('csrf-token');
        expect(body.get('username')).toBe('student');
        expect(body.get('password')).toBe('77726476706e6973617765736f6d6521f669c8738c549c2e');
        expect(init?.headers).toMatchObject({
          host: 'v.hbu.cn',
          origin: 'https://v.hbu.cn',
        });
        return new Response(JSON.stringify({ success: true, url: `${resourcePrefix}/login` }), {
          status: 200,
          headers: { 'set-cookie': 'webvpn_session=active; Path=/' },
        });
      }
      if (url === `https://v.hbu.edu.cn${resourcePrefix}/sigin`) {
        expect(init?.headers).toMatchObject({
          host: 'v.hbu.cn',
          origin: 'https://v.hbu.cn',
          referer: `https://v.hbu.cn${resourcePrefix}/login`,
        });
        return new Response('', {
          status: 302,
          headers: { location: 'https://zhjw.hbu.cn/index' },
        });
      }
      if (url === `https://v.hbu.edu.cn${resourcePrefix}/index`) {
        return new Response('<html><body>URP综合教务系统首页</body></html>', { status: 200 });
      }
      return new Response('', { status: 500 });
    });
    const client = new HbuJwHttpClient({ fetchImpl: fetchImpl as never });

    await expect(client.login('student', 'password')).resolves.toEqual({
      cookieJar: {
        version: 1,
        transport: 'direct',
        cookies: [
          { name: 'wengine_vpn_ticketv_hbu_cn', value: 'ticket' },
          { name: 'webvpn_session', value: 'active' },
          { name: 'JSESSIONID', value: 'jw-session' },
        ],
      },
    });
    expect(fetchImpl.mock.calls.map((call) => call[0])).not.toContain('https://zhjw.hbu.cn/sigin');
  });

  it('reports WebVPN credential rejection precisely', async () => {
    const resourcePrefix = '/http/77726476706e69737468656265737421eaff4b8b69386a45300b87';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://zhjw.hbu.cn/login') {
        return new Response('', { status: 302, headers: { location: `https://v.hbu.cn${resourcePrefix}/login` } });
      }
      if (url === `https://v.hbu.edu.cn${resourcePrefix}/login`) {
        return new Response('', { status: 302, headers: { location: 'https://v.hbu.cn/login' } });
      }
      if (url === 'https://v.hbu.edu.cn/login') {
        return new Response('<form id="form"><input name="_csrf" value="csrf"><input name="auth_type" value="local"></form><script>$.post("/do-login")</script>', { status: 200 });
      }
      if (url === 'https://v.hbu.edu.cn/do-login') {
        return new Response(JSON.stringify({ success: false, error: 'INVALID_ACCOUNT', message: '账号或密码错误' }), { status: 200 });
      }
      return new Response('', { status: 500 });
    });
    const client = new HbuJwHttpClient({ fetchImpl: fetchImpl as never });

    await expect(client.login('student', 'password')).rejects.toMatchObject({
      code: 'webvpn_invalid_account',
      category: 'credential',
      message: '河北大学 WebVPN 拒绝了账号或密码，请确认统一认证密码后重新绑定。',
    });
  });

  it('extracts clear login failure messages from the jw login page', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://zhjw.hbu.cn/login') {
        return new Response('<form action="/sigin"><input name="password"></form>', {
          status: 200,
          headers: { 'set-cookie': 'JSESSIONID=abc; Path=/' },
        });
      }
      if (url === 'https://zhjw.hbu.cn/sigin') {
        return new Response('<html><body><div>账号不存在</div><form action="/sigin"><input name="password"></form></body></html>', { status: 200 });
      }
      return new Response('', { status: 500 });
    });
    const client = new HbuJwHttpClient({ fetchImpl: fetchImpl as never });

    await expect(client.login('student', 'password')).rejects.toThrow('账号不存在');
  });

  it('loads all passing scores from the dynamic callback endpoint', async () => {
    const rows = [scoreRow({ id: { courseNumber: '2023D00003' }, courseName: '程序设计' })];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://zhjw.hbu.cn/student/integratedQuery/scoreQuery/allPassingScores/index') {
        return new Response('<script>const url = "/student/integratedQuery/scoreQuery/token/allPassingScores/callback";</script>', { status: 200 });
      }
      if (url === 'https://zhjw.hbu.cn/student/integratedQuery/scoreQuery/token/allPassingScores/callback') {
        return new Response(JSON.stringify(allPassingScoresPayload(rows)), { status: 200 });
      }
      return new Response('', { status: 500 });
    });
    const client = new HbuJwHttpClient({ fetchImpl: fetchImpl as never });

    await expect(client.getAllPassingScores(cookieJar())).resolves.toEqual(rows);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      'https://zhjw.hbu.cn/student/integratedQuery/scoreQuery/allPassingScores/index',
      'https://zhjw.hbu.cn/student/integratedQuery/scoreQuery/token/allPassingScores/callback',
    ]);
  });

  it('rejects ambiguous score callback pages and malformed payloads', async () => {
    const ambiguousFetch = vi.fn(async () => new Response([
      '"/student/integratedQuery/scoreQuery/a/allPassingScores/callback"',
      '"/student/integratedQuery/scoreQuery/b/allPassingScores/callback"',
    ].join('\n'), { status: 200 }));
    const ambiguousClient = new HbuJwHttpClient({ fetchImpl: ambiguousFetch as never });
    await expect(ambiguousClient.getAllPassingScores(cookieJar(null))).rejects.toThrow('没有唯一的回调地址');

    const malformedFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/allPassingScores/index')) {
        return new Response('"/student/integratedQuery/scoreQuery/a/allPassingScores/callback"', { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const malformedClient = new HbuJwHttpClient({ fetchImpl: malformedFetch as never });
    await expect(malformedClient.getAllPassingScores(cookieJar(null))).rejects.toThrow('结构异常');
  });

  it('loads this term scores from the dynamic data endpoint', async () => {
    const rows = [thisTermScoreRow({ id: { courseNumber: '2023S01003', executiveEducationPlanNumber: '2025-2026-2-2' } })];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://zhjw.hbu.cn/student/integratedQuery/scoreQuery/thisTermScores/index') {
        return new Response('<script>var url = "/student/integratedQuery/scoreQuery/token/thisTermScores/data";</script>', { status: 200 });
      }
      if (url === 'https://zhjw.hbu.cn/student/integratedQuery/scoreQuery/token/thisTermScores/data') {
        expect(init?.method ?? 'GET').toBe('GET');
        return new Response(JSON.stringify(thisTermScoresPayload(rows)), {
          status: 200,
          headers: { 'content-type': 'application/json;charset=UTF-8' },
        });
      }
      return new Response('', { status: 500 });
    });
    const client = new HbuJwHttpClient({ fetchImpl: fetchImpl as never });

    await expect(client.getThisTermScores(cookieJar())).resolves.toEqual(rows);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      'https://zhjw.hbu.cn/student/integratedQuery/scoreQuery/thisTermScores/index',
      'https://zhjw.hbu.cn/student/integratedQuery/scoreQuery/token/thisTermScores/data',
    ]);
  });

  it('rejects ambiguous term score data pages and malformed term score payloads', async () => {
    const ambiguousFetch = vi.fn(async () => new Response([
      '"/student/integratedQuery/scoreQuery/a/thisTermScores/data"',
      '"/student/integratedQuery/scoreQuery/b/thisTermScores/data"',
    ].join('\n'), { status: 200 }));
    const ambiguousClient = new HbuJwHttpClient({ fetchImpl: ambiguousFetch as never });
    await expect(ambiguousClient.getThisTermScores(cookieJar(null))).rejects.toThrow('没有唯一的数据地址');

    const malformedFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/thisTermScores/index')) {
        return new Response('"/student/integratedQuery/scoreQuery/a/thisTermScores/data"', { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const malformedClient = new HbuJwHttpClient({ fetchImpl: malformedFetch as never });
    await expect(malformedClient.getThisTermScores(cookieJar(null))).rejects.toThrow('结构异常');
  });

  it('loads subitem score terms and details from the fixed look endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://zhjw.hbu.cn/student/integratedQuery/scoreQuery/subitemScore/index') {
        return new Response(`
          <select id="zxjxjhh">
            <option value="2026-2027-1-2">2026-2027学年秋(三学期)</option>
            <option value="2025-2026-2-2" selected>2025-2026学年春(三学期)</option>
          </select>
          <script>url: "/student/integratedQuery/scoreQuery/subitemScore/look"</script>
        `, { status: 200 });
      }
      if (url === 'https://zhjw.hbu.cn/student/integratedQuery/scoreQuery/subitemScore/look') {
        expect(init?.method).toBe('POST');
        expect(String(init?.body ?? '')).toBe('zxjxjhh=2025-2026-2-2&kch=2023S01105&kxh=02&kssj=20260620&kcsxdm=003');
        return new Response(JSON.stringify({
          msg: '',
          scoreDetailList: [
            { id: { studentNumber: '20221202009', scoreTypeCode: '001' }, pscj: 68, qmcj: 0, zcj: 27.2, remark: '2026-04-28' },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' } });
      }
      return new Response('', { status: 500 });
    });
    const client = new HbuJwHttpClient({ fetchImpl: fetchImpl as never });

    await expect(client.getSubitemScoreTerms(cookieJar())).resolves.toEqual([
      { code: '2026-2027-1-2', label: '2026-2027学年秋(三学期)', selected: false },
      { code: '2025-2026-2-2', label: '2025-2026学年春(三学期)', selected: true },
    ]);
    await expect(client.getSubitemScoreDetails(
      cookieJar(),
      { zxjxjhh: '2025-2026-2-2', kch: '2023S01105', kxh: '02', kssj: '20260620', kcsxdm: '003' },
    )).resolves.toMatchObject({
      rows: [
        { id: { studentNumber: '20221202009', scoreTypeCode: '001' }, zcj: 27.2 },
      ],
    });
  });

  it('rejects ambiguous subitem score look pages and malformed look payloads', async () => {
    const params = { zxjxjhh: '2025-2026-2-2', kch: '2023S01004', kxh: '01', kssj: '20260620', kcsxdm: '001' };
    const ambiguousFetch = vi.fn(async () => new Response([
      '"/student/integratedQuery/scoreQuery/subitemScore/a/look"',
      '"/student/integratedQuery/scoreQuery/subitemScore/b/look"',
    ].join('\n'), { status: 200 }));
    const ambiguousClient = new HbuJwHttpClient({ fetchImpl: ambiguousFetch as never });
    await expect(ambiguousClient.getSubitemScoreDetails(cookieJar(null), params)).rejects.toThrow('没有唯一的查看地址');

    const malformedFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/subitemScore/index')) {
        return new Response('"/student/integratedQuery/scoreQuery/subitemScore/a/look"', { status: 200 });
      }
      return new Response('not-json', { status: 200 });
    });
    const malformedClient = new HbuJwHttpClient({ fetchImpl: malformedFetch as never });
    await expect(malformedClient.getSubitemScoreDetails(cookieJar(null), params)).rejects.toThrow('非 JSON');
  });

  it('loads exam schedule from the fullcalendar detail endpoint', async () => {
    const rows = [
      examPlanEvent({
        title: '软件工程\n09:30-11:00\n七一路校区\n七一路校区A5座\n101\n',
        start: '2026-06-29',
      }),
    ];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://zhjw.hbu.cn/student/examinationManagement/examPlan/index') {
        return new Response('<script>events: "/student/examinationManagement/examPlan/detail"</script>', { status: 200 });
      }
      if (url === 'https://zhjw.hbu.cn/student/examinationManagement/examPlan/detail') {
        expect(init?.method ?? 'GET').toBe('GET');
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'content-type': 'application/json;charset=UTF-8' },
        });
      }
      return new Response('', { status: 500 });
    });
    const client = new HbuJwHttpClient({ fetchImpl: fetchImpl as never });

    await expect(client.getExamSchedule(cookieJar())).resolves.toEqual(rows);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      'https://zhjw.hbu.cn/student/examinationManagement/examPlan/index',
      'https://zhjw.hbu.cn/student/examinationManagement/examPlan/detail',
    ]);
  });

  it('rejects ambiguous exam schedule pages and malformed exam payloads', async () => {
    const ambiguousFetch = vi.fn(async () => new Response([
      '"/student/examinationManagement/examPlan/detail"',
      '"/student/examinationManagement/examPlan/detail"',
    ].join('\n'), { status: 200 }));
    const ambiguousClient = new HbuJwHttpClient({ fetchImpl: ambiguousFetch as never });
    await expect(ambiguousClient.getExamSchedule(cookieJar(null))).rejects.toThrow('没有唯一的数据地址');

    const malformedFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/examPlan/index')) {
        return new Response('"/student/examinationManagement/examPlan/detail"', { status: 200 });
      }
      return new Response(JSON.stringify([{ title: '软件工程' }]), { status: 200 });
    });
    const malformedClient = new HbuJwHttpClient({ fetchImpl: malformedFetch as never });
    await expect(malformedClient.getExamSchedule(cookieJar(null))).rejects.toThrow('结构异常');
  });

  it('loads this semester schedule from the dynamic callback endpoint', async () => {
    const payload = thisSemesterSchedulePayload();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://zhjw.hbu.cn/student/courseSelect/thisSemesterCurriculum/index') {
        return new Response('<script>const url = "/student/courseSelect/thisSemesterCurriculum/token/ajaxStudentSchedule/curr/callback";</script>', { status: 200 });
      }
      if (url === 'https://zhjw.hbu.cn/student/courseSelect/thisSemesterCurriculum/token/ajaxStudentSchedule/curr/callback') {
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      return new Response('', { status: 500 });
    });
    const client = new HbuJwHttpClient({ fetchImpl: fetchImpl as never });

    const schedule = await client.getThisSemesterSchedule(cookieJar());

    expect(schedule).toMatchObject({
      executiveEducationPlanNumber: '2025-2026-2-2',
      programPlanName: '2023级计算机科学与技术专业人才培养方案',
      totalUnits: 22.3,
    });
    expect(schedule.courses).toHaveLength(3);
    expect(schedule.courses[0]).toMatchObject({
      courseNumber: '2023S01003',
      sequenceNumber: '01',
      courseName: '软件工程',
      teacherName: '罗文劼*',
    });
    expect(schedule.courses[0]?.timeAndPlaceList[0]).toMatchObject({
      classDay: 1,
      classSessions: 1,
      continuingSession: 2,
      classWeek: '110000000000000000000000',
      weekDescription: '1-2周',
      campusName: '七一路校区',
      teachingBuildingName: 'A5座',
      classroomName: '312',
    });
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      'https://zhjw.hbu.cn/student/courseSelect/thisSemesterCurriculum/index',
      'https://zhjw.hbu.cn/student/courseSelect/thisSemesterCurriculum/token/ajaxStudentSchedule/curr/callback',
    ]);
  });

  it('rejects ambiguous schedule callback pages and malformed schedule payloads', async () => {
    const ambiguousFetch = vi.fn(async () => new Response([
      '"/student/courseSelect/thisSemesterCurriculum/a/ajaxStudentSchedule/curr/callback"',
      '"/student/courseSelect/thisSemesterCurriculum/b/ajaxStudentSchedule/curr/callback"',
    ].join('\n'), { status: 200 }));
    const ambiguousClient = new HbuJwHttpClient({ fetchImpl: ambiguousFetch as never });
    await expect(ambiguousClient.getThisSemesterSchedule(cookieJar(null))).rejects.toThrow('没有唯一的回调地址');

    const malformedFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/thisSemesterCurriculum/index')) {
        return new Response('"/student/courseSelect/thisSemesterCurriculum/a/ajaxStudentSchedule/curr/callback"', { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const malformedClient = new HbuJwHttpClient({ fetchImpl: malformedFetch as never });
    await expect(malformedClient.getThisSemesterSchedule(cookieJar(null))).rejects.toThrow('结构异常');
  });
});

describe('hbu-jw bind page rendering', () => {
  it('renders a clear success page with close-page guidance and the confirm command', () => {
    const html = renderBindPage({
      backgroundImagePath: '/jw/bind/assets/campus-bg.jpg',
      qq: '1405359129',
      state: 'success',
      confirmCode: '123456',
    });

    expect(html).toContain('教务登录验证成功');
    expect(html).toContain('你可以直接关闭这个页面');
    expect(html).toContain('教务确认 123456');
    expect(html).toContain('data-copy-confirm-command');
    expect(html).toContain('data-copy-text="教务确认 123456"');
    expect(html).toContain('复制确认消息');
    expect(html).toContain('navigator.clipboard.writeText');
    expect(html).not.toContain('请输入教务系统密码');
  });

  it('keeps submitted form state after login failure except the password', () => {
    const html = renderBindPage({
      backgroundImagePath: '/jw/bind/assets/campus-bg.jpg',
      qq: '1405359129',
      token: 'bind-token',
      submitPath: '/jw/bind/submit',
      username: 'student-1',
      persistCredentialConsent: true,
      state: 'error',
      message: '账号或密码错误',
    });

    expect(html).toContain('账号或密码错误');
    expect(html).toContain('name="token" value="bind-token"');
    expect(html).toContain('name="username"');
    expect(html).toContain('value="student-1"');
    expect(html).toContain('value="1405359129" readonly');
    expect(html).toContain('name="persistCredentialConsent" value="yes" required checked');
    expect(html).toContain('仅用于河北大学 WebVPN 与教务登录态失效后的自动重新登录');
    expect(html).toContain('id="password"');
    expect(html).toContain('data-password-toggle');
    expect(html).toContain('aria-label="显示密码"');
    expect(html).not.toContain('name="password" value=');
  });

  it('renders a pending page without the credential form', () => {
    const html = renderBindPage({
      backgroundImagePath: '/jw/bind/assets/campus-bg.jpg',
      qq: '1405359129',
      token: 'bind-token',
      submitPath: '/jw/bind/submit',
      state: 'pending',
    });

    expect(html).toContain('正在验证教务账号密码');
    expect(html).toContain('window.location.reload');
    expect(html).not.toContain('<form class="form"');
    expect(html).not.toContain('请输入教务系统密码');
  });
});

describe('hbu-jw plugin integration', () => {
  it('keeps guidance authorization on the triggering message and attaches the mandatory tool workflow', async () => {
    vi.spyOn(HbuJwCourseGuidanceService.prototype, 'assertBound').mockResolvedValue(undefined);
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const { puppeteer } = createPuppeteerHarness();
    const registeredTools: Array<{ authorization: (session: Record<string, unknown>) => boolean }> = [];
    const registerTool = vi.fn((_name: string, tool: { authorization: (session: Record<string, unknown>) => boolean }) => {
      registeredTools.push(tool);
      return () => undefined;
    });
    const eventHandlers = new Map<string, Array<() => unknown>>();
    const on = vi.fn((event: string, handler: () => unknown) => {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler);
      eventHandlers.set(event, handlers);
    });
    let workflowMiddleware: ((session: unknown, context: unknown) => Promise<number>) | undefined;
    const builder = {
      after: vi.fn(() => builder),
      before: vi.fn(() => builder),
    };
    const chatChain = {
      middleware: vi.fn((_name: string, handler: (session: unknown, context: unknown) => Promise<number>) => {
        workflowMiddleware = handler;
        return builder;
      }),
    };
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on,
      puppeteer,
      chatluna: {
        platform: { registerTool },
        registerAllowReplyResolver: vi.fn(() => () => undefined),
        chatChain,
      },
      chatluna_storage: { createTempFile: vi.fn() },
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '100',
      naturalTriggerEnabled: true,
      naturalTriggerGroups: '100',
    });
    for (const handler of eventHandlers.get('chatluna/chat-chain-added') ?? []) handler();

    const session = {
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:100',
      guildId: '100',
      messageId: 'message-1',
      content: '选课指导',
    };
    const inputMessage = {
      additional_kwargs: {
        overrideRequestParams: { text: { format: { type: 'json_schema' } } },
      },
    };
    const next = vi.fn(async () => {
      expect(registeredTools.map((tool) => tool.authorization(session))).toEqual([true, true, true]);
      expect(registeredTools.map((tool) => tool.authorization({ ...session, messageId: 'message-2' })))
        .toEqual([false, false, false]);
      await workflowMiddleware?.(session, { options: { inputMessage } });
      return 'agent-result';
    });

    await expect(middleware.mock.calls[0]?.[0](session, next)).resolves.toBe('agent-result');
    expect(workflowMiddleware).toBeTypeOf('function');
    expect(inputMessage.additional_kwargs.overrideRequestParams).toEqual({
      text: { format: { type: 'json_schema' } },
      qqbot_required_tool_sequence: [
        'hbu_jw_course_guidance_context',
        'hbu_jw_course_offerings',
        'hbu_jw_validate_course_recommendation',
      ],
      qqbot_required_tool_terminal: 'hbu_jw_validate_course_recommendation',
    });
  });

  it('registers the three guidance tools and blocks an unbound guidance keyword before Agent handoff', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const { puppeteer } = createPuppeteerHarness();
    const registerTool = vi.fn((_name: string, _tool: unknown) => () => undefined);
    const registerAllowReplyResolver = vi.fn(() => () => undefined);
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
      puppeteer,
      chatluna: { platform: { registerTool }, registerAllowReplyResolver },
      chatluna_storage: { createTempFile: vi.fn() },
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '100',
      naturalTriggerEnabled: true,
      naturalTriggerGroups: '100',
    });

    expect(registerTool.mock.calls.map((call) => call[0])).toEqual([
      'hbu_jw_course_guidance_context',
      'hbu_jw_course_offerings',
      'hbu_jw_validate_course_recommendation',
    ]);
    expect(registerAllowReplyResolver).toHaveBeenCalledWith('qqbot-hbu-jw-course-guidance', expect.any(Function));

    const next = vi.fn();
    const send = vi.fn();
    await middleware.mock.calls[0]?.[0]({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'private:1405359129',
      isDirect: true,
      content: '选课指导',
      send,
    }, next);

    expect(next).not.toHaveBeenCalled();
    expect(renderMessageContent(send.mock.calls[0]?.[0])).toContain('教务绑定');
  });

  it('returns the academic affairs menu in allowed groups without creating a binding challenge', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const { puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
      puppeteer,
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '100',
      naturalTriggerEnabled: true,
      naturalTriggerGroups: '100',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:100',
      guildId: '100',
      content: '教务',
      send,
    }, vi.fn());

    const reply = send.mock.calls[0]?.[0];
    expect(extractAtIds(reply)).toEqual(['1405359129']);
    expect(renderMessageContent(reply)).toContain('image/png');
    expect(getNavigatedHtml()).toContain('教务功能菜单');
    expect(getNavigatedHtml()).toContain('匿名成绩');
    expect(getNavigatedHtml()).toContain('考试安排');
    expect(database.tables.get('hbu_jw_bind_challenge') ?? []).toHaveLength(0);
  });

  it('registers tables, routes, and the exact binding keyword middleware', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const server = {
      get: vi.fn(),
      post: vi.fn(),
    };
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server,
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '100',
      naturalTriggerEnabled: true,
      naturalTriggerGroups: '100',
    });

    expect(ctx.model.extend).toHaveBeenCalledWith('hbu_jw_bind_challenge', expect.anything(), expect.anything());
    expect(server.get).toHaveBeenCalledWith('/jw/bind', expect.any(Function));
    expect(server.post).toHaveBeenCalledWith('/jw/bind/submit', expect.any(Function));
    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:100',
      guildId: '100',
      content: '教务绑定',
      send,
    }, vi.fn());

    const reply = send.mock.calls[0]?.[0];
    const text = renderMessageContent(reply);
    expect(extractAtIds(reply)).toEqual(['1405359129']);
    expect(text).not.toContain('@1405359129');
    expect(text).toContain('https://bot.example/jw/bind?token=');
    expect(text).toContain('网页登录成功后，页面会显示 6 位确认码');
    expect(text).toContain('教务确认 <确认码>');
    expect(database.tables.get('hbu_jw_bind_challenge')?.[0]).toMatchObject({
      ownerKey: 'onebot:1405359129',
      channelId: 'group:100',
      status: 'created',
    });
  });

  it('redirects successful credential submissions to the GET bind success page', async () => {
    vi.spyOn(HbuJwHttpClient.prototype, 'login').mockResolvedValue({
      cookieJar: cookieJar(),
    });
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const server = {
      get: vi.fn(),
      post: vi.fn(),
    };
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server,
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '100',
      naturalTriggerEnabled: true,
      naturalTriggerGroups: '100',
    });

    const keywordHandler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await keywordHandler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:100',
      guildId: '100',
      content: '教务绑定',
      send,
    }, vi.fn());
    const token = new URL(renderMessageContent(send.mock.calls[0]?.[0]).match(/https:\/\/bot\.example\S+/)?.[0] ?? '').searchParams.get('token') ?? '';
    expect(token).toMatch(/\S/);

    const postHandler = server.post.mock.calls.find(([path]) => path === '/jw/bind/submit')?.[1];
    const postHeaders = new Map<string, string>();
    const postCtx: any = {
      request: {
        body: {
          token,
          username: 'student-1',
          password: 'secret-password',
          persistCredentialConsent: 'yes',
        },
      },
      set: vi.fn((name: string, value: string) => postHeaders.set(name.toLowerCase(), value)),
    };
    await postHandler(postCtx);

    expect(postCtx.status).toBe(303);
    expect(postHeaders.get('location')).toBe(`/jw/bind?token=${encodeURIComponent(token)}`);
    expect(postHeaders.get('cache-control')).toBe('no-store');
    expect(postCtx.body).toBe('');

    const repeatedPostHeaders = new Map<string, string>();
    const repeatedPostCtx: any = {
      request: {
        body: {
          token,
          username: 'student-1',
          password: 'secret-password',
          persistCredentialConsent: 'yes',
        },
      },
      set: vi.fn((name: string, value: string) => repeatedPostHeaders.set(name.toLowerCase(), value)),
    };
    await postHandler(repeatedPostCtx);

    expect(repeatedPostCtx.status).toBe(303);
    expect(repeatedPostHeaders.get('location')).toBe(`/jw/bind?token=${encodeURIComponent(token)}`);
    expect(repeatedPostHeaders.get('cache-control')).toBe('no-store');
    expect(String(repeatedPostCtx.body ?? '')).not.toContain('已经提交过账号密码');

    const getHandler = server.get.mock.calls.find(([path]) => path === '/jw/bind')?.[1];
    const getHeaders = new Map<string, string>();
    const getCtx: any = {
      query: { token },
      set: vi.fn((name: string, value: string) => getHeaders.set(name.toLowerCase(), value)),
    };
    await getHandler(getCtx);

    expect(getCtx.status).toBe(200);
    expect(getHeaders.get('cache-control')).toBe('no-store');
    expect(String(getCtx.body)).toContain('教务登录验证成功');
    expect(String(getCtx.body)).toMatch(/教务确认 \d{6}/);
    expect(String(getCtx.body)).not.toContain('<form class="form"');
  });

  it('redirects duplicate submissions while credential validation is pending', async () => {
    let markLoginStarted!: () => void;
    const loginStarted = new Promise<void>((resolve) => {
      markLoginStarted = resolve;
    });
    let resolveLogin!: (value: { cookieJar: SerializedCookieJar }) => void;
    const loginResult = new Promise<{ cookieJar: SerializedCookieJar }>((resolve) => {
      resolveLogin = resolve;
    });
    vi.spyOn(HbuJwHttpClient.prototype, 'login').mockImplementation(async () => {
      markLoginStarted();
      return loginResult;
    });
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const server = {
      get: vi.fn(),
      post: vi.fn(),
    };
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server,
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '100',
      naturalTriggerEnabled: true,
      naturalTriggerGroups: '100',
    });

    const keywordHandler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await keywordHandler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:100',
      guildId: '100',
      content: '教务绑定',
      send,
    }, vi.fn());
    const token = new URL(renderMessageContent(send.mock.calls[0]?.[0]).match(/https:\/\/bot\.example\S+/)?.[0] ?? '').searchParams.get('token') ?? '';
    expect(token).toMatch(/\S/);

    const postHandler = server.post.mock.calls.find(([path]) => path === '/jw/bind/submit')?.[1];
    const requestBody = {
      token,
      username: 'student-1',
      password: 'secret-password',
      persistCredentialConsent: 'yes',
    };
    const firstPostHeaders = new Map<string, string>();
    const firstPostCtx: any = {
      request: { body: requestBody },
      set: vi.fn((name: string, value: string) => firstPostHeaders.set(name.toLowerCase(), value)),
    };
    const firstPost = postHandler(firstPostCtx);
    await loginStarted;

    const repeatedPostHeaders = new Map<string, string>();
    const repeatedPostCtx: any = {
      request: { body: requestBody },
      set: vi.fn((name: string, value: string) => repeatedPostHeaders.set(name.toLowerCase(), value)),
    };
    await postHandler(repeatedPostCtx);

    expect(repeatedPostCtx.status).toBe(303);
    expect(repeatedPostHeaders.get('location')).toBe(`/jw/bind?token=${encodeURIComponent(token)}`);
    expect(repeatedPostHeaders.get('cache-control')).toBe('no-store');
    expect(String(repeatedPostCtx.body ?? '')).not.toContain('已经提交过账号密码');

    const getHandler = server.get.mock.calls.find(([path]) => path === '/jw/bind')?.[1];
    const pendingGetHeaders = new Map<string, string>();
    const pendingGetCtx: any = {
      query: { token },
      set: vi.fn((name: string, value: string) => pendingGetHeaders.set(name.toLowerCase(), value)),
    };
    await getHandler(pendingGetCtx);
    expect(pendingGetCtx.status).toBe(200);
    expect(pendingGetHeaders.get('cache-control')).toBe('no-store');
    expect(String(pendingGetCtx.body)).toContain('正在验证教务账号密码');
    expect(String(pendingGetCtx.body)).not.toContain('<form class="form"');

    resolveLogin({ cookieJar: cookieJar() });
    await firstPost;
    expect(firstPostCtx.status).toBe(303);
    expect(firstPostHeaders.get('cache-control')).toBe('no-store');
  });

  it('explains the confirm command when the confirmation code is missing', async () => {
    const dir = createTempDir();
    const middleware = vi.fn();
    const ctx = {
      baseDir: dir,
      database: createDatabase(),
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '100',
      naturalTriggerEnabled: true,
      naturalTriggerGroups: '100',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    const next = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:100',
      guildId: '100',
      content: '教务确认',
      send,
    }, next);

    expect(send).toHaveBeenCalledWith('请发送完整确认命令：教务确认 <6位确认码>。确认码会在网页登录成功后的页面上显示。');
    expect(next).not.toHaveBeenCalled();
  });

  it('passes bare hbu-jw keywords through outside natural trigger groups', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '100',
      naturalTriggerEnabled: true,
      naturalTriggerGroups: '200',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    const next = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:100',
      guildId: '100',
      content: '教务绑定',
      send,
    }, next);

    expect(send).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(database.tables.get('hbu_jw_bind_challenge') ?? []).toHaveLength(0);
  });

  it('passes bare hbu-jw keywords through when natural trigger is disabled', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '100',
      naturalTriggerGroups: '100',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    const next = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:100',
      guildId: '100',
      content: '教务绑定',
      send,
    }, next);

    expect(send).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(database.tables.get('hbu_jw_bind_challenge') ?? []).toHaveLength(0);
  });

  it('accepts explicitly mentioned hbu-jw keywords outside natural trigger groups', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '100',
      naturalTriggerEnabled: true,
      naturalTriggerGroups: '200',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    const next = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:100',
      guildId: '100',
      content: '<at id="100000001"/> 教务绑定',
      stripped: { content: '教务绑定', atSelf: true },
      send,
    }, next);

    const reply = send.mock.calls[0]?.[0];
    expect(renderMessageContent(reply)).toContain('https://bot.example/jw/bind?token=');
    expect(next).not.toHaveBeenCalled();
    expect(database.tables.get('hbu_jw_bind_challenge')?.[0]).toMatchObject({
      ownerKey: 'onebot:1405359129',
      channelId: 'group:100',
      status: 'created',
    });
  });

  it('blocks the menu keyword outside allowed groups before rendering the image', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const { puppeteer } = createPuppeteerHarness();
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
      puppeteer,
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '100',
      naturalTriggerEnabled: true,
      naturalTriggerGroups: '200',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:200',
      guildId: '200',
      content: '教务',
      send,
    }, vi.fn());

    expect(send).toHaveBeenCalledWith('当前群未开启教务系统功能。');
    expect(puppeteer.page).not.toHaveBeenCalled();
  });

  it('blocks hbu-jw keywords outside allowed groups before any GPA query', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const getAllPassingScores = vi.spyOn(HbuJwHttpClient.prototype, 'getAllPassingScores');
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '100',
      naturalTriggerEnabled: true,
      naturalTriggerGroups: '200',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:200',
      guildId: '200',
      content: 'GPA',
      send,
    }, vi.fn());

    expect(send).toHaveBeenCalledWith('当前群未开启教务系统功能。');
    expect(getAllPassingScores).not.toHaveBeenCalled();
  });

  it('blocks schedule keywords outside allowed groups before any schedule query', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const getThisSemesterSchedule = vi.spyOn(HbuJwHttpClient.prototype, 'getThisSemesterSchedule');
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '100',
      naturalTriggerEnabled: true,
      naturalTriggerGroups: '200',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:200',
      guildId: '200',
      content: '完整课表',
      send,
    }, vi.fn());

    expect(send).toHaveBeenCalledWith('当前群未开启教务系统功能。');
    expect(getThisSemesterSchedule).not.toHaveBeenCalled();
  });

  it('blocks term score keywords outside allowed groups before any term score query', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const getThisTermScores = vi.spyOn(HbuJwHttpClient.prototype, 'getThisTermScores');
    const getAllPassingScores = vi.spyOn(HbuJwHttpClient.prototype, 'getAllPassingScores');
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '100',
      naturalTriggerEnabled: true,
      naturalTriggerGroups: '200',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:200',
      guildId: '200',
      content: '成绩',
      send,
    }, vi.fn());

    expect(send).toHaveBeenCalledWith('当前群未开启教务系统功能。');
    expect(getThisTermScores).not.toHaveBeenCalled();
    expect(getAllPassingScores).not.toHaveBeenCalled();
  });

  it('blocks anonymous term score keywords outside allowed groups before any score query', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const getThisTermScores = vi.spyOn(HbuJwHttpClient.prototype, 'getThisTermScores');
    const getAllPassingScores = vi.spyOn(HbuJwHttpClient.prototype, 'getAllPassingScores');
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '100',
      naturalTriggerEnabled: true,
      naturalTriggerGroups: '200',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:200',
      guildId: '200',
      content: '匿名成绩',
      send,
    }, vi.fn());

    expect(send).toHaveBeenCalledWith('当前群未开启教务系统功能。');
    expect(getThisTermScores).not.toHaveBeenCalled();
    expect(getAllPassingScores).not.toHaveBeenCalled();
  });

  it('blocks exam schedule keywords outside allowed groups before any exam query', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const getExamSchedule = vi.spyOn(HbuJwHttpClient.prototype, 'getExamSchedule');
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '100',
      naturalTriggerEnabled: true,
      naturalTriggerGroups: '200',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:200',
      guildId: '200',
      content: '考试安排',
      send,
    }, vi.fn());

    expect(send).toHaveBeenCalledWith('当前群未开启教务系统功能。');
    expect(getExamSchedule).not.toHaveBeenCalled();
  });

  it('allows hbu-jw binding in private chats regardless of the group allowlist', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'private:1405359129',
      isDirect: true,
      content: '教务绑定',
      send,
    }, vi.fn());

    expect(renderMessageContent(send.mock.calls[0]?.[0])).toContain('https://bot.example/jw/bind?token=');
    expect(database.tables.get('hbu_jw_bind_challenge')?.[0]).toMatchObject({
      ownerKey: 'onebot:1405359129',
      channelId: 'private:1405359129',
      status: 'created',
    });
  });

  it('allows the menu keyword in private chats regardless of the group allowlist', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const { puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
      puppeteer,
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'private:1405359129',
      isDirect: true,
      content: '教务',
      send,
    }, vi.fn());

    const reply = send.mock.calls[0]?.[0];
    expect(extractAtIds(reply)).toEqual(['1405359129']);
    expect(renderMessageContent(reply)).toContain('image/png');
    expect(getNavigatedHtml()).toContain('发送 <strong>教务</strong> 查看本菜单');
  });

  it('allows schedule keywords in private chats and asks for binding when no session exists', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const getThisSemesterSchedule = vi.spyOn(HbuJwHttpClient.prototype, 'getThisSemesterSchedule');
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'private:1405359129',
      isDirect: true,
      content: '课表',
      send,
    }, vi.fn());

    expect(send).toHaveBeenCalledWith('请先发送“教务绑定”。');
    expect(getThisSemesterSchedule).not.toHaveBeenCalled();
  });

  it('routes the selection result keyword and asks for binding before querying', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const getCourseSelectionResult = vi.spyOn(HbuJwHttpClient.prototype, 'getCourseSelectionResult');
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'private:1405359129',
      isDirect: true,
      content: '选课结果',
      send,
    }, vi.fn());

    expect(send).toHaveBeenCalledWith('请先发送“教务绑定”。');
    expect(getCourseSelectionResult).not.toHaveBeenCalled();
  });

  it('allows term score keywords in private chats and asks for binding when no session exists', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const getThisTermScores = vi.spyOn(HbuJwHttpClient.prototype, 'getThisTermScores');
    const getAllPassingScores = vi.spyOn(HbuJwHttpClient.prototype, 'getAllPassingScores');
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'private:1405359129',
      isDirect: true,
      content: '成绩',
      send,
    }, vi.fn());

    expect(send).toHaveBeenCalledWith('请先发送“教务绑定”。');
    expect(getThisTermScores).not.toHaveBeenCalled();
    expect(getAllPassingScores).not.toHaveBeenCalled();
  });

  it('allows anonymous term score keywords in allowed groups and asks for binding when no session exists', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const getThisTermScores = vi.spyOn(HbuJwHttpClient.prototype, 'getThisTermScores');
    const getAllPassingScores = vi.spyOn(HbuJwHttpClient.prototype, 'getAllPassingScores');
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '100',
      naturalTriggerEnabled: true,
      naturalTriggerGroups: '100',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:100',
      guildId: '100',
      content: '匿名成绩',
      send,
    }, vi.fn());

    expect(send).toHaveBeenCalledWith('请先发送“教务绑定”。');
    expect(getThisTermScores).not.toHaveBeenCalled();
    expect(getAllPassingScores).not.toHaveBeenCalled();
  });

  it('allows anonymous term score keywords in private chats and asks for binding when no session exists', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const getThisTermScores = vi.spyOn(HbuJwHttpClient.prototype, 'getThisTermScores');
    const getAllPassingScores = vi.spyOn(HbuJwHttpClient.prototype, 'getAllPassingScores');
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'private:1405359129',
      isDirect: true,
      content: '匿名成绩',
      send,
    }, vi.fn());

    expect(send).toHaveBeenCalledWith('请先发送“教务绑定”。');
    expect(getThisTermScores).not.toHaveBeenCalled();
    expect(getAllPassingScores).not.toHaveBeenCalled();
  });

  it('allows exam schedule keywords in private chats and asks for binding when no session exists', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const getExamSchedule = vi.spyOn(HbuJwHttpClient.prototype, 'getExamSchedule');
    const ctx = {
      baseDir: dir,
      database,
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
    };

    apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'private:1405359129',
      isDirect: true,
      content: '考试安排',
      send,
    }, vi.fn());

    expect(send).toHaveBeenCalledWith('请先发送“教务绑定”。');
    expect(getExamSchedule).not.toHaveBeenCalled();
  });

  it('rejects public http bind URLs and allows localhost http for development', () => {
    const dir = createTempDir();
    const createCtx = () => ({
      baseDir: dir,
      database: createDatabase(),
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware: vi.fn(),
      on: vi.fn(),
    });

    expect(() => apply(createCtx() as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'http://example.com',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '',
    })).toThrow('必须是 https URL');

    expect(() => apply(createCtx() as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'http://127.0.0.1:5140',
      credentialKekPath: join(dir, 'kek.key'),
      allowedGroups: '',
    })).not.toThrow();
  });

  it('requires the hbu-jw allowlist to be explicitly configured', () => {
    const dir = createTempDir();
    const ctx = {
      baseDir: dir,
      database: createDatabase(),
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware: vi.fn(),
      on: vi.fn(),
    };

    expect(() => apply(ctx as never, {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      credentialKekPath: join(dir, 'kek.key'),
    })).toThrow('hbu-jw.allowedGroups 必须显式配置');
  });
});
