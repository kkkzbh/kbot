import { h, type Fragment } from 'koishi';
import type { HbuJwHttpClient } from './jw-client.js';
import { HbuJwUserError, type HbuJwScoreRow, type OwnerIdentity, type SerializedCookieJar } from './types.js';

const REQUIRED_ATTRIBUTE_CODE = '001';
const REQUIRED_ATTRIBUTE_NAME = '必修';

const FIXED_EXCLUDED_COURSE_NAMES = new Set([
  '大学生职业生涯规划',
  '创业基础',
  '大学生心理健康',
  '大学生心理健康教育',
]);

const ART_EXCLUDED_COURSES = new Map([
  ['0823GRY001', '艺术导论'],
  ['0823GRY002', '美学概论'],
  ['0823GRY003', '中西方美术史'],
  ['0823GRY004', '中西方音乐史'],
  ['0823GRY005', '文艺理论'],
  ['0823GRY006', '音乐鉴赏'],
  ['0823GRY007', '美术鉴赏'],
  ['0823GRY008', '影视鉴赏'],
  ['0823GRY009', '舞蹈鉴赏'],
  ['0823GRY010', '戏剧鉴赏'],
  ['0823GRY011', '戏曲鉴赏'],
  ['0823GRY012', '书法鉴赏'],
  ['0823GRY013', '设计鉴赏'],
  ['0823GRY014', '音乐欣赏与体验'],
  ['0823GRY015', '书法鉴赏与体验'],
  ['0823GRY016', '中国画鉴赏与体验'],
  ['0823GRY017', '燕赵非遗鉴赏与体验'],
  ['0823GRY018', '篆刻艺术鉴赏与体验'],
  ['0823GRY019', '坤舆艺术名家讲堂系列'],
]);

export interface HbuJwGpaCourseSummary {
  courseNumber: string;
  courseName: string;
  credit: number | null;
  gradePointScore: number | null;
}

export interface HbuJwGpaResult {
  gpa: number;
  gpaRounded: string;
  includedCredits: number;
  includedCourseCount: number;
  excludedNonRequiredCount: number;
  excludedFixedCourses: HbuJwGpaCourseSummary[];
  excludedArtCourses: HbuJwGpaCourseSummary[];
  skippedNoGradePointCourses: HbuJwGpaCourseSummary[];
  coveredTerms: string[];
}

export interface HbuJwAuthServiceLike {
  ensureAuthenticated(identity: OwnerIdentity): Promise<
    | { kind: 'authenticated'; cookieJar: SerializedCookieJar }
    | { kind: 'needs_binding'; reason: string }
    | { kind: 'invalid'; reason: string }
  >;
}

export class HbuJwGpaService {
  constructor(
    private readonly authService: HbuJwAuthServiceLike,
    private readonly jwClient: Pick<HbuJwHttpClient, 'getAllPassingScores'>,
  ) {}

  async queryGpa(identity: OwnerIdentity): Promise<Fragment> {
    const auth = await this.authService.ensureAuthenticated(identity);
    if (auth.kind !== 'authenticated') {
      throw new HbuJwUserError(auth.reason);
    }

    try {
      const rows = await this.jwClient.getAllPassingScores(auth.cookieJar);
      return formatGpaReply(identity.qqUserId, calculateHbuJwGpa(rows));
    } catch (error) {
      if (error instanceof HbuJwUserError) throw error;
      throw new HbuJwUserError('教务成绩查询失败，请稍后重试。');
    }
  }
}

export function calculateHbuJwGpa(rows: HbuJwScoreRow[]): HbuJwGpaResult {
  let includedCredits = 0;
  let weightedGradePoints = 0;
  let includedCourseCount = 0;
  let excludedNonRequiredCount = 0;
  const excludedFixedCourses: HbuJwGpaCourseSummary[] = [];
  const excludedArtCourses: HbuJwGpaCourseSummary[] = [];
  const skippedNoGradePointCourses: HbuJwGpaCourseSummary[] = [];
  const coveredTerms: string[] = [];
  const coveredTermSet = new Set<string>();

  for (const row of rows) {
    const courseNumber = readCourseNumber(row);
    const courseName = normalizeCourseName(row.courseName);
    const term = formatTerm(row);
    if (term && !coveredTermSet.has(term)) {
      coveredTermSet.add(term);
      coveredTerms.push(term);
    }

    if (!isRequiredCourse(row)) {
      excludedNonRequiredCount += 1;
      continue;
    }

    const summary = summarizeCourse(row, courseNumber, courseName);
    if (isFixedExcludedCourse(courseName)) {
      excludedFixedCourses.push(summary);
      continue;
    }
    if (ART_EXCLUDED_COURSES.has(courseNumber)) {
      excludedArtCourses.push(summary);
      continue;
    }
    if (row.gradePointScore == null || row.gradePointScore === '') {
      skippedNoGradePointCourses.push(summary);
      continue;
    }

    const credit = parseFiniteNumber(row.credit, `课程 ${courseName} 的学分无效。`);
    const gradePoint = parseFiniteNumber(row.gradePointScore, `课程 ${courseName} 的绩点无效。`);
    includedCredits += credit;
    weightedGradePoints += credit * gradePoint;
    includedCourseCount += 1;
  }

  if (includedCredits <= 0) {
    throw new HbuJwUserError('没有可用于计算 GPA 的成绩。');
  }

  const gpa = weightedGradePoints / includedCredits;
  return {
    gpa,
    gpaRounded: gpa.toFixed(2),
    includedCredits,
    includedCourseCount,
    excludedNonRequiredCount,
    excludedFixedCourses,
    excludedArtCourses,
    skippedNoGradePointCourses,
    coveredTerms,
  };
}

export function formatGpaReply(qqUserId: string, result: HbuJwGpaResult): Fragment {
  const body = [
    `GPA：${result.gpaRounded}`,
    '口径：当前所有已返回成绩中的必修课，排除固定不计 GPA 课程和艺术教育课程',
    `覆盖：${formatCoveredTerms(result.coveredTerms)}`,
    `计入：${result.includedCourseCount} 门 / ${formatNumber(result.includedCredits)} 学分`,
    `排除：非必修 ${result.excludedNonRequiredCount} 门，固定 ${result.excludedFixedCourses.length} 门，艺术 ${result.excludedArtCourses.length} 门，无绩点 ${result.skippedNoGradePointCourses.length} 门`,
  ].join('\n');
  return [h.at(qqUserId), h.text(`\n${body}`)];
}

function isRequiredCourse(row: HbuJwScoreRow): boolean {
  return row.courseAttributeCode === REQUIRED_ATTRIBUTE_CODE && row.courseAttributeName === REQUIRED_ATTRIBUTE_NAME;
}

function normalizeCourseName(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, '').trim();
}

function readCourseNumber(row: HbuJwScoreRow): string {
  const courseNumber = String(row.id?.courseNumber ?? '').trim();
  if (!courseNumber) {
    throw new Error(`课程 ${normalizeCourseName(row.courseName) || '<未知>'} 缺少课程号。`);
  }
  return courseNumber;
}

function isFixedExcludedCourse(courseName: string): boolean {
  return /^形势与政策\d*$/.test(courseName) || FIXED_EXCLUDED_COURSE_NAMES.has(courseName);
}

function summarizeCourse(row: HbuJwScoreRow, courseNumber: string, courseName: string): HbuJwGpaCourseSummary {
  return {
    courseNumber,
    courseName,
    credit: row.credit == null || row.credit === '' ? null : Number(row.credit),
    gradePointScore: row.gradePointScore == null || row.gradePointScore === '' ? null : Number(row.gradePointScore),
  };
}

function parseFiniteNumber(value: unknown, message: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(message);
  }
  return parsed;
}

function formatTerm(row: HbuJwScoreRow): string | null {
  const academicYear = String(row.academicYearCode ?? '').trim();
  const termName = String(row.termName ?? '').trim();
  if (!academicYear || !termName) return null;
  return `${academicYear} ${termName}`;
}

function formatCoveredTerms(terms: string[]): string {
  if (terms.length === 0) return '无';
  if (terms.length === 1) return `${terms[0]}，共 1 学期`;
  return `${terms[0]} 至 ${terms[terms.length - 1]}，共 ${terms.length} 学期`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/g, '').replace(/\.$/g, '');
}
