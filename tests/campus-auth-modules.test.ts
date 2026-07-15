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
import { renderCampusLocationActionPage } from '../src/plugins/campus-auth-core/action-page.js';
import { SecondClassHttpClient } from '../src/plugins/hbu-second-class/client.js';
import { SecondClassCache } from '../src/plugins/hbu-second-class/cache.js';
import { SecondClassReauthStore } from '../src/plugins/hbu-second-class/reauth-store.js';
import {
  HbuSecondClassAuthProvider,
  HbuSecondClassService,
  SecondClassReauthRequiredError,
} from '../src/plugins/hbu-second-class/service.js';
import {
  buildSecondClassCreditsView,
  collectRadarPoints,
  collectTranscriptRows,
  renderSecondClassCreditsHtml,
} from '../src/plugins/hbu-second-class/render.js';
import {
  apply as applySecondClass,
  buildSecondClassReauthReply,
  parseSecondClassCommand,
  secondClassCaptchaImage,
  shouldExposeSecondClassCapabilityReference,
} from '../src/plugins/hbu-second-class/index.js';
import { SecondClassApiError, SecondClassSessionExpiredError } from '../src/plugins/hbu-second-class/types.js';
import { VersionedJsonCache } from '../src/plugins/shared/versioned-json-cache.js';
import { apply as applyZyh, parseZyhCommand, shouldExposeZyhCapabilityReference } from '../src/plugins/zyh/index.js';
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

type CampusModuleMiddleware = (session: Record<string, any>, next: () => Promise<unknown>) => Promise<unknown>;

function createCampusModuleHarness() {
  let middleware: CampusModuleMiddleware | undefined;
  const nativeFeatureChat = {
    registerCapability: vi.fn(() => () => undefined),
    sendReply: vi.fn(async (_session: unknown, _payload: unknown) => undefined),
  };
  const campusAuth = {
    registerProvider: vi.fn(() => () => undefined),
    registerLocationActionProvider: vi.fn(() => () => undefined),
    registerLifecycleListener: vi.fn(() => () => undefined),
  };
  const ctx: Record<string, any> = {
    model: { extend: vi.fn() },
    database: createDatabase(),
    campusAuth,
    nativeFeatureChat,
    puppeteer: {},
    middleware: vi.fn((handler: CampusModuleMiddleware) => { middleware = handler; }),
    on: vi.fn(),
  };
  return {
    ctx,
    nativeFeatureChat,
    middleware: () => {
      if (!middleware) throw new Error('campus module middleware was not registered.');
      return middleware;
    },
  };
}

function groupSession(content: string, groupId = '100'): Record<string, any> {
  return {
    platform: 'onebot',
    userId: '10001',
    channelId: groupId,
    guildId: groupId,
    isDirect: false,
    content,
    stripped: { content, atSelf: true },
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
    {
      publicBaseUrl: 'https://bind.example',
      bindPagePath: '/campus/bind',
      bindTokenTtlMs: 600_000,
      actionPagePath: '/campus/action',
      actionTokenTtlMs: 300_000,
      maxBindingAttempts,
    },
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
      sourceProviderId: null,
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
    ['managed_credentials', CAMPUS_AUTH_PROVIDER_SECOND_CLASS],
    ['direct_credentials', CAMPUS_AUTH_PROVIDER_SECOND_CLASS],
    ['token_import', CAMPUS_AUTH_PROVIDER_SECOND_CLASS],
  ] as const)('persists %s only after the six-digit confirmation', async (method, providerId) => {
    const { service, database } = createAuthService();
    service.registerProvider(provider(CAMPUS_AUTH_PROVIDER_ZYH, ['managed_credentials', 'session_credentials', 'session_import']));
    service.registerProvider(provider(CAMPUS_AUTH_PROVIDER_SECOND_CLASS, ['managed_credentials', 'direct_credentials', 'token_import']));
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

  it('keeps independent 二课 sessions when 志愿汇 is unbound', async () => {
    const { service } = createAuthService();
    service.registerProvider(provider(CAMPUS_AUTH_PROVIDER_ZYH, ['session_import']));
    service.registerProvider(provider(CAMPUS_AUTH_PROVIDER_SECOND_CLASS, ['token_import']));
    const identity = owner('2');
    await bind(service, identity, CAMPUS_AUTH_PROVIDER_ZYH, 'session_import');
    await bind(service, identity, CAMPUS_AUTH_PROVIDER_SECOND_CLASS, 'token_import');
    await service.unbind(identity, CAMPUS_AUTH_PROVIDER_ZYH);
    expect(await service.getActiveSession(identity.ownerKey, CAMPUS_AUTH_PROVIDER_SECOND_CLASS)).not.toBeNull();
  });

  it('keeps account state after failure while clearing secrets and stale captcha values', () => {
    const html = renderCampusBindPage({
      providerLabel: '志愿汇', qqUserId: '10001', token: 'one-time-token', submitPath: '/campus/bind/submit', state: 'form',
      message: '<账号验证失败>',
      selectedMethod: 'managed_credentials',
      submittedFields: {
        username: 'student<123>',
        password: 'fixture-password',
        captchaCode: 'expired-captcha',
        captchaUuid: 'tampered-uuid',
        persistConsent: 'yes',
      },
      methods: [
        {
          id: 'managed_credentials', label: '托管', description: '描述', fields: [
            { name: 'username', label: '账号', type: 'text', required: true },
            { name: 'password', label: '密码', type: 'password', required: true },
            { name: 'captchaCode', label: '验证码', type: 'captcha', required: true },
            { name: 'captchaUuid', label: '', type: 'hidden', value: 'fresh-server-uuid' },
            { name: 'persistConsent', label: '保存密码', type: 'checkbox', required: true },
          ],
        },
        { id: 'session_credentials', label: '单次登录', description: '描述', fields: [] },
      ],
    });
    expect(html).toContain('&lt;账号验证失败&gt;');
    expect(html).toContain('name="username" type="text" value="student&lt;123&gt;"');
    expect(html).toContain('name="method" value="managed_credentials" checked');
    expect(html).toContain('name="persistConsent" value="yes" required checked');
    expect(html).toContain('name="captchaUuid" value="fresh-server-uuid"');
    expect(html).not.toContain('fixture-password');
    expect(html).not.toContain('expired-captcha');
    expect(html).not.toContain('tampered-uuid');
  });

  it('renders a copy button on the verified binding page', () => {
    const html = renderCampusBindPage({
      providerLabel: '志愿汇', qqUserId: '10001', state: 'verified', confirmCommand: '志愿汇确认 123456',
    });
    expect(html).toContain('data-copy-confirm-command');
    expect(html).toContain('data-copy-text="志愿汇确认 123456"');
    expect(html).toContain('复制确认消息');
    expect(html).toContain('navigator.clipboard.writeText');
  });

  it('collects location through the browser API without exposing coordinate inputs', () => {
    const html = renderCampusLocationActionPage({
      providerLabel: '志愿汇',
      token: 'one-time-token',
      preparePath: '/campus/action/prepare',
      commitPath: '/campus/action/commit',
      state: 'locate',
    });
    expect(html).toContain('navigator.geolocation.getCurrentPosition');
    expect(html).toContain('enableHighAccuracy:true');
    expect(html).toContain('name="latitude"');
    expect(html).toContain('name="longitude"');
    expect(html).not.toContain('type="text" name="latitude"');
    expect(html).not.toContain('type="text" name="longitude"');
  });

  it('redacts credential, token, captcha, and bearer values from diagnostics', () => {
    const value = diagnostic(new Error('password=plain Authorization:auth-token token=api-token captcha=1234 Bearer bearer-token'));
    expect(value).not.toContain('plain');
    expect(value).not.toContain('auth-token');
    expect(value).not.toContain('api-token');
    expect(value).not.toContain('1234');
    expect(value).not.toContain('bearer-token');
  });

  it('encrypts location-action payloads and commits a one-time action exactly once', async () => {
    const { service, database } = createAuthService();
    const prepare = vi.fn(async ({ payload }: { payload: unknown }) => ({
      title: '测试活动',
      actionLabel: '签到',
      details: ['距签到点 10 米'],
      payload: { activityId: 'activity-1', received: payload },
    }));
    const commit = vi.fn(async () => ({ message: '测试活动签到成功。' }));
    service.registerLocationActionProvider({
      id: CAMPUS_AUTH_PROVIDER_SECOND_CLASS,
      label: '河北大学二课',
      prepare,
      commit,
    });
    const started = await service.startLocationAction(owner(), CAMPUS_AUTH_PROVIDER_SECOND_CLASS, 'sign_in', { code: '123456' });
    const token = new URL(started.link).searchParams.get('token')!;
    const storedBefore = JSON.stringify(database.tables.get('campus_location_action_challenge'));
    expect(storedBefore).not.toContain('123456');
    expect(storedBefore).not.toContain(token);

    await service.prepareLocationAction(token, { latitude: 38.8, longitude: 115.5, accuracy: 15 });
    const ready = await service.resolveLocationActionPage(token);
    expect(ready).toMatchObject({ state: 'ready', prepared: { title: '测试活动', actionLabel: '签到' } });
    await expect(service.prepareLocationAction(token, { latitude: 38.8, longitude: 115.5, accuracy: 15 })).rejects.toThrow('状态已经变化');
    await expect(service.commitLocationAction(token, { latitude: 38.8, longitude: 115.5, accuracy: 10 })).resolves.toBe('测试活动签到成功。');
    await expect(service.commitLocationAction(token, { latitude: 38.8, longitude: 115.5, accuracy: 10 })).rejects.toThrow('已失效');
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    const storedAfter = JSON.stringify(database.tables.get('campus_location_action_challenge'));
    expect(storedAfter).not.toContain('123456');
    expect(storedAfter).not.toContain('activity-1');
  });

  it('makes an indeterminate remote submission terminal so it cannot be replayed', async () => {
    const { service } = createAuthService();
    const commit = vi.fn(async () => { throw new TypeError('network response lost'); });
    service.registerLocationActionProvider({
      id: CAMPUS_AUTH_PROVIDER_ZYH,
      label: '志愿汇',
      prepare: async () => ({ title: '测试活动', actionLabel: '签到', details: [], payload: { activityId: '1' } }),
      commit,
    });
    const started = await service.startLocationAction(owner(), CAMPUS_AUTH_PROVIDER_ZYH, 'sign_in', { code: 'ABC123' });
    const token = new URL(started.link).searchParams.get('token')!;
    await service.prepareLocationAction(token, { latitude: 38.8, longitude: 115.5, accuracy: 15 });
    await expect(service.commitLocationAction(token, { latitude: 38.8, longitude: 115.5, accuracy: 10 })).rejects.toThrow('官方 App');
    const page = await service.resolveLocationActionPage(token);
    expect(page).toMatchObject({ state: 'completed', challenge: { status: 'uncertain' } });
    await expect(service.commitLocationAction(token, { latitude: 38.8, longitude: 115.5, accuracy: 10 })).rejects.toThrow('已失效');
    expect(commit).toHaveBeenCalledTimes(1);
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

  it('uses the official location sign-in and sign-out H5 contracts', async () => {
    const requests: Array<{ url: string; body: string }> = [];
    let state: 'in' | 'out' = 'in';
    const client = new ZyhHttpClient(async (request) => {
      requests.push(request);
      const body = new URLSearchParams(request.body);
      if (body.get('api') === 'activity/isSignForApp') {
        return {
          status: 200,
          headers: new Headers(),
          text: JSON.stringify(state === 'in'
            ? { errCode: '0000', data: { status: 1 } }
            : { errCode: '0000', data: { status: 2, card_activityid: 'card-1', sign_time: '08:00' } }),
        };
      }
      if (body.get('api') === 'activity/detailRevampedForApp') {
        return {
          status: 200,
          headers: new Headers(),
          text: JSON.stringify({ errCode: '0000', data: {
            card_activityid: 'activity-1', title: '测试志愿活动', status: 2, isface: 0,
            position: [{ earth_lat: '38.8', earth_lng: '115.5', range: '100', address: '河北大学' }],
          } }),
        };
      }
      return { status: 200, headers: new Headers(), text: JSON.stringify({ errCode: '0000' }) };
    });
    const session = { authorization: 'at', userId: 'user-1', platformId: '3' };
    const signInState = await client.getSignState(session);
    const activity = await client.getSignActivity(session, signInState, '123456', { latitude: 38.8, longitude: 115.5 });
    await client.submitSign(session, 'sign_in', activity, '123456', { latitude: 38.8, longitude: 115.5 });
    state = 'out';
    const signOutState = await client.getSignState(session);
    await client.getSignActivity(session, signOutState, '', { latitude: 38.8, longitude: 115.5 });
    await client.submitSign(session, 'sign_out', activity, '123456', { latitude: 38.8, longitude: 115.5 });

    expect(requests.every((request) => request.url === 'https://appapi.zyh365.com/common/api-public?app_id=h5')).toBe(true);
    const bodies = requests.map((request) => new URLSearchParams(request.body));
    expect(bodies[1]?.get('activity_code')).toBe('123456');
    expect(bodies[4]?.get('card_activityid')).toBe('card-1');
    expect(bodies[2]?.get('api')).toBe('activity/signIn');
    expect(bodies[2]?.get('type')).toBe('1');
    expect(bodies[5]?.get('api')).toBe('activity/sign');
    expect(bodies[5]?.get('type')).toBe('2');
    expect(bodies[5]?.get('activityCode')).toBe('123456');
  });
});

describe('河北大学二课 protocol client', () => {
  it('offers managed renewal, one-time account, and Token binding methods', async () => {
    const directLogin = vi.fn(async () => ({
      token: 'token', schoolId: '1101092545313637006', schoolName: '河北大学', studentNo: '2026000001', accountName: '学生',
    }));
    const provider = new HbuSecondClassAuthProvider({
      getCaptcha: vi.fn(async () => ({ uuid: 'captcha-uuid', imageDataUrl: 'data:image/png;base64,fixture' })),
      directLogin,
    } as never);
    const methods = await provider.getBindingMethods();
    expect(methods.map((method) => method.id)).toEqual(['managed_credentials', 'direct_credentials', 'token_import']);
    const result = await provider.authenticate({
      identity: owner(),
      method: 'managed_credentials',
      fields: { loginName: '2026000001', password: 'secret', captchaCode: 'a1b2', captchaUuid: 'captcha-uuid', persistConsent: 'yes' },
    });
    expect(result.credentialPayload).toEqual({ loginName: '2026000001', password: 'secret' });
    expect(directLogin).toHaveBeenCalledWith({ loginName: '2026000001', password: 'secret', captchaCode: 'a1b2', captchaUuid: 'captcha-uuid' });
  });

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

  it('treats HTTP and envelope 401 responses as expired sessions', async () => {
    const httpClient = new SecondClassHttpClient(async () => ({ status: 401, text: JSON.stringify({ code: 401, msg: 'expired' }) }));
    await expect(httpClient.importToken('expired')).rejects.toBeInstanceOf(SecondClassSessionExpiredError);
  });

  it('preflights a reused sign code, loads configured locations, and calls the matching endpoint', async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = [];
    const client = new SecondClassHttpClient(async (request) => {
      const path = new URL(request.url).pathname;
      requests.push({ path, method: request.method, body: request.body });
      if (path.includes('/getByCode/v2/')) {
        return { status: 200, text: JSON.stringify({ code: 200, data: {
          id: 'activity-1', activityName: '测试二课活动', activityType: 1, locationOpenStatus: 1, activitySignCode: { type: 0 },
        } }) };
      }
      if (path.includes('/editDetail/')) {
        return { status: 200, text: JSON.stringify({ code: 200, data: {
          signAddressList: [{ latitude: '38.8', longitude: '115.5', radius: '100', address: '河北大学' }],
        } }) };
      }
      return { status: 200, text: JSON.stringify({ code: 200, message: '成功', data: { signType: 0 } }) };
    });
    const info = await client.getSignCodeInfo('token', '123456');
    expect(info).toMatchObject({ activityId: 'activity-1', operation: 'sign_in', locationRequired: true });
    expect(await client.getSignLocations('token', info.activityId)).toEqual([
      { latitude: 38.8, longitude: 115.5, radius: 100, address: '河北大学' },
    ]);
    await client.submitSignCode('token', info, '123456');
    expect(requests.map((request) => request.path)).toEqual([
      '/app/h5/activity/getByCode/v2/123456',
      '/app/h5/activity/editDetail/activity-1',
      '/app/h5/tBizSignActivity/signOrSignOut',
    ]);
    expect(JSON.parse(requests[2]!.body!)).toEqual({ code: '123456' });
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
    expect(parseZyhCommand('志愿汇签到 123456')).toEqual({ kind: 'sign_in', code: '123456' });
    expect(parseZyhCommand('志愿汇签退')).toEqual({ kind: 'sign_out_help' });
    expect(parseZyhCommand('志愿汇签退 123456')).toEqual({ kind: 'sign_out', code: '123456' });
    expect(parseSecondClassCommand('二课成绩单 2025-2026-2')).toEqual({ kind: 'transcript', semester: '2025-2026-2' });
    expect(parseSecondClassCommand('二课确认 654321')).toEqual({ kind: 'confirm', code: '654321' });
    expect(parseSecondClassCommand('二课确认 abcdef')).toBeNull();
    expect(parseSecondClassCommand('二课验证')).toEqual({ kind: 'reauth_request' });
    expect(parseSecondClassCommand('二课验证 a1B2')).toEqual({ kind: 'reauth_submit', code: 'a1B2' });
    expect(parseSecondClassCommand('二课验证 1234!')).toBeNull();
    expect(parseSecondClassCommand('二课签到 123456')).toEqual({ kind: 'sign_in', code: '123456' });
    expect(parseSecondClassCommand('二课签退 123456')).toEqual({ kind: 'sign_out', code: '123456' });
  });

  it('allows 二课签到 and 签退 in console-enabled groups and rejects unlisted groups', async () => {
    const harness = createCampusModuleHarness();
    applySecondClass(harness.ctx as never, { allowedGroups: '100', naturalTriggerEnabled: false });
    const signWithCode = vi.spyOn(harness.ctx.hbuSecondClass as HbuSecondClassService, 'signWithCode')
      .mockResolvedValue({ message: '二课操作成功。' });
    const middleware = harness.middleware();

    await middleware(groupSession('二课签到 123456'), async () => undefined);
    await middleware(groupSession('二课签退 123456'), async () => undefined);
    expect(signWithCode.mock.calls.map((call) => call.slice(1))).toEqual([
      ['sign_in', '123456'],
      ['sign_out', '123456'],
    ]);

    await middleware(groupSession('二课签到 123456', '200'), async () => undefined);
    expect(signWithCode).toHaveBeenCalledTimes(2);
    expect(harness.nativeFeatureChat.sendReply.mock.lastCall?.[1]).toMatchObject({ reply: '当前群未开启二课功能。' });
  });

  it('allows 志愿汇签到 and 签退 in console-enabled groups and rejects unlisted groups', async () => {
    const harness = createCampusModuleHarness();
    applyZyh(harness.ctx as never, { allowedGroups: '100', naturalTriggerEnabled: false });
    const startSignAction = vi.spyOn(harness.ctx.zyh as ZyhService, 'startSignAction')
      .mockResolvedValue({ link: 'https://action.example/once', expiresAt: 300_000 });
    const middleware = harness.middleware();

    await middleware(groupSession('志愿汇签到 123456'), async () => undefined);
    await middleware(groupSession('志愿汇签退 123456'), async () => undefined);
    expect(startSignAction.mock.calls.map((call) => call.slice(1))).toEqual([
      ['sign_in', '123456'],
      ['sign_out', '123456'],
    ]);

    await middleware(groupSession('志愿汇签退 123456', '200'), async () => undefined);
    expect(startSignAction).toHaveBeenCalledTimes(2);
    expect(harness.nativeFeatureChat.sendReply.mock.lastCall?.[1]).toMatchObject({ reply: '当前群未开启志愿汇功能。' });
  });

  it('converts a captcha data URL into a chat image fragment', () => {
    const encoded = Buffer.from('captcha-image').toString('base64');
    const image = secondClassCaptchaImage({ uuid: 'uuid', imageDataUrl: `data:image/png;base64,${encoded}` }) as unknown as { type: string; attrs: { source: Buffer; mime: string } };
    expect(image.type).toBe('image');
    expect(image.attrs.mime).toBe('image/png');
    expect(image.attrs.source.equals(Buffer.from('captcha-image'))).toBe(true);
  });

  it('builds an addressed chat reply with the captcha image and verification command', () => {
    const reply = buildSecondClassReauthReply('10001', {
      message: '请输入验证码。',
      captcha: { uuid: 'uuid', imageDataUrl: 'data:image/png;base64,Y2FwdGNoYQ==' },
      expiresAt: 310_000,
    }, 10_000) as unknown as Array<{ type: string; attrs: Record<string, unknown> }>;
    expect(reply.map((part) => part.type)).toEqual(['at', 'text', 'image', 'text']);
    expect(reply[0]?.attrs.id).toBe('10001');
    expect(reply[2]?.attrs.mime).toBe('image/png');
    expect(reply[3]?.attrs.content).toContain('5 分钟内回复：二课验证 <验证码>');
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

  it('renders every nested 二课 credit category with points and recognized-credit targets', () => {
    const leaf = (categoryName: string, actualCredit: number, requiredCredit: number, actualCreditScore: number, requiredCreditScore: number) => ({
      categoryName,
      evaluationRule: 0,
      qualified: null,
      actualCredit,
      requiredCredit,
      actualCreditScore,
      requiredCreditScore,
      invalidCredit: 0,
      childList: null,
    });
    const data = {
      oneScore: 185.5,
      twoScore: 46.375,
      invalidScore: 0,
      creditCategoryDetailsList: [
        {
          ...leaf('必修Ⅰ', 173.5, 160, 43.375, 40),
          evaluationRule: 1,
          childList: [
            leaf('思想成长', 24, 40, 6, 10),
            leaf('社会实践', 16, 40, 4, 10),
            leaf('志愿公益', 57.5, 40, 14.375, 10),
            leaf('创新创业', 76, 40, 19, 10),
          ],
        },
        {
          ...leaf('选修', 12, 60, 3, 15),
          childList: [
            leaf('文体活动', 3, 0, 0.75, 0),
            leaf('工作履历', 0, 0, 0, 0),
            leaf('技能特长', 9, 0, 2.25, 0),
          ],
        },
        {
          ...leaf('必修Ⅱ', 0, 20, 0, 5),
          evaluationRule: 1,
          childList: [leaf('德育答辩', 0, 20, 0, 5)],
        },
      ],
    };

    const view = buildSecondClassCreditsView(data);
    expect(view).toMatchObject({ earnedPoints: 185.5, earnedCredits: 46.375, invalidPoints: 0 });
    expect(view.categories.flatMap((category) => category.children.map((child) => child.name))).toEqual([
      '思想成长', '社会实践', '志愿公益', '创新创业', '文体活动', '工作履历', '技能特长', '德育答辩',
    ]);
    expect(view.categories[0]).toMatchObject({ name: '必修Ⅰ', earnedCredits: 43.375, requiredCredits: 40 });

    const html = renderSecondClassCreditsHtml(view);
    expect(html).toContain('46.375');
    expect(html).toContain('43.375');
    expect(html).toContain('共 8 个细分项');
    expect(html).toContain('0 / 3 个要求组已达标');
    expect(html).toContain('2 / 4 个必修子项达标');
    for (const categoryName of ['思想成长', '社会实践', '志愿公益', '创新创业', '文体活动', '工作履历', '技能特长', '德育答辩']) {
      expect(html).toContain(categoryName);
    }
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

  it('requires rebinding when a 二课 session expires', async () => {
    const database = createDatabase();
    const oldSession = { token: 'expired', schoolId: '1101092545313637006', schoolName: '河北大学', studentNo: '2026000001', accountName: '学生' };
    const campusAuth = {
      getActiveSession: vi.fn(async () => ({ row: { method: 'direct_credentials', version: 4 }, payload: oldSession })),
      markSessionValidated: vi.fn(async () => undefined),
      markSessionInvalid: vi.fn(async () => undefined),
    };
    const client = {
      getUserInfo: vi.fn(async () => { throw new SecondClassSessionExpiredError(); }),
    };
    const service = new HbuSecondClassService(
      campusAuth as never,
      client as never,
      new SecondClassCache(database as never),
      new SecondClassReauthStore(database as never),
    );
    await expect(service.ensureAuthenticated(owner())).rejects.toThrow('重新绑定');
    expect(campusAuth.markSessionInvalid).toHaveBeenCalledWith(owner().ownerKey, CAMPUS_AUTH_PROVIDER_SECOND_CLASS, 'session_expired');

    campusAuth.getActiveSession.mockResolvedValueOnce({ row: { method: 'token_import', version: 5 }, payload: oldSession });
    await expect(service.ensureAuthenticated(owner())).rejects.toThrow('重新绑定');
    expect(campusAuth.markSessionInvalid).toHaveBeenCalled();
  });

  it('issues a chat captcha and renews a managed 二课 session without rotating its cache version', async () => {
    const database = createDatabase();
    const oldSession = { token: 'expired', schoolId: '1101092545313637006', schoolName: '河北大学', studentNo: '2026000001', accountName: '学生' };
    const freshSession = { ...oldSession, token: 'fresh' };
    const credential = { row: { id: 12, method: 'managed_credentials' }, payload: { loginName: '2026000001', password: 'secret' } };
    const campusAuth = {
      getActiveSession: vi.fn(async () => ({ row: { method: 'managed_credentials', version: 8 }, payload: oldSession })),
      getActiveCredential: vi.fn(async () => credential),
      replaceSession: vi.fn(async () => ({ row: { method: 'managed_credentials', version: 8 }, payload: freshSession })),
      markSessionValidated: vi.fn(async () => undefined),
      markSessionInvalid: vi.fn(async () => undefined),
      markCredentialUsed: vi.fn(async () => undefined),
      markCredentialFailure: vi.fn(async () => undefined),
    };
    const client = {
      getUserInfo: vi.fn(async () => { throw new SecondClassSessionExpiredError(); }),
      getCaptcha: vi.fn(async () => ({ uuid: 'captcha-uuid', imageDataUrl: 'data:image/png;base64,Y2FwdGNoYQ==' })),
      directLogin: vi.fn(async () => freshSession),
    };
    const store = new SecondClassReauthStore(database as never, () => 10_000);
    const service = new HbuSecondClassService(campusAuth as never, client as never, new SecondClassCache(database as never), store);

    let required: unknown;
    try {
      await service.ensureAuthenticated(owner());
    } catch (error) {
      required = error;
    }
    expect(required).toBeInstanceOf(SecondClassReauthRequiredError);
    expect((required as SecondClassReauthRequiredError).prompt.captcha.uuid).toBe('captcha-uuid');
    expect(database.tables.get('hbu_second_class_reauth')).toEqual([
      expect.objectContaining({ ownerKey: owner().ownerKey, credentialId: 12, captchaUuid: 'captcha-uuid', status: 'waiting' }),
    ]);
    expect(JSON.stringify(database.tables.get('hbu_second_class_reauth'))).not.toContain('secret');

    const renewed = await service.completeReauth(owner(), 'a1B2');
    expect(renewed).toEqual({ session: freshSession, sessionVersion: 8 });
    expect(client.directLogin).toHaveBeenCalledWith({ loginName: '2026000001', password: 'secret', captchaCode: 'a1B2', captchaUuid: 'captcha-uuid' });
    expect(campusAuth.replaceSession).toHaveBeenCalledWith(owner(), CAMPUS_AUTH_PROVIDER_SECOND_CLASS, 'managed_credentials', freshSession, { sourceCredentialId: 12, rotateVersion: false });
    expect(campusAuth.markCredentialUsed).toHaveBeenCalledWith(12);
    expect(database.tables.get('hbu_second_class_reauth')).toEqual([]);
  });

  it('accepts a 二课 captcha only in the originating chat and before expiry', async () => {
    const database = createDatabase();
    let now = 20_000;
    const store = new SecondClassReauthStore(database as never, () => now);
    await store.replace(owner(), 3, 'uuid');
    expect(await store.claim(owner('10001', 'private:other'))).toBeNull();
    expect(await store.getWaiting(owner().ownerKey)).toEqual(expect.objectContaining({ status: 'waiting', captchaUuid: 'uuid' }));
    now += 5 * 60_000;
    expect(await store.getWaiting(owner().ownerKey)).toBeNull();
    expect(database.tables.get('hbu_second_class_reauth')).toEqual([]);
  });

  it('replaces a rejected 二课 captcha while retaining the managed credential reference', async () => {
    const database = createDatabase();
    const credential = { row: { id: 5, method: 'managed_credentials' }, payload: { loginName: '2026000001', password: 'secret' } };
    const campusAuth = {
      getActiveCredential: vi.fn(async () => credential),
      markCredentialFailure: vi.fn(async () => undefined),
    };
    const client = {
      getCaptcha: vi
        .fn()
        .mockResolvedValueOnce({ uuid: 'first-uuid', imageDataUrl: 'data:image/png;base64,Zmlyc3Q=' })
        .mockResolvedValueOnce({ uuid: 'second-uuid', imageDataUrl: 'data:image/png;base64,c2Vjb25k' }),
      directLogin: vi.fn(async () => { throw new SecondClassApiError('验证码错误。', 400, 200); }),
    };
    const store = new SecondClassReauthStore(database as never, () => 30_000);
    const service = new HbuSecondClassService(campusAuth as never, client as never, new SecondClassCache(database as never), store);
    await service.beginReauth(owner());

    let required: unknown;
    try {
      await service.completeReauth(owner(), 'wrong');
    } catch (error) {
      required = error;
    }
    expect(required).toBeInstanceOf(SecondClassReauthRequiredError);
    expect((required as SecondClassReauthRequiredError).prompt.captcha.uuid).toBe('second-uuid');
    expect(await store.getWaiting(owner().ownerKey)).toEqual(expect.objectContaining({ credentialId: 5, captchaUuid: 'second-uuid' }));
  });
});
