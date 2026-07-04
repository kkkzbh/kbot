export const HBU_JW_SERVICE_ID = 'hbu-jw';

export type BindChallengeStatus = 'created' | 'login_pending' | 'login_succeeded' | 'confirmed' | 'expired' | 'cancelled';
export type HbuJwSessionStatus = 'active' | 'expired' | 'invalid';

export interface HbuJwBindChallenge {
  id: number;
  tokenHash: string;
  ownerKey: string;
  platform: string;
  qqUserId: string;
  channelId: string;
  status: BindChallengeStatus;
  loginAttemptId?: string | null;
  confirmCodeHash?: string | null;
  pendingCookieJarCipher?: string | null;
  pendingCredentialCipher?: string | null;
  pendingCredentialMeta?: string | null;
  errorMessage?: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface HbuJwSession {
  id: number;
  ownerKey: string;
  platform: string;
  qqUserId: string;
  cookieJarCipher: string;
  status: HbuJwSessionStatus;
  validatedAt: number;
  lastRefreshAt?: number | null;
  lastFailureReason?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface HbuJwCredential {
  id: number;
  ownerKey: string;
  platform: string;
  qqUserId: string;
  serviceId: string;
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

export interface HbuJwAuthAudit {
  id: number;
  ownerKey: string;
  eventType: string;
  status: string;
  reason?: string | null;
  createdAt: number;
}

export interface SerializedCookieJar {
  cookies: Array<{
    name: string;
    value: string;
  }>;
}

export interface HbuJwScoreRow {
  id?: {
    courseNumber?: string | null;
    [key: string]: unknown;
  } | null;
  courseName?: string | null;
  credit?: string | number | null;
  gradePointScore?: string | number | null;
  courseAttributeCode?: string | null;
  courseAttributeName?: string | null;
  academicYearCode?: string | null;
  termName?: string | null;
  [key: string]: unknown;
}

export interface HbuJwCredentialPayload {
  username: string;
  password: string;
}

export interface OwnerIdentity {
  ownerKey: string;
  platform: string;
  qqUserId: string;
  channelId: string;
}

export type DatabaseLike = {
  get<T = Record<string, unknown>>(table: string, query: Record<string, unknown>): Promise<T[]>;
  set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<unknown>;
  create<T = Record<string, unknown>>(table: string, row: Record<string, unknown>): Promise<T>;
  remove(table: string, query: Record<string, unknown>): Promise<unknown>;
};

export class HbuJwUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HbuJwUserError';
  }
}
