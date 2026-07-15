import type { CampusAuthServiceLike } from '../../types/campus-auth.js';
import {
  CAMPUS_AUTH_PROVIDER_ZYH,
  type CampusLocation,
  type CampusLocationActionPrepared,
  type CampusAuthMethodView,
  type CampusAuthProvider,
  type CampusAuthProviderAuthenticateInput,
  type CampusAuthPendingResult,
  type CampusOwnerIdentity,
} from '../campus-auth-core/index.js';
import { CampusAuthUserError } from '../campus-auth-core/index.js';
import { ZyhHttpClient } from './client.js';
import type { VersionedQueryResult } from '../shared/versioned-json-cache.js';
import { ZyhCache } from './cache.js';
import { nearestRange, requireUsableLocation, wgs84ToBd09 } from '../shared/location.js';
import type {
  ZyhActivity,
  ZyhCredentialPayload,
  ZyhProfile,
  ZyhSessionPayload,
  ZyhSignActivity,
  ZyhSignOperation,
  ZyhSignState,
} from './types.js';
import { ZyhApiError, ZyhSessionExpiredError } from './types.js';

export class ZyhAuthProvider implements CampusAuthProvider {
  readonly id = CAMPUS_AUTH_PROVIDER_ZYH;
  readonly label = '志愿汇';
  readonly confirmCommandPrefix = '志愿汇确认';

  constructor(private readonly client: ZyhHttpClient) {}

  async getBindingMethods(): Promise<CampusAuthMethodView[]> {
    return [
      {
        id: 'managed_credentials',
        label: '托管账号登录',
        description: '加密保存账号密码，在登录态失效时自动重新登录。',
        fields: [
          { name: 'username', label: '身份证号', type: 'text', required: true, autocomplete: 'username' },
          { name: 'password', label: '密码', type: 'password', required: true, autocomplete: 'current-password' },
          { name: 'persistConsent', label: '我授权 QQBot 加密保存志愿汇账号密码，用于自动重新登录。', type: 'checkbox', required: true },
        ],
      },
      {
        id: 'session_credentials',
        label: '单次账号登录',
        description: '密码仅用于本次换取登录态，服务器不会保存密码。',
        fields: [
          { name: 'username', label: '身份证号', type: 'text', required: true, autocomplete: 'username' },
          { name: 'password', label: '密码', type: 'password', required: true, autocomplete: 'current-password' },
        ],
      },
      {
        id: 'session_import',
        label: '导入现有会话',
        description: '高级方式：导入志愿汇 H5/App 的三个安全头。',
        fields: [
          { name: 'authorization', label: 'Authorization', type: 'password', required: true, autocomplete: 'off' },
          { name: 'userId', label: 'User-Id', type: 'text', required: true, autocomplete: 'off' },
          { name: 'platformId', label: 'Platform-Id', type: 'text', required: true, value: '3', autocomplete: 'off' },
        ],
      },
    ];
  }

  async authenticate(input: CampusAuthProviderAuthenticateInput): Promise<CampusAuthPendingResult> {
    let session: ZyhSessionPayload;
    let credentialPayload: ZyhCredentialPayload | undefined;
    if (input.method === 'managed_credentials' || input.method === 'session_credentials') {
      if (input.method === 'managed_credentials' && input.fields.persistConsent !== 'yes') {
        throw new CampusAuthUserError('请先授权加密保存志愿汇账号密码。');
      }
      const username = input.fields.username.trim();
      const password = input.fields.password;
      session = await this.client.login(username, password);
      if (input.method === 'managed_credentials') credentialPayload = { username, password };
    } else if (input.method === 'session_import') {
      session = {
        authorization: input.fields.authorization.trim(),
        userId: input.fields.userId.trim(),
        platformId: input.fields.platformId.trim(),
      };
    } else {
      throw new CampusAuthUserError('该绑定方式不属于志愿汇。');
    }
    const profile = await this.client.getProfile(session);
    return {
      method: input.method,
      sessionPayload: session,
      credentialPayload,
      accountLabel: profile.info.nickname || profile.info.real_name || maskId(session.userId),
    };
  }
}

export interface ZyhAuthenticatedContext {
  session: ZyhSessionPayload;
  profile: ZyhProfile;
  method: string;
  sessionVersion: number;
}

interface ZyhSignActionPayload {
  operation: ZyhSignOperation;
  activityCode: string;
  cardActivityId: string;
}

interface ZyhPreparedSign {
  activityId: string;
  activityTitle: string;
  operation: ZyhSignOperation;
  cardActivityId: string;
}

export class ZyhService {
  readonly id = CAMPUS_AUTH_PROVIDER_ZYH;
  readonly label = '志愿汇';

  constructor(
    private readonly campusAuth: CampusAuthServiceLike,
    private readonly client: ZyhHttpClient,
    private readonly cache: ZyhCache,
  ) {}

  async ensureAuthenticated(identity: CampusOwnerIdentity): Promise<ZyhAuthenticatedContext> {
    const active = await this.campusAuth.getActiveSession<ZyhSessionPayload>(identity.ownerKey, CAMPUS_AUTH_PROVIDER_ZYH);
    if (!active) throw new CampusAuthUserError('请先发送“志愿汇绑定”。');
    try {
      const profile = await this.client.getProfile(active.payload);
      await this.campusAuth.markSessionValidated(identity.ownerKey, CAMPUS_AUTH_PROVIDER_ZYH);
      return { session: active.payload, profile, method: active.row.method, sessionVersion: active.row.version };
    } catch (error) {
      if (!(error instanceof ZyhSessionExpiredError)) throw error;
    }

    if (active.row.method !== 'managed_credentials') {
      await this.campusAuth.markSessionInvalid(identity.ownerKey, CAMPUS_AUTH_PROVIDER_ZYH, 'session_expired');
      throw new CampusAuthUserError('志愿汇登录态已失效，请重新绑定。');
    }
    const credential = await this.campusAuth.getActiveCredential<ZyhCredentialPayload>(identity.ownerKey, CAMPUS_AUTH_PROVIDER_ZYH);
    if (!credential) throw new Error('managed zyh session is missing its credential.');
    try {
      const session = await this.client.login(credential.payload.username, credential.payload.password);
      const refreshed = await this.campusAuth.replaceSession(identity, CAMPUS_AUTH_PROVIDER_ZYH, 'managed_credentials', session, { rotateVersion: false });
      await this.campusAuth.markCredentialUsed(credential.row.id);
      const profile = await this.client.getProfile(session);
      return { session, profile, method: refreshed.row.method, sessionVersion: refreshed.row.version };
    } catch (error) {
      await this.campusAuth.markCredentialFailure(credential.row.id, error instanceof Error ? error.message : String(error));
      await this.campusAuth.markSessionInvalid(identity.ownerKey, CAMPUS_AUTH_PROVIDER_ZYH, 'credential_refresh_failed');
      throw new CampusAuthUserError('志愿汇账号凭据已失效，请重新绑定。');
    }
  }

  async queryHours(identity: CampusOwnerIdentity): Promise<VersionedQueryResult<ZyhProfile>> {
    const active = await this.requireActiveSession(identity);
    return this.cache.query(identity.ownerKey, active.row.version, 'hours', 'current', async () => {
      return (await this.ensureAuthenticated(identity)).profile;
    });
  }

  async queryActivities(identity: CampusOwnerIdentity, page: number, keyword?: string): Promise<VersionedQueryResult<ZyhActivity[]>> {
    const active = await this.requireActiveSession(identity);
    const scope = `${page}:${keyword?.trim() ?? ''}`;
    return this.cache.query(identity.ownerKey, active.row.version, 'activities', scope, async () => {
      const auth = await this.ensureAuthenticated(identity);
      return this.client.listActivities(auth.session, auth.profile, { page, rows: 10, keyword });
    });
  }

  async queryMyActivities(identity: CampusOwnerIdentity, page: number): Promise<VersionedQueryResult<ZyhActivity[]>> {
    const active = await this.requireActiveSession(identity);
    return this.cache.query(identity.ownerKey, active.row.version, 'my_activities', String(page), async () => {
      const auth = await this.ensureAuthenticated(identity);
      return this.client.listMyActivities(auth.session, { page, rows: 10 });
    });
  }

  async queryRecords(identity: CampusOwnerIdentity, page: number): Promise<VersionedQueryResult<ZyhActivity[]>> {
    const active = await this.requireActiveSession(identity);
    return this.cache.query(identity.ownerKey, active.row.version, 'service_records', String(page), async () => {
      const auth = await this.ensureAuthenticated(identity);
      return this.client.listMyActivities(auth.session, { page, rows: 10, type: 3 });
    });
  }

  async startSignAction(
    identity: CampusOwnerIdentity,
    operation: ZyhSignOperation,
    activityCode: string,
  ): Promise<{ link: string; expiresAt: number }> {
    const normalizedCode = activityCode.trim();
    if (!/^[A-Za-z0-9]{6}$/.test(normalizedCode)) {
      throw new CampusAuthUserError('志愿汇活动码应为 6 位字母或数字。');
    }
    const auth = await this.ensureAuthenticated(identity);
    const state = await userFacingZyhCall(() => this.client.getSignState(auth.session));
    assertZyhOperation(state, operation);
    return this.campusAuth.startLocationAction(identity, this.id, operation, {
      operation,
      activityCode: normalizedCode,
      cardActivityId: state.cardActivityId,
    } satisfies ZyhSignActionPayload);
  }

  async prepare(input: {
    identity: CampusOwnerIdentity;
    actionId: string;
    payload: unknown;
    location: CampusLocation;
  }): Promise<CampusLocationActionPrepared<ZyhPreparedSign>> {
    const payload = requireZyhSignPayload(input.payload, input.actionId);
    const auth = await this.ensureAuthenticated(input.identity);
    const state = await userFacingZyhCall(() => this.client.getSignState(auth.session));
    assertZyhStateStable(state, payload);
    const checked = await this.validateLocation(auth.session, state, payload.activityCode, input.location);
    return {
      title: checked.activity.title,
      actionLabel: zyhOperationLabel(payload.operation),
      details: [
        `操作：${zyhOperationLabel(payload.operation)}`,
        `签到点：${checked.address}`,
        `距签到点约 ${Math.round(checked.distance)} 米（允许 ${Math.round(checked.radius)} 米）`,
        `手机定位精度约 ${Math.round(input.location.accuracy)} 米`,
      ],
      payload: {
        activityId: checked.activity.activityId,
        activityTitle: checked.activity.title,
        operation: payload.operation,
        cardActivityId: state.cardActivityId,
      },
    };
  }

  async commit(input: {
    identity: CampusOwnerIdentity;
    actionId: string;
    payload: unknown;
    prepared: unknown;
    location: CampusLocation;
  }): Promise<{ message: string }> {
    const payload = requireZyhSignPayload(input.payload, input.actionId);
    const prepared = requireZyhPreparedSign(input.prepared);
    if (prepared.operation !== payload.operation) throw new CampusAuthUserError('待提交的志愿汇操作类型已变化，请重新发起。');
    if (prepared.cardActivityId !== payload.cardActivityId) throw new CampusAuthUserError('待提交的志愿汇活动记录已变化，请重新发起。');
    const auth = await this.ensureAuthenticated(input.identity);
    const state = await userFacingZyhCall(() => this.client.getSignState(auth.session));
    assertZyhStateStable(state, payload);
    const checked = await this.validateLocation(auth.session, state, payload.activityCode, input.location);
    if (checked.activity.activityId !== prepared.activityId) {
      throw new CampusAuthUserError('当前可操作的志愿活动已变化，请重新发起。');
    }
    await userFacingZyhCall(() => this.client.submitSign(auth.session, payload.operation, checked.activity, payload.activityCode, checked.point));
    return { message: `${checked.activity.title}${zyhOperationLabel(payload.operation)}成功。` };
  }

  private async requireActiveSession(identity: CampusOwnerIdentity) {
    const active = await this.campusAuth.getActiveSession<ZyhSessionPayload>(identity.ownerKey, CAMPUS_AUTH_PROVIDER_ZYH);
    if (!active) throw new CampusAuthUserError('请先发送“志愿汇绑定”。');
    return active;
  }

  private async validateLocation(
    session: ZyhSessionPayload,
    state: ZyhSignState,
    activityCode: string,
    location: CampusLocation,
  ): Promise<{
    activity: ZyhSignActivity;
    point: { latitude: number; longitude: number };
    address: string;
    distance: number;
    radius: number;
  }> {
    requireUsableLocation(location);
    const point = wgs84ToBd09(location);
    const activity = await userFacingZyhCall(() => this.client.getSignActivity(session, state, activityCode, point));
    if (state.operation === 'sign_out' && activity.activityId !== state.cardActivityId) {
      throw new CampusAuthUserError('志愿汇当前待签退活动与活动详情不一致，请重新发起。');
    }
    if (activity.status !== 2) throw new CampusAuthUserError('该志愿活动当前不在可签到或签退时间内。');
    if (activity.faceRequired) throw new CampusAuthUserError('该活动要求人脸核验，请使用志愿汇官方 App 完成。');
    const nearest = nearestRange(point, activity.positions.map((position) => ({
      latitude: position.latitude,
      longitude: position.longitude,
      radius: position.radius,
      label: position.address,
    })));
    if (nearest.distance > nearest.range.radius) {
      throw new CampusAuthUserError(`当前位置距“${nearest.range.label}”约 ${Math.round(nearest.distance)} 米，超出 ${Math.round(nearest.range.radius)} 米签到范围。`);
    }
    return {
      activity,
      point,
      address: nearest.range.label,
      distance: nearest.distance,
      radius: nearest.range.radius,
    };
  }
}

function requireZyhSignPayload(value: unknown, actionId: string): ZyhSignActionPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid zyh sign action payload.');
  const row = value as Record<string, unknown>;
  const operation = row.operation;
  const activityCode = String(row.activityCode ?? '').trim();
  const cardActivityId = String(row.cardActivityId ?? '').trim();
  if ((operation !== 'sign_in' && operation !== 'sign_out') || actionId !== operation) {
    throw new Error('invalid zyh sign action payload.');
  }
  if (!/^[A-Za-z0-9]{6}$/.test(activityCode)) throw new Error('invalid zyh activity code.');
  if (operation === 'sign_out' && !cardActivityId) throw new Error('invalid zyh sign-out activity state.');
  return { operation, activityCode, cardActivityId };
}

function requireZyhPreparedSign(value: unknown): ZyhPreparedSign {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid prepared zyh sign action.');
  const row = value as Record<string, unknown>;
  const operation = row.operation;
  const activityId = String(row.activityId ?? '').trim();
  const activityTitle = String(row.activityTitle ?? '').trim();
  const cardActivityId = String(row.cardActivityId ?? '').trim();
  if (!activityId || !activityTitle || (operation !== 'sign_in' && operation !== 'sign_out') || (operation === 'sign_out' && !cardActivityId)) {
    throw new Error('invalid prepared zyh sign action.');
  }
  return { activityId, activityTitle, operation, cardActivityId };
}

function assertZyhOperation(state: ZyhSignState, expected: ZyhSignOperation): void {
  if (state.operation !== expected) {
    throw new CampusAuthUserError(state.operation === 'sign_out'
      ? '当前活动已经签到，请发送“志愿汇签退 <6位活动码>”。'
      : '当前没有待签退活动，请发送“志愿汇签到 <6位活动码>”。');
  }
}

function assertZyhStateStable(state: ZyhSignState, payload: ZyhSignActionPayload): void {
  assertZyhOperation(state, payload.operation);
  if (payload.operation === 'sign_out' && state.cardActivityId !== payload.cardActivityId) {
    throw new CampusAuthUserError('当前待签退活动已变化，请重新发起。');
  }
}

function zyhOperationLabel(operation: ZyhSignOperation): '签到' | '签退' {
  return operation === 'sign_in' ? '签到' : '签退';
}

async function userFacingZyhCall<T>(loader: () => Promise<T>): Promise<T> {
  try {
    return await loader();
  } catch (error) {
    if (error instanceof ZyhApiError && !(error instanceof ZyhSessionExpiredError)) {
      throw new CampusAuthUserError(error.message);
    }
    throw error;
  }
}

function maskId(value: string): string {
  return value.length > 6 ? `${value.slice(0, 3)}***${value.slice(-3)}` : value;
}
