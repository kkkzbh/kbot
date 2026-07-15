import type { Fragment } from 'koishi';
import {
  buildFeatureMenuReply,
  renderFeatureMenuHtml,
  renderFeatureMenuImage,
  type FeatureMenuPuppeteerLike,
  type FeatureMenuView,
} from '../shared/feature-menu.js';

export type HbuSecondClassMenuPuppeteerLike = FeatureMenuPuppeteerLike;

export class HbuSecondClassMenuService {
  constructor(private readonly puppeteer: HbuSecondClassMenuPuppeteerLike) {}

  async queryMenu(qqUserId: string): Promise<Fragment> {
    return buildFeatureMenuReply(this.puppeteer, qqUserId, buildHbuSecondClassMenuView());
  }
}

export function buildHbuSecondClassMenuView(): FeatureMenuView {
  return {
    id: 'hbu-second-class',
    badge: '课',
    title: '河北大学二课菜单',
    subtitle: '发送 二课 查看本菜单',
    triggerKeyword: '二课',
    footer: 'QQBot · 河北大学第二课堂',
    columns: 2,
    theme: {
      primary: '#4c68b1',
      deep: '#2b3f7b',
      soft: '#f1f4fc',
      glow: 'rgba(76, 104, 177, 0.17)',
      accent: '#d59a3a',
    },
    sections: [
      {
        title: '账号',
        icon: 'user',
        items: [
          { keyword: '二课绑定', description: '使用二课账号或 Token 完成绑定', icon: 'shield' },
          { keyword: '二课确认 <确认码>', description: '网页验证成功后确认账号绑定', icon: 'check', accent: true },
          { keyword: '二课状态', description: '检查当前绑定方式与登录状态', icon: 'id-card' },
          { keyword: '二课验证 [验证码]', description: 'Token 失效后获取图片或提交验证码续登', icon: 'check' },
          { keyword: '二课解绑', description: '清除二课绑定和历史查询缓存', icon: 'link-off' },
        ],
      },
      {
        title: '签到',
        icon: 'check',
        items: [
          { keyword: '二课签到 <签到码>', description: '私聊提交 6 位签到码；定位活动需网页确认', icon: 'check', accent: true },
          { keyword: '二课签退 <签到码>', description: '复用活动签到码完成签退', icon: 'clock' },
        ],
      },
      {
        title: '查询',
        icon: 'search',
        items: [
          { keyword: '二课学分', description: '查看课堂学分和各分类完成情况', icon: 'chart', accent: true },
          { keyword: '二课成绩单 [学期]', description: '生成指定学期的二课成绩单图片', icon: 'clipboard' },
          { keyword: '二课雷达', description: '生成各类学分分布雷达图', icon: 'radar' },
          { keyword: '二课活动', description: '查看当前第二课堂活动', icon: 'activity' },
          { keyword: '二课记录', description: '查看个人二课学分记录', icon: 'list' },
        ],
      },
    ],
  };
}

export function renderHbuSecondClassMenuHtml(view = buildHbuSecondClassMenuView()): string {
  return renderFeatureMenuHtml(view);
}

export function renderHbuSecondClassMenuImage(puppeteer: HbuSecondClassMenuPuppeteerLike, view = buildHbuSecondClassMenuView()) {
  return renderFeatureMenuImage(puppeteer, view);
}
