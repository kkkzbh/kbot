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
import {
  HbuJwUserError,
  type HbuJwExamPlanEvent,
  type OwnerIdentity,
  type SerializedCookieJar,
} from './types.js';

const EXAM_SCHEDULE_WIDTH = 1280;
const DAY_MS = 86_400_000;
const CHINA_OFFSET_MS = 28_800_000;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export interface HbuJwExamScheduleAuthServiceLike {
  ensureAuthenticated(identity: OwnerIdentity): Promise<
    | { kind: 'authenticated'; cookieJar: SerializedCookieJar; credentialVersion?: number }
    | { kind: 'needs_binding'; reason: string }
    | { kind: 'invalid'; reason: string }
    | { kind: 'unavailable'; reason: string }
  >;
}

export interface HbuJwExamSchedulePuppeteerLike {
  page(): Promise<HbuJwExamSchedulePageLike>;
}

interface HbuJwExamSchedulePageLike {
  setViewport?(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<unknown>;
  goto(url: string, options?: unknown): Promise<unknown>;
  waitForSelector?(selector: string, options?: unknown): Promise<unknown>;
  $(selector: string): Promise<HbuJwExamScheduleElementLike | null>;
  screenshot(options?: unknown): Promise<Buffer | Uint8Array | string>;
  close(): Promise<unknown>;
}

interface HbuJwExamScheduleElementLike {
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
}

export type HbuJwExamCountdownKind = 'upcoming' | 'today' | 'past' | 'unknown';

export interface HbuJwExamScheduleRowView {
  courseName: string;
  dateText: string;
  timeText: string;
  locationText: string;
  countdownText: string;
  countdownKind: HbuJwExamCountdownKind;
  sortKey: string;
}

export interface HbuJwExamScheduleView {
  title: string;
  subtitle: string;
  nearestExamDateText: string;
  totalCount: number;
  upcomingCount: number;
  rows: HbuJwExamScheduleRowView[];
}

export class HbuJwExamScheduleService {
  constructor(
    private readonly authService: HbuJwExamScheduleAuthServiceLike,
    private readonly jwClient: Pick<HbuJwHttpClient, 'getExamSchedule'>,
    private readonly puppeteer: HbuJwExamSchedulePuppeteerLike,
    private readonly now: () => Date = () => new Date(),
    private readonly academicCache?: Pick<HbuJwAcademicCache, 'getExamSchedule'>,
  ) {}

  async queryExamSchedule(identity: OwnerIdentity): Promise<Fragment> {
    const auth = await this.authService.ensureAuthenticated(identity);
    if (auth.kind !== 'authenticated') {
      throw new HbuJwUserError(auth.reason);
    }

    const query = this.academicCache
      ? await this.academicCache.getExamSchedule(identity, auth, hbuJwDatabaseFallbackPolicy())
      : { data: await this.jwClient.getExamSchedule(auth.cookieJar), source: 'remote' as const, fetchedAt: this.now().getTime() };
    const view = buildHbuJwExamScheduleView(query.data, this.now());
    const notice = formatAcademicFallbackNotice([query]);
    return [h.at(identity.qqUserId), h.text(notice ? `\n${notice}\n` : '\n'), await renderHbuJwExamScheduleImage(this.puppeteer, view)];
  }
}

export function buildHbuJwExamScheduleView(events: HbuJwExamPlanEvent[], now: Date = new Date()): HbuJwExamScheduleView {
  const rows = events
    .map((event) => toRowView(event, now))
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey));
  const upcomingRows = rows.filter((row) => row.countdownKind === 'upcoming' || row.countdownKind === 'today');
  const nearestExamDateText = upcomingRows[0]?.dateText.replace(/\s+周[日一二三四五六]$/, '') ?? rows[0]?.dateText.replace(/\s+周[日一二三四五六]$/, '') ?? '暂无';
  return {
    title: '河北大学考试安排',
    subtitle: `${inferTermLabel(rows)} · 共 ${rows.length} 场考试`,
    nearestExamDateText,
    totalCount: rows.length,
    upcomingCount: upcomingRows.length,
    rows,
  };
}

export async function renderHbuJwExamScheduleImage(
  puppeteer: HbuJwExamSchedulePuppeteerLike,
  view: HbuJwExamScheduleView,
): Promise<ReturnType<typeof h.image>> {
  const page = await puppeteer.page();
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'qqbot-hbu-jw-exams-'));
    const htmlPath = join(tempDir, 'exams.html');
    await writeFile(htmlPath, renderHbuJwExamScheduleHtml(view), 'utf8');
    await page.setViewport?.({ width: EXAM_SCHEDULE_WIDTH, height: 1000, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
    await page.waitForSelector?.('#hbu-jw-exam-schedule-card', { timeout: 5000 });
    const card = await page.$('#hbu-jw-exam-schedule-card');
    if (!card) throw new Error('hbu jw exam schedule root not found');
    const box = await card.boundingBox();
    if (!box) throw new Error('hbu jw exam schedule root has no bounding box');
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

export function renderHbuJwExamScheduleHtml(view: HbuJwExamScheduleView): string {
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
      background: #f3f6f2;
      color: #202a31;
      font-family: "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif;
    }
    #hbu-jw-exam-schedule-card {
      width: ${EXAM_SCHEDULE_WIDTH}px;
      margin: 0;
      padding: 12px;
      background: #f3f6f2;
    }
    .sheet {
      overflow: hidden;
      border: 1px solid #d3ddd7;
      border-radius: 8px;
      background: #fbfdfb;
      box-shadow: 0 16px 36px rgba(42, 72, 57, 0.10);
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      padding: 24px 30px 22px;
      background: linear-gradient(90deg, #ffffff, #f7faf7);
      border-bottom: 1px solid #dde5df;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 17px;
      min-width: 0;
    }
    .seal {
      width: 58px;
      height: 58px;
      border: 3px solid #187349;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #187349;
      background: #ffffff;
      font-size: 18px;
      font-weight: 900;
      flex: 0 0 auto;
    }
    h1 {
      margin: 0;
      color: #176b43;
      font-size: 34px;
      line-height: 1.1;
      font-weight: 900;
      letter-spacing: 0;
    }
    .subtitle {
      margin-top: 7px;
      color: #68756e;
      font-size: 18px;
      line-height: 1.25;
      white-space: nowrap;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(3, auto);
      align-items: center;
      gap: 0;
      border: 1px solid #dce5df;
      border-radius: 8px;
      background: #ffffff;
      color: #405047;
      white-space: nowrap;
    }
    .metric {
      min-width: 142px;
      padding: 14px 22px;
      border-right: 1px solid #dce5df;
    }
    .metric:last-child { border-right: 0; }
    .metric-label {
      color: #68756e;
      font-size: 14px;
      line-height: 1.2;
    }
    .metric-value {
      margin-top: 4px;
      color: #176b43;
      font-size: 24px;
      line-height: 1.1;
      font-weight: 900;
      font-variant-numeric: tabular-nums;
    }
    .table-wrap {
      padding: 0 22px 22px;
      background: #fbfdfb;
    }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      table-layout: fixed;
      border: 1px solid #dce5df;
      border-radius: 8px;
      overflow: hidden;
      background: #ffffff;
    }
    thead th {
      height: 58px;
      border-right: 1px solid #dce5df;
      border-bottom: 1px solid #dce5df;
      color: #176b43;
      background: #fbfdfb;
      font-size: 17px;
      line-height: 1.2;
      text-align: center;
      font-weight: 900;
    }
    thead th:last-child,
    tbody td:last-child { border-right: 0; }
    tbody td {
      height: 72px;
      border-right: 1px solid #e1e8e4;
      border-bottom: 1px solid #e1e8e4;
      color: #202a31;
      background: #ffffff;
      font-size: 17px;
      line-height: 1.25;
      vertical-align: middle;
      text-align: center;
    }
    tbody tr:nth-child(even) td { background: #f8fbf8; }
    tbody tr:last-child td { border-bottom: 0; }
    .date-col { width: 164px; }
    .time-col { width: 184px; }
    .course-col { width: 270px; }
    .location-col { width: 380px; }
    .countdown-col { width: 140px; }
    .course-name {
      padding: 0 18px;
      text-align: left;
      font-size: 20px;
      font-weight: 900;
      color: #14191d;
      overflow-wrap: anywhere;
    }
    .location {
      padding: 0 22px;
      text-align: left;
      color: #202a31;
      overflow-wrap: anywhere;
    }
    .num {
      font-variant-numeric: tabular-nums;
      font-weight: 760;
    }
    .countdown {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 82px;
      height: 32px;
      padding: 0 12px;
      border-radius: 8px;
      font-size: 17px;
      line-height: 1;
      font-weight: 900;
      font-variant-numeric: tabular-nums;
    }
    .countdown-upcoming { color: #176b43; background: #e1f4e8; }
    .countdown-today { color: #9a5d00; background: #fff0cc; }
    .countdown-past { color: #758179; background: #edf1ef; }
    .countdown-unknown { color: #6f7a74; background: #edf1ef; }
    .empty {
      height: 220px;
      text-align: center;
      color: #7b8780;
      font-size: 22px;
      font-weight: 850;
    }
  </style>
</head>
<body>
  <main id="hbu-jw-exam-schedule-card">
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
          <div class="metric">
            <div class="metric-label">最近考试</div>
            <div class="metric-value">${escapeHtml(view.nearestExamDateText)}</div>
          </div>
          <div class="metric">
            <div class="metric-label">共</div>
            <div class="metric-value">${view.totalCount} 场</div>
          </div>
          <div class="metric">
            <div class="metric-label">未开始</div>
            <div class="metric-value">${view.upcomingCount} 场</div>
          </div>
        </div>
      </header>
      <section class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="date-col">日期</th>
              <th class="time-col">时间</th>
              <th class="course-col">课程</th>
              <th class="location-col">校区/教室</th>
              <th class="countdown-col">倒计时</th>
            </tr>
          </thead>
          <tbody>
            ${view.rows.length === 0 ? '<tr><td class="empty" colspan="5">暂无考试安排</td></tr>' : view.rows.map(renderExamRow).join('')}
          </tbody>
        </table>
      </section>
    </section>
  </main>
</body>
</html>`;
}

function toRowView(event: HbuJwExamPlanEvent, now: Date): HbuJwExamScheduleRowView {
  const lines = readOptionalText(event.title).split('\n').map((line) => line.trim()).filter(Boolean);
  const dateParts = parseDateParts(readOptionalText(event.start));
  const dayDelta = dateParts ? dateParts.dayIndex - chinaDayIndex(now) : null;
  return {
    courseName: lines[0] || '未知课程',
    dateText: dateParts ? `${dateParts.month}-${dateParts.day} 周${WEEKDAYS[dateParts.weekday]}` : '日期未返回',
    timeText: lines[1] || '时间未返回',
    locationText: formatLocation(lines),
    countdownText: formatCountdownText(dayDelta),
    countdownKind: classifyCountdown(dayDelta),
    sortKey: `${readOptionalText(event.start) || '9999-99-99'} ${lines[1] || ''} ${lines[0] || ''}`,
  };
}

function formatLocation(lines: string[]): string {
  const campus = lines[2] || '';
  const building = stripPrefix(lines[3] || '', campus);
  const room = lines[4] || '';
  const extra = lines.slice(5).join(' ');
  return [campus, building, room, extra].filter(Boolean).join(' ') || '地点未返回';
}

function stripPrefix(value: string, prefix: string): string {
  return prefix && value.startsWith(prefix) ? value.slice(prefix.length).trim() : value;
}

function parseDateParts(value: string): { month: string; day: string; weekday: number; dayIndex: number } | null {
  const matched = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const utcMs = Date.UTC(year, month - 1, day);
  const normalized = new Date(utcMs);
  if (normalized.getUTCFullYear() !== year || normalized.getUTCMonth() !== month - 1 || normalized.getUTCDate() !== day) {
    return null;
  }
  return {
    month: matched[2]!,
    day: matched[3]!,
    weekday: normalized.getUTCDay(),
    dayIndex: Math.floor(utcMs / DAY_MS),
  };
}

function chinaDayIndex(date: Date): number {
  return Math.floor((date.getTime() + CHINA_OFFSET_MS) / DAY_MS);
}

function formatCountdownText(dayDelta: number | null): string {
  if (dayDelta == null) return '未知';
  if (dayDelta < 0) return '已结束';
  if (dayDelta === 0) return '今天';
  if (dayDelta === 1) return '明天';
  return `${dayDelta} 天`;
}

function classifyCountdown(dayDelta: number | null): HbuJwExamCountdownKind {
  if (dayDelta == null) return 'unknown';
  if (dayDelta < 0) return 'past';
  if (dayDelta === 0) return 'today';
  return 'upcoming';
}

function inferTermLabel(rows: HbuJwExamScheduleRowView[]): string {
  const firstDate = rows.map((row) => row.sortKey.slice(0, 10)).find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
  if (!firstDate) return '本学期';
  const year = Number(firstDate.slice(0, 4));
  const month = Number(firstDate.slice(5, 7));
  if (month >= 9) return `${year}-${year + 1} 秋`;
  return `${year - 1}-${year} 春`;
}

function renderExamRow(row: HbuJwExamScheduleRowView): string {
  return `<tr>
    <td class="date-col num">${escapeHtml(row.dateText)}</td>
    <td class="time-col num">${escapeHtml(row.timeText)}</td>
    <td class="course-col"><div class="course-name">${escapeHtml(row.courseName)}</div></td>
    <td class="location-col"><div class="location">${escapeHtml(row.locationText)}</div></td>
    <td class="countdown-col"><span class="countdown countdown-${row.countdownKind}">${escapeHtml(row.countdownText)}</span></td>
  </tr>`;
}

function readOptionalText(value: unknown): string {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
