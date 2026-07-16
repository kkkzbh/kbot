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
import { assertGenshinRedeemCookieCapability } from './cookie.js';
import { credentialAad, decryptGenshinCredential } from './credential.js';
import { GenshinStore, signInRecordRow } from './store.js';
import {
  GenshinDailyNoteVerificationRequiredError,
  GenshinTakumiError,
  type GenshinDailyNote,
  type GenshinDailyNoteVerification,
  type GenshinDailyNoteVerificationContext,
  type GenshinSignResult,
  type GenshinTakumiClient,
} from './takumi-client.js';
import {
  type GenshinBindChallenge,
  type GenshinCredential,
  type GenshinCredentialPayload,
  type GenshinGameRole,
  type GenshinQrLoginResult,
  type GenshinOperationStatus,
  type GenshinSignInTrigger,
  type GenshinStatusVerification,
  GenshinUserError,
  type OwnerIdentity,
} from './types.js';

const logger = new Logger('genshin');

export interface GenshinRuntimeConfig {
  bindPagePath: string;
  publicBaseUrl: string;
  bindTokenTtlMs: number;
  statusVerificationPath: string;
  timezone: string;
}

export interface StartBindingResult {
  link: string;
  expiresAt: number;
}

export interface BindPageChallenge {
  token: string;
  qqUserId: string;
  state: 'qr' | 'role_selection';
  qrUrl?: string;
  qrStatus?: 'qr_pending' | 'qr_scanned';
  roles?: GenshinGameRole[];
}

export type QrBindingStatusResult =
  | { kind: 'pending'; message: string }
  | { kind: 'scanned'; message: string }
  | { kind: 'role_selection'; roles: GenshinGameRole[] }
  | { kind: 'success'; confirmCode: string; role: GenshinGameRole };

export type SelectRoleResult =
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

export interface GenshinStatusReply {
  role: GenshinGameRole;
  note: GenshinDailyNote;
  queriedAt: number;
}

export interface GenshinStatusVerificationPage {
  token: string;
  gt: string;
  challenge: string;
}

export class GenshinStatusVerificationLinkError extends GenshinUserError {
  constructor(message: string) {
    super(message);
    this.name = 'GenshinStatusVerificationLinkError';
  }
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
    }
  }

  async resolveBindPageChallenge(token: string): Promise<BindPageChallenge> {
    const challenge = await this.requireUsableChallenge(token);
    if (challenge.status === 'created') {
      const qr = await this.client.createQrLogin();
      const updated = await this.store.setChallengeQrTicket(challenge.id, qr.ticket, qr.url, this.now());
      if (!updated || updated.status !== 'qr_pending' || !updated.qrUrl) {
        throw new GenshinUserError('原神扫码登录状态已变化，请重新发送“原神绑定”。');
      }
      await this.audit(challenge.ownerKey, 'qr_created', 'ok');
      return {
        token,
        qqUserId: updated.qqUserId,
        state: 'qr',
        qrUrl: updated.qrUrl,
        qrStatus: 'qr_pending',
      };
    }
    if (challenge.status === 'qr_pending' || challenge.status === 'qr_scanned') {
      if (!challenge.qrUrl || !challenge.qrTicket) {
        throw new Error('genshin qr challenge is missing qr state.');
      }
      return {
        token,
        qqUserId: challenge.qqUserId,
        state: 'qr',
        qrUrl: challenge.qrUrl,
        qrStatus: challenge.status,
      };
    }
    if (challenge.status === 'role_selecting') {
      if (!challenge.pendingRolesJson) {
        throw new Error('genshin role_selecting challenge is missing pending roles.');
      }
      return {
        token,
        qqUserId: challenge.qqUserId,
        state: 'role_selection',
        roles: parseRolesJson(challenge.pendingRolesJson),
      };
    }
    if (challenge.status === 'verifying') {
      throw new GenshinUserError('扫码确认正在处理，请稍后刷新页面。');
    }
    if (challenge.status === 'login_succeeded') {
      throw new GenshinUserError('确认码已生成，请使用页面显示的确认码；如果页面已关闭，请重新发送“原神绑定”。');
    }
    throw new GenshinUserError('绑定链接已失效，请重新发送“原神绑定”。');
  }

  async pollQrLogin(token: string): Promise<QrBindingStatusResult> {
    const challenge = await this.requireUsableChallenge(token);
    if (challenge.status === 'created') {
      await this.resolveBindPageChallenge(token);
      return { kind: 'pending', message: '请使用米游社 App 扫描二维码。' };
    }
    if (challenge.status === 'role_selecting') {
      if (!challenge.pendingRolesJson) {
        throw new Error('genshin role_selecting challenge is missing pending roles.');
      }
      return { kind: 'role_selection', roles: parseRolesJson(challenge.pendingRolesJson) };
    }
    if (challenge.status === 'login_succeeded') {
      throw new GenshinUserError('确认码已生成，请使用页面显示的确认码；如果页面已关闭，请重新发送“原神绑定”。');
    }
    if (challenge.status !== 'qr_pending' && challenge.status !== 'qr_scanned') {
      throw new GenshinUserError('当前绑定流程不能轮询扫码状态，请重新发送“原神绑定”。');
    }
    if (!challenge.qrTicket) {
      throw new Error('genshin qr challenge is missing ticket.');
    }

    const result = await this.client.queryQrLogin(challenge.qrTicket);
    if (result.status === 'Init') {
      return { kind: 'pending', message: '请使用米游社 App 扫描二维码。' };
    }
    if (result.status === 'Scanned') {
      if (challenge.status !== 'qr_scanned') {
        await this.store.markChallengeQrScanned(challenge.id, this.now());
        await this.audit(challenge.ownerKey, 'qr_scanned', 'ok');
      }
      return { kind: 'scanned', message: '已扫码，请在米游社 App 内确认登录。' };
    }
    if (result.status === 'Expired') {
      const now = this.now();
      await this.store.clearChallengeSecrets(challenge.id, 'expired', now);
      await this.audit(challenge.ownerKey, 'qr_expired', 'failed', 'qrcode expired');
      throw new GenshinUserError('二维码已过期，请重新发送“原神绑定”。');
    }
    return this.completeQrLogin(challenge, result);
  }

  async selectRole(args: { token: string; selectedRoleKey?: string }): Promise<SelectRoleResult> {
    const challenge = await this.requireUsableChallenge(args.token);
    if (challenge.status !== 'role_selecting') {
      throw new GenshinUserError('当前绑定流程不需要选择 UID。');
    }
    return this.completeRoleSelection(challenge, args.selectedRoleKey ?? '');
  }

  private async completeQrLogin(challenge: GenshinBindChallenge, result: GenshinQrLoginResult): Promise<QrBindingStatusResult> {
    if (!result.cookies) {
      throw new Error('confirmed genshin qr result is missing passport cookies.');
    }
    const now = this.now();
    const verifyAttemptId = createRandomToken(16);
    const claimedChallenge = await this.store.claimQrChallengeForVerification(challenge.id, verifyAttemptId, now);
    if (!claimedChallenge) {
      throw new GenshinUserError('该绑定链接状态已变化，请重新发送“原神绑定”。');
    }

    try {
      const cookies = await this.client.completeAccountTokens(result.cookies);
      const roles = await this.client.listRoles(cookies);
      if (roles.length === 0) {
        throw new GenshinUserError('该米游社账号没有可绑定的国服原神 UID。');
      }

      const encrypted = encryptEnvelopeJson(
        { cookies } satisfies GenshinCredentialPayload,
        pendingCredentialAad(claimedChallenge),
        this.kek,
      );
      const selectedRole = roles.length === 1 ? roles[0] : null;
      if (!selectedRole) {
        const updated = await this.store.completeChallengeVerification(claimedChallenge.id, verifyAttemptId, {
          status: 'role_selecting',
          verifyAttemptId: null,
          qrTicket: null,
          qrUrl: null,
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
        return { kind: 'role_selection', roles };
      }

      const confirmCode = createConfirmCode();
      const updated = await this.store.completeChallengeVerification(claimedChallenge.id, verifyAttemptId, {
        status: 'login_succeeded',
        verifyAttemptId: null,
        qrTicket: null,
        qrUrl: null,
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
      await this.audit(claimedChallenge.ownerKey, 'qr_login_verified', 'ok');
      return {
        kind: 'success',
        confirmCode,
        role: selectedRole,
      };
    } catch (error) {
      const reason = formatFailureReason(error);
      await this.store.releaseChallengeVerification(claimedChallenge.id, verifyAttemptId, reason, now);
      await this.audit(claimedChallenge.ownerKey, 'qr_login_verification_failed', 'failed', reason);
      logger.warn('genshin qr login verification failed: owner=%s reason=%s', claimedChallenge.ownerKey, reason);
      if (error instanceof GenshinUserError) throw error;
      if (error instanceof GenshinTakumiError) throw new GenshinUserError(error.message);
      throw new GenshinUserError('原神扫码绑定验证失败，请稍后重试。');
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
    await this.store.cancelActiveStatusVerifications(identity.ownerKey, now);
    await this.store.clearChallengeSecrets(challenge.id, 'confirmed', now);
    await this.audit(identity.ownerKey, 'bind_confirmed', 'ok');
    return role;
  }

  async unbind(identity: OwnerIdentity): Promise<void> {
    const now = this.now();
    await this.store.revokeCredential(identity.ownerKey, now);
    await this.store.cancelActiveChallenges(identity.ownerKey, now);
    await this.store.cancelActiveStatusVerifications(identity.ownerKey, now);
    await this.store.clearOwnerChallengeSecrets(identity.ownerKey, now);
    await this.audit(identity.ownerKey, 'unbind', 'ok');
  }

  async manualSignIn(identity: OwnerIdentity): Promise<SignInReply> {
    const credential = await this.requireActiveCredential(identity.ownerKey);
    return this.signInCredential(credential, 'manual');
  }

  async queryStatus(identity: OwnerIdentity): Promise<GenshinStatusReply> {
    const credential = await this.requireActiveCredential(identity.ownerKey);
    const now = this.now();
    try {
      const { payload, role } = await this.completeCredentialTokens(credential);
      const claimedVerification = await this.store.claimVerifiedStatusChallenge(
        credential.ownerKey,
        createRandomToken(16),
        now,
      );
      const verification = statusVerificationContext(claimedVerification);
      const note = await this.client.fetchDailyNote(payload.cookies, role, verification);
      await this.store.markCredentialUsed(credential.id, now);
      await this.audit(credential.ownerKey, 'status_queried', 'ok');
      return { role, note, queriedAt: now };
    } catch (error) {
      if (error instanceof GenshinDailyNoteVerificationRequiredError) {
        const link = await this.createStatusVerificationLink(credential.ownerKey, error.verification, now);
        const message = `米游社要求完成人机验证后才能读取实时便笺：\n${link}\n验证完成后，请重新发送“原神状态”。`;
        await this.store.markCredentialFailure(credential.id, '米游社实时便笺要求人机验证。', now);
        await this.audit(credential.ownerKey, 'status_verification_required', 'failed', formatFailureReason(error));
        throw new GenshinStatusVerificationLinkError(message);
      }
      const message = statusFailure(error);
      await this.store.markCredentialFailure(credential.id, message, now);
      await this.audit(credential.ownerKey, 'status_query_failed', 'failed', formatFailureReason(error));
      throw new GenshinUserError(message);
    }
  }

  async resolveStatusVerificationPage(token: string): Promise<GenshinStatusVerificationPage> {
    const verification = await this.requirePendingStatusVerification(token);
    return {
      token,
      gt: verification.gt,
      challenge: verification.challenge,
    };
  }

  async completeStatusVerification(token: string, validate: string): Promise<void> {
    const verification = await this.requirePendingStatusVerification(token);
    const credential = await this.requireActiveCredential(verification.ownerKey);
    try {
      const { payload } = await this.completeCredentialTokens(credential);
      const verifiedChallenge = await this.client.verifyDailyNoteChallenge(payload.cookies, {
        gt: verification.gt,
        challenge: verification.challenge,
        path: verification.challengePath,
      }, validate);
      const updated = await this.store.markStatusVerificationVerified(verification.id, verifiedChallenge, this.now());
      if (!updated) {
        throw new GenshinUserError('验证状态已变化，请回到 QQ 重新发送“原神状态”。');
      }
      await this.audit(verification.ownerKey, 'status_verification_completed', 'ok');
    } catch (error) {
      await this.audit(verification.ownerKey, 'status_verification_failed', 'failed', formatFailureReason(error));
      if (error instanceof GenshinTakumiError) {
        throw new GenshinUserError(error.message);
      }
      throw error;
    }
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

  private async completeRoleSelection(challenge: GenshinBindChallenge, selectedRoleKey: string): Promise<SelectRoleResult> {
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
    const confirmCodeHash = hashConfirmCode(challenge, confirmCode);
    const updated = await this.store.completeRoleSelection(challenge.id, {
      status: 'login_succeeded',
      selectedRoleJson: JSON.stringify(selectedRole),
      pendingRolesJson: null,
      confirmCodeHash,
      errorMessage: null,
      updatedAt: now,
    });
    if (!updated || updated.status !== 'login_succeeded' || updated.confirmCodeHash !== confirmCodeHash) {
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

  private async requirePendingStatusVerification(token: string): Promise<GenshinStatusVerification> {
    const normalizedToken = token.trim();
    if (!normalizedToken) {
      throw new GenshinUserError('实时便笺验证链接无效，请回到 QQ 重新发送“原神状态”。');
    }
    const verification = await this.store.findStatusVerificationByTokenHash(sha256Hex(normalizedToken));
    if (!verification) {
      throw new GenshinUserError('实时便笺验证链接无效，请回到 QQ 重新发送“原神状态”。');
    }
    const now = this.now();
    if (verification.expiresAt <= now) {
      await this.store.cleanupExpiredStatusVerifications(now);
      throw new GenshinUserError('实时便笺验证链接已过期，请回到 QQ 重新发送“原神状态”。');
    }
    if (verification.status !== 'pending') {
      throw new GenshinUserError('实时便笺验证链接已使用，请回到 QQ 重新发送“原神状态”。');
    }
    return verification;
  }

  private async createStatusVerificationLink(
    ownerKey: string,
    verification: GenshinDailyNoteVerification,
    now: number,
  ): Promise<string> {
    await this.store.cleanupExpiredStatusVerifications(now);
    await this.store.cancelActiveStatusVerifications(ownerKey, now);
    const token = createRandomToken();
    await this.store.createStatusVerification({
      tokenHash: sha256Hex(token),
      ownerKey,
      gt: verification.gt,
      challenge: verification.challenge,
      challengePath: verification.path,
      expiresAt: now + this.config.bindTokenTtlMs,
      now,
    });
    return `${this.config.publicBaseUrl}${this.config.statusVerificationPath}?token=${encodeURIComponent(token)}`;
  }

  private async completeCredentialTokens(
    credential: GenshinCredential,
  ): Promise<{ payload: GenshinCredentialPayload; role: GenshinGameRole }> {
    const decrypted = this.decryptCredential(credential);
    const cookies = await this.client.completeAccountTokens(decrypted.payload.cookies);
    if (cookies !== decrypted.payload.cookies) {
      const encrypted = encryptEnvelopeJson(
        { cookies } satisfies GenshinCredentialPayload,
        credentialAad(credential.ownerKey, credential.id),
        this.kek,
      );
      const updated = await this.store.refreshActiveCredentialEnvelope(
        credential,
        encrypted.cipherText,
        encrypted.meta,
        this.now(),
      );
      if (!updated) {
        throw new GenshinUserError('原神绑定状态已变化，请重新发送“原神状态”。');
      }
    }
    return {
      payload: { cookies },
      role: decrypted.role,
    };
  }

  private decryptCredential(credential: GenshinCredential): { payload: GenshinCredentialPayload; role: GenshinGameRole } {
    return decryptGenshinCredential(credential, this.kek);
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

function statusFailure(error: unknown): string {
  if (error instanceof GenshinTakumiError || error instanceof GenshinUserError) {
    return error.message;
  }
  return '原神状态查询失败，请稍后重试。';
}

function statusVerificationContext(
  verification: GenshinStatusVerification | null,
): GenshinDailyNoteVerificationContext | undefined {
  const challenge = String(verification?.verifiedChallenge ?? '').trim();
  if (!verification || !challenge) return undefined;
  return {
    challenge,
    path: verification.challengePath,
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
