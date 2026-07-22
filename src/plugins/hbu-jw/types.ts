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
  pendingConfirmCodeCipher?: string | null;
  pendingConfirmCodeMeta?: string | null;
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

export type HbuJwAcademicDataKind =
  | 'subitem_term'
  | 'passing_score'
  | 'term_score'
  | 'subitem_detail'
  | 'course_selection_result'
  | 'schedule_header'
  | 'schedule_course'
  | 'exam_event';

export interface HbuJwAcademicSyncState {
  id: number;
  syncKey: string;
  ownerKey: string;
  credentialVersion: number;
  dataKind: HbuJwAcademicDataKind;
  scopeKey: string;
  lastAttemptedAt: number;
  lastSucceededAt?: number | null;
  lastFailureReason?: string | null;
  rowCount: number;
  sourceHash?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface HbuJwAcademicItem {
  id: number;
  recordKey: string;
  ownerKey: string;
  credentialVersion: number;
  dataKind: HbuJwAcademicDataKind;
  scopeKey: string;
  position: number;
  rawJson: string;
  sourceHash: string;
  fetchedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface SerializedCookieJar {
  version: 1;
  transport: 'direct' | 'broker';
  cookies: Array<{
    name: string;
    value: string;
  }>;
}

export interface HbuJwScoreRow {
  id?: {
    courseNumber?: string | null;
    coureSequenceNumber?: string | null;
    executiveEducationPlanNumber?: string | null;
    startTime?: string | null;
    studentId?: string | null;
    [key: string]: unknown;
  } | null;
  courseName?: string | null;
  credit?: string | number | null;
  courseScore?: string | number | null;
  gradePointScore?: string | number | null;
  courseAttributeCode?: string | null;
  courseAttributeName?: string | null;
  xkcsxdm?: string | null;
  xkcsxmc?: string | null;
  academicYearCode?: string | null;
  termName?: string | null;
  examTime?: string | null;
  avgcj?: string | number | null;
  rank?: string | number | null;
  operatingTime?: string | null;
  [key: string]: unknown;
}

export interface HbuJwThisTermScoreRow {
  id?: {
    courseNumber?: string | null;
    executiveEducationPlanNumber?: string | null;
    examtime?: string | null;
    studentNumber?: string | null;
    [key: string]: unknown;
  } | null;
  coureSequenceNumber?: string | null;
  courseName?: string | null;
  credit?: string | number | null;
  coursePropertyCode?: string | null;
  coursePropertyName?: string | null;
  courseScore?: string | number | null;
  gradePoint?: string | number | null;
  levelName?: string | null;
  examTypeName?: string | null;
  inputMethodCode?: string | null;
  inputStatusCode?: string | null;
  inputStatusExplain?: string | null;
  maxcj?: string | number | null;
  mincj?: string | number | null;
  avgcj?: string | number | null;
  rank?: string | number | null;
  unpassedReasonExplain?: string | null;
  englishCourseName?: string | null;
  termName?: string | null;
  operatetime?: string | null;
  remark?: string | null;
  [key: string]: unknown;
}

export interface HbuJwSubitemScoreTerm {
  code: string;
  label: string;
  selected: boolean;
}

export interface HbuJwSubitemScoreLookParams {
  zxjxjhh: string;
  kch: string;
  kxh: string;
  kssj: string;
  kcsxdm: string;
}

export interface HbuJwSubitemScoreDetailRow {
  id?: {
    executiveEducationPlanNumber?: string | null;
    courseNumber?: string | null;
    studentNumber?: string | null;
    examtime?: string | null;
    scoreTypeCode?: string | null;
    [key: string]: unknown;
  } | null;
  coureSequenceNumber?: string | null;
  zcj?: string | number | null;
  pscj?: string | number | null;
  qzcj?: string | number | null;
  qmcj?: string | number | null;
  remark?: string | null;
  [key: string]: unknown;
}

export interface HbuJwSubitemScoreLookResult {
  params: HbuJwSubitemScoreLookParams;
  rows: HbuJwSubitemScoreDetailRow[];
  message: string;
}

export interface HbuJwExamPlanEvent {
  title?: string | null;
  start?: string | null;
  color?: string | null;
  [key: string]: unknown;
}

export interface HbuJwScheduleTimeAndPlace {
  classDay: number;
  classSessions: number;
  continuingSession: number;
  classWeek: string;
  weekDescription: string;
  campusName: string;
  teachingBuildingName: string;
  classroomName: string;
}

export interface HbuJwScheduleCourse {
  courseNumber: string;
  sequenceNumber: string;
  executiveEducationPlanNumber: string;
  courseName: string;
  unit: number;
  coursePropertiesName: string;
  courseCategoryName: string;
  examTypeName: string;
  teacherName: string;
  selectCourseStatusName: string;
  timeAndPlaceList: HbuJwScheduleTimeAndPlace[];
}

export interface HbuJwThisSemesterSchedule {
  executiveEducationPlanNumber: string;
  programPlanName: string;
  totalUnits: number;
  courses: HbuJwScheduleCourse[];
}

export interface HbuJwCourseSelectionCourse {
  courseNumber: string;
  sequenceNumber: string;
  executiveEducationPlanNumber: string;
  courseName: string;
  unit: number;
  coursePropertiesName: string;
  courseCategoryName: string;
  examTypeName: string;
  teacherName: string;
  studyModeName: string;
  selectCourseStatusName: string;
  restrictedCondition: string;
  courseSelectionTime: string;
  timeAndPlaceList: HbuJwScheduleTimeAndPlace[];
}

export interface HbuJwCourseSelectionGroup {
  programPlanCode: string;
  programPlanName: string;
  totalUnits: number;
  courses: HbuJwCourseSelectionCourse[];
}

export interface HbuJwCourseSelectionResult {
  totalUnits: number;
  groups: HbuJwCourseSelectionGroup[];
}

export interface HbuJwStudentPlanProfile {
  majorName: string;
  cohortYear: number;
  planNumber: string | null;
  planDetailPath: string | null;
}

export interface HbuJwTrainingPlanCategory {
  code: string;
  name: string;
  requiredCredits: number;
}

export type HbuJwTrainingPlanCourseAttribute = 'required' | 'limited' | 'elective';

export interface HbuJwTrainingPlanCourse {
  courseNumber: string;
  courseName: string;
  categoryCode: string;
  categoryName: string;
  attribute: HbuJwTrainingPlanCourseAttribute;
  credits: number | null;
  replacementCourseNumbers: string[];
}

export interface HbuJwTrainingPlanSnapshot {
  planNumber: string;
  planName: string;
  majorCode: string;
  majorName: string;
  cohortYear: number;
  requiredCredits: number;
  categories: HbuJwTrainingPlanCategory[];
  courses: HbuJwTrainingPlanCourse[];
}

export interface HbuJwTrainingPlanCacheRow {
  id: number;
  planNumber: string;
  majorCode: string;
  majorName: string;
  cohortYear: number;
  planName: string;
  snapshotJson: string;
  sourceHash: string;
  syncedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface HbuJwCourseOfferingMeeting {
  classWeek: string;
  weekday: number;
  startSection: number;
  sectionCount: number;
  campusName: string;
  teachingBuildingName: string;
  classroomName: string;
}

export interface HbuJwCourseOffering {
  executionPlanNumber: string;
  courseNumber: string;
  sequenceNumber: string;
  courseName: string;
  credits: number;
  courseAttributeCode: string;
  courseAttributeName: string;
  categoryCode: string;
  categoryName: string;
  planCategoryCode: string;
  planCategoryName: string;
  teacherName: string;
  capacity: number;
  remainingSeats: number;
  meetings: HbuJwCourseOfferingMeeting[];
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
  upsert(table: string, rows: Array<Record<string, unknown>>, keys?: string[]): Promise<unknown>;
  remove(table: string, query: Record<string, unknown>): Promise<unknown>;
};

export class HbuJwUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HbuJwUserError';
  }
}
