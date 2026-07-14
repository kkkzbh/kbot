import { CampusAuthUserError } from '../campus-auth-core/index.js';
import type { ZyhActivity, ZyhProfile, ZyhSessionPayload } from './types.js';
import { ZyhApiError, ZyhSessionExpiredError } from './types.js';
import { zyhEnvelopeSchema, zyhListEnvelopeSchema, zyhProfileEnvelopeSchema } from './protocol.js';

const ZYH_API_BASE = 'https://ogmapi.zyh365.com';
const ZYH_H5_ACCESS_KEY_ID = '92ae62f25d4d4ac8a58d58e2476a4e5b';

export interface ZyhHttpRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export interface ZyhHttpResponse {
  status: number;
  headers: Headers;
  text: string;
}

export type ZyhHttpTransport = (request: ZyhHttpRequest) => Promise<ZyhHttpResponse>;

export class ZyhHttpClient {
  constructor(private readonly transport: ZyhHttpTransport = defaultTransport) {}

  async login(username: string, password: string): Promise<ZyhSessionPayload> {
    const response = await this.post('userCenter/login', {
      username,
      password,
      AccessKeyId: ZYH_H5_ACCESS_KEY_ID,
    });
    requireSuccess(response.body, response.status, '志愿汇登录失败。');
    const authorization = response.headers.get('at')?.trim() ?? '';
    const userId = response.headers.get('user-id')?.trim() ?? '';
    const platformId = response.headers.get('platform-id')?.trim() ?? '3';
    if (!authorization || !userId) {
      throw new ZyhApiError('志愿汇登录响应缺少安全头。', 'invalid_login_response', response.status);
    }
    return { authorization, userId, platformId };
  }

  async getProfile(session: ZyhSessionPayload): Promise<ZyhProfile> {
    const response = await this.post('volunteerinfo/getvolunteerbyId', { zyzid: session.userId }, session);
    requireSuccess(response.body, response.status, '获取志愿汇个人信息失败。');
    const parsed = zyhProfileEnvelopeSchema.safeParse(response.body);
    if (!parsed.success) throw new ZyhApiError('志愿汇个人信息响应结构无效。', 'invalid_profile_response', response.status);
    const info = record(parsed.data.info);
    const nav = parsed.data.nav ?? [];
    const navNumber = (name: string): number | null => {
      const item = nav.find((entry) => record(entry).name === name);
      return item ? number(record(item).value) : null;
    };
    const hoursSystem = number(info.hours_system) ?? number(response.body.hours_system) ?? navNumber('信用时数') ?? 0;
    const hoursHistory = number(info.hours_history) ?? number(response.body.hours_history) ?? navNumber('荣誉时数') ?? 0;
    return {
      info,
      hoursSystem,
      hoursHistory,
      hoursTotal: number(response.body.hours_totalduration) ?? hoursSystem + hoursHistory,
      points: number(info.points) ?? number(response.body.points) ?? 0,
    };
  }

  async listActivities(
    session: ZyhSessionPayload,
    profile: ZyhProfile,
    options: { page: number; rows: number; keyword?: string },
  ): Promise<ZyhActivity[]> {
    const response = await this.post('recruit/list', {
      province: string(profile.info.province),
      city: string(profile.info.city),
      county: string(profile.info.county),
      search_title: options.keyword?.trim() ?? '',
      page: String(options.page),
      rows: String(options.rows),
      sort: '1',
      ordertype: '1',
      earth_lng: '',
      earth_lat: '',
      status: '2',
    }, session);
    requireSuccess(response.body, response.status, '获取志愿活动失败。');
    const parsed = zyhListEnvelopeSchema.safeParse(response.body);
    if (!parsed.success) throw new ZyhApiError('志愿汇活动列表响应结构无效。', 'invalid_activity_response', response.status);
    return parsed.data.data.map(normalizeActivity);
  }

  async listMyActivities(
    session: ZyhSessionPayload,
    options: { page: number; rows: number; type?: number },
  ): Promise<ZyhActivity[]> {
    const response = await this.post('recruit/myList', {
      zyzid: session.userId,
      showCount: '1',
      earth_lng: '',
      earth_lat: '',
      page: String(options.page),
      rows: String(options.rows),
      ...(options.type == null ? {} : { type: String(options.type) }),
    }, session);
    requireSuccess(response.body, response.status, '获取我的志愿活动失败。');
    const parsed = zyhListEnvelopeSchema.safeParse(response.body);
    if (!parsed.success) throw new ZyhApiError('志愿汇个人活动响应结构无效。', 'invalid_my_activity_response', response.status);
    return parsed.data.data.map(normalizeActivity);
  }

  async validateSession(session: ZyhSessionPayload): Promise<boolean> {
    try {
      await this.getProfile(session);
      return true;
    } catch (error) {
      if (error instanceof ZyhSessionExpiredError) return false;
      throw error;
    }
  }

  private async post(
    api: string,
    fields: Record<string, string>,
    session?: ZyhSessionPayload,
  ): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
    const data = new URLSearchParams({ api, apimode: 'vmsapi', ...fields });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'user-agent': 'qqbot-zyh/1.0',
    };
    if (session) {
      headers.Authorization = session.authorization;
      headers['User-Id'] = session.userId;
      headers['Platform-Id'] = session.platformId;
    }
    const response = await this.transport({
      url: `${ZYH_API_BASE}/api/${api}.do`,
      method: 'POST',
      headers,
      body: data.toString(),
    });
    if (response.status === 401) throw new ZyhSessionExpiredError();
    let body: unknown;
    try {
      body = JSON.parse(response.text);
    } catch {
      throw new ZyhApiError('志愿汇返回了无法解析的响应。', 'invalid_json', response.status);
    }
    const parsed = zyhEnvelopeSchema.safeParse(body);
    if (!parsed.success) throw new ZyhApiError('志愿汇响应结构无效。', 'invalid_envelope', response.status);
    return { status: response.status, headers: response.headers, body: parsed.data };
  }
}

async function defaultTransport(request: ZyhHttpRequest): Promise<ZyhHttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

function requireSuccess(body: Record<string, unknown>, status: number, defaultMessage: string): void {
  const code = String(body.errCode ?? body.code ?? '');
  if (code === '0000') return;
  const message = String(body.message ?? body.msg ?? defaultMessage).trim() || defaultMessage;
  if (status === 401 || ['401', '1001', '1002'].includes(code)) throw new ZyhSessionExpiredError(message);
  throw new ZyhApiError(message, code || 'unknown', status);
}

function normalizeActivity(value: unknown): ZyhActivity {
  const item = record(value);
  const id = string(item.id || item.recruitid);
  if (!id) throw new CampusAuthUserError('志愿汇活动响应缺少活动 ID。');
  return {
    id,
    title: string(item.title) || '未命名活动',
    departmentName: string(item.deptname || item.departmentName || item.department_name),
    city: string(item.city || item.city_name),
    county: string(item.county || item.county_name),
    recruitStartTime: number(item.recruit_start_time),
    recruitFinishTime: number(item.recruit_finish_time),
    signupPeople: number(item.signup_people ?? item.join_num),
    recruitPeople: number(item.recruit_people),
    isFinished: Number(item.is_finish) === 1,
    statusText: string(item.statusName || item.status_text) || null,
  };
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function string(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function number(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
