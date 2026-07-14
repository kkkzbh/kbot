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
