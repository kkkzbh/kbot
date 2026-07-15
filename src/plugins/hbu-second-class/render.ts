import { h } from 'koishi';

export interface SecondClassPuppeteerLike {
  page(): Promise<{
    setViewport(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<unknown>;
    setContent(html: string, options?: unknown): Promise<unknown>;
    $(selector: string): Promise<{ boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> } | null>;
    screenshot(options?: unknown): Promise<Buffer | Uint8Array | string>;
    close(): Promise<unknown>;
  }>;
}

interface TranscriptRow {
  name: string;
  semester: string;
  category: string;
  credit: string;
  score: string;
}

interface RadarPoint {
  name: string;
  value: number;
}

export interface SecondClassCreditCategoryView {
  name: string;
  evaluationRule: 0 | 1;
  qualified: boolean | null;
  earnedPoints: number;
  requiredPoints: number;
  earnedCredits: number;
  requiredCredits: number;
  invalidPoints: number;
  children: SecondClassCreditCategoryView[];
}

export interface SecondClassCreditsView {
  earnedPoints: number;
  earnedCredits: number;
  invalidPoints: number;
  categories: SecondClassCreditCategoryView[];
}

export async function renderSecondClassCredits(puppeteer: SecondClassPuppeteerLike, data: unknown): Promise<ReturnType<typeof h.image>> {
  return renderCard(puppeteer, renderSecondClassCreditsHtml(buildSecondClassCreditsView(data)));
}

export function buildSecondClassCreditsView(data: unknown): SecondClassCreditsView {
  const record = requireRecord(data, '二课学分响应缺少数据。');
  const rawCategories = record.creditCategoryDetailsList;
  if (!Array.isArray(rawCategories)) throw new Error('二课学分响应缺少分类明细。');
  return {
    earnedPoints: requireNonNegativeNumber(record.oneScore, '累计积分'),
    earnedCredits: requireNonNegativeNumber(record.twoScore, '认定学分'),
    invalidPoints: requireNonNegativeNumber(record.invalidScore, '无效积分'),
    categories: rawCategories.map((item) => normalizeCreditCategory(item)),
  };
}

export function renderSecondClassCreditsHtml(view: SecondClassCreditsView): string {
  const requiredGroups = view.categories.filter((category) => category.requiredCredits > 0);
  const completedGroups = requiredGroups.filter(isCreditCategoryCompleted).length;
  const groups = view.categories.length
    ? view.categories.map((category, index) => renderCreditGroup(category, index)).join('')
    : '<div class="credit-empty">暂无分类学分数据</div>';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>二课学分明细</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#edf3f1;color:#1f2d32;font-family:"Noto Sans CJK SC","Microsoft YaHei",Arial,sans-serif}#second-class-card{width:1180px;padding:20px;background:#edf3f1}.credit-sheet{overflow:hidden;padding:48px 52px 44px;border:1px solid #d4dfdb;border-radius:30px;background:#fbfcfb;box-shadow:0 22px 54px rgba(31,62,51,.13)}.credit-eyebrow{color:#18805b;font-size:18px;font-weight:800;letter-spacing:.16em}.credit-title{margin:10px 0 0;font-size:48px;line-height:1.08;font-weight:900;letter-spacing:-.04em}.credit-hero{display:grid;grid-template-columns:1.4fr 1fr;align-items:end;gap:40px;padding:38px 0 34px}.credit-hero-label{color:#718079;font-size:20px}.credit-hero-value{margin-top:9px;font-size:88px;line-height:.9;font-weight:900;font-variant-numeric:tabular-nums;letter-spacing:-.065em}.credit-hero-unit{margin-left:12px;color:#718079;font-size:27px;font-weight:800;letter-spacing:0}.credit-hero-note{display:grid;gap:12px;padding:24px 26px;border-radius:18px;background:#edf6f2;color:#5f7169;font-size:18px;line-height:1.4}.credit-hero-note strong{color:#1f2d32;font-size:27px;font-variant-numeric:tabular-nums}.credit-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid #dce5e1;border-bottom:1px solid #dce5e1}.credit-stat{padding:25px 24px 24px 0}.credit-stat+.credit-stat{padding-left:24px;border-left:1px solid #dce5e1}.credit-stat-label{color:#718079;font-size:18px}.credit-stat-value{margin-top:10px;font-size:36px;line-height:1;font-weight:900;font-variant-numeric:tabular-nums}.credit-stat-unit{margin-left:6px;color:#718079;font-size:19px;font-weight:700}.credit-section-head{display:flex;align-items:end;justify-content:space-between;gap:24px;padding:38px 0 20px}.credit-section-head h2{margin:0;font-size:27px}.credit-section-head p{margin:0;color:#718079;font-size:17px}.credit-groups{display:grid;gap:20px}.credit-group{--accent:#18805b;overflow:hidden;border:1px solid #dce5e1;border-radius:22px;background:#fff}.credit-group:nth-child(3n+2){--accent:#486aa7}.credit-group:nth-child(3n+3){--accent:#a46c28}.credit-group-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:26px;padding:26px 28px 22px}.credit-group-kicker{color:var(--accent);font-size:15px;font-weight:900;letter-spacing:.12em}.credit-group-name{margin:5px 0 0;font-size:29px;line-height:1.15}.credit-group-score{text-align:right}.credit-group-score strong{font-size:35px;line-height:1;font-weight:900;font-variant-numeric:tabular-nums}.credit-group-score span{margin-left:6px;color:#718079;font-size:19px;font-weight:700}.credit-group-meta{display:flex;flex-wrap:wrap;gap:10px 18px;margin-top:14px;color:#718079;font-size:17px}.credit-status{color:var(--accent);font-weight:900}.credit-invalid{color:#b24b40}.credit-progress{height:8px;margin:0 28px 25px;overflow:hidden;border-radius:999px;background:#e5ece9}.credit-progress span{display:block;height:100%;border-radius:inherit;background:var(--accent)}.credit-details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:20px 28px 28px;border-top:1px solid #e5ebe8;background:#f7f9f8}.credit-detail{min-width:0;padding:18px 19px 17px;border:1px solid #e0e7e4;border-radius:16px;background:#fff}.credit-detail-name{overflow:hidden;color:#2d3a3f;font-size:20px;font-weight:900;text-overflow:ellipsis;white-space:nowrap}.credit-detail-path{margin-top:4px;overflow:hidden;color:#89958f;font-size:13px;text-overflow:ellipsis;white-space:nowrap}.credit-detail-score{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-top:14px}.credit-detail-score strong{font-size:25px;font-variant-numeric:tabular-nums}.credit-detail-score span{color:#718079;font-size:15px;text-align:right}.credit-detail-points{margin-top:8px;color:#718079;font-size:15px;font-variant-numeric:tabular-nums}.credit-detail-progress{height:5px;margin-top:13px;overflow:hidden;border-radius:999px;background:#e8eeeb}.credit-detail-progress span{display:block;height:100%;border-radius:inherit;background:var(--accent)}.credit-empty{padding:70px 20px;text-align:center;color:#718079;font-size:24px}.credit-footer{padding-top:28px;color:#8a9690;font-size:14px;text-align:right}
  </style>
</head>
<body>
  <main id="second-class-card">
    <section class="credit-sheet">
      <div class="credit-eyebrow">HEBEI UNIVERSITY · SECOND CLASS</div>
      <h1 class="credit-title">二课学分明细</h1>
      <section class="credit-hero">
        <div>
          <div class="credit-hero-label">当前累计认定学分</div>
          <div class="credit-hero-value">${formatCreditNumber(view.earnedCredits)}<span class="credit-hero-unit">学分</span></div>
        </div>
        <div class="credit-hero-note">
          <span>由累计积分折算</span>
          <strong>${formatCreditNumber(view.earnedPoints)} 积分</strong>
        </div>
      </section>
      <section class="credit-stats">
        <div class="credit-stat"><div class="credit-stat-label">累计积分</div><div class="credit-stat-value">${formatCreditNumber(view.earnedPoints)}<span class="credit-stat-unit">积分</span></div></div>
        <div class="credit-stat"><div class="credit-stat-label">认定学分</div><div class="credit-stat-value">${formatCreditNumber(view.earnedCredits)}<span class="credit-stat-unit">学分</span></div></div>
        <div class="credit-stat"><div class="credit-stat-label">无效积分</div><div class="credit-stat-value">${formatCreditNumber(view.invalidPoints)}<span class="credit-stat-unit">积分</span></div></div>
      </section>
      <div class="credit-section-head"><h2>分类完成情况</h2><p>${completedGroups} / ${requiredGroups.length} 个要求组已达标 · 共 ${countCreditDetails(view.categories)} 个细分项</p></div>
      <section class="credit-groups">${groups}</section>
      <footer class="credit-footer">QQBot · 河北大学第二课堂</footer>
    </section>
  </main>
</body>
</html>`;
}

export async function renderSecondClassTranscript(puppeteer: SecondClassPuppeteerLike, data: unknown, semester?: string): Promise<ReturnType<typeof h.image>> {
  const rows = collectTranscriptRows(data);
  const title = semester ? `二课成绩单 · ${semester}` : '二课成绩单';
  const body = rows.length
    ? `<table><thead><tr><th>项目</th><th>学期</th><th>类别</th><th>学分</th><th>成绩</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.semester)}</td><td>${escapeHtml(row.category)}</td><td>${escapeHtml(row.credit)}</td><td>${escapeHtml(row.score)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">暂无成绩单记录</div>';
  return renderCard(puppeteer, cardHtml(title, `${rows.length} 条记录`, body));
}

export async function renderSecondClassRadar(puppeteer: SecondClassPuppeteerLike, data: unknown): Promise<ReturnType<typeof h.image>> {
  const points = collectRadarPoints(data).slice(0, 12);
  const body = points.length >= 3
    ? `<div class="radar-wrap">${radarSvg(points)}<div class="radar-list">${points.map((point) => `<div><span>${escapeHtml(point.name)}</span><strong>${formatNumber(point.value)}</strong></div>`).join('')}</div></div>`
    : '<div class="empty">暂无雷达图数据</div>';
  return renderCard(puppeteer, cardHtml('二课学分雷达', `${points.length} 个维度`, body));
}

export function collectTranscriptRows(data: unknown): TranscriptRow[] {
  return collectRecords(data).map((row) => {
    const name = firstText(row, ['courseName', 'activityName', 'projectName', 'proName', 'name', 'title']);
    if (!name) return null;
    return {
      name,
      semester: firstText(row, ['semesterName', 'semester', 'yearSemester', 'schoolYearName']),
      category: firstText(row, ['categoryName', 'creditTypeName', 'typeName', 'labelName']),
      credit: firstText(row, ['credit', 'creditScore', 'actualCreditScore', 'scoreValue']),
      score: firstText(row, ['grade', 'result', 'score', 'statusName']),
    };
  }).filter((row): row is TranscriptRow => row !== null);
}

export function collectRadarPoints(data: unknown): RadarPoint[] {
  const deduplicated = new Map<string, number>();
  for (const row of collectRecords(data)) {
    const name = firstText(row, ['categoryName', 'typeName', 'name', 'label']);
    const value = firstNumber(row, ['actualCreditScore', 'creditScore', 'score', 'value']);
    if (name && value != null) deduplicated.set(name, value);
  }
  return [...deduplicated].map(([name, value]) => ({ name, value }));
}

function normalizeCreditCategory(value: unknown): SecondClassCreditCategoryView {
  const record = requireRecord(value, '二课学分分类结构无效。');
  const name = firstText(record, ['categoryName']);
  if (!name) throw new Error('二课学分分类缺少名称。');
  const rawChildren = record.childList;
  let children: unknown[];
  if (rawChildren === null) {
    children = [];
  } else if (Array.isArray(rawChildren)) {
    children = rawChildren;
  } else {
    throw new Error(`二课学分分类“${name}”的子分类结构无效。`);
  }
  return {
    name,
    evaluationRule: requireEvaluationRule(record.evaluationRule, name),
    qualified: requireQualified(record.qualified, name),
    earnedPoints: requireNonNegativeNumber(record.actualCredit, `${name}累计积分`),
    requiredPoints: requireNonNegativeNumber(record.requiredCredit, `${name}要求积分`),
    earnedCredits: requireNonNegativeNumber(record.actualCreditScore, `${name}认定学分`),
    requiredCredits: requireNonNegativeNumber(record.requiredCreditScore, `${name}要求学分`),
    invalidPoints: requireNonNegativeNumber(record.invalidCredit, `${name}无效积分`),
    children: children.map((item) => normalizeCreditCategory(item)),
  };
}

function renderCreditGroup(category: SecondClassCreditCategoryView, index: number): string {
  const hasRequirement = category.requiredCredits > 0;
  const completed = hasRequirement && isCreditCategoryCompleted(category);
  const gap = Math.max(0, category.requiredCredits - category.earnedCredits);
  const status = hasRequirement ? creditCategoryStatus(category, completed, gap) : '累计分类';
  const scoreTarget = hasRequirement ? ` / ${formatCreditNumber(category.requiredCredits)}` : '';
  const pointTarget = category.requiredPoints > 0 ? ` / ${formatCreditNumber(category.requiredPoints)}` : '';
  const details = flattenCreditDetails(category.children);
  const invalid = category.invalidPoints > 0
    ? `<span class="credit-invalid">含 ${formatCreditNumber(category.invalidPoints)} 无效积分</span>`
    : '';
  const detailHtml = details.length
    ? `<div class="credit-details">${details.map((detail) => renderCreditDetail(detail)).join('')}</div>`
    : '';
  return `<article class="credit-group">
    <div class="credit-group-head">
      <div>
        <div class="credit-group-kicker">分类 ${String(index + 1).padStart(2, '0')}</div>
        <h3 class="credit-group-name">${escapeHtml(category.name)}</h3>
        <div class="credit-group-meta"><span>积分 ${formatCreditNumber(category.earnedPoints)}${pointTarget}</span><span class="credit-status">${escapeHtml(status)}</span>${invalid}</div>
      </div>
      <div class="credit-group-score"><strong>${formatCreditNumber(category.earnedCredits)}</strong><span>${scoreTarget} 学分</span></div>
    </div>
    ${hasRequirement ? `<div class="credit-progress"><span style="width:${progressPercent(category.earnedCredits, category.requiredCredits)}%"></span></div>` : ''}
    ${detailHtml}
  </article>`;
}

interface FlattenedCreditDetail {
  category: SecondClassCreditCategoryView;
  parentPath: string;
}

function flattenCreditDetails(
  categories: SecondClassCreditCategoryView[],
  ancestors: string[] = [],
): FlattenedCreditDetail[] {
  return categories.flatMap((category) => {
    const parentPath = ancestors.join(' › ');
    return [
      { category, parentPath },
      ...flattenCreditDetails(category.children, [...ancestors, category.name]),
    ];
  });
}

function renderCreditDetail(detail: FlattenedCreditDetail): string {
  const category = detail.category;
  const hasRequirement = category.requiredCredits > 0;
  const creditTarget = hasRequirement ? ` / ${formatCreditNumber(category.requiredCredits)} 学分` : ' 学分';
  const pointTarget = category.requiredPoints > 0 ? ` / ${formatCreditNumber(category.requiredPoints)}` : '';
  const state = hasRequirement
    ? creditCategoryStatus(category, isCreditCategoryCompleted(category), Math.max(0, category.requiredCredits - category.earnedCredits))
    : '累计';
  const path = detail.parentPath ? `<div class="credit-detail-path">${escapeHtml(detail.parentPath)}</div>` : '';
  const invalid = category.invalidPoints > 0 ? ` · 无效 ${formatCreditNumber(category.invalidPoints)}` : '';
  return `<article class="credit-detail">
    <div class="credit-detail-name">${escapeHtml(category.name)}</div>${path}
    <div class="credit-detail-score"><strong>${formatCreditNumber(category.earnedCredits)}${creditTarget}</strong><span>${escapeHtml(state)}</span></div>
    <div class="credit-detail-points">积分 ${formatCreditNumber(category.earnedPoints)}${pointTarget}${invalid}</div>
    ${hasRequirement ? `<div class="credit-detail-progress"><span style="width:${progressPercent(category.earnedCredits, category.requiredCredits)}%"></span></div>` : ''}
  </article>`;
}

function countCreditDetails(categories: SecondClassCreditCategoryView[]): number {
  return categories.reduce((total, category) => total + category.children.length + countCreditDetails(category.children), 0);
}

function formatCreditNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function progressPercent(value: number, required: number): number {
  return required <= 0 ? 0 : Math.min(100, Math.max(0, value / required * 100));
}

function isCreditCategoryCompleted(category: SecondClassCreditCategoryView): boolean {
  if (category.qualified != null) return category.qualified;
  const requiredChildren = category.children.filter((child) => child.requiredCredits > 0);
  if (category.evaluationRule === 1 && requiredChildren.length > 0) {
    return requiredChildren.every(isCreditCategoryCompleted);
  }
  return category.earnedCredits >= category.requiredCredits;
}

function creditCategoryStatus(category: SecondClassCreditCategoryView, completed: boolean, aggregateGap: number): string {
  if (completed) return '已达标';
  if (category.qualified === false) return '官方判定未达标';
  const requiredChildren = category.children.filter((child) => child.requiredCredits > 0);
  if (category.evaluationRule === 1 && requiredChildren.length > 0) {
    const completedChildren = requiredChildren.filter(isCreditCategoryCompleted).length;
    return `${completedChildren} / ${requiredChildren.length} 个必修子项达标`;
  }
  return `还差 ${formatCreditNumber(aggregateGap)} 学分`;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    throw new Error(`二课学分响应中的${label}无效。`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`二课学分响应中的${label}无效。`);
  return number;
}

function requireEvaluationRule(value: unknown, categoryName: string): 0 | 1 {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    throw new Error(`二课学分分类“${categoryName}”的考核规则无效。`);
  }
  const rule = Number(value);
  if (rule !== 0 && rule !== 1) {
    throw new Error(`二课学分分类“${categoryName}”的考核规则无效。`);
  }
  return rule;
}

function requireQualified(value: unknown, categoryName: string): boolean | null {
  if (value == null) return null;
  if (typeof value !== 'boolean') throw new Error(`二课学分分类“${categoryName}”的达标状态无效。`);
  return value;
}

async function renderCard(puppeteer: SecondClassPuppeteerLike, html: string): Promise<ReturnType<typeof h.image>> {
  const page = await puppeteer.page();
  try {
    await page.setViewport({ width: 1240, height: 1800, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const element = await page.$('#second-class-card');
    const box = await element?.boundingBox();
    if (!box) throw new Error('second-class card did not render.');
    const image = await page.screenshot({ type: 'png', clip: box, captureBeyondViewport: true });
    if (typeof image === 'string') throw new Error('second-class screenshot returned a path.');
    return h.image(Buffer.from(image), 'image/png');
  } finally {
    await page.close();
  }
}

function cardHtml(title: string, subtitle: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;padding:28px;background:#edf2f7;font-family:Inter,"Noto Sans SC","Microsoft YaHei",sans-serif;color:#172033}.card{width:1180px;padding:38px;background:#fff;border-radius:26px;box-shadow:0 18px 50px rgba(20,40,60,.12)}.head{display:flex;align-items:end;justify-content:space-between;margin-bottom:28px}.head h1{margin:0;font-size:42px}.head p{margin:0;color:#64748b;font-size:20px}table{border-collapse:collapse;width:100%;font-size:20px}th,td{padding:16px 13px;border-bottom:1px solid #dce4ee;text-align:left;vertical-align:top}th{background:#eff8f5;color:#116149}.empty{padding:90px 20px;text-align:center;color:#64748b;font-size:26px}.radar-wrap{display:grid;grid-template-columns:680px 1fr;align-items:center;gap:28px}.radar{width:680px;height:680px}.radar-list{display:grid;gap:12px}.radar-list div{display:flex;justify-content:space-between;gap:18px;padding:14px 18px;background:#f1f5f9;border-radius:12px;font-size:20px}.radar-list strong{color:#0b7451}
  </style></head><body><main id="second-class-card" class="card"><div class="head"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div>${body}</main></body></html>`;
}

function radarSvg(points: RadarPoint[]): string {
  const center = 340;
  const radius = 250;
  const maximum = Math.max(1, ...points.map((point) => point.value));
  const axis = points.map((point, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / points.length;
    const x = center + Math.cos(angle) * radius;
    const y = center + Math.sin(angle) * radius;
    const lx = center + Math.cos(angle) * (radius + 48);
    const ly = center + Math.sin(angle) * (radius + 48);
    return `<line x1="${center}" y1="${center}" x2="${x}" y2="${y}" stroke="#cbd5e1" stroke-width="2"/><text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" font-size="18" fill="#334155">${escapeHtml(shorten(point.name, 8))}</text>`;
  }).join('');
  const grids = [0.25, 0.5, 0.75, 1].map((scale) => `<polygon points="${polygon(points.length, radius * scale, center)}" fill="none" stroke="#d7e0e9" stroke-width="2"/>`).join('');
  const valuePoints = points.map((point, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / points.length;
    const scaled = radius * point.value / maximum;
    return `${center + Math.cos(angle) * scaled},${center + Math.sin(angle) * scaled}`;
  }).join(' ');
  return `<svg class="radar" viewBox="0 0 680 680">${grids}${axis}<polygon points="${valuePoints}" fill="rgba(18,139,112,.28)" stroke="#128b70" stroke-width="5"/></svg>`;
}

function polygon(count: number, radius: number, center: number): string {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
    return `${center + Math.cos(angle) * radius},${center + Math.sin(angle) * radius}`;
  }).join(' ');
}

function collectRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 8 || value == null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((entry) => collectRecords(entry, depth + 1));
  const record = value as Record<string, unknown>;
  const nested = Object.values(record).flatMap((entry) => collectRecords(entry, depth + 1));
  return [record, ...nested];
}

function firstText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (value != null && typeof value !== 'object' && String(value).trim()) return String(value).trim();
  }
  return '';
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.0+$/, '');
}

function shorten(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
