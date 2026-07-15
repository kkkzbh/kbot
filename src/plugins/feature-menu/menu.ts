import type { Fragment } from 'koishi';
import {
  buildFeatureMenuReply,
  renderFeatureMenuHtml,
  renderFeatureMenuImage,
  type FeatureMenuPuppeteerLike,
  type FeatureMenuView,
} from '../shared/feature-menu.js';

export type FeatureIndexMenuPuppeteerLike = FeatureMenuPuppeteerLike;

export class FeatureIndexMenuService {
  constructor(private readonly puppeteer: FeatureIndexMenuPuppeteerLike) {}

  async queryMenu(qqUserId: string): Promise<Fragment> {
    return buildFeatureMenuReply(this.puppeteer, qqUserId, buildFeatureIndexMenuView());
  }
}

export function buildFeatureIndexMenuView(): FeatureMenuView {
  return {
    id: 'feature-index',
    badge: '功',
    title: 'QQBot 功能菜单',
    subtitle: '发送 功能 查看本菜单',
    triggerKeyword: '功能',
    footer: '发送对应关键字进入详细功能 · 部分功能受当前群设置限制',
    columns: 3,
    theme: {
      primary: '#4f67c8',
      deep: '#293b84',
      soft: '#f2f5ff',
      glow: 'rgba(79, 103, 200, 0.18)',
      accent: '#d79a36',
    },
    sections: [
      {
        title: '校园学习',
        icon: 'book',
        items: [
          { keyword: '教务', description: '课表、成绩、GPA、选课与考试安排', icon: 'clipboard', accent: true },
          { keyword: '学习通', description: '课程、待办、签到、刷课与章节答题', icon: 'book', accent: true },
        ],
      },
      {
        title: '校园生活',
        icon: 'activity',
        items: [
          { keyword: '志愿汇', description: '志愿时长、活动、签到与服务记录', icon: 'heart' },
          { keyword: '二课', description: '二课学分、成绩单、活动与能力雷达', icon: 'chart' },
        ],
      },
      {
        title: '游戏与互动',
        icon: 'play',
        items: [
          { keyword: '原神', description: '账号绑定、每日签到、兑换与抽卡记录', icon: 'radar', accent: true },
          { keyword: '好感', description: '查看与丰川祥子的关系和互动面板', icon: 'heart' },
        ],
      },
    ],
  };
}

export function renderFeatureIndexMenuHtml(view = buildFeatureIndexMenuView()): string {
  return renderFeatureMenuHtml(view);
}

export function renderFeatureIndexMenuImage(
  puppeteer: FeatureIndexMenuPuppeteerLike,
  view = buildFeatureIndexMenuView(),
) {
  return renderFeatureMenuImage(puppeteer, view);
}
