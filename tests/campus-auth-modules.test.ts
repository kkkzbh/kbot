import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => {
  type SchemaNode = { default: () => SchemaNode; description: () => SchemaNode; role: () => SchemaNode };
  const schema = (): SchemaNode => ({ default: schema, description: schema, role: schema });
  class Logger { info(): void {} warn(): void {} }
  const h = {
    image: (source: Buffer, mime: string) => ({ type: 'image', attrs: { source, mime }, children: [] }),
    text: (content: string) => ({ type: 'text', attrs: { content }, children: [], toString: () => content }),
    at: (id: string) => ({ type: 'at', attrs: { id }, children: [], toString: () => `<at id="${id}"/>` }),
  };
  return {
    Context: class {}, Logger, h,
    Schema: {
      object: schema, boolean: schema, string: schema, natural: schema, array: schema, union: schema,
    },
  };
});

import { CampusAuthService, diagnostic } from '../src/plugins/campus-auth-core/service.js';
import { CampusAuthStore } from '../src/plugins/campus-auth-core/store.js';
import {
  CAMPUS_AUTH_PROVIDER_SECOND_CLASS,
  CAMPUS_AUTH_PROVIDER_ZYH,
  CampusAuthUserError,
  type CampusAuthMethod,
  type CampusAuthProvider,
  type CampusOwnerIdentity,
} from '../src/plugins/campus-auth-core/types.js';
import { renderCampusBindPage } from '../src/plugins/campus-auth-core/bind-page.js';
import { SecondClassHttpClient } from '../src/plugins/hbu-second-class/client.js';
import { SecondClassCache } from '../src/plugins/hbu-second-class/cache.js';
import { HbuSecondClassService } from '../src/plugins/hbu-second-class/service.js';
import { collectRadarPoints, collectTranscriptRows } from '../src/plugins/hbu-second-class/render.js';
import { parseSecondClassCommand, shouldExposeSecondClassCapabilityReference } from '../src/plugins/hbu-second-class/index.js';
import { SecondClassSessionExpiredError } from '../src/plugins/hbu-second-class/types.js';
import { VersionedJsonCache } from '../src/plugins/shared/versioned-json-cache.js';
import { parseZyhCommand, shouldExposeZyhCapabilityReference } from '../src/plugins/zyh/index.js';
import { ZyhHttpClient } from '../src/plugins/zyh/client.js';
import { ZyhCache } from '../src/plugins/zyh/cache.js';
import { ZyhService } from '../src/plugins/zyh/service.js';
import { ZyhSessionExpiredError } from '../src/plugins/zyh/types.js';

const fixtureDir = resolve(process.cwd(), 'tests/fixtures/campus-auth');
const fixture = (name: string): string => readFileSync(resolve(fixtureDir, name), 'utf8');

function createDatabase() {
  const tables = new Map<string, Record<string, any>[]>();
  const ids = new Map<string, number>();
  const rows = (table: string) => tables.get(table) ?? [];
  const matches = (row: Record<string, any>, query: Record<string, any>) => Object.entries(query).every(([key, value]) => row[key] === value);
  return {
    tables,
    get: vi.fn(async (table: string, query: Record<string, any>) => rows(table).filter((row) => matches(row, query))),
    create: vi.fn(async (table: string, input: Record<string, any>) => {
      const id = (ids.get(table) ?? 0) + 1;
      ids.set(table, id);
      const row = { id, ...input };
      tables.set(table, [...rows(table), row]);
      return row;
    }),
    set: vi.fn(async (table: string, query: Record<string, any>, patch: Record<string, any>) => {
      tables.set(table, rows(table).map((row) => matches(row, query) ? { ...row, ...patch } : row));
    }),
    remove: vi.fn(async (table: string, query: Record<string, any>) => {
      tables.set(table, rows(table).filter((row) => !matches(row, query)));
    }),
  };
}

function owner(id = '10001', channelId = 'private:10001'): CampusOwnerIdentity {
  return { ownerKey: `onebot:${id}`, platform: 'onebot', qqUserId: id, channelId };
}

function createAuthService(maxBindingAttempts = 5) {
  const database = createDatabase();
  let now = 1_000;
  const service = new CampusAuthService(
    new CampusAuthStore(database as never),
    { id: 'fixture-kek', key: Buffer.alloc(32, 7) },
    { publicBaseUrl: 'https://bind.example', bindPagePath: '/campus/bind', bindTokenTtlMs: 600_000, maxBindingAttempts },
    () => now,
  );
  return { service, database, advance: (ms: number) => { now += ms; } };
}

function provider(id: typeof CAMPUS_AUTH_PROVIDER_ZYH | typeof CAMPUS_AUTH_PROVIDER_SECOND_CLASS, methods: CampusAuthMethod[]): CampusAuthProvider {
  return {
    id,
    label: id,
    confirmCommandPrefix: id === CAMPUS_AUTH_PROVIDER_ZYH ? '志愿汇确认' : '二课确认',
    getBindingMethods: async () => methods.map((method) => ({ id: method, label: method, description: method, fields: [] })),
    authenticate: async (input) => ({
      method: input.method,
      sessionPayload: { token: `${input.method}-session-token` },
      credentialPayload: input.method === 'managed_credentials' ? { username: 'fixture-user', password: 'fixture-password' } : undefined,
      sourceProviderId: input.method === 'zyh_sso' ? CAMPUS_AUTH_PROVIDER_ZYH : null,
      accountLabel: 'fixture-account',
    }),
  };
}

async function bind(service: CampusAuthService, identity: CampusOwnerIdentity, providerId: typeof CAMPUS_AUTH_PROVIDER_ZYH | typeof CAMPUS_AUTH_PROVIDER_SECOND_CLASS, method: CampusAuthMethod) {
  const started = await service.startBinding(identity, providerId);
  const token = new URL(started.link).searchParams.get('token')!;
  await service.submitBinding(token, method, {});
  const page = await service.resolveBindPage(token);
  expect(page.state).toBe('verified');
  const confirmed = await service.confirmBinding(identity, providerId, page.confirmCode!);
  return { token, confirmed };
}

describe('campus auth core contracts', () => {
  it.each([
    ['managed_credentials', CAMPUS_AUTH_PROVIDER_ZYH],
    ['session_credentials', CAMPUS_AUTH_PROVIDER_ZYH],
    ['session_import', CAMPUS_AUTH_PROVIDER_ZYH],
    ['zyh_sso', CAMPUS_AUTH_PROVIDER_SECOND_CLASS],
    ['direct_credentials', CAMPUS_AUTH_PROVIDER_SECOND_CLASS],
    ['token_import', CAMPUS_AUTH_PROVIDER_SECOND_CLASS],
  ] as const)('persists %s only after the six-digit confirmation', async (method, providerId) => {
    const { service, database } = createAuthService();
    service.registerProvider(provider(CAMPUS_AUTH_PROVIDER_ZYH, ['managed_credentials', 'session_credentials', 'session_import']));
    service.registerProvider(provider(CAMPUS_AUTH_PROVIDER_SECOND_CLASS, ['zyh_sso', 'direct_credentials', 'token_import']));
    const identity = owner(method);
    const started = await service.startBinding(identity, providerId);
    const token = new URL(started.link).searchParams.get('token')!;
    await service.submitBinding(token, method, {});
    expect(await service.getActiveSession(identity.ownerKey, providerId)).toBeNull();
    const page = await service.resolveBindPage(token);
    expect(page.confirmCode).toMatch(/^\d{6}$/);
    await service.confirmBinding(identity, providerId, page.confirmCode!);
    expect((await service.getActiveSession<{ token: string }>(identity.ownerKey, providerId))?.payload.token).toContain(method);
    const stored = JSON.stringify([...database.tables.values()]);
    expect(stored).not.toContain(`${method}-session-token`);
    expect(stored).not.toContain(page.confirmCode);
    expect(stored).not.toContain('fixture-password');
  });

  it('rejects cross-channel confirmation and expires one-time links', async () => {
    const { service, advance } = createAuthService();
    service.registerProvider(provider(CAMPUS_AUTH_PROVIDER_ZYH, ['session_import']));
    const identity = owner();
    const started = await service.startBinding(identity, CAMPUS_AUTH_PROVIDER_ZYH);
    const token = new URL(started.link).searchParams.get('token')!;
    await service.submitBinding(token, 'session_import', {});
    const code = (await service.resolveBindPage(token)).confirmCode!;
    await expect(service.confirmBinding(identity, CAMPUS_AUTH_PROVIDER_ZYH, code === '000000' ? '000001' : '000000')).rejects.toThrow('确认码不正确');
    await expect(service.confirmBinding(owner('10001', 'group:999'), CAMPUS_AUTH_PROVIDER_ZYH, code)).rejects.toThrow('原会话');
    advance(600_001);
    await expect(service.resolveBindPage(token)).rejects.toThrow('已过期');
  });

  it('serializes duplicate submissions and enforces the attempt limit', async () => {
    const { service } = createAuthService(2);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let callCount = 0;
    service.registerProvider({
      ...provider(CAMPUS_AUTH_PROVIDER_ZYH, ['session_import']),
      authenticate: async () => {
        callCount += 1;
        await gate;
        throw new CampusAuthUserError('验证失败');
      },
    });
    const started = await service.startBinding(owner(), CAMPUS_AUTH_PROVIDER_ZYH);
    const token = new URL(started.link).searchParams.get('token')!;
    const first = service.submitBinding(token, 'session_import', {});
    const duplicate = service.submitBinding(token, 'session_import', {});
    release();
    const results = await Promise.allSettled([first, duplicate]);
    expect(callCount).toBe(1);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    await expect(service.submitBinding(token, 'session_import', {})).rejects.toThrow('验证失败');
    await expect(service.submitBinding(token, 'session_import', {})).rejects.toThrow('尝试次数已用完');
  });

  it('cascades only sessions that originate from the志愿汇 provider', async () => {
    const { service } = createAuthService();
    service.registerProvider(provider(CAMPUS_AUTH_PROVIDER_ZYH, ['session_import']));
    service.registerProvider(provider(CAMPUS_AUTH_PROVIDER_SECOND_CLASS, ['zyh_sso', 'token_import']));
    const first = owner('1');
    await bind(service, first, CAMPUS_AUTH_PROVIDER_ZYH, 'session_import');
    await bind(service, first, CAMPUS_AUTH_PROVIDER_SECOND_CLASS, 'zyh_sso');
    await service.unbind(first, CAMPUS_AUTH_PROVIDER_ZYH);
    expect(await service.getActiveSession(first.ownerKey, CAMPUS_AUTH_PROVIDER_SECOND_CLASS)).toBeNull();

    const second = owner('2');
    await bind(service, second, CAMPUS_AUTH_PROVIDER_ZYH, 'session_import');
    await bind(service, second, CAMPUS_AUTH_PROVIDER_SECOND_CLASS, 'token_import');
    await service.unbind(second, CAMPUS_AUTH_PROVIDER_ZYH);
    expect(await service.getActiveSession(second.ownerKey, CAMPUS_AUTH_PROVIDER_SECOND_CLASS)).not.toBeNull();
  });

  it('renders errors in a retryable form without reflecting secret values', () => {
    const html = renderCampusBindPage({
      providerLabel: '志愿汇', qqUserId: '10001', token: 'one-time-token', submitPath: '/campus/bind/submit', state: 'form',
      message: '<账号验证失败>',
      methods: [{ id: 'managed_credentials', label: '托管', description: '描述', fields: [{ name: 'password', label: '密码', type: 'password', required: true }] }],
    });
    expect(html).toContain('&lt;账号验证失败&gt;');
    expect(html).toContain('type="password"');
    expect(html).not.toContain('fixture-password');
  });

  it('redacts credential, token, captcha, and bearer values from diagnostics', () => {
    const value = diagnostic(new Error('password=plain Authorization:auth-token token=api-token captcha=1234 Bearer bearer-token'));
    expect(value).not.toContain('plain');
    expect(value).not.toContain('auth-token');
    expect(value).not.toContain('api-token');
    expect(value).not.toContain('1234');
    expect(value).not.toContain('bearer-token');
  });
});

describe('志愿汇 protocol client', () => {
  it('parses login headers, profile hours, and read-only activity fixtures', async () => {
    const requests: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const client = new ZyhHttpClient(async (request) => {
      requests.push(request);
      if (request.url.includes('userCenter/login')) {
        return { status: 200, headers: new Headers({ at: 'fixture-at', 'user-id': 'fixture-user-id', 'platform-id': '3' }), text: fixture('zyh-login-success.json') };
      }
      if (request.url.includes('volunteerinfo/getvolunteerbyId')) {
        return { status: 200, headers: new Headers(), text: fixture('zyh-profile-success.json') };
      }
      return { status: 200, headers: new Headers(), text: fixture('zyh-activity-success.json') };
    });
    const session = await client.login('fixture-id-card', 'fixture-password');
    expect(session).toEqual({ authorization: 'fixture-at', userId: 'fixture-user-id', platformId: '3' });
    const profile = await client.getProfile(session);
    expect(profile).toMatchObject({ hoursSystem: 12.5, hoursHistory: 3, hoursTotal: 15.5, points: 88 });
    const activities = await client.listActivities(session, profile, { page: 1, rows: 10 });
    expect(activities).toEqual([expect.objectContaining({ id: 'fixture-activity-id', title: '校园志愿服务', isFinished: true })]);
    expect(requests[1]?.headers.Authorization).toBe('fixture-at');
    expect(requests.every((request) => request.url.endsWith('.do'))).toBe(true);
  });
});

describe('河北大学二课 protocol client', () => {
  it('uses the Web SM2 login contract and validates the 河北大学 tenant', async () => {
    let loginBody: Record<string, unknown> = {};
    const client = new SecondClassHttpClient(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/app/common/sm2/getKey') return { status: 200, text: fixture('second-class-sm2-key-success.json') };
      if (path === '/auth/h5/login') {
        loginBody = JSON.parse(request.body!);
        return { status: 200, text: fixture('second-class-login-success.json') };
      }
      if (path === '/app/h5/info') {
        expect(request.headers.Authorization).toBe('fixture-second-class-token');
        return { status: 200, text: fixture('second-class-info-success.json') };
      }
      if (path === '/app/h5/school/info') return { status: 200, text: fixture('second-class-school-success.json') };
      throw new Error(`unexpected path ${path}`);
    });
    const session = await client.directLogin({ loginName: '2026000001', password: 'plain-secret', captchaCode: '1234', captchaUuid: 'uuid' });
    expect(session).toMatchObject({ token: 'fixture-second-class-token', schoolId: '1101092545313637006', schoolName: '河北大学' });
    expect(loginBody).toMatchObject({ loginName: '2026000001', code: '1234', uuid: 'uuid', passwordEncrypt: true });
    expect(loginBody.password).not.toBe('plain-secret');
    expect(String(loginBody.password)).toMatch(/^[0-9a-f]+$/i);
  });

  it('rejects imported tokens from a different tenant', async () => {
    const client = new SecondClassHttpClient(async (request) => {
      if (new URL(request.url).pathname === '/app/h5/info') return { status: 200, text: fixture('second-class-info-success.json') };
      return { status: 200, text: JSON.stringify({ code: 200, data: { id: 'other-school', name: '其他大学' } }) };
    });
    await expect(client.importToken('other-token')).rejects.toThrow('不属于河北大学');
  });

  it('uses the native zyh temporary-code header for linked SSO sessions', async () => {
    const requests: Array<{ path: string; headers: Record<string, string> }> = [];
    const client = new SecondClassHttpClient(async (request) => {
      const path = new URL(request.url).pathname;
      requests.push({ path, headers: request.headers });
      if (path === '/auth/getUserByZyhToken') return { status: 200, text: JSON.stringify({ code: 200, data: { userName: 'fixture' } }) };
      if (path === '/auth/h5/auth/login') return { status: 200, text: fixture('second-class-login-success.json') };
      if (path === '/app/h5/info') return { status: 200, text: fixture('second-class-info-success.json') };
      if (path === '/app/h5/school/info') return { status: 200, text: fixture('second-class-school-success.json') };
      throw new Error(`unexpected path ${path}`);
    });
    await client.loginWithZyh({ zyhCode: 'fixture-temp-code', studentSuffix: '001' });
    expect(requests.slice(0, 2).every((request) => request.headers.token === 'fixture-temp-code')).toBe(true);
    expect(requests.map((request) => request.path)).toEqual([
      '/auth/getUserByZyhToken', '/auth/h5/auth/login', '/app/h5/info', '/app/h5/school/info',
    ]);
  });

  it('treats HTTP and envelope 401 responses as expired sessions', async () => {
    const httpClient = new SecondClassHttpClient(async () => ({ status: 401, text: JSON.stringify({ code: 401, msg: 'expired' }) }));
    await expect(httpClient.importToken('expired')).rejects.toBeInstanceOf(SecondClassSessionExpiredError);
  });
});

describe('versioned cache and user-facing parsers', () => {
  it('returns only same-version historical data and records its fetch time', async () => {
    const database = createDatabase();
    let now = 10_000;
    const cache = new VersionedJsonCache(database as never, 'sync', 'items', 1_000_000, () => now);
    await cache.query('owner', 1, 'hours', 'current', async () => ({ hours: 8 }), () => true);
    now += 500;
    const historical = await cache.query('owner', 1, 'hours', 'current', async () => { throw new TypeError('network down'); }, () => true);
    expect(historical).toEqual(expect.objectContaining({ data: { hours: 8 }, source: 'database', fetchedAt: 10_000 }));
    await expect(cache.query('owner', 2, 'hours', 'current', async () => { throw new TypeError('network down'); }, () => true)).rejects.toThrow('network down');
  });

  it('parses both module command surfaces and hides malformed confirm codes', () => {
    expect(parseZyhCommand('志愿记录 2')).toEqual({ kind: 'records', page: 2 });
    expect(parseZyhCommand('志愿汇确认 123456')).toEqual({ kind: 'confirm', code: '123456' });
    expect(parseZyhCommand('志愿汇确认 12345')).toBeNull();
    expect(parseSecondClassCommand('二课成绩单 2025-2026-2')).toEqual({ kind: 'transcript', semester: '2025-2026-2' });
    expect(parseSecondClassCommand('二课确认 654321')).toEqual({ kind: 'confirm', code: '654321' });
    expect(parseSecondClassCommand('二课确认 abcdef')).toBeNull();
  });

  it('exposes capability guidance only for current-message command intent', () => {
    const session = (content: string) => ({ content, stripped: { content } }) as never;
    expect(shouldExposeZyhCapabilityReference(session('志愿汇绑定失败了'))).toBe(true);
    expect(shouldExposeZyhCapabilityReference(session('今天参加了志愿服务'))).toBe(false);
    expect(shouldExposeSecondClassCapabilityReference(session('二课学分怎么查'))).toBe(true);
    expect(shouldExposeSecondClassCapabilityReference(session('第二课堂活动挺丰富'))).toBe(false);
  });

  it('normalizes transcript and radar payloads for image rendering', () => {
    const data = {
      rows: [{ activityName: '志愿服务', semesterName: '2025-2026-2', categoryName: '社会实践', creditScore: 2 }],
      radar: [{ categoryName: '社会实践', actualCreditScore: 2 }, { categoryName: '创新创业', actualCreditScore: 3 }, { categoryName: '文体活动', actualCreditScore: 1 }],
    };
    expect(collectTranscriptRows(data)).toContainEqual(expect.objectContaining({ name: '志愿服务', credit: '2' }));
    expect(collectRadarPoints(data)).toEqual(expect.arrayContaining([
      { name: '社会实践', value: 2 }, { name: '创新创业', value: 3 }, { name: '文体活动', value: 1 },
    ]));
  });
});

describe('session renewal contracts', () => {
  it('refreshes only managed 志愿汇 credentials without rotating the cache version', async () => {
    const database = createDatabase();
    const expired = { authorization: 'expired', userId: 'user', platformId: '3' };
    const refreshed = { authorization: 'fresh', userId: 'user', platformId: '3' };
    const profile = { info: { nickname: '测试用户' }, hoursSystem: 1, hoursHistory: 2, hoursTotal: 3, points: 4 };
    const campusAuth = {
      getActiveSession: vi.fn(async () => ({ row: { method: 'managed_credentials', version: 7 }, payload: expired })),
      getActiveCredential: vi.fn(async () => ({ row: { id: 9 }, payload: { username: 'id-card', password: 'secret' } })),
      replaceSession: vi.fn(async () => ({ row: { method: 'managed_credentials', version: 7 }, payload: refreshed })),
      markCredentialUsed: vi.fn(async () => undefined),
      markCredentialFailure: vi.fn(async () => undefined),
      markSessionInvalid: vi.fn(async () => undefined),
      markSessionValidated: vi.fn(async () => undefined),
    };
    const client = {
      getProfile: vi.fn(async (session) => {
        if (session.authorization === 'expired') throw new ZyhSessionExpiredError();
        return profile;
      }),
      login: vi.fn(async () => refreshed),
    };
    const service = new ZyhService(campusAuth as never, client as never, new ZyhCache(database as never));
    const result = await service.ensureAuthenticated(owner());
    expect(result).toMatchObject({ session: refreshed, sessionVersion: 7 });
    expect(campusAuth.replaceSession).toHaveBeenCalledWith(owner(), CAMPUS_AUTH_PROVIDER_ZYH, 'managed_credentials', refreshed, { rotateVersion: false });
    expect(campusAuth.markCredentialUsed).toHaveBeenCalledWith(9);
  });

  it('requires rebinding when imported 志愿汇 sessions expire', async () => {
    const database = createDatabase();
    const campusAuth = {
      getActiveSession: vi.fn(async () => ({ row: { method: 'session_import', version: 2 }, payload: { authorization: 'expired', userId: 'user', platformId: '3' } })),
      markSessionInvalid: vi.fn(async () => undefined),
    };
    const client = { getProfile: vi.fn(async () => { throw new ZyhSessionExpiredError(); }) };
    const service = new ZyhService(campusAuth as never, client as never, new ZyhCache(database as never));
    await expect(service.ensureAuthenticated(owner())).rejects.toThrow('重新绑定');
    expect(campusAuth.markSessionInvalid).toHaveBeenCalled();
  });

  it('renews 二课 SSO from 志愿汇 and keeps direct sessions explicit on expiry', async () => {
    const database = createDatabase();
    const oldSession = { token: 'expired', schoolId: '1101092545313637006', schoolName: '河北大学', studentNo: '2026000001', accountName: '学生' };
    const newSession = { ...oldSession, token: 'fresh' };
    const campusAuth = {
      getActiveSession: vi.fn(async () => ({ row: { method: 'zyh_sso', version: 4 }, payload: oldSession })),
      markSessionValidated: vi.fn(async () => undefined),
      markSessionInvalid: vi.fn(async () => undefined),
      replaceSession: vi.fn(async () => ({ row: { method: 'zyh_sso', version: 4 }, payload: newSession })),
    };
    const zyh = { getSecondClassSsoSource: vi.fn(async () => ({ code: 'zyh-temp-code', credentialId: 9 })) };
    const client = {
      getUserInfo: vi.fn(async () => { throw new SecondClassSessionExpiredError(); }),
      refreshZyhSso: vi.fn(async () => newSession),
    };
    const service = new HbuSecondClassService(campusAuth as never, zyh as never, client as never, new SecondClassCache(database as never));
    await expect(service.ensureAuthenticated(owner())).resolves.toEqual({ session: newSession, sessionVersion: 4 });
    expect(campusAuth.replaceSession).toHaveBeenCalledWith(owner(), CAMPUS_AUTH_PROVIDER_SECOND_CLASS, 'zyh_sso', newSession, {
      sourceProviderId: CAMPUS_AUTH_PROVIDER_ZYH,
      sourceCredentialId: 9,
      rotateVersion: false,
    });

    campusAuth.getActiveSession.mockResolvedValueOnce({ row: { method: 'token_import', version: 5 }, payload: oldSession });
    await expect(service.ensureAuthenticated(owner())).rejects.toThrow('重新绑定');
    expect(campusAuth.markSessionInvalid).toHaveBeenCalled();
  });
});
