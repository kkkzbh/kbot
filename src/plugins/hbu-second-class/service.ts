import type { CampusAuthServiceLike } from '../../types/campus-auth.js';
import type { VersionedQueryResult } from '../shared/versioned-json-cache.js';
import {
  CAMPUS_AUTH_PROVIDER_SECOND_CLASS,
  CampusAuthUserError,
  type CampusAuthMethodView,
  type CampusAuthProvider,
  type CampusAuthProviderAuthenticateInput,
  type CampusAuthPendingResult,
  type CampusOwnerIdentity,
} from '../campus-auth-core/index.js';
import { SecondClassCache } from './cache.js';
import { SecondClassHttpClient } from './client.js';
import { SecondClassReauthStore } from './reauth-store.js';
import type {
  SecondClassCaptcha,
  SecondClassCredentialPayload,
  SecondClassPage,
  SecondClassSessionPayload,
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

export class HbuSecondClassService {
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
