export const GENSHIN_SERVICE_ID = 'genshin';
export const GENSHIN_GAME_BIZ = 'hk4e_cn';

export const GENSHIN_GACHA_TYPES = ['100', '200', '301', '400', '302', '500'] as const;
export type GenshinGachaType = typeof GENSHIN_GACHA_TYPES[number];
export type GenshinUigfGachaType = '100' | '200' | '301' | '302' | '500';

export type GenshinBindChallengeStatus =
  | 'created'
  | 'qr_pending'
  | 'qr_scanned'
  | 'verifying'
  | 'role_selecting'
  | 'login_succeeded'
  | 'confirmed'
  | 'expired'
  | 'cancelled';

export type GenshinCookieFieldName =
  | 'stoken'
  | 'stuid'
  | 'mid'
  | 'ltoken'
  | 'ltoken_v2'
  | 'ltmid_v2'
  | 'ltuid_v2'
  | 'cookie_token'
  | 'cookie_token_v2'
  | 'account_id'
  | 'account_id_v2'
  | 'account_mid_v2'
  | 'login_uid'
  | 'ltuid';

export const GENSHIN_COOKIE_FIELD_NAMES: readonly GenshinCookieFieldName[] = [
  'stoken',
  'stuid',
  'mid',
  'ltoken',
  'ltoken_v2',
  'ltmid_v2',
  'ltuid_v2',
  'cookie_token',
  'cookie_token_v2',
  'account_id',
  'account_id_v2',
  'account_mid_v2',
  'login_uid',
  'ltuid',
];

export type GenshinCookieFields = Partial<Record<GenshinCookieFieldName, string>>;

export interface GenshinGameRole {
  uid: string;
  region: string;
  regionName: string;
  nickname: string;
  level: number | null;
  gameBiz: typeof GENSHIN_GAME_BIZ;
}

export interface GenshinCredentialPayload {
  cookies: GenshinCookieFields;
}

export type GenshinQrLoginStatus = 'Init' | 'Scanned' | 'Confirmed' | 'Expired';

export interface GenshinQrLoginTicket {
  url: string;
  ticket: string;
}

export interface GenshinQrLoginResult {
  status: GenshinQrLoginStatus;
  accountId?: string;
  gameToken?: string;
}

export interface GenshinBindChallenge {
  id: number;
  tokenHash: string;
  ownerKey: string;
  platform: string;
  qqUserId: string;
  channelId: string;
  status: GenshinBindChallengeStatus;
  verifyAttemptId?: string | null;
  qrTicket?: string | null;
  qrUrl?: string | null;
  confirmCodeHash?: string | null;
  pendingCredentialCipher?: string | null;
  pendingCredentialMeta?: string | null;
  pendingRolesJson?: string | null;
  selectedRoleJson?: string | null;
  errorMessage?: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface GenshinCredential {
  id: number;
  ownerKey: string;
  platform: string;
  qqUserId: string;
  serviceId: string;
  uid: string;
  region: string;
  regionName: string;
  nickname: string;
  level?: number | null;
  gameBiz: string;
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

export type GenshinSignInTrigger = 'manual' | 'auto';
export type GenshinOperationStatus = 'ok' | 'already_done' | 'failed';

export interface GenshinSignInRecord {
  id: number;
  ownerKey: string;
  uid: string;
  region: string;
  signDate: string;
  trigger: GenshinSignInTrigger;
  status: GenshinOperationStatus;
  retcode: number;
  message: string;
  createdAt: number;
}

export interface GenshinRedeemRecord {
  id: number;
  ownerKey: string;
  uid: string;
  region: string;
  cdkeyHash: string;
  status: GenshinOperationStatus;
  retcode: number;
  message: string;
  createdAt: number;
}

export interface GenshinGachaRecord {
  id: number;
  recordKey: string;
  ownerKey: string;
  uid: string;
  region: string;
  gachaType: GenshinGachaType;
  uigfGachaType: GenshinUigfGachaType;
  recordId: string;
  itemId: string;
  name: string;
  itemType: string;
  rankType: string;
  count: string;
  time: string;
  createdAt: number;
}

export interface GenshinGachaSyncState {
  id: number;
  syncKey: string;
  ownerKey: string;
  uid: string;
  region: string;
  gachaType: GenshinGachaType;
  lastSyncedAt: number;
  lastFetchedRecordId: string;
  lastNewCount: number;
  updatedAt: number;
}

export interface GenshinAuthAudit {
  id: number;
  ownerKey: string;
  eventType: string;
  status: string;
  reason?: string | null;
  createdAt: number;
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

export class GenshinUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenshinUserError';
  }
}
