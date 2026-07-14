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

export interface SecondClassPage {
  rows: Record<string, unknown>[];
  total: number | null;
  raw: unknown;
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
