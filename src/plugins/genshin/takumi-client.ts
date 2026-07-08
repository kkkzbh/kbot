import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { buildGenshinCookieHeader } from './cookie.js';
import {
  GENSHIN_GACHA_TYPES,
  GENSHIN_GAME_BIZ,
  type GenshinCookieFields,
  type GenshinGachaType,
  type GenshinGameRole,
  type GenshinQrLoginResult,
  type GenshinQrLoginStatus,
  type GenshinQrLoginTicket,
} from './types.js';

const API_TAKUMI_BASE_URL = 'https://api-takumi.mihoyo.com';
const PASSPORT_API_BASE_URL = 'https://passport-api.mihoyo.com';
const DEVICE_FP_URL = 'https://public-data-api.mihoyo.com/device-fp/api/getFp';
const REDEEM_BASE_URL = 'https://hk4e-api.mihoyo.com';
const PASSPORT_QR_APP_ID = 'ddxf5dufpuyo';
const PASSPORT_QR_CLIENT_TYPE = '3';
const PASSPORT_QR_USER_AGENT = 'HYPContainer/1.3.3.182';
const QR_EXPIRED_RETCODE = -106;
const REDEEM_AUTH_APPID = 'apicdkey';
const GACHA_AUTH_APPID = 'webview_gacha';
const DS1_SALT = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs';
const DS2_SALT = '9nQiU3AV0rJSIBWgdynfoGMGKaklfbM7';

export interface GenshinTakumiClientOptions {
  fetchImpl?: typeof fetch;
  appVersion?: string;
  clientType?: string;
  actId?: string;
  redeemGameVersion?: string;
  userAgent?: string;
  deviceId?: string;
}

export interface GenshinSignResult {
  status: 'ok' | 'already_done';
  retcode: number;
  message: string;
  totalSignDay: number | null;
}

export interface GenshinRedeemResult {
  retcode: number;
  message: string;
}

export interface GenshinAuthKey {
  signType: number;
  authkeyVer: number;
  authkey: string;
}

export interface GenshinGachaLogItem {
  gachaType: GenshinGachaType;
  itemId: string;
  count: string;
  time: string;
  name: string;
  itemType: string;
  rankType: string;
  id: string;
}

export interface GenshinGachaLogPage {
  list: GenshinGachaLogItem[];
}

interface TakumiResponse<T> {
  retcode: number;
  message: string;
  data?: T;
}

interface RoleListPayload {
  list?: Array<{
    game_biz?: string;
    game_uid?: string | number;
    region?: string;
    region_name?: string;
    nickname?: string;
    level?: string | number;
  }>;
}

interface CookieAccountInfoPayload {
  uid?: string | number;
  cookie_token?: string;
}

interface SignInfoPayload {
  is_sign?: boolean;
  total_sign_day?: number;
}

interface AuthKeyPayload {
  sign_type?: number;
  authkey_ver?: number;
  authkey?: string;
}

interface GachaLogPayload {
  list?: GachaLogPayloadItem[];
}

interface GachaLogPayloadItem {
  gacha_type?: string | number;
  item_id?: string | number;
  count?: string | number;
  time?: string;
  name?: string;
  item_type?: string;
  rank_type?: string | number;
  id?: string | number;
}

interface QrFetchPayload {
  url?: string;
  ticket?: string;
}

interface QrQueryPayload {
  status?: string;
  tokens?: Array<{
    token_type?: number;
    token?: string;
  }>;
  user_info?: {
    aid?: string | number;
    mid?: string;
  };
}

export class GenshinTakumiError extends Error {
  readonly retcode: number | null;
  readonly diagnostic: string;

  constructor(message: string, options: { retcode?: number | null; diagnostic: string; cause?: unknown }) {
    super(message);
    this.name = 'GenshinTakumiError';
    this.retcode = options.retcode ?? null;
    this.diagnostic = options.diagnostic;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export class GenshinTakumiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly appVersion: string;
  private readonly clientType: string;
  private readonly actId: string;
  private readonly redeemGameVersion: string;
  private readonly userAgent: string;
  private readonly deviceId: string;

  constructor(options: GenshinTakumiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.appVersion = options.appVersion ?? '2.70.1';
    this.clientType = options.clientType ?? '5';
    this.actId = options.actId ?? 'e202311201442471';
    this.redeemGameVersion = options.redeemGameVersion ?? 'CNRELWin6.0.0';
    this.userAgent = options.userAgent ?? `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) miHoYoBBS/${this.appVersion}`;
    this.deviceId = (options.deviceId ?? randomUUID()).toUpperCase();
  }

  async listRoles(cookies: GenshinCookieFields): Promise<GenshinGameRole[]> {
    if (!cookies.cookie_token || !cookies.account_id) {
      throw new GenshinTakumiError('当前登录凭据缺少 cookie_token + account_id，无法读取原神 UID。', {
        retcode: null,
        diagnostic: 'listRoles missing cookie_token or account_id',
      });
    }
    const url = new URL('/binding/api/getUserGameRolesByCookieToken', PASSPORT_API_BASE_URL);
    url.searchParams.set('game_biz', GENSHIN_GAME_BIZ);
    const payload = await this.requestJson<RoleListPayload>(url, {
      method: 'GET',
      headers: this.cookieTokenRoleHeaders(cookies),
    });
    const list = payload.data?.list ?? [];
    return list
      .filter((role) => role.game_biz === GENSHIN_GAME_BIZ)
      .map((role) => ({
        uid: String(role.game_uid ?? '').trim(),
        region: String(role.region ?? '').trim(),
        regionName: String(role.region_name ?? '').trim(),
        nickname: String(role.nickname ?? '').trim(),
        level: normalizeLevel(role.level),
        gameBiz: GENSHIN_GAME_BIZ as typeof GENSHIN_GAME_BIZ,
      }))
      .filter((role) => Boolean(role.uid && role.region));
  }

  async createQrLogin(): Promise<GenshinQrLoginTicket> {
    const payload = await this.postPassportQr<QrFetchPayload>(new URL('/account/ma-cn-passport/app/createQRLogin', PASSPORT_API_BASE_URL), JSON.stringify({}));
    const url = String(payload.data?.url ?? '').trim();
    const ticket = String(payload.data?.ticket ?? '').trim() || readQrTicket(url);
    if (!url || !ticket) {
      throw new GenshinTakumiError('米游社未返回有效扫码登录票据。', {
        retcode: payload.retcode,
        diagnostic: 'qrcode fetch missing url or ticket',
      });
    }
    return { url, ticket };
  }

  async queryQrLogin(ticket: string): Promise<GenshinQrLoginResult> {
    const body = JSON.stringify({ ticket });
    const payload = await this.requestRawJson<TakumiResponse<QrQueryPayload>>(new URL('/account/ma-cn-passport/app/queryQRLoginStatus', PASSPORT_API_BASE_URL), {
      method: 'POST',
      headers: this.passportQrHeaders(),
      body,
    });
    if (payload.retcode === QR_EXPIRED_RETCODE) {
      return { status: 'Expired' };
    }
    if (payload.retcode !== 0) {
      throw new GenshinTakumiError(payload.message || '米游社接口返回失败。', {
        retcode: payload.retcode,
        diagnostic: `POST /account/ma-cn-passport/app/queryQRLoginStatus retcode=${payload.retcode}`,
      });
    }
    const status = normalizeQrLoginStatus(payload.data?.status);
    if (status !== 'Confirmed') {
      return { status };
    }
    return {
      status,
      cookies: parsePassportQrCookies(payload.data, payload.retcode),
    };
  }

  async exchangeCookieToken(cookies: GenshinCookieFields): Promise<GenshinCookieFields> {
    const stuid = String(cookies.stuid ?? cookies.account_id ?? cookies.login_uid ?? '').trim();
    if (!cookies.stoken || !cookies.mid || !stuid) {
      throw new GenshinTakumiError('当前登录凭据缺少 stoken + mid + stuid，无法换取 cookie_token。', {
        retcode: null,
        diagnostic: 'exchangeCookieToken missing stoken, mid, or stuid',
      });
    }
    const url = new URL('/account/auth/api/getCookieAccountInfoBySToken', PASSPORT_API_BASE_URL);
    url.searchParams.set('stoken', cookies.stoken);
    url.searchParams.set('uid', stuid);
    const payload = await this.requestJson<CookieAccountInfoPayload>(url, {
      method: 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        cookie: buildCookieHeaderPairs([
          ['mid', cookies.mid],
          ['stoken', cookies.stoken],
          ['stuid', stuid],
        ]),
      },
    });
    const cookieToken = String(payload.data?.cookie_token ?? '').trim();
    const accountId = String(payload.data?.uid ?? '').trim();
    if (!cookieToken || !accountId) {
      throw new GenshinTakumiError('米游社未返回有效 cookie_token + account_id。', {
        retcode: payload.retcode,
        diagnostic: 'cookie token exchange missing cookie_token or uid',
      });
    }
    return {
      ...cookies,
      cookie_token: cookieToken,
      account_id: accountId,
      login_uid: accountId,
      stuid,
    };
  }

  async signIn(cookies: GenshinCookieFields, role: GenshinGameRole): Promise<GenshinSignResult> {
    const info = await this.getSignInfo(cookies, role);
    if (info.isSigned) {
      return {
        status: 'already_done',
        retcode: 0,
        message: '今天已经签到过了。',
        totalSignDay: info.totalSignDay,
      };
    }

    const body = JSON.stringify({
      act_id: this.actId,
      uid: role.uid,
      region: role.region,
      lang: 'zh-cn',
    });
    const deviceFp = await this.fetchDeviceFp();
    const payload = await this.postTakumi<unknown>(new URL('/event/luna/sign', API_TAKUMI_BASE_URL), cookies, body, {
      'content-type': 'application/json;charset=utf-8',
      'x-rpc-platform': '1',
      'x-rpc-device_fp': deviceFp,
      ds: createDs2(),
    });
    return {
      status: 'ok',
      retcode: payload.retcode,
      message: payload.message || 'OK',
      totalSignDay: info.totalSignDay == null ? null : info.totalSignDay + 1,
    };
  }

  async redeemCode(cookies: GenshinCookieFields, role: GenshinGameRole, cdkey: string): Promise<GenshinRedeemResult> {
    const authKey = await this.genAuthKey(cookies, role, REDEEM_AUTH_APPID);
    const url = new URL('/common/apicdkey/api/exchangeCdkey', REDEEM_BASE_URL);
    url.searchParams.set('sign_type', String(authKey.signType));
    url.searchParams.set('auth_appid', REDEEM_AUTH_APPID);
    url.searchParams.set('authkey_ver', String(authKey.authkeyVer));
    url.searchParams.set('cdkey', cdkey);
    url.searchParams.set('lang', 'zh-cn');
    url.searchParams.set('device_type', 'pc');
    url.searchParams.set('game_version', this.redeemGameVersion);
    url.searchParams.set('plat_type', 'pc');
    url.searchParams.set('authkey', authKey.authkey);
    url.searchParams.set('game_biz', GENSHIN_GAME_BIZ);
    const payload = await this.requestJson<unknown>(url, {
      method: 'GET',
      headers: this.baseHeaders(cookies),
    });
    return {
      retcode: payload.retcode,
      message: payload.message || 'OK',
    };
  }

  async createGachaAuthKey(cookies: GenshinCookieFields, role: GenshinGameRole): Promise<GenshinAuthKey> {
    return this.genAuthKey(cookies, role, GACHA_AUTH_APPID);
  }

  async fetchGachaLogPage(
    cookies: GenshinCookieFields,
    role: GenshinGameRole,
    authKey: GenshinAuthKey,
    gachaType: GenshinGachaType,
    endId: string,
  ): Promise<GenshinGachaLogPage> {
    if (!GENSHIN_GACHA_TYPES.includes(gachaType)) {
      throw new GenshinTakumiError('抽卡记录卡池类型无效。', {
        retcode: null,
        diagnostic: `invalid gacha_type=${gachaType}`,
      });
    }
    const url = new URL('/event/gacha_info/api/getGachaLog', REDEEM_BASE_URL);
    url.searchParams.set('authkey_ver', String(authKey.authkeyVer));
    url.searchParams.set('sign_type', String(authKey.signType));
    url.searchParams.set('auth_appid', GACHA_AUTH_APPID);
    url.searchParams.set('init_type', gachaType);
    url.searchParams.set('gacha_type', gachaType);
    url.searchParams.set('page', '1');
    url.searchParams.set('size', '20');
    url.searchParams.set('end_id', endId);
    url.searchParams.set('lang', 'zh-cn');
    url.searchParams.set('authkey', authKey.authkey);
    url.searchParams.set('game_biz', GENSHIN_GAME_BIZ);
    url.searchParams.set('region', role.region);
    const payload = await this.requestJson<GachaLogPayload>(url, {
      method: 'GET',
      headers: this.baseHeaders(cookies),
    });
    if (!Array.isArray(payload.data?.list)) {
      throw new GenshinTakumiError('米游社未返回有效抽卡记录列表。', {
        retcode: payload.retcode,
        diagnostic: 'getGachaLog missing list',
      });
    }
    return {
      list: payload.data.list.map(normalizeGachaLogItem),
    };
  }

  private async getSignInfo(cookies: GenshinCookieFields, role: GenshinGameRole): Promise<{ isSigned: boolean; totalSignDay: number | null }> {
    const url = new URL('/event/luna/info', API_TAKUMI_BASE_URL);
    url.searchParams.set('lang', 'zh-cn');
    url.searchParams.set('act_id', this.actId);
    url.searchParams.set('region', role.region);
    url.searchParams.set('uid', role.uid);
    const payload = await this.getTakumi<SignInfoPayload>(url, cookies);
    return {
      isSigned: payload.data?.is_sign === true,
      totalSignDay: typeof payload.data?.total_sign_day === 'number' ? payload.data.total_sign_day : null,
    };
  }

  private async genAuthKey(cookies: GenshinCookieFields, role: GenshinGameRole, authAppId: string): Promise<GenshinAuthKey> {
    const body = JSON.stringify({
      auth_appid: authAppId,
      game_biz: GENSHIN_GAME_BIZ,
      game_uid: Number(role.uid),
      region: role.region,
    });
    const payload = await this.postTakumi<AuthKeyPayload>(new URL('/binding/api/genAuthKey', API_TAKUMI_BASE_URL), cookies, body, {
      'content-type': 'application/json;charset=utf-8',
      ds: createDs1('', body),
    });
    const data = payload.data;
    if (!data?.authkey || typeof data.sign_type !== 'number' || typeof data.authkey_ver !== 'number') {
      throw new GenshinTakumiError('米游社未返回有效 authkey。', {
        retcode: payload.retcode,
        diagnostic: 'genAuthKey missing authkey',
      });
    }
    return {
      signType: data.sign_type,
      authkeyVer: data.authkey_ver,
      authkey: data.authkey,
    };
  }

  private async getTakumi<T>(url: URL, cookies: GenshinCookieFields): Promise<TakumiResponse<T>> {
    return this.requestJson<T>(url, {
      method: 'GET',
      headers: this.baseHeaders(cookies),
    });
  }

  private async postTakumi<T>(url: URL, cookies: GenshinCookieFields, body: string, headers: Record<string, string>): Promise<TakumiResponse<T>> {
    return this.requestJson<T>(url, {
      method: 'POST',
      headers: this.baseHeaders(cookies, headers),
      body,
    });
  }

  private async postPassportQr<T>(url: URL, body: string): Promise<TakumiResponse<T>> {
    return this.requestJson<T>(url, {
      method: 'POST',
      headers: this.passportQrHeaders(),
      body,
    });
  }

  private async fetchDeviceFp(): Promise<string> {
    const body = JSON.stringify({
      seed_id: randomAlphaNum(13),
      device_id: this.deviceId,
      platform: '1',
      seed_time: String(Date.now()),
      ext_fields: JSON.stringify({
        IDFV: randomUUID().toUpperCase(),
        model: 'iPhone16,1',
        osVersion: '17.0.3',
        screenSize: '393x852',
        vendor: '--',
        cpuType: 'CPU_TYPE_ARM64',
        cpuCores: '16',
        isJailBreak: '0',
        networkType: 'WIFI',
        proxyStatus: '0',
        batteryStatus: '80',
        chargeStatus: '0',
        romCapacity: '256000',
        romRemain: '128000',
        ramCapacity: '8192',
        ramRemain: '4096',
        appMemory: '80',
        accelerometer: '0x0x0',
        gyroscope: '0x0x0',
        magnetometer: '0x0x0',
      }),
      app_name: 'bbs_cn',
      device_fp: randomDigits(13),
    });
    const payload = await this.requestRawJson<{ retcode?: number; message?: string; data?: { code?: number; msg?: string; device_fp?: string } }>(new URL(DEVICE_FP_URL), {
      method: 'POST',
      headers: this.baseHeaders(undefined, { 'content-type': 'application/json;charset=utf-8' }),
      body,
    });
    if (payload.retcode !== 0 || payload.data?.code !== 200 || !payload.data.device_fp) {
      throw new GenshinTakumiError(payload.message || payload.data?.msg || '米游社设备指纹获取失败。', {
        retcode: payload.retcode ?? null,
        diagnostic: `getFp retcode=${payload.retcode ?? 'null'} code=${payload.data?.code ?? 'null'}`,
      });
    }
    return payload.data.device_fp;
  }

  private async requestJson<T>(url: URL, init: RequestInit): Promise<TakumiResponse<T>> {
    const payload = await this.requestRawJson<TakumiResponse<T>>(url, init);
    if (payload.retcode !== 0) {
      throw new GenshinTakumiError(payload.message || '米游社接口返回失败。', {
        retcode: payload.retcode,
        diagnostic: `${init.method ?? 'GET'} ${url.pathname} retcode=${payload.retcode}`,
      });
    }
    return payload;
  }

  private async requestRawJson<T>(url: URL, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw new GenshinTakumiError('米游社接口请求失败，请稍后重试。', {
        retcode: null,
        diagnostic: describeError(error),
        cause: error,
      });
    }
    const text = await response.text();
    if (!response.ok) {
      throw new GenshinTakumiError('米游社接口 HTTP 请求失败。', {
        retcode: null,
        diagnostic: `${init.method ?? 'GET'} ${url.pathname} status=${response.status} body=${clipDiagnostic(text)}`,
      });
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new GenshinTakumiError('米游社接口返回了非 JSON 内容。', {
        retcode: null,
        diagnostic: `${init.method ?? 'GET'} ${url.pathname} body=${clipDiagnostic(text)}`,
        cause: error,
      });
    }
  }

  private baseHeaders(cookies?: GenshinCookieFields, extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh-Hans;q=0.9',
      origin: 'https://act.mihoyo.com',
      referer: 'https://act.mihoyo.com/',
      'user-agent': this.userAgent,
      'x-requested-with': 'com.mihoyo.hyperion',
      'x-rpc-app_version': this.appVersion,
      'x-rpc-client_type': this.clientType,
      'x-rpc-device_id': this.deviceId,
      'x-rpc-signgame': 'hk4e',
      ...(cookies ? { cookie: buildGenshinCookieHeader(cookies) } : {}),
      ...extra,
    };
  }

  private cookieTokenRoleHeaders(cookies: GenshinCookieFields): Record<string, string> {
    return {
      accept: 'application/json, text/plain, */*',
      cookie: buildCookieHeaderPairs([
        ['account_id', cookies.account_id],
        ['cookie_token', cookies.cookie_token],
      ]),
    };
  }

  private passportQrHeaders(): Record<string, string> {
    return {
      accept: 'application/json, text/plain, */*',
      'user-agent': PASSPORT_QR_USER_AGENT,
      'x-rpc-app_id': PASSPORT_QR_APP_ID,
      'x-rpc-client_type': PASSPORT_QR_CLIENT_TYPE,
      'x-rpc-device_id': this.deviceId,
      'content-type': 'application/json',
    };
  }
}

function createDs1(query: string, body: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const random = randomAlphaNum(6);
  const digest = md5(`salt=${DS1_SALT}&t=${timestamp}&r=${random}&b=${body}&q=${query}`);
  return `${timestamp},${random},${digest}`;
}

function createDs2(): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const random = randomAlphaNum(6);
  const digest = md5(`salt=${DS2_SALT}&t=${timestamp}&r=${random}`);
  return `${timestamp},${random},${digest}`;
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

function randomAlphaNum(length: number): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function randomDigits(length: number): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => String(byte % 10)).join('');
}

function normalizeLevel(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeGachaLogItem(item: GachaLogPayloadItem): GenshinGachaLogItem {
  const gachaType = normalizeGachaType(item.gacha_type);
  const normalized = {
    gachaType,
    itemId: String(item.item_id ?? '').trim(),
    count: String(item.count ?? '').trim(),
    time: String(item.time ?? '').trim(),
    name: String(item.name ?? '').trim(),
    itemType: String(item.item_type ?? '').trim(),
    rankType: String(item.rank_type ?? '').trim(),
    id: String(item.id ?? '').trim(),
  };
  if (!normalized.itemId || !normalized.count || !normalized.time || !normalized.name || !normalized.itemType || !normalized.rankType || !normalized.id) {
    throw new GenshinTakumiError('米游社返回了无效抽卡记录。', {
      retcode: null,
      diagnostic: `invalid gacha log item id=${normalized.id || 'missing'}`,
    });
  }
  return normalized;
}

function normalizeGachaType(value: unknown): GenshinGachaType {
  const gachaType = String(value ?? '').trim();
  if (GENSHIN_GACHA_TYPES.includes(gachaType as GenshinGachaType)) {
    return gachaType as GenshinGachaType;
  }
  throw new GenshinTakumiError('米游社返回了未知抽卡记录卡池类型。', {
    retcode: null,
    diagnostic: `unknown gacha_type=${gachaType || 'missing'}`,
  });
}

function readQrTicket(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return url.searchParams.get('ticket')?.trim() || url.searchParams.get('tk')?.trim() || '';
  } catch {
    return '';
  }
}

function buildCookieHeaderPairs(pairs: Array<[string, string | undefined]>): string {
  return pairs
    .flatMap(([name, value]) => {
      const normalized = String(value ?? '').trim();
      return normalized ? [`${name}=${normalized}`] : [];
    })
    .join('; ');
}

function normalizeQrLoginStatus(value: unknown): GenshinQrLoginStatus {
  if (value === 'Created') return 'Init';
  if (value === 'Scanned' || value === 'Confirmed') return value;
  throw new GenshinTakumiError('米游社返回了未知扫码登录状态。', {
    retcode: null,
    diagnostic: `unknown qrcode status=${String(value)}`,
  });
}

function parsePassportQrCookies(data: QrQueryPayload | undefined, retcode: number): GenshinCookieFields {
  const stoken = String(data?.tokens?.find((token) => token.token_type === 1)?.token ?? '').trim();
  const mid = String(data?.user_info?.mid ?? '').trim();
  const aid = String(data?.user_info?.aid ?? '').trim();
  if (!stoken || !mid || !aid) {
    throw new GenshinTakumiError('米游社扫码登录未返回有效 stoken + mid + stuid。', {
      retcode,
      diagnostic: 'passport qrcode confirmed without stoken, mid, or aid',
    });
  }
  return {
    stoken,
    mid,
    account_id: aid,
    login_uid: aid,
    stuid: aid,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function clipDiagnostic(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500);
}
