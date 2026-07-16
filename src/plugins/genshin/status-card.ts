import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { h } from 'koishi';
import type { GenshinStatusReply } from './service.js';
import type { GenshinMenuPuppeteerLike } from './menu.js';

const STATUS_CARD_WIDTH = 960;

export interface GenshinStatusView {
  nickname: string;
  maskedUid: string;
  regionName: string;
  levelText: string;
  updatedAtText: string;
  resin: {
    current: number;
    max: number;
    percent: number;
    recoveryText: string;
    state: 'normal' | 'warning' | 'full';
  };
  homeCoin: {
    current: number;
    max: number;
    percent: number;
    recoveryText: string;
    state: 'normal' | 'warning' | 'full';
    unlocked: boolean;
  };
  commissions: {
    finished: number;
    total: number;
    rewardText: string;
    complete: boolean;
  };
  weeklyDiscount: {
    remaining: number;
    limit: number;
  };
  transformer: {
    title: string;
    detail: string;
    ready: boolean;
  };
  expeditions: Array<{
    avatarSideIcon: string;
    status: 'Finished' | 'Ongoing';
    statusText: string;
  }>;
  expeditionSummary: string;
}

export function buildGenshinStatusView(
  reply: GenshinStatusReply,
  timezone: string,
): GenshinStatusView {
  const { role, note, queriedAt } = reply;
  const finishedExpeditions = note.expeditions.filter((item) => item.status === 'Finished').length;
  return {
    nickname: role.nickname || '旅行者',
    maskedUid: maskUid(role.uid),
    regionName: role.regionName || role.region,
    levelText: role.level == null ? '冒险等阶未知' : `冒险等阶 ${role.level}`,
    updatedAtText: `${formatClock(queriedAt, timezone)} 更新`,
    resin: {
      current: note.currentResin,
      max: note.maxResin,
      percent: percent(note.currentResin, note.maxResin),
      recoveryText: resourceRecoveryText(
        note.currentResin,
        note.maxResin,
        note.resinRecoverySeconds,
        queriedAt,
        timezone,
        '树脂已回满',
      ),
      state: resourceState(note.currentResin, note.maxResin),
    },
    homeCoin: {
      current: note.currentHomeCoin,
      max: note.maxHomeCoin,
      percent: percent(note.currentHomeCoin, note.maxHomeCoin),
      recoveryText: resourceRecoveryText(
        note.currentHomeCoin,
        note.maxHomeCoin,
        note.homeCoinRecoverySeconds,
        queriedAt,
        timezone,
        '洞天宝钱已满',
      ),
      state: resourceState(note.currentHomeCoin, note.maxHomeCoin),
      unlocked: note.maxHomeCoin > 0,
    },
    commissions: {
      finished: note.finishedTaskNum,
      total: note.totalTaskNum,
      rewardText: note.isExtraTaskRewardReceived ? '每日委托奖励已领取' : '每日委托奖励未领取',
      complete: note.finishedTaskNum >= note.totalTaskNum && note.isExtraTaskRewardReceived,
    },
    weeklyDiscount: {
      remaining: note.remainResinDiscountNum,
      limit: note.resinDiscountNumLimit,
    },
    transformer: transformerView(note.transformer),
    expeditions: note.expeditions.map((item) => ({
      avatarSideIcon: item.avatarSideIcon,
      status: item.status,
      statusText: item.status === 'Finished'
        ? '已完成'
        : `${formatDuration(item.remainedSeconds)}后完成`,
    })),
    expeditionSummary: note.expeditions.length === 0
      ? '当前没有进行中的探索派遣'
      : `已派遣 ${note.currentExpeditionNum}/${note.maxExpeditionNum} · ${finishedExpeditions} 个可领取`,
  };
}

export async function renderGenshinStatusImage(
  puppeteer: GenshinMenuPuppeteerLike,
  view: GenshinStatusView,
): Promise<ReturnType<typeof h.image>> {
  const page = await puppeteer.page();
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'qqbot-genshin-status-'));
    const htmlPath = join(tempDir, 'status.html');
    await writeFile(htmlPath, renderGenshinStatusHtml(view), 'utf8');
    await page.setViewport?.({ width: STATUS_CARD_WIDTH, height: 1200, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
    await page.waitForSelector?.('#genshin-status-card', { timeout: 5000 });
    const card = await page.$('#genshin-status-card');
    if (!card) throw new Error('genshin status card root not found');
    const box = await card.boundingBox();
    if (!box) throw new Error('genshin status card root has no bounding box');
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

export function renderGenshinStatusHtml(view: GenshinStatusView): string {
  const expeditions = view.expeditions.length > 0
    ? view.expeditions.map((item) => `
        <div class="expedition ${item.status === 'Finished' ? 'finished' : ''}">
          <div class="avatar-shell">
            <span class="avatar-star">✦</span>
            <img src="${escapeHtml(item.avatarSideIcon)}" alt="" onerror="this.remove()">
          </div>
          <span class="expedition-status">${escapeHtml(item.statusText)}</span>
        </div>`).join('')
    : '<div class="expedition-empty">暂无派遣记录</div>';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>原神实时便笺</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: ${STATUS_CARD_WIDTH}px; margin: 0; overflow: hidden; }
    body {
      color: #22343a;
      background: #0b3c43;
      font-family: "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif;
    }
    #genshin-status-card {
      position: relative;
      width: ${STATUS_CARD_WIDTH}px;
      min-height: 1080px;
      padding: 30px;
      overflow: hidden;
      background:
        radial-gradient(circle at 12% 8%, rgba(118, 206, 194, .36) 0 2px, transparent 3px),
        radial-gradient(circle at 84% 13%, rgba(255, 232, 172, .72) 0 2px, transparent 3px),
        radial-gradient(circle at 78% 43%, rgba(118, 206, 194, .28) 0 2px, transparent 3px),
        linear-gradient(145deg, #0e5960 0%, #0b3d45 47%, #122f40 100%);
    }
    #genshin-status-card::before {
      content: "";
      position: absolute;
      width: 500px;
      height: 500px;
      right: -230px;
      top: -250px;
      border: 1px solid rgba(240, 206, 134, .34);
      border-radius: 50%;
      box-shadow:
        0 0 0 34px rgba(240, 206, 134, .035),
        0 0 0 88px rgba(240, 206, 134, .025);
    }
    #genshin-status-card::after {
      content: "";
      position: absolute;
      width: 620px;
      height: 260px;
      left: -170px;
      bottom: -190px;
      border: 2px solid rgba(137, 211, 198, .15);
      border-radius: 50%;
      transform: rotate(-9deg);
    }
    .sheet {
      position: relative;
      z-index: 1;
      overflow: hidden;
      border: 1px solid rgba(238, 219, 174, .66);
      border-radius: 28px;
      background: #f4f1e8;
      box-shadow: 0 26px 60px rgba(1, 20, 25, .32);
    }
    .header {
      position: relative;
      min-height: 188px;
      padding: 32px 38px 30px;
      color: #f8f4e8;
      background:
        linear-gradient(120deg, rgba(255,255,255,.05), transparent 42%),
        linear-gradient(135deg, #174f58, #153946);
    }
    .header::after {
      content: "";
      position: absolute;
      inset: auto 0 0;
      height: 8px;
      background: linear-gradient(90deg, #d5ae5e, #f3db9e 50%, #d5ae5e);
    }
    .eyebrow {
      display: flex;
      align-items: center;
      gap: 12px;
      color: #dfc884;
      font-size: 20px;
      font-weight: 800;
      letter-spacing: 5px;
    }
    .eyebrow::before,
    .eyebrow::after {
      content: "";
      width: 30px;
      height: 1px;
      background: #dfc884;
    }
    .identity-row {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 24px;
      margin-top: 18px;
    }
    .identity {
      display: flex;
      align-items: center;
      gap: 18px;
      min-width: 0;
    }
    .identity-seal {
      width: 74px;
      height: 74px;
      flex: 0 0 74px;
      display: grid;
      place-items: center;
      border: 2px solid rgba(238, 215, 153, .85);
      border-radius: 50%;
      color: #f4dda2;
      background: rgba(255,255,255,.06);
      box-shadow: inset 0 0 0 7px rgba(238, 215, 153, .08);
    }
    .identity-seal svg { width: 40px; height: 40px; }
    h1 {
      margin: 0;
      max-width: 510px;
      overflow: hidden;
      color: #fffdf6;
      font-size: 44px;
      line-height: 1.12;
      font-weight: 900;
      letter-spacing: 1px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .role-meta {
      margin-top: 9px;
      color: rgba(246, 241, 224, .76);
      font-size: 20px;
      letter-spacing: .5px;
    }
    .updated {
      flex: 0 0 auto;
      padding: 9px 14px;
      border: 1px solid rgba(238, 215, 153, .38);
      border-radius: 999px;
      color: #f3e4b5;
      background: rgba(8, 34, 41, .32);
      font-size: 17px;
      font-weight: 700;
    }
    .content { padding: 28px; }
    .resource-grid {
      display: grid;
      grid-template-columns: 1.18fr .82fr;
      gap: 20px;
    }
    .resin-panel {
      position: relative;
      min-height: 292px;
      display: flex;
      align-items: center;
      gap: 28px;
      overflow: hidden;
      padding: 30px;
      border-radius: 24px;
      color: #f8f5eb;
      background:
        radial-gradient(circle at 20% 50%, rgba(91, 223, 209, .18), transparent 35%),
        linear-gradient(135deg, #184f58, #183844);
      box-shadow: 0 12px 30px rgba(32, 66, 70, .18);
    }
    .resin-panel::after {
      content: "✦";
      position: absolute;
      right: 26px;
      top: 16px;
      color: rgba(241, 216, 150, .26);
      font-size: 72px;
    }
    .resin-ring {
      --progress: ${view.resin.percent}%;
      width: 174px;
      height: 174px;
      flex: 0 0 174px;
      display: grid;
      place-items: center;
      position: relative;
      border-radius: 50%;
      background: conic-gradient(#75d8c8 0 var(--progress), rgba(255,255,255,.12) var(--progress) 100%);
      box-shadow: 0 0 30px rgba(85, 211, 194, .18);
    }
    .resin-ring.warning {
      background: conic-gradient(#e3bd69 0 var(--progress), rgba(255,255,255,.12) var(--progress) 100%);
      box-shadow: 0 0 30px rgba(227, 189, 105, .20);
    }
    .resin-ring.full {
      background: conic-gradient(#e58f72 0 100%);
      box-shadow: 0 0 30px rgba(229, 143, 114, .22);
    }
    .resin-ring::before {
      content: "";
      position: absolute;
      inset: 11px;
      border-radius: 50%;
      background: linear-gradient(145deg, #173f49, #102f39);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.12);
    }
    .resin-value {
      position: relative;
      z-index: 1;
      text-align: center;
    }
    .resin-value strong {
      display: block;
      font-size: 58px;
      line-height: 1;
      font-weight: 900;
    }
    .resin-value span {
      display: block;
      margin-top: 7px;
      color: rgba(248,245,235,.65);
      font-size: 18px;
      font-weight: 700;
    }
    .resource-copy { position: relative; z-index: 1; min-width: 0; }
    .resource-label {
      color: #e0c77f;
      font-size: 20px;
      font-weight: 900;
      letter-spacing: 3px;
    }
    .resource-title {
      margin-top: 8px;
      font-size: 34px;
      line-height: 1.16;
      font-weight: 900;
    }
    .resource-detail {
      margin-top: 18px;
      color: rgba(248,245,235,.70);
      font-size: 18px;
      line-height: 1.5;
    }
    .side-stack {
      display: grid;
      grid-template-rows: 1fr 1fr;
      gap: 16px;
    }
    .mini-resource {
      position: relative;
      overflow: hidden;
      padding: 24px;
      border: 1px solid #dfd7c5;
      border-radius: 22px;
      background: rgba(255,255,255,.70);
    }
    .mini-resource::after {
      content: "";
      position: absolute;
      width: 110px;
      height: 110px;
      right: -42px;
      top: -45px;
      border: 16px solid rgba(47, 129, 128, .07);
      border-radius: 50%;
    }
    .mini-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: #586b6d;
      font-size: 18px;
      font-weight: 800;
    }
    .mini-value {
      margin-top: 8px;
      color: #1d4a50;
      font-size: 38px;
      line-height: 1;
      font-weight: 900;
    }
    .mini-value small {
      color: #839091;
      font-size: 18px;
      font-weight: 700;
    }
    .progress {
      height: 7px;
      margin-top: 15px;
      overflow: hidden;
      border-radius: 999px;
      background: #dedbd1;
    }
    .progress span {
      display: block;
      width: var(--progress);
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #3f9893, #73c9b9);
    }
    .mini-resource.warning .progress span { background: linear-gradient(90deg, #b88837, #dfbd6e); }
    .mini-resource.full .progress span { background: linear-gradient(90deg, #c66f58, #e69a7c); }
    .mini-detail {
      margin-top: 10px;
      color: #798485;
      font-size: 15px;
      font-weight: 650;
    }
    .weekly .mini-value { color: #9c6c29; }
    .status-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 18px;
      margin-top: 20px;
    }
    .status-tile {
      min-height: 164px;
      display: flex;
      align-items: center;
      gap: 20px;
      padding: 24px;
      border: 1px solid #dfd7c5;
      border-radius: 22px;
      background: rgba(255,255,255,.70);
    }
    .tile-icon {
      width: 66px;
      height: 66px;
      flex: 0 0 66px;
      display: grid;
      place-items: center;
      border-radius: 20px;
      color: #286a6d;
      background: #dceee8;
    }
    .tile-icon svg { width: 35px; height: 35px; }
    .status-tile.ready .tile-icon {
      color: #9a6925;
      background: #f5e6bd;
    }
    .tile-label {
      color: #6f7e7f;
      font-size: 17px;
      font-weight: 800;
    }
    .tile-value {
      margin-top: 5px;
      color: #223d42;
      font-size: 30px;
      line-height: 1.15;
      font-weight: 900;
    }
    .tile-detail {
      margin-top: 8px;
      color: #7b8788;
      font-size: 15px;
      font-weight: 650;
    }
    .expedition-panel {
      margin-top: 20px;
      padding: 24px 24px 22px;
      border: 1px solid #dfd7c5;
      border-radius: 22px;
      background:
        linear-gradient(135deg, rgba(51, 139, 134, .07), transparent 50%),
        rgba(255,255,255,.72);
    }
    .section-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }
    .section-title {
      display: flex;
      align-items: center;
      gap: 10px;
      color: #254d51;
      font-size: 21px;
      font-weight: 900;
      letter-spacing: 1px;
    }
    .section-title svg { width: 25px; height: 25px; color: #b7883e; }
    .section-summary {
      color: #778586;
      font-size: 15px;
      font-weight: 700;
    }
    .expeditions {
      min-height: 132px;
      display: flex;
      align-items: flex-end;
      gap: 16px;
      margin-top: 20px;
    }
    .expedition {
      flex: 1 1 0;
      min-width: 0;
      text-align: center;
    }
    .avatar-shell {
      position: relative;
      width: 86px;
      height: 86px;
      margin: 0 auto;
      overflow: hidden;
      border: 3px solid #d8c28c;
      border-radius: 50%;
      background: linear-gradient(145deg, #daeae4, #b9d5ce);
      box-shadow: 0 7px 14px rgba(32, 78, 76, .12);
    }
    .avatar-shell img {
      position: relative;
      z-index: 1;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .avatar-star {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: rgba(34, 92, 92, .28);
      font-size: 32px;
    }
    .finished .avatar-shell {
      border-color: #68b9aa;
      box-shadow: 0 0 0 5px rgba(104, 185, 170, .12);
    }
    .expedition-status {
      display: block;
      margin-top: 11px;
      overflow: hidden;
      color: #748081;
      font-size: 14px;
      font-weight: 750;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .finished .expedition-status { color: #248477; font-weight: 900; }
    .expedition-empty {
      width: 100%;
      align-self: center;
      color: #8a9695;
      font-size: 18px;
      font-weight: 700;
      text-align: center;
    }
    .footer {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 20px 30px 24px;
      color: #8a8173;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 1px;
    }
    .footer::before,
    .footer::after {
      content: "";
      width: 76px;
      height: 1px;
      background: #d7cdb9;
    }
  </style>
</head>
<body>
  <main id="genshin-status-card">
    <section class="sheet">
      <header class="header">
        <div class="eyebrow">实时便笺</div>
        <div class="identity-row">
          <div class="identity">
            <div class="identity-seal">${iconSvg('compass')}</div>
            <div>
              <h1>${escapeHtml(view.nickname)}</h1>
              <div class="role-meta">${escapeHtml(view.regionName)} · ${escapeHtml(view.levelText)} · UID ${escapeHtml(view.maskedUid)}</div>
            </div>
          </div>
          <div class="updated">${escapeHtml(view.updatedAtText)}</div>
        </div>
      </header>

      <div class="content">
        <section class="resource-grid">
          <article class="resin-panel">
            <div class="resin-ring ${view.resin.state}">
              <div class="resin-value">
                <strong>${view.resin.current}</strong>
                <span>/ ${view.resin.max}</span>
              </div>
            </div>
            <div class="resource-copy">
              <div class="resource-label">ORIGINAL RESIN</div>
              <div class="resource-title">原粹树脂</div>
              <div class="resource-detail">${escapeHtml(view.resin.recoveryText)}</div>
            </div>
          </article>

          <div class="side-stack">
            <article class="mini-resource ${view.homeCoin.state}">
              <div class="mini-heading"><span>洞天宝钱</span><span>${Math.round(view.homeCoin.percent)}%</span></div>
              <div class="mini-value">${view.homeCoin.unlocked ? `${view.homeCoin.current} <small>/ ${view.homeCoin.max}</small>` : '<small>尚未解锁</small>'}</div>
              <div class="progress" style="--progress: ${view.homeCoin.percent}%"><span></span></div>
              <div class="mini-detail">${escapeHtml(view.homeCoin.recoveryText)}</div>
            </article>
            <article class="mini-resource weekly">
              <div class="mini-heading"><span>周本减半</span><span>本周</span></div>
              <div class="mini-value">${view.weeklyDiscount.remaining} <small>/ ${view.weeklyDiscount.limit} 次剩余</small></div>
              <div class="mini-detail">征讨领域与奔狼领消耗减半</div>
            </article>
          </div>
        </section>

        <section class="status-grid">
          <article class="status-tile ${view.commissions.complete ? 'ready' : ''}">
            <div class="tile-icon">${iconSvg('commission')}</div>
            <div>
              <div class="tile-label">每日委托</div>
              <div class="tile-value">${view.commissions.finished} / ${view.commissions.total}</div>
              <div class="tile-detail">${escapeHtml(view.commissions.rewardText)}</div>
            </div>
          </article>
          <article class="status-tile ${view.transformer.ready ? 'ready' : ''}">
            <div class="tile-icon">${iconSvg('transformer')}</div>
            <div>
              <div class="tile-label">参量质变仪</div>
              <div class="tile-value">${escapeHtml(view.transformer.title)}</div>
              <div class="tile-detail">${escapeHtml(view.transformer.detail)}</div>
            </div>
          </article>
        </section>

        <section class="expedition-panel">
          <div class="section-heading">
            <div class="section-title">${iconSvg('expedition')}<span>探索派遣</span></div>
            <div class="section-summary">${escapeHtml(view.expeditionSummary)}</div>
          </div>
          <div class="expeditions">${expeditions}</div>
        </section>
      </div>

      <footer class="footer">数据来自米游社实时便笺</footer>
    </section>
  </main>
</body>
</html>`;
}

function transformerView(transformer: GenshinStatusReply['note']['transformer']): GenshinStatusView['transformer'] {
  if (!transformer.obtained) {
    return { title: '尚未获得', detail: '完成对应世界任务后解锁', ready: false };
  }
  if (transformer.reached) {
    return { title: '可使用', detail: '冷却已经完成', ready: true };
  }
  const seconds = transformer.day * 86_400
    + transformer.hour * 3_600
    + transformer.minute * 60
    + transformer.second;
  return {
    title: '冷却中',
    detail: `还需 ${formatDuration(seconds)}`,
    ready: false,
  };
}

function resourceRecoveryText(
  current: number,
  max: number,
  recoverySeconds: number,
  queriedAt: number,
  timezone: string,
  fullText: string,
): string {
  if (max === 0) return '尚未解锁尘歌壶';
  if (current >= max || recoverySeconds === 0) return fullText;
  return `预计 ${formatMonthDayClock(queriedAt + recoverySeconds * 1000, timezone)} 回满`;
}

function resourceState(current: number, max: number): 'normal' | 'warning' | 'full' {
  if (max === 0) return 'normal';
  if (current >= max) return 'full';
  if (current / max >= 0.8) return 'warning';
  return 'normal';
}

function percent(current: number, max: number): number {
  if (max === 0) return 0;
  return Math.max(0, Math.min(100, Number(((current / max) * 100).toFixed(2))));
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return '不足1分钟';
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (days === 0 && minutes > 0) parts.push(`${minutes}分钟`);
  return parts.slice(0, 2).join('');
}

function formatClock(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);
}

function formatMonthDayClock(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);
}

function maskUid(uid: string): string {
  if (uid.length <= 4) return uid;
  return `${uid.slice(0, 3)}****${uid.slice(-2)}`;
}

function iconSvg(name: 'compass' | 'commission' | 'transformer' | 'expedition'): string {
  const paths = {
    compass: '<circle cx="12" cy="12" r="9"/><path d="m15.3 8.7-2.1 4.5-4.5 2.1 2.1-4.5 4.5-2.1Z"/><circle cx="12" cy="12" r="1"/>',
    commission: '<path d="M8 3h8l1 3h3v14H4V6h3l1-3Z"/><path d="m8 13 2.5 2.5L16 10"/><path d="M9 6h6"/>',
    transformer: '<circle cx="12" cy="12" r="8"/><path d="M12 4v4l3 2-3 2v4"/><path d="m8 9 4-1M8 15l4 1"/><path d="M4 12h3m10 0h3"/>',
    expedition: '<path d="M4 19 9 5l4 8 2-4 5 10H4Z"/><path d="m7 14 2-2 2 2 2-1 3 3"/><circle cx="17" cy="5" r="2"/>',
  } as const;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
