import type { Context } from 'koishi';
import { createRandomToken } from '../shared/credential-crypto.js';
import type { CampusAuthDatabase, CampusOwnerIdentity } from '../campus-auth-core/index.js';
import type { SecondClassReauthChallenge } from './types.js';

export const SECOND_CLASS_REAUTH_TTL_MS = 5 * 60_000;

export function ensureSecondClassReauthTable(ctx: Context): void {
  ctx.model.extend('hbu_second_class_reauth', {
    id: 'unsigned',
    ownerKey: 'string',
    platform: 'string',
    qqUserId: 'string',
    channelId: 'string',
    credentialId: 'unsigned',
    captchaUuid: 'string',
    status: 'string',
    attemptId: { type: 'string', nullable: true },
    expiresAt: 'double',
    createdAt: 'double',
    updatedAt: 'double',
  }, {
    autoInc: true,
    unique: ['ownerKey'],
    indexes: [['status', 'expiresAt'], ['credentialId']],
  });
}

export class SecondClassReauthStore {
  constructor(
    private readonly database: CampusAuthDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async replace(identity: CampusOwnerIdentity, credentialId: number, captchaUuid: string): Promise<SecondClassReauthChallenge> {
    const now = this.now();
    const expiresAt = now + SECOND_CLASS_REAUTH_TTL_MS;
    const existing = await this.get(identity.ownerKey);
    if (existing) {
      await this.database.set('hbu_second_class_reauth', { id: existing.id }, {
        platform: identity.platform,
        qqUserId: identity.qqUserId,
        channelId: identity.channelId,
        credentialId,
        captchaUuid,
        status: 'waiting',
        attemptId: null,
        expiresAt,
        updatedAt: now,
      });
      const updated = await this.get(identity.ownerKey);
      if (!updated) throw new Error('second-class reauth challenge disappeared during replacement.');
      return updated;
    }
    return this.database.create<SecondClassReauthChallenge>('hbu_second_class_reauth', {
      ownerKey: identity.ownerKey,
      platform: identity.platform,
      qqUserId: identity.qqUserId,
      channelId: identity.channelId,
      credentialId,
      captchaUuid,
      status: 'waiting',
      attemptId: null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
  }

  async claim(identity: CampusOwnerIdentity): Promise<SecondClassReauthChallenge | null> {
    const row = await this.get(identity.ownerKey);
    if (!row || row.status !== 'waiting') return null;
    if (row.expiresAt <= this.now()) {
      await this.clearOwner(identity.ownerKey);
      return null;
    }
    if (row.channelId !== identity.channelId) return null;
    const attemptId = createRandomToken(16);
    const now = this.now();
    await this.database.set('hbu_second_class_reauth', { id: row.id, status: 'waiting' }, {
      status: 'verifying',
      attemptId,
      updatedAt: now,
    });
    const claimed = await this.get(identity.ownerKey);
    return claimed?.status === 'verifying' && claimed.attemptId === attemptId ? claimed : null;
  }

  async getWaiting(ownerKey: string): Promise<SecondClassReauthChallenge | null> {
    const row = await this.get(ownerKey);
    if (!row || row.status !== 'waiting') return null;
    if (row.expiresAt <= this.now()) {
      await this.clearOwner(ownerKey);
      return null;
    }
    return row;
  }

  clearOwner(ownerKey: string): Promise<unknown> {
    return this.database.remove('hbu_second_class_reauth', { ownerKey });
  }

  private async get(ownerKey: string): Promise<SecondClassReauthChallenge | null> {
    const [row] = await this.database.get<SecondClassReauthChallenge>('hbu_second_class_reauth', { ownerKey });
    return row ?? null;
  }
}
