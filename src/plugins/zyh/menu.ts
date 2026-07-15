import type { Fragment } from 'koishi';
import {
  buildFeatureMenuReply,
  renderFeatureMenuHtml,
  renderFeatureMenuImage,
  type FeatureMenuPuppeteerLike,
  type FeatureMenuView,
} from '../shared/feature-menu.js';

export type ZyhMenuPuppeteerLike = FeatureMenuPuppeteerLike;

export class ZyhMenuService {
  constructor(private readonly puppeteer: ZyhMenuPuppeteerLike) {}

  async queryMenu(qqUserId: string): Promise<Fragment> {
    return buildFeatureMenuReply(this.puppeteer, qqUserId, buildZyhMenuView());
  }
}

export function buildZyhMenuView(): FeatureMenuView {
  return {
    id: 'zyh',
    badge: '志',
    title: '志愿汇功能菜单',
    subtitle: '发送 志愿汇 查看本菜单',
    triggerKeyword: '志愿汇',
    footer: 'QQBot · 志愿汇助手',
    columns: 2,
    theme: {
      primary: '#16836f',
      deep: '#07584d',
      soft: '#eef9f6',
      glow: 'rgba(31, 158, 132, 0.16)',
      accent: '#e0aa45',
    },
    sections: [
      {
        title: '账号',
        icon: 'user',
        items: [
          { keyword: '志愿汇绑定', description: '选择登录方式并绑定志愿汇账号', icon: 'shield' },
          { keyword: '志愿汇确认 <确认码>', description: '网页验证成功后确认账号绑定', icon: 'check', accent: true },
          { keyword: '志愿汇状态', description: '检查账号绑定方式与登录状态', icon: 'id-card' },
          { keyword: '志愿汇解绑', description: '解除绑定并撤销关联的二课登录态', icon: 'link-off' },
        ],
      },
      {
        title: '签到',
        icon: 'check',
        items: [
          { keyword: '志愿汇签到 <活动码>', description: '私聊发起，使用手机精确定位校验活动范围', icon: 'check', accent: true },
          { keyword: '志愿汇签退 <活动码>', description: '复用签到活动码签退，并再次校验定位', icon: 'clock' },
        ],
      },
      {
        title: '查询',
        icon: 'search',
        items: [
          { keyword: '志愿时长', description: '查看信用时数、荣誉时数和公益益币', icon: 'clock', accent: true },
          { keyword: '志愿记录 [页码]', description: '查看已经完成的志愿服务记录', icon: 'list' },
          { keyword: '志愿活动 [关键词]', description: '搜索当前可查看的志愿活动', icon: 'search' },
          { keyword: '我的志愿活动 [页码]', description: '查看自己报名和参与的活动', icon: 'heart' },
        ],
      },
    ],
  };
}

export function renderZyhMenuHtml(view = buildZyhMenuView()): string {
  return renderFeatureMenuHtml(view);
}

export function renderZyhMenuImage(puppeteer: ZyhMenuPuppeteerLike, view = buildZyhMenuView()) {
  return renderFeatureMenuImage(puppeteer, view);
}
