import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { h } from 'koishi';
import { assertGenshinAdvancedCookieCapability } from './cookie.js';
import { decryptGenshinCredential } from './credential.js';
import { GENSHIN_GACHA_ICON_BASE_URL, GENSHIN_GACHA_ICON_NAMES } from './gacha-icon-data.js';
import { gachaRecordKey, gachaSyncKey, type GenshinStore } from './store.js';
import {
  GenshinTakumiError,
  type GenshinAuthKey,
  type GenshinGachaLogPage,
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

const CARD_WIDTH = 900;
const MAX_POOL_HISTORY_ROWS = 8;

export interface GenshinGachaServiceOptions {
  timezone: string;
  requestIntervalMs: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

const SYNC_POOLS: Array<{ gachaType: GenshinGachaType; uigfGachaType: GenshinUigfGachaType }> = [
  { gachaType: '100', uigfGachaType: '100' },
  { gachaType: '200', uigfGachaType: '200' },
  { gachaType: '301', uigfGachaType: '301' },
  { gachaType: '400', uigfGachaType: '301' },
  { gachaType: '302', uigfGachaType: '302' },
  { gachaType: '500', uigfGachaType: '500' },
];

const POOL_VIEWS: Array<{
  uigfGachaType: GenshinUigfGachaType;
  title: string;
  tone: GenshinGachaPoolTone;
  accent: string;
  pityLimit: number;
  defaultVisible: boolean;
  badgeText: string;
}> = [
  { uigfGachaType: '301', title: '角色活动祈愿', tone: 'character', accent: '#ff5f66', pityLimit: 90, defaultVisible: true, badgeText: '角色' },
  { uigfGachaType: '302', title: '武器活动祈愿', tone: 'weapon', accent: '#63a9ff', pityLimit: 80, defaultVisible: true, badgeText: '武器' },
  { uigfGachaType: '200', title: '常驻祈愿', tone: 'standard', accent: '#8d79ff', pityLimit: 90, defaultVisible: true, badgeText: '常驻' },
  { uigfGachaType: '500', title: '集录祈愿', tone: 'chronicled', accent: '#52c2a2', pityLimit: 90, defaultVisible: false, badgeText: '集录' },
  { uigfGachaType: '100', title: '新手祈愿', tone: 'novice', accent: '#f1b25f', pityLimit: 90, defaultVisible: false, badgeText: '新手' },
];

type GenshinGachaPoolTone = 'character' | 'weapon' | 'standard' | 'chronicled' | 'novice';

export interface GenshinGachaRecordsView {
  uid: string;
  maskedUid: string;
  nickname: string;
  regionName: string;
  syncedAtText: string;
  addedCount: number;
  totalCount: number;
  poolViews: GenshinGachaPoolView[];
}

export interface GenshinGachaPoolView {
  title: string;
  tone: GenshinGachaPoolTone;
  accent: string;
  pityLimit: number;
  totalCount: number;
  currentPity: number;
  averageFivePityText: string;
  historyRows: GenshinGachaHistoryRowView[];
}

export interface GenshinGachaHistoryRowView {
  name: string;
  iconUrl: string;
  itemType: string;
  rankType: string;
  pityCount: number;
  barPercent: number;
  badgeText: string;
}

export class GenshinGachaService {
  private readonly activeQueries = new Map<string, Promise<GenshinGachaRecordsView>>();
  private readonly timezone: string;
  private readonly requestIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private gachaPageRequestChain: Promise<void> = Promise.resolve();
  private lastGachaPageRequestAt = 0;

  constructor(
    private readonly store: GenshinStore,
    private readonly client: GenshinTakumiClient,
    private readonly kek: CredentialKek,
    options: GenshinGachaServiceOptions,
  ) {
    this.timezone = options.timezone;
    this.requestIntervalMs = options.requestIntervalMs;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? sleepMs;
  }

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
      const page = await this.fetchGachaLogPagePaced(cookies, role, authKey, gachaType, endId);
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

  private fetchGachaLogPagePaced(
    cookies: Parameters<GenshinTakumiClient['fetchGachaLogPage']>[0],
    role: Parameters<GenshinTakumiClient['fetchGachaLogPage']>[1],
    authKey: GenshinAuthKey,
    gachaType: GenshinGachaType,
    endId: string,
  ): Promise<GenshinGachaLogPage> {
    const previous = this.gachaPageRequestChain.catch(() => {});
    const request = previous.then(async () => {
      if (this.lastGachaPageRequestAt > 0) {
        const elapsedMs = this.now() - this.lastGachaPageRequestAt;
        const delayMs = Math.max(0, this.requestIntervalMs - elapsedMs);
        if (delayMs > 0) await this.sleep(delayMs);
      }
      this.lastGachaPageRequestAt = this.now();
      return this.client.fetchGachaLogPage(cookies, role, authKey, gachaType, endId);
    });
    this.gachaPageRequestChain = request.then(() => undefined, () => undefined);
    return request;
  }
}

function sleepMs(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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
    await page.setViewport?.({ width: CARD_WIDTH, height: 1800, deviceScaleFactor: 1 });
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
      color: #ffffff;
      background: #090d1d;
      font-family: "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif;
    }
    #genshin-gacha-record-card {
      width: ${CARD_WIDTH}px;
      padding: 32px 44px 38px;
      background:
        radial-gradient(circle at 20% 0%, rgba(104, 166, 255, 0.34), transparent 30%),
        radial-gradient(circle at 82% 10%, rgba(255, 219, 112, 0.14), transparent 24%),
        linear-gradient(180deg, #1b3155 0%, #101933 34%, #090d1d 100%);
      position: relative;
      overflow: hidden;
    }
    #genshin-gacha-record-card::before {
      content: "";
      position: absolute;
      inset: 0;
      background-image:
        linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
      background-size: 36px 36px;
      opacity: 0.6;
    }
    #genshin-gacha-record-card::after {
      content: "";
      position: absolute;
      left: -40px;
      right: -40px;
      bottom: 20px;
      height: 520px;
      background:
        linear-gradient(142deg, transparent 0 42%, rgba(60, 82, 128, 0.36) 42% 61%, transparent 61%) 0 145px / 350px 320px no-repeat,
        linear-gradient(218deg, transparent 0 43%, rgba(42, 60, 102, 0.48) 43% 62%, transparent 62%) 430px 120px / 420px 390px no-repeat;
      opacity: 0.75;
    }
    .content {
      position: relative;
      z-index: 1;
    }
    .mast {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 22px;
      min-height: 74px;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      color: #f7fbff;
      font-size: 36px;
      line-height: 1.1;
      font-weight: 900;
      letter-spacing: 0;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      justify-content: flex-end;
      color: rgba(255,255,255,0.76);
      font-size: 17px;
      line-height: 1;
      font-weight: 800;
    }
    .pill {
      min-height: 30px;
      display: inline-flex;
      align-items: center;
      padding: 5px 10px;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 7px;
      background: rgba(5, 10, 27, 0.48);
      white-space: nowrap;
    }
    .pool-section {
      margin-top: 16px;
      padding: 20px 20px 18px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      background: rgba(5, 10, 27, 0.58);
    }
    .pool-section:first-of-type { margin-top: 0; }
    .pool-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 13px;
    }
    .pool-title {
      color: #f8fbff;
      font-size: 25px;
      font-weight: 900;
    }
    .pool-stats {
      display: grid;
      grid-template-columns: repeat(3, 74px);
      gap: 10px;
      text-align: center;
    }
    .stat-label {
      color: rgba(255,255,255,0.58);
      font-size: 13px;
      font-weight: 800;
      line-height: 1.2;
    }
    .stat-value {
      margin-top: 2px;
      color: #ffdf6e;
      font-size: 25px;
      line-height: 1;
      font-weight: 950;
      white-space: nowrap;
    }
    .history-list {
      display: grid;
      gap: 9px;
    }
    .pity-row {
      display: grid;
      grid-template-columns: 56px 1fr 64px;
      align-items: center;
      gap: 10px;
      min-height: 50px;
    }
    .history-row {
      display: grid;
      grid-template-columns: 56px 34px 1fr 64px;
      align-items: center;
      gap: 10px;
      min-height: 50px;
    }
    .wish-icon {
      width: 52px;
      height: 52px;
      border-radius: 8px;
      object-fit: cover;
      box-shadow: 0 8px 18px rgba(0,0,0,0.3);
    }
    .turn {
      width: 30px;
      height: 30px;
      display: grid;
      place-items: center;
      border-radius: 7px;
      color: rgba(255,255,255,0.76);
      background: rgba(255,255,255,0.13);
      font-size: 16px;
      font-weight: 900;
    }
    .bar-track {
      height: 38px;
      border-radius: 7px;
      background: rgba(255,255,255,0.09);
      overflow: hidden;
    }
    .bar {
      width: var(--bar-width);
      min-width: 220px;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 0 12px;
      border-radius: 7px;
      color: #fff;
      background:
        repeating-linear-gradient(45deg, rgba(255,255,255,0.16) 0 10px, transparent 10px 20px),
        var(--accent);
      box-shadow: 0 8px 18px rgba(0,0,0,0.26);
    }
    .bar-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 18px;
      font-weight: 900;
    }
    .bar-count {
      font-size: 18px;
      font-weight: 950;
      white-space: nowrap;
    }
    .current-pity {
      width: fit-content;
      max-width: 100%;
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      padding: 0 14px;
      border-radius: 7px;
      color: #ffffff;
      background: #44a875;
      font-size: 18px;
      font-weight: 900;
    }
    .badge {
      min-width: 54px;
      min-height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      justify-self: end;
      padding: 0 8px;
      border-radius: 7px;
      color: #151b2e;
      background: #ffe275;
      font-size: 15px;
      font-weight: 950;
    }
    .pool-section.is-weapon .badge { background: #79cdff; }
    .pool-section.is-standard .badge { background: #c5b8ff; }
    .pool-section.is-chronicled .badge { background: #86ebcd; }
    .pool-section.is-novice .badge { background: #ffd38b; }
    .empty {
      min-height: 54px;
      display: flex;
      align-items: center;
      color: rgba(255,255,255,0.58);
      font-size: 18px;
      font-weight: 800;
    }
    .footer {
      display: flex;
      justify-content: space-between;
      margin-top: 22px;
      color: rgba(255,255,255,0.5);
      font-size: 16px;
      font-weight: 800;
    }
  </style>
</head>
<body>
  <main id="genshin-gacha-record-card">
    <section class="content">
      <header class="mast">
        <h1>原神抽卡记录</h1>
        <div class="meta">
          <span class="pill">${escapeHtml(view.nickname || '旅行者')}</span>
          <span class="pill">UID ${escapeHtml(view.maskedUid)}</span>
          <span class="pill">${escapeHtml(view.regionName)}</span>
          <span class="pill">新增 ${view.addedCount}</span>
        </div>
      </header>
      ${view.poolViews.map(renderPoolHistorySection).join('')}
      <footer class="footer">
        <span>总抽数 ${view.totalCount}</span>
        <span>${escapeHtml(view.syncedAtText)}</span>
      </footer>
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
  return {
    uid: options.uid,
    maskedUid: maskUid(options.uid),
    nickname: options.nickname,
    regionName: options.regionName,
    syncedAtText: `同步 ${formatDateTimeInTimeZone(options.syncedAt, options.timezone)}`,
    addedCount: options.addedCount,
    totalCount: sorted.length,
    poolViews: buildPoolViews(sorted),
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
  return POOL_VIEWS.flatMap((pool) => {
    const poolRecords = records.filter((record) => record.uigfGachaType === pool.uigfGachaType);
    if (!pool.defaultVisible && poolRecords.length === 0) return [];
    const firstFiveIndex = poolRecords.findIndex((record) => record.rankType === '5');
    const currentPity = firstFiveIndex < 0 ? poolRecords.length : firstFiveIndex;
    const allHistoryRows = buildPoolHistoryRows(poolRecords, pool);
    return [{
      title: pool.title,
      tone: pool.tone,
      accent: pool.accent,
      pityLimit: pool.pityLimit,
      totalCount: poolRecords.length,
      currentPity,
      averageFivePityText: averagePityText(allHistoryRows),
      historyRows: allHistoryRows.slice(0, MAX_POOL_HISTORY_ROWS),
    }];
  });
}

function buildPoolHistoryRows(
  poolRecords: GenshinGachaRecord[],
  pool: (typeof POOL_VIEWS)[number],
): GenshinGachaHistoryRowView[] {
  const fiveIndexes = poolRecords
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.rankType === '5');
  return fiveIndexes.map(({ record, index }, order) => {
    const nextFiveIndex = fiveIndexes[order + 1]?.index;
    const pityCount = nextFiveIndex == null ? poolRecords.length - index : nextFiveIndex - index;
    return {
      name: record.name,
      iconUrl: resolveGachaIconUrl(record.itemId, pool.tone),
      itemType: record.itemType,
      rankType: record.rankType,
      pityCount,
      barPercent: barPercent(pityCount, pool.pityLimit),
      badgeText: historyBadgeText(record, pool),
    };
  });
}

function averagePityText(rows: GenshinGachaHistoryRowView[]): string {
  if (rows.length === 0) return '-';
  const average = rows.reduce((sum, row) => sum + row.pityCount, 0) / rows.length;
  return average.toFixed(1);
}

function barPercent(pityCount: number, pityLimit: number): number {
  return Math.max(18, Math.min(100, Math.round((pityCount / pityLimit) * 100)));
}

function historyBadgeText(record: GenshinGachaRecord, pool: (typeof POOL_VIEWS)[number]): string {
  if (pool.tone === 'standard' || pool.tone === 'chronicled' || pool.tone === 'novice') return pool.badgeText;
  return record.itemType === '武器' ? '武器' : '角色';
}

function renderPoolHistorySection(pool: GenshinGachaPoolView): string {
  return `<article class="pool-section is-${pool.tone}" style="--accent: ${escapeHtml(pool.accent)}">
    <div class="pool-head">
      <div class="pool-title">${escapeHtml(pool.title)}</div>
      <div class="pool-stats">
        <div><div class="stat-label">平均出金</div><div class="stat-value">${escapeHtml(pool.averageFivePityText)}</div></div>
        <div><div class="stat-label">总抽数</div><div class="stat-value">${pool.totalCount}</div></div>
        <div><div class="stat-label">当前垫数</div><div class="stat-value">${pool.currentPity}</div></div>
      </div>
    </div>
    <div class="history-list">
      ${pool.currentPity > 0 ? renderCurrentPityRow(pool) : ''}
      ${pool.historyRows.length ? pool.historyRows.map((row, index) => renderHistoryRow(row, pool, index)).join('') : '<div class="empty">暂无五星记录</div>'}
    </div>
  </article>`;
}

function renderCurrentPityRow(pool: GenshinGachaPoolView): string {
  return `<div class="pity-row">
    <img class="wish-icon" src="${renderUnknownWishIconSrc(pool.tone)}" alt="当前垫数">
    <div class="current-pity">已垫 ${pool.currentPity} 抽</div>
    <span class="badge">当前</span>
  </div>`;
}

function renderHistoryRow(row: GenshinGachaHistoryRowView, pool: GenshinGachaPoolView, index: number): string {
  return `<div class="history-row">
    <img class="wish-icon" src="${escapeHtml(row.iconUrl)}" alt="${escapeHtml(row.name)}">
    <div class="turn">${index + 1}</div>
    <div class="bar-track">
      <div class="bar" style="--bar-width: ${row.barPercent}%">
        <span class="bar-name">${escapeHtml(row.name)}</span>
        <span class="bar-count">${row.pityCount}抽</span>
      </div>
    </div>
    <span class="badge">${escapeHtml(row.badgeText)}</span>
  </div>`;
}

function resolveGachaIconUrl(itemId: string, tone: GenshinGachaPoolTone): string {
  const iconName = GENSHIN_GACHA_ICON_NAMES[itemId as keyof typeof GENSHIN_GACHA_ICON_NAMES];
  if (!iconName) return renderUnknownWishIconSrc(tone);
  return `${GENSHIN_GACHA_ICON_BASE_URL}${encodeURIComponent(iconName)}.png`;
}

function renderUnknownWishIconSrc(tone: GenshinGachaPoolTone): string {
  const palette = iconPalette(tone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${palette.start}"/>
        <stop offset="1" stop-color="${palette.end}"/>
      </linearGradient>
    </defs>
    <rect width="96" height="96" rx="14" fill="url(#g)"/>
    <circle cx="28" cy="28" r="26" fill="rgba(255,255,255,0.22)"/>
    <path d="M0 73 L96 38 L96 96 L0 96 Z" fill="rgba(0,0,0,0.18)"/>
    <rect x="5" y="5" width="86" height="86" rx="12" fill="none" stroke="${palette.stroke}" stroke-width="4"/>
    <text x="48" y="51" text-anchor="middle" dominant-baseline="middle" font-family="Microsoft YaHei, Noto Sans CJK SC, Arial, sans-serif" font-size="58" font-weight="900" fill="${palette.text}">?</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function iconPalette(tone: GenshinGachaPoolTone): { start: string; end: string; stroke: string; text: string } {
  if (tone === 'weapon') {
    return { start: '#7da9c8', end: '#2c466d', stroke: '#d8f5ff', text: '#ffffff' };
  }
  if (tone === 'standard') {
    return { start: '#8a82b7', end: '#403965', stroke: '#ece6ff', text: '#ffffff' };
  }
  if (tone === 'chronicled') {
    return { start: '#6ccdb7', end: '#245a53', stroke: '#d6fff5', text: '#ffffff' };
  }
  if (tone === 'novice') {
    return { start: '#d9a35c', end: '#704429', stroke: '#ffebc2', text: '#ffffff' };
  }
  return { start: '#a18482', end: '#4b3444', stroke: '#ffe9a8', text: '#ffffff' };
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
