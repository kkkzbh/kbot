import { Logger } from 'koishi';
import { HbuJwLoginError, type HbuJwHttpClient } from './jw-client.js';
import {
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
  type HbuJwKek,
} from './crypto.js';
import { HbuJwStore } from './store.js';
import {
  HBU_JW_SERVICE_ID,
  HbuJwUserError,
  type HbuJwBindChallenge,
  type HbuJwCredentialPayload,
  type OwnerIdentity,
  type SerializedCookieJar,
} from './types.js';

const logger = new Logger('hbu-jw');

export interface HbuJwRuntimeConfig {
  bindPagePath: string;
  publicBaseUrl: string;
  bindTokenTtlMs: number;
  autoReloginEnabled: boolean;
}

export interface StartBindingResult {
  link: string;
  expiresAt: number;
}

export interface BindPageChallenge {
  token: string;
  qqUserId: string;
  state: 'form' | 'pending' | 'success';
  confirmCode?: string;
}

export interface SubmitCredentialsResult {
  qqUserId: string;
  confirmCode: string;
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
    if (challenge.status === 'login_succeeded') {
      const payload = this.decryptPendingConfirmCode(challenge);
      return {
        token,
        qqUserId: challenge.qqUserId,
        state: 'success',
        confirmCode: payload.confirmCode,
      };
    }
    if (challenge.status === 'login_pending') {
      return {
        token,
        qqUserId: challenge.qqUserId,
        state: 'pending',
      };
    }
    return {
      token,
      qqUserId: challenge.qqUserId,
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
      const login = await this.jwClient.login(username, args.password);
      const cookieJarCipher = encryptSelfContainedJson(login.cookieJar, cookieAad(claimedChallenge.ownerKey), this.kek);
      const credential = encryptEnvelopeJson(
        { username, password: args.password } satisfies HbuJwCredentialPayload,
        pendingCredentialAad(claimedChallenge),
        this.kek,
      );
      const confirmCode = createConfirmCode();
      const pendingConfirmCode = encryptEnvelopeJson(
        { confirmCode } satisfies PendingConfirmCodePayload,
        pendingConfirmCodeAad(claimedChallenge),
        this.kek,
      );
      const completed = await this.store.completeChallengeLogin(claimedChallenge.id, loginAttemptId, {
        status: 'login_succeeded',
        confirmCodeHash: hashConfirmCode(claimedChallenge, confirmCode),
        pendingConfirmCodeCipher: pendingConfirmCode.cipherText,
        pendingConfirmCodeMeta: pendingConfirmCode.meta,
        pendingCookieJarCipher: cookieJarCipher,
        pendingCredentialCipher: credential.cipherText,
        pendingCredentialMeta: credential.meta,
        errorMessage: null,
        updatedAt: now,
      });
      if (!completed) {
        throw new HbuJwUserError('该绑定链接状态已变化，请重新发送“教务绑定”生成新链接。');
      }
      await this.audit(claimedChallenge.ownerKey, 'jw_login_succeeded', 'ok');
      return {
        qqUserId: claimedChallenge.qqUserId,
        confirmCode,
      };
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
    await this.store.replaceSession(identity, challenge.pendingCookieJarCipher, 'active', now);
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
    if (challenges.some((challenge) => challenge.status === 'login_pending')) return '正在验证教务账号密码';
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

    try {
      const credentialPayload = decryptEnvelopeJson<HbuJwCredentialPayload>(
        credential.credentialCipher,
        credential.credentialMeta,
        credentialAad(identity.ownerKey, HBU_JW_SERVICE_ID, credential.id),
        this.kek,
      );
      const login = await this.jwClient.login(credentialPayload.username, credentialPayload.password);
      const cookieJarCipher = encryptSelfContainedJson(login.cookieJar, cookieAad(identity.ownerKey), this.kek);
      await this.store.replaceSession(identity, cookieJarCipher, 'active', now);
      await this.store.markCredentialUsed(credential.id, now);
      await this.audit(identity.ownerKey, 'credential_refresh_succeeded', 'ok');
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

  async runKeepAlive(recentUseWindowMs: number): Promise<void> {
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
    return {
      qqUserId: challenge.qqUserId,
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
