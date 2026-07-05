import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { h, type Fragment } from 'koishi';
import {
  buildSubitemScoreLookParamsFromScoreRow,
  buildSubitemScoreLookParamsFromThisTermRow,
  type HbuJwHttpClient,
} from './jw-client.js';
import {
  type HbuJwScoreRow,
  type HbuJwSubitemScoreDetailRow,
  type HbuJwSubitemScoreLookParams,
  type HbuJwSubitemScoreTerm,
  HbuJwUserError,
  type HbuJwThisTermScoreRow,
  type OwnerIdentity,
  type SerializedCookieJar,
} from './types.js';

const COURSE_QUERY_WIDTH = 1280;
const COURSE_QUERY_PAGE_SIZE = 100;

export interface HbuJwCourseQueryAuthServiceLike {
  ensureAuthenticated(identity: OwnerIdentity): Promise<
    | { kind: 'authenticated'; cookieJar: SerializedCookieJar }
    | { kind: 'needs_binding'; reason: string }
    | { kind: 'invalid'; reason: string }
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
  termInput?: string;
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

export interface HbuJwCourseQueryResultView {
  title: string;
  subtitle: string;
  course: HbuJwCourseQueryCourseCandidate;
  totalRows: number;
  pageNumber: number;
  pageCount: number;
  rows: HbuJwCourseQueryDetailView[];
}

export interface HbuJwCourseQueryDetailView {
  studentNumber: string;
  regularScore: string;
  midtermScore: string;
  finalScore: string;
  totalScore: string;
  dateText: string;
}

export class HbuJwCourseQueryService {
  constructor(
    private readonly authService: HbuJwCourseQueryAuthServiceLike,
    private readonly jwClient: Pick<HbuJwHttpClient, 'getThisTermScores' | 'getAllPassingScores' | 'getSubitemScoreTerms' | 'getSubitemScoreDetails'>,
    private readonly puppeteer: HbuJwCourseQueryPuppeteerLike,
  ) {}

  async queryHelp(qqUserId: string): Promise<Fragment> {
    return [h.at(qqUserId), h.text('\n'), await renderHbuJwCourseQueryHelpImage(this.puppeteer)];
  }

  async queryCourse(identity: OwnerIdentity, input: HbuJwCourseQueryCommandInput): Promise<Fragment> {
    const auth = await this.authService.ensureAuthenticated(identity);
    if (auth.kind !== 'authenticated') {
      throw new HbuJwUserError(auth.reason);
    }

    const terms = await this.jwClient.getSubitemScoreTerms(auth.cookieJar);
    const term = resolveCourseQueryTerm(terms, input.termInput ?? '0');
    const currentTerm = requireSelectedTerm(terms);
    const candidates = term.code === currentTerm.code
      ? await this.loadThisTermCandidates(auth.cookieJar, term)
      : await this.loadHistoricalCandidates(auth.cookieJar, term);
    const matched = matchCourseCandidates(candidates, input.courseQuery);

    if (matched.length === 0) {
      throw new HbuJwUserError(`未找到课程：${input.courseQuery}。请发送“课程查询”查看格式。`);
    }
    if (matched.length > 1) {
      throw new HbuJwUserError(formatAmbiguousCourseMessage(input.courseQuery, matched));
    }

    const course = matched[0]!;
    const result = await this.jwClient.getSubitemScoreDetails(auth.cookieJar, course.params);
    const pages = buildHbuJwCourseQueryResultViews(course, result.rows);
    const images = await Promise.all(pages.map((page) => renderHbuJwCourseQueryResultImage(this.puppeteer, page)));
    return [h.at(identity.qqUserId), h.text('\n'), ...interleaveImages(images)];
  }

  private async loadThisTermCandidates(cookieJar: SerializedCookieJar, term: HbuJwSubitemScoreTerm): Promise<HbuJwCourseQueryCourseCandidate[]> {
    const rows = await this.jwClient.getThisTermScores(cookieJar);
    return rows
      .filter((row) => readText(row.id?.executiveEducationPlanNumber) === term.code)
      .map((row) => candidateFromThisTermRow(row, term));
  }

  private async loadHistoricalCandidates(cookieJar: SerializedCookieJar, term: HbuJwSubitemScoreTerm): Promise<HbuJwCourseQueryCourseCandidate[]> {
    const rows = await this.jwClient.getAllPassingScores(cookieJar);
    return rows
      .filter((row) => {
        const id = isRecord(row.id) ? row.id : {};
        return readText(id.executiveEducationPlanNumber) === term.code;
      })
      .map((row) => candidateFromScoreRow(row, term));
  }
}

export function resolveCourseQueryTerm(terms: HbuJwSubitemScoreTerm[], input: string): HbuJwSubitemScoreTerm {
  const termInput = input.trim();
  if (/^\d{4}-\d{4}-[123]-\d+$/.test(termInput)) {
    const term = terms.find((item) => item.code === termInput);
    if (!term) {
      throw new HbuJwUserError(`教务学期列表中没有 ${termInput}。`);
    }
    return term;
  }
  if (!/^-?\d+$/.test(termInput)) {
    throw new HbuJwUserError('学期参数必须是 0、-1、-2 或完整学期号。');
  }
  const offset = Number(termInput);
  if (!Number.isInteger(offset) || offset > 0) {
    throw new HbuJwUserError('学期偏移只支持 0 或负数，例如 -1 表示上一学期。');
  }
  const selectedIndex = terms.findIndex((term) => term.selected);
  if (selectedIndex < 0) {
    throw new HbuJwUserError('教务学期列表没有当前学期。');
  }
  const index = selectedIndex + Math.abs(offset);
  const term = terms[index];
  if (!term) {
    throw new HbuJwUserError(`教务学期列表中没有偏移 ${termInput} 对应的学期。`);
  }
  return term;
}

export function matchCourseCandidates(candidates: HbuJwCourseQueryCourseCandidate[], query: string): HbuJwCourseQueryCourseCandidate[] {
  const normalizedQuery = normalizeQuery(query);
  const exactCourseNumber = candidates.filter((course) => normalizeQuery(course.courseNumber) === normalizedQuery);
  if (exactCourseNumber.length > 0) return exactCourseNumber;
  return candidates.filter((course) => normalizeQuery(course.courseName).includes(normalizedQuery));
}

export function buildHbuJwCourseQueryResultViews(
  course: HbuJwCourseQueryCourseCandidate,
  rows: HbuJwSubitemScoreDetailRow[],
): HbuJwCourseQueryResultView[] {
  const visibleRows = rows.filter(isPrimaryScoreType);
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / COURSE_QUERY_PAGE_SIZE));
  const pages: HbuJwCourseQueryResultView[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    const pageRows = visibleRows.slice(index * COURSE_QUERY_PAGE_SIZE, (index + 1) * COURSE_QUERY_PAGE_SIZE);
    pages.push({
      title: '课程查询',
      subtitle: `${course.termLabel} · ${course.courseName} · ${visibleRows.length} 条 01 返回`,
      course,
      totalRows: visibleRows.length,
      pageNumber: index + 1,
      pageCount,
      rows: pageRows.map(toDetailView),
    });
  }
  return pages;
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
          <p><strong>课程查询 &lt;课程&gt; [学期]</strong></p>
          <p>课程可写课程名关键词或课程号。</p>
        </article>
        <article>
          <h2>示例</h2>
          <p>课程查询 模式识别</p>
          <p>课程查询 2023S01105 -1</p>
        </article>
        <article>
          <h2>学期</h2>
          <p>0 是本学期，-1 是上一学期。</p>
          <p>也可使用 2025-2026-2-2。</p>
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
              <th>平时</th>
              <th>期中</th>
              <th>期末</th>
              <th>总评</th>
              <th class="date-col">日期</th>
            </tr>
          </thead>
          <tbody>
            ${view.rows.length === 0 ? '<tr><td class="empty" colspan="6">接口返回 0 条 01 分项成绩</td></tr>' : view.rows.map(renderDetailRow).join('')}
          </tbody>
        </table>
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

function candidateFromScoreRow(row: HbuJwScoreRow, term: HbuJwSubitemScoreTerm): HbuJwCourseQueryCourseCandidate {
  const id = isRecord(row.id) ? row.id : {};
  return {
    courseName: readText(row.courseName) || '未知课程',
    courseNumber: readText(id.courseNumber),
    sequenceNumber: normalizeSequenceNumber(id.coureSequenceNumber),
    propertyName: readText(row.courseAttributeName) || '未标注',
    termCode: term.code,
    termLabel: term.label,
    params: buildSubitemScoreLookParamsFromScoreRow(row),
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
    <td class="num">${escapeHtml(row.regularScore)}</td>
    <td class="num">${escapeHtml(row.midtermScore)}</td>
    <td class="num">${escapeHtml(row.finalScore)}</td>
    <td class="num total">${escapeHtml(row.totalScore)}</td>
    <td class="date-col num">${escapeHtml(row.dateText)}</td>
  </tr>`;
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
    .student-col { width: 250px; }
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

function isPrimaryScoreType(row: HbuJwSubitemScoreDetailRow): boolean {
  return readText(row.id?.scoreTypeCode) === '001';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
