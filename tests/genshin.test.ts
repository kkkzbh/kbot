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
  };

  const createSchemaNode = (): MockSchemaNode => ({
    default: () => createSchemaNode(),
    description: () => createSchemaNode(),
    role: () => createSchemaNode(),
  });

  class MockLogger {
    info(): void {}
    warn(): void {}
  }

  const hFactory = {
    text: (content: string) => ({
      type: 'text',
      attrs: { content },
      children: [],
      toString: () => content,
    }),
    at: (id: string) => ({
      type: 'at',
      attrs: { id },
      children: [],
      toString: () => `<at id="${id}"/>`,
    }),
    image: (source: Buffer | string, mime?: string) => ({
      type: 'image',
      attrs: { source, mime },
      children: [],
      toString: () => `[image:${mime ?? 'unknown'}]`,
    }),
  };

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
    },
    h: hFactory,
  };
});

import { apply } from '../src/plugins/genshin/index.js';
import { parseGenshinCookieInput } from '../src/plugins/genshin/cookie.js';
import {
  buildGenshinMenuView,
  GenshinMenuService,
  renderGenshinMenuImage,
} from '../src/plugins/genshin/menu.js';
import { GenshinService } from '../src/plugins/genshin/service.js';
import { GenshinStore } from '../src/plugins/genshin/store.js';
import { GenshinTakumiClient } from '../src/plugins/genshin/takumi-client.js';
import { loadOrCreateKek } from '../src/plugins/shared/credential-crypto.js';
import type {
  DatabaseLike,
  GenshinGameRole,
  OwnerIdentity,
} from '../src/plugins/genshin/types.js';
import { renderGenshinBindPage } from '../src/plugins/genshin/web/bind-page.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-genshin-'));
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

function identity(overrides: Partial<OwnerIdentity> = {}): OwnerIdentity {
  return {
    ownerKey: 'onebot:1405359129',
    platform: 'onebot',
    qqUserId: '1405359129',
    channelId: 'private:1405359129',
    ...overrides,
  };
}

function role(overrides: Partial<GenshinGameRole> = {}): GenshinGameRole {
  return {
    uid: '100000001',
    region: 'cn_gf01',
    regionName: '天空岛',
    nickname: '旅行者',
    level: 60,
    gameBiz: 'hk4e_cn',
    ...overrides,
  };
}

function extractToken(link: string): string {
  return new URL(link).searchParams.get('token') ?? '';
}

function cookieText(): string {
  return 'stoken=v2_secret; mid=mid_secret; account_id=123456; cookie_token=token_secret; ltuid_v2=123456';
}

function webCookieText(): string {
  return 'ltoken=legacy_ltoken; ltuid=123456; ltoken_v2=v2_ltoken; ltmid_v2=mid_v2; account_id_v2=123456; account_mid_v2=mid_v2; cookie_token_v2=token_v2';
}

function createService(options: {
  database?: ReturnType<typeof createDatabase>;
  roles?: GenshinGameRole[];
  signIn?: ReturnType<typeof vi.fn>;
  redeemCode?: ReturnType<typeof vi.fn>;
  now?: () => number;
} = {}) {
  const dir = createTempDir();
  const database = options.database ?? createDatabase();
  const client = {
    listRoles: vi.fn(async () => options.roles ?? [role()]),
    signIn: options.signIn ?? vi.fn(async () => ({ status: 'ok', retcode: 0, message: 'OK', totalSignDay: 8 })),
    redeemCode: options.redeemCode ?? vi.fn(async () => ({ retcode: 0, message: 'OK' })),
  };
  const service = new GenshinService(
    new GenshinStore(database as unknown as DatabaseLike),
    client as unknown as GenshinTakumiClient,
    loadOrCreateKek(join(dir, 'kek.key')),
    {
      bindPagePath: '/genshin/bind',
      publicBaseUrl: 'https://genshin.example',
      bindTokenTtlMs: 600_000,
      timezone: 'Asia/Shanghai',
    },
    options.now ?? (() => 1_000),
  );
  return { service, database, client };
}

function createPuppeteerHarness() {
  let navigatedHtml = '';
  const screenshotPng = createHarnessPng();
  const element = {
    boundingBox: vi.fn(async () => ({ x: 0, y: 0, width: 1320, height: 820 })),
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

function renderMessageContent(content: unknown): string {
  if (Array.isArray(content)) return content.map((part) => String(part)).join('');
  return String(content ?? '');
}

function extractAtIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part): part is { type: string; attrs?: { id?: string } } => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'at')
    .map((part) => String(part.attrs?.id ?? ''))
    .filter(Boolean);
}

describe('genshin cookie parser', () => {
  it('extracts whitelist fields from header, JSON, and Netscape Cookie-Editor exports', () => {
    expect(parseGenshinCookieInput(cookieText())).toMatchObject({
      stoken: 'v2_secret',
      mid: 'mid_secret',
      account_id: '123456',
      cookie_token: 'token_secret',
    });

    expect(parseGenshinCookieInput(JSON.stringify([
      { name: 'ltoken_v2', value: 'v2_ltoken' },
      { name: 'ltmid_v2', value: 'mid_v2' },
      { name: 'account_id_v2', value: '123456' },
      { name: 'account_mid_v2', value: 'mid_v2' },
      { name: 'unrelated', value: 'drop-me' },
    ]))).toEqual({
      ltoken_v2: 'v2_ltoken',
      ltmid_v2: 'mid_v2',
      account_id_v2: '123456',
      account_mid_v2: 'mid_v2',
    });

    expect(parseGenshinCookieInput([
      '# Netscape HTTP Cookie File',
      '.miyoushe.com\tTRUE\t/\tTRUE\t0\tcookie_token\ttoken_secret',
      '.miyoushe.com\tTRUE\t/\tTRUE\t0\tlogin_uid\t123456',
      '.miyoushe.com\tTRUE\t/\tTRUE\t0\tltoken\tlegacy_ltoken',
    ].join('\n'))).toEqual({
      cookie_token: 'token_secret',
      login_uid: '123456',
      ltoken: 'legacy_ltoken',
    });
  });

  it('accepts web cookies for binding without requiring stoken', () => {
    expect(parseGenshinCookieInput(webCookieText())).toMatchObject({
      ltoken: 'legacy_ltoken',
      ltoken_v2: 'v2_ltoken',
      ltmid_v2: 'mid_v2',
      account_id_v2: '123456',
      account_mid_v2: 'mid_v2',
      cookie_token_v2: 'token_v2',
    });
  });

  it('requires a binding-capable login field set', () => {
    expect(() => parseGenshinCookieInput('mid=mid_secret; account_id=123456')).toThrow('缺少可用于绑定 UID 和签到的登录字段');
    expect(() => parseGenshinCookieInput('ltoken_v2=v2_ltoken; account_id_v2=123456')).toThrow('缺少可用于绑定 UID 和签到的登录字段');
    expect(() => parseGenshinCookieInput('cookie_token_v2=token_v2')).toThrow('缺少可用于绑定 UID 和签到的登录字段');
  });
});

describe('genshin binding service', () => {
  it('keeps normalized cookies encrypted while waiting for a multi-role selection', async () => {
    const roles = [role({ uid: '100000001' }), role({ uid: '100000002', region: 'cn_qd01', regionName: '世界树' })];
    const { service, database } = createService({ roles });
    const started = await service.startBinding(identity());
    const token = extractToken(started.link);

    const first = await service.submitCookie({ token, cookieText: cookieText() });

    expect(first).toMatchObject({ kind: 'role_selection', roles });
    const [challenge] = database.tables.get('genshin_bind_challenge') ?? [];
    expect(challenge).toMatchObject({ status: 'role_selecting', pendingRolesJson: JSON.stringify(roles) });
    expect(JSON.stringify(challenge)).not.toContain('v2_secret');

    const second = await service.submitCookie({ token, selectedRoleKey: '100000002:cn_qd01' });
    expect(second).toMatchObject({ kind: 'success', role: roles[1] });
    await service.confirmBinding(identity(), second.kind === 'success' ? second.confirmCode : '');

    expect(database.tables.get('genshin_credential')).toHaveLength(1);
    expect(database.tables.get('genshin_credential')?.[0]).toMatchObject({
      ownerKey: 'onebot:1405359129',
      uid: '100000002',
      region: 'cn_qd01',
      version: 1,
      revokedAt: null,
    });
    expect(JSON.stringify(database.tables.get('genshin_credential'))).not.toContain('v2_secret');
    expect(database.tables.get('genshin_bind_challenge')?.[0]).toMatchObject({
      status: 'confirmed',
      pendingCredentialCipher: null,
      selectedRoleJson: null,
    });
  });

  it('runs manual sign-in and manual redeem for the bound UID only', async () => {
    const signIn = vi.fn(async () => ({ status: 'already_done', retcode: 0, message: '今天已经签到过了。', totalSignDay: 9 }));
    const redeemCode = vi.fn(async () => ({ retcode: 0, message: 'OK' }));
    const { service, database } = createService({ signIn, redeemCode });
    const started = await service.startBinding(identity());
    const submitted = await service.submitCookie({ token: extractToken(started.link), cookieText: cookieText() });
    await service.confirmBinding(identity(), submitted.kind === 'success' ? submitted.confirmCode : '');

    await expect(service.manualSignIn(identity())).resolves.toMatchObject({
      role: { uid: '100000001' },
      status: 'already_done',
      totalSignDay: 9,
    });
    await expect(service.redeemCode(identity(), 'GENSHIN2026')).resolves.toMatchObject({
      role: { uid: '100000001' },
      status: 'ok',
    });

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(redeemCode).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ uid: '100000001' }), 'GENSHIN2026');
    expect(database.tables.get('genshin_signin_record')?.[0]).toMatchObject({
      uid: '100000001',
      trigger: 'manual',
      status: 'already_done',
      signDate: '1970-01-01',
    });
    expect(database.tables.get('genshin_redeem_record')?.[0]).toMatchObject({
      uid: '100000001',
      status: 'ok',
      retcode: 0,
    });
  });

  it('allows web-cookie binding and sign-in while rejecting redeem without stoken', async () => {
    const signIn = vi.fn(async () => ({ status: 'ok', retcode: 0, message: 'OK', totalSignDay: 9 }));
    const redeemCode = vi.fn(async () => ({ retcode: 0, message: 'OK' }));
    const { service, database } = createService({ signIn, redeemCode });
    const started = await service.startBinding(identity());
    const submitted = await service.submitCookie({ token: extractToken(started.link), cookieText: webCookieText() });
    await service.confirmBinding(identity(), submitted.kind === 'success' ? submitted.confirmCode : '');

    await expect(service.manualSignIn(identity())).resolves.toMatchObject({
      role: { uid: '100000001' },
      status: 'ok',
    });
    await expect(service.redeemCode(identity(), 'GENSHIN2026')).rejects.toThrow('当前绑定 Cookie 不包含 stoken');

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(redeemCode).not.toHaveBeenCalled();
    expect(database.tables.get('genshin_redeem_record')?.[0]).toMatchObject({
      uid: '100000001',
      status: 'failed',
      retcode: -1,
      message: expect.stringContaining('当前绑定 Cookie 不包含 stoken'),
    });
  });
});

describe('genshin menu module', () => {
  it('builds the genshin menu with currently exposed keywords', () => {
    const view = buildGenshinMenuView();

    expect(view.title).toBe('原神功能菜单');
    expect(view.subtitle).toBe('发送 原神 查看本菜单');
    expect(view.sections.map((section) => [section.title, section.items.map((item) => [item.keyword, item.description])])).toEqual([
      [
        '账号',
        [
          ['原神绑定', '绑定米游社国服原神 UID'],
          ['原神确认 <确认码>', '绑定页验证通过后确认绑定'],
          ['原神解绑', '解除当前 QQ 与原神 UID 的绑定'],
        ],
      ],
      [
        '日常',
        [
          ['原神签到', '为已绑定 UID 执行每日签到'],
          ['原神兑换 <兑换码>', '为已绑定 UID 领取兑换码奖励'],
        ],
      ],
    ]);
  });

  it('renders the menu view as a PNG image', async () => {
    const { page, puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const image = await renderGenshinMenuImage(puppeteer, buildGenshinMenuView());
    const html = getNavigatedHtml();

    expect(String(image)).toContain('image/png');
    expect(html).toContain('原神功能菜单');
    expect(html).toContain('发送 <strong>原神</strong> 查看本菜单');
    expect(html).toContain('class="panel-title">账号');
    expect(html).toContain('class="panel-title">日常');
    expect(html).toContain('原神绑定');
    expect(html).toContain('原神确认 <span class="param">&lt;确认码&gt;</span>');
    expect(html).toContain('原神兑换 <span class="param">&lt;兑换码&gt;</span>');
    expect(html).not.toContain('原神资料');
    expect(html).not.toContain('抽卡记录');
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'png' }));
  });

  it('returns a mentioned menu image without requiring authentication', async () => {
    const { puppeteer } = createPuppeteerHarness();
    const service = new GenshinMenuService(puppeteer);

    const reply = await service.queryMenu('1405359129');

    expect(extractAtIds(reply)).toEqual(['1405359129']);
    expect(renderMessageContent(reply)).toContain('image/png');
  });
});

describe('genshin takumi client', () => {
  it('sends CN role, sign-in, authkey, and redeem requests with the expected shape', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url: url.toString(), init });
      if (url.pathname === '/binding/api/getUserGameRolesByCookie') {
        return jsonResponse({ retcode: 0, message: 'OK', data: { list: [{ game_biz: 'hk4e_cn', game_uid: '100000001', region: 'cn_gf01', region_name: '天空岛', nickname: '旅行者', level: 60 }] } });
      }
      if (url.pathname === '/event/luna/info') {
        return jsonResponse({ retcode: 0, message: 'OK', data: { is_sign: false, total_sign_day: 8 } });
      }
      if (url.hostname === 'public-data-api.mihoyo.com') {
        return jsonResponse({ retcode: 0, message: 'OK', data: { code: 200, device_fp: '1234567890123' } });
      }
      if (url.pathname === '/event/luna/sign') {
        return jsonResponse({ retcode: 0, message: 'OK', data: {} });
      }
      if (url.pathname === '/binding/api/genAuthKey') {
        return jsonResponse({ retcode: 0, message: 'OK', data: { sign_type: 2, authkey_ver: 1, authkey: 'authkey-secret' } });
      }
      if (url.pathname === '/common/apicdkey/api/exchangeCdkey') {
        return jsonResponse({ retcode: 0, message: 'OK', data: {} });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new GenshinTakumiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      deviceId: '00000000-0000-4000-8000-000000000001',
      redeemGameVersion: 'CNRELWin6.0.0',
    });
    const cookies = parseGenshinCookieInput(cookieText());
    const [selectedRole] = await client.listRoles(cookies);

    await client.signIn(cookies, selectedRole);
    await client.redeemCode(cookies, selectedRole, 'GENSHIN2026');

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/binding/api/getUserGameRolesByCookie',
      '/event/luna/info',
      '/device-fp/api/getFp',
      '/event/luna/sign',
      '/binding/api/genAuthKey',
      '/common/apicdkey/api/exchangeCdkey',
    ]);
    expect(calls[0].url).toContain('game_biz=hk4e_cn');
    expect(calls[3].init.method).toBe('POST');
    expect(calls[3].init.headers).toMatchObject({
      cookie: expect.stringContaining('stoken=v2_secret'),
      'x-rpc-signgame': 'hk4e',
      ds: expect.stringMatching(/^\d+,[A-Za-z0-9]{6},[a-f0-9]{32}$/),
    });
    const redeemUrl = new URL(calls[5].url);
    expect(redeemUrl.hostname).toBe('hk4e-api.mihoyo.com');
    expect(redeemUrl.searchParams.get('auth_appid')).toBe('apicdkey');
    expect(redeemUrl.searchParams.get('authkey')).toBe('authkey-secret');
    expect(redeemUrl.searchParams.get('game_biz')).toBe('hk4e_cn');
  });
});

describe('genshin plugin routes and middleware', () => {
  it('registers tables, bind routes, and private bind middleware', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const middleware = vi.fn();
    const { puppeteer } = createPuppeteerHarness();
    const server = {
      use: vi.fn(),
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
      puppeteer,
    };

    apply(ctx as never, {
      bindPagePath: '/genshin/bind',
      publicBaseUrl: 'https://genshin.example',
      credentialKekPath: join(dir, 'kek.key'),
      autoSignEnabled: false,
      allowedGroups: '',
    });

    expect(ctx.model.extend).toHaveBeenCalledWith('genshin_bind_challenge', expect.anything(), expect.anything());
    expect(server.use).toHaveBeenCalledWith(expect.any(Function));
    expect(server.get).toHaveBeenCalledWith('/genshin/bind', expect.any(Function));
    expect(server.post).toHaveBeenCalledWith('/genshin/bind/submit', expect.any(Function));
    const guard = server.use.mock.calls[0]?.[0];
    const next = vi.fn(async () => undefined);
    const forbidden = { host: 'genshin.example', path: '/console', status: 200, body: '' };
    await guard(forbidden, next);
    expect(forbidden).toMatchObject({ status: 404, body: 'Not Found' });
    expect(next).not.toHaveBeenCalled();
    await guard({ host: 'genshin.example', path: '/genshin/bind' }, next);
    await guard({ host: 'other.example', path: '/console' }, next);
    expect(next).toHaveBeenCalledTimes(2);
    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'private:1405359129',
      isDirect: true,
      content: '原神绑定',
      send,
    }, vi.fn());

    expect(renderMessageContent(send.mock.calls[0]?.[0])).toContain('https://genshin.example/genshin/bind?token=');
    expect(database.tables.get('genshin_bind_challenge')?.[0]).toMatchObject({
      ownerKey: 'onebot:1405359129',
      channelId: 'private:1405359129',
      status: 'created',
    });
  });

  it('returns the genshin menu in allowed natural-trigger groups without creating a binding challenge', async () => {
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
      publicBaseUrl: 'https://genshin.example',
      credentialKekPath: join(dir, 'kek.key'),
      autoSignEnabled: false,
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
      content: '原神',
      send,
    }, vi.fn());

    const reply = send.mock.calls[0]?.[0];
    expect(extractAtIds(reply)).toEqual(['1405359129']);
    expect(renderMessageContent(reply)).toContain('image/png');
    expect(getNavigatedHtml()).toContain('原神功能菜单');
    expect(database.tables.get('genshin_bind_challenge') ?? []).toHaveLength(0);
  });

  it('passes bare genshin keywords through outside natural trigger groups', async () => {
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
      publicBaseUrl: 'https://genshin.example',
      credentialKekPath: join(dir, 'kek.key'),
      autoSignEnabled: false,
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
      content: '原神绑定',
      send,
    }, next);

    expect(send).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(database.tables.get('genshin_bind_challenge') ?? []).toHaveLength(0);
  });

  it('accepts explicitly mentioned genshin keywords outside natural trigger groups', async () => {
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
      publicBaseUrl: 'https://genshin.example',
      credentialKekPath: join(dir, 'kek.key'),
      autoSignEnabled: false,
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
      content: '<at id="100000001"/> 原神绑定',
      stripped: { content: '原神绑定', atSelf: true },
      send,
    }, next);

    const reply = send.mock.calls[0]?.[0];
    expect(renderMessageContent(reply)).toContain('https://genshin.example/genshin/bind?token=');
    expect(next).not.toHaveBeenCalled();
    expect(database.tables.get('genshin_bind_challenge')?.[0]).toMatchObject({
      ownerKey: 'onebot:1405359129',
      channelId: 'group:100',
      status: 'created',
    });
  });

  it('blocks genshin keywords outside allowed groups before rendering the menu', async () => {
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
      publicBaseUrl: 'https://genshin.example',
      credentialKekPath: join(dir, 'kek.key'),
      autoSignEnabled: false,
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
      content: '原神',
      send,
    }, vi.fn());

    expect(send).toHaveBeenCalledWith('当前群未开启原神功能。');
    expect(puppeteer.page).not.toHaveBeenCalled();
  });

  it('allows genshin menu in private chats regardless of the group allowlist', async () => {
    const dir = createTempDir();
    const middleware = vi.fn();
    const { puppeteer } = createPuppeteerHarness();
    const ctx = {
      baseDir: dir,
      database: createDatabase(),
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware,
      on: vi.fn(),
      puppeteer,
    };

    apply(ctx as never, {
      publicBaseUrl: 'https://genshin.example',
      credentialKekPath: join(dir, 'kek.key'),
      autoSignEnabled: false,
      allowedGroups: '',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'private:1405359129',
      isDirect: true,
      content: '原神',
      send,
    }, vi.fn());

    expect(renderMessageContent(send.mock.calls[0]?.[0])).toContain('image/png');
  });

  it('requires the genshin allowlist to be explicitly configured', () => {
    const dir = createTempDir();
    const { puppeteer } = createPuppeteerHarness();
    const ctx = {
      baseDir: dir,
      database: createDatabase(),
      model: { extend: vi.fn() },
      server: { get: vi.fn(), post: vi.fn() },
      middleware: vi.fn(),
      on: vi.fn(),
      puppeteer,
    };

    expect(() => apply(ctx as never, {
      publicBaseUrl: 'https://genshin.example',
      credentialKekPath: join(dir, 'kek.key'),
      autoSignEnabled: false,
    })).toThrow('genshin.allowedGroups 必须显式配置');
  });

  it('renders the bind page without profile or gacha features', () => {
    const html = renderGenshinBindPage({
      qq: '1405359129',
      token: 'token',
      submitPath: '/genshin/bind/submit',
    });

    expect(html).toContain('粘贴整段 Cookie');
    expect(html).toContain('Cookie-Editor');
    expect(html).toContain('米游社原神页面');
    expect(html).not.toContain('原神资料');
    expect(html).not.toContain('抽卡记录');
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
