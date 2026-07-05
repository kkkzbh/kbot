import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { h, type Fragment } from 'koishi';
import type { HbuJwHttpClient } from './jw-client.js';
import {
  HbuJwUserError,
  type HbuJwThisTermScoreRow,
  type OwnerIdentity,
  type SerializedCookieJar,
} from './types.js';

const TERM_SCORES_WIDTH = 1280;
const CONFIRMED_STATUS_CODE = '05';

export interface HbuJwTermScoresAuthServiceLike {
  ensureAuthenticated(identity: OwnerIdentity): Promise<
    | { kind: 'authenticated'; cookieJar: SerializedCookieJar }
    | { kind: 'needs_binding'; reason: string }
    | { kind: 'invalid'; reason: string }
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

export type HbuJwTermScoreStatusKind = 'confirmed' | 'temporary' | 'pending' | 'unknown';

export interface HbuJwTermScoreRowView {
  courseNumber: string;
  sequenceNumber: string;
  courseName: string;
  creditText: string;
  propertyName: string;
  statusText: string;
  statusKind: HbuJwTermScoreStatusKind;
  scoreText: string;
  gradePointText: string;
  averageText: string;
  rankText: string;
}

export interface HbuJwTermScoresView {
  title: string;
  subtitle: string;
  totalCourseCount: number;
  totalCredits: number;
  confirmedCount: number;
  temporaryCount: number;
  pendingCount: number;
  unknownCount: number;
  rows: HbuJwTermScoreRowView[];
}

export class HbuJwTermScoresService {
  constructor(
    private readonly authService: HbuJwTermScoresAuthServiceLike,
    private readonly jwClient: Pick<HbuJwHttpClient, 'getThisTermScores'>,
    private readonly puppeteer: HbuJwTermScoresPuppeteerLike,
  ) {}

  async queryTermScores(identity: OwnerIdentity): Promise<Fragment> {
    const auth = await this.authService.ensureAuthenticated(identity);
    if (auth.kind !== 'authenticated') {
      throw new HbuJwUserError(auth.reason);
    }

    try {
      const scores = await this.jwClient.getThisTermScores(auth.cookieJar);
      const view = buildHbuJwTermScoresView(scores);
      return [h.at(identity.qqUserId), h.text('\n'), await renderHbuJwTermScoresImage(this.puppeteer, view)];
    } catch (error) {
      if (error instanceof HbuJwUserError) throw error;
      throw new HbuJwUserError('教务成绩查询失败，请稍后重试。');
    }
  }
}

export function buildHbuJwTermScoresView(rows: HbuJwThisTermScoreRow[]): HbuJwTermScoresView {
  const rowViews = rows.map(toRowView);
  const termLabel = formatTermLabel(rows);
  const totalCredits = rows.reduce((sum, row) => sum + parseCredit(row.credit), 0);
  const confirmedCount = rowViews.filter((row) => row.statusKind === 'confirmed').length;
  const temporaryCount = rowViews.filter((row) => row.statusKind === 'temporary').length;
  const pendingCount = rowViews.filter((row) => row.statusKind === 'pending').length;
  const unknownCount = rowViews.filter((row) => row.statusKind === 'unknown').length;

  return {
    title: '河北大学本学期成绩',
    subtitle: `${termLabel} · ${rows.length} 门课程 · ${formatNumber(totalCredits)} 学分`,
    totalCourseCount: rows.length,
    totalCredits,
    confirmedCount,
    temporaryCount,
    pendingCount,
    unknownCount,
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
    .course-col { width: 348px; }
    .credit-col { width: 84px; }
    .property-col { width: 112px; }
    .status-col { width: 120px; }
    .score-col { width: 100px; }
    .point-col { width: 96px; }
    .avg-col { width: 96px; }
    .rank-col { width: 120px; }
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
    .status-temporary { color: #8a5c08; background: #fff1cf; }
    .status-pending { color: #55708a; background: #e7f0f7; }
    .status-unknown { color: #66716c; background: #edf1ef; }
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
          <span>已确定<strong>${view.confirmedCount}</strong></span>
          <span>暂存<strong>${view.temporaryCount}</strong></span>
          <span>未录入<strong>${view.pendingCount}</strong></span>
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
              <th class="score-col">成绩</th>
              <th class="point-col">绩点</th>
              <th class="avg-col">均分</th>
              <th class="rank-col">名次</th>
            </tr>
          </thead>
          <tbody>
            ${view.rows.length === 0 ? '<tr><td class="empty" colspan="8">暂无本学期成绩</td></tr>' : view.rows.map(renderScoreRow).join('')}
          </tbody>
        </table>
      </section>
    </section>
  </main>
</body>
</html>`;
}

function toRowView(row: HbuJwThisTermScoreRow): HbuJwTermScoreRowView {
  const statusKind = classifyTermScoreStatus(row);
  return {
    courseNumber: readOptionalText(row.id?.courseNumber),
    sequenceNumber: normalizeSequenceNumber(row.coureSequenceNumber),
    courseName: readOptionalText(row.courseName) || '未知课程',
    creditText: formatNumber(parseCredit(row.credit)),
    propertyName: readOptionalText(row.coursePropertyName) || '未标注',
    statusText: formatStatusText(row, statusKind),
    statusKind,
    scoreText: formatScoreText(row, statusKind),
    gradePointText: formatConfirmedNumber(row.gradePoint, statusKind),
    averageText: formatConfirmedValue(row.avgcj, statusKind),
    rankText: formatConfirmedValue(row.rank, statusKind),
  };
}

export function classifyTermScoreStatus(row: HbuJwThisTermScoreRow): HbuJwTermScoreStatusKind {
  const code = readOptionalText(row.inputStatusCode);
  const text = readOptionalText(row.inputStatusExplain);
  if (code === CONFIRMED_STATUS_CODE || text === '确定') return 'confirmed';
  if (text.includes('暂存')) return 'temporary';
  if (text.includes('尚未录入') || text.includes('未录入')) return 'pending';
  return 'unknown';
}

function formatStatusText(row: HbuJwThisTermScoreRow, statusKind: HbuJwTermScoreStatusKind): string {
  const text = readOptionalText(row.inputStatusExplain);
  if (text) return text;
  if (statusKind === 'confirmed') return '确定';
  if (statusKind === 'temporary') return '暂存';
  if (statusKind === 'pending') return '尚未录入';
  return '未知';
}

function formatScoreText(row: HbuJwThisTermScoreRow, statusKind: HbuJwTermScoreStatusKind): string {
  if (statusKind !== 'confirmed') return '—';
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
  return `<tr>
    <td class="course-col">
      <div class="course-name">${escapeHtml(row.courseName)}</div>
      <div class="course-meta">${escapeHtml(courseMeta || '课程号未返回')}</div>
    </td>
    <td class="credit-col num">${escapeHtml(row.creditText)}</td>
    <td class="property-col">${escapeHtml(row.propertyName)}</td>
    <td class="status-col"><span class="status ${statusClass}">${escapeHtml(row.statusText)}</span></td>
    <td class="score-col ${row.scoreText === '—' ? 'muted' : 'score'}">${escapeHtml(row.scoreText)}</td>
    <td class="point-col ${row.gradePointText === '—' ? 'muted' : 'num'}">${escapeHtml(row.gradePointText)}</td>
    <td class="avg-col ${row.averageText === '—' ? 'muted' : 'num'}">${escapeHtml(row.averageText)}</td>
    <td class="rank-col ${row.rankText === '—' ? 'muted' : 'num'}">${escapeHtml(row.rankText)}</td>
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
