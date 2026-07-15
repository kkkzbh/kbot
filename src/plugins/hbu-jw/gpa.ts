import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { h, type Fragment } from 'koishi';
import {
  formatAcademicFallbackNotice,
  hbuJwDatabaseFallbackPolicy,
  type HbuJwAcademicCache,
} from './academic-cache.js';
import type { HbuJwHttpClient } from './jw-client.js';
import { HbuJwUserError, type HbuJwScoreRow, type OwnerIdentity, type SerializedCookieJar } from './types.js';

const GPA_CARD_WIDTH = 1104;
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

const PROFESSIONAL_COURSE_NAME_PATTERNS = [
  /(?:专业英语|高等数学|数学分析|线性代数|解析几何|概率论|数理统计|概率统计|离散数学|复变函数|数理方程|运筹学|数值分析|数值计算|抽象代数|微积分)/,
  /(?:程序设计|算法|数据结构|操作系统|计算机|软件工程|数据库|编译原理|人工智能|机器学习|模式识别|信息安全|密码学|数字逻辑|计算机组成|体系结构|嵌入式|物联网|云计算|大数据)/,
  /(?:大学物理|普通物理|理论力学|材料力学|电路|电子技术|通信原理|信号与系统|自动控制|自动化|机械设计|材料科学|无机化学|有机化学|分析化学|生物学|地质学|测绘学|土木工程|建筑学|环境工程)/,
] as const;

export interface HbuJwGpaCourseSummary {
  courseNumber: string;
  courseName: string;
  credit: number | null;
  gradePointScore: number | null;
}

export interface HbuJwIncludedGpaCourse {
  courseNumber: string;
  courseName: string;
  credit: number;
  gradePointScore: number;
}

export type HbuJwGpaExclusionReason = 'non_required' | 'fixed' | 'art' | 'no_grade_point';

export type HbuJwGpaCourseEvaluation =
  | { kind: 'included'; course: HbuJwIncludedGpaCourse }
  | { kind: 'excluded'; reason: HbuJwGpaExclusionReason; course: HbuJwGpaCourseSummary };

export type HbuJwGpaCourseMask = 'professional' | 'general';

export interface HbuJwGpaTotals {
  includedCredits: number;
  weightedGradePoints: number;
  includedCourseCount: number;
}

export interface HbuJwGpaCategorySummary {
  gpa: number | null;
  gpaRounded: string | null;
  includedCredits: number;
  includedCourseCount: number;
}

export interface HbuJwGpaTermPoint {
  academicYear: string;
  academicYearShort: string;
  termName: '秋' | '春';
  label: string;
  cumulativeGpa: number;
  cumulativeGpaRounded: string;
  cumulativeCredits: number;
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
  professional: HbuJwGpaCategorySummary;
  general: HbuJwGpaCategorySummary;
  termTrend: HbuJwGpaTermPoint[];
}

export interface HbuJwGpaView {
  gpaText: string;
  coveredTermCount: number;
  coveredTermRangeText: string;
  includedCreditsText: string;
  includedCourseCount: number;
  professionalGpaText: string;
  professionalCreditsText: string;
  generalGpaText: string;
  generalCreditsText: string;
  termTrend: HbuJwGpaTermPoint[];
}

export interface HbuJwAuthServiceLike {
  ensureAuthenticated(identity: OwnerIdentity): Promise<
    | { kind: 'authenticated'; cookieJar: SerializedCookieJar; credentialVersion?: number }
    | { kind: 'needs_binding'; reason: string }
    | { kind: 'invalid'; reason: string }
  >;
}

export interface HbuJwGpaPuppeteerLike {
  page(): Promise<HbuJwGpaPageLike>;
}

interface HbuJwGpaPageLike {
  setViewport?(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<unknown>;
  goto(url: string, options?: unknown): Promise<unknown>;
  waitForSelector?(selector: string, options?: unknown): Promise<unknown>;
  $(selector: string): Promise<HbuJwGpaElementLike | null>;
  screenshot(options?: unknown): Promise<Buffer | Uint8Array | string>;
  close(): Promise<unknown>;
}

interface HbuJwGpaElementLike {
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
}

interface HbuJwGpaTerm {
  academicYear: string;
  academicYearStart: number;
  academicYearShort: string;
  termName: '秋' | '春';
  sortKey: number;
  label: string;
}

interface HbuJwClassifiedGpaCourse {
  course: HbuJwIncludedGpaCourse;
  mask: HbuJwGpaCourseMask;
  term: HbuJwGpaTerm;
}

export class HbuJwGpaService {
  constructor(
    private readonly authService: HbuJwAuthServiceLike,
    private readonly jwClient: Pick<HbuJwHttpClient, 'getAllPassingScores'>,
    private readonly puppeteer: HbuJwGpaPuppeteerLike,
    private readonly academicCache?: Pick<HbuJwAcademicCache, 'getAllPassingScores'>,
  ) {}

  async queryGpa(identity: OwnerIdentity): Promise<Fragment> {
    const auth = await this.authService.ensureAuthenticated(identity);
    if (auth.kind !== 'authenticated') {
      throw new HbuJwUserError(auth.reason);
    }

    try {
      const query = this.academicCache
        ? await this.academicCache.getAllPassingScores(identity, auth, hbuJwDatabaseFallbackPolicy())
        : { data: await this.jwClient.getAllPassingScores(auth.cookieJar), source: 'remote' as const, fetchedAt: Date.now() };
      const view = buildHbuJwGpaView(calculateHbuJwGpa(query.data));
      const notice = formatAcademicFallbackNotice([query]);
      return [h.at(identity.qqUserId), h.text(notice ? `\n${notice}\n` : '\n'), await renderHbuJwGpaImage(this.puppeteer, view)];
    } catch (error) {
      if (error instanceof HbuJwUserError) throw error;
      throw new HbuJwUserError('教务成绩查询失败，请稍后重试。');
    }
  }
}

export function calculateHbuJwGpa(rows: HbuJwScoreRow[]): HbuJwGpaResult {
  let excludedNonRequiredCount = 0;
  const excludedFixedCourses: HbuJwGpaCourseSummary[] = [];
  const excludedArtCourses: HbuJwGpaCourseSummary[] = [];
  const skippedNoGradePointCourses: HbuJwGpaCourseSummary[] = [];
  const classifiedCourses: HbuJwClassifiedGpaCourse[] = [];

  for (const row of rows) {
    const evaluation = evaluateHbuJwGpaCourse(row);
    if (evaluation.kind === 'included') {
      classifiedCourses.push({
        course: evaluation.course,
        mask: classifyHbuJwGpaCourse(evaluation.course.courseName),
        term: parseHbuJwGpaTerm(row, evaluation.course.courseName),
      });
      continue;
    }

    if (evaluation.reason === 'non_required') {
      excludedNonRequiredCount += 1;
      continue;
    }

    if (evaluation.reason === 'fixed') {
      excludedFixedCourses.push(evaluation.course);
      continue;
    }
    if (evaluation.reason === 'art') {
      excludedArtCourses.push(evaluation.course);
      continue;
    }
    skippedNoGradePointCourses.push(evaluation.course);
  }

  const includedCourses = classifiedCourses.map(({ course }) => course);
  const totals = createHbuJwGpaTotals(includedCourses);
  const gpa = calculateHbuJwGpaFromTotals(totals);
  if (gpa == null) {
    throw new HbuJwUserError('没有可用于计算 GPA 的成绩。');
  }

  const termTrend = buildHbuJwGpaTermTrend(classifiedCourses);
  return {
    gpa,
    gpaRounded: gpa.toFixed(2),
    includedCredits: totals.includedCredits,
    includedCourseCount: totals.includedCourseCount,
    excludedNonRequiredCount,
    excludedFixedCourses,
    excludedArtCourses,
    skippedNoGradePointCourses,
    coveredTerms: termTrend.map(({ label }) => label),
    professional: summarizeHbuJwGpaCategory(classifiedCourses, 'professional'),
    general: summarizeHbuJwGpaCategory(classifiedCourses, 'general'),
    termTrend,
  };
}

export function evaluateHbuJwGpaCourse(row: HbuJwScoreRow): HbuJwGpaCourseEvaluation {
  const courseNumber = readCourseNumber(row);
  const courseName = normalizeCourseName(row.courseName);
  const summary = summarizeCourse(row, courseNumber, courseName);

  if (!isRequiredCourse(row)) {
    return { kind: 'excluded', reason: 'non_required', course: summary };
  }
  if (isFixedExcludedCourse(courseName)) {
    return { kind: 'excluded', reason: 'fixed', course: summary };
  }
  if (ART_EXCLUDED_COURSES.has(courseNumber)) {
    return { kind: 'excluded', reason: 'art', course: summary };
  }
  if (row.gradePointScore == null || row.gradePointScore === '') {
    return { kind: 'excluded', reason: 'no_grade_point', course: summary };
  }

  return {
    kind: 'included',
    course: {
      courseNumber,
      courseName,
      credit: parseFiniteNumber(row.credit, `课程 ${courseName} 的学分无效。`),
      gradePointScore: parseFiniteNumber(row.gradePointScore, `课程 ${courseName} 的绩点无效。`),
    },
  };
}

export function classifyHbuJwGpaCourse(courseName: string): HbuJwGpaCourseMask {
  const normalizedName = normalizeCourseName(courseName);
  return PROFESSIONAL_COURSE_NAME_PATTERNS.some((pattern) => pattern.test(normalizedName))
    ? 'professional'
    : 'general';
}

export function createHbuJwGpaTotals(courses: HbuJwIncludedGpaCourse[]): HbuJwGpaTotals {
  return courses.reduce<HbuJwGpaTotals>((totals, course) => addHbuJwGpaCourseToTotals(totals, course), {
    includedCredits: 0,
    weightedGradePoints: 0,
    includedCourseCount: 0,
  });
}

export function addHbuJwGpaCourseToTotals(totals: HbuJwGpaTotals, course: HbuJwIncludedGpaCourse): HbuJwGpaTotals {
  return {
    includedCredits: totals.includedCredits + course.credit,
    weightedGradePoints: totals.weightedGradePoints + course.credit * course.gradePointScore,
    includedCourseCount: totals.includedCourseCount + 1,
  };
}

export function calculateHbuJwGpaFromTotals(totals: HbuJwGpaTotals): number | null {
  if (totals.includedCredits <= 0) return null;
  return totals.weightedGradePoints / totals.includedCredits;
}

export function buildHbuJwGpaView(result: HbuJwGpaResult): HbuJwGpaView {
  const firstTerm = result.termTrend[0];
  const lastTerm = result.termTrend[result.termTrend.length - 1];
  return {
    gpaText: result.gpaRounded,
    coveredTermCount: result.termTrend.length,
    coveredTermRangeText: firstTerm.label === lastTerm.label
      ? firstTerm.label
      : `${firstTerm.label} — ${lastTerm.label}`,
    includedCreditsText: formatNumber(result.includedCredits),
    includedCourseCount: result.includedCourseCount,
    professionalGpaText: result.professional.gpaRounded ?? '—',
    professionalCreditsText: formatNumber(result.professional.includedCredits),
    generalGpaText: result.general.gpaRounded ?? '—',
    generalCreditsText: formatNumber(result.general.includedCredits),
    termTrend: result.termTrend,
  };
}

export async function renderHbuJwGpaImage(
  puppeteer: HbuJwGpaPuppeteerLike,
  view: HbuJwGpaView,
): Promise<ReturnType<typeof h.image>> {
  const page = await puppeteer.page();
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'qqbot-hbu-jw-gpa-'));
    const htmlPath = join(tempDir, 'gpa.html');
    await writeFile(htmlPath, renderHbuJwGpaHtml(view), 'utf8');
    await page.setViewport?.({ width: GPA_CARD_WIDTH, height: 900, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
    await page.waitForSelector?.('#hbu-jw-gpa-card', { timeout: 5000 });
    const card = await page.$('#hbu-jw-gpa-card');
    if (!card) throw new Error('hbu jw gpa root not found');
    const box = await card.boundingBox();
    if (!box) throw new Error('hbu jw gpa root has no bounding box');
    const screenshot = await page.screenshot({
      type: 'png',
      clip: {
        x: Math.floor(box.x),
        y: Math.floor(box.y),
        width: Math.ceil(box.width),
        height: Math.ceil(box.height),
      },
    });
    return h.image(Buffer.from(screenshot), 'image/png');
  } finally {
    await page.close();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export function renderHbuJwGpaHtml(view: HbuJwGpaView): string {
  const firstPoint = view.termTrend[0];
  const lastPoint = view.termTrend[view.termTrend.length - 1];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GPA 学业统计卡片</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #eef4ef;
      color: #25313a;
      font-family: "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif;
    }
    #hbu-jw-gpa-card {
      width: ${GPA_CARD_WIDTH}px;
      margin: 0;
      padding: 12px;
      background: #eef4ef;
    }
    .sheet {
      overflow: hidden;
      padding: 50px 56px 42px;
      border: 1px solid #d4ddd7;
      border-radius: 28px;
      background: #fbfcfb;
      box-shadow: 0 22px 50px rgba(40, 72, 56, 0.12);
    }
    .hero {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 32px;
      padding-bottom: 38px;
    }
    .hero-label {
      color: #718079;
      font-size: 22px;
      line-height: 1.3;
    }
    .hero-value {
      margin-top: 9px;
      color: #25313a;
      font-size: 96px;
      line-height: 0.9;
      font-weight: 900;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.07em;
    }
    .hero-meta {
      display: grid;
      gap: 9px;
      color: #718079;
      font-size: 18px;
      line-height: 1.35;
      text-align: right;
    }
    .hero-meta strong {
      color: #25313a;
      font-size: 23px;
      font-weight: 900;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      border-top: 1px solid #dce4df;
      border-bottom: 1px solid #dce4df;
    }
    .stat {
      min-width: 0;
      padding: 29px 28px 28px 0;
    }
    .stat + .stat {
      padding-left: 28px;
      border-left: 1px solid #dce4df;
    }
    .stat-head {
      display: flex;
      align-items: center;
      gap: 11px;
      color: #718079;
      font-size: 20px;
      line-height: 1.3;
    }
    .mask {
      width: 13px;
      height: 13px;
      flex: 0 0 auto;
      background: #aeb8b2;
    }
    .mask-major { background: #238358; }
    .mask-general { background: #b97822; }
    .stat-value {
      margin-top: 15px;
      color: #25313a;
      font-size: 43px;
      line-height: 1;
      font-weight: 900;
      font-variant-numeric: tabular-nums;
    }
    .stat-unit {
      margin-left: 6px;
      color: #718079;
      font-size: 24px;
      font-weight: 700;
    }
    .stat-note {
      margin-top: 12px;
      color: #718079;
      font-size: 17px;
      line-height: 1.4;
    }
    .trend { padding-top: 34px; }
    .trend-heading {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 12px;
    }
    .trend-title {
      color: #25313a;
      font-size: 21px;
      font-weight: 900;
    }
    .trend-summary {
      color: #718079;
      font-size: 17px;
      text-align: right;
    }
    .trend-chart {
      display: block;
      width: 100%;
      height: auto;
    }
    .chart-grid {
      stroke: #dce4df;
      stroke-width: 1;
    }
    .chart-area { fill: rgba(35, 131, 88, 0.12); }
    .chart-line {
      fill: none;
      stroke: #238358;
      stroke-width: 4;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .chart-point {
      fill: #fbfcfb;
      stroke: #238358;
      stroke-width: 4;
    }
    .chart-point-current { fill: #238358; }
    .chart-axis-label,
    .chart-term-label {
      fill: #718079;
      font-size: 15px;
      font-weight: 700;
    }
    .chart-axis-label { text-anchor: end; }
    .chart-term-label,
    .chart-value-label { text-anchor: middle; }
    .chart-value-label {
      fill: #25313a;
      font-size: 16px;
      font-weight: 900;
    }
  </style>
</head>
<body>
  <main id="hbu-jw-gpa-card">
    <section class="sheet">
      <section class="hero">
        <div>
          <div class="hero-label">累计加权 GPA</div>
          <div class="hero-value">${escapeHtml(view.gpaText)}</div>
        </div>
        <div class="hero-meta">
          <span><strong>${view.coveredTermCount}</strong> 个学期</span>
          <span>${escapeHtml(view.coveredTermRangeText)}</span>
        </div>
      </section>
      <section class="stats">
        <div class="stat">
          <div class="stat-head"><span class="mask"></span><span>计入学分</span></div>
          <div class="stat-value">${escapeHtml(view.includedCreditsText)}<span class="stat-unit">学分</span></div>
          <div class="stat-note">${view.includedCourseCount} 门必修课程</div>
        </div>
        <div class="stat">
          <div class="stat-head"><span class="mask mask-major"></span><span>专业课 GPA</span></div>
          <div class="stat-value">${escapeHtml(view.professionalGpaText)}</div>
          <div class="stat-note">理工 · 数学 · ${escapeHtml(view.professionalCreditsText)} 学分</div>
        </div>
        <div class="stat">
          <div class="stat-head"><span class="mask mask-general"></span><span>公共基础 GPA</span></div>
          <div class="stat-value">${escapeHtml(view.generalGpaText)}</div>
          <div class="stat-note">其他计入必修课程 · ${escapeHtml(view.generalCreditsText)} 学分</div>
        </div>
      </section>
      <section class="trend">
        <div class="trend-heading">
          <div class="trend-title">累计 GPA 走势</div>
          <div class="trend-summary">首学期 ${escapeHtml(firstPoint.cumulativeGpaRounded)} · 当前 ${escapeHtml(lastPoint.cumulativeGpaRounded)}</div>
        </div>
        ${renderHbuJwGpaTrendSvg(view.termTrend)}
      </section>
    </section>
  </main>
</body>
</html>`;
}

function summarizeHbuJwGpaCategory(
  courses: HbuJwClassifiedGpaCourse[],
  mask: HbuJwGpaCourseMask,
): HbuJwGpaCategorySummary {
  const totals = createHbuJwGpaTotals(courses.filter((entry) => entry.mask === mask).map(({ course }) => course));
  const gpa = calculateHbuJwGpaFromTotals(totals);
  return {
    gpa,
    gpaRounded: gpa == null ? null : gpa.toFixed(2),
    includedCredits: totals.includedCredits,
    includedCourseCount: totals.includedCourseCount,
  };
}

function buildHbuJwGpaTermTrend(courses: HbuJwClassifiedGpaCourse[]): HbuJwGpaTermPoint[] {
  const grouped = new Map<number, { term: HbuJwGpaTerm; courses: HbuJwIncludedGpaCourse[] }>();
  for (const entry of courses) {
    const group = grouped.get(entry.term.sortKey);
    if (group) {
      group.courses.push(entry.course);
    } else {
      grouped.set(entry.term.sortKey, { term: entry.term, courses: [entry.course] });
    }
  }

  let cumulativeTotals: HbuJwGpaTotals = {
    includedCredits: 0,
    weightedGradePoints: 0,
    includedCourseCount: 0,
  };
  return [...grouped.values()]
    .sort((left, right) => left.term.sortKey - right.term.sortKey)
    .map(({ term, courses: termCourses }) => {
      for (const course of termCourses) {
        cumulativeTotals = addHbuJwGpaCourseToTotals(cumulativeTotals, course);
      }
      const cumulativeGpa = calculateHbuJwGpaFromTotals(cumulativeTotals);
      if (cumulativeGpa == null) {
        throw new Error(`学期 ${term.label} 没有可用于计算累计 GPA 的成绩。`);
      }
      return {
        academicYear: term.academicYear,
        academicYearShort: term.academicYearShort,
        termName: term.termName,
        label: term.label,
        cumulativeGpa,
        cumulativeGpaRounded: cumulativeGpa.toFixed(2),
        cumulativeCredits: cumulativeTotals.includedCredits,
      };
    });
}

function parseHbuJwGpaTerm(row: HbuJwScoreRow, courseName: string): HbuJwGpaTerm {
  const academicYear = String(row.academicYearCode ?? '').trim();
  const academicYearMatch = /^(\d{4})-(\d{4})$/.exec(academicYear);
  if (!academicYearMatch) {
    throw new Error(`课程 ${courseName} 的学年无效。`);
  }
  const academicYearStart = Number(academicYearMatch[1]);
  const academicYearEnd = Number(academicYearMatch[2]);
  if (academicYearEnd !== academicYearStart + 1) {
    throw new Error(`课程 ${courseName} 的学年无效。`);
  }

  const rawTermName = String(row.termName ?? '').trim();
  if (rawTermName !== '秋' && rawTermName !== '春') {
    throw new Error(`课程 ${courseName} 的学期无效。`);
  }
  const termName: '秋' | '春' = rawTermName;
  return {
    academicYear,
    academicYearStart,
    academicYearShort: `${academicYearStart}-${String(academicYearEnd).slice(-2)}`,
    termName,
    sortKey: academicYearStart * 2 + (termName === '秋' ? 0 : 1),
    label: `${academicYear} ${termName}`,
  };
}

function renderHbuJwGpaTrendSvg(points: HbuJwGpaTermPoint[]): string {
  const chartWidth = 960;
  const chartHeight = 274;
  const gridLeft = 68;
  const gridRight = 922;
  const pointLeft = 94;
  const pointRight = 894;
  const plotTop = 50;
  const plotBottom = 194;
  const values = points.map(({ cumulativeGpa }) => cumulativeGpa);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  let scaleMin = Math.floor((rawMin - 0.1) * 5) / 5;
  let scaleMax = Math.ceil((rawMax + 0.1) * 5) / 5;
  if (scaleMax - scaleMin < 0.4) {
    const midpoint = (scaleMin + scaleMax) / 2;
    scaleMin = Math.floor((midpoint - 0.2) * 5) / 5;
    scaleMax = scaleMin + 0.4;
  }

  const xForIndex = (index: number): number => points.length === 1
    ? (pointLeft + pointRight) / 2
    : pointLeft + (pointRight - pointLeft) * index / (points.length - 1);
  const yForValue = (value: number): number => plotBottom
    - (value - scaleMin) / (scaleMax - scaleMin) * (plotBottom - plotTop);
  const coordinates = points.map((point, index) => ({
    point,
    x: xForIndex(index),
    y: yForValue(point.cumulativeGpa),
  }));
  const linePath = coordinates.map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'}${svgNumber(x)} ${svgNumber(y)}`).join(' ');
  const areaPath = coordinates.length === 1
    ? `M${svgNumber(coordinates[0].x - 32)} ${plotBottom} L${svgNumber(coordinates[0].x)} ${svgNumber(coordinates[0].y)} L${svgNumber(coordinates[0].x + 32)} ${plotBottom} Z`
    : `${linePath} L${svgNumber(coordinates[coordinates.length - 1].x)} ${plotBottom} L${svgNumber(coordinates[0].x)} ${plotBottom} Z`;
  const ticks = [scaleMax, (scaleMin + scaleMax) / 2, scaleMin];

  return `<svg class="trend-chart" viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-labelledby="gpa-trend-title gpa-trend-desc">
          <title id="gpa-trend-title">${points.length} 个学期的累计 GPA 变化</title>
          <desc id="gpa-trend-desc">累计 GPA 从 ${escapeHtml(points[0].label)} 的 ${escapeHtml(points[0].cumulativeGpaRounded)} 变化到 ${escapeHtml(points[points.length - 1].label)} 的 ${escapeHtml(points[points.length - 1].cumulativeGpaRounded)}。</desc>
          ${ticks.map((tick) => {
            const y = yForValue(tick);
            return `<line class="chart-grid" x1="${gridLeft}" y1="${svgNumber(y)}" x2="${gridRight}" y2="${svgNumber(y)}"></line>
          <text class="chart-axis-label" x="54" y="${svgNumber(y + 5)}">${tick.toFixed(1)}</text>`;
          }).join('\n          ')}
          <path class="chart-area" d="${areaPath}"></path>
          <path class="chart-line" d="${linePath}"></path>
          ${coordinates.map(({ x, y }, index) => `<circle class="chart-point${index === coordinates.length - 1 ? ' chart-point-current' : ''}" cx="${svgNumber(x)}" cy="${svgNumber(y)}" r="${index === coordinates.length - 1 ? 8 : 7}"></circle>`).join('\n          ')}
          ${coordinates.map(({ point, x, y }) => `<text class="chart-value-label" x="${svgNumber(x)}" y="${svgNumber(Math.max(24, y - 18))}">${escapeHtml(point.cumulativeGpaRounded)}</text>`).join('\n          ')}
          ${coordinates.map(({ point, x }) => `<text class="chart-term-label" x="${svgNumber(x)}" y="231"><tspan x="${svgNumber(x)}">${escapeHtml(point.academicYearShort)}</tspan><tspan x="${svgNumber(x)}" dy="18">${point.termName}</tspan></text>`).join('\n          ')}
        </svg>`;
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

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/g, '').replace(/\.$/g, '');
}

function svgNumber(value: number): string {
  return value.toFixed(2).replace(/0+$/g, '').replace(/\.$/g, '');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
