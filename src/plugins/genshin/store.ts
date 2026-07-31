import type { Context } from 'koishi';
import type {
  DatabaseLike,
  GenshinAuthAudit,
  GenshinBindChallenge,
  GenshinBindChallengeStatus,
  GenshinCredential,
  GenshinGachaRecord,
  GenshinGachaSyncState,
  GenshinGachaType,
  GenshinGameRole,
  GenshinOperationStatus,
  GenshinSignInRecord,
  GenshinSignInTrigger,
  GenshinStatusVerification,
  OwnerIdentity,
} from './types.js';
import { GENSHIN_SERVICE_ID } from './types.js';

const ACTIVE_CHALLENGE_STATUSES: GenshinBindChallengeStatus[] = ['created', 'qr_pending', 'qr_scanned', 'verifying', 'role_selecting', 'login_succeeded'];

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
      qrTicket: { type: 'string', nullable: true },
      qrUrl: { type: 'text', nullable: true },
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
    'genshin_status_verification',
    {
      id: 'unsigned',
      tokenHash: 'string',
      ownerKey: 'string',
      status: 'string',
      gt: 'string',
      challenge: 'string',
      challengePath: 'string',
      verifiedChallenge: { type: 'string', nullable: true },
      consumeAttemptId: { type: 'string', nullable: true },
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
    'genshin_gacha_record',
    {
      id: 'unsigned',
      recordKey: 'string',
      ownerKey: 'string',
      uid: 'string',
      region: 'string',
      gachaType: 'string',
      uigfGachaType: 'string',
      recordId: 'string',
      itemId: 'string',
      name: 'string',
      itemType: 'string',
      rankType: 'string',
      count: 'string',
      time: 'string',
      createdAt: 'double',
    },
    {
      autoInc: true,
      unique: ['recordKey'],
      indexes: [['ownerKey', 'uid', 'region'], ['uid', 'region', 'gachaType'], ['time'], ['recordId']],
    },
  );

  ctx.model.extend(
    'genshin_gacha_sync_state',
    {
      id: 'unsigned',
      syncKey: 'string',
      ownerKey: 'string',
      uid: 'string',
      region: 'string',
      gachaType: 'string',
      lastSyncedAt: 'double',
      lastFetchedRecordId: 'string',
      lastNewCount: 'integer',
      updatedAt: 'double',
    },
    {
      autoInc: true,
      unique: ['syncKey'],
      indexes: [['ownerKey', 'uid', 'region'], ['uid', 'region', 'gachaType'], ['updatedAt']],
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

  async cleanupExpiredStatusVerifications(now: number): Promise<void> {
    await this.database.set('genshin_status_verification', {
      status: { $in: ['pending', 'verified'] },
      expiresAt: { $lte: now },
    }, clearedStatusVerificationPatch('expired', now));
  }

  async cancelActiveStatusVerifications(ownerKey: string, now: number): Promise<void> {
    await this.database.set('genshin_status_verification', {
      ownerKey,
      status: { $in: ['pending', 'verified'] },
    }, clearedStatusVerificationPatch('expired', now));
  }

  async createStatusVerification(args: {
    tokenHash: string;
    ownerKey: string;
    gt: string;
    challenge: string;
    challengePath: string;
    expiresAt: number;
    now: number;
  }): Promise<GenshinStatusVerification> {
    return this.database.create<GenshinStatusVerification>('genshin_status_verification', {
      tokenHash: args.tokenHash,
      ownerKey: args.ownerKey,
      status: 'pending',
      gt: args.gt,
      challenge: args.challenge,
      challengePath: args.challengePath,
      verifiedChallenge: null,
      consumeAttemptId: null,
      expiresAt: args.expiresAt,
      createdAt: args.now,
      updatedAt: args.now,
    });
  }

  async findStatusVerificationByTokenHash(tokenHash: string): Promise<GenshinStatusVerification | null> {
    const [row] = await this.database.get<GenshinStatusVerification>('genshin_status_verification', { tokenHash });
    return row ?? null;
  }

  async markStatusVerificationVerified(id: number, verifiedChallenge: string, now: number): Promise<GenshinStatusVerification | null> {
    await this.database.set('genshin_status_verification', { id, status: 'pending' }, {
      status: 'verified',
      gt: '',
      challenge: '',
      verifiedChallenge,
      consumeAttemptId: null,
      updatedAt: now,
    });
    const [row] = await this.database.get<GenshinStatusVerification>('genshin_status_verification', { id });
    return row?.status === 'verified' && row.verifiedChallenge === verifiedChallenge ? row : null;
  }

  async claimVerifiedStatusChallenge(
    ownerKey: string,
    consumeAttemptId: string,
    now: number,
  ): Promise<GenshinStatusVerification | null> {
    const rows = await this.database.get<GenshinStatusVerification>('genshin_status_verification', {
      ownerKey,
      status: 'verified',
    });
    const row = rows
      .filter((candidate) => candidate.expiresAt > now && Boolean(candidate.verifiedChallenge))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (!row) return null;
    const verifiedChallenge = row.verifiedChallenge as string;
    await this.database.set('genshin_status_verification', { id: row.id, status: 'verified' }, {
      status: 'consumed',
      verifiedChallenge: null,
      consumeAttemptId,
      updatedAt: now,
    });
    const [claimed] = await this.database.get<GenshinStatusVerification>('genshin_status_verification', { id: row.id });
    return claimed?.status === 'consumed' && claimed.consumeAttemptId === consumeAttemptId
      ? { ...claimed, verifiedChallenge }
      : null;
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
      qrTicket: null,
      qrUrl: null,
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

  async setChallengeQrTicket(id: number, ticket: string, url: string, now: number): Promise<GenshinBindChallenge | null> {
    await this.database.set('genshin_bind_challenge', { id, status: 'created' }, {
      status: 'qr_pending',
      qrTicket: ticket,
      qrUrl: url,
      errorMessage: null,
      updatedAt: now,
    });
    return this.findChallengeById(id);
  }

  async markChallengeQrScanned(id: number, now: number): Promise<void> {
    await this.database.set('genshin_bind_challenge', { id, status: 'qr_pending' }, {
      status: 'qr_scanned',
      errorMessage: null,
      updatedAt: now,
    });
  }

  async claimQrChallengeForVerification(id: number, verifyAttemptId: string, now: number): Promise<GenshinBindChallenge | null> {
    await this.database.set('genshin_bind_challenge', { id, status: { $in: ['qr_pending', 'qr_scanned'] } }, {
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
      qrTicket: null,
      qrUrl: null,
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
      qrTicket: null,
      qrUrl: null,
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

  async refreshActiveCredentialEnvelope(
    row: GenshinCredential,
    credentialCipher: string,
    credentialMeta: string,
    now: number,
  ): Promise<boolean> {
    await this.database.set('genshin_credential', {
      id: row.id,
      ownerKey: row.ownerKey,
      version: row.version,
      credentialCipher: row.credentialCipher,
      credentialMeta: row.credentialMeta,
      revokedAt: null,
    }, {
      credentialCipher,
      credentialMeta,
      updatedAt: now,
    });
    const [updated] = await this.database.get<GenshinCredential>('genshin_credential', { id: row.id });
    return Boolean(
      updated
      && updated.ownerKey === row.ownerKey
      && updated.version === row.version
      && updated.credentialCipher === credentialCipher
      && updated.credentialMeta === credentialMeta
      && updated.revokedAt == null
    );
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

  async findGachaRecord(recordKey: string): Promise<GenshinGachaRecord | null> {
    const [row] = await this.database.get<GenshinGachaRecord>('genshin_gacha_record', { recordKey });
    return row ?? null;
  }

  async createGachaRecord(row: Omit<GenshinGachaRecord, 'id'>): Promise<void> {
    await this.database.create('genshin_gacha_record', row as unknown as Record<string, unknown>);
  }

  async listGachaRecords(uid: string, region: string): Promise<GenshinGachaRecord[]> {
    return this.database.get<GenshinGachaRecord>('genshin_gacha_record', {
      uid,
      region,
    });
  }

  async upsertGachaSyncState(row: Omit<GenshinGachaSyncState, 'id'>): Promise<void> {
    const [existing] = await this.database.get<GenshinGachaSyncState>('genshin_gacha_sync_state', { syncKey: row.syncKey });
    if (existing) {
      await this.database.set('genshin_gacha_sync_state', { id: existing.id }, row as unknown as Record<string, unknown>);
      return;
    }
    await this.database.create('genshin_gacha_sync_state', row as unknown as Record<string, unknown>);
  }

  async listGachaSyncStates(ownerKey: string, uid: string, region: string): Promise<GenshinGachaSyncState[]> {
    return this.database.get<GenshinGachaSyncState>('genshin_gacha_sync_state', {
      ownerKey,
      uid,
      region,
    });
  }

  async audit(row: Omit<GenshinAuthAudit, 'id'>): Promise<void> {
    await this.database.create('genshin_auth_audit', row);
  }
}

export function gachaRecordKey(uid: string, region: string, recordId: string): string {
  return `${uid}:${region}:${recordId}`;
}

export function gachaSyncKey(ownerKey: string, uid: string, region: string, gachaType: GenshinGachaType): string {
  return `${ownerKey}:${uid}:${region}:${gachaType}`;
}

function clearedChallengePatch(status: GenshinBindChallengeStatus, now: number): Record<string, unknown> {
  return {
    status,
    verifyAttemptId: null,
    qrTicket: null,
    qrUrl: null,
    confirmCodeHash: null,
    pendingCredentialCipher: null,
    pendingCredentialMeta: null,
    pendingRolesJson: null,
    selectedRoleJson: null,
    errorMessage: null,
    updatedAt: now,
  };
}

function clearedStatusVerificationPatch(status: 'expired' | 'consumed', now: number): Record<string, unknown> {
  return {
    status,
    gt: '',
    challenge: '',
    verifiedChallenge: null,
    consumeAttemptId: null,
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
