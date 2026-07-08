import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { h } from 'koishi';
import { assertGenshinAdvancedCookieCapability } from './cookie.js';
import { decryptGenshinCredential } from './credential.js';
import { gachaRecordKey, gachaSyncKey, type GenshinStore } from './store.js';
import {
  GenshinTakumiError,
  type GenshinAuthKey,
  type GenshinGachaLogItem,
  type GenshinTakumiClient,
} from './takumi-client.js';
import {
  type GenshinGachaRecord,
  type GenshinGachaType,
  type GenshinUigfGachaType,
  GenshinUserError,
  type OwnerIdentity,
} from './types.js';
import type { CredentialKek } from '../shared/credential-crypto.js';
import type { GenshinMenuPuppeteerLike } from './menu.js';

const CARD_WIDTH = 1320;

const SYNC_POOLS: Array<{ gachaType: GenshinGachaType; uigfGachaType: GenshinUigfGachaType }> = [
  { gachaType: '100', uigfGachaType: '100' },
  { gachaType: '200', uigfGachaType: '200' },
  { gachaType: '301', uigfGachaType: '301' },
  { gachaType: '400', uigfGachaType: '301' },
  { gachaType: '302', uigfGachaType: '302' },
  { gachaType: '500', uigfGachaType: '500' },
];

const POOL_VIEWS: Array<{ uigfGachaType: GenshinUigfGachaType; title: string; accent: string }> = [
  { uigfGachaType: '301', title: '角色活动', accent: '#2f7d9b' },
  { uigfGachaType: '302', title: '武器活动', accent: '#b68424' },
  { uigfGachaType: '200', title: '常驻祈愿', accent: '#6a7180' },
  { uigfGachaType: '500', title: '集录祈愿', accent: '#9a5fb6' },
  { uigfGachaType: '100', title: '新手祈愿', accent: '#3f9b6a' },
];

export interface GenshinGachaRecordsView {
  uid: string;
  maskedUid: string;
  nickname: string;
  regionName: string;
  syncedAtText: string;
  addedCount: number;
  totalCount: number;
  rank5Count: number;
  rank4Count: number;
  rank5RateText: string;
  rank4RateText: string;
  poolViews: GenshinGachaPoolView[];
  recentFive: GenshinGachaRecordView[];
  recentRecords: GenshinGachaRecordView[];
}

export interface GenshinGachaPoolView {
  title: string;
  accent: string;
  totalCount: number;
  currentPity: number;
  lastFiveName: string;
  lastFivePityText: string;
}

export interface GenshinGachaRecordView {
  name: string;
  itemType: string;
  rankType: string;
  poolLabel: string;
  time: string;
  pityText: string;
}

export class GenshinGachaService {
  private readonly activeQueries = new Map<string, Promise<GenshinGachaRecordsView>>();

  constructor(
    private readonly store: GenshinStore,
    private readonly client: GenshinTakumiClient,
    private readonly kek: CredentialKek,
    private readonly timezone: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async queryGachaRecords(identity: OwnerIdentity): Promise<GenshinGachaRecordsView> {
    const running = this.activeQueries.get(identity.ownerKey);
    if (running) return running;
    const query = this.queryGachaRecordsNow(identity).finally(() => {
      this.activeQueries.delete(identity.ownerKey);
    });
    this.activeQueries.set(identity.ownerKey, query);
    return query;
  }

  private async queryGachaRecordsNow(identity: OwnerIdentity): Promise<GenshinGachaRecordsView> {
    const credential = await this.store.getActiveCredential(identity.ownerKey);
    if (!credential) {
      throw new GenshinUserError('请先发送“原神绑定”完成 UID 绑定。');
    }
    const { payload, role } = decryptGenshinCredential(credential, this.kek);
    const now = this.now();
    try {
      assertGenshinAdvancedCookieCapability(payload.cookies, '当前绑定 Cookie 不包含 stoken + mid/stuid，不能读取抽卡记录。请重新发送“原神绑定”完成扫码绑定。');
      const authKey = await this.client.createGachaAuthKey(payload.cookies, role);
      const addedCount = await this.syncPools(identity.ownerKey, role.uid, role.region, payload.cookies, role, authKey, now);
      await this.store.markCredentialUsed(credential.id, now);
      await this.store.audit({
        ownerKey: credential.ownerKey,
        eventType: 'gacha_records_synced',
        status: 'ok',
        reason: null,
        createdAt: now,
      });
      const records = await this.store.listGachaRecords(role.uid, role.region);
      return buildGachaRecordsView(records, {
        uid: role.uid,
        nickname: role.nickname,
        regionName: role.regionName || role.region,
        addedCount,
        syncedAt: now,
        timezone: this.timezone,
      });
    } catch (error) {
      const result = gachaFailure(error);
      await this.store.markCredentialFailure(credential.id, result.message, now);
      await this.store.audit({
        ownerKey: credential.ownerKey,
        eventType: 'gacha_records_failed',
        status: 'failed',
        reason: result.message,
        createdAt: now,
      });
      throw new GenshinUserError(result.message);
    }
  }

  private async syncPools(
    ownerKey: string,
    uid: string,
    region: string,
    cookies: Parameters<GenshinTakumiClient['fetchGachaLogPage']>[0],
    role: Parameters<GenshinTakumiClient['fetchGachaLogPage']>[1],
    authKey: GenshinAuthKey,
    now: number,
  ): Promise<number> {
    let totalNewCount = 0;
    for (const pool of SYNC_POOLS) {
      const result = await this.syncPool(ownerKey, uid, region, cookies, role, authKey, pool.gachaType, pool.uigfGachaType, now);
      totalNewCount += result.newCount;
      await this.store.upsertGachaSyncState({
        syncKey: gachaSyncKey(ownerKey, uid, region, pool.gachaType),
        ownerKey,
        uid,
        region,
        gachaType: pool.gachaType,
        lastSyncedAt: now,
        lastFetchedRecordId: result.latestRecordId,
        lastNewCount: result.newCount,
        updatedAt: now,
      });
    }
    return totalNewCount;
  }

  private async syncPool(
    ownerKey: string,
    uid: string,
    region: string,
    cookies: Parameters<GenshinTakumiClient['fetchGachaLogPage']>[0],
    role: Parameters<GenshinTakumiClient['fetchGachaLogPage']>[1],
    authKey: GenshinAuthKey,
    gachaType: GenshinGachaType,
    uigfGachaType: GenshinUigfGachaType,
    now: number,
  ): Promise<{ newCount: number; latestRecordId: string }> {
    let endId = '0';
    let newCount = 0;
    let latestRecordId = '';
    while (true) {
      const page = await this.client.fetchGachaLogPage(cookies, role, authKey, gachaType, endId);
      if (page.list.length === 0) return { newCount, latestRecordId };
      latestRecordId ||= page.list[0]?.id ?? '';
      let foundExisting = false;
      for (const item of page.list) {
        const recordKey = gachaRecordKey(uid, region, item.id);
        const existing = await this.store.findGachaRecord(recordKey);
        if (existing) {
          foundExisting = true;
          break;
        }
        await this.store.createGachaRecord(toGachaRecordRow({
          ownerKey,
          uid,
          region,
          recordKey,
          item,
          gachaType,
          uigfGachaType,
          now,
        }));
        newCount += 1;
      }
      if (foundExisting) return { newCount, latestRecordId };
      endId = page.list[page.list.length - 1]?.id ?? '';
      if (!endId) return { newCount, latestRecordId };
    }
  }
}

export async function renderGenshinGachaRecordsImage(
  puppeteer: GenshinMenuPuppeteerLike,
  view: GenshinGachaRecordsView,
): Promise<ReturnType<typeof h.image>> {
  const page = await puppeteer.page();
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'qqbot-genshin-gacha-records-'));
    const htmlPath = join(tempDir, 'gacha-records.html');
    await writeFile(htmlPath, renderGenshinGachaRecordsHtml(view), 'utf8');
    await page.setViewport?.({ width: CARD_WIDTH, height: 1180, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
    await page.waitForSelector?.('#genshin-gacha-record-card', { timeout: 5000 });
    const card = await page.$('#genshin-gacha-record-card');
    if (!card) throw new Error('genshin gacha record root not found');
    const box = await card.boundingBox();
    if (!box) throw new Error('genshin gacha record root has no bounding box');
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

export function renderGenshinGachaRecordsHtml(view: GenshinGachaRecordsView): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>原神抽卡记录</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: ${CARD_WIDTH}px; margin: 0; overflow: hidden; }
    body {
      color: #18222e;
      background: #eef4f3;
      font-family: "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif;
    }
    #genshin-gacha-record-card {
      width: ${CARD_WIDTH}px;
      padding: 32px;
      background:
        linear-gradient(135deg, rgba(47, 125, 155, 0.12), transparent 34%),
        linear-gradient(315deg, rgba(182, 132, 36, 0.16), transparent 36%),
        #eef4f3;
    }
    .sheet {
      overflow: hidden;
      border: 2px solid rgba(55, 107, 124, 0.32);
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.97);
      box-shadow: 0 24px 58px rgba(25, 63, 82, 0.15);
    }
    .hero {
      min-height: 168px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 28px;
      padding: 34px 42px;
      border-bottom: 1px solid #dde9ea;
      background: linear-gradient(180deg, #fbfefe, #f3f9f8);
    }
    h1 {
      margin: 0;
      color: #173b4a;
      font-size: 54px;
      line-height: 1.08;
      font-weight: 900;
      letter-spacing: 0;
    }
    .meta {
      margin-top: 14px;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      color: #53636b;
      font-size: 22px;
      line-height: 1.2;
      font-weight: 700;
    }
    .pill {
      min-height: 34px;
      display: inline-flex;
      align-items: center;
      padding: 5px 12px;
      border: 1px solid #cfe0e2;
      border-radius: 999px;
      background: #ffffff;
      white-space: nowrap;
    }
    .sync {
      min-width: 210px;
      padding: 18px 20px;
      border-left: 5px solid #b68424;
      border-radius: 8px;
      background: #fffaf0;
      text-align: right;
    }
    .sync-label {
      color: #80601d;
      font-size: 20px;
      font-weight: 800;
    }
    .sync-value {
      margin-top: 5px;
      color: #2f3942;
      font-size: 32px;
      line-height: 1.05;
      font-weight: 900;
    }
    .kpis {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 16px;
      padding: 24px 28px 18px;
    }
    .kpi {
      min-height: 116px;
      padding: 18px;
      border: 1px solid #dce8ea;
      border-radius: 8px;
      background: #ffffff;
    }
    .kpi-label {
      color: #65747b;
      font-size: 20px;
      line-height: 1.2;
      font-weight: 800;
    }
    .kpi-value {
      margin-top: 12px;
      color: #172033;
      font-size: 38px;
      line-height: 1;
      font-weight: 900;
    }
    .pools {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 14px;
      padding: 0 28px 24px;
    }
    .pool {
      min-height: 142px;
      padding: 16px;
      border: 1px solid #dce8ea;
      border-top: 5px solid var(--accent);
      border-radius: 8px;
      background: #fbfdfd;
    }
    .pool-title {
      color: #1f3440;
      font-size: 22px;
      font-weight: 900;
    }
    .pool-counts {
      margin-top: 12px;
      display: flex;
      justify-content: space-between;
      gap: 10px;
    }
    .pool-counts span {
      color: #69777e;
      font-size: 17px;
      font-weight: 800;
    }
    .pool-counts strong {
      display: block;
      margin-top: 4px;
      color: #172033;
      font-size: 28px;
      line-height: 1;
      font-weight: 900;
    }
    .pool-last {
      margin-top: 12px;
      color: #637179;
      font-size: 17px;
      line-height: 1.25;
      font-weight: 700;
      word-break: keep-all;
      overflow-wrap: anywhere;
    }
    .sections {
      display: grid;
      grid-template-columns: 410px 1fr;
      gap: 20px;
      padding: 0 28px 30px;
    }
    .panel {
      border: 1px solid #dce8ea;
      border-radius: 8px;
      background: #ffffff;
      overflow: hidden;
    }
    .panel-title {
      height: 54px;
      display: flex;
      align-items: center;
      padding: 0 18px;
      border-bottom: 1px solid #e3ecef;
      color: #173b4a;
      font-size: 24px;
      font-weight: 900;
      background: #f6fbfb;
    }
    .timeline {
      padding: 14px 18px 18px;
      display: grid;
      gap: 10px;
    }
    .five {
      min-height: 54px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 74px;
      align-items: center;
      gap: 10px;
      padding-bottom: 10px;
      border-bottom: 1px solid #edf2f3;
    }
    .five:last-child { border-bottom: 0; padding-bottom: 0; }
    .five-name {
      min-width: 0;
      color: #9b6d17;
      font-size: 21px;
      line-height: 1.15;
      font-weight: 900;
      overflow-wrap: anywhere;
    }
    .five-meta {
      margin-top: 4px;
      color: #6d7b82;
      font-size: 15px;
      line-height: 1.2;
      font-weight: 700;
    }
    .five-pity {
      color: #173b4a;
      font-size: 22px;
      text-align: right;
      font-weight: 900;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      height: 42px;
      padding: 7px 10px;
      border-bottom: 1px solid #edf2f3;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 17px;
      line-height: 1.2;
    }
    th {
      color: #68767d;
      font-size: 15px;
      font-weight: 900;
      background: #fbfdfd;
    }
    td {
      color: #24313a;
      font-weight: 700;
    }
    .rank-5 td:first-child { color: #ad7512; font-weight: 900; }
    .rank-4 td:first-child { color: #7a55a2; font-weight: 900; }
    .empty {
      padding: 24px;
      color: #708087;
      font-size: 20px;
      font-weight: 800;
    }
  </style>
</head>
<body>
  <main id="genshin-gacha-record-card">
    <section class="sheet">
      <header class="hero">
        <div>
          <h1>原神抽卡记录</h1>
          <div class="meta">
            <span class="pill">${escapeHtml(view.nickname || '旅行者')}</span>
            <span class="pill">UID ${escapeHtml(view.maskedUid)}</span>
            <span class="pill">${escapeHtml(view.regionName)}</span>
            <span class="pill">${escapeHtml(view.syncedAtText)}</span>
          </div>
        </div>
        <div class="sync">
          <div class="sync-label">本次新增</div>
          <div class="sync-value">${view.addedCount}</div>
        </div>
      </header>
      <section class="kpis">
        ${renderKpi('总抽数', String(view.totalCount))}
        ${renderKpi('五星', `${view.rank5Count}`)}
        ${renderKpi('五星出率', view.rank5RateText)}
        ${renderKpi('四星', `${view.rank4Count}`)}
        ${renderKpi('四星出率', view.rank4RateText)}
      </section>
      <section class="pools">
        ${view.poolViews.map(renderPool).join('')}
      </section>
      <section class="sections">
        <article class="panel">
          <div class="panel-title">最近五星</div>
          <div class="timeline">
            ${view.recentFive.length ? view.recentFive.map(renderRecentFive).join('') : '<div class="empty">暂无五星记录</div>'}
          </div>
        </article>
        <article class="panel">
          <div class="panel-title">最近记录</div>
          ${renderRecentTable(view.recentRecords)}
        </article>
      </section>
    </section>
  </main>
</body>
</html>`;
}

export function buildGachaRecordsView(
  records: GenshinGachaRecord[],
  options: {
    uid: string;
    nickname: string;
    regionName: string;
    addedCount: number;
    syncedAt: number;
    timezone: string;
  },
): GenshinGachaRecordsView {
  const sorted = [...records].sort(compareGachaRecordDesc);
  const rank5Count = sorted.filter((record) => record.rankType === '5').length;
  const rank4Count = sorted.filter((record) => record.rankType === '4').length;
  return {
    uid: options.uid,
    maskedUid: maskUid(options.uid),
    nickname: options.nickname,
    regionName: options.regionName,
    syncedAtText: `同步 ${formatDateTimeInTimeZone(options.syncedAt, options.timezone)}`,
    addedCount: options.addedCount,
    totalCount: sorted.length,
    rank5Count,
    rank4Count,
    rank5RateText: formatRate(rank5Count, sorted.length),
    rank4RateText: formatRate(rank4Count, sorted.length),
    poolViews: buildPoolViews(sorted),
    recentFive: buildRecentViews(sorted.filter((record) => record.rankType === '5').slice(0, 8)),
    recentRecords: buildRecentViews(sorted.slice(0, 20)),
  };
}

function toGachaRecordRow(args: {
  ownerKey: string;
  uid: string;
  region: string;
  recordKey: string;
  item: GenshinGachaLogItem;
  gachaType: GenshinGachaType;
  uigfGachaType: GenshinUigfGachaType;
  now: number;
}): Omit<GenshinGachaRecord, 'id'> {
  return {
    recordKey: args.recordKey,
    ownerKey: args.ownerKey,
    uid: args.uid,
    region: args.region,
    gachaType: args.gachaType,
    uigfGachaType: args.uigfGachaType,
    recordId: args.item.id,
    itemId: args.item.itemId,
    name: args.item.name,
    itemType: args.item.itemType,
    rankType: args.item.rankType,
    count: args.item.count,
    time: args.item.time,
    createdAt: args.now,
  };
}

function buildPoolViews(records: GenshinGachaRecord[]): GenshinGachaPoolView[] {
  return POOL_VIEWS.map((pool) => {
    const poolRecords = records.filter((record) => record.uigfGachaType === pool.uigfGachaType);
    const firstFiveIndex = poolRecords.findIndex((record) => record.rankType === '5');
    const currentPity = firstFiveIndex < 0 ? poolRecords.length : firstFiveIndex;
    const lastFive = firstFiveIndex < 0 ? null : poolRecords[firstFiveIndex]!;
    return {
      title: pool.title,
      accent: pool.accent,
      totalCount: poolRecords.length,
      currentPity,
      lastFiveName: lastFive?.name ?? '暂无五星',
      lastFivePityText: lastFive ? `${firstFiveIndex + 1} 抽前` : '等待首金',
    };
  });
}

function buildRecentViews(records: GenshinGachaRecord[]): GenshinGachaRecordView[] {
  return records.map((record) => ({
    name: record.name,
    itemType: record.itemType,
    rankType: record.rankType,
    poolLabel: poolLabel(record.uigfGachaType),
    time: record.time,
    pityText: `${record.rankType}★`,
  }));
}

function renderKpi(label: string, value: string): string {
  return `<article class="kpi"><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-value">${escapeHtml(value)}</div></article>`;
}

function renderPool(pool: GenshinGachaPoolView): string {
  return `<article class="pool" style="--accent: ${escapeHtml(pool.accent)}">
    <div class="pool-title">${escapeHtml(pool.title)}</div>
    <div class="pool-counts">
      <span>总抽<strong>${pool.totalCount}</strong></span>
      <span>当前垫数<strong>${pool.currentPity}</strong></span>
    </div>
    <div class="pool-last">${escapeHtml(pool.lastFiveName)} · ${escapeHtml(pool.lastFivePityText)}</div>
  </article>`;
}

function renderRecentFive(row: GenshinGachaRecordView): string {
  return `<div class="five">
    <div>
      <div class="five-name">${escapeHtml(row.name)}</div>
      <div class="five-meta">${escapeHtml(row.poolLabel)} · ${escapeHtml(row.time)}</div>
    </div>
    <div class="five-pity">${escapeHtml(row.pityText)}</div>
  </div>`;
}

function renderRecentTable(rows: GenshinGachaRecordView[]): string {
  if (rows.length === 0) return '<div class="empty">暂无抽卡记录</div>';
  return `<table>
    <thead>
      <tr>
        <th style="width: 29%">名称</th>
        <th style="width: 13%">星级</th>
        <th style="width: 17%">类型</th>
        <th style="width: 19%">卡池</th>
        <th style="width: 22%">时间</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(renderRecordRow).join('')}
    </tbody>
  </table>`;
}

function renderRecordRow(row: GenshinGachaRecordView): string {
  const rankClass = row.rankType === '5' ? 'rank-5' : row.rankType === '4' ? 'rank-4' : 'rank-3';
  return `<tr class="${rankClass}">
    <td>${escapeHtml(row.name)}</td>
    <td>${escapeHtml(row.rankType)}★</td>
    <td>${escapeHtml(row.itemType)}</td>
    <td>${escapeHtml(row.poolLabel)}</td>
    <td>${escapeHtml(row.time)}</td>
  </tr>`;
}

function compareGachaRecordDesc(left: GenshinGachaRecord, right: GenshinGachaRecord): number {
  const timeOrder = right.time.localeCompare(left.time);
  if (timeOrder !== 0) return timeOrder;
  return compareRecordIdDesc(left.recordId, right.recordId);
}

function compareRecordIdDesc(left: string, right: string): number {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  if (leftId === rightId) return 0;
  return leftId > rightId ? -1 : 1;
}

function poolLabel(uigfGachaType: GenshinUigfGachaType): string {
  return POOL_VIEWS.find((pool) => pool.uigfGachaType === uigfGachaType)?.title ?? uigfGachaType;
}

function formatRate(count: number, total: number): string {
  if (total === 0) return '0.00%';
  return `${((count / total) * 100).toFixed(2)}%`;
}

function formatDateTimeInTimeZone(time: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(time));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

function maskUid(uid: string): string {
  if (uid.length <= 5) return uid;
  return `${uid.slice(0, 3)}****${uid.slice(-2)}`;
}

function gachaFailure(error: unknown): { message: string } {
  if (error instanceof GenshinTakumiError || error instanceof GenshinUserError) {
    return { message: error.message };
  }
  return { message: '原神抽卡记录读取失败，请稍后重试。' };
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
