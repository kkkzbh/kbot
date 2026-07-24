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
  buildSubitemScoreLookParamsFromThisTermRow,
  type HbuJwHttpClient,
} from './jw-client.js';
import {
  type HbuJwSubitemScoreDetailRow,
  type HbuJwSubitemScoreLookParams,
  type HbuJwSubitemScoreTerm,
  type HbuJwScoreRow,
  HbuJwUserError,
  type HbuJwThisTermScoreRow,
  type OwnerIdentity,
  type SerializedCookieJar,
} from './types.js';

const COURSE_QUERY_WIDTH = 1280;
const COURSE_QUERY_PAGE_SIZE = 100;
const COURSE_QUERY_SCORE_FIELDS = ['pscj', 'qzcj', 'qmcj', 'zcj'] as const;

export interface HbuJwCourseQueryAuthServiceLike {
  ensureAuthenticated(identity: OwnerIdentity): Promise<
    | { kind: 'authenticated'; cookieJar: SerializedCookieJar; credentialVersion?: number }
    | { kind: 'needs_binding'; reason: string }
    | { kind: 'invalid'; reason: string }
    | { kind: 'unavailable'; reason: string }
  >;
}

export interface HbuJwCourseQueryPuppeteerLike {
  page(): Promise<HbuJwCourseQueryPageLike>;
}

interface HbuJwCourseQueryPageLike {
  setViewport?(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<unknown>;
  goto(url: string, options?: unknown): Promise<unknown>;
  waitForSelector?(selector: string, options?: unknown): Promise<unknown>;
  $(selector: string): Promise<HbuJwCourseQueryElementLike | null>;
  screenshot(options?: unknown): Promise<Buffer | Uint8Array | string>;
  close(): Promise<unknown>;
}

interface HbuJwCourseQueryElementLike {
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
}

export interface HbuJwCourseQueryCommandInput {
  courseQuery: string;
  sequenceOffsetInput?: string;
}

export interface HbuJwCourseQueryCourseCandidate {
  courseName: string;
  courseNumber: string;
  sequenceNumber: string;
  propertyName: string;
  termCode: string;
  termLabel: string;
  params: HbuJwSubitemScoreLookParams;
}

interface HbuJwCourseQueryCandidateLoad {
  candidates: HbuJwCourseQueryCourseCandidate[];
  result: HbuJwAcademicQueryResult<unknown>;
  sourceRowCount: number;
}

export interface HbuJwOwnCourseScoreCandidate {
  courseName: string;
  courseNumber: string;
  sequenceNumber: string;
  propertyName: string;
  academicYear: string;
  termName: string;
  row: HbuJwScoreRow;
}

export interface HbuJwCourseQueryResultView {
  title: string;
  subtitle: string;
  course: HbuJwCourseQueryCourseCandidate;
  totalRows: number;
  pageNumber: number;
  pageCount: number;
  emptyMessage: string;
  rows: HbuJwCourseQueryDetailView[];
}

export interface HbuJwCourseQueryDetailView {
  studentNumber: string;
  scoreTypeText: string;
  regularScore: string;
  midtermScore: string;
  finalScore: string;
  totalScore: string;
  dateText: string;
}

export interface HbuJwOwnCourseScoreMetadata {
  label: string;
  value: string;
}

export interface HbuJwOwnCourseScoreView {
  title: string;
  subtitle: string;
  courseName: string;
  courseNumber: string;
  sequenceNumber: string;
  scoreText: string;
  gradePointText: string;
  averageText: string;
  rankText: string;
  metadata: HbuJwOwnCourseScoreMetadata[];
}

export class HbuJwCourseQueryService {
  constructor(
    private readonly authService: HbuJwCourseQueryAuthServiceLike,
    private readonly jwClient: Pick<HbuJwHttpClient, 'getAllPassingScores' | 'getThisTermScores' | 'getSubitemScoreTerms' | 'getSubitemScoreDetails'>,
    private readonly puppeteer: HbuJwCourseQueryPuppeteerLike,
    private readonly academicCache?: Pick<HbuJwAcademicCache, 'getAllPassingScores' | 'getThisTermScores' | 'getSubitemScoreTerms' | 'getSubitemScoreDetails'>,
  ) {}

  async queryHelp(qqUserId: string): Promise<Fragment> {
    return [h.at(qqUserId), h.text('\n'), await renderHbuJwCourseQueryHelpImage(this.puppeteer)];
  }

  async queryCourse(identity: OwnerIdentity, input: HbuJwCourseQueryCommandInput): Promise<Fragment> {
    const auth = await this.authService.ensureAuthenticated(identity);
    if (auth.kind !== 'authenticated') {
      throw new HbuJwUserError(auth.reason);
    }

    const queryResults: Array<HbuJwAcademicQueryResult<unknown>> = [];
    const termsResult = await this.loadSubitemScoreTerms(identity, auth);
    queryResults.push(termsResult);
    const terms = termsResult.data;
    const term = requireSelectedTerm(terms);
    const candidateLoad = await this.loadThisTermCandidates(identity, auth, term, queryResults);
    const matched = matchCourseCandidates(candidateLoad.candidates, input.courseQuery);

    if (matched.length === 0) {
      throw new HbuJwUserError(formatCourseNotFoundMessage({
        query: input.courseQuery,
        term,
        candidateCount: candidateLoad.candidates.length,
        result: candidateLoad.result,
        sourceRowCount: candidateLoad.sourceRowCount,
      }));
    }
    if (matched.length > 1) {
      throw new HbuJwUserError(formatAmbiguousCourseMessage(input.courseQuery, matched));
    }

    const course = withSequenceOffset(matched[0]!, input.sequenceOffsetInput);
    const result = await this.loadSubitemScoreDetails(identity, auth, course.params);
    queryResults.push(result);
    const pages = buildHbuJwCourseQueryResultViews(course, result.data.rows);
    const images = await Promise.all(pages.map((page) => renderHbuJwCourseQueryResultImage(this.puppeteer, page)));
    const notice = formatAcademicFallbackNotice(queryResults);
    return [h.at(identity.qqUserId), h.text(notice ? `\n${notice}\n` : '\n'), ...interleaveImages(images)];
  }

  async queryOwnCourseScore(identity: OwnerIdentity, courseQuery: string): Promise<Fragment> {
    const auth = await this.authService.ensureAuthenticated(identity);
    if (auth.kind !== 'authenticated') {
      throw new HbuJwUserError(auth.reason);
    }

    const result = await this.loadAllPassingScores(identity, auth);
    const candidates = result.data.map(candidateFromPassingScoreRow);
    const matched = matchCourseCandidates(candidates, courseQuery);
    if (matched.length === 0) {
      throw new HbuJwUserError(`全部及格成绩中未找到“${courseQuery}”。请检查课程名或改用课程号。`);
    }
    const distinctCourses = new Set(matched.map((course) => `${course.courseNumber}\u0000${course.courseName}`));
    if (distinctCourses.size > 1) {
      throw new HbuJwUserError(formatOwnCourseScoreAmbiguity(courseQuery, matched));
    }

    const views = sortOwnCourseScoreCandidates(matched).map(buildHbuJwOwnCourseScoreView);
    const images = await Promise.all(views.map((view) => renderHbuJwOwnCourseScoreImage(this.puppeteer, view)));
    const notice = formatAcademicFallbackNotice([result]);
    return [
      h.at(identity.qqUserId),
      h.text(notice ? `\n${notice}\n` : '\n'),
      ...interleaveImages(images),
    ];
  }

  private async loadThisTermCandidates(
    identity: OwnerIdentity,
    auth: { cookieJar: SerializedCookieJar; credentialVersion?: number },
    term: HbuJwSubitemScoreTerm,
    queryResults: Array<HbuJwAcademicQueryResult<unknown>>,
  ): Promise<HbuJwCourseQueryCandidateLoad> {
    const result = this.academicCache
      ? await this.academicCache.getThisTermScores(identity, auth, hbuJwDatabaseFallbackPolicy())
      : { data: await this.jwClient.getThisTermScores(auth.cookieJar), source: 'remote' as const, fetchedAt: Date.now() };
    queryResults.push(result);
    const candidates = result.data
      .filter((row) => readText(row.id?.executiveEducationPlanNumber) === term.code)
      .map((row) => candidateFromThisTermRow(row, term));
    return {
      candidates,
      result,
      sourceRowCount: result.data.length,
    };
  }

  private async loadSubitemScoreTerms(
    identity: OwnerIdentity,
    auth: { cookieJar: SerializedCookieJar; credentialVersion?: number },
  ): Promise<HbuJwAcademicQueryResult<HbuJwSubitemScoreTerm[]>> {
    if (this.academicCache) {
      return this.academicCache.getSubitemScoreTerms(identity, auth, hbuJwDatabaseFallbackPolicy());
    }
    return { data: await this.jwClient.getSubitemScoreTerms(auth.cookieJar), source: 'remote', fetchedAt: Date.now() };
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
  ): Promise<Awaited<ReturnType<HbuJwAcademicCache['getSubitemScoreDetails']>>> {
    if (this.academicCache) {
      return this.academicCache.getSubitemScoreDetails(identity, auth, params, hbuJwDatabaseFallbackPolicy());
    }
    return { data: await this.jwClient.getSubitemScoreDetails(auth.cookieJar, params), source: 'remote', fetchedAt: Date.now() };
  }
}

export function resolveCourseQuerySequenceNumber(input: string): string {
  const normalized = input.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new HbuJwUserError('课序偏移必须是非负整数，例如 0 表示课序 01，1 表示课序 02。');
  }
  const offset = Number(normalized);
  if (!Number.isSafeInteger(offset) || offset > 98) {
    throw new HbuJwUserError('课序偏移只支持 0 到 98，分别对应课序 01 到 99。');
  }
  return String(offset + 1).padStart(2, '0');
}

export function matchCourseCandidates<T extends Pick<HbuJwCourseQueryCourseCandidate, 'courseName' | 'courseNumber'>>(
  candidates: T[],
  query: string,
): T[] {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return [];
  const exactCourseNumber = candidates.filter((course) => normalizeQuery(course.courseNumber) === normalizedQuery);
  if (exactCourseNumber.length > 0) return exactCourseNumber;
  const nameMatches = candidates
    .map((course) => {
      const normalizedName = normalizeQuery(course.courseName);
      return {
        course,
        startIndex: normalizedName.indexOf(normalizedQuery),
        nameLength: normalizedName.length,
      };
    })
    .filter((match) => match.startIndex >= 0);
  if (nameMatches.length === 0) return [];

  const leftmostIndex = Math.min(...nameMatches.map((match) => match.startIndex));
  const leftmostMatches = nameMatches.filter((match) => match.startIndex === leftmostIndex);
  const shortestLength = Math.min(...leftmostMatches.map((match) => match.nameLength));
  return leftmostMatches
    .filter((match) => match.nameLength === shortestLength)
    .map((match) => match.course);
}

export function buildHbuJwCourseQueryResultViews(
  course: HbuJwCourseQueryCourseCandidate,
  rows: HbuJwSubitemScoreDetailRow[],
): HbuJwCourseQueryResultView[] {
  const visibleRows = sortCourseQueryRows(selectRowsWithRecordedScoreTypes(rows));
  const scoreTypeCodes = uniqueScoreTypeCodes(visibleRows);
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / COURSE_QUERY_PAGE_SIZE));
  const pages: HbuJwCourseQueryResultView[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    const pageRows = visibleRows.slice(index * COURSE_QUERY_PAGE_SIZE, (index + 1) * COURSE_QUERY_PAGE_SIZE);
    pages.push({
      title: '课程查询',
      subtitle: formatCourseQuerySubtitle(course, visibleRows.length, rows.length, scoreTypeCodes),
      course,
      totalRows: visibleRows.length,
      pageNumber: index + 1,
      pageCount,
      emptyMessage: formatCourseQueryEmptyMessage(rows.length),
      rows: pageRows.map(toDetailView),
    });
  }
  return pages;
}

export function buildHbuJwOwnCourseScoreView(
  course: HbuJwOwnCourseScoreCandidate,
): HbuJwOwnCourseScoreView {
  const source = course.row;
  return {
    title: '课程成绩详情',
    subtitle: `${formatOwnCourseTerm(course)} · ${course.courseName} · 本人成绩`,
    courseName: course.courseName,
    courseNumber: course.courseNumber,
    sequenceNumber: course.sequenceNumber,
    scoreText: formatScoreCell(source.courseScore),
    gradePointText: formatScoreCell(source.gradePointScore),
    averageText: formatScoreCell(source.avgcj),
    rankText: formatScoreCell(source.rank),
    metadata: [
      { label: '学年', value: course.academicYear || '—' },
      { label: '学期', value: course.termName || '—' },
      { label: '学分', value: formatScoreCell(source.credit) },
      { label: '课程性质', value: course.propertyName },
      { label: '考试时间', value: formatScoreCell(source.examTime ?? source.id?.startTime) },
      { label: '录入时间', value: formatScoreCell(source.operatingTime) },
    ],
  };
}

export async function renderHbuJwCourseQueryHelpImage(
  puppeteer: HbuJwCourseQueryPuppeteerLike,
): Promise<ReturnType<typeof h.image>> {
  return renderCourseQueryImage(puppeteer, 'course-query-help.html', renderHbuJwCourseQueryHelpHtml(), '#hbu-jw-course-query-card');
}

export async function renderHbuJwCourseQueryResultImage(
  puppeteer: HbuJwCourseQueryPuppeteerLike,
  view: HbuJwCourseQueryResultView,
): Promise<ReturnType<typeof h.image>> {
  return renderCourseQueryImage(puppeteer, 'course-query-result.html', renderHbuJwCourseQueryResultHtml(view), '#hbu-jw-course-query-card');
}

export async function renderHbuJwOwnCourseScoreImage(
  puppeteer: HbuJwCourseQueryPuppeteerLike,
  view: HbuJwOwnCourseScoreView,
): Promise<ReturnType<typeof h.image>> {
  return renderCourseQueryImage(puppeteer, 'own-course-score.html', renderHbuJwOwnCourseScoreHtml(view), '#hbu-jw-course-query-card');
}

export function renderHbuJwCourseQueryHelpHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>课程查询</title>
  ${courseQueryBaseStyle()}
</head>
<body>
  <main id="hbu-jw-course-query-card">
    <section class="sheet compact">
      <header class="header">
        <div class="brand"><div class="seal">HBU</div><div><h1>课程查询</h1><p>查询指定课程的分项成绩接口返回</p></div></div>
      </header>
      <section class="help-grid">
        <article>
          <h2>命令格式</h2>
          <p><strong>课程查询 &lt;课程&gt; [课序偏移]</strong></p>
          <p>课程可写课程名关键词或课程号。</p>
        </article>
        <article>
          <h2>示例</h2>
          <p>课程查询 软件工程</p>
          <p>课程查询 软件工程 1</p>
        </article>
        <article>
          <h2>课序偏移</h2>
          <p>省略时查询本人已选课序。</p>
          <p>0 查询课序 01，1 查询课序 02。</p>
          <p>课程查询仅使用本学期数据。</p>
        </article>
      </section>
      <footer>会展示教务接口返回名单，请注意发送场景。</footer>
    </section>
  </main>
</body>
</html>`;
}

export function renderHbuJwCourseQueryResultHtml(view: HbuJwCourseQueryResultView): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(view.title)}</title>
  ${courseQueryBaseStyle()}
</head>
<body>
  <main id="hbu-jw-course-query-card">
    <section class="sheet">
      <header class="header">
        <div class="brand">
          <div class="seal">HBU</div>
          <div>
            <h1>${escapeHtml(view.title)}</h1>
            <p>${escapeHtml(view.subtitle)}</p>
          </div>
        </div>
        <div class="summary">
          <span>${escapeHtml(view.course.courseNumber)}</span>
          <span>课序 ${escapeHtml(view.course.sequenceNumber)}</span>
          <span>${view.pageNumber}/${view.pageCount}</span>
        </div>
      </header>
      <section class="params">
        <span>zxjxjhh=${escapeHtml(view.course.params.zxjxjhh)}</span>
        <span>kch=${escapeHtml(view.course.params.kch)}</span>
        <span>kxh=${escapeHtml(view.course.params.kxh)}</span>
        <span>kssj=${escapeHtml(view.course.params.kssj)}</span>
        <span>kcsxdm=${escapeHtml(view.course.params.kcsxdm)}</span>
      </section>
      <section class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="student-col">学生</th>
              <th class="type-col">类型</th>
              <th>平时</th>
              <th>期中</th>
              <th>期末</th>
              <th>总评</th>
              <th class="date-col">日期</th>
            </tr>
          </thead>
          <tbody>
            ${view.rows.length === 0 ? `<tr><td class="empty" colspan="7">${escapeHtml(view.emptyMessage)}</td></tr>` : view.rows.map(renderDetailRow).join('')}
          </tbody>
        </table>
      </section>
    </section>
  </main>
</body>
</html>`;
}

export function renderHbuJwOwnCourseScoreHtml(view: HbuJwOwnCourseScoreView): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(view.title)}</title>
  ${courseQueryBaseStyle()}
</head>
<body>
  <main id="hbu-jw-course-query-card">
    <section class="sheet">
      <header class="header">
        <div class="brand">
          <div class="seal">HBU</div>
          <div>
            <h1>${escapeHtml(view.title)}</h1>
            <p>${escapeHtml(view.subtitle)}</p>
          </div>
        </div>
        <div class="summary">
          <span>${escapeHtml(view.courseNumber)}</span>
          <span>课序 ${escapeHtml(view.sequenceNumber)}</span>
        </div>
      </header>
      <section class="own-score-overview">
        ${renderOwnScoreMetric('总评成绩', view.scoreText, true)}
        ${renderOwnScoreMetric('绩点', view.gradePointText, true)}
        ${renderOwnScoreMetric('班级平均', view.averageText)}
        ${renderOwnScoreMetric('排名', view.rankText)}
      </section>
      <section class="own-score-metadata">
        ${view.metadata.map(renderOwnScoreMetadata).join('')}
      </section>
    </section>
  </main>
</body>
</html>`;
}

async function renderCourseQueryImage(
  puppeteer: HbuJwCourseQueryPuppeteerLike,
  filename: string,
  html: string,
  selector: string,
): Promise<ReturnType<typeof h.image>> {
  const page = await puppeteer.page();
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'qqbot-hbu-jw-course-query-'));
    const htmlPath = join(tempDir, filename);
    await writeFile(htmlPath, html, 'utf8');
    await page.setViewport?.({ width: COURSE_QUERY_WIDTH, height: 1600, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
    await page.waitForSelector?.(selector, { timeout: 5000 });
    const card = await page.$(selector);
    if (!card) throw new Error('hbu jw course query root not found');
    const box = await card.boundingBox();
    if (!box) throw new Error('hbu jw course query root has no bounding box');
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

function candidateFromThisTermRow(row: HbuJwThisTermScoreRow, term: HbuJwSubitemScoreTerm): HbuJwCourseQueryCourseCandidate {
  return {
    courseName: readText(row.courseName) || '未知课程',
    courseNumber: readText(row.id?.courseNumber),
    sequenceNumber: normalizeSequenceNumber(row.coureSequenceNumber),
    propertyName: readText(row.coursePropertyName) || '未标注',
    termCode: term.code,
    termLabel: term.label,
    params: buildSubitemScoreLookParamsFromThisTermRow(row),
  };
}

function candidateFromPassingScoreRow(row: HbuJwScoreRow): HbuJwOwnCourseScoreCandidate {
  return {
    courseName: readText(row.courseName) || '未知课程',
    courseNumber: readText(row.id?.courseNumber),
    sequenceNumber: normalizeSequenceNumber(row.id?.coureSequenceNumber),
    propertyName: readText(row.xkcsxmc ?? row.courseAttributeName) || '未标注',
    academicYear: readText(row.academicYearCode),
    termName: readText(row.termName),
    row,
  };
}

function withSequenceOffset(
  course: HbuJwCourseQueryCourseCandidate,
  sequenceOffsetInput: string | undefined,
): HbuJwCourseQueryCourseCandidate {
  if (sequenceOffsetInput === undefined) return course;
  const sequenceNumber = resolveCourseQuerySequenceNumber(sequenceOffsetInput);
  return {
    ...course,
    sequenceNumber,
    params: {
      ...course.params,
      kxh: sequenceNumber,
    },
  };
}

function requireSelectedTerm(terms: HbuJwSubitemScoreTerm[]): HbuJwSubitemScoreTerm {
  const term = terms.find((item) => item.selected);
  if (!term) throw new HbuJwUserError('教务学期列表没有当前学期。');
  return term;
}

function formatAmbiguousCourseMessage(query: string, matched: HbuJwCourseQueryCourseCandidate[]): string {
  const lines = matched.slice(0, 8).map((course) => `${course.courseNumber} ${course.courseName} 课序${course.sequenceNumber}`);
  const suffix = matched.length > 8 ? `\n还有 ${matched.length - 8} 门未显示。` : '';
  return `“${query}”匹配到多门课程，请使用课程号或更完整名称：\n${lines.join('\n')}${suffix}`;
}

function formatOwnCourseScoreAmbiguity(query: string, matched: HbuJwOwnCourseScoreCandidate[]): string {
  const uniqueCourses = [...new Map(matched.map((course) => [
    `${course.courseNumber}\u0000${course.courseName}`,
    course,
  ])).values()];
  const lines = uniqueCourses.slice(0, 8).map((course) => `${course.courseNumber} ${course.courseName}`);
  const suffix = uniqueCourses.length > 8 ? `\n还有 ${uniqueCourses.length - 8} 门未显示。` : '';
  return `“${query}”匹配到多门课程，请使用课程号或更完整名称：\n${lines.join('\n')}${suffix}`;
}

function sortOwnCourseScoreCandidates(candidates: HbuJwOwnCourseScoreCandidate[]): HbuJwOwnCourseScoreCandidate[] {
  return [...candidates].sort((left, right) => {
    const yearComparison = right.academicYear.localeCompare(left.academicYear, 'zh-CN', { numeric: true });
    if (yearComparison !== 0) return yearComparison;
    return ownCourseTermOrder(right.termName) - ownCourseTermOrder(left.termName);
  });
}

function ownCourseTermOrder(termName: string): number {
  if (termName === '春') return 2;
  if (termName === '秋') return 1;
  return 0;
}

function formatOwnCourseTerm(course: HbuJwOwnCourseScoreCandidate): string {
  const parts = [course.academicYear, course.termName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : '历史成绩';
}

function formatCourseNotFoundMessage(args: {
  query: string;
  term: HbuJwSubitemScoreTerm;
  candidateCount: number;
  result: HbuJwAcademicQueryResult<unknown>;
  sourceRowCount: number;
}): string {
  const source = args.result.source === 'remote'
    ? `教务“本学期成绩”接口实时返回 ${args.sourceRowCount} 门课程`
    : `教务“本学期成绩”数据库记录共 ${args.sourceRowCount} 门课程`;
  const lines = [
    `课程查询已完成，本学期未找到“${args.query}”。`,
    `当前学期：${args.term.label}（${args.term.code}）。`,
    `数据来源：${source}，其中当前学期 ${args.candidateCount} 门。`,
  ];
  const fallbackNotice = formatAcademicFallbackNotice([args.result]);
  if (fallbackNotice) lines.push(fallbackNotice);
  lines.push('教务“本学期成绩”接口没有返回该课程，Bot无法取得分项查询所需的课程参数。');
  return lines.join('\n');
}

function interleaveImages(images: ReturnType<typeof h.image>[]): Array<ReturnType<typeof h.image> | ReturnType<typeof h.text>> {
  const result: Array<ReturnType<typeof h.image> | ReturnType<typeof h.text>> = [];
  images.forEach((image, index) => {
    if (index > 0) result.push(h.text('\n'));
    result.push(image);
  });
  return result;
}

function toDetailView(row: HbuJwSubitemScoreDetailRow): HbuJwCourseQueryDetailView {
  return {
    studentNumber: readText(row.id?.studentNumber) || '—',
    scoreTypeText: formatScoreTypeCode(row),
    regularScore: formatScoreCell(row.pscj),
    midtermScore: formatScoreCell(row.qzcj),
    finalScore: formatScoreCell(row.qmcj),
    totalScore: formatScoreCell(row.zcj),
    dateText: readText(row.remark) || '—',
  };
}

function renderDetailRow(row: HbuJwCourseQueryDetailView): string {
  return `<tr>
    <td class="student-col num">${escapeHtml(row.studentNumber)}</td>
    <td class="type-col num">${escapeHtml(row.scoreTypeText)}</td>
    <td class="num">${escapeHtml(row.regularScore)}</td>
    <td class="num">${escapeHtml(row.midtermScore)}</td>
    <td class="num">${escapeHtml(row.finalScore)}</td>
    <td class="num total">${escapeHtml(row.totalScore)}</td>
    <td class="date-col num">${escapeHtml(row.dateText)}</td>
  </tr>`;
}

function renderOwnScoreMetric(label: string, value: string, accent = false): string {
  return `<article class="own-score-metric${accent ? ' accent' : ''}">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
  </article>`;
}

function renderOwnScoreMetadata(item: HbuJwOwnCourseScoreMetadata): string {
  return `<article class="own-score-metadata-item">
    <span>${escapeHtml(item.label)}</span>
    <strong>${escapeHtml(item.value)}</strong>
  </article>`;
}

function courseQueryBaseStyle(): string {
  return `<style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #f2f5f1;
      color: #25313a;
      font-family: "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif;
    }
    #hbu-jw-course-query-card {
      width: ${COURSE_QUERY_WIDTH}px;
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
    .sheet.compact { min-height: 500px; }
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
    h2 {
      margin: 0 0 12px;
      color: #1f7f52;
      font-size: 22px;
      line-height: 1.2;
    }
    p {
      margin: 6px 0 0;
      color: #5f6d66;
      font-size: 18px;
      line-height: 1.35;
    }
    .summary {
      display: flex;
      align-items: center;
      gap: 12px;
      color: #435047;
      font-size: 16px;
      white-space: nowrap;
    }
    .summary span,
    .params span {
      display: inline-flex;
      align-items: center;
      height: 28px;
      padding: 0 10px;
      border-radius: 999px;
      background: #edf5ef;
      color: #315443;
      font-weight: 800;
    }
    .help-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      padding: 26px 30px 22px;
    }
    .help-grid article {
      min-height: 170px;
      padding: 22px;
      border: 1px solid #dce4df;
      border-radius: 8px;
      background: #ffffff;
    }
    footer {
      margin: 0 30px 28px;
      padding: 15px 18px;
      border-radius: 8px;
      background: #fff7df;
      color: #73540d;
      font-size: 17px;
      font-weight: 800;
    }
    .params {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding: 18px 26px 0;
      font-size: 14px;
    }
    .table-wrap {
      padding: 14px 26px 28px;
      background: #fbfcfb;
    }
    .own-score-overview {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      padding: 24px 26px 16px;
    }
    .own-score-metric {
      min-height: 112px;
      padding: 18px 20px;
      border: 1px solid #dce4df;
      border-radius: 8px;
      background: #ffffff;
    }
    .own-score-metric span,
    .own-score-metadata-item span {
      display: block;
      color: #718078;
      font-size: 15px;
      font-weight: 760;
    }
    .own-score-metric strong {
      display: block;
      margin-top: 12px;
      color: #27353d;
      font-size: 30px;
      line-height: 1.1;
      font-variant-numeric: tabular-nums;
    }
    .own-score-metric.accent {
      border-color: #b9d9c7;
      background: #edf7f1;
    }
    .own-score-metric.accent strong { color: #1f7f52; }
    .own-score-metadata {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1px;
      margin: 0 26px 24px;
      overflow: hidden;
      border: 1px solid #dce4df;
      border-radius: 8px;
      background: #dce4df;
    }
    .own-score-metadata-item {
      min-height: 78px;
      padding: 15px 17px;
      background: #ffffff;
    }
    .own-score-metadata-item strong {
      display: block;
      margin-top: 8px;
      color: #2b393f;
      font-size: 17px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    thead th {
      height: 48px;
      border-bottom: 1px solid #dce4df;
      color: #57645d;
      font-size: 15px;
      line-height: 1.2;
      text-align: left;
      font-weight: 800;
      background: #fbfcfb;
    }
    tbody td {
      height: 42px;
      border-bottom: 1px solid #e5ebe7;
      color: #28343c;
      font-size: 16px;
      line-height: 1.2;
      vertical-align: middle;
    }
    tbody tr:last-child td { border-bottom: 0; }
    .student-col { width: 230px; }
    .type-col { width: 90px; }
    .date-col { width: 170px; }
    .num {
      font-variant-numeric: tabular-nums;
      font-weight: 760;
    }
    .total {
      color: #1f7f52;
      font-weight: 850;
    }
    .empty {
      height: 150px;
      text-align: center;
      color: #7d8a84;
      font-size: 22px;
      font-weight: 800;
    }
  </style>`;
}

function formatScoreCell(value: unknown): string {
  const text = readText(value);
  return text || '—';
}

function selectRowsWithRecordedScoreTypes(rows: HbuJwSubitemScoreDetailRow[]): HbuJwSubitemScoreDetailRow[] {
  const scoreTypesWithValues = new Set(
    rows
      .filter(hasRecordedScoreValue)
      .map(readScoreTypeCode),
  );
  return rows.filter((row) => scoreTypesWithValues.has(readScoreTypeCode(row)));
}

function sortCourseQueryRows(rows: HbuJwSubitemScoreDetailRow[]): HbuJwSubitemScoreDetailRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => (
      compareStudentNumber(left.row, right.row)
      || compareScoreTypeCode(left.row, right.row)
      || left.index - right.index
    ))
    .map(({ row }) => row);
}

function compareStudentNumber(left: HbuJwSubitemScoreDetailRow, right: HbuJwSubitemScoreDetailRow): number {
  const leftNumber = readText(left.id?.studentNumber);
  const rightNumber = readText(right.id?.studentNumber);
  if (leftNumber && rightNumber) return leftNumber.localeCompare(rightNumber, 'zh-CN', { numeric: true });
  if (leftNumber) return -1;
  if (rightNumber) return 1;
  return 0;
}

function compareScoreTypeCode(left: HbuJwSubitemScoreDetailRow, right: HbuJwSubitemScoreDetailRow): number {
  return readScoreTypeCode(left).localeCompare(readScoreTypeCode(right), 'zh-CN', { numeric: true });
}

function hasRecordedScoreValue(row: HbuJwSubitemScoreDetailRow): boolean {
  return COURSE_QUERY_SCORE_FIELDS.some((field) => readText(row[field]) !== '');
}

function uniqueScoreTypeCodes(rows: HbuJwSubitemScoreDetailRow[]): string[] {
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const code = readScoreTypeCode(row);
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(formatScoreTypeCode(row));
  }
  return codes;
}

function formatCourseQuerySubtitle(
  course: HbuJwCourseQueryCourseCandidate,
  visibleRowCount: number,
  rawRowCount: number,
  scoreTypeCodes: string[],
): string {
  const suffix = scoreTypeCodes.length > 0
    ? `类型 ${scoreTypeCodes.join('/')}`
    : `接口返回 ${rawRowCount} 条记录`;
  return `${course.termLabel} · ${course.courseName} · ${visibleRowCount} 条有效分项成绩 · ${suffix}`;
}

function formatCourseQueryEmptyMessage(rawRowCount: number): string {
  return rawRowCount === 0 ? '接口返回 0 条分项成绩' : `接口返回 ${rawRowCount} 条记录，但成绩字段为空`;
}

function formatScoreTypeCode(row: HbuJwSubitemScoreDetailRow): string {
  return readScoreTypeCode(row) || '未标注';
}

function readScoreTypeCode(row: HbuJwSubitemScoreDetailRow): string {
  const code = readText(row.id?.scoreTypeCode);
  if (!/^\d+$/.test(code)) return code;
  return code.padStart(3, '0');
}

function normalizeQuery(value: string): string {
  return value.replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
}

function normalizeSequenceNumber(value: unknown): string {
  const text = readText(value);
  return text === 'NONE' ? '' : text;
}

function readText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
