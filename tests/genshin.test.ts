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
import {
  buildGachaRecordsView,
  GenshinGachaService,
  renderGenshinGachaRecordsImage,
} from '../src/plugins/genshin/gacha-records.js';
import {
  buildGenshinMenuView,
  GenshinMenuService,
  renderGenshinMenuImage,
} from '../src/plugins/genshin/menu.js';
import { GenshinService } from '../src/plugins/genshin/service.js';
import { credentialAad } from '../src/plugins/genshin/credential.js';
import { gachaRecordKey, GenshinStore } from '../src/plugins/genshin/store.js';
import { GenshinTakumiClient, GenshinTakumiError, type GenshinGachaLogItem } from '../src/plugins/genshin/takumi-client.js';
import { encryptEnvelopeJson, loadOrCreateKek, type CredentialKek } from '../src/plugins/shared/credential-crypto.js';
import type {
  DatabaseLike,
  GenshinCookieFields,
  GenshinCredentialPayload,
  GenshinGachaRecord,
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

function createService(options: {
  database?: ReturnType<typeof createDatabase>;
  roles?: GenshinGameRole[];
  qrResults?: Array<{ status: 'Init' | 'Scanned' | 'Confirmed' | 'Expired'; cookies?: GenshinCookieFields }>;
  signIn?: ReturnType<typeof vi.fn>;
  redeemCode?: ReturnType<typeof vi.fn>;
  createGachaAuthKey?: ReturnType<typeof vi.fn>;
  fetchGachaLogPage?: ReturnType<typeof vi.fn>;
  now?: () => number;
} = {}) {
  const dir = createTempDir();
  const database = options.database ?? createDatabase();
  const kek = loadOrCreateKek(join(dir, 'kek.key'));
  const passportCookies = { stoken: 'v2_secret', mid: 'mid_secret', account_id: '123456', login_uid: '123456', stuid: '123456' };
  const qrResults = [...(options.qrResults ?? [{ status: 'Confirmed' as const, cookies: passportCookies }])];
  const client = {
    createQrLogin: vi.fn(async () => ({ ticket: 'ticket-secret', url: 'https://user.mihoyo.com/login-platform/mobile.html?tk=ticket-secret#/login/qr' })),
    queryQrLogin: vi.fn(async () => qrResults.shift() ?? { status: 'Confirmed', cookies: passportCookies }),
    exchangeCookieToken: vi.fn(async (cookies: GenshinCookieFields) => ({ ...cookies, cookie_token: 'cookie_token_secret', account_id: '123456' })),
    listRoles: vi.fn(async () => options.roles ?? [role()]),
    signIn: options.signIn ?? vi.fn(async () => ({ status: 'ok', retcode: 0, message: 'OK', totalSignDay: 8 })),
    redeemCode: options.redeemCode ?? vi.fn(async () => ({ retcode: 0, message: 'OK' })),
    createGachaAuthKey: options.createGachaAuthKey ?? vi.fn(async () => ({ signType: 2, authkeyVer: 1, authkey: 'gacha-authkey-secret' })),
    fetchGachaLogPage: options.fetchGachaLogPage ?? vi.fn(async () => ({ list: [] })),
  };
  const service = new GenshinService(
    new GenshinStore(database as unknown as DatabaseLike),
    client as unknown as GenshinTakumiClient,
    kek,
    {
      bindPagePath: '/genshin/bind',
      publicBaseUrl: 'https://genshin.example',
      bindTokenTtlMs: 600_000,
      timezone: 'Asia/Shanghai',
    },
    options.now ?? (() => 1_000),
  );
  return { service, database, client, kek };
}

async function completeQrBinding(service: GenshinService, token: string) {
  await service.resolveBindPageChallenge(token);
  const result = await service.pollQrLogin(token);
  if (result.kind !== 'success') throw new Error(`expected successful qr binding, got ${result.kind}`);
  await service.confirmBinding(identity(), result.confirmCode);
  return result;
}

async function seedCredential(args: {
  database: ReturnType<typeof createDatabase>;
  kek: CredentialKek;
  owner?: OwnerIdentity;
  role?: GenshinGameRole;
  payload?: GenshinCredentialPayload;
}) {
  const owner = args.owner ?? identity();
  const selectedRole = args.role ?? role();
  const row = await args.database.create('genshin_credential', {
    ownerKey: owner.ownerKey,
    platform: owner.platform,
    qqUserId: owner.qqUserId,
    serviceId: 'genshin',
    uid: selectedRole.uid,
    region: selectedRole.region,
    regionName: selectedRole.regionName,
    nickname: selectedRole.nickname,
    level: selectedRole.level,
    gameBiz: selectedRole.gameBiz,
    credentialCipher: '',
    credentialMeta: '',
    kekId: args.kek.id,
    alg: 'aes-256-gcm',
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    lastUsedAt: null,
    lastFailureReason: null,
    revokedAt: null,
  });
  const envelope = encryptEnvelopeJson(
    args.payload ?? { cookies: { stoken: 'v2_secret', mid: 'mid_secret', stuid: '123456' } },
    credentialAad(owner.ownerKey, Number(row.id)),
    args.kek,
  );
  await args.database.set('genshin_credential', { id: row.id }, {
    credentialCipher: envelope.cipherText,
    credentialMeta: envelope.meta,
  });
  return row;
}

function gachaItem(overrides: Partial<GenshinGachaLogItem> = {}): GenshinGachaLogItem {
  return {
    gachaType: '301',
    itemId: '10000002',
    count: '1',
    time: '2026-07-08 19:30:00',
    name: '神里绫华',
    itemType: '角色',
    rankType: '5',
    id: '1000000000000000001',
    ...overrides,
  };
}

function gachaRecord(overrides: Partial<GenshinGachaRecord> = {}): GenshinGachaRecord {
  const base = {
    id: 1,
    recordKey: gachaRecordKey('100000001', 'cn_gf01', '1000000000000000001'),
    ownerKey: 'onebot:1405359129',
    uid: '100000001',
    region: 'cn_gf01',
    gachaType: '301' as const,
    uigfGachaType: '301' as const,
    recordId: '1000000000000000001',
    itemId: '10000002',
    name: '神里绫华',
    itemType: '角色',
    rankType: '5',
    count: '1',
    time: '2026-07-08 19:30:00',
    createdAt: 1_000,
  };
  return { ...base, ...overrides };
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

describe('genshin binding service', () => {
  it('keeps qr-derived stoken cookies encrypted while waiting for a multi-role selection', async () => {
    const roles = [role({ uid: '100000001' }), role({ uid: '100000002', region: 'cn_qd01', regionName: '世界树' })];
    const { service, database, client } = createService({ roles });
    const started = await service.startBinding(identity());
    const token = extractToken(started.link);

    const page = await service.resolveBindPageChallenge(token);
    expect(page).toMatchObject({ state: 'qr', qrUrl: 'https://user.mihoyo.com/login-platform/mobile.html?tk=ticket-secret#/login/qr' });

    const first = await service.pollQrLogin(token);

    expect(first).toMatchObject({ kind: 'role_selection', roles });
    const [challenge] = database.tables.get('genshin_bind_challenge') ?? [];
    expect(challenge).toMatchObject({ status: 'role_selecting', pendingRolesJson: JSON.stringify(roles) });
    expect(JSON.stringify(challenge)).not.toContain('v2_secret');
    expect(JSON.stringify(challenge)).not.toContain('cookie_token_secret');
    expect(client.exchangeCookieToken).toHaveBeenCalledWith({
      stoken: 'v2_secret',
      mid: 'mid_secret',
      account_id: '123456',
      login_uid: '123456',
      stuid: '123456',
    });

    const second = await service.selectRole({ token, selectedRoleKey: '100000002:cn_qd01' });
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
    expect(JSON.stringify(database.tables.get('genshin_credential'))).not.toContain('cookie_token_secret');
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
    await completeQrBinding(service, extractToken(started.link));

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

  it('tracks qr scanned state before app confirmation', async () => {
    const { service, database, client } = createService({
      qrResults: [
        { status: 'Init' },
        { status: 'Scanned' },
        { status: 'Confirmed', cookies: { stoken: 'v2_secret', mid: 'mid_secret', account_id: '123456', login_uid: '123456', stuid: '123456' } },
      ],
    });
    const started = await service.startBinding(identity());
    const token = extractToken(started.link);
    await service.resolveBindPageChallenge(token);

    await expect(service.pollQrLogin(token)).resolves.toMatchObject({ kind: 'pending' });
    await expect(service.pollQrLogin(token)).resolves.toMatchObject({ kind: 'scanned' });
    expect(database.tables.get('genshin_bind_challenge')?.[0]).toMatchObject({ status: 'qr_scanned' });

    await expect(service.pollQrLogin(token)).resolves.toMatchObject({ kind: 'success' });
    expect(client.queryQrLogin).toHaveBeenCalledTimes(3);
  });

  it('expires the binding challenge when the mihoyo qr ticket expires', async () => {
    const { service, database } = createService({
      qrResults: [{ status: 'Expired' }],
    });
    const started = await service.startBinding(identity());
    const token = extractToken(started.link);
    await service.resolveBindPageChallenge(token);

    await expect(service.pollQrLogin(token)).rejects.toThrow('二维码已过期，请重新发送“原神绑定”。');
    expect(database.tables.get('genshin_bind_challenge')?.[0]).toMatchObject({
      status: 'expired',
      qrTicket: null,
      qrUrl: null,
    });
  });
});

describe('genshin gacha records service', () => {
  it('syncs gacha records incrementally and stores per-pool sync state', async () => {
    const fetchGachaLogPage = vi.fn(async (_cookies, _role, _authKey, gachaType: string, endId: string) => {
      if (gachaType === '301' && endId === '0') {
        return {
          list: [
            gachaItem({ id: '1000000000000000003', name: '琴', time: '2026-07-08 19:32:00' }),
            gachaItem({ id: '1000000000000000002', name: '祭礼剑', itemType: '武器', rankType: '4', time: '2026-07-08 19:31:00' }),
            gachaItem({ id: '1000000000000000001', name: '飞天御剑', itemType: '武器', rankType: '3', time: '2026-07-08 19:30:00' }),
          ],
        };
      }
      return { list: [] };
    });
    const { service, database, client, kek } = createService({ fetchGachaLogPage, now: () => 1_000 });
    const started = await service.startBinding(identity());
    await completeQrBinding(service, extractToken(started.link));
    const gachaService = new GenshinGachaService(new GenshinStore(database as unknown as DatabaseLike), client as unknown as GenshinTakumiClient, kek, {
      timezone: 'Asia/Shanghai',
      requestIntervalMs: 0,
      now: () => 2_000,
    });

    const first = await gachaService.queryGachaRecords(identity());

    expect(first).toMatchObject({
      uid: '100000001',
      addedCount: 3,
      totalCount: 3,
      poolViews: expect.arrayContaining([
        expect.objectContaining({
          title: '角色活动祈愿',
          totalCount: 3,
          currentPity: 0,
          averageFivePityText: '3.0',
          historyRows: [expect.objectContaining({ name: '琴', pityCount: 3 })],
        }),
        expect.objectContaining({ title: '武器活动祈愿' }),
        expect.objectContaining({ title: '常驻祈愿' }),
      ]),
    });
    expect(database.tables.get('genshin_gacha_record')).toHaveLength(3);
    expect(database.tables.get('genshin_gacha_sync_state')).toHaveLength(6);
    expect(database.tables.get('genshin_gacha_record')?.map((row) => row.recordKey)).toContain('100000001:cn_gf01:1000000000000000003');

    fetchGachaLogPage.mockImplementation(async (_cookies, _role, _authKey, gachaType: string, endId: string) => {
      if (gachaType === '301' && endId === '0') {
        return {
          list: [
            gachaItem({ id: '1000000000000000004', name: '莫娜', time: '2026-07-08 19:33:00' }),
            gachaItem({ id: '1000000000000000003', name: '琴', time: '2026-07-08 19:32:00' }),
          ],
        };
      }
      return { list: [] };
    });

    const second = await gachaService.queryGachaRecords(identity());

    expect(second).toMatchObject({
      addedCount: 1,
      totalCount: 4,
      poolViews: expect.arrayContaining([
        expect.objectContaining({
          title: '角色活动祈愿',
          historyRows: [
            expect.objectContaining({ name: '莫娜', pityCount: 1 }),
            expect.objectContaining({ name: '琴', pityCount: 3 }),
          ],
        }),
      ]),
    });
    expect(database.tables.get('genshin_gacha_record')).toHaveLength(4);
    expect(database.tables.get('genshin_gacha_sync_state')?.find((row) => row.gachaType === '301')).toMatchObject({
      lastFetchedRecordId: '1000000000000000004',
      lastNewCount: 1,
    });
  });

  it('paces official gacha page requests across pools', async () => {
    const fetchGachaLogPage = vi.fn(async (_cookies: unknown, _role: unknown, _authKey: unknown, _gachaType: string, _endId: string) => ({ list: [] }));
    const sleep = vi.fn(async () => {});
    const { service, database, client, kek } = createService({ fetchGachaLogPage, now: () => 1_000 });
    const started = await service.startBinding(identity());
    await completeQrBinding(service, extractToken(started.link));
    const gachaService = new GenshinGachaService(new GenshinStore(database as unknown as DatabaseLike), client as unknown as GenshinTakumiClient, kek, {
      timezone: 'Asia/Shanghai',
      requestIntervalMs: 1_200,
      now: () => 2_000,
      sleep,
    });

    await gachaService.queryGachaRecords(identity());

    expect(fetchGachaLogPage).toHaveBeenCalledTimes(6);
    expect(fetchGachaLogPage.mock.calls.map((call) => call[3])).toEqual(['100', '200', '301', '400', '302', '500']);
    expect(sleep).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledWith(1_200);
  });

  it('keeps local gacha records when official pages are empty', async () => {
    const database = createDatabase({
      genshin_gacha_record: [gachaRecord()],
    });
    const fetchGachaLogPage = vi.fn(async () => ({ list: [] }));
    const { client, kek } = createService({ database, fetchGachaLogPage });
    await seedCredential({ database, kek });
    const gachaService = new GenshinGachaService(new GenshinStore(database as unknown as DatabaseLike), client as unknown as GenshinTakumiClient, kek, {
      timezone: 'Asia/Shanghai',
      requestIntervalMs: 0,
      now: () => 2_000,
    });

    const view = await gachaService.queryGachaRecords(identity());

    expect(view).toMatchObject({
      addedCount: 0,
      totalCount: 1,
      poolViews: expect.arrayContaining([
        expect.objectContaining({
          title: '角色活动祈愿',
          currentPity: 0,
          historyRows: [expect.objectContaining({ name: '神里绫华', pityCount: 1 })],
        }),
      ]),
    });
    expect(database.tables.get('genshin_gacha_record')).toHaveLength(1);
  });

  it('reports missing binding and missing advanced cookie capability', async () => {
    const database = createDatabase();
    const { client, kek } = createService({ database });
    const gachaService = new GenshinGachaService(new GenshinStore(database as unknown as DatabaseLike), client as unknown as GenshinTakumiClient, kek, {
      timezone: 'Asia/Shanghai',
      requestIntervalMs: 0,
    });

    await expect(gachaService.queryGachaRecords(identity())).rejects.toThrow('请先发送“原神绑定”完成 UID 绑定。');

    await seedCredential({ database, kek, payload: { cookies: { ltoken: 'ltoken-only' } } });
    await expect(gachaService.queryGachaRecords(identity())).rejects.toThrow('当前绑定 Cookie 不包含 stoken + mid/stuid，不能读取抽卡记录。请重新发送“原神绑定”完成扫码绑定。');
  });

  it('surfaces takumi failures without rendering stale gacha records', async () => {
    const createGachaAuthKey = vi.fn(async () => {
      throw new GenshinTakumiError('authkey 失效。', { retcode: -100, diagnostic: 'test failure' });
    });
    const database = createDatabase({
      genshin_gacha_record: [gachaRecord()],
    });
    const { client, kek } = createService({ database, createGachaAuthKey });
    await seedCredential({ database, kek });
    const gachaService = new GenshinGachaService(new GenshinStore(database as unknown as DatabaseLike), client as unknown as GenshinTakumiClient, kek, {
      timezone: 'Asia/Shanghai',
      requestIntervalMs: 0,
    });

    await expect(gachaService.queryGachaRecords(identity())).rejects.toThrow('authkey 失效。');
    expect(database.tables.get('genshin_credential')?.[0]).toMatchObject({ lastFailureReason: 'authkey 失效。' });
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
      [
        '记录',
        [
          ['抽卡记录', '同步并查看当前 UID 抽卡统计'],
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
    expect(html).toContain('class="panel-title">记录');
    expect(html).toContain('原神绑定');
    expect(html).toContain('原神确认 <span class="param">&lt;确认码&gt;</span>');
    expect(html).toContain('原神兑换 <span class="param">&lt;兑换码&gt;</span>');
    expect(html).toContain('抽卡记录');
    expect(html).not.toContain('原神资料');
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

describe('genshin gacha records renderer', () => {
  it('shows optional gacha pools only when records exist', () => {
    const emptyOptionalView = buildGachaRecordsView([gachaRecord()], {
      uid: '100000001',
      nickname: '旅行者',
      regionName: '天空岛',
      addedCount: 1,
      syncedAt: 1_788_891_000_000,
      timezone: 'Asia/Shanghai',
    });
    expect(emptyOptionalView.poolViews.map((pool) => pool.title)).toEqual(['角色活动祈愿', '武器活动祈愿', '常驻祈愿']);

    const withChronicledView = buildGachaRecordsView([
      gachaRecord(),
      gachaRecord({
        id: 2,
        recordKey: gachaRecordKey('100000001', 'cn_gf01', '1000000000000000002'),
        recordId: '1000000000000000002',
        gachaType: '500',
        uigfGachaType: '500',
        name: '集录五星',
        itemType: '角色',
        rankType: '5',
        time: '2026-07-08 19:29:00',
      }),
    ], {
      uid: '100000001',
      nickname: '旅行者',
      regionName: '天空岛',
      addedCount: 2,
      syncedAt: 1_788_891_000_000,
      timezone: 'Asia/Shanghai',
    });
    expect(withChronicledView.poolViews.map((pool) => pool.title)).toContain('集录祈愿');
    expect(withChronicledView.poolViews.find((pool) => pool.title === '集录祈愿')?.historyRows[0]).toMatchObject({
      name: '集录五星',
      badgeText: '集录',
    });
  });

  it('renders the gacha records view as a PNG image', async () => {
    const { page, puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const view = buildGachaRecordsView([
      gachaRecord(),
      gachaRecord({
        id: 2,
        recordKey: gachaRecordKey('100000001', 'cn_gf01', '1000000000000000002'),
        recordId: '1000000000000000002',
        name: '祭礼剑',
        itemType: '武器',
        rankType: '4',
        time: '2026-07-08 19:31:00',
      }),
      gachaRecord({
        id: 3,
        recordKey: gachaRecordKey('100000001', 'cn_gf01', '1000000000000000003'),
        recordId: '1000000000000000003',
        itemId: '11509',
        gachaType: '302',
        uigfGachaType: '302',
        name: '雾切之回光',
        itemType: '武器',
        rankType: '5',
        time: '2026-07-08 19:20:00',
      }),
      gachaRecord({
        id: 4,
        recordKey: gachaRecordKey('100000001', 'cn_gf01', '1000000000000000004'),
        recordId: '1000000000000000004',
        itemId: '14501',
        gachaType: '200',
        uigfGachaType: '200',
        name: '天空之卷',
        itemType: '武器',
        rankType: '5',
        time: '2026-07-08 19:10:00',
      }),
    ], {
      uid: '100000001',
      nickname: '旅行者',
      regionName: '天空岛',
      addedCount: 4,
      syncedAt: 1_788_891_000_000,
      timezone: 'Asia/Shanghai',
    });

    const image = await renderGenshinGachaRecordsImage(puppeteer, view);
    const html = getNavigatedHtml();

    expect(String(image)).toContain('image/png');
    expect(html).toContain('原神抽卡记录');
    expect(html).toContain('UID 100****01');
    expect(html).toContain('角色活动祈愿');
    expect(html).toContain('武器活动祈愿');
    expect(html).toContain('常驻祈愿');
    expect(html).not.toContain('集录祈愿');
    expect(html).not.toContain('新手祈愿');
    expect(html).toContain('data:image/svg+xml');
    expect(html).toContain('https://enka.network/ui/UI_AvatarIcon_Ayaka.png');
    expect(html).toContain('https://enka.network/ui/UI_EquipIcon_Sword_Narukami.png');
    expect(html).toContain('https://enka.network/ui/UI_EquipIcon_Catalyst_Dvalin.png');
    expect(html).toContain('已垫 1 抽');
    expect(html).toContain('神里绫华');
    expect(html).toContain('雾切之回光');
    expect(html).toContain('天空之卷');
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'png' }));
  });
});

describe('genshin takumi client', () => {
  it('sends QR login, CN role, sign-in, authkey, and redeem requests with the expected shape', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url: url.toString(), init });
      if (url.pathname === '/account/ma-cn-passport/app/createQRLogin') {
        return jsonResponse({
          retcode: 0,
          message: 'OK',
          data: {
            url: 'https://user.mihoyo.com/login-platform/mobile.html?expire=1783513587&tk=ticket-secret&token_types=1#/login/qr',
            ticket: 'ticket-secret',
          },
        });
      }
      if (url.pathname === '/account/ma-cn-passport/app/queryQRLoginStatus') {
        return jsonResponse({
          retcode: 0,
          message: 'OK',
          data: {
            status: 'Confirmed',
            tokens: [{ token_type: 1, token: 'v2_secret' }],
            user_info: { aid: '123456', mid: 'mid_secret' },
          },
        });
      }
      if (url.pathname === '/account/auth/api/getCookieAccountInfoBySToken') {
        return jsonResponse({ retcode: 0, message: 'OK', data: { uid: '123456', cookie_token: 'cookie_token_secret' } });
      }
      if (url.pathname === '/binding/api/getUserGameRolesByCookieToken') {
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
      if (url.pathname === '/gacha_info/api/getGachaLog') {
        return jsonResponse({
          retcode: 0,
          message: 'OK',
          data: {
            list: [{
              gacha_type: '301',
              count: '1',
              time: '2026-07-08 19:30:00',
              name: '神里绫华',
              item_type: '角色',
              rank_type: '5',
              id: '1000000000000000001',
            }],
          },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new GenshinTakumiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      deviceId: '00000000-0000-4000-8000-000000000001',
      redeemGameVersion: 'CNRELWin6.0.0',
    });
    const qr = await client.createQrLogin();
    const qrResult = await client.queryQrLogin(qr.ticket);
    if (qrResult.status !== 'Confirmed' || !qrResult.cookies) {
      throw new Error('expected confirmed qr result');
    }
    const cookies = await client.exchangeCookieToken(qrResult.cookies);
    const [selectedRole] = await client.listRoles(cookies);

    await client.signIn(cookies, selectedRole);
    await client.redeemCode(cookies, selectedRole, 'GENSHIN2026');
    const gachaAuthKey = await client.createGachaAuthKey(cookies, selectedRole);
    await client.fetchGachaLogPage(cookies, selectedRole, gachaAuthKey, '301', '0');

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/account/ma-cn-passport/app/createQRLogin',
      '/account/ma-cn-passport/app/queryQRLoginStatus',
      '/account/auth/api/getCookieAccountInfoBySToken',
      '/binding/api/getUserGameRolesByCookieToken',
      '/event/luna/info',
      '/device-fp/api/getFp',
      '/event/luna/sign',
      '/binding/api/genAuthKey',
      '/common/apicdkey/api/exchangeCdkey',
      '/binding/api/genAuthKey',
      '/gacha_info/api/getGachaLog',
    ]);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({});
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ ticket: 'ticket-secret' });
    expect(calls[0].init.headers).toMatchObject({
      'x-rpc-app_id': 'ddxf5dufpuyo',
      'x-rpc-client_type': '3',
      'x-rpc-device_id': '00000000-0000-4000-8000-000000000001',
      'content-type': 'application/json',
    });
    expect(calls[1].init.headers).toMatchObject({
      'x-rpc-app_id': 'ddxf5dufpuyo',
      'x-rpc-client_type': '3',
      'x-rpc-device_id': '00000000-0000-4000-8000-000000000001',
      'content-type': 'application/json',
    });
    expect(cookies).toMatchObject({ stoken: 'v2_secret', mid: 'mid_secret', stuid: '123456', cookie_token: 'cookie_token_secret' });
    expect(new URL(calls[2].url).hostname).toBe('passport-api.mihoyo.com');
    expect(new URL(calls[2].url).searchParams.get('stoken')).toBe('v2_secret');
    expect(new URL(calls[2].url).searchParams.get('uid')).toBe('123456');
    expect(calls[2].init.headers).toMatchObject({
      cookie: expect.stringContaining('stoken=v2_secret'),
    });
    expect(String((calls[2].init.headers as Record<string, string>).cookie)).toContain('mid=mid_secret');
    expect(String((calls[2].init.headers as Record<string, string>).cookie)).toContain('stuid=123456');
    expect(new URL(calls[3].url).hostname).toBe('passport-api.mihoyo.com');
    expect(calls[3].url).toContain('game_biz=hk4e_cn');
    expect(calls[3].init.headers).toMatchObject({
      cookie: 'account_id=123456; cookie_token=cookie_token_secret',
    });
    expect(calls[6].init.method).toBe('POST');
    expect(calls[6].init.headers).toMatchObject({
      cookie: expect.stringContaining('stoken=v2_secret'),
      'x-rpc-signgame': 'hk4e',
      ds: expect.stringMatching(/^\d+,[A-Za-z0-9]{6},[a-f0-9]{32}$/),
    });
    const redeemUrl = new URL(calls[8].url);
    expect(redeemUrl.hostname).toBe('hk4e-api.mihoyo.com');
    expect(redeemUrl.searchParams.get('auth_appid')).toBe('apicdkey');
    expect(redeemUrl.searchParams.get('authkey')).toBe('authkey-secret');
    expect(redeemUrl.searchParams.get('game_biz')).toBe('hk4e_cn');
    expect(JSON.parse(String(calls[7].init.body))).toMatchObject({ auth_appid: 'apicdkey' });
    expect(JSON.parse(String(calls[9].init.body))).toMatchObject({ auth_appid: 'webview_gacha' });
    const gachaUrl = new URL(calls[10].url);
    expect(gachaUrl.hostname).toBe('public-operation-hk4e.mihoyo.com');
    expect(gachaUrl.pathname).toBe('/gacha_info/api/getGachaLog');
    expect(gachaUrl.searchParams.get('authkey_ver')).toBe('1');
    expect(gachaUrl.searchParams.get('sign_type')).toBe('2');
    expect(gachaUrl.searchParams.get('auth_appid')).toBe('webview_gacha');
    expect(gachaUrl.searchParams.get('gacha_type')).toBe('301');
    expect(gachaUrl.searchParams.get('size')).toBe('20');
    expect(gachaUrl.searchParams.get('end_id')).toBe('0');
  });

  it('maps expired passport qr tickets to an expired status', async () => {
    const fetchImpl = vi.fn(async (url: URL) => {
      if (url.pathname === '/account/ma-cn-passport/app/queryQRLoginStatus') {
        return jsonResponse({ retcode: -106, message: 'ExpiredCode', data: null });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new GenshinTakumiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      deviceId: '00000000-0000-4000-8000-000000000001',
    });

    await expect(client.queryQrLogin('expired-ticket')).resolves.toEqual({ status: 'Expired' });
  });

  it('rejects confirmed passport qr responses without root tokens', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      retcode: 0,
      message: 'OK',
      data: { status: 'Confirmed', tokens: [], user_info: { aid: '123456', mid: 'mid_secret' } },
    }));
    const client = new GenshinTakumiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      deviceId: '00000000-0000-4000-8000-000000000001',
    });

    await expect(client.queryQrLogin('ticket-secret')).rejects.toMatchObject({
      diagnostic: 'passport qrcode confirmed without stoken, mid, or aid',
    });
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
    expect(ctx.model.extend).toHaveBeenCalledWith('genshin_gacha_record', expect.anything(), expect.anything());
    expect(ctx.model.extend).toHaveBeenCalledWith('genshin_gacha_sync_state', expect.anything(), expect.anything());
    expect(server.use).toHaveBeenCalledWith(expect.any(Function));
    expect(server.get).toHaveBeenCalledWith('/genshin/bind', expect.any(Function));
    expect(server.get).toHaveBeenCalledWith('/genshin/bind/status', expect.any(Function));
    expect(server.post).toHaveBeenCalledWith('/genshin/bind/submit', expect.any(Function));
    const guard = server.use.mock.calls[0]?.[0];
    const next = vi.fn(async () => undefined);
    const forbidden = { host: 'genshin.example', path: '/console', status: 200, body: '' };
    await guard(forbidden, next);
    expect(forbidden).toMatchObject({ status: 404, body: 'Not Found' });
    expect(next).not.toHaveBeenCalled();
    await guard({ host: 'genshin.example', path: '/genshin/bind' }, next);
    await guard({ host: 'genshin.example', path: '/genshin/bind/status' }, next);
    await guard({ host: 'other.example', path: '/console' }, next);
    expect(next).toHaveBeenCalledTimes(3);
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

  it('returns gacha record images for bare and prefixed keywords in allowed groups', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const kek = loadOrCreateKek(join(dir, 'kek.key'));
    await seedCredential({ database, kek });
    const createGachaAuthKey = vi.spyOn(GenshinTakumiClient.prototype, 'createGachaAuthKey').mockResolvedValue({
      signType: 2,
      authkeyVer: 1,
      authkey: 'gacha-authkey-secret',
    });
    const fetchGachaLogPage = vi.spyOn(GenshinTakumiClient.prototype, 'fetchGachaLogPage').mockImplementation(async (_cookies, _role, _authKey, gachaType, endId) => {
      if (gachaType === '301' && endId === '0') {
        return { list: [gachaItem()] };
      }
      return { list: [] };
    });
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
      gachaRequestIntervalMs: 1,
      allowedGroups: '100',
      naturalTriggerEnabled: false,
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:100',
      guildId: '100',
      content: '抽卡记录',
      send,
    }, vi.fn());
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:100',
      guildId: '100',
      content: '原神抽卡记录',
      send,
    }, vi.fn());

    expect(send).toHaveBeenCalledTimes(2);
    expect(renderMessageContent(send.mock.calls[0]?.[0])).toContain('image/png');
    expect(renderMessageContent(send.mock.calls[1]?.[0])).toContain('image/png');
    expect(getNavigatedHtml()).toContain('原神抽卡记录');
    expect(getNavigatedHtml()).toContain('神里绫华');
    expect(createGachaAuthKey).toHaveBeenCalledTimes(2);
    expect(fetchGachaLogPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ uid: '100000001' }), expect.anything(), '301', '0');
  });

  it('blocks bare gacha records outside allowed groups before rendering', async () => {
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
      naturalTriggerEnabled: false,
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:200',
      guildId: '200',
      content: '抽卡记录',
      send,
    }, vi.fn());

    expect(send).toHaveBeenCalledWith('当前群未开启原神功能。');
    expect(puppeteer.page).not.toHaveBeenCalled();
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

  it('renders the qr bind page', () => {
    const html = renderGenshinBindPage({
      qq: '1405359129',
      token: 'token',
      submitPath: '/genshin/bind/submit',
      statusPath: '/genshin/bind/status?token=token',
      qrImageDataUrl: 'data:image/png;base64,qr',
    });

    expect(html).toContain('米游社 App');
    expect(html).toContain('data-qr-status-path="/genshin/bind/status?token=token"');
    expect(html).toContain('data:image/png;base64,qr');
    expect(html).not.toContain('Cookie-Editor');
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
