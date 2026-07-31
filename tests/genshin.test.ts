import { mkdtempSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
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

import {
  apply as applyGenshinPlugin,
  buildGenshinCapabilityReference,
  shouldExposeGenshinCapabilityReference,
} from '../src/plugins/genshin/index.js';
import {
  buildGachaRecordsView,
  GenshinGachaService,
  renderGenshinGachaRecordsImage,
} from '../src/plugins/genshin/gacha-records.js';
import { GenshinGachaIconResolver } from '../src/plugins/genshin/gacha-icon-resolver.js';
import {
  createMemoryGenshinDeviceProfileStore,
  GenshinDeviceProfileStore,
} from '../src/plugins/genshin/device-profile.js';
import {
  buildGenshinMenuView,
  GenshinMenuService,
  renderGenshinMenuImage,
} from '../src/plugins/genshin/menu.js';
import {
  formatGenshinPreviewCodeReply,
  GenshinPreviewCodeClient,
  GenshinPreviewCodeError,
  type GenshinPreviewCodeInfo,
} from '../src/plugins/genshin/preview-codes.js';
import {
  buildGenshinStatusView,
  renderGenshinStatusHtml,
  renderGenshinStatusImage,
} from '../src/plugins/genshin/status-card.js';
import { GenshinService } from '../src/plugins/genshin/service.js';
import { credentialAad } from '../src/plugins/genshin/credential.js';
import { gachaRecordKey, GenshinStore } from '../src/plugins/genshin/store.js';
import {
  GenshinDailyNoteVerificationRequiredError,
  GenshinTakumiClient,
  GenshinTakumiError,
  type GenshinDailyNote,
  type GenshinGachaLogItem,
} from '../src/plugins/genshin/takumi-client.js';
import {
  decryptEnvelopeJson,
  encryptEnvelopeJson,
  loadOrCreateKek,
  type CredentialKek,
} from '../src/plugins/shared/credential-crypto.js';
import type {
  DatabaseLike,
  GenshinCookieFields,
  GenshinCredentialPayload,
  GenshinGachaRecord,
  GenshinGameRole,
  OwnerIdentity,
} from '../src/plugins/genshin/types.js';
import { renderGenshinBindPage } from '../src/plugins/genshin/web/bind-page.js';
import { renderGenshinStatusVerificationPage } from '../src/plugins/genshin/web/status-verification-page.js';

const tempDirs: string[] = [];

function apply(ctx: Record<string, any>, config: Parameters<typeof applyGenshinPlugin>[1]): void {
  ctx.nativeFeatureChat ??= {
    registerCapability: vi.fn(() => () => undefined),
    sendReply: vi.fn(async (session, input) => {
      await session.send(input.reply);
      return null;
    }),
  };
  applyGenshinPlugin(ctx as never, config);
}

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
  fetchDailyNote?: ReturnType<typeof vi.fn>;
  completeAccountTokens?: ReturnType<typeof vi.fn>;
  verifyDailyNoteChallenge?: ReturnType<typeof vi.fn>;
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
    completeAccountTokens: options.completeAccountTokens ?? vi.fn(async (cookies: GenshinCookieFields) => ({
      ...cookies,
      cookie_token: 'cookie_token_secret',
      account_id: '123456',
      ltoken: 'ltoken_secret',
      ltuid: '123456',
    })),
    listRoles: vi.fn(async () => options.roles ?? [role()]),
    signIn: options.signIn ?? vi.fn(async () => ({ status: 'ok', retcode: 0, message: 'OK', totalSignDay: 8 })),
    fetchDailyNote: options.fetchDailyNote ?? vi.fn(async () => dailyNote()),
    verifyDailyNoteChallenge: options.verifyDailyNoteChallenge ?? vi.fn(async () => 'verified-challenge'),
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
      statusVerificationPath: '/genshin/bind/status-verification',
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

function dailyNote(overrides: Partial<GenshinDailyNote> = {}): GenshinDailyNote {
  return {
    currentResin: 172,
    maxResin: 200,
    resinRecoverySeconds: 13_440,
    finishedTaskNum: 4,
    totalTaskNum: 4,
    isExtraTaskRewardReceived: true,
    remainResinDiscountNum: 2,
    resinDiscountNumLimit: 3,
    currentExpeditionNum: 5,
    maxExpeditionNum: 5,
    expeditions: [
      {
        avatarSideIcon: 'https://upload-bbs.mihoyo.com/game_record/genshin/character_side_icon/UI_AvatarIcon_Side_Ayaka.png',
        status: 'Finished',
        remainedSeconds: 0,
      },
      {
        avatarSideIcon: 'https://upload-bbs.mihoyo.com/game_record/genshin/character_side_icon/UI_AvatarIcon_Side_Amber.png',
        status: 'Ongoing',
        remainedSeconds: 3_780,
      },
    ],
    currentHomeCoin: 2_180,
    maxHomeCoin: 2_400,
    homeCoinRecoverySeconds: 6_600,
    transformer: {
      obtained: true,
      reached: false,
      day: 1,
      hour: 3,
      minute: 20,
      second: 0,
    },
    ...overrides,
  };
}

function previewCodeInfo(overrides: Partial<GenshinPreviewCodeInfo> = {}): GenshinPreviewCodeInfo {
  return {
    actId: 'ea202607241851454675',
    sourceUrl: 'https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=ea202607241851454675',
    previewTitle: '《原神》7.0版本「无神怜爱的雪国」前瞻特别节目',
    versionTitle: '《原神》7.0版本前瞻特别节目',
    liveTitle: '原神7.0前瞻',
    liveStartAt: Date.parse('2026-07-31T20:00:00+08:00'),
    liveEndAt: Date.parse('2026-07-31T21:30:00+08:00'),
    liveEnded: true,
    expirationText: '兑换码将于8月3日12:00过期，请及时兑换~',
    expiresAt: Date.parse('2026-08-03T12:00:00+08:00'),
    codes: [
      { code: '无神怜爱的雪国', rewards: '原石*100 精锻用魔矿*10' },
      { code: '欢迎来到至冬', rewards: '原石*100 大英雄的经验*5' },
      { code: '冰中雪影奥黛塔', rewards: '原石*100 摩拉*50000' },
    ],
    ...overrides,
  };
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
    expect(client.completeAccountTokens).toHaveBeenCalledWith({
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

  it('runs manual sign-in for the bound UID only', async () => {
    const signIn = vi.fn(async () => ({ status: 'already_done', retcode: 0, message: '今天已经签到过了。', totalSignDay: 9 }));
    const { service, database } = createService({ signIn });
    const started = await service.startBinding(identity());
    await completeQrBinding(service, extractToken(started.link));

    await expect(service.manualSignIn(identity())).resolves.toMatchObject({
      role: { uid: '100000001' },
      status: 'already_done',
      totalSignDay: 9,
    });
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(database.tables.get('genshin_signin_record')?.[0]).toMatchObject({
      uid: '100000001',
      trigger: 'manual',
      status: 'already_done',
      signDate: '1970-01-01',
    });
  });

  it('queries the live status for the bound UID and records credential use', async () => {
    const fetchDailyNote = vi.fn(async () => dailyNote());
    const { service, database } = createService({ fetchDailyNote });
    const started = await service.startBinding(identity());
    await completeQrBinding(service, extractToken(started.link));

    await expect(service.queryStatus(identity())).resolves.toMatchObject({
      role: { uid: '100000001', region: 'cn_gf01' },
      note: { currentResin: 172, currentHomeCoin: 2_180 },
      queriedAt: 1_000,
    });

    expect(fetchDailyNote).toHaveBeenCalledWith(
      expect.objectContaining({ stoken: 'v2_secret' }),
      expect.objectContaining({ uid: '100000001', region: 'cn_gf01' }),
      undefined,
    );
    expect(database.tables.get('genshin_credential')?.[0]).toMatchObject({
      lastUsedAt: 1_000,
      lastFailureReason: null,
    });
    expect(database.tables.get('genshin_auth_audit')).toContainEqual(expect.objectContaining({
      eventType: 'status_queried',
      status: 'ok',
    }));
  });

  it('stores a human-verification challenge and consumes it on the next status query', async () => {
    const required = new GenshinDailyNoteVerificationRequiredError({
      gt: 'geetest-id',
      challenge: 'geetest-challenge',
      path: '/game_record/app/genshin/api/index',
    }, 1034);
    const fetchDailyNote = vi.fn()
      .mockRejectedValueOnce(required)
      .mockResolvedValueOnce(dailyNote());
    const verifyDailyNoteChallenge = vi.fn(async () => 'xrpc-verified-challenge');
    const { service, database } = createService({ fetchDailyNote, verifyDailyNoteChallenge });
    const started = await service.startBinding(identity());
    await completeQrBinding(service, extractToken(started.link));

    let verificationLink = '';
    await service.queryStatus(identity()).catch((error: Error) => {
      verificationLink = error.message.match(/https:\/\/genshin\.example\/\S+/)?.[0] ?? '';
    });
    expect(verificationLink).toContain('/genshin/bind/status-verification?token=');
    const token = extractToken(verificationLink);
    expect(database.tables.get('genshin_credential')?.[0]?.lastFailureReason).toBe('米游社实时便笺要求人机验证。');
    expect(JSON.stringify(database.tables.get('genshin_credential'))).not.toContain(token);
    await expect(service.resolveStatusVerificationPage(token)).resolves.toEqual({
      token,
      gt: 'geetest-id',
      challenge: 'geetest-challenge',
    });

    await service.completeStatusVerification(token, 'geetest-validate');
    await expect(service.queryStatus(identity())).resolves.toMatchObject({
      note: { currentResin: 172 },
    });

    expect(verifyDailyNoteChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ ltoken: 'ltoken_secret' }),
      {
        gt: 'geetest-id',
        challenge: 'geetest-challenge',
        path: '/game_record/app/genshin/api/index',
      },
      'geetest-validate',
    );
    expect(fetchDailyNote).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ uid: '100000001' }),
      {
        challenge: 'xrpc-verified-challenge',
        path: '/game_record/app/genshin/api/index',
      },
    );
    expect(database.tables.get('genshin_status_verification')?.[0]).toMatchObject({
      status: 'consumed',
      gt: '',
      challenge: '',
      verifiedChallenge: null,
    });
    expect(JSON.stringify(database.tables.get('genshin_status_verification'))).not.toContain(token);
  });

  it('does not resurrect a credential unbound while legacy tokens are being completed', async () => {
    let releaseCompletion!: () => void;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const completeAccountTokens = vi.fn(async (cookies: GenshinCookieFields) => {
      await completionGate;
      return {
        ...cookies,
        account_id: '123456',
        cookie_token: 'cookie-token',
        ltoken: 'ltoken-value',
        ltuid: '123456',
      };
    });
    const fetchDailyNote = vi.fn(async () => dailyNote());
    const { service, database, kek } = createService({ completeAccountTokens, fetchDailyNote });
    await seedCredential({ database, kek });

    const query = service.queryStatus(identity());
    await vi.waitFor(() => expect(completeAccountTokens).toHaveBeenCalledTimes(1));
    await service.unbind(identity());
    releaseCompletion();

    await expect(query).rejects.toThrow('原神绑定状态已变化');
    expect(database.tables.get('genshin_credential')?.[0]).toMatchObject({
      revokedAt: 1_000,
      credentialCipher: '',
      credentialMeta: '',
    });
    expect(fetchDailyNote).not.toHaveBeenCalled();
  });

  it('does not roll a concurrent rebind back to the legacy credential snapshot', async () => {
    let releaseCompletion!: () => void;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const completeAccountTokens = vi.fn(async (cookies: GenshinCookieFields) => {
      await completionGate;
      return {
        ...cookies,
        account_id: '123456',
        cookie_token: 'old-cookie-token',
        ltoken: 'old-ltoken',
        ltuid: '123456',
      };
    });
    const fetchDailyNote = vi.fn(async () => dailyNote());
    const { service, database, kek } = createService({ completeAccountTokens, fetchDailyNote });
    await seedCredential({ database, kek });
    const oldRow = database.tables.get('genshin_credential')?.[0];
    if (!oldRow) throw new Error('missing seeded credential');

    const query = service.queryStatus(identity());
    await vi.waitFor(() => expect(completeAccountTokens).toHaveBeenCalledTimes(1));
    const newRole = role({ uid: '200000001', nickname: '新旅行者' });
    const newPayload: GenshinCredentialPayload = {
      cookies: {
        stoken: 'new-stoken',
        mid: 'new-mid',
        stuid: '654321',
        account_id: '654321',
        cookie_token: 'new-cookie-token',
        ltoken: 'new-ltoken',
        ltuid: '654321',
      },
    };
    const newEnvelope = encryptEnvelopeJson(
      newPayload,
      credentialAad(identity().ownerKey, Number(oldRow.id)),
      kek,
    );
    await database.set('genshin_credential', { id: oldRow.id }, {
      uid: newRole.uid,
      nickname: newRole.nickname,
      version: Number(oldRow.version) + 1,
      credentialCipher: newEnvelope.cipherText,
      credentialMeta: newEnvelope.meta,
      revokedAt: null,
    });
    releaseCompletion();

    await expect(query).rejects.toThrow('原神绑定状态已变化');
    const current = database.tables.get('genshin_credential')?.[0];
    expect(current).toMatchObject({
      uid: '200000001',
      nickname: '新旅行者',
      version: 2,
      revokedAt: null,
      credentialCipher: newEnvelope.cipherText,
      credentialMeta: newEnvelope.meta,
    });
    expect(fetchDailyNote).not.toHaveBeenCalled();
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

  it('resolves missing gacha item ids through the runtime icon cache', async () => {
    const dir = createTempDir();
    const fetchGachaLogPage = vi.fn(async (_cookies, _role, _authKey, gachaType: string, endId: string) => {
      if (gachaType === '302' && endId === '0') {
        return {
          list: [
            gachaItem({
              gachaType: '302',
              itemId: '',
              name: '雾切之回光',
              itemType: '武器',
              rankType: '5',
              id: '1000000000000000005',
            }),
          ],
        };
      }
      return { list: [] };
    });
    const iconDictFetch = vi.fn(async () => jsonResponse({
      雾切之回光: 11509,
      西风剑: 11401,
    }));
    const { service, database, client, kek } = createService({ fetchGachaLogPage, now: () => 1_000 });
    const started = await service.startBinding(identity());
    await completeQrBinding(service, extractToken(started.link));
    const iconResolver = new GenshinGachaIconResolver({
      cachePath: join(dir, 'gacha-icon-cache.json'),
      fetchImpl: iconDictFetch as unknown as typeof fetch,
      now: () => 2_000,
    });
    const gachaService = new GenshinGachaService(new GenshinStore(database as unknown as DatabaseLike), client as unknown as GenshinTakumiClient, kek, {
      timezone: 'Asia/Shanghai',
      requestIntervalMs: 0,
      iconResolver,
      now: () => 2_000,
    });

    const view = await gachaService.queryGachaRecords(identity());

    expect(iconDictFetch).toHaveBeenCalledTimes(1);
    expect(view.poolViews.find((pool) => pool.title === '武器活动祈愿')?.historyRows[0]).toMatchObject({
      name: '雾切之回光',
      iconUrl: 'https://enka.network/ui/UI_EquipIcon_Sword_Narukami.png',
    });
    const cache = JSON.parse(await readFile(join(dir, 'gacha-icon-cache.json'), 'utf8'));
    expect(cache.entries['雾切之回光']).toMatchObject({
      itemId: '11509',
      iconName: 'UI_EquipIcon_Sword_Narukami',
      source: 'uigf-dict',
      updatedAt: 2_000,
    });
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
  it('only exposes command guidance for likely feature usage', () => {
    const session = (content: string) => ({ content, stripped: { content } }) as never;

    expect(shouldExposeGenshinCapabilityReference(session('你玩原神吗？'))).toBe(false);
    expect(shouldExposeGenshinCapabilityReference(session('原神最近的剧情怎么样？'))).toBe(false);
    expect(shouldExposeGenshinCapabilityReference(session('抽卡记录看起来挺有意思'))).toBe(false);
    expect(shouldExposeGenshinCapabilityReference(session('原神兑换ABCDEF12'))).toBe(false);
    expect(shouldExposeGenshinCapabilityReference(session('原神确认123456'))).toBe(true);
    expect(shouldExposeGenshinCapabilityReference(session('抽卡记录怎么查'))).toBe(true);
    expect(shouldExposeGenshinCapabilityReference(session('原神状态'))).toBe(true);
    expect(shouldExposeGenshinCapabilityReference(session('原神兑换码'))).toBe(true);
    expect(shouldExposeGenshinCapabilityReference(session('原神签到失败了'))).toBe(true);
  });

  it('describes the exact keyword contract for Agent corrections', () => {
    const reference = buildGenshinCapabilityReference({
      isDirect: true,
      channelId: 'private:10001',
    } as never, {
      allowedGroups: new Set<string>(),
      naturalTriggerEnabled: false,
      naturalTriggerGroups: new Set<string>(),
    } as never);

    expect(reference).toContain('总入口：“原神”');
    expect(reference).toContain('原神确认 <6位数字确认码>');
    expect(reference).not.toContain('原神兑换 <兑换码>');
    expect(reference).toContain('前瞻：“原神兑换码”');
    expect(reference).toContain('无需绑定 UID');
    expect(reference).toContain('原神状态');
    expect(reference).toContain('“抽卡记录”或“原神抽卡记录”');
    expect(reference).toContain('米游社国服原神 UID');
  });

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
          ['原神状态', '查看树脂、委托、派遣与洞天宝钱'],
          ['原神签到', '为已绑定 UID 执行每日签到'],
          ['原神兑换码', '查看最新国服前瞻版本与三个兑换码'],
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
    expect(html).not.toContain('原神兑换 <span class="param">&lt;兑换码&gt;</span>');
    expect(html).toContain('原神兑换码');
    expect(html).toContain('原神状态');
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

describe('genshin status card', () => {
  it('builds a live-note view with resource recovery and expedition states', () => {
    const view = buildGenshinStatusView({
      role: role(),
      note: dailyNote(),
      queriedAt: Date.UTC(2026, 6, 16, 10, 0, 0),
    }, 'Asia/Shanghai');

    expect(view).toMatchObject({
      nickname: '旅行者',
      uid: '100000001',
      regionName: '天空岛',
      levelText: '冒险等阶 60',
      resin: { current: 172, max: 200, state: 'warning' },
      homeCoin: { current: 2_180, max: 2_400, state: 'warning' },
      commissions: { finished: 4, total: 4, complete: true },
      weeklyDiscount: { remaining: 2, limit: 3 },
      transformer: { title: '冷却中', detail: '还需 1天3小时', ready: false },
      expeditionSummary: '已派遣 5/5 · 1 个可领取',
    });
    expect(view.resin.recoveryText).toContain('21:44');
    expect(view.expeditions.map((item) => item.statusText)).toEqual(['已完成', '1小时3分钟后完成']);

    const lockedHomeView = buildGenshinStatusView({
      role: role(),
      note: dailyNote({ currentHomeCoin: 0, maxHomeCoin: 0, homeCoinRecoverySeconds: 0 }),
      queriedAt: Date.UTC(2026, 6, 16, 10, 0, 0),
    }, 'Asia/Shanghai');
    expect(lockedHomeView.homeCoin).toMatchObject({
      percent: 0,
      recoveryText: '尚未解锁尘歌壶',
      unlocked: false,
    });
  });

  it('renders the live-note HTML as a PNG card', async () => {
    const { page, puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    const view = buildGenshinStatusView({
      role: role({ nickname: '旅行者 <荧>' }),
      note: dailyNote(),
      queriedAt: Date.UTC(2026, 6, 16, 10, 0, 0),
    }, 'Asia/Shanghai');

    const html = renderGenshinStatusHtml(view);
    expect(html).toContain('原神实时便笺');
    expect(html).toContain('旅行者 &lt;荧&gt;');
    expect(html).toContain('UID 100000001');
    expect(html).not.toContain('UID 100****01');
    expect(html).not.toContain('在线状态');
    expect(html).toContain('原粹树脂');
    expect(html).toContain('172');
    expect(html).toContain('洞天宝钱');
    expect(html).toContain('参量质变仪');
    expect(html).toContain('UI_AvatarIcon_Side_Ayaka.png');

    const image = await renderGenshinStatusImage(puppeteer, view);
    expect(String(image)).toContain('image/png');
    expect(getNavigatedHtml()).toContain('id="genshin-status-card"');
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'png' }));
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
      gachaRecord({
        id: 5,
        recordKey: gachaRecordKey('100000001', 'cn_gf01', '1000000000000000005'),
        recordId: '1000000000000000005',
        itemId: '',
        name: '奈芙尔',
        itemType: '角色',
        rankType: '5',
        time: '2026-07-08 19:40:00',
      }),
      gachaRecord({
        id: 6,
        recordKey: gachaRecordKey('100000001', 'cn_gf01', '1000000000000000006'),
        recordId: '1000000000000000006',
        itemId: '',
        name: '西风剑',
        itemType: '武器',
        rankType: '4',
        time: '2026-07-08 19:41:00',
      }),
      gachaRecord({
        id: 7,
        recordKey: gachaRecordKey('100000001', 'cn_gf01', '1000000000000000007'),
        recordId: '1000000000000000007',
        itemId: '10000133',
        name: '桑多涅',
        itemType: '角色',
        rankType: '5',
        time: '2026-07-08 19:29:00',
      }),
    ], {
      uid: '100000001',
      nickname: '旅行者',
      regionName: '天空岛',
      addedCount: 6,
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
    expect(html).toContain('https://enka.network/ui/UI_AvatarIcon_Nefer.png');
    expect(html).toContain('https://enka.network/ui/UI_AvatarIcon_Ayaka.png');
    expect(html).toContain('file:///');
    expect(html).toContain('/genshin/assets/UI_AvatarIcon_Sandrone.png');
    expect(html).toContain('https://enka.network/ui/UI_EquipIcon_Sword_Narukami.png');
    expect(html).toContain('https://enka.network/ui/UI_EquipIcon_Catalyst_Dvalin.png');
    expect(html).toContain('已垫 1 抽');
    expect(html).toContain('奈芙尔');
    expect(html).toContain('桑多涅');
    expect(html).toContain('神里绫华');
    expect(html).toContain('雾切之回光');
    expect(html).toContain('天空之卷');
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'png' }));
  });
});

describe('genshin device profile', () => {
  it('persists the device identity and fingerprint with owner-only permissions', async () => {
    const dir = createTempDir();
    const path = join(dir, 'device-profile.json');
    const first = new GenshinDeviceProfileStore(path);
    first.saveDeviceFp('persisted-device-fp');
    const second = new GenshinDeviceProfileStore(path);

    expect(second.profile).toEqual(first.profile);
    expect(second.profile.deviceFp).toBe('persisted-device-fp');
    const { mode } = await stat(path);
    expect(mode & 0o077).toBe(0);
  });
});

describe('genshin preview code client', () => {
  const now = Date.parse('2026-08-01T00:00:00+08:00');

  it('returns the latest official CN preview information and exactly three codes', async () => {
    const fetchImpl = createPreviewCodeFetch();
    const client = new GenshinPreviewCodeClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
      memoryCacheTtlMs: 0,
    });

    const result = await client.queryLatest();

    expect(result).toEqual(previewCodeInfo());
    expect(formatGenshinPreviewCodeReply(result, now)).toBe([
      '《原神》7.0版本「无神怜爱的雪国」前瞻特别节目',
      '直播状态：已结束',
      '兑换截止：2026-08-03 12:00（UTC+8，未过期）',
      '',
      '1. 无神怜爱的雪国',
      '   原石*100 精锻用魔矿*10',
      '2. 欢迎来到至冬',
      '   原石*100 大英雄的经验*5',
      '3. 冰中雪影奥黛塔',
      '   原石*100 摩拉*50000',
      '',
      '来源：米游社官方前瞻直播',
    ].join('\n'));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).searchParams.get('uid')).toBe('75276539');
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).searchParams.get('size')).toBe('100');
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({
      'x-rpc-act_id': 'ea202607241851454675',
    });
    expect(new URL(String(fetchImpl.mock.calls[2]?.[0])).searchParams.get('version')).toBe('340cd7');
  });

  it('persists a verified snapshot and uses it after the live activity API is archived', async () => {
    const dir = createTempDir();
    const cachePath = join(dir, 'preview-codes.json');
    const firstFetch = createPreviewCodeFetch();
    const firstClient = new GenshinPreviewCodeClient({
      fetchImpl: firstFetch as unknown as typeof fetch,
      cachePath,
      now: () => now,
      memoryCacheTtlMs: 0,
    });
    await firstClient.queryLatest();

    const stored = JSON.parse(await readFile(cachePath, 'utf8')) as { data?: GenshinPreviewCodeInfo };
    expect(stored.data).toMatchObject({
      actId: 'ea202607241851454675',
      codes: [{ code: '无神怜爱的雪国' }, { code: '欢迎来到至冬' }, { code: '冰中雪影奥黛塔' }],
    });

    const archivedFetch = vi.fn(async () => jsonResponse(previewPostsPayload()));
    const restartedClient = new GenshinPreviewCodeClient({
      fetchImpl: archivedFetch as unknown as typeof fetch,
      cachePath,
      now: () => now,
      memoryCacheTtlMs: 0,
    });

    await expect(restartedClient.queryLatest()).resolves.toEqual(previewCodeInfo());
    expect(archivedFetch).toHaveBeenCalledTimes(1);
  });

  it('reports when all three codes have not been issued yet', async () => {
    const fetchImpl = createPreviewCodeFetch({
      codes: previewCodesPayload().slice(0, 2),
    });
    const client = new GenshinPreviewCodeClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
      memoryCacheTtlMs: 0,
    });

    const error = await client.queryLatest().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(GenshinPreviewCodeError);
    expect(error).toMatchObject({ stage: 'codes', retcode: 0 });
    expect((error as Error).message).toBe('原神7.0前瞻的 3 个兑换码尚未全部发放（当前 2 个），请稍后再查。');
  });

  it('preserves the failed stage and provider retcode', async () => {
    const fetchImpl = createPreviewCodeFetch({
      liveResponse: { data: null, message: '活动已结束', retcode: -500007 },
    });
    const client = new GenshinPreviewCodeClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
      memoryCacheTtlMs: 0,
    });

    const error = await client.queryLatest().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(GenshinPreviewCodeError);
    expect(error).toMatchObject({ stage: 'live', status: 200, retcode: -500007 });
    expect((error as Error).message).toContain('retcode -500007（活动已结束）');
  });
});

describe('genshin takumi client', () => {
  it('completes the game-record cookie fields from a QR root token', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url: url.toString(), init });
      if (url.pathname === '/account/auth/api/getCookieAccountInfoBySToken') {
        return jsonResponse({ retcode: 0, message: 'OK', data: { uid: '123456', cookie_token: 'cookie-token' } });
      }
      if (url.pathname === '/account/auth/api/getLTokenBySToken') {
        return jsonResponse({ retcode: 0, message: 'OK', data: { ltoken: 'ltoken-value' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new GenshinTakumiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.completeAccountTokens({
      stoken: 'stoken-value',
      mid: 'mid-value',
      stuid: '123456',
    })).resolves.toMatchObject({
      account_id: '123456',
      cookie_token: 'cookie-token',
      ltoken: 'ltoken-value',
      ltuid: '123456',
    });

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/account/auth/api/getCookieAccountInfoBySToken',
      '/account/auth/api/getLTokenBySToken',
    ]);
    expect(calls[1].init.headers).toMatchObject({
      cookie: 'mid=mid-value; stoken=stoken-value; stuid=123456',
    });
  });

  it('sends QR login, CN role, sign-in, and gacha requests with the expected shape', async () => {
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
    });
    const qr = await client.createQrLogin();
    const qrResult = await client.queryQrLogin(qr.ticket);
    if (qrResult.status !== 'Confirmed' || !qrResult.cookies) {
      throw new Error('expected confirmed qr result');
    }
    const cookies = await client.exchangeCookieToken(qrResult.cookies);
    const [selectedRole] = await client.listRoles(cookies);

    await client.signIn(cookies, selectedRole);
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
    expect(JSON.parse(String(calls[7].init.body))).toMatchObject({ auth_appid: 'webview_gacha' });
    const gachaUrl = new URL(calls[8].url);
    expect(gachaUrl.hostname).toBe('public-operation-hk4e.mihoyo.com');
    expect(gachaUrl.pathname).toBe('/gacha_info/api/getGachaLog');
    expect(gachaUrl.searchParams.get('authkey_ver')).toBe('1');
    expect(gachaUrl.searchParams.get('sign_type')).toBe('2');
    expect(gachaUrl.searchParams.get('auth_appid')).toBe('webview_gacha');
    expect(gachaUrl.searchParams.get('gacha_type')).toBe('301');
    expect(gachaUrl.searchParams.get('size')).toBe('20');
    expect(gachaUrl.searchParams.get('end_id')).toBe('0');
  });

  it('requests and normalizes the Genshin daily note contract', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({
        retcode: 0,
        message: 'OK',
        data: {
          current_resin: 172,
          max_resin: 200,
          resin_recovery_time: '13440',
          finished_task_num: 4,
          total_task_num: 4,
          is_extra_task_reward_received: true,
          remain_resin_discount_num: 2,
          resin_discount_num_limit: 3,
          current_expedition_num: 5,
          max_expedition_num: 5,
          expeditions: [{
            avatar_side_icon: 'https://upload-bbs.mihoyo.com/ayaka.png',
            status: 'Ongoing',
            remained_time: '3780',
          }],
          current_home_coin: 2_180,
          max_home_coin: 2_400,
          home_coin_recovery_time: '6600',
          transformer: {
            obtained: true,
            recovery_time: { Day: 1, Hour: 3, Minute: 20, Second: 0, reached: false },
          },
        },
      });
    });
    const deviceProfileStore = createMemoryGenshinDeviceProfileStore('00000000-0000-4000-8000-000000000001');
    deviceProfileStore.saveDeviceFp('device-fp-123');
    const client = new GenshinTakumiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      deviceProfileStore,
      now: () => 1_700_000_000_000,
      recordNonce: () => 123_456,
    });

    await expect(client.fetchDailyNote({
      account_id: '123456',
      cookie_token: 'cookie-token-secret',
      ltoken: 'ltoken-secret',
      ltuid: '123456',
      stoken: 'must-not-leak-to-record-api',
    }, role())).resolves.toEqual(dailyNote({
      expeditions: [{
        avatarSideIcon: 'https://upload-bbs.mihoyo.com/ayaka.png',
        status: 'Ongoing',
        remainedSeconds: 3_780,
      }],
    }));

    expect(new URL(calls[0].url).pathname).toBe('/game_record/app/genshin/api/index');
    const requestUrl = new URL(calls[1].url);
    expect(requestUrl.hostname).toBe('api-takumi-record.mihoyo.com');
    expect(requestUrl.pathname).toBe('/game_record/app/genshin/api/dailyNote');
    expect(requestUrl.search).toBe('?role_id=100000001&server=cn_gf01');
    expect(calls[1].init.headers).toMatchObject({
      cookie: 'account_id=123456; cookie_token=cookie-token-secret; ltoken=ltoken-secret; ltuid=123456',
      referer: 'https://webstatic.mihoyo.com',
      'x-rpc-app_version': '2.95.1',
      'x-rpc-client_type': '5',
      'x-rpc-device_id': '00000000-0000-4000-8000-000000000001',
      'x-rpc-device_fp': 'device-fp-123',
      'x-rpc-tool_verison': 'v5.0.1-ys',
      ds: '1700000000,123456,0cea3ef09388c60574ce981a0a397a3d',
    });
    expect(calls[1].init.headers).not.toHaveProperty('origin');
    expect(String((calls[1].init.headers as Record<string, string>).cookie)).not.toContain('stoken');
  });

  it('turns record-api risk control into a Geetest challenge', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url: url.toString(), init });
      if (url.pathname === '/game_record/app/genshin/api/index') {
        return jsonResponse({ retcode: 1034, message: '', data: null });
      }
      if (url.pathname === '/game_record/app/card/wapi/createVerification') {
        return jsonResponse({ retcode: 0, message: 'OK', data: { gt: 'geetest-id', challenge: 'geetest-challenge' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const deviceProfileStore = createMemoryGenshinDeviceProfileStore('device-id');
    deviceProfileStore.saveDeviceFp('device-fp');
    const client = new GenshinTakumiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      deviceProfileStore,
      now: () => 1_700_000_000_000,
      recordNonce: () => 123_456,
    });
    const cookies = {
      account_id: '123456',
      cookie_token: 'cookie-token',
      ltoken: 'ltoken-value',
      ltuid: '123456',
    };

    await expect(client.fetchDailyNote(cookies, role())).rejects.toMatchObject({
      name: 'GenshinDailyNoteVerificationRequiredError',
      retcode: 1034,
      verification: {
        gt: 'geetest-id',
        challenge: 'geetest-challenge',
        path: '/game_record/app/genshin/api/index',
      },
    });
    expect(new URL(calls[1].url).search).toBe('?is_high=true');
    expect(calls[1].init.headers).toMatchObject({
      'x-rpc-challenge_game': '2',
      'x-rpc-challenge_path': '/game_record/app/genshin/api/index',
      'x-rpc-device_fp': 'device-fp',
    });
  });

  it('submits Geetest validation and returns the x-rpc challenge', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ retcode: 0, message: 'OK', data: { challenge: 'xrpc-challenge' } });
    });
    const deviceProfileStore = createMemoryGenshinDeviceProfileStore('device-id');
    deviceProfileStore.saveDeviceFp('device-fp');
    const client = new GenshinTakumiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      deviceProfileStore,
      now: () => 1_700_000_000_000,
      recordNonce: () => 123_456,
    });

    await expect(client.verifyDailyNoteChallenge({
      account_id: '123456',
      cookie_token: 'cookie-token',
      ltoken: 'ltoken-value',
      ltuid: '123456',
    }, {
      gt: 'geetest-id',
      challenge: 'geetest-challenge',
      path: '/game_record/app/genshin/api/index',
    }, 'geetest-validate')).resolves.toBe('xrpc-challenge');

    expect(new URL(calls[0].url).pathname).toBe('/game_record/app/card/wapi/verifyVerification');
    expect(calls[0].init.headers).toMatchObject({
      'content-type': 'application/json',
      'x-rpc-challenge_game': '2',
      'x-rpc-challenge_path': '/game_record/app/genshin/api/index',
      ds: expect.stringMatching(/^1700000000,123456,[a-f0-9]{32}$/),
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      geetest_challenge: 'geetest-challenge',
      geetest_validate: 'geetest-validate',
      geetest_seccode: 'geetest-validate|jordan',
    });
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
    expect(ctx.model.extend).toHaveBeenCalledWith('genshin_status_verification', expect.anything(), expect.anything());
    expect(ctx.model.extend).toHaveBeenCalledWith('genshin_gacha_record', expect.anything(), expect.anything());
    expect(ctx.model.extend).toHaveBeenCalledWith('genshin_gacha_sync_state', expect.anything(), expect.anything());
    expect(server.use).toHaveBeenCalledWith(expect.any(Function));
    expect(server.get).toHaveBeenCalledWith('/genshin/bind', expect.any(Function));
    expect(server.get).toHaveBeenCalledWith('/genshin/bind/status', expect.any(Function));
    expect(server.get).toHaveBeenCalledWith('/genshin/bind/status-verification', expect.any(Function));
    expect(server.post).toHaveBeenCalledWith('/genshin/bind/submit', expect.any(Function));
    expect(server.post).toHaveBeenCalledWith('/genshin/bind/status-verification/submit', expect.any(Function));
    const guard = server.use.mock.calls[0]?.[0];
    const next = vi.fn(async () => undefined);
    const forbidden = { host: 'genshin.example', path: '/', status: 200, body: '' };
    await guard(forbidden, next);
    expect(forbidden).toMatchObject({ status: 404, body: 'Not Found' });
    expect(next).not.toHaveBeenCalled();
    await guard({ host: 'genshin.example', path: '/genshin/bind' }, next);
    await guard({ host: 'genshin.example', path: '/genshin/bind/status' }, next);
    await guard({ host: 'genshin.example', path: '/genshin/bind/status-verification' }, next);
    await guard({ host: 'genshin.example', path: '/genshin/bind/status-verification/submit' }, next);
    await guard({ host: 'other.example', path: '/' }, next);
    expect(next).toHaveBeenCalledTimes(5);
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

  it('returns official preview information and three codes for the bare 原神兑换码 command', async () => {
    const dir = createTempDir();
    const queryLatest = vi.spyOn(GenshinPreviewCodeClient.prototype, 'queryLatest').mockResolvedValue(previewCodeInfo());
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
      allowedGroups: '100',
      naturalTriggerEnabled: false,
    });

    const send = vi.fn();
    const next = vi.fn();
    await middleware.mock.calls[0]?.[0]({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:100',
      guildId: '100',
      content: '原神兑换码',
      send,
    }, next);

    const reply = renderMessageContent(send.mock.calls[0]?.[0]);
    expect(reply).toContain('《原神》7.0版本「无神怜爱的雪国」前瞻特别节目');
    expect(reply).toContain('1. 无神怜爱的雪国');
    expect(reply).toContain('2. 欢迎来到至冬');
    expect(reply).toContain('3. 冰中雪影奥黛塔');
    expect(reply).toContain('来源：米游社官方前瞻直播');
    expect(queryLatest).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it('does not handle the removed manual redemption command', async () => {
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
      allowedGroups: '100',
      naturalTriggerEnabled: true,
      naturalTriggerGroups: '100',
    });

    const send = vi.fn();
    const next = vi.fn();
    await middleware.mock.calls[0]?.[0]({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'group:100',
      guildId: '100',
      content: '原神兑换 GENSHIN2026',
      send,
    }, next);

    expect(send).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
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

  it('returns the current Genshin status card for a bound private-chat user', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const kek = loadOrCreateKek(join(dir, 'kek.key'));
    await seedCredential({ database, kek });
    vi.spyOn(GenshinTakumiClient.prototype, 'completeAccountTokens').mockImplementation(async (cookies) => ({
      ...cookies,
      account_id: '123456',
      cookie_token: 'cookie_token_secret',
      ltoken: 'ltoken_secret',
      ltuid: '123456',
    }));
    const fetchDailyNote = vi.spyOn(GenshinTakumiClient.prototype, 'fetchDailyNote').mockResolvedValue(dailyNote());
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
      allowedGroups: '',
    });

    const handler = middleware.mock.calls[0]?.[0];
    const send = vi.fn();
    await handler({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'private:1405359129',
      isDirect: true,
      content: '原神状态',
      send,
    }, vi.fn());

    const reply = send.mock.calls[0]?.[0];
    expect(extractAtIds(reply)).toEqual(['1405359129']);
    expect(renderMessageContent(reply)).toContain('image/png');
    expect(getNavigatedHtml()).toContain('原神实时便笺');
    expect(getNavigatedHtml()).toContain('原粹树脂');
    expect(fetchDailyNote).toHaveBeenCalledWith(
      expect.objectContaining({ stoken: 'v2_secret' }),
      expect.objectContaining({ uid: '100000001' }),
      undefined,
    );
    const storedCredential = database.tables.get('genshin_credential')?.[0];
    const storedPayload = decryptEnvelopeJson<GenshinCredentialPayload>(
      String(storedCredential?.credentialCipher ?? ''),
      String(storedCredential?.credentialMeta ?? ''),
      credentialAad(String(storedCredential?.ownerKey ?? ''), Number(storedCredential?.id)),
      kek,
    );
    expect(storedPayload.cookies).toMatchObject({
      cookie_token: 'cookie_token_secret',
      ltoken: 'ltoken_secret',
      ltuid: '123456',
    });
  });

  it('does not persist the one-time status verification link in chat history', async () => {
    const dir = createTempDir();
    const database = createDatabase();
    const kek = loadOrCreateKek(join(dir, 'kek.key'));
    await seedCredential({ database, kek });
    vi.spyOn(GenshinTakumiClient.prototype, 'completeAccountTokens').mockImplementation(async (cookies) => ({
      ...cookies,
      account_id: '123456',
      cookie_token: 'cookie-token',
      ltoken: 'ltoken-value',
      ltuid: '123456',
    }));
    vi.spyOn(GenshinTakumiClient.prototype, 'fetchDailyNote').mockRejectedValue(new GenshinDailyNoteVerificationRequiredError({
      gt: 'geetest-id',
      challenge: 'geetest-challenge',
      path: '/game_record/app/genshin/api/index',
    }, 1034));
    const sendReply = vi.fn(async (session: any, input: any) => {
      await session.send(input.reply);
      return null;
    });
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
      nativeFeatureChat: {
        registerCapability: vi.fn(() => () => undefined),
        sendReply,
      },
    };
    apply(ctx as never, {
      publicBaseUrl: 'https://genshin.example',
      credentialKekPath: join(dir, 'kek.key'),
      autoSignEnabled: false,
      allowedGroups: '',
    });
    const send = vi.fn();
    await middleware.mock.calls[0]?.[0]({
      platform: 'onebot',
      userId: '1405359129',
      channelId: 'private:1405359129',
      isDirect: true,
      content: '原神状态',
      send,
    }, vi.fn());

    const replyText = renderMessageContent(send.mock.calls[0]?.[0]);
    const token = new URL(replyText.match(/https:\/\/genshin\.example\/\S+/)?.[0] ?? '').searchParams.get('token') ?? '';
    expect(token).not.toBe('');
    expect(sendReply.mock.calls[0]?.[1]).toMatchObject({
      includeReplyPayload: false,
      summary: '原神状态查询需要完成米游社人机验证；一次性链接未写入历史。',
    });
    expect(String(sendReply.mock.calls[0]?.[1]?.summary)).not.toContain(token);
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

  it('renders a copy button on the successful binding page', () => {
    const html = renderGenshinBindPage({
      qq: '1405359129',
      state: 'success',
      confirmCode: '123456',
      role: role(),
    });

    expect(html).toContain('data-copy-command="原神确认 123456"');
    expect(html).toContain('复制确认命令');
    expect(html).toContain('navigator.clipboard.writeText');
  });

  it('renders the Geetest status-verification page without exposing credentials', () => {
    const html = renderGenshinStatusVerificationPage({
      state: 'pending',
      token: 'one-time-token',
      submitPath: '/genshin/bind/status-verification/submit',
      gt: 'geetest-id',
      challenge: 'geetest-challenge',
    });

    expect(html).toContain('https://static.geetest.com/static/js/gt.0.5.2.js');
    expect(html).toContain("product: 'bind'");
    expect(html).toContain('name="token" value="one-time-token"');
    expect(html).toContain('验证通过后回到 QQ');
    expect(html).not.toContain('stoken');
    expect(html).not.toContain('cookie_token');
  });
});

function previewPostsPayload(): unknown {
  return {
    retcode: 0,
    message: 'OK',
    data: {
      list: [
        {
          post: {
            post: {
              subject: '《原神》7.0版本「无神怜爱的雪国」前瞻特别节目预告',
              structured_content: JSON.stringify([
                {
                  insert: '米游社直播间',
                  attributes: {
                    link: 'https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=ea202607241851454675&mhy_presentation_style=fullscreen&game_biz=hk4e',
                  },
                },
              ]),
              created_at: 1_785_297_612,
            },
          },
        },
      ],
    },
  };
}

function previewLivePayload(): unknown {
  return {
    retcode: 0,
    message: 'OK',
    data: {
      game: 'hk4e',
      live: {
        title: '原神7.0前瞻',
        start: '2026-07-31 20:00:00',
        end: '2026-07-31 21:30:00',
        is_end: true,
        code_ver: '340cd7',
      },
      streamer: {
        aid: '75276539',
      },
      template: JSON.stringify({
        appTitle: '《原神》7.0版本前瞻特别节目',
        codeTipText: '兑换码将于8月3日12:00过期，请及时兑换~',
      }),
    },
  };
}

function previewCodesPayload(): Array<{ title: string; code: string }> {
  return [
    { title: '<p>原石*<span>100</span> 精锻用魔矿*<span>10</span></p>', code: '无神怜爱的雪国' },
    { title: '<p>原石*<span>100</span> 大英雄的经验*<span>5</span></p>', code: '欢迎来到至冬' },
    { title: '<p>原石*<span>100</span> 摩拉*<span>50000</span></p>', code: '冰中雪影奥黛塔' },
  ];
}

function createPreviewCodeFetch(options: {
  codes?: Array<{ title: string; code: string }>;
  liveResponse?: unknown;
} = {}) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.hostname === 'bbs-api.mihoyo.com') return jsonResponse(previewPostsPayload());
    if (url.pathname === '/event/miyolive/index') return jsonResponse(options.liveResponse ?? previewLivePayload());
    if (url.pathname === '/event/miyolive/refreshCode') {
      return jsonResponse({
        retcode: 0,
        message: 'OK',
        data: { code_list: options.codes ?? previewCodesPayload() },
      });
    }
    throw new Error(`unexpected preview code URL: ${url.href}`);
  });
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
