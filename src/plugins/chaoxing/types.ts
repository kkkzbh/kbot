export const CHAOXING_SERVICE_ID = 'chaoxing';

export type ChaoxingBindStatus =
  | 'created'
  | 'qr_pending'
  | 'qr_scanned'
  | 'login_pending'
  | 'login_succeeded'
  | 'confirmed'
  | 'expired'
  | 'cancelled';

export type ChaoxingSessionStatus = 'active' | 'expired' | 'invalid';
export type ChaoxingTaskKind = 'work' | 'exam' | 'sign';
export type ChaoxingJobType = 'study' | 'sign_watch' | 'answer';
export type ChaoxingJobStatus =
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type ChaoxingQuestionType = 'single' | 'multiple' | 'judgement' | 'completion';

export interface ChaoxingCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  expiresAt?: number | null;
}

export interface SerializedChaoxingCookieJar {
  cookies: ChaoxingCookie[];
}

export interface ChaoxingProfile {
  uid: string;
  puid: string;
  fid: string;
  name: string;
  schoolName: string;
  username?: string;
  deviceCode?: string;
}

export interface ChaoxingBindChallenge {
  id: number;
  tokenHash: string;
  ownerKey: string;
  platform: string;
  qqUserId: string;
  channelId: string;
  status: ChaoxingBindStatus;
  bindingMode?: 'qr' | 'password' | null;
  qrUuid?: string | null;
  qrEnc?: string | null;
  loginAttemptId?: string | null;
  confirmCodeHash?: string | null;
  pendingConfirmCodeCipher?: string | null;
  pendingConfirmCodeMeta?: string | null;
  pendingCookieJarCipher?: string | null;
  pendingCredentialCipher?: string | null;
  pendingCredentialMeta?: string | null;
  pendingProfileJson?: string | null;
  errorMessage?: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChaoxingSession {
  id: number;
  ownerKey: string;
  platform: string;
  qqUserId: string;
  channelId: string;
  cookieJarCipher: string;
  profileJson: string;
  status: ChaoxingSessionStatus;
  credentialVersion?: number | null;
  validatedAt: number;
  lastRefreshAt?: number | null;
  lastFailureReason?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChaoxingCredential {
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

export interface ChaoxingCredentialPayload {
  username: string;
  password: string;
}

export interface ChaoxingAuthAudit {
  id: number;
  ownerKey: string;
  eventType: string;
  status: string;
  reason?: string | null;
  createdAt: number;
}

export interface ChaoxingCourse {
  courseId: string;
  classId: string;
  cpi: string;
  name: string;
  className: string;
  teacherName: string;
  schoolName: string;
  imageUrl: string;
  state: number;
  isRetired: number;
}

export interface ChaoxingCourseRow extends ChaoxingCourse {
  id: number;
  recordKey: string;
  ownerKey: string;
  credentialVersion: number;
  sourceJson: string;
  firstSeenAt: number;
  lastSeenAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChaoxingChapter {
  chapterId: string;
  courseId: string;
  classId: string;
  title: string;
  position: number;
  enc: string;
  courseOrigin: string;
}

export interface ChaoxingActivity {
  activityId: string;
  courseId: string;
  classId: string;
  title: string;
  activityType: number;
  signTypeCode: string;
  status: number;
  userStatus?: number | null;
  startAt?: number | null;
  endAt?: number | null;
  ext: string;
  raw: Record<string, unknown>;
}

export interface ChaoxingDeadlineItem {
  recordKey: string;
  kind: ChaoxingTaskKind;
  courseId: string;
  classId: string;
  remoteId: string;
  courseName: string;
  title: string;
  status: string;
  startAt?: number | null;
  endAt?: number | null;
  score?: string | null;
  source: Record<string, unknown>;
}

export interface ChaoxingTaskRow extends Omit<ChaoxingDeadlineItem, 'source'> {
  id: number;
  ownerKey: string;
  credentialVersion: number;
  sourceJson: string;
  sourceHash: string;
  firstSeenAt: number;
  lastSeenAt: number;
  notifiedAt?: number | null;
  remindedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChaoxingJob {
  id: number;
  ownerKey: string;
  platform: string;
  qqUserId: string;
  channelId: string;
  type: ChaoxingJobType;
  status: ChaoxingJobStatus;
  courseId?: string | null;
  classId?: string | null;
  courseQuery?: string | null;
  payloadJson: string;
  progressJson: string;
  resultJson?: string | null;
  errorMessage?: string | null;
  runAfter: number;
  lockedAt?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChaoxingJobEvent {
  id: number;
  jobId: number;
  ownerKey: string;
  eventType: string;
  detailJson: string;
  createdAt: number;
}

export interface ChaoxingSignRecord {
  id: number;
  ownerKey: string;
  jobId?: number | null;
  activityId: string;
  courseId: string;
  classId: string;
  signType: string;
  status: string;
  requestJson: string;
  responseText: string;
  createdAt: number;
}

export interface ChaoxingQuestionOption {
  key: string;
  text: string;
}

export interface ChaoxingQuestion {
  id: string;
  position: number;
  type: ChaoxingQuestionType;
  typeCode: string;
  title: string;
  options: ChaoxingQuestionOption[];
  answerFields: string[];
}

export interface ChaoxingAnswerCandidate {
  answer: string;
  source: string;
  confidence: number;
}

export interface ChaoxingAnswerCache {
  id: number;
  answerKey: string;
  questionType: ChaoxingQuestionType;
  title: string;
  optionsJson: string;
  answer: string;
  source: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChaoxingAnswerRecord {
  id: number;
  ownerKey: string;
  jobId: number;
  workId: string;
  questionId: string;
  questionType: ChaoxingQuestionType;
  title: string;
  answer: string;
  source: string;
  confidence: number;
  submitMode: 'save' | 'submit';
  resultStatus: string;
  resultMessage: string;
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

export class ChaoxingUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChaoxingUserError';
  }
}

export class ChaoxingProtocolError extends Error {
  readonly code: string;
  readonly responseExcerpt?: string;

  constructor(code: string, message: string, responseExcerpt?: string) {
    super(message);
    this.name = 'ChaoxingProtocolError';
    this.code = code;
    this.responseExcerpt = responseExcerpt;
  }
}

export class ChaoxingAuthError extends ChaoxingUserError {
  constructor(message = '学习通登录态已失效，请重新绑定。') {
    super(message);
    this.name = 'ChaoxingAuthError';
  }
}

export class ChaoxingCaptchaRequiredError extends ChaoxingUserError {
  readonly responseExcerpt?: string;

  constructor(message = '学习通要求完成验证码，任务已暂停。', responseExcerpt?: string) {
    super(message);
    this.name = 'ChaoxingCaptchaRequiredError';
    this.responseExcerpt = responseExcerpt;
  }
}
