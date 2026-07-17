import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { h, type Fragment } from 'koishi';
import {
  formatAcademicFallbackNotice,
  hbuJwDatabaseFallbackPolicy,
  type HbuJwAcademicCache,
  type HbuJwAcademicQueryResult,
} from './academic-cache.js';
import {
  addHbuJwGpaCourseToTotals,
  calculateHbuJwGpaFromTotals,
  createHbuJwGpaTotals,
  evaluateHbuJwGpaCourse,
  type HbuJwGpaCourseEvaluation,
  type HbuJwIncludedGpaCourse,
} from './gpa.js';
import {
  buildSubitemScoreLookParamsFromThisTermRow,
  HbuJwQueryError,
  type HbuJwHttpClient,
} from './jw-client.js';
import {
  type HbuJwScoreRow,
  type HbuJwSubitemScoreLookParams,
  type HbuJwSubitemScoreLookResult,
  HbuJwUserError,
  type HbuJwThisTermScoreRow,
  type OwnerIdentity,
  type SerializedCookieJar,
} from './types.js';

const TERM_SCORES_WIDTH = 1280;
const CONFIRMED_STATUS_CODE = '05';
const LOOK_REQUIRED_STATUS_CODE = '04';
const PENDING_STATUS_CODE = '01';
const EMPTY_DELTA_TEXT = '—';
const ANONYMIZED_TEXT = '*';

export interface HbuJwTermScoresAuthServiceLike {
  ensureAuthenticated(identity: OwnerIdentity): Promise<
    | { kind: 'authenticated'; cookieJar: SerializedCookieJar; credentialVersion?: number }
    | { kind: 'needs_binding'; reason: string }
    | { kind: 'invalid'; reason: string }
    | { kind: 'unavailable'; reason: string }
  >;
}

export interface HbuJwTermScoresPuppeteerLike {
  page(): Promise<HbuJwTermScoresPageLike>;
}

interface HbuJwTermScoresPageLike {
  setViewport?(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<unknown>;
  goto(url: string, options?: unknown): Promise<unknown>;
  waitForSelector?(selector: string, options?: unknown): Promise<unknown>;
  $(selector: string): Promise<HbuJwTermScoresElementLike | null>;
  screenshot(options?: unknown): Promise<Buffer | Uint8Array | string>;
  close(): Promise<unknown>;
}

interface HbuJwTermScoresElementLike {
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
}

export type HbuJwTermScoreStatusKind = 'confirmed' | 'recorded' | 'pending';
export type HbuJwTermScoreStatus =
  | { kind: 'confirmed' }
  | { kind: 'recorded'; recordedCount: number }
  | { kind: 'pending' };
export type HbuJwTermScoreGpaDeltaKind = 'positive' | 'negative' | 'zero' | 'not-counted' | 'pending' | 'missing' | 'anonymous';
export type HbuJwTermScoresMode = 'full' | 'anonymous';

export type HbuJwTermScoresBuildInput =
  | { mode: 'full'; rows: HbuJwThisTermScoreRow[]; allPassingRows: HbuJwScoreRow[]; statusOverrides?: ReadonlyMap<HbuJwThisTermScoreRow, HbuJwTermScoreStatus> }
  | { mode: 'anonymous'; rows: HbuJwThisTermScoreRow[]; statusOverrides?: ReadonlyMap<HbuJwThisTermScoreRow, HbuJwTermScoreStatus> };

export interface HbuJwTermScoreRowView {
  courseNumber: string;
  sequenceNumber: string;
  courseName: string;
  creditText: string;
  propertyName: string;
  statusText: string;
  statusKind: HbuJwTermScoreStatusKind;
  timeText: string;
  scoreText: string;
  gradePointText: string;
  averageText: string;
  rankText: string;
  gpaDeltaText: string;
  gpaDeltaKind: HbuJwTermScoreGpaDeltaKind;
}

export interface HbuJwTermScoresView {
  title: string;
  subtitle: string;
  totalCourseCount: number;
  totalCredits: number;
  confirmedCount: number;
  recordedCount: number;
  pendingCount: number;
  rows: HbuJwTermScoreRowView[];
}

export class HbuJwTermScoresService {
  constructor(
    private readonly authService: HbuJwTermScoresAuthServiceLike,
    private readonly jwClient: Pick<HbuJwHttpClient, 'getThisTermScores' | 'getAllPassingScores' | 'getSubitemScoreDetails'>,
    private readonly puppeteer: HbuJwTermScoresPuppeteerLike,
    private readonly academicCache?: Pick<HbuJwAcademicCache, 'getThisTermScores' | 'getAllPassingScores' | 'getSubitemScoreDetails'>,
  ) {}

  async queryTermScores(identity: OwnerIdentity, mode: HbuJwTermScoresMode = 'full'): Promise<Fragment> {
    const auth = await this.authService.ensureAuthenticated(identity);
    if (auth.kind !== 'authenticated') {
      throw new HbuJwUserError(auth.reason);
    }

    try {
      const queryResults: Array<HbuJwAcademicQueryResult<unknown>> = [];
      const view = mode === 'full'
        ? await this.buildFullView(identity, auth, queryResults)
        : await this.buildAnonymousView(identity, auth, queryResults);
      const notice = formatAcademicFallbackNotice(queryResults);
      return [h.at(identity.qqUserId), h.text(notice ? `\n${notice}\n` : '\n'), await renderHbuJwTermScoresImage(this.puppeteer, view)];
    } catch (error) {
      if (error instanceof HbuJwUserError) throw error;
      throw new HbuJwUserError('教务成绩查询失败，请稍后重试。');
    }
  }

  private async buildFullView(
    identity: OwnerIdentity,
    auth: { cookieJar: SerializedCookieJar; credentialVersion?: number },
    queryResults: Array<HbuJwAcademicQueryResult<unknown>>,
  ): Promise<HbuJwTermScoresView> {
    const [scoresResult, allPassingScoresResult] = await Promise.all([
      this.loadThisTermScores(identity, auth),
      this.loadAllPassingScores(identity, auth),
    ]);
    queryResults.push(scoresResult, allPassingScoresResult);
    const statusOverrides = await resolveLookStatusOverrides(async (params) => {
      const result = await this.loadSubitemScoreDetails(identity, auth, params);
      queryResults.push(result);
      return result.data;
    }, scoresResult.data);
    return buildHbuJwTermScoresView({ mode: 'full', rows: scoresResult.data, allPassingRows: allPassingScoresResult.data, statusOverrides });
  }

  private async buildAnonymousView(
    identity: OwnerIdentity,
    auth: { cookieJar: SerializedCookieJar; credentialVersion?: number },
    queryResults: Array<HbuJwAcademicQueryResult<unknown>>,
  ): Promise<HbuJwTermScoresView> {
    const scoresResult = await this.loadThisTermScores(identity, auth);
    queryResults.push(scoresResult);
    const statusOverrides = await resolveLookStatusOverrides(async (params) => {
      const result = await this.loadSubitemScoreDetails(identity, auth, params);
      queryResults.push(result);
      return result.data;
    }, scoresResult.data);
    return buildHbuJwTermScoresView({ mode: 'anonymous', rows: scoresResult.data, statusOverrides });
  }

  private async loadThisTermScores(
    identity: OwnerIdentity,
    auth: { cookieJar: SerializedCookieJar; credentialVersion?: number },
  ): Promise<HbuJwAcademicQueryResult<HbuJwThisTermScoreRow[]>> {
    if (this.academicCache) {
      return this.academicCache.getThisTermScores(identity, auth, hbuJwDatabaseFallbackPolicy());
    }
    return { data: await this.jwClient.getThisTermScores(auth.cookieJar), source: 'remote', fetchedAt: Date.now() };
  }

  private async loadAllPassingScores(
    identity: OwnerIdentity,
    auth: { cookieJar: SerializedCookieJar; credentialVersion?: number },
  ): Promise<HbuJwAcademicQueryResult<HbuJwScoreRow[]>> {
    if (this.academicCache) {
      return this.academicCache.getAllPassingScores(identity, auth, hbuJwDatabaseFallbackPolicy());
    }
    return { data: await this.jwClient.getAllPassingScores(auth.cookieJar), source: 'remote', fetchedAt: Date.now() };
  }

  private async loadSubitemScoreDetails(
    identity: OwnerIdentity,
    auth: { cookieJar: SerializedCookieJar; credentialVersion?: number },
    params: HbuJwSubitemScoreLookParams,
  ): Promise<HbuJwAcademicQueryResult<HbuJwSubitemScoreLookResult>> {
    if (this.academicCache) {
      return this.academicCache.getSubitemScoreDetails(identity, auth, params, hbuJwDatabaseFallbackPolicy());
    }
    return { data: await this.jwClient.getSubitemScoreDetails(auth.cookieJar, params), source: 'remote', fetchedAt: Date.now() };
  }
}

export function buildHbuJwTermScoresView(input: HbuJwTermScoresBuildInput): HbuJwTermScoresView {
  const { rows } = input;
  const statusOverrides = input.statusOverrides ?? new Map<HbuJwThisTermScoreRow, HbuJwTermScoreStatus>();
  const sortedRows = [...rows].sort((left, right) => compareTermScoreRows(left, right, statusOverrides));
  const gpaDeltas = input.mode === 'full'
    ? calculateTermScoreGpaDeltas(sortedRows, input.allPassingRows, statusOverrides)
    : new Map<string, HbuJwTermScoreGpaDelta>();
  const rowViews = sortedRows.map((row) => toRowView(
    row,
    input.mode === 'anonymous' ? anonymizedGpaDelta() : gpaDeltas.get(termScoreKey(row)) ?? missingGpaDelta(),
    input.mode,
    statusOverrides,
  ));
  const termLabel = formatTermLabel(rows);
  const totalCredits = rows.reduce((sum, row) => sum + parseCredit(row.credit), 0);
  const confirmedCount = rowViews.filter((row) => row.statusKind === 'confirmed').length;
  const recordedCount = rowViews.filter((row) => row.statusKind === 'recorded').length;
  const pendingCount = rowViews.filter((row) => row.statusKind === 'pending').length;

  return {
    title: '河北大学本学期成绩',
    subtitle: `${termLabel} · ${rows.length} 门课程 · ${formatNumber(totalCredits)} 学分`,
    totalCourseCount: rows.length,
    totalCredits,
    confirmedCount,
    recordedCount,
    pendingCount,
    rows: rowViews,
  };
}

export async function renderHbuJwTermScoresImage(
  puppeteer: HbuJwTermScoresPuppeteerLike,
  view: HbuJwTermScoresView,
): Promise<ReturnType<typeof h.image>> {
  const page = await puppeteer.page();
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'qqbot-hbu-jw-term-scores-'));
    const htmlPath = join(tempDir, 'term-scores.html');
    await writeFile(htmlPath, renderHbuJwTermScoresHtml(view), 'utf8');
    await page.setViewport?.({ width: TERM_SCORES_WIDTH, height: 1400, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
    await page.waitForSelector?.('#hbu-jw-term-scores-card', { timeout: 5000 });
    const card = await page.$('#hbu-jw-term-scores-card');
    if (!card) throw new Error('hbu jw term scores root not found');
    const box = await card.boundingBox();
    if (!box) throw new Error('hbu jw term scores root has no bounding box');
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

export function renderHbuJwTermScoresHtml(view: HbuJwTermScoresView): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(view.title)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #f2f5f1;
      color: #25313a;
      font-family: "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif;
    }
    #hbu-jw-term-scores-card {
      width: ${TERM_SCORES_WIDTH}px;
      margin: 0;
      padding: 12px;
      background: #f2f5f1;
    }
    .sheet {
      overflow: hidden;
      border: 1px solid #d4ddd7;
      border-radius: 8px;
      background: #fbfcfb;
      box-shadow: 0 16px 36px rgba(40, 72, 56, 0.10);
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      padding: 24px 30px 20px;
      border-bottom: 1px solid #dce4df;
      background: linear-gradient(90deg, #ffffff, #f6faf6);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 16px;
      min-width: 0;
    }
    .seal {
      width: 54px;
      height: 54px;
      border: 3px solid #238358;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #238358;
      background: #ffffff;
      font-size: 17px;
      font-weight: 850;
      flex: 0 0 auto;
    }
    h1 {
      margin: 0;
      color: #1f7f52;
      font-size: 32px;
      line-height: 1.15;
      font-weight: 850;
      letter-spacing: 0;
    }
    .subtitle {
      margin-top: 6px;
      color: #718079;
      font-size: 18px;
      line-height: 1.25;
      white-space: nowrap;
    }
    .summary {
      display: flex;
      align-items: center;
      gap: 16px;
      color: #435047;
      font-size: 16px;
      white-space: nowrap;
    }
    .summary strong {
      color: #1f7f52;
      font-size: 21px;
      margin-left: 5px;
    }
    .table-wrap {
      padding: 0 26px 28px;
      background: #fbfcfb;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    thead th {
      height: 52px;
      border-bottom: 1px solid #dce4df;
      color: #57645d;
      font-size: 15px;
      line-height: 1.2;
      text-align: left;
      font-weight: 800;
      background: #fbfcfb;
    }
    tbody td {
      height: 58px;
      border-bottom: 1px solid #e5ebe7;
      color: #28343c;
      font-size: 16px;
      line-height: 1.25;
      vertical-align: middle;
    }
    tbody tr:last-child td { border-bottom: 0; }
    .course-col { width: 260px; }
    .credit-col { width: 64px; }
    .property-col { width: 86px; }
    .status-col { width: 124px; }
    .time-col { width: 110px; }
    .score-col { width: 76px; }
    .point-col { width: 76px; }
    .avg-col { width: 76px; }
    .rank-col { width: 86px; }
    .delta-col { width: 110px; }
    .course-name {
      color: #23313a;
      font-size: 17px;
      font-weight: 800;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .course-meta {
      margin-top: 3px;
      color: #7a8780;
      font-size: 13px;
      line-height: 1.15;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .num {
      font-variant-numeric: tabular-nums;
      font-weight: 760;
    }
    .score {
      color: #1f7f52;
      font-size: 18px;
      font-weight: 850;
    }
    .muted {
      color: #8a9690;
      font-weight: 700;
    }
    .gpa-delta {
      font-variant-numeric: tabular-nums;
      font-size: 17px;
      font-weight: 850;
    }
    .gpa-positive { color: #16824d; }
    .gpa-negative { color: #c43d3d; }
    .gpa-zero { color: #56635d; }
    .gpa-not-counted,
    .gpa-pending,
    .gpa-missing,
    .gpa-anonymous { color: #8a9690; }
    .status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 70px;
      height: 28px;
      padding: 0 11px;
      border-radius: 999px;
      font-size: 14px;
      line-height: 1;
      font-weight: 850;
    }
    .status-confirmed { color: #176b45; background: #dff4e8; }
    .status-recorded { color: #8a5c08; background: #fff1cf; }
    .status-pending { color: #6a6f78; background: #edf1ef; }
    .empty {
      height: 210px;
      text-align: center;
      color: #7d8a84;
      font-size: 22px;
      font-weight: 800;
    }
  </style>
</head>
<body>
  <main id="hbu-jw-term-scores-card">
    <section class="sheet">
      <header class="header">
        <div class="brand">
          <div class="seal">HBU</div>
          <div>
            <h1>${escapeHtml(view.title)}</h1>
            <div class="subtitle">${escapeHtml(view.subtitle)}</div>
          </div>
        </div>
        <div class="summary">
          <span>确定<strong>${view.confirmedCount}</strong></span>
          <span>已录入<strong>${view.recordedCount}</strong></span>
          <span>尚未录入<strong>${view.pendingCount}</strong></span>
        </div>
      </header>
      <section class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="course-col">课程</th>
              <th class="credit-col">学分</th>
              <th class="property-col">属性</th>
              <th class="status-col">状态</th>
              <th class="time-col">时间</th>
              <th class="score-col">成绩</th>
              <th class="point-col">绩点</th>
              <th class="avg-col">均分</th>
              <th class="rank-col">名次</th>
              <th class="delta-col">GPA增量</th>
            </tr>
          </thead>
          <tbody>
            ${view.rows.length === 0 ? '<tr><td class="empty" colspan="10">暂无本学期成绩</td></tr>' : view.rows.map(renderScoreRow).join('')}
          </tbody>
        </table>
      </section>
    </section>
  </main>
</body>
</html>`;
}

function toRowView(
  row: HbuJwThisTermScoreRow,
  gpaDelta: HbuJwTermScoreGpaDelta,
  mode: HbuJwTermScoresMode,
  statusOverrides: ReadonlyMap<HbuJwThisTermScoreRow, HbuJwTermScoreStatus>,
): HbuJwTermScoreRowView {
  const status = resolveTermScoreStatus(row, statusOverrides);
  const anonymous = mode === 'anonymous';
  return {
    courseNumber: readOptionalText(row.id?.courseNumber),
    sequenceNumber: normalizeSequenceNumber(row.coureSequenceNumber),
    courseName: readOptionalText(row.courseName) || '未知课程',
    creditText: formatNumber(parseCredit(row.credit)),
    propertyName: readOptionalText(row.coursePropertyName) || '未标注',
    statusText: formatStatusText(status),
    statusKind: status.kind,
    timeText: formatOperationTime(row.operatetime),
    scoreText: anonymous ? ANONYMIZED_TEXT : formatScoreText(row, status.kind),
    gradePointText: anonymous ? ANONYMIZED_TEXT : formatConfirmedNumber(row.gradePoint, status.kind),
    averageText: formatConfirmedValue(row.avgcj, status.kind),
    rankText: anonymous ? ANONYMIZED_TEXT : formatConfirmedValue(row.rank, status.kind),
    gpaDeltaText: gpaDelta.text,
    gpaDeltaKind: gpaDelta.kind,
  };
}

type HbuJwTermScoreRawStatusKind = 'confirmed' | 'needs-look' | 'pending';

function readRawTermScoreStatus(row: HbuJwThisTermScoreRow): HbuJwTermScoreRawStatusKind {
  const code = readOptionalText(row.inputStatusCode);
  const text = readOptionalText(row.inputStatusExplain);
  if (code === CONFIRMED_STATUS_CODE || text === '确定') return 'confirmed';
  if (code === PENDING_STATUS_CODE || text.includes('尚未录入') || text.includes('未录入')) return 'pending';
  if (code === LOOK_REQUIRED_STATUS_CODE || text.includes('暂存')) return 'needs-look';
  const courseName = readOptionalText(row.courseName) || '未知课程';
  throw new HbuJwQueryError(`课程 ${courseName} 返回了未知录入状态：${text || code || '<空>'}。`);
}

function resolveTermScoreStatus(
  row: HbuJwThisTermScoreRow,
  statusOverrides: ReadonlyMap<HbuJwThisTermScoreRow, HbuJwTermScoreStatus>,
): HbuJwTermScoreStatus {
  const override = statusOverrides.get(row);
  if (override) return override;
  const rawStatus = readRawTermScoreStatus(row);
  if (rawStatus === 'confirmed') return { kind: 'confirmed' };
  if (rawStatus === 'pending') return { kind: 'pending' };
  const courseName = readOptionalText(row.courseName) || '未知课程';
  throw new HbuJwQueryError(`课程 ${courseName} 缺少分项成绩 look 结果。`);
}

function classifyTermScoreStatus(
  row: HbuJwThisTermScoreRow,
  statusOverrides: ReadonlyMap<HbuJwThisTermScoreRow, HbuJwTermScoreStatus>,
): HbuJwTermScoreStatusKind {
  return resolveTermScoreStatus(row, statusOverrides).kind;
}

function formatStatusText(status: HbuJwTermScoreStatus): string {
  if (status.kind === 'confirmed') return '确定';
  if (status.kind === 'recorded') return `已录入${status.recordedCount}`;
  return '尚未录入';
}

function formatScoreText(row: HbuJwThisTermScoreRow, statusKind: HbuJwTermScoreStatusKind): string {
  if (statusKind !== 'confirmed' && statusKind !== 'recorded') return '—';
  const score = readOptionalText(row.courseScore);
  if (score) return score;
  const level = readOptionalText(row.levelName);
  return level || '—';
}

function formatConfirmedNumber(value: unknown, statusKind: HbuJwTermScoreStatusKind): string {
  if (statusKind !== 'confirmed') return '—';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '—';
  return formatNumber(parsed);
}

function formatConfirmedValue(value: unknown, statusKind: HbuJwTermScoreStatusKind): string {
  if (statusKind !== 'confirmed') return '—';
  return readOptionalText(value) || '—';
}

function parseCredit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

interface HbuJwTermScoreGpaDelta {
  text: string;
  kind: HbuJwTermScoreGpaDeltaKind;
}

function calculateTermScoreGpaDeltas(
  rows: HbuJwThisTermScoreRow[],
  allPassingRows: HbuJwScoreRow[],
  statusOverrides: ReadonlyMap<HbuJwThisTermScoreRow, HbuJwTermScoreStatus>,
): Map<string, HbuJwTermScoreGpaDelta> {
  const evaluationsByCourseNumber = new Map<string, HbuJwGpaCourseEvaluation>();
  const includedByCourseNumber = new Map<string, HbuJwIncludedGpaCourse>();
  const includedCourses: HbuJwIncludedGpaCourse[] = [];
  for (const row of allPassingRows) {
    const evaluation = evaluateHbuJwGpaCourse(row);
    const courseNumber = evaluation.course.courseNumber;
    evaluationsByCourseNumber.set(courseNumber, evaluation);
    if (evaluation.kind === 'included') {
      includedCourses.push(evaluation.course);
      includedByCourseNumber.set(courseNumber, evaluation.course);
    }
  }

  const currentIncludedCourseNumbers = new Set<string>();
  for (const row of rows) {
    if (classifyTermScoreStatus(row, statusOverrides) !== 'confirmed') continue;
    const courseNumber = readOptionalText(row.id?.courseNumber);
    if (includedByCourseNumber.has(courseNumber)) {
      currentIncludedCourseNumbers.add(courseNumber);
    }
  }

  let totals = createHbuJwGpaTotals(
    includedCourses.filter((course) => !currentIncludedCourseNumbers.has(course.courseNumber)),
  );
  const remainingCurrentCourses = new Map(
    [...currentIncludedCourseNumbers].map((courseNumber) => [courseNumber, includedByCourseNumber.get(courseNumber)!]),
  );
  const result = new Map<string, HbuJwTermScoreGpaDelta>();

  for (const row of rows) {
    const key = termScoreKey(row);
    const statusKind = classifyTermScoreStatus(row, statusOverrides);
    if (statusKind === 'recorded') {
      result.set(key, { text: '待确定', kind: 'pending' });
      continue;
    }
    if (statusKind !== 'confirmed') {
      result.set(key, missingGpaDelta());
      continue;
    }

    const courseNumber = readOptionalText(row.id?.courseNumber);
    const evaluation = evaluationsByCourseNumber.get(courseNumber);
    if (!evaluation) {
      result.set(key, missingGpaDelta());
      continue;
    }
    if (evaluation.kind === 'excluded') {
      result.set(key, { text: '不计', kind: 'not-counted' });
      continue;
    }

    const course = remainingCurrentCourses.get(courseNumber);
    if (!course) {
      result.set(key, missingGpaDelta());
      continue;
    }

    const before = calculateHbuJwGpaFromTotals(totals);
    const nextTotals = addHbuJwGpaCourseToTotals(totals, course);
    const after = calculateHbuJwGpaFromTotals(nextTotals);
    totals = nextTotals;
    remainingCurrentCourses.delete(courseNumber);

    if (before == null || after == null) {
      result.set(key, missingGpaDelta());
      continue;
    }
    result.set(key, formatGpaDelta(after - before));
  }

  return result;
}

function compareTermScoreRows(
  left: HbuJwThisTermScoreRow,
  right: HbuJwThisTermScoreRow,
  statusOverrides: ReadonlyMap<HbuJwThisTermScoreRow, HbuJwTermScoreStatus>,
): number {
  const statusDiff = statusSortWeight(classifyTermScoreStatus(left, statusOverrides)) - statusSortWeight(classifyTermScoreStatus(right, statusOverrides));
  if (statusDiff !== 0) return statusDiff;

  const timeDiff = sortOperationTime(left.operatetime).localeCompare(sortOperationTime(right.operatetime));
  if (timeDiff !== 0) return timeDiff;

  const nameDiff = readOptionalText(left.courseName).localeCompare(readOptionalText(right.courseName), 'zh-CN');
  if (nameDiff !== 0) return nameDiff;

  return readOptionalText(left.id?.courseNumber).localeCompare(readOptionalText(right.id?.courseNumber));
}

function statusSortWeight(statusKind: HbuJwTermScoreStatusKind): number {
  if (statusKind === 'confirmed') return 0;
  if (statusKind === 'recorded') return 1;
  return 2;
}

async function resolveLookStatusOverrides(
  loadDetails: (params: HbuJwSubitemScoreLookParams) => Promise<HbuJwSubitemScoreLookResult>,
  rows: HbuJwThisTermScoreRow[],
): Promise<Map<HbuJwThisTermScoreRow, HbuJwTermScoreStatus>> {
  const rowsNeedingLook = rows.filter((row) => readRawTermScoreStatus(row) !== 'confirmed');
  if (rowsNeedingLook.length === 0) return new Map<HbuJwThisTermScoreRow, HbuJwTermScoreStatus>();

  const overrides = new Map<HbuJwThisTermScoreRow, HbuJwTermScoreStatus>();
  await Promise.all(rowsNeedingLook.map(async (row) => {
    const result = await loadDetails(buildSubitemScoreLookParamsFromThisTermRow(row));
    const recordedCount = result.rows.filter(isPrimarySubitemScoreType).length;
    overrides.set(row, recordedCount > 0 ? { kind: 'recorded', recordedCount } : { kind: 'pending' });
  }));
  return overrides;
}

function isPrimarySubitemScoreType(row: { id?: { scoreTypeCode?: string | null } | null }): boolean {
  const code = readOptionalText(row.id?.scoreTypeCode);
  return code === '001' || code === '1';
}

function sortOperationTime(value: unknown): string {
  const text = readOptionalText(value);
  return /^\d{14}$/.test(text) ? text : '99999999999999';
}

function formatOperationTime(value: unknown): string {
  const text = readOptionalText(value);
  if (!text) return '—';
  if (/^\d{14}$/.test(text)) {
    return `${text.slice(4, 6)}-${text.slice(6, 8)} ${text.slice(8, 10)}:${text.slice(10, 12)}`;
  }
  return text;
}

function formatGpaDelta(value: number): HbuJwTermScoreGpaDelta {
  const rounded = Number(value.toFixed(3));
  if (rounded > 0) return { text: `+${rounded.toFixed(3)}`, kind: 'positive' };
  if (rounded < 0) return { text: rounded.toFixed(3), kind: 'negative' };
  return { text: '0.000', kind: 'zero' };
}

function missingGpaDelta(): HbuJwTermScoreGpaDelta {
  return { text: EMPTY_DELTA_TEXT, kind: 'missing' };
}

function anonymizedGpaDelta(): HbuJwTermScoreGpaDelta {
  return { text: ANONYMIZED_TEXT, kind: 'anonymous' };
}

function termScoreKey(row: HbuJwThisTermScoreRow): string {
  return [
    readOptionalText(row.id?.courseNumber),
    normalizeSequenceNumber(row.coureSequenceNumber),
    readOptionalText(row.id?.examtime),
    readOptionalText(row.courseName),
  ].join('\u0000');
}

function formatTermLabel(rows: HbuJwThisTermScoreRow[]): string {
  const planNumber = rows.map((row) => readOptionalText(row.id?.executiveEducationPlanNumber)).find(Boolean);
  const parsed = planNumber ? planNumber.match(/^(\d{4})-(\d{4})-([12])-\d+$/) : null;
  if (parsed) {
    return `${parsed[1]}-${parsed[2]} ${parsed[3] === '1' ? '秋' : '春'}`;
  }
  const termName = rows.map((row) => readOptionalText(row.termName)).find(Boolean);
  return termName ? `本学期 ${termName}` : '本学期';
}

function normalizeSequenceNumber(value: unknown): string {
  const text = readOptionalText(value);
  return text === 'NONE' ? '' : text;
}

function readOptionalText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function renderScoreRow(row: HbuJwTermScoreRowView): string {
  const statusClass = `status-${row.statusKind}`;
  const courseMeta = [row.courseNumber, row.sequenceNumber ? `课序 ${row.sequenceNumber}` : ''].filter(Boolean).join(' · ');
  const scoreMuted = row.scoreText === EMPTY_DELTA_TEXT || row.scoreText === ANONYMIZED_TEXT;
  const pointMuted = row.gradePointText === EMPTY_DELTA_TEXT || row.gradePointText === ANONYMIZED_TEXT;
  const averageMuted = row.averageText === EMPTY_DELTA_TEXT;
  const rankMuted = row.rankText === EMPTY_DELTA_TEXT || row.rankText === ANONYMIZED_TEXT;
  return `<tr>
    <td class="course-col">
      <div class="course-name">${escapeHtml(row.courseName)}</div>
      <div class="course-meta">${escapeHtml(courseMeta || '课程号未返回')}</div>
    </td>
    <td class="credit-col num">${escapeHtml(row.creditText)}</td>
    <td class="property-col">${escapeHtml(row.propertyName)}</td>
    <td class="status-col"><span class="status ${statusClass}">${escapeHtml(row.statusText)}</span></td>
    <td class="time-col ${row.timeText === '—' ? 'muted' : 'num'}">${escapeHtml(row.timeText)}</td>
    <td class="score-col ${scoreMuted ? 'muted' : 'score'}">${escapeHtml(row.scoreText)}</td>
    <td class="point-col ${pointMuted ? 'muted' : 'num'}">${escapeHtml(row.gradePointText)}</td>
    <td class="avg-col ${averageMuted ? 'muted' : 'num'}">${escapeHtml(row.averageText)}</td>
    <td class="rank-col ${rankMuted ? 'muted' : 'num'}">${escapeHtml(row.rankText)}</td>
    <td class="delta-col gpa-delta gpa-${row.gpaDeltaKind}">${escapeHtml(row.gpaDeltaText)}</td>
  </tr>`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/g, '').replace(/\.$/g, '');
}
