export interface SecondClassSessionPayload {
  token: string;
  schoolId: string;
  schoolName: string;
  studentNo: string;
  accountName: string;
}

export interface SecondClassUserInfo {
  raw: Record<string, unknown>;
  schoolId: string;
  schoolName: string;
  studentNo: string;
  accountName: string;
  phone: string;
}

export interface SecondClassCaptcha {
  uuid: string;
  imageDataUrl: string;
}

export interface SecondClassLoginInput {
  loginName: string;
  password: string;
  captchaCode: string;
  captchaUuid: string;
}

export interface SecondClassCredentialPayload {
  loginName: string;
  password: string;
}

export type SecondClassReauthStatus = 'waiting' | 'verifying';

export interface SecondClassReauthChallenge {
  id: number;
  ownerKey: string;
  platform: string;
  qqUserId: string;
  channelId: string;
  credentialId: number;
  captchaUuid: string;
  status: SecondClassReauthStatus;
  attemptId?: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface SecondClassPage {
  rows: Record<string, unknown>[];
  total: number | null;
  raw: unknown;
}

export type SecondClassSignOperation = 'sign_in' | 'sign_out';

export interface SecondClassSignCodeInfo {
  activityId: string;
  activityName: string;
  activityType: number;
  locationRequired: boolean;
  operation: SecondClassSignOperation;
}

export interface SecondClassSignLocation {
  latitude: number;
  longitude: number;
  radius: number;
  address: string;
}

export interface SecondClassSignResult {
  operation: SecondClassSignOperation;
  signType: number | null;
  message: string;
}

export interface SecondClassQuerySnapshot<T = unknown> {
  data: T;
  source: 'remote' | 'database';
  fetchedAt: number;
  failureReason?: string;
}

export class SecondClassApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SecondClassApiError';
  }
}

export class SecondClassSessionExpiredError extends SecondClassApiError {
  constructor(message = '二课登录态已失效。') {
    super(message, 401, 401);
    this.name = 'SecondClassSessionExpiredError';
  }
}
