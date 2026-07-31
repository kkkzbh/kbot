import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { buildGenshinCookieHeader } from './cookie.js';
import {
  createMemoryGenshinDeviceProfileStore,
  type GenshinDeviceProfileStoreLike,
} from './device-profile.js';
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
const API_TAKUMI_RECORD_BASE_URL = 'https://api-takumi-record.mihoyo.com';
const PASSPORT_API_BASE_URL = 'https://passport-api.mihoyo.com';
const DEVICE_FP_URL = 'https://public-data-api.mihoyo.com/device-fp/api/getFp';
const GACHA_LOG_BASE_URL = 'https://public-operation-hk4e.mihoyo.com';
const DAILY_NOTE_PATH = '/game_record/app/genshin/api/dailyNote';
const GAME_RECORD_INDEX_PATH = '/game_record/app/genshin/api/index';
const GAME_RECORD_CREATE_VERIFICATION_PATH = '/game_record/app/card/wapi/createVerification';
const GAME_RECORD_VERIFY_VERIFICATION_PATH = '/game_record/app/card/wapi/verifyVerification';
const GAME_RECORD_APP_VERSION = '2.95.1';
const GAME_RECORD_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/${GAME_RECORD_APP_VERSION}`;
const GAME_RECORD_TOOL_VERSION = 'v5.0.1-ys';
const PASSPORT_QR_APP_ID = 'ddxf5dufpuyo';
const PASSPORT_QR_CLIENT_TYPE = '3';
const PASSPORT_QR_USER_AGENT = 'HYPContainer/1.3.3.182';
const QR_EXPIRED_RETCODE = -106;
const GACHA_AUTH_APPID = 'webview_gacha';
const CONTENT_DS_SALT = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs';
const SIGN_DS_SALT = '9nQiU3AV0rJSIBWgdynfoGMGKaklfbM7';

export interface GenshinTakumiClientOptions {
  fetchImpl?: typeof fetch;
  appVersion?: string;
  clientType?: string;
  actId?: string;
  userAgent?: string;
  deviceId?: string;
  deviceProfileStore?: GenshinDeviceProfileStoreLike;
  now?: () => number;
  recordNonce?: () => number;
}

export interface GenshinSignResult {
  status: 'ok' | 'already_done';
  retcode: number;
  message: string;
  totalSignDay: number | null;
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

export interface GenshinDailyNoteExpedition {
  avatarSideIcon: string;
  status: 'Finished' | 'Ongoing';
  remainedSeconds: number;
}

export interface GenshinDailyNoteTransformer {
  obtained: boolean;
  reached: boolean;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface GenshinDailyNote {
  currentResin: number;
  maxResin: number;
  resinRecoverySeconds: number;
  finishedTaskNum: number;
  totalTaskNum: number;
  isExtraTaskRewardReceived: boolean;
  remainResinDiscountNum: number;
  resinDiscountNumLimit: number;
  currentExpeditionNum: number;
  maxExpeditionNum: number;
  expeditions: GenshinDailyNoteExpedition[];
  currentHomeCoin: number;
  maxHomeCoin: number;
  homeCoinRecoverySeconds: number;
  transformer: GenshinDailyNoteTransformer;
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

interface LTokenPayload {
  ltoken?: string;
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

interface DailyNotePayload {
  current_resin?: unknown;
  max_resin?: unknown;
  resin_recovery_time?: unknown;
  finished_task_num?: unknown;
  total_task_num?: unknown;
  is_extra_task_reward_received?: unknown;
  remain_resin_discount_num?: unknown;
  resin_discount_num_limit?: unknown;
  current_expedition_num?: unknown;
  max_expedition_num?: unknown;
  expeditions?: unknown;
  current_home_coin?: unknown;
  max_home_coin?: unknown;
  home_coin_recovery_time?: unknown;
  transformer?: unknown;
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

export interface GenshinDailyNoteVerification {
  gt: string;
  challenge: string;
  path: string;
}

export interface GenshinDailyNoteVerificationContext {
  challenge: string;
  path: string;
}

export class GenshinDailyNoteVerificationRequiredError extends GenshinTakumiError {
  readonly verification: GenshinDailyNoteVerification;

  constructor(verification: GenshinDailyNoteVerification, retcode: number) {
    super('米游社要求完成人机验证后才能读取实时便笺。', {
      retcode,
      diagnostic: `game record verification required path=${verification.path} retcode=${retcode}`,
    });
    this.name = 'GenshinDailyNoteVerificationRequiredError';
    this.verification = verification;
  }
}

export class GenshinTakumiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly appVersion: string;
  private readonly clientType: string;
  private readonly actId: string;
  private readonly userAgent: string;
  private readonly deviceId: string;
  private readonly deviceProfileStore: GenshinDeviceProfileStoreLike;
  private readonly now: () => number;
  private readonly recordNonce: () => number;

  constructor(options: GenshinTakumiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.appVersion = options.appVersion ?? '2.70.1';
    this.clientType = options.clientType ?? '5';
    this.actId = options.actId ?? 'e202311201442471';
    this.userAgent = options.userAgent ?? `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) miHoYoBBS/${this.appVersion}`;
    if (options.deviceId && options.deviceProfileStore) {
      throw new Error('genshin client accepts either deviceId or deviceProfileStore.');
    }
    this.deviceProfileStore = options.deviceProfileStore ?? createMemoryGenshinDeviceProfileStore(options.deviceId);
    this.deviceId = this.deviceProfileStore.profile.deviceId;
    this.now = options.now ?? (() => Date.now());
    this.recordNonce = options.recordNonce ?? (() => randomInt(100_001, 200_001));
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

  async exchangeLToken(cookies: GenshinCookieFields): Promise<GenshinCookieFields> {
    const stuid = String(cookies.stuid ?? cookies.account_id ?? cookies.login_uid ?? '').trim();
    if (!cookies.stoken || !cookies.mid || !stuid) {
      throw new GenshinTakumiError('当前登录凭据缺少 stoken + mid + stuid，无法换取 ltoken。', {
        retcode: null,
        diagnostic: 'exchangeLToken missing stoken, mid, or stuid',
      });
    }
    const payload = await this.requestJson<LTokenPayload>(new URL('/account/auth/api/getLTokenBySToken', PASSPORT_API_BASE_URL), {
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
    const ltoken = String(payload.data?.ltoken ?? '').trim();
    if (!ltoken) {
      throw new GenshinTakumiError('米游社未返回有效 ltoken。', {
        retcode: payload.retcode,
        diagnostic: 'ltoken exchange missing ltoken',
      });
    }
    return {
      ...cookies,
      ltoken,
      ltuid: stuid,
    };
  }

  async completeAccountTokens(cookies: GenshinCookieFields): Promise<GenshinCookieFields> {
    const withCookieToken = cookies.cookie_token && cookies.account_id
      ? cookies
      : await this.exchangeCookieToken(cookies);
    return withCookieToken.ltoken && withCookieToken.ltuid
      ? withCookieToken
      : this.exchangeLToken(withCookieToken);
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
      ds: createSignDs(),
    });
    return {
      status: 'ok',
      retcode: payload.retcode,
      message: payload.message || 'OK',
      totalSignDay: info.totalSignDay == null ? null : info.totalSignDay + 1,
    };
  }

  async fetchDailyNote(
    cookies: GenshinCookieFields,
    role: GenshinGameRole,
    verification?: GenshinDailyNoteVerificationContext,
  ): Promise<GenshinDailyNote> {
    const deviceFp = await this.fetchDeviceFp();
    const query = canonicalQuery(new URLSearchParams({ role_id: role.uid, server: role.region }));
    await this.requestGameRecord<unknown>(GAME_RECORD_INDEX_PATH, query, cookies, deviceFp, {
      challenge: verification?.path === GAME_RECORD_INDEX_PATH ? verification.challenge : '',
    });
    const payload = await this.requestGameRecord<DailyNotePayload>(DAILY_NOTE_PATH, query, cookies, deviceFp, {
      challenge: verification?.path === DAILY_NOTE_PATH ? verification.challenge : '',
      toolVersion: true,
    });
    return normalizeDailyNote(payload.data);
  }

  async verifyDailyNoteChallenge(
    cookies: GenshinCookieFields,
    verification: GenshinDailyNoteVerification,
    validate: string,
  ): Promise<string> {
    const normalizedValidate = validate.trim();
    if (!normalizedValidate) {
      throw new GenshinTakumiError('人机验证结果为空，请重新验证。', {
        retcode: null,
        diagnostic: 'daily note verification missing validate',
      });
    }
    const deviceFp = await this.fetchDeviceFp();
    const body = JSON.stringify({
      geetest_challenge: verification.challenge,
      geetest_validate: normalizedValidate,
      geetest_seccode: `${normalizedValidate}|jordan`,
    });
    const url = new URL(GAME_RECORD_VERIFY_VERIFICATION_PATH, API_TAKUMI_RECORD_BASE_URL);
    const payload = await this.requestRawJson<TakumiResponse<{ challenge?: string }>>(url, {
      method: 'POST',
      headers: this.gameRecordHeaders(cookies, '', deviceFp, {
        body,
        challengePath: verification.path,
        contentType: true,
      }),
      body,
    });
    if (payload.retcode !== 0) {
      throw new GenshinTakumiError(payload.message || '米游社人机验证失败，请重新验证。', {
        retcode: payload.retcode,
        diagnostic: `POST ${GAME_RECORD_VERIFY_VERIFICATION_PATH} retcode=${payload.retcode}`,
      });
    }
    const challenge = String(payload.data?.challenge ?? '').trim();
    if (!challenge) {
      throw new GenshinTakumiError('米游社未返回有效验证凭据。', {
        retcode: payload.retcode,
        diagnostic: 'verifyVerification missing challenge',
      });
    }
    return challenge;
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
    const url = new URL('/gacha_info/api/getGachaLog', GACHA_LOG_BASE_URL);
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
      ds: createContentDs('', body, this.now, this.recordNonce),
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
    if (this.deviceProfileStore.profile.deviceFp) {
      return this.deviceProfileStore.profile.deviceFp;
    }
    const profile = this.deviceProfileStore.profile;
    const body = JSON.stringify({
      device_id: profile.fingerprintDeviceId,
      seed_id: randomUUID(),
      seed_time: String(this.now()),
      platform: '2',
      device_fp: randomBytes(7).toString('hex').slice(0, 13),
      app_name: 'bbs_cn',
      bbs_device_id: profile.deviceId,
      ext_fields: JSON.stringify(androidFingerprintFields(profile.deviceName, profile.productName)),
    });
    const payload = await this.requestRawJson<{ retcode?: number; message?: string; data?: { device_fp?: string } }>(new URL(DEVICE_FP_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const deviceFp = String(payload.data?.device_fp ?? '').trim();
    if (payload.retcode !== 0 || !deviceFp) {
      throw new GenshinTakumiError(payload.message || '米游社设备指纹获取失败。', {
        retcode: payload.retcode ?? null,
        diagnostic: `getFp retcode=${payload.retcode ?? 'null'}`,
      });
    }
    this.deviceProfileStore.saveDeviceFp(deviceFp);
    return deviceFp;
  }

  private async requestGameRecord<T>(
    path: string,
    query: string,
    cookies: GenshinCookieFields,
    deviceFp: string,
    options: { challenge?: string; toolVersion?: boolean } = {},
  ): Promise<TakumiResponse<T>> {
    const url = new URL(path, API_TAKUMI_RECORD_BASE_URL);
    url.search = query;
    const payload = await this.requestRawJson<TakumiResponse<T>>(url, {
      method: 'GET',
      headers: this.gameRecordHeaders(cookies, query, deviceFp, {
        challenge: options.challenge,
        toolVersion: options.toolVersion,
      }),
    });
    if ([1034, 5003, 10306].includes(payload.retcode)) {
      const verification = await this.createDailyNoteVerification(cookies, path, deviceFp);
      throw new GenshinDailyNoteVerificationRequiredError(verification, payload.retcode);
    }
    if (payload.retcode !== 0) {
      throw new GenshinTakumiError(payload.message || `米游社请求失败（错误码 ${payload.retcode}）。`, {
        retcode: payload.retcode,
        diagnostic: `GET ${path} retcode=${payload.retcode}`,
      });
    }
    return payload;
  }

  private async createDailyNoteVerification(
    cookies: GenshinCookieFields,
    path: string,
    deviceFp: string,
  ): Promise<GenshinDailyNoteVerification> {
    const query = 'is_high=true';
    const url = new URL(GAME_RECORD_CREATE_VERIFICATION_PATH, API_TAKUMI_RECORD_BASE_URL);
    url.search = query;
    const payload = await this.requestJson<{ gt?: string; challenge?: string }>(url, {
      method: 'GET',
      headers: this.gameRecordHeaders(cookies, query, deviceFp, { challengePath: path }),
    });
    const gt = String(payload.data?.gt ?? '').trim();
    const challenge = String(payload.data?.challenge ?? '').trim();
    if (!gt || !challenge) {
      throw new GenshinTakumiError('米游社未返回有效人机验证参数。', {
        retcode: payload.retcode,
        diagnostic: `createVerification missing gt or challenge path=${path}`,
      });
    }
    return { gt, challenge, path };
  }

  private gameRecordHeaders(
    cookies: GenshinCookieFields,
    query: string,
    deviceFp: string,
    options: {
      body?: string;
      challenge?: string;
      challengePath?: string;
      contentType?: boolean;
      toolVersion?: boolean;
    } = {},
  ): Record<string, string> {
    return {
      accept: 'application/json',
      cookie: gameRecordCookieHeader(cookies),
      ds: createContentDs(query, options.body ?? '', this.now, this.recordNonce),
      referer: 'https://webstatic.mihoyo.com',
      'user-agent': GAME_RECORD_USER_AGENT,
      'x-rpc-app_version': GAME_RECORD_APP_VERSION,
      'x-rpc-client_type': '5',
      'x-rpc-device_id': this.deviceId,
      'x-rpc-device_fp': deviceFp,
      ...(options.challenge ? { 'x-rpc-challenge': options.challenge } : {}),
      ...(options.challengePath ? {
        'x-rpc-challenge_game': '2',
        'x-rpc-challenge_path': options.challengePath,
      } : {}),
      ...(options.contentType ? { 'content-type': 'application/json' } : {}),
      ...(options.toolVersion ? { 'x-rpc-tool_verison': GAME_RECORD_TOOL_VERSION } : {}),
    };
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

function createContentDs(
  query: string,
  body: string,
  now: () => number,
  nonceFactory: () => number,
): string {
  const timestamp = Math.floor(now() / 1000);
  const nonce = nonceFactory();
  if (!Number.isInteger(nonce) || nonce < 100_001 || nonce > 200_000) {
    throw new Error('genshin content DS nonce must be an integer from 100001 through 200000.');
  }
  const normalizedQuery = canonicalQuery(new URLSearchParams(query));
  const digest = md5(`salt=${CONTENT_DS_SALT}&t=${timestamp}&r=${nonce}&b=${body}&q=${normalizedQuery}`);
  return `${timestamp},${nonce},${digest}`;
}

function createSignDs(): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const random = randomAlphaNum(6);
  const digest = md5(`salt=${SIGN_DS_SALT}&t=${timestamp}&r=${random}`);
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

function canonicalQuery(searchParams: URLSearchParams): string {
  return new URLSearchParams([...searchParams.entries()].sort(([left], [right]) => left.localeCompare(right))).toString();
}

function gameRecordCookieHeader(cookies: GenshinCookieFields): string {
  const accountId = String(cookies.account_id ?? '').trim();
  const cookieToken = String(cookies.cookie_token ?? '').trim();
  const ltoken = String(cookies.ltoken ?? '').trim();
  const ltuid = String(cookies.ltuid ?? '').trim();
  if (!accountId || !cookieToken || !ltoken || !ltuid) {
    throw new GenshinTakumiError('当前登录凭据缺少实时便笺所需的登录字段，请重新绑定原神账号。', {
      retcode: null,
      diagnostic: 'game record cookie missing account_id, cookie_token, ltoken, or ltuid',
    });
  }
  return buildCookieHeaderPairs([
    ['account_id', accountId],
    ['cookie_token', cookieToken],
    ['ltoken', ltoken],
    ['ltuid', ltuid],
  ]);
}

function androidFingerprintFields(deviceName: string, productName: string): Record<string, string | number> {
  return {
    proxyStatus: 0,
    isRoot: 0,
    romCapacity: '512',
    deviceName,
    productName,
    romRemain: '512',
    hostname: 'dg02-pool03-kvm87',
    screenSize: '1440x2905',
    isTablet: 0,
    aaid: '',
    model: deviceName,
    brand: 'XiaoMi',
    hardware: 'qcom',
    deviceType: 'OP5913L1',
    devId: 'REL',
    serialNumber: 'unknown',
    sdCapacity: 512215,
    buildTime: '1693626947000',
    buildUser: 'android-build',
    simState: 5,
    ramRemain: '239814',
    appUpdateTimeDiff: 1702604034482,
    deviceInfo: `XiaoMi/${productName}/OP5913L1:13/SKQ1.221119.001/T.118e6c7-5aa23-73911:user/release-keys`,
    vaid: '',
    buildType: 'user',
    sdkVersion: '34',
    ui_mode: 'UI_MODE_TYPE_NORMAL',
    isMockLocation: 0,
    cpuType: 'arm64-v8a',
    isAirMode: 0,
    ringMode: 2,
    chargeStatus: 1,
    manufacturer: 'XiaoMi',
    emulatorStatus: 0,
    appMemory: '512',
    osVersion: '14',
    vendor: 'unknown',
    accelerometer: '1.4883357x7.1712894x6.2847486',
    sdRemain: 239600,
    buildTags: 'release-keys',
    packageName: 'com.mihoyo.hyperion',
    networkType: 'WiFi',
    oaid: '',
    debugStatus: 1,
    ramCapacity: '469679',
    magnetometer: '20.081251x-27.487501x2.1937501',
    display: `${productName}_13.1.0.181(CN01)`,
    appInstallTimeDiff: 1688455751496,
    packageVersion: '2.20.1',
    gyroscope: '0.030226856x0.014647375x0.010652636',
    batteryStatus: 100,
    hasKeyboard: 0,
    board: 'taro',
  };
}

function normalizeDailyNote(payload: DailyNotePayload | undefined): GenshinDailyNote {
  if (!payload || typeof payload !== 'object') {
    throw invalidDailyNote('dailyNote missing data object');
  }
  const expeditions = requireArray(payload.expeditions, 'expeditions').map((item, index) => {
    const record = requireObject(item, `expeditions[${index}]`);
    const status = record.status;
    if (status !== 'Finished' && status !== 'Ongoing') {
      throw invalidDailyNote(`expeditions[${index}].status is invalid`);
    }
    return {
      avatarSideIcon: requireString(record.avatar_side_icon, `expeditions[${index}].avatar_side_icon`),
      status: status as GenshinDailyNoteExpedition['status'],
      remainedSeconds: requireSeconds(record.remained_time, `expeditions[${index}].remained_time`),
    };
  });
  const transformer = requireObject(payload.transformer, 'transformer');
  const recoveryTime = requireObject(transformer.recovery_time, 'transformer.recovery_time');
  return {
    currentResin: requireNonNegativeInteger(payload.current_resin, 'current_resin'),
    maxResin: requirePositiveInteger(payload.max_resin, 'max_resin'),
    resinRecoverySeconds: requireSeconds(payload.resin_recovery_time, 'resin_recovery_time'),
    finishedTaskNum: requireNonNegativeInteger(payload.finished_task_num, 'finished_task_num'),
    totalTaskNum: requireNonNegativeInteger(payload.total_task_num, 'total_task_num'),
    isExtraTaskRewardReceived: requireBoolean(payload.is_extra_task_reward_received, 'is_extra_task_reward_received'),
    remainResinDiscountNum: requireNonNegativeInteger(payload.remain_resin_discount_num, 'remain_resin_discount_num'),
    resinDiscountNumLimit: requireNonNegativeInteger(payload.resin_discount_num_limit, 'resin_discount_num_limit'),
    currentExpeditionNum: requireNonNegativeInteger(payload.current_expedition_num, 'current_expedition_num'),
    maxExpeditionNum: requireNonNegativeInteger(payload.max_expedition_num, 'max_expedition_num'),
    expeditions,
    currentHomeCoin: requireNonNegativeInteger(payload.current_home_coin, 'current_home_coin'),
    maxHomeCoin: requireNonNegativeInteger(payload.max_home_coin, 'max_home_coin'),
    homeCoinRecoverySeconds: requireSeconds(payload.home_coin_recovery_time, 'home_coin_recovery_time'),
    transformer: {
      obtained: requireBoolean(transformer.obtained, 'transformer.obtained'),
      reached: requireBoolean(recoveryTime.reached, 'transformer.recovery_time.reached'),
      day: requireNonNegativeInteger(recoveryTime.Day, 'transformer.recovery_time.Day'),
      hour: requireNonNegativeInteger(recoveryTime.Hour, 'transformer.recovery_time.Hour'),
      minute: requireNonNegativeInteger(recoveryTime.Minute, 'transformer.recovery_time.Minute'),
      second: requireNonNegativeInteger(recoveryTime.Second, 'transformer.recovery_time.Second'),
    },
  };
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidDailyNote(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw invalidDailyNote(`${field} must be an array`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidDailyNote(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw invalidDailyNote(`${field} must be a boolean`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidDailyNote(`${field} must be a non-negative integer`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const parsed = requireNonNegativeInteger(value, field);
  if (parsed === 0) {
    throw invalidDailyNote(`${field} must be positive`);
  }
  return parsed;
}

function requireSeconds(value: unknown, field: string): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw invalidDailyNote(`${field} must be a non-negative integer string`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidDailyNote(`${field} exceeds the supported integer range`);
  }
  return parsed;
}

function invalidDailyNote(diagnostic: string): GenshinTakumiError {
  return new GenshinTakumiError('米游社未返回有效原神状态数据。', {
    retcode: 0,
    diagnostic,
  });
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
  if (!normalized.count || !normalized.time || !normalized.name || !normalized.itemType || !normalized.rankType || !normalized.id) {
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
