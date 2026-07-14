import { sm2 } from 'sm-crypto';
import { CampusAuthUserError } from '../campus-auth-core/index.js';
import type {
  SecondClassCaptcha,
  SecondClassLoginInput,
  SecondClassPage,
  SecondClassSessionPayload,
  SecondClassUserInfo,
} from './types.js';
import {
  SecondClassApiError,
  SecondClassSessionExpiredError,
} from './types.js';
import {
  secondClassCaptchaDataSchema,
  secondClassEnvelopeSchema,
  secondClassSm2KeyDataSchema,
  secondClassTokenDataSchema,
} from './protocol.js';

const SECOND_CLASS_API_BASE = 'https://api.zq2ke.com';
export const HBU_SECOND_CLASS_SCHOOL_IDS = new Set([
  '1101092545313637006',
  '1150468423570948814',
]);

export interface SecondClassHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

export interface SecondClassHttpResponse {
  status: number;
  text: string;
}

export type SecondClassHttpTransport = (request: SecondClassHttpRequest) => Promise<SecondClassHttpResponse>;

interface ApiEnvelope {
  code: number;
  message: string;
  data: unknown;
}

export class SecondClassHttpClient {
  constructor(private readonly transport: SecondClassHttpTransport = defaultTransport) {}

  async getCaptcha(): Promise<SecondClassCaptcha> {
    const response = await this.request('/app/common/captcha/image');
    const parsed = secondClassCaptchaDataSchema.safeParse(response.data);
    if (!parsed.success) throw new SecondClassApiError('二课验证码响应不完整。', 0, 200);
    const { uuid, img: image } = parsed.data;
    return {
      uuid,
      imageDataUrl: image.startsWith('data:') ? image : `data:image/png;base64,${image}`,
    };
  }

  async directLogin(input: SecondClassLoginInput): Promise<SecondClassSessionPayload> {
    const keyEnvelope = await this.request('/app/common/sm2/getKey');
    const parsedKey = secondClassSm2KeyDataSchema.safeParse(keyEnvelope.data);
    if (!parsedKey.success) throw new SecondClassApiError('二课 SM2 公钥缺失。', 0, 200);
    const publicKey = parsedKey.data.publicKeyQ;
    const login = await this.request('/auth/h5/login', {
      method: 'POST',
      body: {
        uuid: input.captchaUuid,
        loginName: input.loginName,
        password: sm2.doEncrypt(input.password, publicKey, 1),
        code: input.captchaCode,
        passwordEncrypt: true,
      },
    });
    return this.buildSession(requireToken(login.data), await this.getUserInfo(requireToken(login.data)));
  }

  async importToken(token: string): Promise<SecondClassSessionPayload> {
    const normalized = token.trim().replace(/^Bearer\s+/i, '');
    if (!normalized) throw new CampusAuthUserError('请填写二课 Token。');
    return this.buildSession(normalized, await this.getUserInfo(normalized));
  }

  async loginWithZyhAppCode(zyhCode: string): Promise<SecondClassSessionPayload> {
    const normalized = zyhCode.trim();
    if (!normalized) throw new CampusAuthUserError('志愿汇 App 没有返回临时授权码。');
    const login = await this.request('/auth/h5/auth/login', { method: 'POST', zyhCode: normalized });
    const token = requireToken(login.data);
    return this.buildSession(token, await this.getUserInfo(token));
  }

  async getUserInfo(token: string): Promise<SecondClassUserInfo> {
    const infoEnvelope = await this.request('/app/h5/info', { token });
    const raw = requireRecord(infoEnvelope.data, '二课账号信息响应缺少数据。');
    const schoolEnvelope = await this.request('/app/h5/school/info', { token });
    const schoolRaw = requireRecord(schoolEnvelope.data, '二课学校信息响应缺少数据。');
    const schoolId = firstText(schoolRaw, ['id', 'schoolId', 'schoolBaseInfoId'])
      || findNestedText(raw, new Set(['schoolId', 'schoolBaseInfoId']));
    const schoolName = firstText(schoolRaw, ['name', 'schoolName'])
      || findNestedText(raw, new Set(['schoolName']));
    if (schoolName !== '河北大学' || !HBU_SECOND_CLASS_SCHOOL_IDS.has(schoolId)) {
      throw new CampusAuthUserError('当前二课账号不属于河北大学。');
    }
    const user = asRecord(raw.user);
    return {
      raw,
      schoolId,
      schoolName,
      studentNo: firstText(raw, ['studentNo', 'userNo']) || firstText(user, ['studentNo', 'userNo']),
      accountName: firstText(user, ['nickName', 'name', 'realName']) || firstText(raw, ['name', 'nickName']),
      phone: firstText(raw, ['phone', 'mobile']) || firstText(user, ['phone', 'mobile']),
    };
  }

  getCreditDetails(token: string): Promise<unknown> {
    return this.data('/app/h5/student/creditDetails', token);
  }

  getTranscript(token: string): Promise<unknown> {
    return this.data('/app/h5/studentTranscript/transcript', token);
  }

  getRadar(token: string): Promise<unknown> {
    return this.data('/app/h5/studentTranscript/type/radar-chart', token);
  }

  getSemesterGrades(token: string): Promise<unknown> {
    return this.data('/app/h5/studentTranscript/year-semester/grades', token);
  }

  async listActivities(token: string, page = 1): Promise<SecondClassPage> {
    return normalizePage(await this.data('/app/h5/activity/page', token, { current: page, size: 10 }));
  }

  async listMyActivities(token: string, page = 1): Promise<SecondClassPage> {
    return normalizePage(await this.data('/app/h5/activity/getMyActivityPage', token, { current: page, size: 10 }));
  }

  async listCreditRecords(token: string, page = 1): Promise<SecondClassPage> {
    return normalizePage(await this.data('/app/h5/creditRecord/page', token, { current: page, size: 10 }));
  }

  private async data(path: string, token: string, query?: Record<string, string | number>): Promise<unknown> {
    return (await this.request(path, { token, query })).data;
  }

  private async request(
    path: string,
    options: {
      method?: 'GET' | 'POST';
      token?: string;
      zyhCode?: string;
      body?: Record<string, unknown>;
      query?: Record<string, string | number>;
      acceptedCodes?: number[];
    } = {},
  ): Promise<ApiEnvelope> {
    const url = new URL(path, SECOND_CLASS_API_BASE);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'qqbot-hbu-second-class/1.0',
    };
    if (options.token) headers.Authorization = options.token;
    if (options.zyhCode) headers.token = options.zyhCode;
    const response = await this.transport({
      url: url.toString(),
      method: options.method ?? 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(response.text);
    } catch {
      throw new SecondClassApiError('二课返回了无法解析的响应。', 0, response.status);
    }
    const parsed = secondClassEnvelopeSchema.safeParse(raw);
    if (!parsed.success) throw new SecondClassApiError('二课响应结构无效。', 0, response.status);
    const envelope = parsed.data;
    const code = envelope.code;
    const message = text(envelope.msg || envelope.message) || '二课请求失败。';
    if (response.status === 401 || code === 401) throw new SecondClassSessionExpiredError(message);
    const accepted = options.acceptedCodes ?? [200];
    if (!accepted.includes(code)) throw new SecondClassApiError(message, Number.isFinite(code) ? code : 0, response.status);
    return { code, message, data: envelope.data };
  }

  private buildSession(token: string, info: SecondClassUserInfo): SecondClassSessionPayload {
    return {
      token,
      schoolId: info.schoolId,
      schoolName: info.schoolName,
      studentNo: info.studentNo,
      accountName: info.accountName,
    };
  }
}

async function defaultTransport(request: SecondClassHttpRequest): Promise<SecondClassHttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, text: await response.text() };
}

function requireToken(data: unknown): string {
  const parsed = secondClassTokenDataSchema.safeParse(data);
  if (!parsed.success) throw new SecondClassApiError('二课登录响应缺少 Token。', 0, 200);
  return parsed.data.token;
}

function normalizePage(value: unknown): SecondClassPage {
  const raw = asRecord(value);
  const candidates = [raw.records, raw.rows, raw.list, asRecord(raw.page).records];
  const rows = candidates.find(Array.isArray);
  return {
    rows: (rows ?? []).map((entry) => requireRecord(entry, '二课列表包含无效记录。')),
    total: finiteNumber(raw.total ?? asRecord(raw.page).total),
    raw: value,
  };
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  const result = asRecord(value);
  if (!Object.keys(result).length) throw new SecondClassApiError(message, 0, 200);
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstText(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const found = text(value[key]);
    if (found) return found;
  }
  return '';
}

function findNestedText(value: unknown, keys: Set<string>, depth = 0): string {
  if (depth > 5 || value == null || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedText(item, keys, depth + 1);
      if (found) return found;
    }
    return '';
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (keys.has(key)) {
      const found = text(item);
      if (found) return found;
    }
    const nested = findNestedText(item, keys, depth + 1);
    if (nested) return nested;
  }
  return '';
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
