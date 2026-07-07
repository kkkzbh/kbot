import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { buildGenshinCookieHeader } from './cookie.js';
import {
  GENSHIN_GAME_BIZ,
  type GenshinCookieFields,
  type GenshinGameRole,
} from './types.js';

const API_TAKUMI_BASE_URL = 'https://api-takumi.mihoyo.com';
const DEVICE_FP_URL = 'https://public-data-api.mihoyo.com/device-fp/api/getFp';
const REDEEM_BASE_URL = 'https://hk4e-api.mihoyo.com';
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

interface SignInfoPayload {
  is_sign?: boolean;
  total_sign_day?: number;
}

interface AuthKeyPayload {
  sign_type?: number;
  authkey_ver?: number;
  authkey?: string;
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
    const url = new URL('/binding/api/getUserGameRolesByCookie', API_TAKUMI_BASE_URL);
    url.searchParams.set('game_biz', GENSHIN_GAME_BIZ);
    const payload = await this.getTakumi<RoleListPayload>(url, cookies);
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
    const authKey = await this.genAuthKey(cookies, role);
    const url = new URL('/common/apicdkey/api/exchangeCdkey', REDEEM_BASE_URL);
    url.searchParams.set('sign_type', String(authKey.signType));
    url.searchParams.set('auth_appid', 'apicdkey');
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

  private async genAuthKey(cookies: GenshinCookieFields, role: GenshinGameRole): Promise<{ signType: number; authkeyVer: number; authkey: string }> {
    const body = JSON.stringify({
      auth_appid: 'apicdkey',
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

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function clipDiagnostic(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500);
}
