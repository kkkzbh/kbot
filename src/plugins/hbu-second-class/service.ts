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
import type { SecondClassPage, SecondClassSessionPayload } from './types.js';
import { SecondClassSessionExpiredError } from './types.js';

export class HbuSecondClassAuthProvider implements CampusAuthProvider {
  readonly id = CAMPUS_AUTH_PROVIDER_SECOND_CLASS;
  readonly label = '河北大学二课';
  readonly confirmCommandPrefix = '二课确认';
  constructor(private readonly client: SecondClassHttpClient) {}

  async getBindingMethods(): Promise<CampusAuthMethodView[]> {
    const directCaptcha = await this.client.getCaptcha();
    return [
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
    if (input.method === 'direct_credentials') {
      session = await this.client.directLogin({
        loginName: input.fields.loginName.trim(),
        password: input.fields.password,
        captchaCode: input.fields.captchaCode.trim(),
        captchaUuid: input.fields.captchaUuid.trim(),
      });
    } else if (input.method === 'token_import') {
      session = await this.client.importToken(input.fields.token);
    } else {
      throw new CampusAuthUserError('该绑定方式不属于二课。');
    }
    return {
      method: input.method,
      sessionPayload: session,
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
    await this.campusAuth.markSessionInvalid(identity.ownerKey, CAMPUS_AUTH_PROVIDER_SECOND_CLASS, 'session_expired');
    throw new CampusAuthUserError('二课登录态已失效，请重新绑定。');
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
