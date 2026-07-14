export interface ZyhSessionPayload {
  authorization: string;
  userId: string;
  platformId: string;
  secondClassSsoCode?: string;
}

export interface ZyhCredentialPayload {
  username: string;
  password: string;
}

export interface ZyhProfileInfo {
  avatar?: string | null;
  nickname?: string | null;
  real_name?: string | null;
  username?: string | null;
  zyzid?: string | null;
  mobile?: string | null;
  province?: string | null;
  city?: string | null;
  county?: string | null;
  province_name?: string | null;
  city_name?: string | null;
  county_name?: string | null;
  hours_system?: number | string | null;
  hours_history?: number | string | null;
  points?: number | string | null;
  [key: string]: unknown;
}

export interface ZyhProfile {
  info: ZyhProfileInfo;
  hoursSystem: number;
  hoursHistory: number;
  hoursTotal: number;
  points: number;
}

export interface ZyhActivity {
  id: string;
  title: string;
  departmentName: string;
  city: string;
  county: string;
  recruitStartTime?: number | null;
  recruitFinishTime?: number | null;
  signupPeople?: number | null;
  recruitPeople?: number | null;
  isFinished: boolean;
  statusText?: string | null;
}

export class ZyhApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ZyhApiError';
  }
}

export class ZyhSessionExpiredError extends ZyhApiError {
  constructor(message = '志愿汇登录态已失效。') {
    super(message, 'session_expired', 401);
    this.name = 'ZyhSessionExpiredError';
  }
}
