import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { h, type Fragment } from 'koishi';

const MENU_WIDTH = 1494;

export interface HbuJwMenuPuppeteerLike {
  page(): Promise<HbuJwMenuPageLike>;
}

interface HbuJwMenuPageLike {
  setViewport?(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<unknown>;
  goto(url: string, options?: unknown): Promise<unknown>;
  waitForSelector?(selector: string, options?: unknown): Promise<unknown>;
  $(selector: string): Promise<HbuJwMenuElementLike | null>;
  screenshot(options?: unknown): Promise<Buffer | Uint8Array | string>;
  close(): Promise<unknown>;
}

interface HbuJwMenuElementLike {
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
}

export interface HbuJwMenuItemView {
  keyword: string;
  description: string;
  icon: HbuJwMenuIconName;
  accent?: 'gold';
}

export interface HbuJwMenuSectionView {
  title: '账号' | '查询';
  icon: HbuJwMenuIconName;
  items: HbuJwMenuItemView[];
}

export interface HbuJwMenuView {
  title: string;
  subtitle: string;
  sections: HbuJwMenuSectionView[];
}

type HbuJwMenuIconName =
  | 'calendar'
  | 'chart'
  | 'check'
  | 'clipboard'
  | 'grid'
  | 'id-card'
  | 'link-off'
  | 'list'
  | 'plus-shield'
  | 'search'
  | 'user';

const MENU_SECTIONS: HbuJwMenuSectionView[] = [
  {
    title: '账号',
    icon: 'user',
    items: [
      { keyword: '教务绑定', description: '绑定教务账号', icon: 'plus-shield' },
      { keyword: '教务确认 <确认码>', description: '网页登录成功后确认绑定', icon: 'check', accent: 'gold' },
      { keyword: '教务状态', description: '检查当前绑定状态', icon: 'id-card' },
      { keyword: '教务解绑', description: '解除教务账号与QQ的绑定，相关加密数据也会清除', icon: 'link-off' },
    ],
  },
  {
    title: '查询',
    icon: 'search',
    items: [
      { keyword: 'GPA', description: '计算推免相关GPA，排除艺术类等必修课程', icon: 'chart' },
      { keyword: '成绩 [index]', description: '省略 index 查本学期；0 查入学首学期，依次递增', icon: 'list' },
      { keyword: '成绩 <课程名>', description: '从全部及格成绩中查看本人某门课程详情', icon: 'search' },
      { keyword: '匿名成绩', description: '查看本学期成绩，但不显示敏感数据，可查是否出分', icon: 'list' },
      { keyword: '课程查询', description: '查看指定课程的分项成绩接口返回', icon: 'search' },
      { keyword: '选课结果', description: '查看本学期课程、学分与选课状态', icon: 'check' },
      { keyword: '课表', description: '查看这周的课表', icon: 'calendar' },
      { keyword: '完整课表', description: '查看本学期动态课表', icon: 'grid' },
      { keyword: '考试安排', description: '查看本学期的考试安排', icon: 'clipboard' },
    ],
  },
];

export class HbuJwMenuService {
  constructor(private readonly puppeteer: HbuJwMenuPuppeteerLike) {}

  async queryMenu(qqUserId: string): Promise<Fragment> {
    return [h.at(qqUserId), h.text('\n'), await renderHbuJwMenuImage(this.puppeteer, buildHbuJwMenuView())];
  }
}

export function buildHbuJwMenuView(): HbuJwMenuView {
  return {
    title: '教务功能菜单',
    subtitle: '发送 教务 查看本菜单',
    sections: MENU_SECTIONS,
  };
}

export async function renderHbuJwMenuImage(
  puppeteer: HbuJwMenuPuppeteerLike,
  view: HbuJwMenuView,
): Promise<ReturnType<typeof h.image>> {
  const page = await puppeteer.page();
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'qqbot-hbu-jw-menu-'));
    const htmlPath = join(tempDir, 'menu.html');
    await writeFile(htmlPath, renderHbuJwMenuHtml(view), 'utf8');
    await page.setViewport?.({ width: MENU_WIDTH, height: 1080, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
    await page.waitForSelector?.('#hbu-jw-menu-card', { timeout: 5000 });
    const card = await page.$('#hbu-jw-menu-card');
    if (!card) throw new Error('hbu jw menu root not found');
    const box = await card.boundingBox();
    if (!box) throw new Error('hbu jw menu root has no bounding box');
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

export function renderHbuJwMenuHtml(view: HbuJwMenuView): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(view.title)}</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      width: ${MENU_WIDTH}px;
      overflow: hidden;
    }
    body {
      margin: 0;
      background: #f5faf6;
      color: #101923;
      font-family: "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif;
    }
    #hbu-jw-menu-card {
      width: ${MENU_WIDTH}px;
      margin: 0;
      padding: 33px 37px 34px;
      background:
        radial-gradient(circle at 10% 8%, rgba(42, 126, 83, 0.10), transparent 30%),
        radial-gradient(circle at 90% 18%, rgba(42, 126, 83, 0.08), transparent 28%),
        linear-gradient(180deg, #fbfdfb, #eef7f0);
    }
    .sheet {
      position: relative;
      overflow: hidden;
      min-height: 985px;
      border: 2px solid #9ec8ad;
      border-radius: 28px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.94), rgba(250,253,250,0.98)),
        #ffffff;
      box-shadow: 0 22px 50px rgba(32, 92, 62, 0.13);
    }
    .hero {
      position: relative;
      min-height: 246px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 38px 330px 28px;
      border-bottom: 1px solid rgba(121, 166, 137, 0.36);
      background: linear-gradient(180deg, #ffffff 0%, #f9fcfa 66%, #eef7f1 100%);
    }
    .brand {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 28px;
      min-width: 0;
      position: relative;
      z-index: 2;
    }
    .seal {
      width: 96px;
      height: 96px;
      border: 4px solid #09663d;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #09663d;
      background: #ffffff;
      font-size: 28px;
      font-weight: 900;
      flex: 0 0 auto;
      box-shadow: 0 12px 24px rgba(24, 94, 58, 0.10);
    }
    h1 {
      margin: 0;
      color: #065f3c;
      font-size: 64px;
      line-height: 1.12;
      font-weight: 900;
      letter-spacing: 0;
      text-shadow: 0 3px 0 rgba(6, 77, 49, 0.10);
    }
    .subtitle {
      margin-top: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      color: #37413d;
      font-size: 32px;
      line-height: 1.25;
      white-space: nowrap;
    }
    .subtitle strong {
      color: #07653f;
      font-weight: 900;
    }
    .bubble {
      width: 44px;
      height: 36px;
      border: 3px solid #2e3534;
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
      border-left: 3px solid #2e3534;
      border-bottom: 3px solid #2e3534;
      background: #f9fcfa;
      transform: rotate(-18deg);
    }
    .bubble span {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: #2e3534;
    }
    .campus {
      position: absolute;
      bottom: 0;
      width: 360px;
      height: 174px;
      opacity: 0.34;
      pointer-events: none;
    }
    .campus-left { left: 24px; }
    .campus-right { right: 28px; }
    .campus .ground {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, #5a9670 12%, #5a9670 88%, transparent);
    }
    .campus-left .tower {
      position: absolute;
      left: 145px;
      bottom: 28px;
      width: 38px;
      height: 112px;
      border: 3px solid #4f9169;
      border-bottom: 0;
      background: linear-gradient(90deg, transparent 31%, rgba(79,145,105,0.24) 32%, rgba(79,145,105,0.24) 38%, transparent 39%, transparent 61%, rgba(79,145,105,0.24) 62%, rgba(79,145,105,0.24) 68%, transparent 69%);
    }
    .campus-left .tower::before {
      content: "";
      position: absolute;
      left: 50%;
      top: -24px;
      width: 60px;
      height: 20px;
      border: 3px solid #4f9169;
      border-bottom: 0;
      border-radius: 50% 50% 0 0;
      transform: translateX(-50%);
      background: rgba(79,145,105,0.10);
    }
    .campus-left .tower::after {
      content: "";
      position: absolute;
      left: 50%;
      top: -48px;
      width: 3px;
      height: 28px;
      background: #4f9169;
      transform: translateX(-50%);
    }
    .campus-left .building {
      position: absolute;
      left: 190px;
      bottom: 26px;
      width: 98px;
      height: 58px;
      border: 3px solid #4f9169;
      border-bottom: 0;
      background: repeating-linear-gradient(90deg, rgba(79,145,105,0.15) 0 8px, transparent 8px 20px);
    }
    .tree {
      position: absolute;
      bottom: 22px;
      width: 58px;
      height: 58px;
      border-radius: 50%;
      background: rgba(79,145,105,0.35);
      box-shadow:
        24px -10px 0 rgba(79,145,105,0.24),
        45px 4px 0 rgba(79,145,105,0.20);
    }
    .tree::after {
      content: "";
      position: absolute;
      left: 26px;
      bottom: -24px;
      width: 6px;
      height: 40px;
      background: rgba(79,145,105,0.45);
    }
    .campus-left .tree-a { left: 24px; }
    .campus-left .tree-b { left: 68px; transform: scale(0.78); }
    .campus-right .gate {
      position: absolute;
      right: 38px;
      bottom: 25px;
      width: 198px;
      height: 96px;
      border: 4px solid #4f9169;
      border-bottom: 0;
      border-radius: 34px 34px 0 0;
    }
    .campus-right .gate::before {
      content: "河北大学";
      position: absolute;
      top: -29px;
      left: 34px;
      width: 124px;
      height: 32px;
      border: 3px solid #4f9169;
      display: grid;
      place-items: center;
      color: #4f9169;
      font-size: 17px;
      font-weight: 900;
      background: rgba(255,255,255,0.60);
    }
    .campus-right .gate::after {
      content: "";
      position: absolute;
      left: 72px;
      bottom: 0;
      width: 50px;
      height: 64px;
      border: 4px solid #4f9169;
      border-bottom: 0;
      border-radius: 28px 28px 0 0;
    }
    .campus-right .side {
      position: absolute;
      bottom: 25px;
      width: 58px;
      height: 66px;
      border: 3px solid #4f9169;
      border-bottom: 0;
      background: rgba(79,145,105,0.10);
    }
    .campus-right .side-left { right: 245px; }
    .campus-right .side-right { right: 14px; }
    .campus-right .tree-a { right: 272px; transform: scale(0.76); }
    .campus-right .tree-b { right: 0; transform: scale(0.66); }
    .menu-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 26px;
      padding: 28px 30px 34px;
    }
    .panel {
      min-height: 642px;
      overflow: hidden;
      border: 1px solid #d4e7dc;
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.86);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.60), 0 12px 24px rgba(22, 88, 55, 0.07);
    }
    .panel-head {
      height: 78px;
      display: flex;
      align-items: center;
      gap: 20px;
      padding: 0 32px;
      border-bottom: 1px solid #e0eee6;
      background: linear-gradient(90deg, #f4fbf6, #ffffff);
    }
    .panel-head .icon {
      width: 50px;
      height: 50px;
      color: #087247;
      flex: 0 0 auto;
    }
    .panel-title {
      color: #075f3c;
      font-size: 38px;
      font-weight: 900;
    }
    .panel-body {
      display: grid;
      gap: 16px;
      padding: 22px 24px 24px;
    }
    .menu-item {
      min-height: 96px;
      display: grid;
      grid-template-columns: 72px minmax(0, 1fr) 28px;
      align-items: center;
      gap: 18px;
      padding: 16px 24px 16px 22px;
      border: 1px solid #dbe5df;
      border-radius: 8px;
      background: linear-gradient(180deg, #ffffff, #fcfefd);
      box-shadow: 0 7px 16px rgba(23, 70, 45, 0.05);
    }
    .item-icon {
      width: 54px;
      height: 54px;
      color: #087247;
      display: grid;
      place-items: center;
    }
    .menu-item.is-gold .item-icon { color: #d49400; }
    .item-icon svg {
      width: 54px;
      height: 54px;
      stroke-width: 2.7;
    }
    .item-title {
      min-width: 0;
      color: #111827;
      font-size: 34px;
      line-height: 1.18;
      font-weight: 900;
    }
    .item-title .param {
      color: #d28c00;
    }
    .item-desc {
      margin-top: 7px;
      color: #717d78;
      font-size: 19px;
      line-height: 1.2;
      font-weight: 700;
    }
    .chevron {
      width: 18px;
      height: 18px;
      border-right: 4px solid #777f80;
      border-bottom: 4px solid #777f80;
      transform: rotate(-45deg);
      justify-self: end;
    }
  </style>
</head>
<body>
  <main id="hbu-jw-menu-card">
    <section class="sheet">
      <header class="hero">
        <div class="campus campus-left" aria-hidden="true">
          <div class="tree tree-a"></div>
          <div class="tree tree-b"></div>
          <div class="tower"></div>
          <div class="building"></div>
          <div class="ground"></div>
        </div>
        <div class="brand">
          <div class="seal">HBU</div>
          <div>
            <h1>${escapeHtml(view.title)}</h1>
            <div class="subtitle">${renderSubtitle(view.subtitle)}</div>
          </div>
        </div>
        <div class="campus campus-right" aria-hidden="true">
          <div class="tree tree-a"></div>
          <div class="tree tree-b"></div>
          <div class="side side-left"></div>
          <div class="gate"></div>
          <div class="side side-right"></div>
          <div class="ground"></div>
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

function renderMenuSection(section: HbuJwMenuSectionView): string {
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

function renderMenuItem(item: HbuJwMenuItemView): string {
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
  const keyword = '教务';
  const index = subtitle.indexOf(keyword);
  if (index < 0) return `<span class="bubble"><span></span><span></span><span></span></span>${escapeHtml(subtitle)}`;
  return `<span class="bubble"><span></span><span></span><span></span></span>${escapeHtml(subtitle.slice(0, index))}<strong>${escapeHtml(keyword)}</strong>${escapeHtml(subtitle.slice(index + keyword.length))}`;
}

function renderKeyword(keyword: string): string {
  return escapeHtml(keyword).replace(
    /&lt;([^&]+)&gt;/g,
    '<span class="param">&lt;$1&gt;</span>',
  );
}

function renderIcon(icon: HbuJwMenuIconName, className?: string): string {
  const attrs = className ? ` class="${className}"` : '';
  const common = `xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"`;
  const paths: Record<HbuJwMenuIconName, string> = {
    calendar: '<rect x="12" y="16" width="40" height="38" rx="5"/><path d="M22 10v10M42 10v10M12 28h40M23 38h3M31 38h3M39 38h3M23 46h3M31 46h3M39 46h3"/>',
    chart: '<path d="M13 51h39"/><path d="M17 48V16"/><path d="M22 42l10-10 8 6 13-16"/><path d="M45 22h8v8"/>',
    check: '<circle cx="32" cy="32" r="25" fill="currentColor" stroke="none"/><path d="M20 33l8 8 17-20" stroke="#fff" stroke-width="6"/>',
    clipboard: '<rect x="16" y="12" width="32" height="44" rx="5"/><path d="M25 12c1-5 13-5 14 0v7H25zM24 29h16M24 39h16M24 49h10"/>',
    grid: '<rect x="13" y="13" width="38" height="38" rx="4"/><path d="M13 26h38M13 39h38M26 13v38M39 13v38"/>',
    'id-card': '<rect x="10" y="18" width="44" height="30" rx="4"/><circle cx="24" cy="32" r="5"/><path d="M16 42c2-5 14-5 16 0M36 29h10M36 37h10"/>',
    'link-off': '<path d="M24 22l-5 5c-5 5-5 12 0 17s12 5 17 0l4-4"/><path d="M40 42l5-5c5-5 5-12 0-17s-12-5-17 0l-4 4"/><path d="M24 40l16-16M14 14l36 36"/>',
    list: '<rect x="17" y="11" width="30" height="42" rx="4"/><path d="M25 23h14M25 32h14M25 41h14"/>',
    'plus-shield': '<path d="M32 8l22 8v15c0 14-9 23-22 27-13-4-22-13-22-27V16z"/><path d="M32 22v22M21 33h22"/>',
    search: '<circle cx="27" cy="27" r="16"/><path d="M39 39l13 13"/>',
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
