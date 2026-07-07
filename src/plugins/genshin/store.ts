import type { Context } from 'koishi';
import type {
  DatabaseLike,
  GenshinAuthAudit,
  GenshinBindChallenge,
  GenshinBindChallengeStatus,
  GenshinCredential,
  GenshinGameRole,
  GenshinOperationStatus,
  GenshinRedeemRecord,
  GenshinSignInRecord,
  GenshinSignInTrigger,
  OwnerIdentity,
} from './types.js';
import { GENSHIN_SERVICE_ID } from './types.js';

const ACTIVE_CHALLENGE_STATUSES: GenshinBindChallengeStatus[] = ['created', 'verifying', 'role_selecting', 'login_succeeded'];

export function ensureGenshinTables(ctx: Context): void {
  ctx.model.extend(
    'genshin_bind_challenge',
    {
      id: 'unsigned',
      tokenHash: 'string',
      ownerKey: 'string',
      platform: 'string',
      qqUserId: 'string',
      channelId: 'string',
      status: 'string',
      verifyAttemptId: { type: 'string', nullable: true },
      confirmCodeHash: { type: 'string', nullable: true },
      pendingCredentialCipher: { type: 'text', nullable: true },
      pendingCredentialMeta: { type: 'text', nullable: true },
      pendingRolesJson: { type: 'text', nullable: true },
      selectedRoleJson: { type: 'text', nullable: true },
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
    'genshin_credential',
    {
      id: 'unsigned',
      ownerKey: 'string',
      platform: 'string',
      qqUserId: 'string',
      serviceId: 'string',
      uid: 'string',
      region: 'string',
      regionName: 'string',
      nickname: 'string',
      level: { type: 'integer', nullable: true },
      gameBiz: 'string',
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
      indexes: [['ownerKey', 'serviceId'], ['uid'], ['revokedAt']],
    },
  );

  ctx.model.extend(
    'genshin_signin_record',
    {
      id: 'unsigned',
      ownerKey: 'string',
      uid: 'string',
      region: 'string',
      signDate: 'string',
      trigger: 'string',
      status: 'string',
      retcode: 'integer',
      message: 'text',
      createdAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['ownerKey', 'signDate'], ['uid', 'signDate'], ['createdAt']],
    },
  );

  ctx.model.extend(
    'genshin_redeem_record',
    {
      id: 'unsigned',
      ownerKey: 'string',
      uid: 'string',
      region: 'string',
      cdkeyHash: 'string',
      status: 'string',
      retcode: 'integer',
      message: 'text',
      createdAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['ownerKey'], ['uid'], ['cdkeyHash'], ['createdAt']],
    },
  );

  ctx.model.extend(
    'genshin_auth_audit',
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

export class GenshinStore {
  constructor(private readonly database: DatabaseLike) {}

  async cleanupExpiredChallenges(now: number): Promise<void> {
    await this.database.set('genshin_bind_challenge', {
      status: { $in: ACTIVE_CHALLENGE_STATUSES },
      expiresAt: { $lte: now },
    }, clearedChallengePatch('expired', now));
  }

  async cancelActiveChallenges(ownerKey: string, now: number): Promise<void> {
    await this.database.set('genshin_bind_challenge', {
      ownerKey,
      status: { $in: ACTIVE_CHALLENGE_STATUSES },
    }, clearedChallengePatch('cancelled', now));
  }

  async createChallenge(identity: OwnerIdentity, tokenHash: string, expiresAt: number, now: number): Promise<GenshinBindChallenge> {
    return this.database.create<GenshinBindChallenge>('genshin_bind_challenge', {
      tokenHash,
      ownerKey: identity.ownerKey,
      platform: identity.platform,
      qqUserId: identity.qqUserId,
      channelId: identity.channelId,
      status: 'created',
      verifyAttemptId: null,
      confirmCodeHash: null,
      pendingCredentialCipher: null,
      pendingCredentialMeta: null,
      pendingRolesJson: null,
      selectedRoleJson: null,
      errorMessage: null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
  }

  async findChallengeByTokenHash(tokenHash: string): Promise<GenshinBindChallenge | null> {
    const [row] = await this.database.get<GenshinBindChallenge>('genshin_bind_challenge', { tokenHash });
    return row ?? null;
  }

  async findChallengeById(id: number): Promise<GenshinBindChallenge | null> {
    const [row] = await this.database.get<GenshinBindChallenge>('genshin_bind_challenge', { id });
    return row ?? null;
  }

  async findLoginSucceededChallenge(ownerKey: string): Promise<GenshinBindChallenge | null> {
    const rows = await this.database.get<GenshinBindChallenge>('genshin_bind_challenge', {
      ownerKey,
      status: 'login_succeeded',
    });
    return rows.sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  }

  async claimChallengeForVerification(id: number, verifyAttemptId: string, now: number): Promise<GenshinBindChallenge | null> {
    await this.database.set('genshin_bind_challenge', { id, status: 'created' }, {
      status: 'verifying',
      verifyAttemptId,
      errorMessage: null,
      updatedAt: now,
    });
    const row = await this.findChallengeById(id);
    return row?.status === 'verifying' && row.verifyAttemptId === verifyAttemptId ? row : null;
  }

  async releaseChallengeVerification(id: number, verifyAttemptId: string, reason: string, now: number): Promise<void> {
    await this.database.set('genshin_bind_challenge', { id, status: 'verifying', verifyAttemptId }, {
      status: 'created',
      verifyAttemptId: null,
      pendingCredentialCipher: null,
      pendingCredentialMeta: null,
      pendingRolesJson: null,
      selectedRoleJson: null,
      confirmCodeHash: null,
      errorMessage: reason,
      updatedAt: now,
    });
  }

  async completeChallengeVerification(id: number, verifyAttemptId: string, patch: Partial<GenshinBindChallenge>): Promise<GenshinBindChallenge | null> {
    await this.database.set('genshin_bind_challenge', { id, status: 'verifying', verifyAttemptId }, patch as Record<string, unknown>);
    return this.findChallengeById(id);
  }

  async completeRoleSelection(id: number, patch: Partial<GenshinBindChallenge>): Promise<GenshinBindChallenge | null> {
    await this.database.set('genshin_bind_challenge', { id, status: 'role_selecting' }, patch as Record<string, unknown>);
    return this.findChallengeById(id);
  }

  async clearChallengeSecrets(id: number, status: GenshinBindChallengeStatus, now: number): Promise<void> {
    await this.database.set('genshin_bind_challenge', { id }, clearedChallengePatch(status, now));
  }

  async clearOwnerChallengeSecrets(ownerKey: string, now: number): Promise<void> {
    await this.database.set('genshin_bind_challenge', { ownerKey }, {
      verifyAttemptId: null,
      confirmCodeHash: null,
      pendingCredentialCipher: null,
      pendingCredentialMeta: null,
      pendingRolesJson: null,
      selectedRoleJson: null,
      errorMessage: null,
      updatedAt: now,
    });
  }

  async upsertCredentialPlaceholder(identity: OwnerIdentity, role: GenshinGameRole, kekId: string, now: number): Promise<GenshinCredential> {
    const [existing] = await this.database.get<GenshinCredential>('genshin_credential', { ownerKey: identity.ownerKey });
    if (existing) {
      return {
        ...existing,
        platform: identity.platform,
        qqUserId: identity.qqUserId,
        serviceId: GENSHIN_SERVICE_ID,
        uid: role.uid,
        region: role.region,
        regionName: role.regionName,
        nickname: role.nickname,
        level: role.level,
        gameBiz: role.gameBiz,
        kekId,
        alg: 'aes-256-gcm',
        version: existing.version + 1,
        updatedAt: now,
        lastUsedAt: null,
        lastFailureReason: null,
        revokedAt: null,
      };
    }
    return this.database.create<GenshinCredential>('genshin_credential', {
      ownerKey: identity.ownerKey,
      platform: identity.platform,
      qqUserId: identity.qqUserId,
      serviceId: GENSHIN_SERVICE_ID,
      uid: role.uid,
      region: role.region,
      regionName: role.regionName,
      nickname: role.nickname,
      level: role.level,
      gameBiz: role.gameBiz,
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

  async updateCredentialEnvelope(row: GenshinCredential, credentialCipher: string, credentialMeta: string, now: number): Promise<void> {
    await this.database.set('genshin_credential', { id: row.id }, {
      ownerKey: row.ownerKey,
      platform: row.platform,
      qqUserId: row.qqUserId,
      serviceId: row.serviceId,
      uid: row.uid,
      region: row.region,
      regionName: row.regionName,
      nickname: row.nickname,
      level: row.level ?? null,
      gameBiz: row.gameBiz,
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

  async getActiveCredential(ownerKey: string): Promise<GenshinCredential | null> {
    const rows = await this.database.get<GenshinCredential>('genshin_credential', {
      ownerKey,
      serviceId: GENSHIN_SERVICE_ID,
      revokedAt: null,
    });
    return rows.sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  }

  async listActiveCredentials(): Promise<GenshinCredential[]> {
    const rows = await this.database.get<GenshinCredential>('genshin_credential', {
      serviceId: GENSHIN_SERVICE_ID,
      revokedAt: null,
    });
    return rows.sort((left, right) => left.updatedAt - right.updatedAt);
  }

  async markCredentialUsed(id: number, now: number): Promise<void> {
    await this.database.set('genshin_credential', { id }, {
      lastUsedAt: now,
      lastFailureReason: null,
      updatedAt: now,
    });
  }

  async markCredentialFailure(id: number, reason: string, now: number): Promise<void> {
    await this.database.set('genshin_credential', { id }, {
      lastFailureReason: reason,
      updatedAt: now,
    });
  }

  async revokeCredential(ownerKey: string, now: number): Promise<void> {
    await this.database.set('genshin_credential', {
      ownerKey,
      serviceId: GENSHIN_SERVICE_ID,
      revokedAt: null,
    }, {
      credentialCipher: '',
      credentialMeta: '',
      revokedAt: now,
      updatedAt: now,
    });
  }

  async findSuccessfulSignIn(ownerKey: string, uid: string, signDate: string): Promise<GenshinSignInRecord | null> {
    const rows = await this.database.get<GenshinSignInRecord>('genshin_signin_record', {
      ownerKey,
      uid,
      signDate,
    });
    return rows.find((row) => row.status === 'ok' || row.status === 'already_done') ?? null;
  }

  async recordSignIn(row: Omit<GenshinSignInRecord, 'id'>): Promise<void> {
    await this.database.create('genshin_signin_record', row);
  }

  async recordRedeem(row: Omit<GenshinRedeemRecord, 'id'>): Promise<void> {
    await this.database.create('genshin_redeem_record', row);
  }

  async audit(row: Omit<GenshinAuthAudit, 'id'>): Promise<void> {
    await this.database.create('genshin_auth_audit', row);
  }
}

function clearedChallengePatch(status: GenshinBindChallengeStatus, now: number): Record<string, unknown> {
  return {
    status,
    verifyAttemptId: null,
    confirmCodeHash: null,
    pendingCredentialCipher: null,
    pendingCredentialMeta: null,
    pendingRolesJson: null,
    selectedRoleJson: null,
    errorMessage: null,
    updatedAt: now,
  };
}

export function signInRecordRow(args: {
  ownerKey: string;
  role: GenshinGameRole;
  signDate: string;
  trigger: GenshinSignInTrigger;
  status: GenshinOperationStatus;
  retcode: number;
  message: string;
  createdAt: number;
}): Omit<GenshinSignInRecord, 'id'> {
  return {
    ownerKey: args.ownerKey,
    uid: args.role.uid,
    region: args.role.region,
    signDate: args.signDate,
    trigger: args.trigger,
    status: args.status,
    retcode: args.retcode,
    message: args.message,
    createdAt: args.createdAt,
  };
}
