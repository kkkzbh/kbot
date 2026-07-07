import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { h, type Fragment } from 'koishi';
import type { HbuJwHttpClient } from './jw-client.js';
import {
  HbuJwUserError,
  type HbuJwScheduleCourse,
  type HbuJwThisSemesterSchedule,
  type OwnerIdentity,
  type SerializedCookieJar,
} from './types.js';

const DAY_MS = 86_400_000;
const WEEK_MS = DAY_MS * 7;
const SCHEDULE_WIDTH = 1536;
const PHASE_WIDTH = 54;
const TIME_WIDTH = 176;
const DAY_WIDTH = 184;
const ROW_HEIGHT = 68;
const HEADER_HEIGHT = 52;
const BODY_HEIGHT = ROW_HEIGHT * 11;
const TABLE_WIDTH = PHASE_WIDTH + TIME_WIDTH + DAY_WIDTH * 7;
const COURSE_GAP = 8;

const SECTION_TIMES = [
  ['08:20', '09:05'],
  ['09:15', '10:00'],
  ['10:20', '11:05'],
  ['11:15', '12:00'],
  ['14:30', '15:15'],
  ['15:25', '16:10'],
  ['16:20', '17:05'],
  ['17:15', '18:00'],
  ['19:00', '19:45'],
  ['19:55', '20:40'],
  ['20:50', '21:35'],
] as const;

const DAY_NAMES = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'] as const;

const COURSE_TONES = [
  ['#ed6b64', '#ef9188'],
  ['#168b8d', '#39b1a6'],
  ['#1285a9', '#35abd2'],
  ['#4f9d58', '#77bd77'],
  ['#d4a10b', '#e3bb39'],
  ['#0c5d59', '#177c78'],
  ['#f07a44', '#ff9b61'],
  ['#8d5d91', '#a77ca7'],
  ['#7b9f42', '#99bd5c'],
  ['#b98772', '#cda08d'],
] as const;

export type HbuJwScheduleMode = 'current-week' | 'full-semester';

export interface HbuJwAuthServiceLike {
  ensureAuthenticated(identity: OwnerIdentity): Promise<
    | { kind: 'authenticated'; cookieJar: SerializedCookieJar }
    | { kind: 'needs_binding'; reason: string }
    | { kind: 'invalid'; reason: string }
  >;
}

export interface HbuJwSchedulePuppeteerLike {
  page(): Promise<HbuJwSchedulePageLike>;
}

interface HbuJwSchedulePageLike {
  setViewport?(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<unknown>;
  goto(url: string, options?: unknown): Promise<unknown>;
  waitForSelector?(selector: string, options?: unknown): Promise<unknown>;
  $(selector: string): Promise<HbuJwScheduleElementLike | null>;
  screenshot(options?: unknown): Promise<Buffer | Uint8Array | string>;
  close(): Promise<unknown>;
}

interface HbuJwScheduleElementLike {
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
}

export interface HbuJwTermInfo {
  academicYearStart: number;
  academicYearEnd: number;
  termCode: 1 | 2;
  termName: '秋' | '春';
  termStartDay: number;
}

export type HbuJwScheduleCellKind = 'single' | 'split' | 'conflict';

export interface HbuJwScheduleEntryView {
  courseNumber: string;
  sequenceNumber: string;
  courseName: string;
  teacherName: string;
  classWeek: string;
  weekDescription: string;
  sectionText: string;
  placeText: string;
  classDay: number;
  startSection: number;
  continuingSession: number;
  colorStart: string;
  colorEnd: string;
}

export interface HbuJwScheduleCellView {
  classDay: number;
  startSection: number;
  continuingSession: number;
  sectionText: string;
  kind: HbuJwScheduleCellKind;
  entries: HbuJwScheduleEntryView[];
}

export interface HbuJwScheduleView {
  mode: HbuJwScheduleMode;
  title: string;
  subtitle: string;
  termLabel: string;
  currentWeek: number;
  weekRangeText: string;
  totalUnits: number;
  renderedCourseCount: number;
  unarrangedCourseCount: number;
  cells: HbuJwScheduleCellView[];
}

export class HbuJwScheduleService {
  constructor(
    private readonly authService: HbuJwAuthServiceLike,
    private readonly jwClient: Pick<HbuJwHttpClient, 'getThisSemesterSchedule'>,
    private readonly puppeteer: HbuJwSchedulePuppeteerLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async querySchedule(identity: OwnerIdentity, mode: HbuJwScheduleMode): Promise<Fragment> {
    const auth = await this.authService.ensureAuthenticated(identity);
    if (auth.kind !== 'authenticated') {
      throw new HbuJwUserError(auth.reason);
    }

    try {
      const schedule = await this.jwClient.getThisSemesterSchedule(auth.cookieJar);
      const view = buildHbuJwScheduleView(schedule, mode, this.now());
      return [h.at(identity.qqUserId), h.text('\n'), await renderHbuJwScheduleImage(this.puppeteer, view)];
    } catch (error) {
      if (error instanceof HbuJwUserError) throw error;
      throw new HbuJwUserError('教务课表查询失败，请稍后重试。');
    }
  }
}

export function buildHbuJwScheduleView(
  schedule: HbuJwThisSemesterSchedule,
  mode: HbuJwScheduleMode,
  nowMs: number,
): HbuJwScheduleView {
  const term = parseExecutiveEducationPlanNumber(schedule.executiveEducationPlanNumber);
  const currentWeek = calculateTeachingWeek(schedule.executiveEducationPlanNumber, nowMs);
  const entries: HbuJwScheduleEntryView[] = [];
  const renderedCourses = new Set<string>();
  let unarrangedCourseCount = 0;

  for (const course of schedule.courses) {
    if (course.timeAndPlaceList.length === 0) {
      unarrangedCourseCount += 1;
      continue;
    }
    for (const timeAndPlace of course.timeAndPlaceList) {
      if (mode === 'current-week' && !isClassWeekActive(timeAndPlace.classWeek, currentWeek)) {
        continue;
      }
      renderedCourses.add(scheduleCourseKey(course));
      const [colorStart, colorEnd] = colorForCourse(course);
      entries.push({
        courseNumber: course.courseNumber,
        sequenceNumber: course.sequenceNumber,
        courseName: `${course.courseName}_${course.sequenceNumber}`,
        teacherName: course.teacherName,
        classWeek: timeAndPlace.classWeek,
        weekDescription: timeAndPlace.weekDescription,
        sectionText: formatSectionText(timeAndPlace.classSessions, timeAndPlace.continuingSession),
        placeText: formatPlaceText(timeAndPlace.campusName, timeAndPlace.teachingBuildingName, timeAndPlace.classroomName),
        classDay: timeAndPlace.classDay,
        startSection: timeAndPlace.classSessions,
        continuingSession: timeAndPlace.continuingSession,
        colorStart,
        colorEnd,
      });
    }
  }

  const cells = createScheduleCells(entries);

  return {
    mode,
    title: mode === 'current-week' ? `河北大学课表 · 第 ${currentWeek} 周` : '河北大学完整课表',
    subtitle: mode === 'current-week'
      ? `${formatTermLabel(term)} · ${schedule.programPlanName}`
      : `${formatTermLabel(term)} · 全学期`,
    termLabel: formatTermLabel(term),
    currentWeek,
    weekRangeText: formatWeekRange(term.termStartDay, currentWeek),
    totalUnits: schedule.totalUnits,
    renderedCourseCount: renderedCourses.size,
    unarrangedCourseCount,
    cells,
  };
}

export function calculateTeachingWeek(executiveEducationPlanNumber: string, nowMs: number): number {
  const term = parseExecutiveEducationPlanNumber(executiveEducationPlanNumber);
  const shanghaiDay = toShanghaiUtcDay(nowMs);
  return Math.max(1, Math.floor((shanghaiDay - term.termStartDay) / WEEK_MS) + 1);
}

export function isClassWeekActive(classWeek: string, teachingWeek: number): boolean {
  return classWeek.charAt(teachingWeek - 1) === '1';
}

export async function renderHbuJwScheduleImage(
  puppeteer: HbuJwSchedulePuppeteerLike,
  view: HbuJwScheduleView,
): Promise<ReturnType<typeof h.image>> {
  const page = await puppeteer.page();
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'qqbot-hbu-jw-schedule-'));
    const htmlPath = join(tempDir, 'schedule.html');
    await writeFile(htmlPath, renderHbuJwScheduleHtml(view), 'utf8');
    await page.setViewport?.({ width: SCHEDULE_WIDTH, height: 1040, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
    await page.waitForSelector?.('#hbu-jw-schedule-card', { timeout: 5000 });
    const card = await page.$('#hbu-jw-schedule-card');
    if (!card) throw new Error('hbu jw schedule root not found');
    const box = await card.boundingBox();
    if (!box) throw new Error('hbu jw schedule root has no bounding box');
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

export function renderHbuJwScheduleHtml(view: HbuJwScheduleView): string {
  const emptyNote = view.mode === 'current-week' ? '本周无已安排课程' : '暂无已安排课程';
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
      color: #26343c;
      font-family: "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif;
    }
    #hbu-jw-schedule-card {
      width: ${SCHEDULE_WIDTH}px;
      margin: 0;
      padding: 10px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.95), rgba(251,252,249,0.98)),
        #f6f7f3;
    }
    .card-inner {
      overflow: hidden;
      border: 1px solid #cfd7d1;
      border-radius: 8px;
      background: rgba(255,255,255,0.96);
      box-shadow: 0 18px 40px rgba(40, 72, 56, 0.12);
    }
    .header {
      height: 92px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 28px 12px 24px;
      border-bottom: 1px solid #d7ded9;
      background: linear-gradient(90deg, #fdfefd, #f4f8f3);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 18px;
      min-width: 0;
    }
    .seal {
      width: 58px;
      height: 58px;
      border: 3px solid #2b8a5c;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #2b8a5c;
      font-weight: 800;
      font-size: 18px;
      letter-spacing: 0;
      background: #ffffff;
    }
    h1 {
      margin: 0;
      color: #1f7f52;
      font-size: 34px;
      line-height: 1.12;
      font-weight: 800;
      letter-spacing: 0;
    }
    .subtitle {
      margin-top: 4px;
      color: #7a858b;
      font-size: 20px;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 980px;
    }
    .tag {
      display: flex;
      align-items: center;
      gap: 9px;
      color: #1f7f52;
      font-size: 21px;
      font-weight: 700;
      white-space: nowrap;
    }
    .tag-icon {
      width: 24px;
      height: 24px;
      border: 2px solid #1f7f52;
      border-radius: 5px;
      position: relative;
    }
    .tag-icon::before,
    .tag-icon::after {
      content: "";
      position: absolute;
      top: -5px;
      width: 4px;
      height: 8px;
      border-radius: 4px;
      background: #1f7f52;
    }
    .tag-icon::before { left: 5px; }
    .tag-icon::after { right: 5px; }
    .table {
      position: relative;
      width: ${TABLE_WIDTH}px;
      margin: 0 auto;
    }
    .table-head {
      height: ${HEADER_HEIGHT}px;
      display: grid;
      grid-template-columns: ${PHASE_WIDTH + TIME_WIDTH}px repeat(7, ${DAY_WIDTH}px);
      border-bottom: 1px solid #d7ded9;
      background: #fbfcfb;
    }
    .head-cell {
      display: grid;
      place-items: center;
      border-right: 1px solid #d7ded9;
      font-size: 18px;
      font-weight: 700;
      color: #334047;
    }
    .head-cell:last-child { border-right: 0; }
    .body {
      position: relative;
      height: ${BODY_HEIGHT}px;
      background: #fff;
    }
    .phase {
      position: absolute;
      left: 0;
      width: ${PHASE_WIDTH}px;
      display: grid;
      place-items: center;
      border-right: 1px solid #d7ded9;
      border-bottom: 1px solid #d7ded9;
      font-size: 24px;
      font-weight: 800;
      color: #1f7f52;
      writing-mode: vertical-rl;
      letter-spacing: 0;
    }
    .phase.morning { top: 0; height: ${ROW_HEIGHT * 4}px; background: rgba(218, 250, 232, 0.62); }
    .phase.afternoon { top: ${ROW_HEIGHT * 4}px; height: ${ROW_HEIGHT * 4}px; background: rgba(250, 236, 218, 0.68); }
    .phase.evening { top: ${ROW_HEIGHT * 8}px; height: ${ROW_HEIGHT * 3}px; background: rgba(218, 234, 250, 0.75); color: #13709c; }
    .time-row {
      position: absolute;
      left: ${PHASE_WIDTH}px;
      width: ${TIME_WIDTH}px;
      height: ${ROW_HEIGHT}px;
      display: grid;
      place-items: center;
      border-right: 1px solid #d7ded9;
      border-bottom: 1px solid #d7ded9;
      font-size: 16px;
      line-height: 1.28;
      text-align: center;
      background: rgba(255,255,255,0.72);
      color: #2f3b43;
    }
    .grid-cell {
      position: absolute;
      width: ${DAY_WIDTH}px;
      height: ${ROW_HEIGHT}px;
      border-right: 1px solid #dfe5e1;
      border-bottom: 1px solid #dfe5e1;
      background: rgba(255,255,255,0.7);
    }
    .grid-cell.morning { background: rgba(229, 252, 239, 0.58); }
    .grid-cell.afternoon { background: rgba(252, 240, 225, 0.58); }
    .grid-cell.evening { background: rgba(225, 238, 252, 0.62); }
    .course {
      position: absolute;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      padding: 10px 10px 9px;
      border-radius: 6px;
      box-shadow: 0 10px 18px rgba(31, 54, 48, 0.18);
    }
    .course-single {
      justify-content: flex-start;
      gap: 4px;
      background: linear-gradient(145deg, var(--c1), var(--c2));
      color: #fff;
    }
    .course-name {
      font-size: 18px;
      line-height: 1.18;
      font-weight: 800;
      word-break: break-all;
    }
    .course-line {
      font-size: 16px;
      line-height: 1.22;
      font-weight: 650;
      word-break: break-all;
    }
    .place {
      display: flex;
      gap: 5px;
      align-items: flex-start;
    }
    .pin {
      flex: 0 0 auto;
      width: 12px;
      height: 12px;
      margin-top: 4px;
      border: 2px solid rgba(255,255,255,0.88);
      border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg);
    }
    .pin + span { flex: 1 1 auto; }
    .course-merged {
      padding: 6px;
      gap: 5px;
      border: 1px solid rgba(31, 127, 82, 0.34);
      background: rgba(253, 255, 254, 0.98);
      color: #26343c;
    }
    .course-merged.course-conflict {
      border-color: rgba(188, 92, 30, 0.56);
    }
    .merged-header {
      flex: 0 0 auto;
      min-height: 22px;
      display: flex;
      align-items: center;
      gap: 6px;
      overflow: hidden;
      white-space: nowrap;
      font-size: 13px;
      line-height: 1;
      font-weight: 800;
      color: #1f6d4a;
    }
    .merged-count {
      flex: 0 0 auto;
      padding: 4px 7px;
      border-radius: 999px;
      background: #1f7f52;
      color: #fff;
      font-size: 13px;
      line-height: 1;
    }
    .course-conflict .merged-count {
      background: #b75a21;
    }
    .merged-kind {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .merged-section {
      flex: 0 0 auto;
      color: #65737b;
      font-weight: 750;
    }
    .merged-list {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid #d8e5dd;
      border-radius: 4px;
      background: #ffffff;
    }
    .course-entry {
      position: relative;
      flex: 1 1 0;
      min-height: 0;
      display: grid;
      grid-template-columns: 21px minmax(0, 1fr);
      column-gap: 5px;
      padding: 4px 5px 4px 0;
      border-top: 1px solid #dce7e1;
      overflow: hidden;
    }
    .course-entry:first-child {
      border-top: 0;
    }
    .course-entry::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 4px;
      background: linear-gradient(180deg, var(--entry-c1), var(--entry-c2));
    }
    .course-entry-index {
      align-self: start;
      justify-self: end;
      width: 16px;
      height: 16px;
      margin-top: 1px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, var(--entry-c1), var(--entry-c2));
      color: #fff;
      font-size: 11px;
      line-height: 1;
      font-weight: 900;
    }
    .course-entry-main {
      min-width: 0;
      overflow: hidden;
    }
    .course-entry-name {
      font-size: 14px;
      line-height: 1.12;
      font-weight: 850;
      word-break: break-all;
      color: #26343c;
    }
    .course-entry-meta,
    .course-entry-place {
      margin-top: 2px;
      font-size: 12px;
      line-height: 1.12;
      font-weight: 700;
      word-break: break-all;
      color: #5f6f68;
    }
    .course-merged.course-many {
      padding: 5px;
    }
    .course-many .merged-header {
      min-height: 20px;
      font-size: 12px;
    }
    .course-many .merged-count {
      padding: 3px 6px;
      font-size: 12px;
    }
    .course-many .course-entry {
      grid-template-columns: 19px minmax(0, 1fr);
      padding-top: 3px;
      padding-bottom: 3px;
    }
    .course-many .course-entry-name {
      font-size: 12px;
      line-height: 1.1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .course-many .course-entry-meta {
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .course-many .course-entry-place {
      display: none;
    }
    .empty-note {
      position: absolute;
      left: ${PHASE_WIDTH + TIME_WIDTH}px;
      top: 0;
      width: ${DAY_WIDTH * 7}px;
      height: ${BODY_HEIGHT}px;
      display: grid;
      place-items: center;
      color: #7c8a83;
      font-size: 28px;
      font-weight: 700;
      pointer-events: none;
    }
    .footer {
      height: 62px;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      align-items: center;
      border-top: 1px solid #d7ded9;
      background: #fbfcfb;
    }
    .footer-item {
      min-width: 0;
      padding: 0 22px;
      border-right: 1px solid #d7ded9;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      color: #2f3b43;
      font-size: 17px;
      white-space: nowrap;
    }
    .footer-item:last-child { border-right: 0; }
    .footer-mark {
      width: 24px;
      height: 24px;
      border: 2px solid #238358;
      border-radius: 6px;
      color: #238358;
      display: grid;
      place-items: center;
      font-size: 14px;
      font-weight: 800;
    }
    .footer-value {
      font-size: 20px;
      font-weight: 800;
      color: #293740;
    }
  </style>
</head>
<body>
  <main id="hbu-jw-schedule-card">
    <section class="card-inner">
      <header class="header">
        <div class="brand">
          <div class="seal">HBU</div>
          <div>
            <h1>${escapeHtml(view.title)}</h1>
            <div class="subtitle">${escapeHtml(view.subtitle)}</div>
          </div>
        </div>
        <div class="tag"><span class="tag-icon"></span><span>课表</span></div>
      </header>
      <section class="table">
        <div class="table-head">
          <div class="head-cell">节次/时间</div>
          ${DAY_NAMES.map((day) => `<div class="head-cell">${day}</div>`).join('')}
        </div>
        <div class="body">
          <div class="phase morning">上午</div>
          <div class="phase afternoon">下午</div>
          <div class="phase evening">晚上</div>
          ${renderTimeRows()}
          ${renderGridCells()}
          ${view.cells.length === 0 ? `<div class="empty-note">${emptyNote}</div>` : ''}
          ${view.cells.map(renderCourseCell).join('')}
        </div>
      </section>
      <footer class="footer">
        <div class="footer-item"><span class="footer-mark">分</span><span>总学分</span><span class="footer-value">${formatNumber(view.totalUnits)}</span></div>
        <div class="footer-item"><span class="footer-mark">课</span><span>课程数量</span><span class="footer-value">${view.renderedCourseCount} 门</span></div>
        <div class="footer-item"><span class="footer-mark">周</span><span>当前周</span><span class="footer-value">第 ${view.currentWeek} 周（${escapeHtml(view.weekRangeText)}）</span></div>
        <div class="footer-item"><span class="footer-mark">未</span><span>未安排课程</span><span class="footer-value">${view.unarrangedCourseCount} 门</span></div>
      </footer>
    </section>
  </main>
</body>
</html>`;
}

function parseExecutiveEducationPlanNumber(value: string): HbuJwTermInfo {
  const matched = value.match(/^(\d{4})-(\d{4})-([12])-\d+$/);
  if (!matched) {
    throw new Error(`invalid executive education plan number: ${value}`);
  }
  const academicYearStart = Number(matched[1]);
  const academicYearEnd = Number(matched[2]);
  const termCode = Number(matched[3]) as 1 | 2;
  const termStartYear = termCode === 1 ? academicYearStart : academicYearEnd;
  const termStartMonth = termCode === 1 ? 9 : 3;
  return {
    academicYearStart,
    academicYearEnd,
    termCode,
    termName: termCode === 1 ? '秋' : '春',
    termStartDay: Date.UTC(termStartYear, termStartMonth - 1, 1),
  };
}

function toShanghaiUtcDay(nowMs: number): number {
  const shifted = new Date(nowMs + 8 * 60 * 60 * 1000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}

function formatTermLabel(term: HbuJwTermInfo): string {
  return `${term.academicYearStart}-${term.academicYearEnd} ${term.termName}`;
}

function formatWeekRange(termStartDay: number, currentWeek: number): string {
  const start = termStartDay + (currentWeek - 1) * WEEK_MS;
  const end = start + 6 * DAY_MS;
  return `${formatUtcDay(start)} ~ ${formatUtcDay(end)}`;
}

function formatUtcDay(ms: number): string {
  const date = new Date(ms);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function scheduleCourseKey(course: HbuJwScheduleCourse): string {
  return `${course.courseNumber}_${course.sequenceNumber}`;
}

function colorForCourse(course: HbuJwScheduleCourse): readonly [string, string] {
  const key = scheduleCourseKey(course);
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return COURSE_TONES[hash % COURSE_TONES.length]!;
}

function formatSectionText(start: number, continuing: number): string {
  const end = start + continuing - 1;
  return `${start}-${end}节`;
}

function formatPlaceText(campusName: string, teachingBuildingName: string, classroomName: string): string {
  return [campusName, teachingBuildingName, classroomName].filter(Boolean).join('');
}

function createScheduleCells(entries: HbuJwScheduleEntryView[]): HbuJwScheduleCellView[] {
  const byDay = new Map<number, HbuJwScheduleEntryView[]>();
  for (const entry of entries) {
    const dayEntries = byDay.get(entry.classDay) ?? [];
    dayEntries.push(entry);
    byDay.set(entry.classDay, dayEntries);
  }

  const cells: HbuJwScheduleCellView[] = [];
  for (const day of [...byDay.keys()].sort((left, right) => left - right)) {
    const sorted = byDay.get(day)!.sort(compareScheduleEntries);
    let group: HbuJwScheduleEntryView[] = [];
    let groupEndSection = 0;

    for (const entry of sorted) {
      const entryEnd = entryEndSection(entry);
      if (group.length === 0) {
        group = [entry];
        groupEndSection = entryEnd;
        continue;
      }
      if (entry.startSection <= groupEndSection) {
        group.push(entry);
        groupEndSection = Math.max(groupEndSection, entryEnd);
        continue;
      }
      cells.push(createScheduleCell(group));
      group = [entry];
      groupEndSection = entryEnd;
    }
    if (group.length > 0) {
      cells.push(createScheduleCell(group));
    }
  }

  return cells;
}

function createScheduleCell(entries: HbuJwScheduleEntryView[]): HbuJwScheduleCellView {
  const sorted = [...entries].sort(compareScheduleEntries);
  const startSection = Math.min(...sorted.map((entry) => entry.startSection));
  const endSection = Math.max(...sorted.map(entryEndSection));
  const continuingSession = endSection - startSection + 1;
  return {
    classDay: sorted[0]!.classDay,
    startSection,
    continuingSession,
    sectionText: formatSectionText(startSection, continuingSession),
    kind: inferScheduleCellKind(sorted),
    entries: sorted,
  };
}

function inferScheduleCellKind(entries: HbuJwScheduleEntryView[]): HbuJwScheduleCellKind {
  if (entries.length === 1) return 'single';
  return hasOverlappingClassWeeks(entries) ? 'conflict' : 'split';
}

function hasOverlappingClassWeeks(entries: HbuJwScheduleEntryView[]): boolean {
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      if (classWeeksOverlap(entries[leftIndex]!.classWeek, entries[rightIndex]!.classWeek)) {
        return true;
      }
    }
  }
  return false;
}

function classWeeksOverlap(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left.charAt(index) === '1' && right.charAt(index) === '1') {
      return true;
    }
  }
  return false;
}

function compareScheduleEntries(left: HbuJwScheduleEntryView, right: HbuJwScheduleEntryView): number {
  return left.startSection - right.startSection
    || entryEndSection(left) - entryEndSection(right)
    || scheduleEntryKey(left).localeCompare(scheduleEntryKey(right));
}

function entryEndSection(entry: Pick<HbuJwScheduleEntryView, 'startSection' | 'continuingSession'>): number {
  return entry.startSection + entry.continuingSession - 1;
}

function scheduleEntryKey(entry: HbuJwScheduleEntryView): string {
  return `${entry.courseNumber}_${entry.sequenceNumber}_${entry.weekDescription}_${entry.placeText}`;
}

function renderTimeRows(): string {
  return SECTION_TIMES.map(([start, end], index) => {
    const top = index * ROW_HEIGHT;
    return `<div class="time-row" style="top:${top}px;"><div>第${index + 1}节<br>${start}-${end}</div></div>`;
  }).join('');
}

function renderGridCells(): string {
  const cells: string[] = [];
  for (let section = 1; section <= 11; section += 1) {
    const phase = section <= 4 ? 'morning' : section <= 8 ? 'afternoon' : 'evening';
    for (let day = 1; day <= 7; day += 1) {
      const left = PHASE_WIDTH + TIME_WIDTH + (day - 1) * DAY_WIDTH;
      const top = (section - 1) * ROW_HEIGHT;
      cells.push(`<div class="grid-cell ${phase}" style="left:${left}px;top:${top}px;"></div>`);
    }
  }
  return cells.join('');
}

function renderCourseCell(cell: HbuJwScheduleCellView): string {
  const left = PHASE_WIDTH + TIME_WIDTH + (cell.classDay - 1) * DAY_WIDTH + COURSE_GAP / 2;
  const top = (cell.startSection - 1) * ROW_HEIGHT + COURSE_GAP / 2;
  const width = DAY_WIDTH - COURSE_GAP;
  const height = cell.continuingSession * ROW_HEIGHT - COURSE_GAP;
  const positionStyle = `left:${left}px;top:${top}px;width:${width}px;height:${height}px;`;
  if (cell.entries.length === 1) {
    return renderSingleCourseCell(cell.entries[0]!, positionStyle);
  }
  return renderMergedCourseCell(cell, positionStyle);
}

function renderSingleCourseCell(entry: HbuJwScheduleEntryView, positionStyle: string): string {
  return `<article class="course course-single" style="${positionStyle}--c1:${entry.colorStart};--c2:${entry.colorEnd};">
    <div class="course-name">${escapeHtml(entry.courseName)}</div>
    <div class="course-line">${escapeHtml(entry.teacherName)}</div>
    <div class="course-line">${escapeHtml(entry.weekDescription)} | ${escapeHtml(entry.sectionText)}</div>
    <div class="course-line place"><span class="pin"></span><span>${escapeHtml(entry.placeText)}</span></div>
  </article>`;
}

function renderMergedCourseCell(cell: HbuJwScheduleCellView, positionStyle: string): string {
  const densityClass = cell.entries.length > 2 ? 'course-many' : 'course-pair';
  const kindClass = cell.kind === 'conflict' ? 'course-conflict' : 'course-split';
  return `<article class="course course-merged ${densityClass} ${kindClass}" style="${positionStyle}">
    <div class="merged-header">
      <span class="merged-count">${cell.entries.length}门</span>
      <span class="merged-kind">${scheduleCellKindText(cell.kind)}</span>
      <span class="merged-section">${escapeHtml(cell.sectionText)}</span>
    </div>
    <div class="merged-list">
      ${cell.entries.map(renderMergedCourseEntry).join('')}
    </div>
  </article>`;
}

function renderMergedCourseEntry(entry: HbuJwScheduleEntryView, index: number): string {
  return `<section class="course-entry" style="--entry-c1:${entry.colorStart};--entry-c2:${entry.colorEnd};">
    <div class="course-entry-index">${index + 1}</div>
    <div class="course-entry-main">
      <div class="course-entry-name">${escapeHtml(entry.courseName)}</div>
      <div class="course-entry-meta">${escapeHtml(entry.teacherName)} · ${escapeHtml(entry.weekDescription)} · ${escapeHtml(entry.sectionText)}</div>
      <div class="course-entry-place">${escapeHtml(entry.placeText)}</div>
    </div>
  </section>`;
}

function scheduleCellKindText(kind: HbuJwScheduleCellKind): string {
  if (kind === 'split') return '分周安排';
  if (kind === 'conflict') return '同周重叠';
  return '单门课程';
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
