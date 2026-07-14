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
import { CampusAuthStore } from './store.js';
import type {
  CampusAuthActiveCredential,
  CampusAuthActiveSession,
  CampusAuthChallenge,
  CampusAuthConfirmedBinding,
  CampusAuthMethod,
  CampusAuthLifecycleListener,
  CampusAuthPendingResult,
  CampusAuthProvider,
  CampusAuthProviderId,
  CampusOwnerIdentity,
} from './types.js';
import { CampusAuthUserError } from './types.js';

const logger = new Logger('campus-auth-core');
const CURRENT_SCHEMA_VERSION = 1;

export interface CampusAuthRuntimeConfig {
  publicBaseUrl: string;
  bindPagePath: string;
  bindTokenTtlMs: number;
  maxBindingAttempts: number;
}

interface PendingConfirmCodePayload {
  confirmCode: string;
}

export interface CampusAuthBindPageState {
  challenge: CampusAuthChallenge;
  provider: CampusAuthProvider;
  state: 'form' | 'pending' | 'verified';
  confirmCode?: string;
}

export class CampusAuthService {
  private readonly providers = new Map<CampusAuthProviderId, CampusAuthProvider>();
  private readonly lifecycleListeners = new Set<CampusAuthLifecycleListener>();

  constructor(
    private readonly store: CampusAuthStore,
    private readonly kek: CredentialKek,
    private readonly config: CampusAuthRuntimeConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  registerProvider(provider: CampusAuthProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new Error(`campus auth provider is already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
    logger.info('campus auth provider registered: %s', provider.id);
    return () => this.providers.delete(provider.id);
  }

  registerLifecycleListener(listener: CampusAuthLifecycleListener): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  getProvider(providerId: CampusAuthProviderId): CampusAuthProvider {
    const provider = this.providers.get(providerId);
    if (!provider) throw new CampusAuthUserError('该校园账号模块尚未启用。');
    return provider;
  }

  async startBinding(identity: CampusOwnerIdentity, providerId: CampusAuthProviderId): Promise<{ link: string; expiresAt: number }> {
    this.getProvider(providerId);
    const now = this.now();
    await this.store.cleanupExpiredChallenges(now);
    await this.store.cancelActiveChallenges(identity.ownerKey, providerId, now);
    const token = createRandomToken();
    const expiresAt = now + this.config.bindTokenTtlMs;
    await this.store.createChallenge(identity, providerId, sha256Hex(token), expiresAt, now);
    await this.audit(identity.ownerKey, providerId, 'bind_started', 'ok');
    return {
      link: `${this.config.publicBaseUrl}${this.config.bindPagePath}?token=${encodeURIComponent(token)}`,
      expiresAt,
    };
  }

  async resolveBindPage(token: string): Promise<CampusAuthBindPageState> {
    const challenge = await this.requireUsableChallenge(token);
    const provider = this.getProvider(challenge.providerId);
    if (challenge.status === 'verified') {
      return {
        challenge,
        provider,
        state: 'verified',
        confirmCode: this.decryptPendingConfirmCode(challenge).confirmCode,
      };
    }
    if (challenge.status === 'authenticating') return { challenge, provider, state: 'pending' };
    return { challenge, provider, state: 'form' };
  }

  async submitBinding(token: string, method: CampusAuthMethod, fields: Readonly<Record<string, string>>): Promise<void> {
    const challenge = await this.requireUsableChallenge(token);
    if (challenge.status === 'verified') return;
    if (challenge.status === 'authenticating') throw new CampusAuthUserError('账号正在验证，请稍候。');
    if (!['created', 'failed', 'user_action_required'].includes(challenge.status)) {
      throw new CampusAuthUserError('当前绑定链接无法再次提交，请重新发起绑定。');
    }
    if (challenge.attemptCount >= this.config.maxBindingAttempts) {
      await this.store.clearChallengeSecrets(challenge.id, 'failed', this.now());
      throw new CampusAuthUserError('该绑定链接尝试次数已用完，请重新发起绑定。');
    }

    const provider = this.getProvider(challenge.providerId);
    const methodDefinition = (await provider.getBindingMethods()).find((candidate) => candidate.id === method);
    if (!methodDefinition) throw new CampusAuthUserError('所选绑定方式无效。');
    for (const field of methodDefinition.fields) {
      if (field.required && !fields[field.name]?.trim()) {
        throw new CampusAuthUserError(`请填写${field.label}。`);
      }
    }

    const attemptId = createRandomToken(16);
    const claimed = await this.store.claimChallenge(challenge.id, challenge.status, attemptId, this.now());
    if (!claimed) throw new CampusAuthUserError('绑定状态已经变化，请刷新页面。');

    try {
      const result = await provider.authenticate({
        identity: {
          ownerKey: claimed.ownerKey,
          platform: claimed.platform,
          qqUserId: claimed.qqUserId,
          channelId: claimed.channelId,
        },
        method,
        fields,
      });
      if (result.method !== method) throw new Error('campus auth provider returned a mismatched auth method.');
      const pending = encryptEnvelopeJson(result, pendingAad(claimed), this.kek);
      const confirmCode = createConfirmCode();
      const encryptedConfirmCode = encryptEnvelopeJson(
        { confirmCode } satisfies PendingConfirmCodePayload,
        pendingConfirmCodeAad(claimed),
        this.kek,
      );
      const completed = await this.store.completeChallenge(claimed.id, attemptId, method, {
        confirmCodeHash: hashConfirmCode(claimed, confirmCode),
        pendingCipher: pending.cipherText,
        pendingMeta: pending.meta,
        pendingConfirmCodeCipher: encryptedConfirmCode.cipherText,
        pendingConfirmCodeMeta: encryptedConfirmCode.meta,
      }, this.now());
      if (!completed) throw new CampusAuthUserError('绑定状态已经变化，请重新发起绑定。');
      await this.audit(claimed.ownerKey, claimed.providerId, 'provider_login_succeeded', 'ok');
    } catch (error) {
      const reason = diagnostic(error);
      await this.store.failChallenge(claimed.id, attemptId, reason, this.now());
      await this.audit(claimed.ownerKey, claimed.providerId, 'provider_login_failed', 'failed', reason);
      if (error instanceof CampusAuthUserError) throw error;
      logger.warn('campus auth provider login failed: provider=%s owner=%s reason=%s', claimed.providerId, claimed.ownerKey, reason);
      throw new CampusAuthUserError('账号验证失败，请检查输入后重试。');
    }
  }

  async confirmBinding(
    identity: CampusOwnerIdentity,
    providerId: CampusAuthProviderId,
    confirmCode: string,
  ): Promise<CampusAuthConfirmedBinding> {
    const now = this.now();
    await this.store.cleanupExpiredChallenges(now);
    const challenge = await this.store.findVerifiedChallenge(identity.ownerKey, providerId);
    if (!challenge) throw new CampusAuthUserError('没有待确认的绑定流程。');
    if (challenge.channelId !== identity.channelId) {
      throw new CampusAuthUserError('请回到发起绑定的原会话发送确认码。');
    }
    if (!challenge.confirmCodeHash || !constantTimeEqualHex(challenge.confirmCodeHash, hashConfirmCode(challenge, confirmCode.trim()))) {
      throw new CampusAuthUserError('确认码不正确。');
    }
    if (!challenge.method || !challenge.pendingCipher || !challenge.pendingMeta) {
      throw new Error('verified campus auth challenge is missing encrypted pending state.');
    }
    const pending = decryptEnvelopeJson<CampusAuthPendingResult>(
      challenge.pendingCipher,
      challenge.pendingMeta,
      pendingAad(challenge),
      this.kek,
    );
    if (pending.method !== challenge.method) throw new Error('campus auth pending method does not match challenge method.');

    const derived = await this.store.removeDerivedSessions(identity.ownerKey, providerId);
    await this.store.revokeCredential(identity.ownerKey, providerId, now);
    if (pending.credentialPayload !== undefined) {
      const credentialRow = await this.store.createCredentialPlaceholder(identity, providerId, pending.method, this.kek.id, now);
      const encryptedCredential = encryptEnvelopeJson(
        pending.credentialPayload,
        credentialAad(identity.ownerKey, providerId, credentialRow.id),
        this.kek,
      );
      await this.store.updateCredentialEnvelope(credentialRow, encryptedCredential.cipherText, encryptedCredential.meta, now);
    }
    const session = await this.replaceSession(
      identity,
      providerId,
      pending.method,
      pending.sessionPayload,
      {
        sourceProviderId: pending.sourceProviderId ?? null,
        sourceCredentialId: pending.sourceCredentialId ?? null,
        expiresAt: pending.expiresAt ?? null,
      },
    );
    await this.store.clearChallengeSecrets(challenge.id, 'confirmed', now);
    await this.audit(identity.ownerKey, providerId, 'bind_confirmed', 'ok');
    await this.emitLifecycle({
      ownerKey: identity.ownerKey,
      providerId,
      type: 'confirmed',
      sessionVersion: session.row.version,
      derivedProviderIds: derived.map((row) => row.providerId),
    });
    return {
      providerId,
      method: pending.method,
      accountLabel: pending.accountLabel,
      sessionVersion: session.row.version,
    };
  }

  async getStatus(ownerKey: string, providerId: CampusAuthProviderId): Promise<{ status: string; method?: CampusAuthMethod; version?: number }> {
    await this.store.cleanupExpiredChallenges(this.now());
    const session = await this.store.getSession(ownerKey, providerId);
    if (session) {
      if (session.status === 'active') return { status: '已绑定', method: session.method, version: session.version };
      if (session.status === 'expired') return { status: '登录态已过期，需要重新验证', method: session.method, version: session.version };
      if (session.status === 'invalid') return { status: '凭据已失效，需要重新绑定', method: session.method, version: session.version };
    }
    const challenges = await this.store.findActiveChallenges(ownerKey, providerId);
    if (challenges.some((row) => row.status === 'verified')) return { status: '绑定流程待确认' };
    if (challenges.some((row) => row.status === 'authenticating')) return { status: '正在验证账号' };
    if (challenges.length) return { status: '等待网页提交' };
    return { status: '未绑定' };
  }

  async getActiveSession<T>(ownerKey: string, providerId: CampusAuthProviderId): Promise<CampusAuthActiveSession<T> | null> {
    const row = await this.store.getSession(ownerKey, providerId);
    if (!row || row.status !== 'active' || !row.sessionCipher || !row.sessionMeta) return null;
    return {
      row,
      payload: decryptEnvelopeJson<T>(row.sessionCipher, row.sessionMeta, sessionAad(ownerKey, providerId, row.id), this.kek),
    };
  }

  async getActiveCredential<T>(ownerKey: string, providerId: CampusAuthProviderId): Promise<CampusAuthActiveCredential<T> | null> {
    const row = await this.store.getActiveCredential(ownerKey, providerId);
    if (!row || !row.credentialCipher || !row.credentialMeta) return null;
    return {
      row,
      payload: decryptEnvelopeJson<T>(row.credentialCipher, row.credentialMeta, credentialAad(ownerKey, providerId, row.id), this.kek),
    };
  }

  async replaceSession<T>(
    identity: CampusOwnerIdentity,
    providerId: CampusAuthProviderId,
    method: CampusAuthMethod,
    payload: T,
    options: { sourceProviderId?: CampusAuthProviderId | null; sourceCredentialId?: number | null; expiresAt?: number | null; rotateVersion?: boolean } = {},
  ): Promise<CampusAuthActiveSession<T>> {
    const now = this.now();
    const row = await this.store.upsertSessionPlaceholder(
      identity,
      providerId,
      method,
      options.sourceProviderId ?? null,
      options.sourceCredentialId ?? null,
      options.expiresAt ?? null,
      now,
      options.rotateVersion ?? true,
    );
    const encrypted = encryptEnvelopeJson(payload, sessionAad(identity.ownerKey, providerId, row.id), this.kek);
    await this.store.updateSessionEnvelope(row, encrypted.cipherText, encrypted.meta, now);
    const updated = await this.store.getSession(identity.ownerKey, providerId);
    if (!updated) throw new Error('campus auth session missing after replacement.');
    return { row: updated, payload };
  }

  markSessionValidated(ownerKey: string, providerId: CampusAuthProviderId): Promise<void> {
    return this.store.markSessionValidated(ownerKey, providerId, this.now());
  }

  cleanupExpiredChallenges(): Promise<void> {
    return this.store.cleanupExpiredChallenges(this.now());
  }

  markSessionInvalid(ownerKey: string, providerId: CampusAuthProviderId, reason: string): Promise<void> {
    return this.store.setSessionStatus(ownerKey, providerId, 'invalid', diagnostic(reason), this.now());
  }

  markCredentialUsed(id: number): Promise<void> {
    return this.store.markCredentialUsed(id, this.now());
  }

  markCredentialFailure(id: number, reason: string): Promise<void> {
    return this.store.markCredentialFailure(id, diagnostic(reason), this.now());
  }

  async unbind(identity: CampusOwnerIdentity, providerId: CampusAuthProviderId): Promise<void> {
    const now = this.now();
    const derived = await this.store.removeDerivedSessions(identity.ownerKey, providerId);
    await this.store.removeSession(identity.ownerKey, providerId);
    await this.store.revokeCredential(identity.ownerKey, providerId, now);
    await this.store.cancelActiveChallenges(identity.ownerKey, providerId, now);
    await this.audit(identity.ownerKey, providerId, 'unbind', 'ok');
    await this.emitLifecycle({
      ownerKey: identity.ownerKey,
      providerId,
      type: 'unbound',
      derivedProviderIds: derived.map((row) => row.providerId),
    });
  }

  private async requireUsableChallenge(token: string): Promise<CampusAuthChallenge> {
    const normalized = token.trim();
    if (!normalized) throw new CampusAuthUserError('绑定链接无效。');
    const challenge = await this.store.findChallengeByTokenHash(sha256Hex(normalized));
    if (!challenge) throw new CampusAuthUserError('绑定链接无效，请重新发起绑定。');
    if (challenge.expiresAt <= this.now()) {
      await this.store.clearChallengeSecrets(challenge.id, 'expired', this.now());
      throw new CampusAuthUserError('绑定链接已过期，请重新发起绑定。');
    }
    if (['confirmed', 'expired', 'cancelled'].includes(challenge.status)) {
      throw new CampusAuthUserError('绑定链接已失效，请重新发起绑定。');
    }
    return challenge;
  }

  private decryptPendingConfirmCode(challenge: CampusAuthChallenge): PendingConfirmCodePayload {
    if (!challenge.pendingConfirmCodeCipher || !challenge.pendingConfirmCodeMeta) {
      throw new Error('verified campus auth challenge is missing confirmation code.');
    }
    return decryptEnvelopeJson<PendingConfirmCodePayload>(
      challenge.pendingConfirmCodeCipher,
      challenge.pendingConfirmCodeMeta,
      pendingConfirmCodeAad(challenge),
      this.kek,
    );
  }

  private audit(ownerKey: string, providerId: CampusAuthProviderId, eventType: string, status: string, reason: string | null = null): Promise<unknown> {
    return this.store.audit({ ownerKey, providerId, eventType, status, reason, createdAt: this.now() });
  }

  private async emitLifecycle(event: Parameters<CampusAuthLifecycleListener>[0]): Promise<void> {
    for (const listener of this.lifecycleListeners) await listener(event);
  }
}

function challengeNamespace(challenge: Pick<CampusAuthChallenge, 'id' | 'ownerKey' | 'providerId'>): string {
  return `${challenge.providerId}:${challenge.ownerKey}:${challenge.id}`;
}

function pendingAad(challenge: Pick<CampusAuthChallenge, 'id' | 'ownerKey' | 'providerId'>): string {
  return `campus-auth:pending:v${CURRENT_SCHEMA_VERSION}:${challengeNamespace(challenge)}`;
}

function pendingConfirmCodeAad(challenge: Pick<CampusAuthChallenge, 'id' | 'ownerKey' | 'providerId'>): string {
  return `campus-auth:confirm:v${CURRENT_SCHEMA_VERSION}:${challengeNamespace(challenge)}`;
}

function credentialAad(ownerKey: string, providerId: CampusAuthProviderId, id: number): string {
  return `campus-auth:credential:v${CURRENT_SCHEMA_VERSION}:${providerId}:${ownerKey}:${id}`;
}

function sessionAad(ownerKey: string, providerId: CampusAuthProviderId, id: number): string {
  return `campus-auth:session:v${CURRENT_SCHEMA_VERSION}:${providerId}:${ownerKey}:${id}`;
}

function hashConfirmCode(challenge: Pick<CampusAuthChallenge, 'id' | 'ownerKey' | 'providerId'>, code: string): string {
  return sha256Hex(`${challengeNamespace(challenge)}:${code}`);
}

export function diagnostic(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\b(password|authorization|token|cookie|captcha|confirmCode)(["']?\s*[:=]\s*["']?)([^\s,"'}&]+)/gi, '$1$2<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}
