import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => ({
  h: {
    text: (content: string) => ({
      type: 'text',
      attrs: { content },
      children: [],
      toString: () => content,
    }),
    at: (id: string) => ({
      type: 'at',
      attrs: { id },
      children: [],
      toString: () => `<at id="${id}"/>`,
    }),
    image: (_source: Buffer | string, mime?: string) => ({
      type: 'image',
      attrs: { mime },
      children: [],
      toString: () => `[image:${mime ?? 'unknown'}]`,
    }),
  },
}));

import {
  buildChaoxingMenuView,
  ChaoxingMenuService,
  renderChaoxingMenuImage,
} from '../src/plugins/chaoxing/menu.js';
import {
  apply as applyFeatureMenu,
  isFeatureMenuCommandText,
} from '../src/plugins/feature-menu/index.js';
import {
  buildFeatureIndexMenuView,
  FeatureIndexMenuService,
  renderFeatureIndexMenuImage,
} from '../src/plugins/feature-menu/menu.js';
import {
  buildHbuSecondClassMenuView,
  HbuSecondClassMenuService,
  renderHbuSecondClassMenuImage,
} from '../src/plugins/hbu-second-class/menu.js';
import {
  buildZyhMenuView,
  renderZyhMenuImage,
  ZyhMenuService,
} from '../src/plugins/zyh/menu.js';

describe('campus feature HTML menus', () => {
  it('lists every top-level feature keyword in the feature index', () => {
    expect(keywords(buildFeatureIndexMenuView())).toEqual([
      '教务',
      '学习通',
      '志愿汇',
      '二课',
      '原神',
      '好感',
    ]);
  });

  it('lists every public entry point in the corresponding menu', () => {
    expect(keywords(buildZyhMenuView())).toEqual(expect.arrayContaining([
      '志愿汇绑定',
      '志愿汇确认 <确认码>',
      '志愿汇状态',
      '志愿汇解绑',
      '志愿时长',
      '志愿记录 [页码]',
      '志愿活动 [关键词]',
      '我的志愿活动 [页码]',
    ]));
    expect(keywords(buildHbuSecondClassMenuView())).toEqual(expect.arrayContaining([
      '二课绑定',
      '二课确认 <确认码>',
      '二课状态',
      '二课验证 [验证码]',
      '二课解绑',
      '二课学分',
      '二课成绩单 [学期]',
      '二课雷达',
      '二课活动',
      '二课记录',
    ]));
    expect(keywords(buildChaoxingMenuView())).toEqual(expect.arrayContaining([
      '学习通绑定',
      '学习通课程',
      '学习通待办',
      '学习通签到监听 [课程]',
      '学习通刷课 <课程>',
      '学习通答题 <课程>',
      '学习通任务状态',
      '学习通错题',
    ]));
  });

  it.each([
    ['功能', buildFeatureIndexMenuView(), renderFeatureIndexMenuImage],
    ['志愿汇', buildZyhMenuView(), renderZyhMenuImage],
    ['二课', buildHbuSecondClassMenuView(), renderHbuSecondClassMenuImage],
    ['学习通', buildChaoxingMenuView(), renderChaoxingMenuImage],
  ] as const)('renders the %s menu as a cropped PNG', async (keyword, view, render) => {
    const harness = createPuppeteerHarness();

    const image = await render(harness.puppeteer, view);

    expect(String(image)).toContain('image/png');
    expect(harness.getNavigatedHtml()).toContain(view.title);
    expect(harness.getNavigatedHtml()).toContain(`发送 <strong>${keyword}</strong> 查看本菜单`);
    expect(harness.getNavigatedHtml()).toContain('id="feature-menu-card"');
    expect(harness.page.screenshot).toHaveBeenCalledWith(expect.objectContaining({
      type: 'png',
      clip: { x: 0, y: 0, width: 1440, height: 1100 },
    }));
    expect(harness.page.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['功能', new FeatureIndexMenuService(createPuppeteerHarness().puppeteer)],
    ['志愿汇', new ZyhMenuService(createPuppeteerHarness().puppeteer)],
    ['二课', new HbuSecondClassMenuService(createPuppeteerHarness().puppeteer)],
    ['学习通', new ChaoxingMenuService(createPuppeteerHarness().puppeteer)],
  ] as const)('returns an @ mention with the %s menu image', async (_keyword, service) => {
    const reply = await service.queryMenu('1405359129');

    expect(extractAtIds(reply)).toEqual(['1405359129']);
    expect(renderMessageContent(reply)).toContain('image/png');
  });
});

describe('top-level feature menu keyword', () => {
  it('matches only the exact 功能 keyword after trimming', () => {
    expect(isFeatureMenuCommandText(' 功能 ')).toBe(true);
    expect(isFeatureMenuCommandText('功能介绍')).toBe(false);
    expect(isFeatureMenuCommandText('有什么功能')).toBe(false);
  });

  it('returns the menu for an exact bare group keyword', async () => {
    const renderHarness = createPuppeteerHarness();
    const sendReply = vi.fn(async (_session: unknown, _input: { reply: unknown }) => null);
    let middleware: ((session: any, next: () => Promise<unknown>) => Promise<unknown>) | undefined;
    const ctx = {
      puppeteer: renderHarness.puppeteer,
      nativeFeatureChat: { sendReply },
      middleware: vi.fn((handler) => {
        middleware = handler;
      }),
    };
    applyFeatureMenu(ctx as never);
    const next = vi.fn(async () => undefined);
    const session = {
      userId: '1405359129',
      isDirect: false,
      guildId: '829573670',
      channelId: '829573670',
      content: '功能',
      stripped: { content: '功能', atSelf: false },
    };

    await middleware!(session, next);

    expect(next).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledWith(session, expect.objectContaining({
      featureId: 'feature-menu',
      commandId: 'menu',
      userText: '功能',
      summary: '机器人返回了顶级功能菜单图片。',
      success: true,
      includeReplyPayload: true,
    }));
    const input = sendReply.mock.calls[0]?.[1];
    expect(extractAtIds(input?.reply)).toEqual(['1405359129']);
    expect(renderMessageContent(input?.reply)).toContain('image/png');
  });

  it('passes non-matching messages to later middleware', async () => {
    const renderHarness = createPuppeteerHarness();
    const sendReply = vi.fn(async (_session: unknown, _input: { reply: unknown }) => null);
    let middleware: ((session: any, next: () => Promise<unknown>) => Promise<unknown>) | undefined;
    const ctx = {
      puppeteer: renderHarness.puppeteer,
      nativeFeatureChat: { sendReply },
      middleware: vi.fn((handler) => {
        middleware = handler;
      }),
    };
    applyFeatureMenu(ctx as never);
    const next = vi.fn(async () => 'next-result');

    await expect(middleware!({
      userId: '1405359129',
      content: '功能介绍',
      stripped: { content: '功能介绍' },
    }, next)).resolves.toBe('next-result');

    expect(next).toHaveBeenCalledOnce();
    expect(sendReply).not.toHaveBeenCalled();
    expect(renderHarness.page.screenshot).not.toHaveBeenCalled();
  });
});

function keywords(view: ReturnType<typeof buildZyhMenuView>): string[] {
  return view.sections.flatMap((section) => section.items.map((item) => item.keyword));
}

function createPuppeteerHarness() {
  let navigatedHtml = '';
  const element = {
    boundingBox: vi.fn(async () => ({ x: 0, y: 0, width: 1440, height: 1100 })),
  };
  const page = {
    setViewport: vi.fn(async () => undefined),
    goto: vi.fn(async (url: string) => {
      navigatedHtml = await readFile(fileURLToPath(url), 'utf8');
    }),
    waitForSelector: vi.fn(async () => undefined),
    $: vi.fn(async () => element),
    screenshot: vi.fn(async () => Buffer.from('png')),
    close: vi.fn(async () => undefined),
  };
  return {
    page,
    puppeteer: { page: vi.fn(async () => page) },
    getNavigatedHtml: () => navigatedHtml,
  };
}

function renderMessageContent(content: unknown): string {
  if (Array.isArray(content)) return content.map((part) => String(part)).join('');
  return String(content ?? '');
}

function extractAtIds(content: unknown): string[] {
  const elements = Array.isArray(content) ? content : [content];
  return elements
    .filter((element): element is { type: string; attrs?: { id?: unknown } } =>
      Boolean(element && typeof element === 'object' && (element as { type?: unknown }).type === 'at'))
    .map((element) => String(element.attrs?.id ?? ''));
}
