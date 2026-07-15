import type { Context } from 'koishi';
import type {
  CampusAuthAudit,
  CampusAuthChallenge,
  CampusAuthChallengeStatus,
  CampusAuthCredential,
  CampusAuthDatabase,
  CampusAuthMethod,
  CampusAuthProviderId,
  CampusAuthSession,
  CampusAuthSessionStatus,
  CampusLocationActionChallenge,
  CampusLocationActionStatus,
  CampusOwnerIdentity,
} from './types.js';

const ACTIVE_CHALLENGE_STATUSES: CampusAuthChallengeStatus[] = [
  'created',
  'authenticating',
  'user_action_required',
  'verified',
  'failed',
];

const ACTIVE_LOCATION_ACTION_STATUSES: CampusLocationActionStatus[] = [
  'created',
  'preparing',
  'ready',
  'committing',
];

export function ensureCampusAuthTables(ctx: Context): void {
  ctx.model.extend('campus_location_action_challenge', {
    id: 'unsigned',
    tokenHash: 'string',
    ownerKey: 'string',
    platform: 'string',
    qqUserId: 'string',
    channelId: 'string',
    providerId: 'string',
    actionId: 'string',
    status: 'string',
    attemptId: { type: 'string', nullable: true },
    payloadCipher: 'text',
    payloadMeta: 'text',
    preparedCipher: { type: 'text', nullable: true },
    preparedMeta: { type: 'text', nullable: true },
    resultMessage: { type: 'text', nullable: true },
    errorMessage: { type: 'text', nullable: true },
    expiresAt: 'double',
    createdAt: 'double',
    updatedAt: 'double',
  }, {
    autoInc: true,
    unique: ['tokenHash'],
    indexes: [['ownerKey', 'providerId', 'status'], ['expiresAt']],
  });

  ctx.model.extend('campus_auth_challenge', {
    id: 'unsigned',
    tokenHash: 'string',
    ownerKey: 'string',
    platform: 'string',
    qqUserId: 'string',
    channelId: 'string',
    providerId: 'string',
    method: { type: 'string', nullable: true },
    status: 'string',
    attemptId: { type: 'string', nullable: true },
    attemptCount: 'unsigned',
    confirmCodeHash: { type: 'string', nullable: true },
    pendingCipher: { type: 'text', nullable: true },
    pendingMeta: { type: 'text', nullable: true },
    pendingConfirmCodeCipher: { type: 'text', nullable: true },
    pendingConfirmCodeMeta: { type: 'text', nullable: true },
    errorMessage: { type: 'text', nullable: true },
    expiresAt: 'double',
    createdAt: 'double',
    updatedAt: 'double',
  }, {
    autoInc: true,
    unique: ['tokenHash'],
    indexes: [['ownerKey', 'providerId', 'status'], ['expiresAt']],
  });

  ctx.model.extend('campus_auth_credential', {
    id: 'unsigned',
    ownerKey: 'string',
    platform: 'string',
    qqUserId: 'string',
    providerId: 'string',
    method: 'string',
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
  }, {
    autoInc: true,
    indexes: [['ownerKey', 'providerId'], ['revokedAt']],
  });

  ctx.model.extend('campus_auth_session', {
    id: 'unsigned',
    ownerKey: 'string',
    platform: 'string',
    qqUserId: 'string',
    providerId: 'string',
    method: 'string',
    sessionCipher: 'text',
    sessionMeta: 'text',
    status: 'string',
    sourceProviderId: { type: 'string', nullable: true },
    sourceCredentialId: { type: 'unsigned', nullable: true },
    version: 'unsigned',
    validatedAt: 'double',
    expiresAt: { type: 'double', nullable: true },
    lastRefreshAt: { type: 'double', nullable: true },
    lastFailureReason: { type: 'text', nullable: true },
    createdAt: 'double',
    updatedAt: 'double',
  }, {
    autoInc: true,
    unique: [['ownerKey', 'providerId']],
    indexes: [['providerId', 'status'], ['sourceProviderId']],
  });

  ctx.model.extend('campus_auth_audit', {
    id: 'unsigned',
    ownerKey: 'string',
    providerId: 'string',
    eventType: 'string',
    status: 'string',
    reason: { type: 'text', nullable: true },
    createdAt: 'double',
  }, {
    autoInc: true,
    indexes: [['ownerKey', 'providerId', 'createdAt'], ['createdAt']],
  });
}

export class CampusAuthStore {
  constructor(private readonly database: CampusAuthDatabase) {}

  createLocationAction(
    identity: CampusOwnerIdentity,
    providerId: CampusAuthProviderId,
    actionId: string,
    tokenHash: string,
    expiresAt: number,
    now: number,
  ): Promise<CampusLocationActionChallenge> {
    return this.database.create<CampusLocationActionChallenge>('campus_location_action_challenge', {
      tokenHash,
      ownerKey: identity.ownerKey,
      platform: identity.platform,
      qqUserId: identity.qqUserId,
      channelId: identity.channelId,
      providerId,
      actionId,
      status: 'created',
      attemptId: null,
      payloadCipher: '',
      payloadMeta: '',
      preparedCipher: null,
      preparedMeta: null,
      resultMessage: null,
      errorMessage: null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
  }

  async updateLocationActionPayload(id: number, payloadCipher: string, payloadMeta: string, now: number): Promise<void> {
    await this.database.set('campus_location_action_challenge', { id, status: 'created' }, {
      payloadCipher,
      payloadMeta,
      updatedAt: now,
    });
  }

  async findLocationActionByTokenHash(tokenHash: string): Promise<CampusLocationActionChallenge | null> {
    const [row] = await this.database.get<CampusLocationActionChallenge>('campus_location_action_challenge', { tokenHash });
    return row ?? null;
  }

  async cancelActiveLocationActions(ownerKey: string, providerId: CampusAuthProviderId, now: number): Promise<void> {
    const rows = await this.database.get<CampusLocationActionChallenge>('campus_location_action_challenge', { ownerKey, providerId });
    for (const row of rows) {
      if (ACTIVE_LOCATION_ACTION_STATUSES.includes(row.status)) await this.clearLocationAction(row.id, 'cancelled', now);
    }
  }

  async cleanupExpiredLocationActions(now: number): Promise<void> {
    const rows = await this.database.get<CampusLocationActionChallenge>('campus_location_action_challenge', {});
    for (const row of rows) {
      if (!['expired', 'cancelled'].includes(row.status) && row.expiresAt <= now) {
        await this.clearLocationAction(row.id, 'expired', now);
      }
    }
  }

  async claimLocationAction(
    id: number,
    expectedStatus: CampusLocationActionStatus,
    nextStatus: 'preparing' | 'committing',
    attemptId: string,
    now: number,
  ): Promise<CampusLocationActionChallenge | null> {
    const [current] = await this.database.get<CampusLocationActionChallenge>('campus_location_action_challenge', { id, status: expectedStatus });
    if (!current) return null;
    await this.database.set('campus_location_action_challenge', { id, status: expectedStatus }, {
      status: nextStatus,
      attemptId,
      errorMessage: null,
      updatedAt: now,
    });
    const [row] = await this.database.get<CampusLocationActionChallenge>('campus_location_action_challenge', { id });
    return row?.status === nextStatus && row.attemptId === attemptId ? row : null;
  }

  async completeLocationPreparation(
    id: number,
    attemptId: string,
    preparedCipher: string,
    preparedMeta: string,
    now: number,
  ): Promise<boolean> {
    await this.database.set('campus_location_action_challenge', { id, status: 'preparing', attemptId }, {
      status: 'ready',
      attemptId: null,
      preparedCipher,
      preparedMeta,
      errorMessage: null,
      updatedAt: now,
    });
    const [row] = await this.database.get<CampusLocationActionChallenge>('campus_location_action_challenge', { id });
    return row?.status === 'ready' && row.preparedCipher === preparedCipher;
  }

  async failLocationActionAttempt(
    id: number,
    attemptId: string,
    currentStatus: 'preparing' | 'committing',
    nextStatus: 'created' | 'ready',
    reason: string,
    now: number,
  ): Promise<void> {
    await this.database.set('campus_location_action_challenge', { id, status: currentStatus, attemptId }, {
      status: nextStatus,
      attemptId: null,
      errorMessage: reason,
      updatedAt: now,
    });
  }

  async completeLocationAction(id: number, attemptId: string, resultMessage: string, now: number): Promise<boolean> {
    await this.database.set('campus_location_action_challenge', { id, status: 'committing', attemptId }, {
      status: 'completed',
      attemptId: null,
      payloadCipher: '',
      payloadMeta: '',
      preparedCipher: null,
      preparedMeta: null,
      resultMessage,
      errorMessage: null,
      updatedAt: now,
    });
    const [row] = await this.database.get<CampusLocationActionChallenge>('campus_location_action_challenge', { id });
    return row?.status === 'completed';
  }

  async finishLocationActionUncertain(id: number, attemptId: string, resultMessage: string, now: number): Promise<void> {
    await this.database.set('campus_location_action_challenge', { id, status: 'committing', attemptId }, {
      status: 'uncertain',
      attemptId: null,
      payloadCipher: '',
      payloadMeta: '',
      preparedCipher: null,
      preparedMeta: null,
      resultMessage,
      errorMessage: null,
      updatedAt: now,
    });
  }

  async clearLocationAction(id: number, status: 'expired' | 'cancelled', now: number): Promise<void> {
    await this.database.set('campus_location_action_challenge', { id }, {
      status,
      attemptId: null,
      payloadCipher: '',
      payloadMeta: '',
      preparedCipher: null,
      preparedMeta: null,
      resultMessage: null,
      errorMessage: null,
      updatedAt: now,
    });
  }

  createChallenge(
    identity: CampusOwnerIdentity,
    providerId: CampusAuthProviderId,
    tokenHash: string,
    expiresAt: number,
    now: number,
  ): Promise<CampusAuthChallenge> {
    return this.database.create<CampusAuthChallenge>('campus_auth_challenge', {
      tokenHash,
      ownerKey: identity.ownerKey,
      platform: identity.platform,
      qqUserId: identity.qqUserId,
      channelId: identity.channelId,
      providerId,
      method: null,
      status: 'created',
      attemptId: null,
      attemptCount: 0,
      confirmCodeHash: null,
      pendingCipher: null,
      pendingMeta: null,
      pendingConfirmCodeCipher: null,
      pendingConfirmCodeMeta: null,
      errorMessage: null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
  }

  async findChallengeByTokenHash(tokenHash: string): Promise<CampusAuthChallenge | null> {
    const [row] = await this.database.get<CampusAuthChallenge>('campus_auth_challenge', { tokenHash });
    return row ?? null;
  }

  async findVerifiedChallenge(ownerKey: string, providerId: CampusAuthProviderId): Promise<CampusAuthChallenge | null> {
    const rows = await this.database.get<CampusAuthChallenge>('campus_auth_challenge', {
      ownerKey,
      providerId,
      status: 'verified',
    });
    return rows.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  }

  async findActiveChallenges(ownerKey: string, providerId: CampusAuthProviderId): Promise<CampusAuthChallenge[]> {
    const rows = await this.database.get<CampusAuthChallenge>('campus_auth_challenge', { ownerKey, providerId });
    return rows.filter((row) => ACTIVE_CHALLENGE_STATUSES.includes(row.status));
  }

  async cancelActiveChallenges(ownerKey: string, providerId: CampusAuthProviderId, now: number): Promise<void> {
    const rows = await this.findActiveChallenges(ownerKey, providerId);
    for (const row of rows) await this.clearChallengeSecrets(row.id, 'cancelled', now);
  }

  async cleanupExpiredChallenges(now: number): Promise<void> {
    const rows = await this.database.get<CampusAuthChallenge>('campus_auth_challenge', {});
    for (const row of rows) {
      if (ACTIVE_CHALLENGE_STATUSES.includes(row.status) && row.expiresAt <= now) {
        await this.clearChallengeSecrets(row.id, 'expired', now);
      }
    }
  }

  async claimChallenge(id: number, expectedStatus: CampusAuthChallengeStatus, attemptId: string, now: number): Promise<CampusAuthChallenge | null> {
    const [current] = await this.database.get<CampusAuthChallenge>('campus_auth_challenge', { id, status: expectedStatus });
    if (!current) return null;
    await this.database.set('campus_auth_challenge', { id, status: expectedStatus }, {
      status: 'authenticating',
      attemptId,
      attemptCount: current.attemptCount + 1,
      errorMessage: null,
      updatedAt: now,
    });
    const [row] = await this.database.get<CampusAuthChallenge>('campus_auth_challenge', { id });
    return row?.status === 'authenticating' && row.attemptId === attemptId ? row : null;
  }

  async completeChallenge(
    id: number,
    attemptId: string,
    method: CampusAuthMethod,
    values: Pick<CampusAuthChallenge,
      'confirmCodeHash' | 'pendingCipher' | 'pendingMeta' | 'pendingConfirmCodeCipher' | 'pendingConfirmCodeMeta'>,
    now: number,
  ): Promise<boolean> {
    await this.database.set('campus_auth_challenge', { id, status: 'authenticating', attemptId }, {
      method,
      status: 'verified',
      attemptId: null,
      ...values,
      errorMessage: null,
      updatedAt: now,
    });
    const [row] = await this.database.get<CampusAuthChallenge>('campus_auth_challenge', { id });
    return row?.status === 'verified' && row.method === method;
  }

  async failChallenge(id: number, attemptId: string, reason: string, now: number): Promise<void> {
    await this.database.set('campus_auth_challenge', { id, status: 'authenticating', attemptId }, {
      status: 'failed',
      attemptId: null,
      errorMessage: reason,
      updatedAt: now,
    });
  }

  async clearChallengeSecrets(id: number, status: CampusAuthChallengeStatus, now: number): Promise<void> {
    await this.database.set('campus_auth_challenge', { id }, {
      status,
      attemptId: null,
      confirmCodeHash: null,
      pendingCipher: null,
      pendingMeta: null,
      pendingConfirmCodeCipher: null,
      pendingConfirmCodeMeta: null,
      updatedAt: now,
    });
  }

  async getActiveCredential(ownerKey: string, providerId: CampusAuthProviderId): Promise<CampusAuthCredential | null> {
    const rows = await this.database.get<CampusAuthCredential>('campus_auth_credential', { ownerKey, providerId });
    return rows.filter((row) => row.revokedAt == null).sort((a, b) => b.version - a.version)[0] ?? null;
  }

  async createCredentialPlaceholder(
    identity: CampusOwnerIdentity,
    providerId: CampusAuthProviderId,
    method: CampusAuthMethod,
    kekId: string,
    now: number,
  ): Promise<CampusAuthCredential> {
    const existing = await this.getActiveCredential(identity.ownerKey, providerId);
    if (existing) await this.revokeCredential(identity.ownerKey, providerId, now);
    const all = await this.database.get<CampusAuthCredential>('campus_auth_credential', { ownerKey: identity.ownerKey, providerId });
    const version = Math.max(0, ...all.map((row) => row.version)) + 1;
    return this.database.create<CampusAuthCredential>('campus_auth_credential', {
      ownerKey: identity.ownerKey,
      platform: identity.platform,
      qqUserId: identity.qqUserId,
      providerId,
      method,
      credentialCipher: '',
      credentialMeta: '',
      kekId,
      alg: 'aes-256-gcm',
      version,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      lastFailureReason: null,
      revokedAt: null,
    });
  }

  async updateCredentialEnvelope(row: CampusAuthCredential, cipherText: string, meta: string, now: number): Promise<void> {
    await this.database.set('campus_auth_credential', { id: row.id, revokedAt: null }, {
      credentialCipher: cipherText,
      credentialMeta: meta,
      updatedAt: now,
    });
  }

  async markCredentialUsed(id: number, now: number): Promise<void> {
    await this.database.set('campus_auth_credential', { id, revokedAt: null }, {
      lastUsedAt: now,
      lastFailureReason: null,
      updatedAt: now,
    });
  }

  async markCredentialFailure(id: number, reason: string, now: number): Promise<void> {
    await this.database.set('campus_auth_credential', { id, revokedAt: null }, {
      lastFailureReason: reason,
      updatedAt: now,
    });
  }

  async revokeCredential(ownerKey: string, providerId: CampusAuthProviderId, now: number): Promise<void> {
    await this.database.set('campus_auth_credential', { ownerKey, providerId, revokedAt: null }, {
      revokedAt: now,
      credentialCipher: '',
      credentialMeta: '',
      updatedAt: now,
    });
  }

  async getSession(ownerKey: string, providerId: CampusAuthProviderId): Promise<CampusAuthSession | null> {
    const [row] = await this.database.get<CampusAuthSession>('campus_auth_session', { ownerKey, providerId });
    return row ?? null;
  }

  async upsertSessionPlaceholder(
    identity: CampusOwnerIdentity,
    providerId: CampusAuthProviderId,
    method: CampusAuthMethod,
    sourceProviderId: CampusAuthProviderId | null,
    sourceCredentialId: number | null,
    expiresAt: number | null,
    now: number,
    rotateVersion = true,
  ): Promise<CampusAuthSession> {
    const existing = await this.getSession(identity.ownerKey, providerId);
    if (!existing) {
      return this.database.create<CampusAuthSession>('campus_auth_session', {
        ownerKey: identity.ownerKey,
        platform: identity.platform,
        qqUserId: identity.qqUserId,
        providerId,
        method,
        sessionCipher: '',
        sessionMeta: '',
        status: 'active',
        sourceProviderId,
        sourceCredentialId,
        version: 1,
        validatedAt: now,
        expiresAt,
        lastRefreshAt: null,
        lastFailureReason: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    await this.database.set('campus_auth_session', { id: existing.id }, {
      platform: identity.platform,
      qqUserId: identity.qqUserId,
      method,
      sessionCipher: '',
      sessionMeta: '',
      status: 'active',
      sourceProviderId,
      sourceCredentialId,
      version: existing.version + (rotateVersion ? 1 : 0),
      validatedAt: now,
      expiresAt,
      lastRefreshAt: now,
      lastFailureReason: null,
      updatedAt: now,
    });
    const [updated] = await this.database.get<CampusAuthSession>('campus_auth_session', { id: existing.id });
    if (!updated) throw new Error('campus auth session disappeared during update.');
    return updated;
  }

  async updateSessionEnvelope(row: CampusAuthSession, cipherText: string, meta: string, now: number): Promise<void> {
    await this.database.set('campus_auth_session', { id: row.id }, {
      sessionCipher: cipherText,
      sessionMeta: meta,
      status: 'active',
      validatedAt: now,
      lastFailureReason: null,
      updatedAt: now,
    });
  }

  async setSessionStatus(ownerKey: string, providerId: CampusAuthProviderId, status: CampusAuthSessionStatus, reason: string | null, now: number): Promise<void> {
    await this.database.set('campus_auth_session', { ownerKey, providerId }, {
      status,
      lastFailureReason: reason,
      updatedAt: now,
    });
  }

  async markSessionValidated(ownerKey: string, providerId: CampusAuthProviderId, now: number): Promise<void> {
    await this.database.set('campus_auth_session', { ownerKey, providerId, status: 'active' }, {
      validatedAt: now,
      lastFailureReason: null,
      updatedAt: now,
    });
  }

  async removeSession(ownerKey: string, providerId: CampusAuthProviderId): Promise<void> {
    await this.database.remove('campus_auth_session', { ownerKey, providerId });
  }

  async removeDerivedSessions(ownerKey: string, sourceProviderId: CampusAuthProviderId): Promise<CampusAuthSession[]> {
    const rows = await this.database.get<CampusAuthSession>('campus_auth_session', { ownerKey, sourceProviderId });
    await this.database.remove('campus_auth_session', { ownerKey, sourceProviderId });
    return rows;
  }

  audit(event: Omit<CampusAuthAudit, 'id'>): Promise<CampusAuthAudit> {
    return this.database.create<CampusAuthAudit>('campus_auth_audit', event);
  }
}
