import { Logger } from 'koishi';
import {
  HbuJwLoginError,
  type HbuJwCasChallenge,
  type HbuJwCasSession,
  type HbuJwHttpClient,
  type HbuJwLoginResult,
  type HbuJwLoginStartResult,
} from './jw-client.js';
import {
  casSessionAad,
  constantTimeEqualHex,
  cookieAad,
  credentialAad,
  createConfirmCode,
  createRandomToken,
  decryptSelfContainedJson,
  decryptEnvelopeJson,
  encryptEnvelopeJson,
  encryptSelfContainedJson,
  sha256Hex,
  smsDeviceTokenAad,
  type HbuJwKek,
} from './crypto.js';
import { HbuJwStore } from './store.js';
import { HbuJwSharedSessionCoordinator } from './shared-session.js';
import {
  HBU_JW_SERVICE_ID,
  HbuJwUserError,
  type HbuJwBindChallenge,
  type HbuJwCredentialPayload,
  type HbuJwSmsDevicePlatform,
  type OwnerIdentity,
  type SerializedCookieJar,
} from './types.js';

const logger = new Logger('hbu-jw');

export interface HbuJwRuntimeConfig {
  bindPagePath: string;
  publicBaseUrl: string;
  bindTokenTtlMs: number;
  autoReloginEnabled: boolean;
  sharedCasIdentity?: {
    ownerKey: string;
    studentId: string;
  };
}

export interface StartBindingResult {
  link: string;
  expiresAt: number;
}

export interface BindPageChallenge {
  token: string;
  qqUserId: string;
  purpose: HbuJwBindChallenge['purpose'];
  state: 'form' | 'pending' | 'sms' | 'success';
  confirmCode?: string;
  maskedPhone?: string;
  resendAvailableAt?: number;
}

export interface SubmitCredentialsResult {
  qqUserId: string;
  state: 'sms' | 'success';
  confirmCode: string;
}

export interface SmsAutomationTokens {
  ios: string;
  android: string;
}

interface PendingConfirmCodePayload {
  confirmCode: string;
}

export class HbuJwBindSubmissionPendingError extends HbuJwUserError {
  constructor() {
    super('教务账号密码正在验证，请稍候。');
    this.name = 'HbuJwBindSubmissionPendingError';
  }
}

export type AuthenticatedSessionResult =
  | { kind: 'authenticated'; cookieJar: SerializedCookieJar; credentialVersion?: number }
  | { kind: 'needs_binding'; reason: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'unavailable'; reason: string };

export class HbuJwService {
  constructor(
    private readonly store: HbuJwStore,
    private readonly jwClient: HbuJwHttpClient,
    private readonly kek: HbuJwKek,
    private readonly config: HbuJwRuntimeConfig,
    private readonly now: () => number = () => Date.now(),
    private readonly sharedSession = new HbuJwSharedSessionCoordinator(),
  ) {}

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.sharedSession.runExclusive(operation);
  }

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
    if (challenge.status === 'login_succeeded') {
      return {
        token,
        qqUserId: challenge.qqUserId,
        purpose: challenge.purpose,
        state: 'success',
        ...(challenge.purpose === 'binding' ? { confirmCode: this.decryptPendingConfirmCode(challenge).confirmCode } : {}),
      };
    }
    if (challenge.status === 'awaiting_sms') {
      if (!challenge.maskedPhone || !challenge.resendAvailableAt) {
        throw new Error('hbu-jw awaiting_sms challenge is missing public state.');
      }
      return {
        token,
        qqUserId: challenge.qqUserId,
        purpose: challenge.purpose,
        state: 'sms',
        maskedPhone: challenge.maskedPhone,
        resendAvailableAt: challenge.resendAvailableAt,
      };
    }
    if (challenge.status === 'login_pending') {
      return {
        token,
        qqUserId: challenge.qqUserId,
        purpose: challenge.purpose,
        state: 'pending',
      };
    }
    return {
      token,
      qqUserId: challenge.qqUserId,
      purpose: challenge.purpose,
      state: 'form',
    };
  }

  async submitCredentials(args: {
    token: string;
    username: string;
    password: string;
    persistCredentialConsent: boolean;
  }): Promise<SubmitCredentialsResult> {
    const challenge = await this.requireUsableChallenge(args.token);
    if (challenge.status === 'login_succeeded') {
      return this.completedSubmitResult(challenge);
    }
    if (challenge.status === 'login_pending') {
      throw new HbuJwBindSubmissionPendingError();
    }
    if (challenge.status !== 'created') {
      throw new HbuJwUserError('该绑定链接已经提交过账号密码，请重新发送“教务绑定”生成新链接。');
    }
    if (!args.persistCredentialConsent) {
      throw new HbuJwUserError('请先授权加密保存教务账号密码，用于后续自动刷新教务登录态。');
    }
    const username = args.username.trim();
    if (!username || !args.password) {
      throw new HbuJwUserError('请输入教务账号和密码。');
    }

    const now = this.now();
    const loginAttemptId = createRandomToken(16);
    const claimedChallenge = await this.store.claimChallengeForLogin(challenge.id, loginAttemptId, now);
    if (!claimedChallenge) {
      const currentChallenge = await this.requireUsableChallenge(args.token);
      if (currentChallenge.status === 'login_succeeded') {
        return this.completedSubmitResult(currentChallenge);
      }
      if (currentChallenge.status === 'login_pending') {
        throw new HbuJwBindSubmissionPendingError();
      }
      throw new HbuJwUserError('该绑定链接已经提交过账号密码，请重新发送“教务绑定”生成新链接。');
    }

    try {
      const credentialPayload = { username, password: args.password } satisfies HbuJwCredentialPayload;
      const credential = encryptEnvelopeJson(
        credentialPayload,
        pendingCredentialAad(claimedChallenge),
        this.kek,
      );
      const login = await this.loginForIdentity(claimedChallenge.ownerKey, username, args.password);
      if (login.kind === 'awaiting_sms') {
        const encryptedChallenge = encryptEnvelopeJson(
          login.challenge,
          pendingCasChallengeAad(claimedChallenge),
          this.kek,
        );
        const waiting = await this.store.setChallengeAwaitingSms(claimedChallenge.id, loginAttemptId, {
          pendingCasChallengeCipher: encryptedChallenge.cipherText,
          pendingCasChallengeMeta: encryptedChallenge.meta,
          pendingCredentialCipher: credential.cipherText,
          pendingCredentialMeta: credential.meta,
          maskedPhone: login.maskedPhone,
          resendAvailableAt: login.resendAvailableAt,
          errorMessage: null,
          updatedAt: this.now(),
        });
        if (!waiting) throw new HbuJwUserError('该绑定链接状态已变化，请重新发送“教务绑定”生成新链接。');
        await this.audit(claimedChallenge.ownerKey, 'cas_sms_sent', 'ok');
        return { qqUserId: claimedChallenge.qqUserId, state: 'sms', confirmCode: '' };
      }
      const result = await this.completeBindingLogin(claimedChallenge, loginAttemptId, login, credential, 'login_pending');
      await this.audit(claimedChallenge.ownerKey, 'jw_login_succeeded', 'ok');
      return result;
    } catch (error) {
      const reason = formatLoginFailureReason(error);
      await this.store.releaseChallengeLogin(claimedChallenge.id, loginAttemptId, reason, now);
      await this.audit(claimedChallenge.ownerKey, 'jw_login_failed', 'failed', reason);
      logger.warn('hbu jw login failed: owner=%s reason=%s', claimedChallenge.ownerKey, reason);
      if (error instanceof HbuJwUserError) throw error;
      if (error instanceof HbuJwLoginError) throw new HbuJwUserError(error.message);
      throw new HbuJwUserError('教务登录失败，请稍后重试。');
    }
  }

  async submitSmsCode(token: string, code: string): Promise<SubmitCredentialsResult> {
    const challenge = await this.requireUsableChallenge(token);
    if (challenge.status === 'login_succeeded') return this.completedSubmitResult(challenge);
    if (challenge.status !== 'awaiting_sms') throw new HbuJwUserError('当前绑定流程没有等待短信验证码。');
    return this.completeSmsChallenge(challenge, code);
  }

  async getSmsAutomationTokens(ownerKey: string): Promise<SmsAutomationTokens> {
    return {
      ios: await this.getOrCreateSmsDeviceToken(ownerKey, 'ios'),
      android: await this.getOrCreateSmsDeviceToken(ownerKey, 'android'),
    };
  }

  async ingestSmsMessage(deviceToken: string, message: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(deviceToken)) throw new HbuJwUserError('短信自动转发 Token 无效。');
    const device = await this.store.findSmsDeviceByTokenHash(sha256Hex(deviceToken));
    if (!device) throw new HbuJwUserError('短信自动转发 Token 无效。');
    const codes = [...message.matchAll(/(?<!\d)\d{6}(?!\d)/g)].map((match) => match[0]);
    const uniqueCodes = [...new Set(codes)];
    if (uniqueCodes.length !== 1) throw new HbuJwUserError('短信中没有唯一的六位验证码。');
    const waiting = (await this.store.findActiveChallenges(device.ownerKey))
      .filter((challenge) => challenge.status === 'awaiting_sms');
    if (waiting.length !== 1) throw new HbuJwUserError('当前没有唯一的教务验证码事务。');
    await this.completeSmsChallenge(waiting[0]!, uniqueCodes[0]!);
  }

  private async completeSmsChallenge(challenge: HbuJwBindChallenge, code: string): Promise<SubmitCredentialsResult> {
    const credentialPayload = this.decryptPendingCredential(challenge);
    const casChallenge = this.decryptPendingCasChallenge(challenge);
    try {
      const login = await this.jwClient.completeSmsLogin(casChallenge, credentialPayload.password, code.trim());
      const credential = encryptEnvelopeJson(
        credentialPayload,
        pendingCredentialAad(challenge),
        this.kek,
      );
      if (challenge.purpose === 'reauth') {
        await this.completeReauthentication(challenge, login, credentialPayload);
        return { qqUserId: challenge.qqUserId, state: 'success', confirmCode: '' };
      }
      const result = await this.completeBindingLogin(challenge, challenge.loginAttemptId!, login, credential, 'awaiting_sms');
      await this.audit(challenge.ownerKey, 'cas_sms_validated', 'ok');
      return result;
    } catch (error) {
      const reason = formatLoginFailureReason(error);
      await this.store.updateChallenge(challenge.id, { errorMessage: reason, updatedAt: this.now() });
      await this.audit(challenge.ownerKey, 'cas_sms_failed', 'failed', reason);
      if (error instanceof HbuJwLoginError) throw new HbuJwUserError(error.message);
      throw error;
    }
  }

  private async getOrCreateSmsDeviceToken(ownerKey: string, platform: HbuJwSmsDevicePlatform): Promise<string> {
    const existing = await this.store.getSmsDevice(ownerKey, platform);
    if (existing) {
      const { token } = decryptSelfContainedJson<{ token: string }>(
        existing.tokenCipher,
        smsDeviceTokenAad(ownerKey, platform),
        this.kek,
      );
      if (sha256Hex(token) !== existing.tokenHash) throw new Error('hbu-jw SMS device token integrity check failed.');
      return token;
    }
    const token = createRandomToken();
    await this.store.createSmsDevice(
      ownerKey,
      platform,
      sha256Hex(token),
      encryptSelfContainedJson({ token }, smsDeviceTokenAad(ownerKey, platform), this.kek),
      this.now(),
    );
    return token;
  }

  async resendSmsCode(token: string): Promise<number> {
    const challenge = await this.requireUsableChallenge(token);
    if (challenge.status !== 'awaiting_sms') throw new HbuJwUserError('当前绑定流程没有等待短信验证码。');
    const now = this.now();
    if ((challenge.resendAvailableAt ?? 0) > now) {
      throw new HbuJwUserError('验证码发送间隔尚未结束，请稍后重试。');
    }
    const casChallenge = this.decryptPendingCasChallenge(challenge);
    const resendAvailableAt = await this.jwClient.resendSmsCode(casChallenge);
    const encryptedChallenge = encryptEnvelopeJson(casChallenge, pendingCasChallengeAad(challenge), this.kek);
    await this.store.updateChallenge(challenge.id, {
      pendingCasChallengeCipher: encryptedChallenge.cipherText,
      pendingCasChallengeMeta: encryptedChallenge.meta,
      resendAvailableAt,
      errorMessage: null,
      updatedAt: now,
    });
    await this.audit(challenge.ownerKey, 'cas_sms_resent', 'ok');
    return resendAvailableAt;
  }

  private async completeBindingLogin(
    challenge: HbuJwBindChallenge,
    loginAttemptId: string,
    login: HbuJwLoginResult,
    credential: { cipherText: string; meta: string },
    source: 'login_pending' | 'awaiting_sms',
  ): Promise<SubmitCredentialsResult> {
    const now = this.now();
    const confirmCode = createConfirmCode();
    const pendingConfirmCode = encryptEnvelopeJson(
      { confirmCode } satisfies PendingConfirmCodePayload,
      pendingConfirmCodeAad(challenge),
      this.kek,
    );
    const patch: Partial<HbuJwBindChallenge> = {
      status: 'login_succeeded',
      confirmCodeHash: hashConfirmCode(challenge, confirmCode),
      pendingConfirmCodeCipher: pendingConfirmCode.cipherText,
      pendingConfirmCodeMeta: pendingConfirmCode.meta,
      pendingCookieJarCipher: encryptSelfContainedJson(login.cookieJar, cookieAad(challenge.ownerKey), this.kek),
      pendingCasSessionCipher: login.casSession
        ? encryptSelfContainedJson(login.casSession, casSessionAad(challenge.ownerKey), this.kek)
        : null,
      pendingCasChallengeCipher: null,
      pendingCasChallengeMeta: null,
      pendingCredentialCipher: credential.cipherText,
      pendingCredentialMeta: credential.meta,
      maskedPhone: null,
      resendAvailableAt: null,
      errorMessage: null,
      updatedAt: now,
    };
    const completed = source === 'login_pending'
      ? await this.store.completeChallengeLogin(challenge.id, loginAttemptId, patch)
      : await this.store.completeSmsChallenge(challenge.id, loginAttemptId, patch);
    if (!completed) throw new HbuJwUserError('该绑定链接状态已变化，请重新发送“教务绑定”生成新链接。');
    return { qqUserId: challenge.qqUserId, state: 'success', confirmCode };
  }

  private async completeReauthentication(
    challenge: HbuJwBindChallenge,
    login: HbuJwLoginResult,
    credentialPayload: HbuJwCredentialPayload,
  ): Promise<void> {
    const now = this.now();
    const identity = challengeIdentity(challenge);
    const cookieJarCipher = encryptSelfContainedJson(login.cookieJar, cookieAad(challenge.ownerKey), this.kek);
    const casSessionCipher = login.casSession
      ? encryptSelfContainedJson(login.casSession, casSessionAad(challenge.ownerKey), this.kek)
      : null;
    await this.store.replaceSession(identity, cookieJarCipher, 'active', now, casSessionCipher);
    const credential = await this.store.getActiveCredential(challenge.ownerKey);
    if (!credential || credentialPayload.username.length === 0) {
      throw new Error('hbu-jw reauthentication challenge is missing its credential.');
    }
    await this.store.markCredentialUsed(credential.id, now);
    const completed = await this.store.completeSmsChallenge(challenge.id, challenge.loginAttemptId!, {
      status: 'login_succeeded',
      pendingCasChallengeCipher: null,
      pendingCasChallengeMeta: null,
      pendingCredentialCipher: null,
      pendingCredentialMeta: null,
      maskedPhone: null,
      resendAvailableAt: null,
      errorMessage: null,
      updatedAt: now,
    });
    if (!completed) throw new HbuJwUserError('验证码已经由另一次请求处理。');
    await this.audit(challenge.ownerKey, 'cas_reauthentication_succeeded', 'ok');
  }

  private decryptPendingCredential(challenge: HbuJwBindChallenge): HbuJwCredentialPayload {
    if (!challenge.pendingCredentialCipher || !challenge.pendingCredentialMeta) {
      throw new Error('hbu-jw SMS challenge is missing pending credentials.');
    }
    return decryptEnvelopeJson<HbuJwCredentialPayload>(
      challenge.pendingCredentialCipher,
      challenge.pendingCredentialMeta,
      pendingCredentialAad(challenge),
      this.kek,
    );
  }

  private decryptPendingCasChallenge(challenge: HbuJwBindChallenge): HbuJwCasChallenge {
    if (!challenge.pendingCasChallengeCipher || !challenge.pendingCasChallengeMeta) {
      throw new Error('hbu-jw SMS challenge is missing CAS state.');
    }
    return decryptEnvelopeJson<HbuJwCasChallenge>(
      challenge.pendingCasChallengeCipher,
      challenge.pendingCasChallengeMeta,
      pendingCasChallengeAad(challenge),
      this.kek,
    );
  }

  async confirmBinding(identity: OwnerIdentity, confirmCode: string): Promise<void> {
    const now = this.now();
    await this.store.cleanupExpiredChallenges(now);
    const challenge = await this.store.findLoginSucceededChallenge(identity.ownerKey);
    if (!challenge) {
      throw new HbuJwUserError('没有待确认的教务绑定流程。');
    }
    if (challenge.expiresAt <= now) {
      await this.store.clearChallengeSecrets(challenge.id, 'expired', now);
      throw new HbuJwUserError('教务绑定确认码已过期，请重新发送“教务绑定”。');
    }
    if (challenge.channelId !== identity.channelId) {
      throw new HbuJwUserError('请回到发起绑定的原群聊发送确认码。');
    }
    if (!challenge.confirmCodeHash || !constantTimeEqualHex(challenge.confirmCodeHash, hashConfirmCode(challenge, confirmCode.trim()))) {
      throw new HbuJwUserError('教务确认码不正确。');
    }
    if (!challenge.pendingCookieJarCipher || !challenge.pendingCredentialCipher || !challenge.pendingCredentialMeta) {
      throw new Error('hbu-jw login_succeeded challenge is missing pending encrypted state.');
    }

    const credentialPayload = decryptEnvelopeJson<HbuJwCredentialPayload>(
      challenge.pendingCredentialCipher,
      challenge.pendingCredentialMeta,
      pendingCredentialAad(challenge),
      this.kek,
    );
    const credentialRow = await this.store.upsertCredentialPlaceholder(identity, this.kek.id, now);
    const credential = encryptEnvelopeJson(
      credentialPayload,
      credentialAad(identity.ownerKey, HBU_JW_SERVICE_ID, credentialRow.id),
      this.kek,
    );
    await this.store.updateCredentialEnvelope(credentialRow, credential.cipherText, credential.meta, now);
    await this.store.removeAcademicData(identity.ownerKey);
    await this.store.replaceSession(
      identity,
      challenge.pendingCookieJarCipher,
      'active',
      now,
      challenge.pendingCasSessionCipher ?? null,
    );
    await this.store.clearChallengeSecrets(challenge.id, 'confirmed', now);
    await this.audit(identity.ownerKey, 'bind_confirmed', 'ok');
  }

  async getStatus(identity: OwnerIdentity): Promise<string> {
    const now = this.now();
    await this.store.cleanupExpiredChallenges(now);
    const session = await this.store.getSession(identity.ownerKey);
    if (session?.status === 'active') return '已绑定';
    if (session?.status === 'expired') {
      return session.lastFailureReason && session.lastFailureReason !== 'session_expired'
        ? `已绑定；${session.lastFailureReason}`
        : '已绑定；教务登录态已过期，下次查询时会自动续登';
    }
    if (session?.status === 'invalid') return session.lastFailureReason ?? '教务账号凭据已失效，需要重新绑定';
    const challenges = await this.store.findActiveChallenges(identity.ownerKey);
    if (challenges.some((challenge) => challenge.status === 'login_succeeded')) return '绑定流程待确认';
    if (challenges.some((challenge) => challenge.status === 'awaiting_sms')) return '统一认证验证码已发送，等待验证';
    if (challenges.some((challenge) => challenge.status === 'login_pending')) return '正在验证统一认证账号';
    if (challenges.some((challenge) => challenge.status === 'created')) return '绑定链接已生成，等待网页登录';
    const latestChallenge = await this.store.findLatestChallenge(identity.ownerKey);
    if (latestChallenge?.status === 'expired') return '绑定链接已过期';
    return '未绑定';
  }

  async unbind(identity: OwnerIdentity): Promise<void> {
    const now = this.now();
    await this.store.removeSession(identity.ownerKey);
    await this.store.revokeCredential(identity.ownerKey, now);
    await this.store.removeAcademicData(identity.ownerKey);
    await this.store.removeSmsDevices(identity.ownerKey);
    await this.store.cancelActiveChallenges(identity.ownerKey, now);
    await this.store.clearOwnerChallengeSecrets(identity.ownerKey, now);
    await this.audit(identity.ownerKey, 'unbind', 'ok');
  }

  async ensureAuthenticated(identity: OwnerIdentity): Promise<AuthenticatedSessionResult> {
    const now = this.now();
    const session = await this.store.getSession(identity.ownerKey);
    const credential = await this.store.getActiveCredential(identity.ownerKey);
    if (session?.status === 'active') {
      if (!credential) {
        throw new Error(`active hbu-jw session is missing credential: owner=${identity.ownerKey}`);
      }
      const cookieJar = this.jwClient.prepareSession(this.decryptCookieJar(identity.ownerKey, session.cookieJarCipher));
      if (await this.jwClient.validate(cookieJar)) {
        await this.store.markSessionValidated(identity.ownerKey, now);
        await this.audit(identity.ownerKey, 'session_validated', 'ok');
        return { kind: 'authenticated', cookieJar, credentialVersion: credential.version };
      }
      await this.store.setSessionStatus(identity.ownerKey, 'expired', 'session_expired', now);
      await this.audit(identity.ownerKey, 'session_expired', 'expired');
    }

    if (!credential) {
      return { kind: 'needs_binding', reason: '请先发送“教务绑定”。' };
    }
    if (!this.config.autoReloginEnabled) {
      return { kind: 'unavailable', reason: '教务登录态已过期，自动续登当前未启用，请联系管理员或重新绑定。' };
    }

    const activeReauth = (await this.store.findActiveChallenges(identity.ownerKey))
      .find((challenge) => challenge.purpose === 'reauth' && challenge.status === 'awaiting_sms');
    if (activeReauth) {
      return { kind: 'unavailable', reason: this.reauthenticationMessage(activeReauth) };
    }

    try {
      const credentialPayload = decryptEnvelopeJson<HbuJwCredentialPayload>(
        credential.credentialCipher,
        credential.credentialMeta,
        credentialAad(identity.ownerKey, HBU_JW_SERVICE_ID, credential.id),
        this.kek,
      );
      const usesSharedCas = this.matchesSharedCasIdentity(identity.ownerKey, credentialPayload.username);
      const previousCasSession = session?.casSessionCipher
        ? decryptSelfContainedJson<HbuJwCasSession>(session.casSessionCipher, casSessionAad(identity.ownerKey), this.kek)
        : undefined;
      const login = usesSharedCas
        ? await this.jwClient.loginSharedCas(credentialPayload.username)
        : await this.jwClient.beginLogin(credentialPayload.username, credentialPayload.password, previousCasSession);
      if (login.kind === 'awaiting_sms') {
        const challenge = await this.createReauthenticationChallenge(identity, credentialPayload, login);
        await this.audit(identity.ownerKey, 'cas_sms_sent', 'ok');
        return { kind: 'unavailable', reason: this.reauthenticationMessage(challenge) };
      }
      const cookieJarCipher = encryptSelfContainedJson(login.cookieJar, cookieAad(identity.ownerKey), this.kek);
      const casSessionCipher = login.casSession
        ? encryptSelfContainedJson(login.casSession, casSessionAad(identity.ownerKey), this.kek)
        : null;
      await this.store.replaceSession(identity, cookieJarCipher, 'active', now, casSessionCipher);
      await this.store.markCredentialUsed(credential.id, now);
      await this.audit(identity.ownerKey, usesSharedCas ? 'shared_cas_session_acquired' : 'credential_refresh_succeeded', 'ok');
      return { kind: 'authenticated', cookieJar: login.cookieJar, credentialVersion: credential.version };
    } catch (error) {
      const failure = classifyCredentialRefreshFailure(error);
      await this.store.setSessionStatus(identity.ownerKey, failure.sessionStatus, failure.userMessage, now);
      if (failure.credentialRejected) {
        await this.store.markCredentialFailure(credential.id, failure.diagnostic, now);
      }
      await this.audit(identity.ownerKey, failure.eventType, 'failed', failure.diagnostic);
      logger.warn('hbu jw credential refresh failed: owner=%s reason=%s', identity.ownerKey, failure.diagnostic);
      return { kind: failure.resultKind, reason: failure.userMessage };
    }
  }

  private loginForIdentity(ownerKey: string, username: string, password: string): Promise<HbuJwLoginStartResult> {
    return this.matchesSharedCasIdentity(ownerKey, username)
      ? this.jwClient.loginSharedCas(username)
      : this.jwClient.beginLogin(username, password);
  }

  private async createReauthenticationChallenge(
    identity: OwnerIdentity,
    credentialPayload: HbuJwCredentialPayload,
    login: Extract<HbuJwLoginStartResult, { kind: 'awaiting_sms' }>,
  ): Promise<HbuJwBindChallenge> {
    const now = this.now();
    await this.store.cancelActiveChallenges(identity.ownerKey, now);
    const token = createRandomToken();
    const challenge = await this.store.createChallenge(
      identity,
      sha256Hex(token),
      now + this.config.bindTokenTtlMs,
      now,
      'reauth',
    );
    const loginAttemptId = createRandomToken(16);
    const claimed = await this.store.claimChallengeForLogin(challenge.id, loginAttemptId, now);
    if (!claimed) throw new Error('hbu-jw could not claim reauthentication challenge.');
    const encryptedCredential = encryptEnvelopeJson(
      credentialPayload,
      pendingCredentialAad(claimed),
      this.kek,
    );
    const encryptedChallenge = encryptEnvelopeJson(
      login.challenge,
      pendingCasChallengeAad(claimed),
      this.kek,
    );
    const pageTokenCipher = encryptSelfContainedJson({ token }, reauthTokenAad(identity.ownerKey), this.kek);
    const waiting = await this.store.setChallengeAwaitingSms(claimed.id, loginAttemptId, {
      pageTokenCipher,
      pendingCasChallengeCipher: encryptedChallenge.cipherText,
      pendingCasChallengeMeta: encryptedChallenge.meta,
      pendingCredentialCipher: encryptedCredential.cipherText,
      pendingCredentialMeta: encryptedCredential.meta,
      maskedPhone: login.maskedPhone,
      resendAvailableAt: login.resendAvailableAt,
      errorMessage: null,
      updatedAt: now,
    });
    if (!waiting) throw new Error('hbu-jw could not persist reauthentication challenge.');
    return waiting;
  }

  private reauthenticationMessage(challenge: HbuJwBindChallenge): string {
    if (!challenge.pageTokenCipher) throw new Error('hbu-jw reauthentication challenge is missing its page token.');
    const { token } = decryptSelfContainedJson<{ token: string }>(
      challenge.pageTokenCipher,
      reauthTokenAad(challenge.ownerKey),
      this.kek,
    );
    const link = `${this.config.publicBaseUrl}${this.config.bindPagePath}?token=${encodeURIComponent(token)}`;
    return `统一认证验证码已发送至 ${challenge.maskedPhone ?? '账号绑定手机'}，请打开链接完成验证：\n${link}`;
  }

  private matchesSharedCasIdentity(ownerKey: string, username: string): boolean {
    const configured = this.config.sharedCasIdentity;
    return configured !== undefined
      && configured.ownerKey === ownerKey
      && configured.studentId === username;
  }

  async runKeepAlive(recentUseWindowMs: number): Promise<void> {
    if (this.jwClient.usesSharedBroker()) return;
    const now = this.now();
    const sessions = await this.store.listRecentActiveSessions(now - recentUseWindowMs);
    await Promise.all(sessions.map(async (session) => {
      try {
        const credential = await this.store.getActiveCredential(session.ownerKey);
        if (!credential) throw new Error('active session is missing its credential');
        const cookieJar = this.jwClient.prepareSession(this.decryptCookieJar(session.ownerKey, session.cookieJarCipher));
        if (await this.jwClient.validate(cookieJar)) {
          await this.store.markSessionValidated(session.ownerKey, now);
        } else {
          await this.store.setSessionStatus(session.ownerKey, 'expired', 'keep_alive_failed', now);
        }
      } catch {
        await this.store.setSessionStatus(session.ownerKey, 'expired', 'keep_alive_failed', now);
      }
    }));
  }

  private async requireUsableChallenge(token: string): Promise<HbuJwBindChallenge> {
    const tokenHash = sha256Hex(token.trim());
    const challenge = await this.store.findChallengeByTokenHash(tokenHash);
    if (!challenge) {
      throw new HbuJwUserError('绑定链接无效，请重新发送“教务绑定”。');
    }
    const now = this.now();
    if (challenge.expiresAt <= now) {
      await this.store.clearChallengeSecrets(challenge.id, 'expired', now);
      throw new HbuJwUserError('绑定链接已过期，请重新发送“教务绑定”。');
    }
    if (challenge.status === 'cancelled' || challenge.status === 'expired' || challenge.status === 'confirmed') {
      throw new HbuJwUserError('绑定链接已失效，请重新发送“教务绑定”。');
    }
    return challenge;
  }

  private decryptCookieJar(ownerKey: string, cookieJarCipher: string): unknown {
    return decryptSelfContainedJson<unknown>(cookieJarCipher, cookieAad(ownerKey), this.kek);
  }

  private completedSubmitResult(challenge: HbuJwBindChallenge): SubmitCredentialsResult {
    if (challenge.purpose === 'reauth') {
      return { qqUserId: challenge.qqUserId, state: 'success', confirmCode: '' };
    }
    return {
      qqUserId: challenge.qqUserId,
      state: 'success',
      confirmCode: this.decryptPendingConfirmCode(challenge).confirmCode,
    };
  }

  private decryptPendingConfirmCode(challenge: HbuJwBindChallenge): PendingConfirmCodePayload {
    if (!challenge.pendingConfirmCodeCipher || !challenge.pendingConfirmCodeMeta) {
      throw new Error('hbu-jw login_succeeded challenge is missing pending confirm code.');
    }
    return decryptEnvelopeJson<PendingConfirmCodePayload>(
      challenge.pendingConfirmCodeCipher,
      challenge.pendingConfirmCodeMeta,
      pendingConfirmCodeAad(challenge),
      this.kek,
    );
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

function hashConfirmCode(challenge: HbuJwBindChallenge, confirmCode: string): string {
  return sha256Hex(`${challenge.id}:${challenge.ownerKey}:${confirmCode}`);
}

function pendingCredentialAad(challenge: HbuJwBindChallenge): string {
  return `hbu-jw:pending-credential:v1:${challenge.ownerKey}:${challenge.id}`;
}

function pendingConfirmCodeAad(challenge: HbuJwBindChallenge): string {
  return `hbu-jw:pending-confirm-code:v1:${challenge.ownerKey}:${challenge.id}`;
}

function pendingCasChallengeAad(challenge: HbuJwBindChallenge): string {
  return `hbu-jw:pending-cas-challenge:v1:${challenge.ownerKey}:${challenge.id}`;
}

function reauthTokenAad(ownerKey: string): string {
  return `hbu-jw:reauth-token:v1:${ownerKey}`;
}

function challengeIdentity(challenge: HbuJwBindChallenge): OwnerIdentity {
  return {
    ownerKey: challenge.ownerKey,
    platform: challenge.platform,
    qqUserId: challenge.qqUserId,
    channelId: challenge.channelId,
  };
}

function formatLoginFailureReason(error: unknown): string {
  if (error instanceof HbuJwLoginError) return clipDiagnostic(`${error.code}: ${error.diagnostic}`);
  if (error instanceof HbuJwUserError) return clipDiagnostic(error.message);
  if (error instanceof Error) return clipDiagnostic(`${error.name}: ${error.message}`);
  return clipDiagnostic(String(error));
}

interface CredentialRefreshFailure {
  resultKind: 'invalid' | 'unavailable';
  sessionStatus: 'invalid' | 'expired';
  credentialRejected: boolean;
  eventType: 'credential_refresh_rejected' | 'credential_refresh_interaction_required' | 'credential_refresh_failed';
  userMessage: string;
  diagnostic: string;
}

function classifyCredentialRefreshFailure(error: unknown): CredentialRefreshFailure {
  if (error instanceof HbuJwLoginError) {
    const diagnostic = clipDiagnostic(`${error.code}: ${error.diagnostic}`);
    if (error.category === 'credential') {
      return {
        resultKind: 'invalid',
        sessionStatus: 'invalid',
        credentialRejected: true,
        eventType: 'credential_refresh_rejected',
        userMessage: error.message,
        diagnostic,
      };
    }
    return {
      resultKind: 'unavailable',
      sessionStatus: 'expired',
      credentialRejected: false,
      eventType: error.category === 'interaction_required'
        ? 'credential_refresh_interaction_required'
        : 'credential_refresh_failed',
      userMessage: error.message,
      diagnostic,
    };
  }
  return {
    resultKind: 'unavailable',
    sessionStatus: 'expired',
    credentialRejected: false,
    eventType: 'credential_refresh_failed',
    userMessage: '教务自动续登出现内部错误，请联系管理员。',
    diagnostic: formatLoginFailureReason(error),
  };
}

function clipDiagnostic(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500);
}
