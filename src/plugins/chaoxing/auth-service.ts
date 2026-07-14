import { createHash, randomBytes } from 'node:crypto';
import { Logger } from 'koishi';
import {
  constantTimeEqualHex,
  createConfirmCode,
  createRandomToken,
  sha256Hex,
} from '../shared/credential-crypto.js';
import type { ChaoxingClient } from './client.js';
import {
  credentialAad,
  decryptEnvelopeJson,
  decryptSelfContainedJson,
  encryptEnvelopeJson,
  encryptSelfContainedJson,
  pendingConfirmCodeAad,
  pendingCookieAad,
  pendingCredentialAad,
  sessionCookieAad,
  type ChaoxingKek,
} from './crypto.js';
import type { ChaoxingTaskStore } from './store.js';
import {
  ChaoxingAuthError,
  ChaoxingUserError,
  type ChaoxingBindChallenge,
  type ChaoxingCredentialPayload,
  type ChaoxingProfile,
  type OwnerIdentity,
  type SerializedChaoxingCookieJar,
} from './types.js';

const logger = new Logger('chaoxing');

export interface ChaoxingAuthRuntimeConfig {
  bindPagePath: string;
  publicBaseUrl: string;
  bindTokenTtlMs: number;
  autoReloginEnabled: boolean;
  sessionValidationTtlMs: number;
}

export interface ChaoxingAuthenticatedSession {
  ownerKey: string;
  cookieJar: SerializedChaoxingCookieJar;
  profile: ChaoxingProfile;
  credentialVersion: number;
}

export interface ChaoxingBindPageState {
  token: string;
  qqUserId: string;
  state: 'qr' | 'scanned' | 'pending' | 'success';
  imageDataUrl?: string;
  confirmCode?: string;
  errorMessage?: string | null;
}

export type ChaoxingQrStatus =
  | { kind: 'pending'; message: string }
  | { kind: 'scanned'; message: string }
  | { kind: 'success'; confirmCode: string };

interface ConfirmCodePayload {
  confirmCode: string;
}

export class ChaoxingAuthService {
  constructor(
    private readonly store: ChaoxingTaskStore,
    private readonly client: ChaoxingClient,
    private readonly kek: ChaoxingKek,
    private readonly config: ChaoxingAuthRuntimeConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async startBinding(identity: OwnerIdentity): Promise<{ link: string; expiresAt: number }> {
    const now = this.now();
    await this.store.cleanupExpiredChallenges(now);
    await this.store.cancelActiveChallenges(identity.ownerKey, now);
    const token = createRandomToken();
    const expiresAt = now + this.config.bindTokenTtlMs;
    await this.store.createChallenge(identity, sha256Hex(token), expiresAt, now);
    await this.audit(identity.ownerKey, 'bind_started', 'ok');
    return { link: `${this.config.publicBaseUrl}${this.config.bindPagePath}?token=${encodeURIComponent(token)}`, expiresAt };
  }

  async resolveBindPage(token: string): Promise<ChaoxingBindPageState> {
    let challenge = await this.requireUsableChallenge(token);
    if (challenge.status === 'created') {
      const qr = await this.client.createQrSession();
      const encryptedJar = encryptSelfContainedJson(qr.cookieJar, pendingCookieAad(challenge.ownerKey, challenge.id), this.kek);
      await this.store.setChallengeQr(challenge.id, qr.uuid, qr.enc, encryptedJar, this.now());
      await this.audit(challenge.ownerKey, 'qr_created', 'ok');
      return { token, qqUserId: challenge.qqUserId, state: 'qr', imageDataUrl: qr.imageDataUrl, errorMessage: challenge.errorMessage };
    }
    if (challenge.status === 'qr_pending' || challenge.status === 'qr_scanned') {
      const cookieJar = this.decryptPendingCookieJar(challenge);
      if (!challenge.qrUuid) throw new Error('chaoxing qr challenge is missing uuid.');
      const image = await this.client.getQrImage(cookieJar, challenge.qrUuid);
      const encryptedJar = encryptSelfContainedJson(image.cookieJar, pendingCookieAad(challenge.ownerKey, challenge.id), this.kek);
      await this.store.updateChallengeQrCookies(challenge.id, encryptedJar, this.now());
      return {
        token,
        qqUserId: challenge.qqUserId,
        state: challenge.status === 'qr_scanned' ? 'scanned' : 'qr',
        imageDataUrl: image.imageDataUrl,
        errorMessage: challenge.errorMessage,
      };
    }
    if (challenge.status === 'login_pending') return { token, qqUserId: challenge.qqUserId, state: 'pending' };
    if (challenge.status === 'login_succeeded') {
      return { token, qqUserId: challenge.qqUserId, state: 'success', confirmCode: this.decryptPendingConfirmCode(challenge) };
    }
    challenge = await this.requireUsableChallenge(token);
    throw new ChaoxingUserError(`当前绑定状态无法打开：${challenge.status}`);
  }

  async pollQrLogin(token: string): Promise<ChaoxingQrStatus> {
    let challenge = await this.requireUsableChallenge(token);
    if (challenge.status === 'created') {
      await this.resolveBindPage(token);
      return { kind: 'pending', message: '请使用学习通 App 扫描二维码。' };
    }
    if (challenge.status === 'login_succeeded') return { kind: 'success', confirmCode: this.decryptPendingConfirmCode(challenge) };
    if (challenge.status === 'login_pending') return { kind: 'pending', message: '学习通正在确认登录，请稍候。' };
    if (challenge.status !== 'qr_pending' && challenge.status !== 'qr_scanned') {
      throw new ChaoxingUserError('当前绑定流程不能轮询二维码，请重新发送“学习通绑定”。');
    }
    if (!challenge.qrUuid || !challenge.qrEnc) throw new Error('chaoxing qr challenge is missing qr fields.');
    const cookieJar = this.decryptPendingCookieJar(challenge);
    const result = await this.client.pollQrLogin(cookieJar, challenge.qrUuid, challenge.qrEnc);
    const encryptedJar = encryptSelfContainedJson(result.cookieJar, pendingCookieAad(challenge.ownerKey, challenge.id), this.kek);
    await this.store.updateChallengeQrCookies(challenge.id, encryptedJar, this.now());
    if (result.kind === 'pending') return { kind: 'pending', message: '请使用学习通 App 扫描二维码。' };
    if (result.kind === 'scanned') {
      if (challenge.status !== 'qr_scanned') {
        await this.store.markChallengeQrScanned(challenge.id, this.now());
        await this.audit(challenge.ownerKey, 'qr_scanned', 'ok');
      }
      return { kind: 'scanned', message: '已扫码，请在学习通 App 内确认登录。' };
    }
    if (result.kind === 'expired') {
      await this.store.resetChallengeQr(challenge.id, '二维码已过期，页面已生成新二维码。', this.now());
      throw new ChaoxingUserError('二维码已过期，请刷新绑定页面。');
    }
    challenge = await this.claimForLogin(challenge, ['qr_pending', 'qr_scanned'], 'qr');
    return this.completeLogin(challenge, result.cookieJar, result.profile, null);
  }

  async submitPassword(args: { token: string; username: string; password: string; persistCredentialConsent: boolean }): Promise<{ confirmCode: string }> {
    const original = await this.requireUsableChallenge(args.token);
    if (original.status === 'login_succeeded') return { confirmCode: this.decryptPendingConfirmCode(original) };
    if (original.status === 'login_pending') throw new ChaoxingUserError('学习通账号正在验证，请稍候。');
    const username = args.username.trim();
    if (!username || !args.password) throw new ChaoxingUserError('请输入学习通账号和密码。');
    const challenge = await this.claimForLogin(original, ['created', 'qr_pending', 'qr_scanned'], 'password');
    try {
      const login = await this.client.login(username, args.password);
      return await this.completeLogin(
        challenge,
        login.cookieJar,
        login.profile,
        args.persistCredentialConsent ? { username, password: args.password } : null,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.store.releaseChallengeLogin(challenge.id, challenge.loginAttemptId!, reason, this.now());
      await this.audit(challenge.ownerKey, 'password_login_failed', 'failed', reason);
      if (error instanceof ChaoxingUserError) throw error;
      logger.warn('chaoxing password login failed: owner=%s reason=%s', challenge.ownerKey, reason);
      throw new ChaoxingUserError('学习通登录失败，请稍后重试。');
    }
  }

  async confirmBinding(identity: OwnerIdentity, confirmCode: string): Promise<void> {
    const now = this.now();
    await this.store.cleanupExpiredChallenges(now);
    const challenge = await this.store.findLoginSucceededChallenge(identity.ownerKey);
    if (!challenge) throw new ChaoxingUserError('没有待确认的学习通绑定流程。');
    if (challenge.channelId !== identity.channelId) throw new ChaoxingUserError('请回到发起绑定的原会话发送确认码。');
    if (!challenge.confirmCodeHash || !constantTimeEqualHex(challenge.confirmCodeHash, confirmCodeHash(challenge, confirmCode.trim()))) {
      throw new ChaoxingUserError('学习通确认码不正确。');
    }
    if (!challenge.pendingCookieJarCipher || !challenge.pendingProfileJson) throw new Error('chaoxing completed challenge is missing pending session.');
    const cookieJar = this.decryptPendingCookieJar(challenge);
    const profile = { ...parseProfile(challenge.pendingProfileJson), deviceCode: createDeviceCode() };
    let credentialVersion: number | null = null;
    let revokeCredentialAfterSave = false;
    if (challenge.pendingCredentialCipher && challenge.pendingCredentialMeta) {
      const payload = decryptEnvelopeJson<ChaoxingCredentialPayload>(
        challenge.pendingCredentialCipher,
        challenge.pendingCredentialMeta,
        pendingCredentialAad(challenge.ownerKey, challenge.id),
        this.kek,
      );
      const credential = await this.store.createCredentialShell(identity, now);
      const encrypted = encryptEnvelopeJson(payload, credentialAad(identity.ownerKey, credential.id), this.kek);
      await this.store.updateCredentialEnvelope(credential, encrypted.cipherText, encrypted.meta, this.kek.id, now);
      credentialVersion = credential.version;
    } else {
      revokeCredentialAfterSave = true;
    }
    const cookieJarCipher = encryptSelfContainedJson(cookieJar, sessionCookieAad(identity.ownerKey), this.kek);
    await this.store.saveSession(identity, cookieJarCipher, profile, credentialVersion, now);
    if (revokeCredentialAfterSave) await this.store.revokeCredential(identity.ownerKey, now);
    await this.store.removeOwnerData(identity.ownerKey);
    await this.store.clearChallengeSecrets(challenge.id, 'confirmed', now);
    await this.audit(identity.ownerKey, 'bind_confirmed', 'ok', challenge.bindingMode ?? 'unknown');
  }

  async unbind(identity: OwnerIdentity): Promise<void> {
    const now = this.now();
    await this.store.cancelJobs(identity.ownerKey, null, now);
    await this.store.removeSession(identity.ownerKey);
    await this.store.revokeCredential(identity.ownerKey, now);
    await this.store.removeOwnerData(identity.ownerKey);
    await this.store.cancelActiveChallenges(identity.ownerKey, now);
    await this.store.clearOwnerChallengeSecrets(identity.ownerKey, now);
    await this.audit(identity.ownerKey, 'unbind', 'ok');
  }

  async status(identity: OwnerIdentity): Promise<string> {
    const session = await this.store.getSession(identity.ownerKey);
    if (session) {
      const profile = parseProfile(session.profileJson);
      const credential = await this.store.getActiveCredential(identity.ownerKey);
      const renewal = credential ? '已启用密码自动续期' : '仅保存 Cookie，过期后需要重新绑定';
      return `已绑定：${profile.name} / ${profile.schoolName}\n状态：${session.status}\n续期：${renewal}`;
    }
    const challenge = await this.store.findLatestChallenge(identity.ownerKey);
    if (challenge && ACTIVE_BINDING_STATUSES.has(challenge.status)) return `绑定进行中：${challenge.status}`;
    return '尚未绑定学习通账号。';
  }

  async getAuthenticatedSession(identity: OwnerIdentity): Promise<ChaoxingAuthenticatedSession> {
    const session = await this.store.getSession(identity.ownerKey);
    if (!session) throw new ChaoxingAuthError('尚未绑定学习通账号，请先发送“学习通绑定”。');
    const cookieJar = decryptSelfContainedJson<SerializedChaoxingCookieJar>(session.cookieJarCipher, sessionCookieAad(identity.ownerKey), this.kek);
    const profile = parseProfile(session.profileJson);
    const now = this.now();
    if (session.status === 'active' && now - session.validatedAt < this.config.sessionValidationTtlMs) {
      return { ownerKey: identity.ownerKey, cookieJar, profile, credentialVersion: session.credentialVersion ?? 0 };
    }
    if (session.status === 'active' && await this.client.validate(cookieJar)) {
      await this.store.markSessionValidated(identity.ownerKey, now);
      return { ownerKey: identity.ownerKey, cookieJar, profile, credentialVersion: session.credentialVersion ?? 0 };
    }
    await this.store.setSessionStatus(identity.ownerKey, 'expired', 'session_expired', now);
    if (!this.config.autoReloginEnabled) throw new ChaoxingAuthError();
    return this.refreshSession(identity, profile);
  }

  async refreshAfterAuthError(identity: OwnerIdentity): Promise<ChaoxingAuthenticatedSession> {
    const session = await this.store.getSession(identity.ownerKey);
    if (!session) throw new ChaoxingAuthError();
    if (!this.config.autoReloginEnabled) {
      await this.store.setSessionStatus(identity.ownerKey, 'expired', 'session_expired', this.now());
      throw new ChaoxingAuthError();
    }
    return this.refreshSession(identity, parseProfile(session.profileJson));
  }

  async persistCookies(auth: ChaoxingAuthenticatedSession, cookieJar: SerializedChaoxingCookieJar): Promise<ChaoxingAuthenticatedSession> {
    const now = this.now();
    const cipher = encryptSelfContainedJson(cookieJar, sessionCookieAad(auth.ownerKey), this.kek);
    await this.store.updateSessionCookie(auth.ownerKey, cipher, auth.credentialVersion || null, now);
    return { ...auth, cookieJar };
  }

  private async refreshSession(identity: OwnerIdentity, previousProfile: ChaoxingProfile): Promise<ChaoxingAuthenticatedSession> {
    const credential = await this.store.getActiveCredential(identity.ownerKey);
    if (!credential) throw new ChaoxingAuthError('学习通扫码登录态已过期，请重新绑定。');
    const payload = decryptEnvelopeJson<ChaoxingCredentialPayload>(
      credential.credentialCipher,
      credential.credentialMeta,
      credentialAad(identity.ownerKey, credential.id),
      this.kek,
    );
    try {
      const login = await this.client.login(payload.username, payload.password);
      const now = this.now();
      const cipher = encryptSelfContainedJson(login.cookieJar, sessionCookieAad(identity.ownerKey), this.kek);
      const refreshedProfile = { ...login.profile, deviceCode: previousProfile.deviceCode };
      await this.store.saveSession(identity, cipher, refreshedProfile, credential.version, now);
      await this.store.markCredentialUsed(credential.id, now);
      await this.audit(identity.ownerKey, 'session_refreshed', 'ok');
      return { ownerKey: identity.ownerKey, cookieJar: login.cookieJar, profile: refreshedProfile, credentialVersion: credential.version };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const now = this.now();
      await this.store.markCredentialFailure(credential.id, reason, now);
      await this.store.setSessionStatus(identity.ownerKey, 'invalid', 'credential_refresh_failed', now);
      await this.audit(identity.ownerKey, 'session_refresh_failed', 'failed', reason);
      logger.warn('chaoxing relogin failed: owner=%s profile=%s reason=%s', identity.ownerKey, previousProfile.uid, reason);
      throw new ChaoxingAuthError('学习通自动续期失败，请重新绑定。');
    }
  }

  private async claimForLogin(challenge: ChaoxingBindChallenge, statuses: ChaoxingBindChallenge['status'][], mode: 'qr' | 'password'): Promise<ChaoxingBindChallenge> {
    const attemptId = createRandomToken(16);
    const claimed = await this.store.claimChallengeLogin(challenge.id, statuses, attemptId, mode, this.now());
    if (!claimed) throw new ChaoxingUserError('绑定状态已经变化，请刷新页面或重新发送“学习通绑定”。');
    return claimed;
  }

  private async completeLogin(
    challenge: ChaoxingBindChallenge,
    cookieJar: SerializedChaoxingCookieJar,
    profile: ChaoxingProfile,
    credential: ChaoxingCredentialPayload | null,
  ): Promise<{ kind: 'success'; confirmCode: string }> {
    if (!challenge.loginAttemptId) throw new Error('chaoxing claimed challenge has no attempt id.');
    const now = this.now();
    const confirmCode = createConfirmCode();
    const pendingConfirm = encryptEnvelopeJson({ confirmCode } satisfies ConfirmCodePayload, pendingConfirmCodeAad(challenge.ownerKey, challenge.id), this.kek);
    const pendingCredential = credential
      ? encryptEnvelopeJson(credential, pendingCredentialAad(challenge.ownerKey, challenge.id), this.kek)
      : null;
    const completed = await this.store.completeChallengeLogin(challenge.id, challenge.loginAttemptId, {
      status: 'login_succeeded', loginAttemptId: null, confirmCodeHash: confirmCodeHash(challenge, confirmCode),
      pendingConfirmCodeCipher: pendingConfirm.cipherText, pendingConfirmCodeMeta: pendingConfirm.meta,
      pendingCookieJarCipher: encryptSelfContainedJson(cookieJar, pendingCookieAad(challenge.ownerKey, challenge.id), this.kek),
      pendingCredentialCipher: pendingCredential?.cipherText ?? null, pendingCredentialMeta: pendingCredential?.meta ?? null,
      pendingProfileJson: JSON.stringify(profile), errorMessage: null, updatedAt: now,
    });
    if (!completed) throw new ChaoxingUserError('绑定状态已经变化，请重新发送“学习通绑定”。');
    await this.audit(challenge.ownerKey, challenge.bindingMode === 'password' ? 'password_login_succeeded' : 'qr_login_succeeded', 'ok');
    return { kind: 'success', confirmCode };
  }

  private async requireUsableChallenge(token: string): Promise<ChaoxingBindChallenge> {
    const normalized = token.trim();
    if (!normalized) throw new ChaoxingUserError('绑定链接缺少 token。');
    const challenge = await this.store.findChallengeByTokenHash(sha256Hex(normalized));
    if (!challenge) throw new ChaoxingUserError('绑定链接无效。');
    if (challenge.expiresAt <= this.now()) {
      await this.store.clearChallengeSecrets(challenge.id, 'expired', this.now());
      throw new ChaoxingUserError('绑定链接已过期，请重新发送“学习通绑定”。');
    }
    if (challenge.status === 'confirmed' || challenge.status === 'expired' || challenge.status === 'cancelled') {
      throw new ChaoxingUserError('绑定链接已经失效，请重新发送“学习通绑定”。');
    }
    return challenge;
  }

  private decryptPendingCookieJar(challenge: ChaoxingBindChallenge): SerializedChaoxingCookieJar {
    if (!challenge.pendingCookieJarCipher) throw new Error('chaoxing challenge is missing pending cookies.');
    return decryptSelfContainedJson<SerializedChaoxingCookieJar>(challenge.pendingCookieJarCipher, pendingCookieAad(challenge.ownerKey, challenge.id), this.kek);
  }

  private decryptPendingConfirmCode(challenge: ChaoxingBindChallenge): string {
    if (!challenge.pendingConfirmCodeCipher || !challenge.pendingConfirmCodeMeta) throw new Error('chaoxing challenge is missing confirm code.');
    return decryptEnvelopeJson<ConfirmCodePayload>(challenge.pendingConfirmCodeCipher, challenge.pendingConfirmCodeMeta, pendingConfirmCodeAad(challenge.ownerKey, challenge.id), this.kek).confirmCode;
  }

  private async audit(ownerKey: string, eventType: string, status: string, reason: string | null = null): Promise<void> {
    await this.store.addAudit({ ownerKey, eventType, status, reason, createdAt: this.now() });
  }
}

const ACTIVE_BINDING_STATUSES = new Set(['created', 'qr_pending', 'qr_scanned', 'login_pending', 'login_succeeded']);

function confirmCodeHash(challenge: ChaoxingBindChallenge, code: string): string {
  return sha256Hex(`${challenge.id}:${challenge.ownerKey}:${code}`);
}

function parseProfile(value: string): ChaoxingProfile {
  const parsed = JSON.parse(value) as ChaoxingProfile;
  if (!parsed.uid || !parsed.puid || !parsed.fid || !parsed.name) throw new Error('stored chaoxing profile is invalid.');
  return parsed;
}

function createDeviceCode(): string {
  const digest = createHash('sha256').update(randomBytes(64)).digest();
  return Buffer.concat([digest, digest]).toString('base64');
}
