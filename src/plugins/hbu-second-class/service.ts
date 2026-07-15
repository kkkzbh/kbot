import type { CampusAuthServiceLike } from '../../types/campus-auth.js';
import type { VersionedQueryResult } from '../shared/versioned-json-cache.js';
import {
  CAMPUS_AUTH_PROVIDER_SECOND_CLASS,
  CampusAuthUserError,
  type CampusLocation,
  type CampusLocationActionPrepared,
  type CampusAuthMethodView,
  type CampusAuthProvider,
  type CampusAuthProviderAuthenticateInput,
  type CampusAuthPendingResult,
  type CampusOwnerIdentity,
} from '../campus-auth-core/index.js';
import { SecondClassCache } from './cache.js';
import { SecondClassHttpClient } from './client.js';
import { SecondClassReauthStore } from './reauth-store.js';
import { nearestRange, requireUsableLocation, wgs84ToBd09 } from '../shared/location.js';
import type {
  SecondClassCaptcha,
  SecondClassCredentialPayload,
  SecondClassPage,
  SecondClassSessionPayload,
  SecondClassSignCodeInfo,
  SecondClassSignOperation,
} from './types.js';
import {
  SecondClassApiError,
  SecondClassSessionExpiredError,
} from './types.js';

export interface SecondClassReauthPrompt {
  message: string;
  captcha: SecondClassCaptcha;
  expiresAt: number;
}

export class SecondClassReauthRequiredError extends CampusAuthUserError {
  constructor(readonly prompt: SecondClassReauthPrompt) {
    super(prompt.message);
    this.name = 'SecondClassReauthRequiredError';
  }
}

export class HbuSecondClassAuthProvider implements CampusAuthProvider {
  readonly id = CAMPUS_AUTH_PROVIDER_SECOND_CLASS;
  readonly label = '河北大学二课';
  readonly confirmCommandPrefix = '二课确认';
  constructor(private readonly client: SecondClassHttpClient) {}

  async getBindingMethods(): Promise<CampusAuthMethodView[]> {
    const captcha = await this.client.getCaptcha();
    return [
      {
        id: 'managed_credentials',
        label: '托管二课账号登录',
        description: '加密保存账号密码；Token 失效后，机器人发送验证码图片，由你回复验证码完成续登。',
        fields: [
          { name: 'loginName', label: '二课账号', type: 'text', required: true, autocomplete: 'username' },
          { name: 'password', label: '二课密码', type: 'password', required: true, autocomplete: 'current-password' },
          { name: 'captchaCode', label: '图形验证码', type: 'captcha', required: true, imageDataUrl: captcha.imageDataUrl, autocomplete: 'off' },
          { name: 'captchaUuid', label: '', type: 'hidden', required: true, value: captcha.uuid },
          { name: 'persistConsent', label: '我授权 QQBot 加密保存二课账号密码，用于验证码续登。', type: 'checkbox', required: true },
        ],
      },
      {
        id: 'direct_credentials',
        label: '二课账号登录',
        description: '密码只用于本次 SM2 加密登录，服务器只保存二课 Token。',
        fields: [
          { name: 'loginName', label: '二课账号', type: 'text', required: true, autocomplete: 'username' },
          { name: 'password', label: '二课密码', type: 'password', required: true, autocomplete: 'current-password' },
          { name: 'captchaCode', label: '图形验证码', type: 'captcha', required: true, imageDataUrl: captcha.imageDataUrl, autocomplete: 'off' },
          { name: 'captchaUuid', label: '', type: 'hidden', required: true, value: captcha.uuid },
        ],
      },
      {
        id: 'token_import',
        label: '导入二课 Token',
        description: '高级方式：导入已登录中青二课 Web 会话的 Authorization Token。',
        fields: [
          { name: 'token', label: 'Authorization Token', type: 'password', required: true, autocomplete: 'off' },
        ],
      },
    ];
  }

  async authenticate(input: CampusAuthProviderAuthenticateInput): Promise<CampusAuthPendingResult> {
    let session: SecondClassSessionPayload;
    let credentialPayload: SecondClassCredentialPayload | undefined;
    if (input.method === 'managed_credentials' || input.method === 'direct_credentials') {
      if (input.method === 'managed_credentials' && input.fields.persistConsent !== 'yes') {
        throw new CampusAuthUserError('请先授权加密保存二课账号密码。');
      }
      const loginName = input.fields.loginName.trim();
      const password = input.fields.password;
      session = await this.client.directLogin({
        loginName,
        password,
        captchaCode: input.fields.captchaCode.trim(),
        captchaUuid: input.fields.captchaUuid.trim(),
      });
      if (input.method === 'managed_credentials') credentialPayload = { loginName, password };
    } else if (input.method === 'token_import') {
      session = await this.client.importToken(input.fields.token);
    } else {
      throw new CampusAuthUserError('该绑定方式不属于二课。');
    }
    return {
      method: input.method,
      sessionPayload: session,
      credentialPayload,
      sourceProviderId: null,
      sourceCredentialId: null,
      accountLabel: session.accountName || maskStudentNo(session.studentNo),
    };
  }
}

export interface SecondClassAuthenticatedContext {
  session: SecondClassSessionPayload;
  sessionVersion: number;
}

interface SecondClassSignActionPayload {
  code: string;
  operation: SecondClassSignOperation;
}

interface SecondClassPreparedSign {
  activityId: string;
  activityName: string;
  operation: SecondClassSignOperation;
}

export interface SecondClassSignCommandResult {
  message?: string;
  locationLink?: string;
  expiresAt?: number;
}

export class HbuSecondClassService {
  readonly id = CAMPUS_AUTH_PROVIDER_SECOND_CLASS;
  readonly label = '河北大学二课';

  constructor(
    private readonly campusAuth: CampusAuthServiceLike,
    private readonly client: SecondClassHttpClient,
    private readonly cache: SecondClassCache,
    private readonly reauthStore: SecondClassReauthStore,
  ) {}

  async ensureAuthenticated(identity: CampusOwnerIdentity): Promise<SecondClassAuthenticatedContext> {
    const active = await this.campusAuth.getActiveSession<SecondClassSessionPayload>(identity.ownerKey, CAMPUS_AUTH_PROVIDER_SECOND_CLASS);
    if (!active) throw new CampusAuthUserError('请先发送“二课绑定”。');
    try {
      await this.client.getUserInfo(active.payload.token);
      await this.campusAuth.markSessionValidated(identity.ownerKey, CAMPUS_AUTH_PROVIDER_SECOND_CLASS);
      return { session: active.payload, sessionVersion: active.row.version };
    } catch (error) {
      if (!(error instanceof SecondClassSessionExpiredError)) throw error;
    }
    if (active.row.method !== 'managed_credentials') {
      await this.campusAuth.markSessionInvalid(identity.ownerKey, CAMPUS_AUTH_PROVIDER_SECOND_CLASS, 'session_expired');
      throw new CampusAuthUserError('二课登录态已失效，请重新绑定。');
    }
    await this.campusAuth.markSessionInvalid(identity.ownerKey, CAMPUS_AUTH_PROVIDER_SECOND_CLASS, 'captcha_required');
    throw new SecondClassReauthRequiredError(
      await this.createReauthPrompt(identity, '二课登录态已失效，请输入图片验证码完成续登。'),
    );
  }

  async beginReauth(identity: CampusOwnerIdentity): Promise<SecondClassReauthPrompt> {
    return this.createReauthPrompt(identity, '请输入图片验证码完成二课续登。');
  }

  async getBindingStatus(identity: CampusOwnerIdentity): Promise<{ status: string; method?: string }> {
    const status = await this.campusAuth.getStatus(identity.ownerKey, CAMPUS_AUTH_PROVIDER_SECOND_CLASS);
    if (await this.reauthStore.getWaiting(identity.ownerKey)) {
      return { status: '等待验证码续登，请发送“二课验证 <验证码>”', method: status.method };
    }
    if (status.method === 'managed_credentials' && status.status.includes('失效')) {
      return { status: '登录态已失效，请发送“二课验证”获取验证码图片', method: status.method };
    }
    return status;
  }

  async completeReauth(identity: CampusOwnerIdentity, captchaCode: string): Promise<SecondClassAuthenticatedContext> {
    const normalizedCode = captchaCode.trim();
    if (!normalizedCode) throw new CampusAuthUserError('请发送：二课验证 <验证码>。');
    const challenge = await this.reauthStore.claim(identity);
    if (!challenge) throw new CampusAuthUserError('没有可用的二课验证码，请先发送“二课验证”获取新图片，并在原会话回复。');
    const credential = await this.campusAuth.getActiveCredential<SecondClassCredentialPayload>(identity.ownerKey, CAMPUS_AUTH_PROVIDER_SECOND_CLASS);
    if (!credential || credential.row.id !== challenge.credentialId || credential.row.method !== 'managed_credentials') {
      await this.reauthStore.clearOwner(identity.ownerKey);
      throw new CampusAuthUserError('当前二课绑定不支持验证码续登，请重新绑定并选择“托管二课账号登录”。');
    }
    try {
      const session = await this.client.directLogin({
        loginName: credential.payload.loginName,
        password: credential.payload.password,
        captchaCode: normalizedCode,
        captchaUuid: challenge.captchaUuid,
      });
      const refreshed = await this.campusAuth.replaceSession(
        identity,
        CAMPUS_AUTH_PROVIDER_SECOND_CLASS,
        'managed_credentials',
        session,
        { sourceCredentialId: credential.row.id, rotateVersion: false },
      );
      await this.campusAuth.markCredentialUsed(credential.row.id);
      await this.reauthStore.clearOwner(identity.ownerKey);
      return { session, sessionVersion: refreshed.row.version };
    } catch (error) {
      await this.campusAuth.markCredentialFailure(credential.row.id, error instanceof Error ? error.message : String(error));
      await this.reauthStore.clearOwner(identity.ownerKey);
      if (error instanceof SecondClassApiError) {
        throw new SecondClassReauthRequiredError(
          await this.createReauthPrompt(identity, `${error.message} 已刷新验证码，请重新输入。`),
        );
      }
      throw error;
    }
  }

  async signWithCode(
    identity: CampusOwnerIdentity,
    operation: SecondClassSignOperation,
    code: string,
  ): Promise<SecondClassSignCommandResult> {
    const normalizedCode = code.trim();
    if (!/^\d{6}$/.test(normalizedCode)) throw new CampusAuthUserError('二课签到码应为 6 位数字。');
    const auth = await this.ensureAuthenticated(identity);
    const info = await userFacingSecondClassCall(() => this.client.getSignCodeInfo(auth.session.token, normalizedCode));
    assertSignOperation(info, operation);
    if (info.locationRequired) {
      const action = await this.campusAuth.startLocationAction(identity, this.id, operation, {
        code: normalizedCode,
        operation,
      } satisfies SecondClassSignActionPayload);
      return { locationLink: action.link, expiresAt: action.expiresAt };
    }
    const result = await userFacingSecondClassCall(() => this.client.submitSignCode(auth.session.token, info, normalizedCode));
    validateSignResult(info, result.signType);
    return { message: `${info.activityName}${operationLabel(operation)}成功。` };
  }

  async prepare(input: {
    identity: CampusOwnerIdentity;
    actionId: string;
    payload: unknown;
    location: CampusLocation;
  }): Promise<CampusLocationActionPrepared<SecondClassPreparedSign>> {
    const payload = requireSignActionPayload(input.payload, input.actionId);
    const auth = await this.ensureAuthenticated(input.identity);
    const info = await userFacingSecondClassCall(() => this.client.getSignCodeInfo(auth.session.token, payload.code));
    assertSignOperation(info, payload.operation);
    const details = [`操作：${operationLabel(payload.operation)}`];
    if (info.locationRequired) {
      const match = await this.validateLocation(auth.session.token, info, input.location);
      details.push(`签到点：${match.address}`);
      details.push(`距签到点约 ${Math.round(match.distance)} 米（允许 ${Math.round(match.radius)} 米）`);
      details.push(`手机定位精度约 ${Math.round(input.location.accuracy)} 米`);
    } else {
      details.push('活动当前不要求定位。');
    }
    return {
      title: info.activityName,
      actionLabel: operationLabel(payload.operation),
      details,
      payload: {
        activityId: info.activityId,
        activityName: info.activityName,
        operation: payload.operation,
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
    const payload = requireSignActionPayload(input.payload, input.actionId);
    const prepared = requirePreparedSign(input.prepared);
    if (prepared.operation !== payload.operation) throw new CampusAuthUserError('待提交的二课操作类型已变化，请重新发起。');
    const auth = await this.ensureAuthenticated(input.identity);
    const info = await userFacingSecondClassCall(() => this.client.getSignCodeInfo(auth.session.token, payload.code));
    assertSignOperation(info, payload.operation);
    if (info.activityId !== prepared.activityId) throw new CampusAuthUserError('签到码对应的活动已变化，请重新发起。');
    if (info.locationRequired) await this.validateLocation(auth.session.token, info, input.location);
    const result = await userFacingSecondClassCall(() => this.client.submitSignCode(auth.session.token, info, payload.code));
    validateSignResult(info, result.signType);
    return { message: `${info.activityName}${operationLabel(payload.operation)}成功。` };
  }

  queryCredits(identity: CampusOwnerIdentity): Promise<VersionedQueryResult<unknown>> {
    return this.query(identity, 'credits', 'current', (token) => this.client.getCreditDetails(token));
  }

  queryTranscript(identity: CampusOwnerIdentity, semester?: string): Promise<VersionedQueryResult<unknown>> {
    return this.query(identity, 'transcript', semester ?? 'all', (token) => semester
      ? this.client.getSemesterGrades(token).then((data) => filterSemesterPayload(data, semester))
      : this.client.getTranscript(token));
  }

  queryRadar(identity: CampusOwnerIdentity): Promise<VersionedQueryResult<unknown>> {
    return this.query(identity, 'radar', 'current', (token) => this.client.getRadar(token));
  }

  queryActivities(identity: CampusOwnerIdentity, page = 1): Promise<VersionedQueryResult<SecondClassPage>> {
    return this.query(identity, 'activities', String(page), (token) => this.client.listActivities(token, page));
  }

  queryMyActivities(identity: CampusOwnerIdentity, page = 1): Promise<VersionedQueryResult<SecondClassPage>> {
    return this.query(identity, 'my_activities', String(page), (token) => this.client.listMyActivities(token, page));
  }

  queryRecords(identity: CampusOwnerIdentity, page = 1): Promise<VersionedQueryResult<SecondClassPage>> {
    return this.query(identity, 'credit_records', String(page), (token) => this.client.listCreditRecords(token, page));
  }

  private async query<T>(identity: CampusOwnerIdentity, kind: string, scope: string, loader: (token: string) => Promise<T>): Promise<VersionedQueryResult<T>> {
    const active = await this.campusAuth.getActiveSession<SecondClassSessionPayload>(identity.ownerKey, CAMPUS_AUTH_PROVIDER_SECOND_CLASS);
    if (!active) throw new CampusAuthUserError('请先发送“二课绑定”。');
    return this.cache.query(identity.ownerKey, active.row.version, kind, scope, async () => {
      const auth = await this.ensureAuthenticated(identity);
      return loader(auth.session.token);
    });
  }

  private async createReauthPrompt(identity: CampusOwnerIdentity, message: string): Promise<SecondClassReauthPrompt> {
    const credential = await this.campusAuth.getActiveCredential<SecondClassCredentialPayload>(identity.ownerKey, CAMPUS_AUTH_PROVIDER_SECOND_CLASS);
    if (!credential || credential.row.method !== 'managed_credentials') {
      throw new CampusAuthUserError('当前二课绑定不支持验证码续登，请重新绑定并选择“托管二课账号登录”。');
    }
    const captcha = await this.client.getCaptcha();
    const challenge = await this.reauthStore.replace(identity, credential.row.id, captcha.uuid);
    return { message, captcha, expiresAt: challenge.expiresAt };
  }

  private async validateLocation(token: string, info: SecondClassSignCodeInfo, location: CampusLocation): Promise<{
    address: string;
    distance: number;
    radius: number;
  }> {
    requireUsableLocation(location);
    const point = wgs84ToBd09(location);
    const locations = await userFacingSecondClassCall(() => this.client.getSignLocations(token, info.activityId));
    const nearest = nearestRange(point, locations.map((item) => ({
      latitude: item.latitude,
      longitude: item.longitude,
      radius: item.radius,
      label: item.address,
    })));
    if (nearest.distance > nearest.range.radius) {
      throw new CampusAuthUserError(`当前位置距“${nearest.range.label}”约 ${Math.round(nearest.distance)} 米，超出 ${Math.round(nearest.range.radius)} 米签到范围。`);
    }
    return { address: nearest.range.label, distance: nearest.distance, radius: nearest.range.radius };
  }
}

function requireSignActionPayload(value: unknown, actionId: string): SecondClassSignActionPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid second-class sign action payload.');
  const payload = value as Record<string, unknown>;
  const operation = payload.operation;
  const code = String(payload.code ?? '').trim();
  if ((operation !== 'sign_in' && operation !== 'sign_out') || actionId !== operation || !/^\d{6}$/.test(code)) {
    throw new Error('invalid second-class sign action payload.');
  }
  return { code, operation };
}

function requirePreparedSign(value: unknown): SecondClassPreparedSign {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid prepared second-class sign action.');
  const row = value as Record<string, unknown>;
  const operation = row.operation;
  const activityId = String(row.activityId ?? '').trim();
  const activityName = String(row.activityName ?? '').trim();
  if (!activityId || !activityName || (operation !== 'sign_in' && operation !== 'sign_out')) {
    throw new Error('invalid prepared second-class sign action.');
  }
  return { activityId, activityName, operation };
}

function assertSignOperation(info: SecondClassSignCodeInfo, expected: SecondClassSignOperation): void {
  if (info.operation !== expected) {
    throw new CampusAuthUserError(`该签到码当前用于${operationLabel(info.operation)}，请发送“二课${operationLabel(info.operation)} <签到码>”。`);
  }
}

function validateSignResult(info: SecondClassSignCodeInfo, signType: number | null): void {
  if (signType == null) return;
  const actual: SecondClassSignOperation = signType === 1 ? 'sign_out' : 'sign_in';
  if (actual !== info.operation) throw new CampusAuthUserError('二课返回的签到状态与请求不一致，请在官方页面确认结果。');
}

function operationLabel(operation: SecondClassSignOperation): '签到' | '签退' {
  return operation === 'sign_in' ? '签到' : '签退';
}

async function userFacingSecondClassCall<T>(loader: () => Promise<T>): Promise<T> {
  try {
    return await loader();
  } catch (error) {
    if (error instanceof SecondClassApiError && !(error instanceof SecondClassSessionExpiredError)) {
      throw new CampusAuthUserError(error.message);
    }
    throw error;
  }
}

function maskStudentNo(value: string): string {
  return value.length > 5 ? `${value.slice(0, 2)}***${value.slice(-3)}` : value;
}

function filterSemesterPayload(data: unknown, semester: string): unknown {
  if (Array.isArray(data)) return data.filter((item) => matchesSemester(item, semester));
  if (!data || typeof data !== 'object') return data;
  const record = data as Record<string, unknown>;
  for (const key of ['records', 'rows', 'list', 'data']) {
    if (Array.isArray(record[key])) return { ...record, [key]: record[key].filter((item) => matchesSemester(item, semester)) };
  }
  return data;
}

function matchesSemester(value: unknown, semester: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return ['semester', 'semesterName', 'yearSemester', 'schoolYearName']
    .some((key) => String(record[key] ?? '').trim() === semester);
}
