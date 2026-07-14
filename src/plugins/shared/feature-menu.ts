import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { h, type Fragment } from 'koishi';

const MENU_WIDTH = 1440;

export interface FeatureMenuPuppeteerLike {
  page(): Promise<FeatureMenuPageLike>;
}

interface FeatureMenuPageLike {
  setViewport?(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<unknown>;
  goto(url: string, options?: unknown): Promise<unknown>;
  waitForSelector?(selector: string, options?: unknown): Promise<unknown>;
  $(selector: string): Promise<FeatureMenuElementLike | null>;
  screenshot(options?: unknown): Promise<Buffer | Uint8Array | string>;
  close(): Promise<unknown>;
}

interface FeatureMenuElementLike {
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
}

export type FeatureMenuIconName =
  | 'activity'
  | 'bell'
  | 'book'
  | 'chart'
  | 'check'
  | 'clipboard'
  | 'clock'
  | 'edit'
  | 'heart'
  | 'id-card'
  | 'link-off'
  | 'list'
  | 'play'
  | 'radar'
  | 'search'
  | 'shield'
  | 'stop'
  | 'tasks'
  | 'user';

export interface FeatureMenuItemView {
  keyword: string;
  description: string;
  icon: FeatureMenuIconName;
  accent?: boolean;
}

export interface FeatureMenuSectionView {
  title: string;
  icon: FeatureMenuIconName;
  items: FeatureMenuItemView[];
}

export interface FeatureMenuTheme {
  primary: string;
  deep: string;
  soft: string;
  glow: string;
  accent: string;
}

export interface FeatureMenuView {
  id: string;
  badge: string;
  title: string;
  subtitle: string;
  triggerKeyword: string;
  footer: string;
  columns: 2 | 3;
  theme: FeatureMenuTheme;
  sections: FeatureMenuSectionView[];
}

export async function buildFeatureMenuReply(
  puppeteer: FeatureMenuPuppeteerLike,
  qqUserId: string,
  view: FeatureMenuView,
): Promise<Fragment> {
  return [h.at(qqUserId), h.text('\n'), await renderFeatureMenuImage(puppeteer, view)];
}

export async function renderFeatureMenuImage(
  puppeteer: FeatureMenuPuppeteerLike,
  view: FeatureMenuView,
): Promise<ReturnType<typeof h.image>> {
  const page = await puppeteer.page();
  let tempDir: string | null = null;
  try {
    const safeId = view.id.replace(/[^a-z0-9-]/giu, '') || 'feature';
    tempDir = await mkdtemp(join(tmpdir(), `qqbot-${safeId}-menu-`));
    const htmlPath = join(tempDir, 'menu.html');
    await writeFile(htmlPath, renderFeatureMenuHtml(view), 'utf8');
    await page.setViewport?.({ width: MENU_WIDTH, height: 1600, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
    await page.waitForSelector?.('#feature-menu-card', { timeout: 5000 });
    const card = await page.$('#feature-menu-card');
    if (!card) throw new Error(`${view.id} menu root not found`);
    const box = await card.boundingBox();
    if (!box) throw new Error(`${view.id} menu root has no bounding box`);
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

export function renderFeatureMenuHtml(view: FeatureMenuView): string {
  const columns = view.columns === 3 ? 3 : 2;
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
      color: #17212b;
      background: ${view.theme.soft};
      font-family: "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif;
    }
    #feature-menu-card {
      width: ${MENU_WIDTH}px;
      padding: 36px;
      background:
        radial-gradient(circle at 8% 6%, ${view.theme.glow}, transparent 30%),
        radial-gradient(circle at 92% 12%, color-mix(in srgb, ${view.theme.accent} 18%, transparent), transparent 30%),
        ${view.theme.soft};
    }
    .sheet {
      overflow: hidden;
      border: 2px solid color-mix(in srgb, ${view.theme.primary} 34%, white);
      border-radius: 28px;
      background: rgba(255,255,255,0.96);
      box-shadow: 0 24px 58px color-mix(in srgb, ${view.theme.deep} 16%, transparent);
    }
    .hero {
      position: relative;
      min-height: 236px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 38px 90px;
      overflow: hidden;
      border-bottom: 1px solid color-mix(in srgb, ${view.theme.primary} 22%, white);
      background: linear-gradient(180deg, #ffffff, color-mix(in srgb, ${view.theme.soft} 72%, white));
    }
    .hero::before, .hero::after {
      content: "";
      position: absolute;
      width: 260px;
      height: 260px;
      border: 5px solid color-mix(in srgb, ${view.theme.primary} 13%, transparent);
      border-radius: 50%;
    }
    .hero::before { left: -72px; top: -96px; }
    .hero::after { right: -62px; bottom: -118px; }
    .brand {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 28px;
    }
    .seal {
      width: 104px;
      height: 104px;
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      border-radius: 28px;
      color: #ffffff;
      background: linear-gradient(145deg, ${view.theme.primary}, ${view.theme.deep});
      box-shadow: 0 15px 32px color-mix(in srgb, ${view.theme.deep} 24%, transparent);
      font-size: 48px;
      line-height: 1;
      font-weight: 900;
    }
    h1 {
      margin: 0;
      color: ${view.theme.deep};
      font-size: 62px;
      line-height: 1.08;
      font-weight: 900;
      letter-spacing: 1px;
    }
    .subtitle {
      margin-top: 17px;
      display: flex;
      align-items: center;
      gap: 14px;
      color: #52606b;
      font-size: 30px;
      line-height: 1.3;
    }
    .subtitle strong { color: ${view.theme.primary}; font-weight: 900; }
    .bubble {
      width: 45px;
      height: 36px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      position: relative;
      flex: 0 0 auto;
      border: 3px solid #42505a;
      border-radius: 18px;
    }
    .bubble::after {
      content: "";
      position: absolute;
      left: 8px;
      bottom: -7px;
      width: 12px;
      height: 12px;
      border-left: 3px solid #42505a;
      border-bottom: 3px solid #42505a;
      background: color-mix(in srgb, ${view.theme.soft} 72%, white);
      transform: rotate(-18deg);
    }
    .bubble span { width: 4px; height: 4px; border-radius: 50%; background: #42505a; }
    .menu-grid {
      display: grid;
      grid-template-columns: repeat(${columns}, minmax(0, 1fr));
      align-items: stretch;
      gap: 24px;
      padding: 28px;
      background: linear-gradient(180deg, #ffffff, color-mix(in srgb, ${view.theme.soft} 44%, white));
    }
    .panel {
      overflow: hidden;
      border: 1px solid color-mix(in srgb, ${view.theme.primary} 25%, #dce4e8);
      border-radius: 18px;
      background: #ffffff;
      box-shadow: 0 11px 26px color-mix(in srgb, ${view.theme.deep} 8%, transparent);
    }
    .panel-head {
      min-height: 82px;
      display: flex;
      align-items: center;
      gap: 17px;
      padding: 14px 26px;
      border-bottom: 1px solid color-mix(in srgb, ${view.theme.primary} 16%, #e5eaed);
      background: linear-gradient(90deg, color-mix(in srgb, ${view.theme.soft} 82%, white), #ffffff);
    }
    .panel-head .icon { width: 46px; height: 46px; color: ${view.theme.primary}; flex: 0 0 auto; }
    .panel-title { color: ${view.theme.deep}; font-size: 34px; font-weight: 900; }
    .panel-body { display: grid; gap: 14px; padding: 20px; }
    .menu-item {
      min-height: 96px;
      display: grid;
      grid-template-columns: 58px minmax(0, 1fr) 18px;
      align-items: center;
      gap: 15px;
      padding: 15px 18px;
      border: 1px solid #e0e7ea;
      border-radius: 12px;
      background: linear-gradient(180deg, #ffffff, #fbfcfd);
    }
    .menu-item.is-accent {
      border-color: color-mix(in srgb, ${view.theme.accent} 56%, white);
      background: linear-gradient(135deg, color-mix(in srgb, ${view.theme.accent} 10%, white), #ffffff 72%);
    }
    .item-icon {
      width: 52px;
      height: 52px;
      display: grid;
      place-items: center;
      color: ${view.theme.primary};
      border-radius: 14px;
      background: color-mix(in srgb, ${view.theme.primary} 9%, white);
    }
    .item-icon svg { width: 38px; height: 38px; }
    .item-title { color: #172733; font-size: 25px; line-height: 1.25; font-weight: 900; }
    .item-desc { margin-top: 6px; color: #66727b; font-size: 19px; line-height: 1.38; }
    .param { color: ${view.theme.primary}; font-weight: 900; white-space: nowrap; }
    .chevron {
      width: 13px;
      height: 13px;
      border-top: 3px solid color-mix(in srgb, ${view.theme.primary} 54%, #8c979d);
      border-right: 3px solid color-mix(in srgb, ${view.theme.primary} 54%, #8c979d);
      transform: rotate(45deg);
    }
    .footer {
      padding: 18px 28px 22px;
      color: #738087;
      background: color-mix(in srgb, ${view.theme.soft} 58%, white);
      border-top: 1px solid color-mix(in srgb, ${view.theme.primary} 15%, #e5eaed);
      text-align: center;
      font-size: 20px;
      letter-spacing: 1px;
    }
    svg { fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 3; }
  </style>
</head>
<body>
  <main id="feature-menu-card" data-feature="${escapeHtml(view.id)}">
    <section class="sheet">
      <header class="hero">
        <div class="brand">
          <div class="seal">${escapeHtml(view.badge)}</div>
          <div>
            <h1>${escapeHtml(view.title)}</h1>
            <div class="subtitle">${renderSubtitle(view.subtitle, view.triggerKeyword)}</div>
          </div>
        </div>
      </header>
      <section class="menu-grid">
        ${view.sections.map(renderSection).join('')}
      </section>
      <footer class="footer">${escapeHtml(view.footer)}</footer>
    </section>
  </main>
</body>
</html>`;
}

function renderSection(section: FeatureMenuSectionView): string {
  return `<section class="panel">
    <header class="panel-head">
      ${renderIcon(section.icon, 'icon')}
      <div class="panel-title">${escapeHtml(section.title)}</div>
    </header>
    <div class="panel-body">${section.items.map(renderItem).join('')}</div>
  </section>`;
}

function renderItem(item: FeatureMenuItemView): string {
  return `<article class="menu-item${item.accent ? ' is-accent' : ''}">
    <div class="item-icon">${renderIcon(item.icon)}</div>
    <div>
      <div class="item-title">${renderKeyword(item.keyword)}</div>
      <div class="item-desc">${escapeHtml(item.description)}</div>
    </div>
    <div class="chevron" aria-hidden="true"></div>
  </article>`;
}

function renderSubtitle(subtitle: string, keyword: string): string {
  const escaped = escapeHtml(subtitle);
  const escapedKeyword = escapeHtml(keyword);
  const index = escaped.indexOf(escapedKeyword);
  const bubble = '<span class="bubble"><span></span><span></span><span></span></span>';
  if (index < 0) return `${bubble}${escaped}`;
  return `${bubble}${escaped.slice(0, index)}<strong>${escapedKeyword}</strong>${escaped.slice(index + escapedKeyword.length)}`;
}

function renderKeyword(keyword: string): string {
  return escapeHtml(keyword).replace(/(&lt;.*?&gt;|\[[^\]]+\])/gu, '<span class="param">$1</span>');
}

function renderIcon(icon: FeatureMenuIconName, className?: string): string {
  const attrs = className ? ` class="${className}"` : '';
  const paths: Record<FeatureMenuIconName, string> = {
    activity: '<path d="M10 35h11l6-17 10 30 7-18h10"/><circle cx="32" cy="32" r="26"/>',
    bell: '<path d="M17 45h30l-5-7V27c0-7-4-12-10-12s-10 5-10 12v11zM27 51c2 5 8 5 10 0"/>',
    book: '<path d="M10 14h18c5 0 7 4 7 8v34c0-5-3-8-8-8H10zM54 14H36c-1 0-1 0-1 1v41c0-5 3-8 8-8h11z"/>',
    chart: '<path d="M12 52h40M17 47V31h9v16M28 47V19h9v28M39 47V25h9v22"/>',
    check: '<circle cx="32" cy="32" r="25" fill="currentColor" stroke="none"/><path d="M20 33l8 8 17-20" stroke="#fff" stroke-width="6"/>',
    clipboard: '<rect x="16" y="12" width="32" height="44" rx="5"/><path d="M25 12c1-5 13-5 14 0v7H25zM24 29h16M24 39h16M24 49h10"/>',
    clock: '<circle cx="32" cy="32" r="25"/><path d="M32 18v15l10 7"/>',
    edit: '<path d="M14 48l3-12L43 10l11 11-26 26zM38 15l11 11M13 53h40"/>',
    heart: '<path d="M32 53S9 41 9 23c0-12 16-17 23-5 7-12 23-7 23 5 0 18-23 30-23 30z"/>',
    'id-card': '<rect x="10" y="18" width="44" height="30" rx="4"/><circle cx="24" cy="31" r="5"/><path d="M16 42c2-5 14-5 16 0M37 29h10M37 37h10"/>',
    'link-off': '<path d="M24 22l-5 5c-5 5-5 12 0 17s12 5 17 0l4-4M40 42l5-5c5-5 5-12 0-17s-12-5-17 0l-4 4M24 40l16-16M14 14l36 36"/>',
    list: '<rect x="16" y="10" width="32" height="44" rx="5"/><path d="M24 23h16M24 32h16M24 41h16"/>',
    play: '<circle cx="32" cy="32" r="25"/><path d="M27 21l17 11-17 11z" fill="currentColor" stroke="none"/>',
    radar: '<circle cx="32" cy="32" r="24"/><circle cx="32" cy="32" r="15"/><path d="M32 8v48M8 32h48M32 32l17-14"/>',
    search: '<circle cx="27" cy="27" r="16"/><path d="M39 39l13 13"/>',
    shield: '<path d="M32 7l22 8v16c0 14-9 23-22 27-13-4-22-13-22-27V15zM32 21v22M21 32h22"/>',
    stop: '<circle cx="32" cy="32" r="25"/><rect x="23" y="23" width="18" height="18" rx="2" fill="currentColor" stroke="none"/>',
    tasks: '<rect x="13" y="11" width="38" height="44" rx="5"/><path d="M21 25l4 4 7-8M36 25h8M21 40l4 4 7-8M36 40h8"/>',
    user: '<circle cx="32" cy="22" r="11"/><path d="M13 55c3-15 35-15 38 0"/>',
  };
  return `<svg${attrs} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${paths[icon]}</svg>`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
