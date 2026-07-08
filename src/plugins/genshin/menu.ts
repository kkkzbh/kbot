import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { h, type Fragment } from 'koishi';

const MENU_WIDTH = 1320;

export interface GenshinMenuPuppeteerLike {
  page(): Promise<GenshinMenuPageLike>;
}

interface GenshinMenuPageLike {
  setViewport?(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<unknown>;
  goto(url: string, options?: unknown): Promise<unknown>;
  waitForSelector?(selector: string, options?: unknown): Promise<unknown>;
  $(selector: string): Promise<GenshinMenuElementLike | null>;
  screenshot(options?: unknown): Promise<Buffer | Uint8Array | string>;
  close(): Promise<unknown>;
}

interface GenshinMenuElementLike {
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
}

export interface GenshinMenuItemView {
  keyword: string;
  description: string;
  icon: GenshinMenuIconName;
  accent?: 'gold';
}

export interface GenshinMenuSectionView {
  title: '账号' | '日常' | '记录';
  icon: GenshinMenuIconName;
  items: GenshinMenuItemView[];
}

export interface GenshinMenuView {
  title: string;
  subtitle: string;
  sections: GenshinMenuSectionView[];
}

type GenshinMenuIconName =
  | 'chart'
  | 'check'
  | 'gift'
  | 'link-off'
  | 'moon'
  | 'plus-shield'
  | 'spark'
  | 'user';

const MENU_SECTIONS: GenshinMenuSectionView[] = [
  {
    title: '账号',
    icon: 'user',
    items: [
      { keyword: '原神绑定', description: '绑定米游社国服原神 UID', icon: 'plus-shield' },
      { keyword: '原神确认 <确认码>', description: '绑定页验证通过后确认绑定', icon: 'check', accent: 'gold' },
      { keyword: '原神解绑', description: '解除当前 QQ 与原神 UID 的绑定', icon: 'link-off' },
    ],
  },
  {
    title: '日常',
    icon: 'spark',
    items: [
      { keyword: '原神签到', description: '为已绑定 UID 执行每日签到', icon: 'moon' },
      { keyword: '原神兑换 <兑换码>', description: '为已绑定 UID 领取兑换码奖励', icon: 'gift', accent: 'gold' },
    ],
  },
  {
    title: '记录',
    icon: 'chart',
    items: [
      { keyword: '抽卡记录', description: '同步并查看当前 UID 抽卡统计', icon: 'chart', accent: 'gold' },
    ],
  },
];

export class GenshinMenuService {
  constructor(private readonly puppeteer: GenshinMenuPuppeteerLike) {}

  async queryMenu(qqUserId: string): Promise<Fragment> {
    return [h.at(qqUserId), h.text('\n'), await renderGenshinMenuImage(this.puppeteer, buildGenshinMenuView())];
  }
}

export function buildGenshinMenuView(): GenshinMenuView {
  return {
    title: '原神功能菜单',
    subtitle: '发送 原神 查看本菜单',
    sections: MENU_SECTIONS,
  };
}

export async function renderGenshinMenuImage(
  puppeteer: GenshinMenuPuppeteerLike,
  view: GenshinMenuView,
): Promise<ReturnType<typeof h.image>> {
  const page = await puppeteer.page();
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'qqbot-genshin-menu-'));
    const htmlPath = join(tempDir, 'menu.html');
    await writeFile(htmlPath, renderGenshinMenuHtml(view), 'utf8');
    await page.setViewport?.({ width: MENU_WIDTH, height: 960, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
    await page.waitForSelector?.('#genshin-menu-card', { timeout: 5000 });
    const card = await page.$('#genshin-menu-card');
    if (!card) throw new Error('genshin menu root not found');
    const box = await card.boundingBox();
    if (!box) throw new Error('genshin menu root has no bounding box');
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

export function renderGenshinMenuHtml(view: GenshinMenuView): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(view.title)}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: ${MENU_WIDTH}px; overflow: hidden; }
    body {
      margin: 0;
      color: #172033;
      background: #eef6f3;
      font-family: "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif;
    }
    #genshin-menu-card {
      width: ${MENU_WIDTH}px;
      margin: 0;
      padding: 34px;
      background:
        linear-gradient(135deg, rgba(52, 145, 177, 0.12), transparent 34%),
        linear-gradient(315deg, rgba(225, 170, 72, 0.16), transparent 35%),
        #eef6f3;
    }
    .sheet {
      overflow: hidden;
      border: 2px solid rgba(73, 127, 136, 0.36);
      border-radius: 24px;
      background: rgba(255, 255, 255, 0.95);
      box-shadow: 0 24px 58px rgba(34, 73, 86, 0.14);
    }
    .hero {
      position: relative;
      min-height: 232px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 34px 80px;
      border-bottom: 1px solid rgba(73, 127, 136, 0.22);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(242, 249, 247, 0.96)),
        #f7fbfa;
    }
    .hero::before,
    .hero::after {
      content: "";
      position: absolute;
      top: 44px;
      width: 190px;
      height: 118px;
      border: 4px solid rgba(59, 126, 145, 0.18);
      border-radius: 50%;
      transform: rotate(-18deg);
    }
    .hero::before { left: 60px; }
    .hero::after { right: 60px; transform: rotate(18deg); }
    .brand {
      display: flex;
      align-items: center;
      gap: 26px;
      position: relative;
      z-index: 1;
    }
    .seal {
      width: 96px;
      height: 96px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #ffffff;
      background: linear-gradient(145deg, #26809d, #17586e);
      box-shadow: 0 14px 32px rgba(23, 88, 110, 0.20);
    }
    .seal svg {
      width: 58px;
      height: 58px;
      stroke-width: 2.8;
    }
    h1 {
      margin: 0;
      color: #173b4a;
      font-size: 58px;
      line-height: 1.08;
      font-weight: 900;
      letter-spacing: 0;
    }
    .subtitle {
      margin-top: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      color: #4d5d66;
      font-size: 30px;
      line-height: 1.25;
      white-space: nowrap;
    }
    .subtitle strong {
      color: #1c6f8c;
      font-weight: 900;
    }
    .bubble {
      width: 44px;
      height: 36px;
      border: 3px solid #33414a;
      border-radius: 18px;
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      flex: 0 0 auto;
    }
    .bubble::after {
      content: "";
      position: absolute;
      left: 8px;
      bottom: -7px;
      width: 12px;
      height: 12px;
      border-left: 3px solid #33414a;
      border-bottom: 3px solid #33414a;
      background: #f7fbfa;
      transform: rotate(-18deg);
    }
    .bubble span {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: #33414a;
    }
    .menu-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
      padding: 28px;
    }
    .panel {
      min-height: 472px;
      overflow: hidden;
      border: 1px solid rgba(111, 147, 156, 0.34);
      border-radius: 16px;
      background: #ffffff;
      box-shadow: 0 12px 28px rgba(40, 80, 90, 0.08);
    }
    .panel-head {
      height: 78px;
      display: flex;
      align-items: center;
      gap: 18px;
      padding: 0 28px;
      border-bottom: 1px solid #e3ecef;
      background: linear-gradient(90deg, #f0f8fa, #ffffff);
    }
    .panel-head .icon {
      width: 48px;
      height: 48px;
      color: #1e7897;
      flex: 0 0 auto;
    }
    .panel-title {
      color: #173b4a;
      font-size: 36px;
      font-weight: 900;
    }
    .panel-body {
      display: grid;
      gap: 16px;
      padding: 22px;
    }
    .menu-item {
      min-height: 98px;
      display: grid;
      grid-template-columns: 66px minmax(0, 1fr) 24px;
      align-items: center;
      gap: 16px;
      padding: 16px 22px 16px 20px;
      border: 1px solid #dfe8eb;
      border-radius: 8px;
      background: linear-gradient(180deg, #ffffff, #fbfdfd);
      box-shadow: 0 8px 18px rgba(43, 78, 88, 0.05);
    }
    .item-icon {
      width: 52px;
      height: 52px;
      color: #1e7897;
      display: grid;
      place-items: center;
    }
    .menu-item.is-gold .item-icon { color: #c48a1d; }
    .item-icon svg {
      width: 52px;
      height: 52px;
      stroke-width: 2.7;
    }
    .item-title {
      min-width: 0;
      color: #172033;
      font-size: 32px;
      line-height: 1.16;
      font-weight: 900;
    }
    .item-title .param { color: #c48a1d; }
    .item-desc {
      margin-top: 7px;
      color: #6a7880;
      font-size: 19px;
      line-height: 1.22;
      font-weight: 700;
    }
    .chevron {
      width: 17px;
      height: 17px;
      border-right: 4px solid #78858a;
      border-bottom: 4px solid #78858a;
      transform: rotate(-45deg);
      justify-self: end;
    }
  </style>
</head>
<body>
  <main id="genshin-menu-card">
    <section class="sheet">
      <header class="hero">
        <div class="brand">
          <div class="seal">${renderIcon('spark')}</div>
          <div>
            <h1>${escapeHtml(view.title)}</h1>
            <div class="subtitle">${renderSubtitle(view.subtitle)}</div>
          </div>
        </div>
      </header>
      <section class="menu-grid">
        ${view.sections.map(renderMenuSection).join('')}
      </section>
    </section>
  </main>
</body>
</html>`;
}

function renderMenuSection(section: GenshinMenuSectionView): string {
  return `<section class="panel">
    <header class="panel-head">
      ${renderIcon(section.icon, 'icon')}
      <div class="panel-title">${escapeHtml(section.title)}</div>
    </header>
    <div class="panel-body">
      ${section.items.map(renderMenuItem).join('')}
    </div>
  </section>`;
}

function renderMenuItem(item: GenshinMenuItemView): string {
  const goldClass = item.accent === 'gold' ? ' is-gold' : '';
  return `<article class="menu-item${goldClass}">
    <div class="item-icon">${renderIcon(item.icon)}</div>
    <div>
      <div class="item-title">${renderKeyword(item.keyword)}</div>
      <div class="item-desc">${escapeHtml(item.description)}</div>
    </div>
    <div class="chevron" aria-hidden="true"></div>
  </article>`;
}

function renderSubtitle(subtitle: string): string {
  const keyword = '原神';
  const index = subtitle.indexOf(keyword);
  if (index < 0) return `<span class="bubble"><span></span><span></span><span></span></span>${escapeHtml(subtitle)}`;
  return `<span class="bubble"><span></span><span></span><span></span></span>${escapeHtml(subtitle.slice(0, index))}<strong>${escapeHtml(keyword)}</strong>${escapeHtml(subtitle.slice(index + keyword.length))}`;
}

function renderKeyword(keyword: string): string {
  return escapeHtml(keyword)
    .replace('&lt;确认码&gt;', '<span class="param">&lt;确认码&gt;</span>')
    .replace('&lt;兑换码&gt;', '<span class="param">&lt;兑换码&gt;</span>');
}

function renderIcon(icon: GenshinMenuIconName, className?: string): string {
  const attrs = className ? ` class="${className}"` : '';
  const common = `xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"`;
  const paths: Record<GenshinMenuIconName, string> = {
    check: '<circle cx="32" cy="32" r="25" fill="currentColor" stroke="none"/><path d="M20 33l8 8 17-20" stroke="#fff" stroke-width="6"/>',
    chart: '<path d="M12 52h40"/><rect x="16" y="30" width="8" height="16" rx="2"/><rect x="28" y="18" width="8" height="28" rx="2"/><rect x="40" y="24" width="8" height="22" rx="2"/><path d="M16 22l11-9 9 6 12-11"/>',
    gift: '<rect x="12" y="26" width="40" height="28" rx="4"/><path d="M32 26v28M12 36h40M22 26c-9-8-2-17 10 0M42 26c9-8 2-17-10 0"/>',
    'link-off': '<path d="M24 22l-5 5c-5 5-5 12 0 17s12 5 17 0l4-4"/><path d="M40 42l5-5c5-5 5-12 0-17s-12-5-17 0l-4 4"/><path d="M24 40l16-16M14 14l36 36"/>',
    moon: '<path d="M43 47c-15 5-29-9-24-24 3 8 11 14 20 14 5 0 9-1 13-4-1 6-4 11-9 14z"/>',
    'plus-shield': '<path d="M32 8l22 8v15c0 14-9 23-22 27-13-4-22-13-22-27V16z"/><path d="M32 22v22M21 33h22"/>',
    spark: '<path d="M32 6l5 18 18 8-18 8-5 18-5-18-18-8 18-8z"/><path d="M49 8l2 7 7 2-7 3-2 7-3-7-7-3 7-2z"/>',
    user: '<circle cx="32" cy="23" r="11"/><path d="M13 54c3-14 35-14 38 0"/>',
  };
  return `<svg${attrs} ${common}>${paths[icon]}</svg>`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
