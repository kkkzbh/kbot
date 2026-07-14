import type { CampusOwnerIdentity } from '../shared/campus-owner.js';

export type { CampusOwnerIdentity } from '../shared/campus-owner.js';

export const CAMPUS_AUTH_PROVIDER_ZYH = 'zyh';
export const CAMPUS_AUTH_PROVIDER_SECOND_CLASS = 'hbu-second-class';

export type CampusAuthProviderId =
  | typeof CAMPUS_AUTH_PROVIDER_ZYH
  | typeof CAMPUS_AUTH_PROVIDER_SECOND_CLASS;

export type CampusAuthMethod =
  | 'managed_credentials'
  | 'session_credentials'
  | 'session_import'
  | 'zyh_sso'
  | 'direct_credentials'
  | 'token_import';

export type CampusAuthChallengeStatus =
  | 'created'
  | 'authenticating'
  | 'user_action_required'
  | 'verified'
  | 'confirmed'
  | 'expired'
  | 'cancelled'
  | 'failed';

export type CampusAuthSessionStatus = 'active' | 'expired' | 'invalid' | 'revoked';

export interface CampusAuthChallenge {
  id: number;
  tokenHash: string;
  ownerKey: string;
  platform: string;
  qqUserId: string;
  channelId: string;
  providerId: CampusAuthProviderId;
  method?: CampusAuthMethod | null;
  status: CampusAuthChallengeStatus;
  attemptId?: string | null;
  attemptCount: number;
  confirmCodeHash?: string | null;
  pendingCipher?: string | null;
  pendingMeta?: string | null;
  pendingConfirmCodeCipher?: string | null;
  pendingConfirmCodeMeta?: string | null;
  errorMessage?: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface CampusAuthCredential {
  id: number;
  ownerKey: string;
  platform: string;
  qqUserId: string;
  providerId: CampusAuthProviderId;
  method: CampusAuthMethod;
  credentialCipher: string;
  credentialMeta: string;
  kekId: string;
  alg: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number | null;
  lastFailureReason?: string | null;
  revokedAt?: number | null;
}

export interface CampusAuthSession {
  id: number;
  ownerKey: string;
  platform: string;
  qqUserId: string;
  providerId: CampusAuthProviderId;
  method: CampusAuthMethod;
  sessionCipher: string;
  sessionMeta: string;
  status: CampusAuthSessionStatus;
  sourceProviderId?: CampusAuthProviderId | null;
  sourceCredentialId?: number | null;
  version: number;
  validatedAt: number;
  expiresAt?: number | null;
  lastRefreshAt?: number | null;
  lastFailureReason?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CampusAuthAudit {
  id: number;
  ownerKey: string;
  providerId: CampusAuthProviderId;
  eventType: string;
  status: string;
  reason?: string | null;
  createdAt: number;
}

export type CampusAuthDatabase = {
  get<T = Record<string, unknown>>(table: string, query: Record<string, unknown>): Promise<T[]>;
  set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<unknown>;
  create<T = Record<string, unknown>>(table: string, row: Record<string, unknown>): Promise<T>;
  remove(table: string, query: Record<string, unknown>): Promise<unknown>;
};

export interface CampusAuthFieldView {
  name: string;
  label: string;
  type: 'text' | 'password' | 'hidden' | 'checkbox' | 'captcha';
  required?: boolean;
  autocomplete?: string;
  help?: string;
  value?: string;
  imageDataUrl?: string;
}

export interface CampusAuthMethodView {
  id: CampusAuthMethod;
  label: string;
  description: string;
  fields: CampusAuthFieldView[];
}

export interface CampusAuthProviderAuthenticateInput {
  identity: CampusOwnerIdentity;
  method: CampusAuthMethod;
  fields: Readonly<Record<string, string>>;
}

export interface CampusAuthPendingResult {
  method: CampusAuthMethod;
  sessionPayload: unknown;
  credentialPayload?: unknown;
  sourceProviderId?: CampusAuthProviderId | null;
  sourceCredentialId?: number | null;
  expiresAt?: number | null;
  accountLabel?: string | null;
}

export interface CampusAuthProvider {
  id: CampusAuthProviderId;
  label: string;
  confirmCommandPrefix: string;
  getBindingMethods(): Promise<CampusAuthMethodView[]>;
  authenticate(input: CampusAuthProviderAuthenticateInput): Promise<CampusAuthPendingResult>;
}

export interface CampusAuthActiveSession<T = unknown> {
  row: CampusAuthSession;
  payload: T;
}

export interface CampusAuthActiveCredential<T = unknown> {
  row: CampusAuthCredential;
  payload: T;
}

export interface CampusAuthConfirmedBinding {
  providerId: CampusAuthProviderId;
  method: CampusAuthMethod;
  accountLabel?: string | null;
  sessionVersion: number;
}

export interface CampusAuthLifecycleEvent {
  ownerKey: string;
  providerId: CampusAuthProviderId;
  type: 'confirmed' | 'unbound';
  sessionVersion?: number;
  derivedProviderIds: CampusAuthProviderId[];
}

export type CampusAuthLifecycleListener = (event: CampusAuthLifecycleEvent) => void | Promise<void>;

export class CampusAuthUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CampusAuthUserError';
  }
}
