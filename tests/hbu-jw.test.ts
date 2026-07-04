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
import { loadOrCreateKek } from '../src/plugins/hbu-jw/crypto.js';
import { HbuJwGpaService, calculateHbuJwGpa, formatGpaReply } from '../src/plugins/hbu-jw/gpa.js';
import { HbuJwHttpClient, HbuJwLoginError } from '../src/plugins/hbu-jw/jw-client.js';
import { HbuJwService } from '../src/plugins/hbu-jw/service.js';
import { HbuJwStore } from '../src/plugins/hbu-jw/store.js';
import type { DatabaseLike, HbuJwScoreRow, OwnerIdentity, SerializedCookieJar } from '../src/plugins/hbu-jw/types.js';
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
