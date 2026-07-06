import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

import { apply } from '../src/plugins/hbu-jw/index.js';
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
import { HbuJwGpaService, calculateHbuJwGpa, formatGpaReply } from '../src/plugins/hbu-jw/gpa.js';
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
  calculateTeachingWeek,
  renderHbuJwScheduleImage,
} from '../src/plugins/hbu-jw/schedule.js';
import { HbuJwService } from '../src/plugins/hbu-jw/service.js';
import { HbuJwStore } from '../src/plugins/hbu-jw/store.js';
import {
  HbuJwTermScoresService,
  buildHbuJwTermScoresView,
  renderHbuJwTermScoresImage,
} from '../src/plugins/hbu-jw/term-scores.js';
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

function createService(options: {
  database?: ReturnType<typeof createDatabase>;
  now?: () => number;
  validate?: (cookieJar: SerializedCookieJar) => Promise<boolean>;
  login?: (username: string, password: string) => Promise<{ cookieJar: SerializedCookieJar }>;
} = {}) {
  const dir = createTempDir();
  const database = options.database ?? createDatabase();
  const login = vi.fn(options.login ?? (async () => ({ cookieJar: { cookies: [{ name: 'JSESSIONID', value: 'abc' }] } })));
  const validate = vi.fn(options.validate ?? (async () => true));
  const service = new HbuJwService(
    new HbuJwStore(database as unknown as DatabaseLike),
    { login, validate } as never,
    loadOrCreateKek(join(dir, 'kek.key')),
    {
      bindPagePath: '/jw/bind',
      publicBaseUrl: 'https://bot.example',
      bindTokenTtlMs: 600_000,
      autoReloginEnabled: true,
    },
    options.now ?? (() => 1_000),
  );
  return { service, database, login, validate };
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

function createPuppeteerHarness() {
  let navigatedHtml = '';
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
    screenshot: vi.fn(async () => Buffer.from('png')),
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

  it('submits credentials once, stores encrypted pending state, and rejects resubmission', async () => {
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
    await expect(service.submitCredentials({
      token,
      username: 'student-2',
      password: 'other-password',
      persistCredentialConsent: true,
    })).rejects.toThrow('已经提交过账号密码');
    expect(login).toHaveBeenCalledTimes(1);
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
      login: async () => ({ cookieJar: { cookies: [{ name: 'JSESSIONID', value: 'fresh' }] } }),
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

    expect(result).toEqual({ kind: 'authenticated', cookieJar: { cookies: [{ name: 'JSESSIONID', value: 'fresh' }] } });
    expect(login).toHaveBeenCalledTimes(2);
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
});

describe('hbu-jw menu module', () => {
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
          ['课表', '查看这周的课表'],
          ['完整课表', '查看本学期的课表'],
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
  });

  it('formats a compact GPA reply without course details', () => {
    const reply = formatGpaReply('1405359129', calculateHbuJwGpa([
      scoreRow({ id: { courseNumber: '2023D00003' }, courseName: '程序设计', credit: '3', gradePointScore: 4.5 }),
      scoreRow({ id: { courseNumber: '0823GRY019' }, courseName: '坤舆艺术名家讲堂系列', credit: '1', gradePointScore: 4.6 }),
    ]));

    const text = renderMessageContent(reply);
    expect(extractAtIds(reply)).toEqual(['1405359129']);
    expect(text).not.toContain('@1405359129');
    expect(text).toContain('GPA：4.50');
    expect(text).toContain('计入：1 门 / 3 学分');
    expect(text).toContain('排除：非必修 0 门，固定 0 门，艺术 1 门，无绩点 0 门');
    expect(text).not.toContain('程序设计');
  });

  it('uses the authenticated session to query and format GPA', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: { cookies: [{ name: 'JSESSIONID', value: 'abc' }] },
    }));
    const getAllPassingScores = vi.fn(async () => [
      scoreRow({ id: { courseNumber: '2023D00003' }, courseName: '程序设计', credit: '3', gradePointScore: 4.5 }),
    ]);
    const service = new HbuJwGpaService({ ensureAuthenticated }, { getAllPassingScores });

    const reply = await service.queryGpa(identity());

    expect(renderMessageContent(reply)).toContain('GPA：4.50');
    expect(extractAtIds(reply)).toEqual(['1405359129']);
    expect(ensureAuthenticated).toHaveBeenCalledWith(identity());
    expect(getAllPassingScores).toHaveBeenCalledWith({ cookies: [{ name: 'JSESSIONID', value: 'abc' }] });
  });

  it('surfaces binding requirements before querying scores', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'needs_binding' as const,
      reason: '请先发送“教务绑定”。',
    }));
    const getAllPassingScores = vi.fn();
    const service = new HbuJwGpaService({ ensureAuthenticated }, { getAllPassingScores });

    await expect(service.queryGpa(identity())).rejects.toThrow('请先发送“教务绑定”。');
    expect(getAllPassingScores).not.toHaveBeenCalled();
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
      cookieJar: { cookies: [{ name: 'JSESSIONID', value: 'abc' }] },
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
    expect(getThisTermScores).toHaveBeenCalledWith({ cookies: [{ name: 'JSESSIONID', value: 'abc' }] });
    expect(getAllPassingScores).toHaveBeenCalledWith({ cookies: [{ name: 'JSESSIONID', value: 'abc' }] });
    expect(getSubitemScoreDetails).not.toHaveBeenCalled();
  });

  it('uses look result row counts for recorded term score status', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: { cookies: [{ name: 'JSESSIONID', value: 'abc' }] },
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
        { id: { studentNumber: '20231202052', scoreTypeCode: '001' }, zcj: 81 },
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
      { cookies: [{ name: 'JSESSIONID', value: 'abc' }] },
      { zxjxjhh: '2025-2026-2-2', kch: '2023S01004', kxh: '01', kssj: '20260620', kcsxdm: '001' },
    );
    expect(getNavigatedHtml()).toContain('已录入2');
    expect(getNavigatedHtml()).toContain('<td class="score-col score">84</td>');
  });

  it('uses empty look results as pending term score status', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: { cookies: [{ name: 'JSESSIONID', value: 'abc' }] },
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
      rows: [],
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
      cookieJar: { cookies: [{ name: 'JSESSIONID', value: 'abc' }] },
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
    expect(getThisTermScores).toHaveBeenCalledWith({ cookies: [{ name: 'JSESSIONID', value: 'abc' }] });
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
      cookieJar: { cookies: [{ name: 'JSESSIONID', value: 'abc' }] },
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
    expect(getExamSchedule).toHaveBeenCalledWith({ cookies: [{ name: 'JSESSIONID', value: 'abc' }] });
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
  it('calculates teaching weeks from fixed HBU term starts', () => {
    expect(calculateTeachingWeek('2025-2026-2-2', Date.UTC(2026, 2, 1))).toBe(1);
    expect(calculateTeachingWeek('2025-2026-2-2', Date.UTC(2026, 2, 15))).toBe(3);
    expect(calculateTeachingWeek('2025-2026-1-1', Date.UTC(2025, 8, 1))).toBe(1);
    expect(calculateTeachingWeek('2025-2026-1-1', Date.UTC(2025, 8, 15))).toBe(3);
  });

  it('filters current-week slots while complete schedule keeps every arranged slot', () => {
    const current = buildHbuJwScheduleView(thisSemesterSchedule(), 'current-week', Date.UTC(2026, 2, 15));
    const complete = buildHbuJwScheduleView(thisSemesterSchedule(), 'full-semester', Date.UTC(2026, 2, 15));

    expect(current.currentWeek).toBe(3);
    expect(current.slots.map((slot) => slot.courseName)).toEqual(['编译原理_01']);
    expect(current.renderedCourseCount).toBe(1);
    expect(current.unarrangedCourseCount).toBe(1);
    expect(complete.slots.map((slot) => slot.courseName)).toEqual(['软件工程_01', '软件工程_01', '编译原理_01']);
    expect(complete.renderedCourseCount).toBe(2);
  });

  it('renders the schedule view as a PNG image with course details in the HTML', async () => {
    const { page, puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const image = await renderHbuJwScheduleImage(
      puppeteer,
      buildHbuJwScheduleView(thisSemesterSchedule(), 'current-week', Date.UTC(2026, 2, 15)),
    );

    expect(String(image)).toContain('image/png');
    expect(getNavigatedHtml()).toContain('河北大学课表 · 第 3 周');
    expect(getNavigatedHtml()).toContain('编译原理_01');
    expect(getNavigatedHtml()).toContain('七一路校区A2座104');
    expect(getNavigatedHtml()).toContain('未安排课程');
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'png' }));
  });

  it('uses the authenticated session to query and render schedules', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: { cookies: [{ name: 'JSESSIONID', value: 'abc' }] },
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
    expect(renderMessageContent(reply)).toContain('image/png');
    expect(ensureAuthenticated).toHaveBeenCalledWith(identity());
    expect(getThisSemesterSchedule).toHaveBeenCalledWith({ cookies: [{ name: 'JSESSIONID', value: 'abc' }] });
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
      cookieJar: { cookies: [{ name: 'JSESSIONID', value: 'abc' }] },
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
    expect(getThisTermScores).toHaveBeenCalledWith({ cookies: [{ name: 'JSESSIONID', value: 'abc' }] });
    expect(getAllPassingScores).not.toHaveBeenCalled();
    expect(getSubitemScoreDetails).toHaveBeenCalledWith(
      { cookies: [{ name: 'JSESSIONID', value: 'abc' }] },
      { zxjxjhh: '2025-2026-2-2', kch: '2023S01105', kxh: '02', kssj: '20260620', kcsxdm: '003' },
    );
    expect(getNavigatedHtml()).toContain('模式识别与机器学习');
    expect(getNavigatedHtml()).toContain('20221202009');
    expect(getNavigatedHtml()).toContain('27.2');
    expect(getNavigatedHtml()).not.toContain('<th class="type-col">类型</th>');
    expect(getNavigatedHtml()).not.toContain('20221202010');
    expect(getNavigatedHtml()).not.toContain('20221202011');
  });

  it('loads historical candidates from all passing scores when a previous term is selected', async () => {
    const ensureAuthenticated = vi.fn(async () => ({
      kind: 'authenticated' as const,
      cookieJar: { cookies: [{ name: 'JSESSIONID', value: 'abc' }] },
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
    expect(getAllPassingScores).toHaveBeenCalledWith({ cookies: [{ name: 'JSESSIONID', value: 'abc' }] });
    expect(getSubitemScoreDetails).toHaveBeenCalledWith(
      { cookies: [{ name: 'JSESSIONID', value: 'abc' }] },
      { zxjxjhh: '2025-2026-1-2', kch: '2023D00003', kxh: '01', kssj: '20260105', kcsxdm: '001' },
    );
    expect(getNavigatedHtml()).toContain('接口返回 0 条 01 分项成绩');
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
  it('rejects cross-origin redirects before sending cookies to the redirected target', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://zhjw.hbu.cn/login') {
        return new Response('', {
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

    await expect(client.login('student', 'password')).rejects.toThrow('非预期跳转');
    expect(fetchImpl.mock.calls.map((call) => call[0])).not.toContain('https://example.com/steal');
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

    await expect(client.getAllPassingScores({ cookies: [{ name: 'JSESSIONID', value: 'abc' }] })).resolves.toEqual(rows);
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
    await expect(ambiguousClient.getAllPassingScores({ cookies: [] })).rejects.toThrow('没有唯一的回调地址');

    const malformedFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/allPassingScores/index')) {
        return new Response('"/student/integratedQuery/scoreQuery/a/allPassingScores/callback"', { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const malformedClient = new HbuJwHttpClient({ fetchImpl: malformedFetch as never });
    await expect(malformedClient.getAllPassingScores({ cookies: [] })).rejects.toThrow('结构异常');
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

    await expect(client.getThisTermScores({ cookies: [{ name: 'JSESSIONID', value: 'abc' }] })).resolves.toEqual(rows);
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
    await expect(ambiguousClient.getThisTermScores({ cookies: [] })).rejects.toThrow('没有唯一的数据地址');

    const malformedFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/thisTermScores/index')) {
        return new Response('"/student/integratedQuery/scoreQuery/a/thisTermScores/data"', { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const malformedClient = new HbuJwHttpClient({ fetchImpl: malformedFetch as never });
    await expect(malformedClient.getThisTermScores({ cookies: [] })).rejects.toThrow('结构异常');
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

    await expect(client.getSubitemScoreTerms({ cookies: [{ name: 'JSESSIONID', value: 'abc' }] })).resolves.toEqual([
      { code: '2026-2027-1-2', label: '2026-2027学年秋(三学期)', selected: false },
      { code: '2025-2026-2-2', label: '2025-2026学年春(三学期)', selected: true },
    ]);
    await expect(client.getSubitemScoreDetails(
      { cookies: [{ name: 'JSESSIONID', value: 'abc' }] },
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
    await expect(ambiguousClient.getSubitemScoreDetails({ cookies: [] }, params)).rejects.toThrow('没有唯一的查看地址');

    const malformedFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/subitemScore/index')) {
        return new Response('"/student/integratedQuery/scoreQuery/subitemScore/a/look"', { status: 200 });
      }
      return new Response('not-json', { status: 200 });
    });
    const malformedClient = new HbuJwHttpClient({ fetchImpl: malformedFetch as never });
    await expect(malformedClient.getSubitemScoreDetails({ cookies: [] }, params)).rejects.toThrow('非 JSON');
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

    await expect(client.getExamSchedule({ cookies: [{ name: 'JSESSIONID', value: 'abc' }] })).resolves.toEqual(rows);
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
    await expect(ambiguousClient.getExamSchedule({ cookies: [] })).rejects.toThrow('没有唯一的数据地址');

    const malformedFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/examPlan/index')) {
        return new Response('"/student/examinationManagement/examPlan/detail"', { status: 200 });
      }
      return new Response(JSON.stringify([{ title: '软件工程' }]), { status: 200 });
    });
    const malformedClient = new HbuJwHttpClient({ fetchImpl: malformedFetch as never });
    await expect(malformedClient.getExamSchedule({ cookies: [] })).rejects.toThrow('结构异常');
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

    const schedule = await client.getThisSemesterSchedule({ cookies: [{ name: 'JSESSIONID', value: 'abc' }] });

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
    await expect(ambiguousClient.getThisSemesterSchedule({ cookies: [] })).rejects.toThrow('没有唯一的回调地址');

    const malformedFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/thisSemesterCurriculum/index')) {
        return new Response('"/student/courseSelect/thisSemesterCurriculum/a/ajaxStudentSchedule/curr/callback"', { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const malformedClient = new HbuJwHttpClient({ fetchImpl: malformedFetch as never });
    await expect(malformedClient.getThisSemesterSchedule({ cookies: [] })).rejects.toThrow('结构异常');
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
    expect(html).toContain('id="password"');
    expect(html).toContain('data-password-toggle');
    expect(html).toContain('aria-label="显示密码"');
    expect(html).not.toContain('name="password" value=');
  });
});

describe('hbu-jw plugin integration', () => {
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
