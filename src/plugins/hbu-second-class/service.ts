import type { CampusAuthServiceLike } from '../../types/campus-auth.js';
import type { ZyhService } from '../zyh/index.js';
import type { VersionedQueryResult } from '../shared/versioned-json-cache.js';
import {
  CAMPUS_AUTH_PROVIDER_SECOND_CLASS,
  CAMPUS_AUTH_PROVIDER_ZYH,
  CampusAuthUserError,
  type CampusAuthMethodView,
  type CampusAuthProvider,
  type CampusAuthProviderAuthenticateInput,
  type CampusAuthPendingResult,
  type CampusOwnerIdentity,
} from '../campus-auth-core/index.js';
import { SecondClassCache } from './cache.js';
import { SecondClassHttpClient } from './client.js';
import type { SecondClassLoginInput, SecondClassPage, SecondClassSessionPayload } from './types.js';
import { SecondClassApiError, SecondClassSessionExpiredError } from './types.js';

export class HbuSecondClassAuthProvider implements CampusAuthProvider {
  readonly id = CAMPUS_AUTH_PROVIDER_SECOND_CLASS;
  readonly label = '河北大学二课';
  readonly confirmCommandPrefix = '二课确认';

  constructor(
    private readonly client: SecondClassHttpClient,
    private readonly zyh: ZyhService,
  ) {}

  async getBindingMethods(): Promise<CampusAuthMethodView[]> {
    const [ssoCaptcha, directCaptcha] = await Promise.all([this.client.getCaptcha(), this.client.getCaptcha()]);
    return [
      {
        id: 'zyh_sso',
        label: '志愿汇 SSO',
        description: '已关联账号直接登录；首次关联需同时验证已有二课账号并核验学号或工号后 3 位。',
        fields: [
          { name: 'studentSuffix', label: '学号或工号后 3 位', type: 'text', required: true, autocomplete: 'off' },
          { name: 'ssoLoginName', label: '二课账号（首次关联填写）', type: 'text', autocomplete: 'username' },
          { name: 'ssoPassword', label: '二课密码（首次关联填写）', type: 'password', autocomplete: 'current-password' },
          { name: 'ssoCaptchaCode', label: '图形验证码（首次关联填写）', type: 'captcha', imageDataUrl: ssoCaptcha.imageDataUrl, autocomplete: 'off' },
          { name: 'ssoCaptchaUuid', label: '', type: 'hidden', value: ssoCaptcha.uuid },
          { name: 'ssoConsent', label: '我确认授权志愿汇身份关联到该二课账号。', type: 'checkbox', required: true },
        ],
      },
      {
        id: 'direct_credentials',
        label: '二课账号登录',
        description: '密码只用于本次 SM2 加密登录，服务器只保存二课 Token。',
        fields: [
          { name: 'loginName', label: '二课账号', type: 'text', required: true, autocomplete: 'username' },
          { name: 'password', label: '二课密码', type: 'password', required: true, autocomplete: 'current-password' },
          { name: 'captchaCode', label: '图形验证码', type: 'captcha', required: true, imageDataUrl: directCaptcha.imageDataUrl, autocomplete: 'off' },
          { name: 'captchaUuid', label: '', type: 'hidden', required: true, value: directCaptcha.uuid },
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
    let sourceCredentialId: number | null = null;
    if (input.method === 'direct_credentials') {
      session = await this.client.directLogin(directLoginFields(input.fields));
    } else if (input.method === 'token_import') {
      session = await this.client.importToken(input.fields.token);
    } else if (input.method === 'zyh_sso') {
      if (input.fields.ssoConsent !== 'yes') throw new CampusAuthUserError('请先确认志愿汇关联授权。');
      const zyhSource = await this.zyh.getSecondClassSsoSource(input.identity);
      sourceCredentialId = zyhSource.credentialId;
      const supplied = [input.fields.ssoLoginName, input.fields.ssoPassword, input.fields.ssoCaptchaCode].some((value) => value?.trim());
      const directLogin = supplied ? directLoginFields({
        loginName: input.fields.ssoLoginName,
        password: input.fields.ssoPassword,
        captchaCode: input.fields.ssoCaptchaCode,
        captchaUuid: input.fields.ssoCaptchaUuid,
      }) : undefined;
      session = await this.client.loginWithZyh({
        zyhCode: zyhSource.code,
        studentSuffix: input.fields.studentSuffix,
        directLogin,
      });
    } else {
      throw new CampusAuthUserError('该绑定方式不属于二课。');
    }
    return {
      method: input.method,
      sessionPayload: session,
      sourceProviderId: input.method === 'zyh_sso' ? CAMPUS_AUTH_PROVIDER_ZYH : null,
      sourceCredentialId,
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
    private readonly zyh: ZyhService,
    private readonly client: SecondClassHttpClient,
    private readonly cache: SecondClassCache,
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
    if (active.row.method !== 'zyh_sso') {
      await this.campusAuth.markSessionInvalid(identity.ownerKey, CAMPUS_AUTH_PROVIDER_SECOND_CLASS, 'session_expired');
      throw new CampusAuthUserError('二课登录态已失效，请重新绑定。');
    }
    try {
      const zyhSource = await this.zyh.getSecondClassSsoSource(identity);
      const refreshed = await this.client.refreshZyhSso(zyhSource.code);
      await this.campusAuth.replaceSession(identity, CAMPUS_AUTH_PROVIDER_SECOND_CLASS, 'zyh_sso', refreshed, {
        sourceProviderId: CAMPUS_AUTH_PROVIDER_ZYH,
        sourceCredentialId: zyhSource.credentialId,
        rotateVersion: false,
      });
      return { session: refreshed, sessionVersion: active.row.version };
    } catch (error) {
      if (error instanceof SecondClassApiError && error.code === 401) {
        await this.campusAuth.markSessionInvalid(identity.ownerKey, CAMPUS_AUTH_PROVIDER_SECOND_CLASS, 'zyh_sso_refresh_failed');
      }
      throw toUserError(error, '二课 SSO 续期失败，请重新绑定。');
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
}

function directLoginFields(fields: Readonly<Record<string, string>>): SecondClassLoginInput {
  const loginName = fields.loginName?.trim();
  const password = fields.password;
  const captchaCode = fields.captchaCode?.trim();
  const captchaUuid = fields.captchaUuid?.trim();
  if (!loginName || !password || !captchaCode || !captchaUuid) {
    throw new CampusAuthUserError('首次关联需要填写二课账号、密码和图形验证码。');
  }
  return { loginName, password, captchaCode, captchaUuid };
}

function toUserError(error: unknown, fallback: string): CampusAuthUserError {
  if (error instanceof CampusAuthUserError) return error;
  if (error instanceof SecondClassApiError) return new CampusAuthUserError(error.message || fallback);
  return new CampusAuthUserError(fallback);
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
