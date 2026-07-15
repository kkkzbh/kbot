import { CampusAuthUserError } from '../campus-auth-core/index.js';
import type {
  ZyhActivity,
  ZyhProfile,
  ZyhSessionPayload,
  ZyhSignActivity,
  ZyhSignOperation,
  ZyhSignState,
} from './types.js';
import { ZyhApiError, ZyhSessionExpiredError } from './types.js';
import { zyhEnvelopeSchema, zyhListEnvelopeSchema, zyhProfileEnvelopeSchema } from './protocol.js';

const ZYH_API_BASE = 'https://ogmapi.zyh365.com';
const ZYH_APP_API_BASE = 'https://appapi.zyh365.com';
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

  async getSignState(session: ZyhSessionPayload): Promise<ZyhSignState> {
    const response = await this.postH5('activity/isSignForApp', {
      mobile_unique: session.userId,
      zyzid: session.userId,
    }, session);
    requireSuccess(response.body, response.status, '获取志愿汇签到状态失败。');
    const data = record(response.body.data);
    const status = number(data.status);
    if (status !== 1 && status !== 2) {
      throw new CampusAuthUserError('当前没有可签到或签退的志愿活动。');
    }
    const cardActivityId = string(data.card_activityid);
    if (status === 2 && !cardActivityId) throw new ZyhApiError('志愿汇签退状态缺少活动记录 ID。', 'invalid_sign_state', response.status);
    return {
      operation: status === 1 ? 'sign_in' : 'sign_out',
      cardActivityId,
      signTime: string(data.sign_time),
    };
  }

  async getSignActivity(
    session: ZyhSessionPayload,
    state: ZyhSignState,
    activityCode: string,
    point: { latitude: number; longitude: number },
  ): Promise<ZyhSignActivity> {
    const response = await this.postH5('activity/detailRevampedForApp', {
      zyzid: session.userId,
      mobile_unique: session.userId,
      activity_code: state.operation === 'sign_in' ? activityCode : '',
      card_activityid: state.operation === 'sign_out' ? state.cardActivityId : '',
      earth_lng: String(point.longitude),
      earth_lat: String(point.latitude),
    }, session);
    requireSuccess(response.body, response.status, '获取志愿汇签到活动失败。');
    const data = record(response.body.data);
    if (!Array.isArray(data.position)) throw new ZyhApiError('志愿汇活动未配置签到范围。', 'invalid_sign_position', response.status);
    const activityId = string(data.card_activityid);
    if (!activityId) throw new ZyhApiError('志愿汇签到活动响应缺少活动 ID。', 'invalid_sign_activity', response.status);
    const status = number(data.status);
    if (status == null) throw new ZyhApiError('志愿汇签到活动响应缺少活动状态。', 'invalid_sign_activity', response.status);
    return {
      activityId,
      title: string(data.title) || `志愿活动 ${activityId}`,
      status,
      faceRequired: Number(data.isface) === 1,
      positions: data.position.map((value) => {
        const item = record(value);
        const latitude = number(item.earth_lat);
        const longitude = number(item.earth_lng);
        const radius = number(item.range);
        if (latitude == null || longitude == null || radius == null || radius <= 0) {
          throw new ZyhApiError('志愿汇签到范围坐标无效。', 'invalid_sign_position', response.status);
        }
        return {
          latitude,
          longitude,
          radius,
          address: string(item.address || item.position_name) || '活动签到点',
        };
      }),
    };
  }

  async submitSign(
    session: ZyhSessionPayload,
    operation: ZyhSignOperation,
    activity: ZyhSignActivity,
    activityCode: string,
    point: { latitude: number; longitude: number },
  ): Promise<void> {
    const response = await this.postH5(operation === 'sign_in' ? 'activity/signIn' : 'activity/sign', {
      activityid: activity.activityId,
      activityCode,
      zyzid: session.userId,
      mobile_unique: session.userId,
      type: operation === 'sign_in' ? '1' : '2',
      isface: '0',
      earth_lng: String(point.longitude),
      earth_lat: String(point.latitude),
    }, session);
    requireSuccess(response.body, response.status, operation === 'sign_in' ? '志愿汇签到失败。' : '志愿汇签退失败。');
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

  private async postH5(
    api: string,
    fields: Record<string, string>,
    session: ZyhSessionPayload,
  ): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
    const data = new URLSearchParams({ api, apimode: 'vmsapi', ...fields });
    const response = await this.transport({
      url: `${ZYH_APP_API_BASE}/common/api-public?app_id=h5`,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'user-agent': 'qqbot-zyh/1.0',
        Authorization: session.authorization,
        'User-Id': session.userId,
        'Platform-Id': session.platformId,
      },
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
