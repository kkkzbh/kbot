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
  type HbuJwCourseSelectionCourse,
  type HbuJwCourseSelectionResult,
  type OwnerIdentity,
  type SerializedCookieJar,
} from './types.js';

const SELECTION_RESULT_WIDTH = 1280;
const WEEKDAY_NAMES = ['', '一', '二', '三', '四', '五', '六', '日'];

export interface HbuJwSelectionResultAuthServiceLike {
  ensureAuthenticated(identity: OwnerIdentity): Promise<
    | { kind: 'authenticated'; cookieJar: SerializedCookieJar; credentialVersion?: number }
    | { kind: 'needs_binding'; reason: string }
    | { kind: 'invalid'; reason: string }
  >;
}

export interface HbuJwSelectionResultPuppeteerLike {
  page(): Promise<HbuJwSelectionResultPageLike>;
}

interface HbuJwSelectionResultPageLike {
  setViewport?(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<unknown>;
  goto(url: string, options?: unknown): Promise<unknown>;
  waitForSelector?(selector: string, options?: unknown): Promise<unknown>;
  $(selector: string): Promise<HbuJwSelectionResultElementLike | null>;
  screenshot(options?: unknown): Promise<Buffer | Uint8Array | string>;
  close(): Promise<unknown>;
}

interface HbuJwSelectionResultElementLike {
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
}

export interface HbuJwSelectionResultView {
  title: string;
  subtitle: string;
  totalUnitsText: string;
  courseCount: number;
  statusSummary: string;
  groups: HbuJwSelectionResultGroupView[];
}

export interface HbuJwSelectionResultGroupView {
  name: string;
  unitsText: string;
  rows: HbuJwSelectionResultRowView[];
}

export interface HbuJwSelectionResultRowView {
  courseName: string;
  courseIdentity: string;
  unitText: string;
  teacherName: string;
  tags: string[];
  statusText: string;
  statusKind: 'success' | 'neutral';
  scheduleLines: string[];
  restrictionText: string;
  selectionTimeText: string;
}

export class HbuJwSelectionResultService {
  constructor(
    private readonly authService: HbuJwSelectionResultAuthServiceLike,
    private readonly jwClient: Pick<HbuJwHttpClient, 'getCourseSelectionResult'>,
    private readonly puppeteer: HbuJwSelectionResultPuppeteerLike,
    private readonly academicCache?: Pick<HbuJwAcademicCache, 'getCourseSelectionResult'>,
  ) {}

  async querySelectionResult(identity: OwnerIdentity): Promise<Fragment> {
    const auth = await this.authService.ensureAuthenticated(identity);
    if (auth.kind !== 'authenticated') throw new HbuJwUserError(auth.reason);

    try {
      const query = this.academicCache
        ? await this.academicCache.getCourseSelectionResult(identity, auth, hbuJwDatabaseFallbackPolicy())
        : { data: await this.jwClient.getCourseSelectionResult(auth.cookieJar), source: 'remote' as const, fetchedAt: Date.now() };
      const notice = formatAcademicFallbackNotice([query]);
      return [
        h.at(identity.qqUserId),
        h.text(notice ? `\n${notice}\n` : '\n'),
        await renderHbuJwSelectionResultImage(this.puppeteer, buildHbuJwSelectionResultView(query.data)),
      ];
    } catch (error) {
      if (error instanceof HbuJwUserError) throw error;
      throw new HbuJwUserError('教务选课结果查询失败，请稍后重试。');
    }
  }
}

export function buildHbuJwSelectionResultView(result: HbuJwCourseSelectionResult): HbuJwSelectionResultView {
  const courses = result.groups.flatMap((group) => group.courses);
  return {
    title: '河北大学选课结果',
    subtitle: inferSelectionTerm(courses),
    totalUnitsText: formatNumber(result.totalUnits),
    courseCount: courses.length,
    statusSummary: summarizeStatuses(courses),
    groups: result.groups.map((group) => ({
      name: group.programPlanName,
      unitsText: formatNumber(group.totalUnits),
      rows: group.courses.map(toRowView),
    })),
  };
}

export async function renderHbuJwSelectionResultImage(
  puppeteer: HbuJwSelectionResultPuppeteerLike,
  view: HbuJwSelectionResultView,
): Promise<ReturnType<typeof h.image>> {
  const page = await puppeteer.page();
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'qqbot-hbu-jw-selection-result-'));
    const htmlPath = join(tempDir, 'selection-result.html');
    await writeFile(htmlPath, renderHbuJwSelectionResultHtml(view), 'utf8');
    await page.setViewport?.({ width: SELECTION_RESULT_WIDTH, height: 1600, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
    await page.waitForSelector?.('#hbu-jw-selection-result-card', { timeout: 5000 });
    const card = await page.$('#hbu-jw-selection-result-card');
    if (!card) throw new Error('hbu jw selection result root not found');
    const box = await card.boundingBox();
    if (!box) throw new Error('hbu jw selection result root has no bounding box');
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
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

export function renderHbuJwSelectionResultHtml(view: HbuJwSelectionResultView): string {
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
      color: #203029;
      background: #eef5f0;
      font-family: "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif;
    }
    #hbu-jw-selection-result-card {
      width: ${SELECTION_RESULT_WIDTH}px;
      padding: 14px;
      background:
        radial-gradient(circle at 8% 3%, rgba(25, 115, 72, 0.10), transparent 28%),
        linear-gradient(180deg, #f7faf7, #edf4ef);
    }
    .sheet {
      overflow: hidden;
      border: 1px solid #cbdcd1;
      border-radius: 18px;
      background: #ffffff;
      box-shadow: 0 18px 44px rgba(31, 87, 57, 0.12);
    }
    .hero {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 30px;
      padding: 30px 36px;
      color: #ffffff;
      background: linear-gradient(125deg, #08683f, #168456);
    }
    .brand { display: flex; align-items: center; gap: 20px; min-width: 0; }
    .seal {
      width: 70px;
      height: 70px;
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      border: 3px solid rgba(255,255,255,0.86);
      border-radius: 50%;
      font-size: 22px;
      font-weight: 900;
    }
    h1 { margin: 0; font-size: 39px; line-height: 1.15; font-weight: 900; }
    .subtitle { margin: 8px 0 0; color: rgba(255,255,255,0.82); font-size: 18px; }
    .summary { display: grid; grid-template-columns: repeat(3, auto); overflow: hidden; border: 1px solid rgba(255,255,255,0.30); border-radius: 12px; }
    .metric { min-width: 132px; padding: 12px 18px; border-right: 1px solid rgba(255,255,255,0.22); }
    .metric:last-child { border-right: 0; }
    .metric-label { color: rgba(255,255,255,0.72); font-size: 13px; }
    .metric-value { margin-top: 4px; font-size: 23px; line-height: 1.2; font-weight: 900; }
    .content { padding: 26px 28px 30px; }
    .group + .group { margin-top: 25px; }
    .group-head { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; margin: 0 4px 12px; }
    .group-head h2 { margin: 0; color: #175f40; font-size: 22px; line-height: 1.3; font-weight: 900; }
    .group-units { color: #61736a; font-size: 15px; white-space: nowrap; }
    .courses { display: grid; gap: 10px; }
    .course {
      display: grid;
      grid-template-columns: 280px 270px minmax(0, 1fr);
      gap: 20px;
      padding: 18px 20px;
      border: 1px solid #d9e5dd;
      border-radius: 12px;
      background: linear-gradient(90deg, #fbfdfb, #ffffff);
    }
    .course-name { color: #162d22; font-size: 21px; line-height: 1.3; font-weight: 900; }
    .identity { margin-top: 8px; color: #6b7b73; font-size: 14px; font-variant-numeric: tabular-nums; }
    .unit { margin-left: 8px; color: #18724a; font-weight: 900; }
    .teacher { margin-top: 10px; color: #43574d; font-size: 15px; line-height: 1.4; }
    .tags { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 7px; }
    .tag { padding: 5px 9px; border: 1px solid #dbe6df; border-radius: 999px; color: #53655c; background: #f7faf8; font-size: 13px; line-height: 1.15; }
    .status { padding: 5px 10px; border-radius: 999px; font-size: 13px; line-height: 1.15; font-weight: 900; }
    .status.success { color: #087044; background: #e7f6ed; border: 1px solid #bde3cb; }
    .status.neutral { color: #6d5b25; background: #fff8e6; border: 1px solid #ead9a8; }
    .selection-time { margin-top: 13px; color: #73827b; font-size: 13px; line-height: 1.35; }
    .schedule { min-width: 0; }
    .slot { color: #32483e; font-size: 14px; line-height: 1.45; }
    .slot + .slot { margin-top: 4px; }
    .restriction { margin-top: 9px; padding-top: 8px; border-top: 1px dashed #d9e2dc; color: #7a6040; font-size: 13px; line-height: 1.4; }
    .empty { padding: 44px 24px; border: 1px dashed #cbdcd1; border-radius: 12px; color: #718078; text-align: center; font-size: 18px; }
    footer { padding: 16px 28px 19px; border-top: 1px solid #e1e9e4; color: #78847e; background: #f9fbfa; font-size: 13px; text-align: right; }
  </style>
</head>
<body>
  <main id="hbu-jw-selection-result-card">
    <section class="sheet">
      <header class="hero">
        <div class="brand"><div class="seal">HBU</div><div><h1>${escapeHtml(view.title)}</h1><p class="subtitle">${escapeHtml(view.subtitle)}</p></div></div>
        <div class="summary">
          <div class="metric"><div class="metric-label">课程</div><div class="metric-value">${view.courseCount} 门</div></div>
          <div class="metric"><div class="metric-label">总学分</div><div class="metric-value">${escapeHtml(view.totalUnitsText)}</div></div>
          <div class="metric"><div class="metric-label">选课状态</div><div class="metric-value">${escapeHtml(view.statusSummary)}</div></div>
        </div>
      </header>
      <section class="content">
        ${view.groups.length === 0 ? '<div class="empty">教务系统当前没有选课结果。</div>' : view.groups.map(renderGroup).join('')}
      </section>
      <footer>数据来源：河北大学综合教务系统 · 选课结果</footer>
    </section>
  </main>
</body>
</html>`;
}

function toRowView(course: HbuJwCourseSelectionCourse): HbuJwSelectionResultRowView {
  const statusText = course.selectCourseStatusName || '未标注';
  return {
    courseName: course.courseName,
    courseIdentity: `${course.courseNumber} · 课序 ${course.sequenceNumber}`,
    unitText: formatNumber(course.unit),
    teacherName: course.teacherName || '教师待定',
    tags: [course.coursePropertiesName, course.courseCategoryName, course.examTypeName, course.studyModeName].filter(Boolean),
    statusText,
    statusKind: /选中|置入|抽中|确认|成功/.test(statusText) ? 'success' : 'neutral',
    scheduleLines: course.timeAndPlaceList.length > 0
      ? course.timeAndPlaceList.map((slot) => {
        const end = slot.classSessions + slot.continuingSession - 1;
        const place = [slot.campusName, slot.teachingBuildingName, slot.classroomName].filter(Boolean).join(' ');
        return `周${WEEKDAY_NAMES[slot.classDay]} 第${slot.classSessions}-${end}节 · ${slot.weekDescription}${place ? ` · ${place}` : ''}`;
      })
      : ['时间地点待定'],
    restrictionText: normalizeRestriction(course.restrictedCondition),
    selectionTimeText: course.courseSelectionTime,
  };
}

function renderGroup(group: HbuJwSelectionResultGroupView): string {
  return `<section class="group">
    <div class="group-head"><h2>${escapeHtml(group.name)}</h2><div class="group-units">${group.rows.length} 门 · ${escapeHtml(group.unitsText)} 学分</div></div>
    <div class="courses">${group.rows.length === 0 ? '<div class="empty">该培养方案下没有课程。</div>' : group.rows.map(renderCourse).join('')}</div>
  </section>`;
}

function renderCourse(row: HbuJwSelectionResultRowView): string {
  return `<article class="course">
    <div>
      <div class="course-name">${escapeHtml(row.courseName)}</div>
      <div class="identity">${escapeHtml(row.courseIdentity)}<span class="unit">${escapeHtml(row.unitText)} 学分</span></div>
      <div class="teacher">教师：${escapeHtml(row.teacherName)}</div>
    </div>
    <div>
      <div class="tags"><span class="status ${row.statusKind}">${escapeHtml(row.statusText)}</span>${row.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
      ${row.selectionTimeText ? `<div class="selection-time">选课时间：${escapeHtml(row.selectionTimeText)}</div>` : ''}
    </div>
    <div class="schedule">
      ${row.scheduleLines.map((line) => `<div class="slot">${escapeHtml(line)}</div>`).join('')}
      ${row.restrictionText ? `<div class="restriction">限制说明：${escapeHtml(row.restrictionText)}</div>` : ''}
    </div>
  </article>`;
}

function summarizeStatuses(courses: HbuJwCourseSelectionCourse[]): string {
  if (courses.length === 0) return '暂无';
  const counts = new Map<string, number>();
  for (const course of courses) {
    const status = course.selectCourseStatusName || '未标注';
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => `${status} ${count}`).join(' · ');
}

function inferSelectionTerm(courses: HbuJwCourseSelectionCourse[]): string {
  const code = courses[0]?.executiveEducationPlanNumber ?? '';
  const match = code.match(/^(\d{4}-\d{4})-([123])-\d+$/);
  if (!match) return code || '当前学期';
  return `${match[1]} 学年 · 第 ${match[2]} 学期`;
}

function normalizeRestriction(value: string): string {
  const text = value.replace(/^[;；\s]+|[;；\s]+$/g, '').trim();
  return text;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
