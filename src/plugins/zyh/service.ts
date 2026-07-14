import type { CampusAuthServiceLike } from '../../types/campus-auth.js';
import {
  CAMPUS_AUTH_PROVIDER_ZYH,
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
import type { ZyhActivity, ZyhCredentialPayload, ZyhProfile, ZyhSessionPayload } from './types.js';
import { ZyhSessionExpiredError } from './types.js';

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

export class ZyhService {
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

  private async requireActiveSession(identity: CampusOwnerIdentity) {
    const active = await this.campusAuth.getActiveSession<ZyhSessionPayload>(identity.ownerKey, CAMPUS_AUTH_PROVIDER_ZYH);
    if (!active) throw new CampusAuthUserError('请先发送“志愿汇绑定”。');
    return active;
  }
}

function maskId(value: string): string {
  return value.length > 6 ? `${value.slice(0, 3)}***${value.slice(-3)}` : value;
}
