import type { Context } from 'koishi';
import type {
  BindChallengeStatus,
  DatabaseLike,
  HbuJwAuthAudit,
  HbuJwBindChallenge,
  HbuJwCredential,
  HbuJwSession,
  HbuJwSessionStatus,
  OwnerIdentity,
} from './types.js';
import { HBU_JW_SERVICE_ID } from './types.js';

const ACTIVE_CHALLENGE_STATUSES: BindChallengeStatus[] = ['created', 'login_pending', 'login_succeeded'];

export function ensureHbuJwTables(ctx: Context): void {
  ctx.model.extend(
    'hbu_jw_bind_challenge',
    {
      id: 'unsigned',
      tokenHash: 'string',
      ownerKey: 'string',
      platform: 'string',
      qqUserId: 'string',
      channelId: 'string',
      status: 'string',
      loginAttemptId: { type: 'string', nullable: true },
      confirmCodeHash: { type: 'string', nullable: true },
      pendingCookieJarCipher: { type: 'text', nullable: true },
      pendingCredentialCipher: { type: 'text', nullable: true },
      pendingCredentialMeta: { type: 'text', nullable: true },
      errorMessage: { type: 'text', nullable: true },
      expiresAt: 'double',
      createdAt: 'double',
      updatedAt: 'double',
    },
    {
      autoInc: true,
      unique: ['tokenHash'],
      indexes: [['ownerKey', 'status'], ['expiresAt']],
    },
  );

  ctx.model.extend(
    'hbu_jw_session',
    {
      id: 'unsigned',
      ownerKey: 'string',
      platform: 'string',
      qqUserId: 'string',
      cookieJarCipher: 'text',
      status: 'string',
      validatedAt: 'double',
      lastRefreshAt: { type: 'double', nullable: true },
      lastFailureReason: { type: 'text', nullable: true },
      createdAt: 'double',
      updatedAt: 'double',
    },
    {
      autoInc: true,
      unique: ['ownerKey'],
    },
  );

  ctx.model.extend(
    'hbu_jw_credential',
    {
      id: 'unsigned',
      ownerKey: 'string',
      platform: 'string',
      qqUserId: 'string',
      serviceId: 'string',
      credentialCipher: 'text',
      credentialMeta: 'text',
      kekId: 'string',
      alg: 'string',
      version: 'unsigned',
      createdAt: 'double',
      updatedAt: 'double',
      lastUsedAt: { type: 'double', nullable: true },
      lastFailureReason: { type: 'text', nullable: true },
      revokedAt: { type: 'double', nullable: true },
    },
    {
      autoInc: true,
      unique: ['ownerKey'],
      indexes: [['ownerKey', 'serviceId'], ['revokedAt']],
    },
  );

  ctx.model.extend(
    'hbu_jw_auth_audit',
    {
      id: 'unsigned',
      ownerKey: 'string',
      eventType: 'string',
      status: 'string',
      reason: { type: 'text', nullable: true },
      createdAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['ownerKey'], ['eventType'], ['createdAt']],
    },
  );
}

export class HbuJwStore {
  constructor(private readonly database: DatabaseLike) {}

  async cleanupExpiredChallenges(now: number): Promise<void> {
    await this.database.set('hbu_jw_bind_challenge', {
      status: { $in: ACTIVE_CHALLENGE_STATUSES },
      expiresAt: { $lte: now },
    }, {
      status: 'expired',
      loginAttemptId: null,
      confirmCodeHash: null,
      pendingCookieJarCipher: null,
      pendingCredentialCipher: null,
      pendingCredentialMeta: null,
      errorMessage: null,
      updatedAt: now,
    });
  }

  async cancelActiveChallenges(ownerKey: string, now: number): Promise<void> {
    await this.database.set('hbu_jw_bind_challenge', {
      ownerKey,
      status: { $in: ACTIVE_CHALLENGE_STATUSES },
    }, {
      status: 'cancelled',
      loginAttemptId: null,
      confirmCodeHash: null,
      pendingCookieJarCipher: null,
      pendingCredentialCipher: null,
      pendingCredentialMeta: null,
      errorMessage: null,
      updatedAt: now,
    });
  }

  async createChallenge(identity: OwnerIdentity, tokenHash: string, expiresAt: number, now: number): Promise<HbuJwBindChallenge> {
    return this.database.create<HbuJwBindChallenge>('hbu_jw_bind_challenge', {
      tokenHash,
      ownerKey: identity.ownerKey,
      platform: identity.platform,
      qqUserId: identity.qqUserId,
      channelId: identity.channelId,
      status: 'created',
      loginAttemptId: null,
      confirmCodeHash: null,
      pendingCookieJarCipher: null,
      pendingCredentialCipher: null,
      pendingCredentialMeta: null,
      errorMessage: null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
  }

  async findChallengeByTokenHash(tokenHash: string): Promise<HbuJwBindChallenge | null> {
    const [row] = await this.database.get<HbuJwBindChallenge>('hbu_jw_bind_challenge', { tokenHash });
    return row ?? null;
  }

  async findChallengeById(id: number): Promise<HbuJwBindChallenge | null> {
    const [row] = await this.database.get<HbuJwBindChallenge>('hbu_jw_bind_challenge', { id });
    return row ?? null;
  }

  async findLoginSucceededChallenge(ownerKey: string): Promise<HbuJwBindChallenge | null> {
    const rows = await this.database.get<HbuJwBindChallenge>('hbu_jw_bind_challenge', {
      ownerKey,
      status: 'login_succeeded',
    });
    return rows.sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  }

  async findActiveChallenges(ownerKey: string): Promise<HbuJwBindChallenge[]> {
    return this.database.get<HbuJwBindChallenge>('hbu_jw_bind_challenge', {
      ownerKey,
      status: { $in: ACTIVE_CHALLENGE_STATUSES },
    });
  }

  async findLatestChallenge(ownerKey: string): Promise<HbuJwBindChallenge | null> {
    const rows = await this.database.get<HbuJwBindChallenge>('hbu_jw_bind_challenge', { ownerKey });
    return rows.sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  }

  async updateChallenge(id: number, patch: Partial<HbuJwBindChallenge>): Promise<void> {
    await this.database.set('hbu_jw_bind_challenge', { id }, patch as Record<string, unknown>);
  }

  async claimChallengeForLogin(id: number, loginAttemptId: string, now: number): Promise<HbuJwBindChallenge | null> {
    await this.database.set('hbu_jw_bind_challenge', { id, status: 'created' }, {
      status: 'login_pending',
      loginAttemptId,
      updatedAt: now,
    });
    const row = await this.findChallengeById(id);
    return row?.status === 'login_pending' && row.loginAttemptId === loginAttemptId ? row : null;
  }

  async completeChallengeLogin(id: number, loginAttemptId: string, patch: Partial<HbuJwBindChallenge>): Promise<HbuJwBindChallenge | null> {
    await this.database.set('hbu_jw_bind_challenge', { id, status: 'login_pending', loginAttemptId }, patch as Record<string, unknown>);
    const row = await this.findChallengeById(id);
    return row?.status === 'login_succeeded' && row.loginAttemptId === loginAttemptId ? row : null;
  }

  async releaseChallengeLogin(id: number, loginAttemptId: string, reason: string, now: number): Promise<void> {
    await this.database.set('hbu_jw_bind_challenge', { id, status: 'login_pending', loginAttemptId }, {
      status: 'created',
      loginAttemptId: null,
      errorMessage: reason,
      updatedAt: now,
    });
  }

  async clearChallengeSecrets(id: number, status: BindChallengeStatus, now: number): Promise<void> {
    await this.database.set('hbu_jw_bind_challenge', { id }, {
      status,
      loginAttemptId: null,
      confirmCodeHash: null,
      pendingCookieJarCipher: null,
      pendingCredentialCipher: null,
      pendingCredentialMeta: null,
      errorMessage: null,
      updatedAt: now,
    });
  }

  async clearOwnerChallengeSecrets(ownerKey: string, now: number): Promise<void> {
    await this.database.set('hbu_jw_bind_challenge', { ownerKey }, {
      loginAttemptId: null,
      confirmCodeHash: null,
      pendingCookieJarCipher: null,
      pendingCredentialCipher: null,
      pendingCredentialMeta: null,
      errorMessage: null,
      updatedAt: now,
    });
  }

  async replaceSession(identity: OwnerIdentity, cookieJarCipher: string, status: HbuJwSessionStatus, now: number): Promise<void> {
    const [existing] = await this.database.get<HbuJwSession>('hbu_jw_session', { ownerKey: identity.ownerKey });
    const row = {
      ownerKey: identity.ownerKey,
      platform: identity.platform,
      qqUserId: identity.qqUserId,
      cookieJarCipher,
      status,
      validatedAt: now,
      lastRefreshAt: now,
      lastFailureReason: null,
      updatedAt: now,
    };
    if (existing) {
      await this.database.set('hbu_jw_session', { id: existing.id }, row);
      return;
    }
    await this.database.create('hbu_jw_session', { ...row, createdAt: now });
  }

  async getSession(ownerKey: string): Promise<HbuJwSession | null> {
    const [row] = await this.database.get<HbuJwSession>('hbu_jw_session', { ownerKey });
    return row ?? null;
  }

  async setSessionStatus(ownerKey: string, status: HbuJwSessionStatus, reason: string | null, now: number): Promise<void> {
    await this.database.set('hbu_jw_session', { ownerKey }, {
      status,
      lastFailureReason: reason,
      updatedAt: now,
    });
  }

  async markSessionValidated(ownerKey: string, now: number): Promise<void> {
    await this.database.set('hbu_jw_session', { ownerKey }, {
      status: 'active',
      validatedAt: now,
      lastFailureReason: null,
      updatedAt: now,
    });
  }

  async upsertCredentialPlaceholder(identity: OwnerIdentity, kekId: string, now: number): Promise<HbuJwCredential> {
    const [existing] = await this.database.get<HbuJwCredential>('hbu_jw_credential', { ownerKey: identity.ownerKey });
    if (existing) {
      return {
        ...existing,
        platform: identity.platform,
        qqUserId: identity.qqUserId,
        serviceId: HBU_JW_SERVICE_ID,
        kekId,
        alg: 'aes-256-gcm',
        version: existing.version + 1,
        updatedAt: now,
        lastUsedAt: null,
        lastFailureReason: null,
        revokedAt: null,
      };
    }
    return this.database.create<HbuJwCredential>('hbu_jw_credential', {
      ownerKey: identity.ownerKey,
      platform: identity.platform,
      qqUserId: identity.qqUserId,
      serviceId: HBU_JW_SERVICE_ID,
      credentialCipher: '',
      credentialMeta: '',
      kekId,
      alg: 'aes-256-gcm',
      version: 1,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      lastFailureReason: null,
      revokedAt: null,
    });
  }

  async updateCredentialEnvelope(row: HbuJwCredential, credentialCipher: string, credentialMeta: string, now: number): Promise<void> {
    await this.database.set('hbu_jw_credential', { id: row.id }, {
      ownerKey: row.ownerKey,
      platform: row.platform,
      qqUserId: row.qqUserId,
      serviceId: row.serviceId,
      credentialCipher,
      credentialMeta,
      kekId: row.kekId,
      alg: row.alg,
      version: row.version,
      lastUsedAt: null,
      lastFailureReason: null,
      revokedAt: null,
      updatedAt: now,
    });
  }

  async getActiveCredential(ownerKey: string): Promise<HbuJwCredential | null> {
    const rows = await this.database.get<HbuJwCredential>('hbu_jw_credential', {
      ownerKey,
      serviceId: HBU_JW_SERVICE_ID,
      revokedAt: null,
    });
    return rows.sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  }

  async markCredentialUsed(id: number, now: number): Promise<void> {
    await this.database.set('hbu_jw_credential', { id }, {
      lastUsedAt: now,
      lastFailureReason: null,
      updatedAt: now,
    });
  }

  async markCredentialFailure(id: number, reason: string, now: number): Promise<void> {
    await this.database.set('hbu_jw_credential', { id }, {
      lastFailureReason: reason,
      updatedAt: now,
    });
  }

  async revokeCredential(ownerKey: string, now: number): Promise<void> {
    await this.database.set('hbu_jw_credential', {
      ownerKey,
      serviceId: HBU_JW_SERVICE_ID,
      revokedAt: null,
    }, {
      credentialCipher: '',
      credentialMeta: '',
      revokedAt: now,
      updatedAt: now,
    });
  }

  async removeSession(ownerKey: string): Promise<void> {
    await this.database.remove('hbu_jw_session', { ownerKey });
  }

  async audit(row: Omit<HbuJwAuthAudit, 'id'>): Promise<void> {
    await this.database.create('hbu_jw_auth_audit', row);
  }

  async listRecentActiveSessions(cutoff: number): Promise<HbuJwSession[]> {
    const rows = await this.database.get<HbuJwSession>('hbu_jw_session', { status: 'active' });
    return rows.filter((row) => row.validatedAt >= cutoff);
  }
}
