import { Logger } from 'koishi';
import {
  constantTimeEqualHex,
  createConfirmCode,
  createRandomToken,
  decryptEnvelopeJson,
  encryptEnvelopeJson,
  sha256Hex,
  type CredentialKek,
} from '../shared/credential-crypto.js';
import { assertGenshinRedeemCookieCapability, parseGenshinCookieInput } from './cookie.js';
import { GenshinStore, signInRecordRow } from './store.js';
import { GenshinTakumiError, type GenshinSignResult, type GenshinTakumiClient } from './takumi-client.js';
import {
  GENSHIN_SERVICE_ID,
  type GenshinBindChallenge,
  type GenshinCredential,
  type GenshinCredentialPayload,
  type GenshinGameRole,
  type GenshinOperationStatus,
  type GenshinSignInTrigger,
  GenshinUserError,
  type OwnerIdentity,
} from './types.js';

const logger = new Logger('genshin');

export interface GenshinRuntimeConfig {
  bindPagePath: string;
  publicBaseUrl: string;
  bindTokenTtlMs: number;
  timezone: string;
}

export interface StartBindingResult {
  link: string;
  expiresAt: number;
}

export interface BindPageChallenge {
  token: string;
  qqUserId: string;
}

export type SubmitCookieResult =
  | { kind: 'role_selection'; qqUserId: string; roles: GenshinGameRole[] }
  | { kind: 'success'; qqUserId: string; confirmCode: string; role: GenshinGameRole };

export interface SignInReply {
  role: GenshinGameRole;
  status: GenshinOperationStatus;
  message: string;
  totalSignDay: number | null;
}

export interface RedeemReply {
  role: GenshinGameRole;
  status: GenshinOperationStatus;
  message: string;
}

export class GenshinService {
  constructor(
    private readonly store: GenshinStore,
    private readonly client: GenshinTakumiClient,
    private readonly kek: CredentialKek,
    private readonly config: GenshinRuntimeConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async startBinding(identity: OwnerIdentity): Promise<StartBindingResult> {
    const now = this.now();
    await this.store.cleanupExpiredChallenges(now);
    await this.store.cancelActiveChallenges(identity.ownerKey, now);
    const token = createRandomToken();
    const tokenHash = sha256Hex(token);
    const expiresAt = now + this.config.bindTokenTtlMs;
    await this.store.createChallenge(identity, tokenHash, expiresAt, now);
    await this.audit(identity.ownerKey, 'bind_started', 'ok');
    return {
      link: `${this.config.publicBaseUrl}${this.config.bindPagePath}?token=${encodeURIComponent(token)}`,
      expiresAt,
    };
  }

  async resolveBindPageChallenge(token: string): Promise<BindPageChallenge> {
    const challenge = await this.requireUsableChallenge(token);
    return {
      token,
      qqUserId: challenge.qqUserId,
    };
  }

  async submitCookie(args: { token: string; cookieText?: string; selectedRoleKey?: string }): Promise<SubmitCookieResult> {
    const challenge = await this.requireUsableChallenge(args.token);
    if (challenge.status === 'role_selecting') {
      return this.completeRoleSelection(challenge, args.selectedRoleKey ?? '');
    }
    if (challenge.status !== 'created') {
      throw new GenshinUserError('该绑定链接已经提交过 Cookie，请重新发送“原神绑定”生成新链接。');
    }

    const cookies = parseGenshinCookieInput(args.cookieText ?? '');
    const now = this.now();
    const verifyAttemptId = createRandomToken(16);
    const claimedChallenge = await this.store.claimChallengeForVerification(challenge.id, verifyAttemptId, now);
    if (!claimedChallenge) {
      throw new GenshinUserError('该绑定链接已经提交过 Cookie，请重新发送“原神绑定”生成新链接。');
    }

    try {
      const roles = await this.client.listRoles(cookies);
      if (roles.length === 0) {
        throw new GenshinUserError('该米游社账号没有可绑定的国服原神 UID。');
      }

      const encrypted = encryptEnvelopeJson(
        { cookies } satisfies GenshinCredentialPayload,
        pendingCredentialAad(claimedChallenge),
        this.kek,
      );
      const selectedRole = args.selectedRoleKey ? findRoleByKey(roles, args.selectedRoleKey) : roles.length === 1 ? roles[0] : null;
      if (!selectedRole) {
        const updated = await this.store.completeChallengeVerification(claimedChallenge.id, verifyAttemptId, {
          status: 'role_selecting',
          verifyAttemptId: null,
          pendingCredentialCipher: encrypted.cipherText,
          pendingCredentialMeta: encrypted.meta,
          pendingRolesJson: JSON.stringify(roles),
          selectedRoleJson: null,
          confirmCodeHash: null,
          errorMessage: null,
          updatedAt: now,
        });
        if (!updated || updated.status !== 'role_selecting') {
          throw new GenshinUserError('该绑定链接状态已变化，请重新发送“原神绑定”。');
        }
        await this.audit(claimedChallenge.ownerKey, 'roles_loaded', 'ok');
        return {
          kind: 'role_selection',
          qqUserId: claimedChallenge.qqUserId,
          roles,
        };
      }

      const confirmCode = createConfirmCode();
      const updated = await this.store.completeChallengeVerification(claimedChallenge.id, verifyAttemptId, {
        status: 'login_succeeded',
        verifyAttemptId: null,
        pendingCredentialCipher: encrypted.cipherText,
        pendingCredentialMeta: encrypted.meta,
        pendingRolesJson: null,
        selectedRoleJson: JSON.stringify(selectedRole),
        confirmCodeHash: hashConfirmCode(claimedChallenge, confirmCode),
        errorMessage: null,
        updatedAt: now,
      });
      if (!updated || updated.status !== 'login_succeeded') {
        throw new GenshinUserError('该绑定链接状态已变化，请重新发送“原神绑定”。');
      }
      await this.audit(claimedChallenge.ownerKey, 'cookie_verified', 'ok');
      return {
        kind: 'success',
        qqUserId: claimedChallenge.qqUserId,
        confirmCode,
        role: selectedRole,
      };
    } catch (error) {
      const reason = formatFailureReason(error);
      await this.store.releaseChallengeVerification(claimedChallenge.id, verifyAttemptId, reason, now);
      await this.audit(claimedChallenge.ownerKey, 'cookie_verification_failed', 'failed', reason);
      logger.warn('genshin cookie verification failed: owner=%s reason=%s', claimedChallenge.ownerKey, reason);
      if (error instanceof GenshinUserError) throw error;
      if (error instanceof GenshinTakumiError) throw new GenshinUserError(error.message);
      throw new GenshinUserError('原神绑定验证失败，请稍后重试。');
    }
  }

  async confirmBinding(identity: OwnerIdentity, confirmCode: string): Promise<GenshinGameRole> {
    const now = this.now();
    await this.store.cleanupExpiredChallenges(now);
    const challenge = await this.store.findLoginSucceededChallenge(identity.ownerKey);
    if (!challenge) {
      throw new GenshinUserError('没有待确认的原神绑定流程。');
    }
    if (challenge.expiresAt <= now) {
      await this.store.clearChallengeSecrets(challenge.id, 'expired', now);
      throw new GenshinUserError('原神绑定确认码已过期，请重新发送“原神绑定”。');
    }
    if (challenge.channelId !== identity.channelId) {
      throw new GenshinUserError('请回到发起绑定的聊天发送确认码。');
    }
    if (!challenge.confirmCodeHash || !constantTimeEqualHex(challenge.confirmCodeHash, hashConfirmCode(challenge, confirmCode.trim()))) {
      throw new GenshinUserError('原神确认码不正确。');
    }
    if (!challenge.pendingCredentialCipher || !challenge.pendingCredentialMeta || !challenge.selectedRoleJson) {
      throw new Error('genshin login_succeeded challenge is missing pending encrypted state.');
    }

    const credentialPayload = decryptEnvelopeJson<GenshinCredentialPayload>(
      challenge.pendingCredentialCipher,
      challenge.pendingCredentialMeta,
      pendingCredentialAad(challenge),
      this.kek,
    );
    const role = parseRoleJson(challenge.selectedRoleJson);
    const credentialRow = await this.store.upsertCredentialPlaceholder(identity, role, this.kek.id, now);
    const credential = encryptEnvelopeJson(
      credentialPayload,
      credentialAad(identity.ownerKey, credentialRow.id),
      this.kek,
    );
    await this.store.updateCredentialEnvelope(credentialRow, credential.cipherText, credential.meta, now);
    await this.store.clearChallengeSecrets(challenge.id, 'confirmed', now);
    await this.audit(identity.ownerKey, 'bind_confirmed', 'ok');
    return role;
  }

  async unbind(identity: OwnerIdentity): Promise<void> {
    const now = this.now();
    await this.store.revokeCredential(identity.ownerKey, now);
    await this.store.cancelActiveChallenges(identity.ownerKey, now);
    await this.store.clearOwnerChallengeSecrets(identity.ownerKey, now);
    await this.audit(identity.ownerKey, 'unbind', 'ok');
  }

  async manualSignIn(identity: OwnerIdentity): Promise<SignInReply> {
    const credential = await this.requireActiveCredential(identity.ownerKey);
    return this.signInCredential(credential, 'manual');
  }

  async redeemCode(identity: OwnerIdentity, cdkeyInput: string): Promise<RedeemReply> {
    const cdkey = normalizeCdkey(cdkeyInput);
    const credential = await this.requireActiveCredential(identity.ownerKey);
    const { payload, role } = this.decryptCredential(credential);
    const now = this.now();
    try {
      assertGenshinRedeemCookieCapability(payload.cookies);
      const result = await this.client.redeemCode(payload.cookies, role, cdkey);
      await this.store.markCredentialUsed(credential.id, now);
      await this.store.recordRedeem({
        ownerKey: credential.ownerKey,
        uid: role.uid,
        region: role.region,
        cdkeyHash: sha256Hex(cdkey),
        status: 'ok',
        retcode: result.retcode,
        message: result.message,
        createdAt: now,
      });
      await this.audit(credential.ownerKey, 'redeem_succeeded', 'ok');
      return {
        role,
        status: 'ok',
        message: result.message || '兑换码领取完成。',
      };
    } catch (error) {
      const result = redeemFailure(error);
      await this.store.markCredentialFailure(credential.id, result.message, now);
      await this.store.recordRedeem({
        ownerKey: credential.ownerKey,
        uid: role.uid,
        region: role.region,
        cdkeyHash: sha256Hex(cdkey),
        status: 'failed',
        retcode: result.retcode,
        message: result.message,
        createdAt: now,
      });
      await this.audit(credential.ownerKey, 'redeem_failed', 'failed', result.message);
      throw new GenshinUserError(result.message);
    }
  }

  async runAutoSignIn(): Promise<void> {
    const now = this.now();
    const signDate = formatDateInTimeZone(now, this.config.timezone);
    const credentials = await this.store.listActiveCredentials();
    for (const credential of credentials) {
      try {
        const existing = await this.store.findSuccessfulSignIn(credential.ownerKey, credential.uid, signDate);
        if (existing) continue;
        await this.signInCredential(credential, 'auto', signDate);
      } catch (error) {
        logger.warn('genshin auto sign failed: owner=%s uid=%s reason=%s', credential.ownerKey, credential.uid, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async completeRoleSelection(challenge: GenshinBindChallenge, selectedRoleKey: string): Promise<SubmitCookieResult> {
    if (!challenge.pendingCredentialCipher || !challenge.pendingCredentialMeta || !challenge.pendingRolesJson) {
      throw new Error('genshin role_selecting challenge is missing pending state.');
    }
    const roles = parseRolesJson(challenge.pendingRolesJson);
    const selectedRole = findRoleByKey(roles, selectedRoleKey);
    if (!selectedRole) {
      throw new GenshinUserError('请选择要绑定的原神 UID。');
    }
    const now = this.now();
    const confirmCode = createConfirmCode();
    const updated = await this.store.completeRoleSelection(challenge.id, {
      status: 'login_succeeded',
      selectedRoleJson: JSON.stringify(selectedRole),
      pendingRolesJson: null,
      confirmCodeHash: hashConfirmCode(challenge, confirmCode),
      errorMessage: null,
      updatedAt: now,
    });
    if (!updated || updated.status !== 'login_succeeded') {
      throw new GenshinUserError('该绑定链接状态已变化，请重新发送“原神绑定”。');
    }
    await this.audit(challenge.ownerKey, 'role_selected', 'ok');
    return {
      kind: 'success',
      qqUserId: challenge.qqUserId,
      confirmCode,
      role: selectedRole,
    };
  }

  private async signInCredential(credential: GenshinCredential, trigger: GenshinSignInTrigger, fixedSignDate?: string): Promise<SignInReply> {
    const { payload, role } = this.decryptCredential(credential);
    const now = this.now();
    const signDate = fixedSignDate ?? formatDateInTimeZone(now, this.config.timezone);
    try {
      const result = await this.client.signIn(payload.cookies, role);
      await this.store.markCredentialUsed(credential.id, now);
      await this.store.recordSignIn(signInRecordRow({
        ownerKey: credential.ownerKey,
        role,
        signDate,
        trigger,
        status: result.status,
        retcode: result.retcode,
        message: result.message,
        createdAt: now,
      }));
      await this.audit(credential.ownerKey, trigger === 'auto' ? 'auto_sign_succeeded' : 'manual_sign_succeeded', 'ok');
      return signInReply(role, result);
    } catch (error) {
      const result = signFailure(error);
      await this.store.markCredentialFailure(credential.id, result.message, now);
      await this.store.recordSignIn(signInRecordRow({
        ownerKey: credential.ownerKey,
        role,
        signDate,
        trigger,
        status: 'failed',
        retcode: result.retcode,
        message: result.message,
        createdAt: now,
      }));
      await this.audit(credential.ownerKey, trigger === 'auto' ? 'auto_sign_failed' : 'manual_sign_failed', 'failed', result.message);
      throw new GenshinUserError(result.message);
    }
  }

  private async requireUsableChallenge(token: string): Promise<GenshinBindChallenge> {
    const tokenHash = sha256Hex(token.trim());
    const challenge = await this.store.findChallengeByTokenHash(tokenHash);
    if (!challenge) {
      throw new GenshinUserError('绑定链接无效，请重新发送“原神绑定”。');
    }
    const now = this.now();
    if (challenge.expiresAt <= now) {
      await this.store.clearChallengeSecrets(challenge.id, 'expired', now);
      throw new GenshinUserError('绑定链接已过期，请重新发送“原神绑定”。');
    }
    if (challenge.status === 'cancelled' || challenge.status === 'expired' || challenge.status === 'confirmed') {
      throw new GenshinUserError('绑定链接已失效，请重新发送“原神绑定”。');
    }
    return challenge;
  }

  private async requireActiveCredential(ownerKey: string): Promise<GenshinCredential> {
    const credential = await this.store.getActiveCredential(ownerKey);
    if (!credential) {
      throw new GenshinUserError('请先发送“原神绑定”完成 UID 绑定。');
    }
    return credential;
  }

  private decryptCredential(credential: GenshinCredential): { payload: GenshinCredentialPayload; role: GenshinGameRole } {
    const payload = decryptEnvelopeJson<GenshinCredentialPayload>(
      credential.credentialCipher,
      credential.credentialMeta,
      credentialAad(credential.ownerKey, credential.id),
      this.kek,
    );
    return {
      payload,
      role: credentialRole(credential),
    };
  }

  private async audit(ownerKey: string, eventType: string, status: string, reason: string | null = null): Promise<void> {
    await this.store.audit({
      ownerKey,
      eventType,
      status,
      reason,
      createdAt: this.now(),
    });
  }
}

function hashConfirmCode(challenge: GenshinBindChallenge, confirmCode: string): string {
  return sha256Hex(`${challenge.id}:${challenge.ownerKey}:${confirmCode}`);
}

function pendingCredentialAad(challenge: GenshinBindChallenge): string {
  return `genshin:pending-credential:v1:${challenge.ownerKey}:${challenge.id}`;
}

function credentialAad(ownerKey: string, credentialId: number): string {
  return `genshin:credential:v1:${ownerKey}:${GENSHIN_SERVICE_ID}:${credentialId}`;
}

function roleKey(role: GenshinGameRole): string {
  return `${role.uid}:${role.region}`;
}

export function genshinRoleKey(role: GenshinGameRole): string {
  return roleKey(role);
}

function findRoleByKey(roles: GenshinGameRole[], key: string): GenshinGameRole | null {
  return roles.find((role) => roleKey(role) === key.trim()) ?? null;
}

function parseRoleJson(value: string): GenshinGameRole {
  const parsed = JSON.parse(value) as GenshinGameRole;
  if (!parsed.uid || !parsed.region) {
    throw new Error('genshin selected role json is invalid.');
  }
  return parsed;
}

function parseRolesJson(value: string): GenshinGameRole[] {
  const parsed = JSON.parse(value) as GenshinGameRole[];
  if (!Array.isArray(parsed)) {
    throw new Error('genshin pending roles json is invalid.');
  }
  return parsed;
}

function credentialRole(credential: GenshinCredential): GenshinGameRole {
  return {
    uid: credential.uid,
    region: credential.region,
    regionName: credential.regionName,
    nickname: credential.nickname,
    level: credential.level ?? null,
    gameBiz: 'hk4e_cn',
  };
}

function normalizeCdkey(input: string): string {
  const cdkey = input.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,32}$/.test(cdkey)) {
    throw new GenshinUserError('兑换码格式不正确，请发送：原神兑换 <兑换码>。');
  }
  return cdkey;
}

function signInReply(role: GenshinGameRole, result: GenshinSignResult): SignInReply {
  return {
    role,
    status: result.status,
    message: result.message,
    totalSignDay: result.totalSignDay,
  };
}

function signFailure(error: unknown): { retcode: number; message: string } {
  if (error instanceof GenshinTakumiError) {
    return {
      retcode: error.retcode ?? -1,
      message: error.message,
    };
  }
  if (error instanceof GenshinUserError) {
    return {
      retcode: -1,
      message: error.message,
    };
  }
  return {
    retcode: -1,
    message: '原神签到失败，请稍后重试。',
  };
}

function redeemFailure(error: unknown): { retcode: number; message: string } {
  if (error instanceof GenshinTakumiError) {
    return {
      retcode: error.retcode ?? -1,
      message: error.message,
    };
  }
  if (error instanceof GenshinUserError) {
    return {
      retcode: -1,
      message: error.message,
    };
  }
  return {
    retcode: -1,
    message: '原神兑换码领取失败，请稍后重试。',
  };
}

function formatFailureReason(error: unknown): string {
  if (error instanceof GenshinTakumiError) return clipDiagnostic(`${error.retcode ?? 'request_failed'}: ${error.message}; ${error.diagnostic}`);
  if (error instanceof GenshinUserError) return clipDiagnostic(error.message);
  if (error instanceof Error) return clipDiagnostic(`${error.name}: ${error.message}`);
  return clipDiagnostic(String(error));
}

function clipDiagnostic(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function formatDateInTimeZone(time: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(time));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
