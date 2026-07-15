import type { Fragment } from 'koishi';
import {
  buildFeatureMenuReply,
  renderFeatureMenuHtml,
  renderFeatureMenuImage,
  type FeatureMenuPuppeteerLike,
  type FeatureMenuView,
} from '../shared/feature-menu.js';

export type ChaoxingMenuPuppeteerLike = FeatureMenuPuppeteerLike;

export class ChaoxingMenuService {
  constructor(private readonly puppeteer: ChaoxingMenuPuppeteerLike) {}

  async queryMenu(qqUserId: string): Promise<Fragment> {
    return buildFeatureMenuReply(this.puppeteer, qqUserId, buildChaoxingMenuView());
  }
}

export function buildChaoxingMenuView(): FeatureMenuView {
  return {
    id: 'chaoxing',
    badge: '学',
    title: '学习通功能菜单',
    subtitle: '发送 学习通 查看本菜单',
    triggerKeyword: '学习通',
    footer: 'QQBot · 学习通助手 · 长任务支持状态查询与停止',
    columns: 3,
    theme: {
      primary: '#d94b43',
      deep: '#8e2e31',
      soft: '#fff4f1',
      glow: 'rgba(217, 75, 67, 0.16)',
      accent: '#d9a441',
    },
    sections: [
      {
        title: '账号',
        icon: 'user',
        items: [
          { keyword: '学习通绑定', description: '扫码登录或选择密码登录', icon: 'shield' },
          { keyword: '学习通确认 <确认码>', description: '登录完成后确认账号绑定', icon: 'check', accent: true },
          { keyword: '学习通状态', description: '检查绑定和自动续期状态', icon: 'id-card' },
          { keyword: '学习通解绑', description: '清除账号、会话和任务记录', icon: 'link-off' },
        ],
      },
      {
        title: '课程与待办',
        icon: 'book',
        items: [
          { keyword: '学习通课程', description: '列出当前账号的课程', icon: 'book' },
          { keyword: '学习通章节 <课程>', description: '查看课程章节和完成状态', icon: 'list' },
          { keyword: '学习通待办', description: '聚合作业、考试和签到活动', icon: 'tasks', accent: true },
          { keyword: '学习通作业', description: '查看未完成作业与截止时间', icon: 'edit' },
          { keyword: '学习通考试', description: '查看考试安排与截止时间', icon: 'clipboard' },
        ],
      },
      {
        title: '签到',
        icon: 'check',
        items: [
          { keyword: '学习通签到', description: '一键处理唯一的普通签到', icon: 'check', accent: true },
          { keyword: '学习通签到状态', description: '查看官方签到状态及活动 ID', icon: 'search' },
          { keyword: '学习通签到 <活动ID> [签到码]', description: '执行指定的普通、手势或签到码签到', icon: 'check' },
          { keyword: '学习通签到监听 [课程]', description: '持续检测签到并发送结果通知', icon: 'bell' },
          { keyword: '学习通停止签到', description: '停止当前签到监听任务', icon: 'stop' },
        ],
      },
      {
        title: '刷课',
        icon: 'play',
        items: [
          { keyword: '学习通刷课 <课程>', description: '处理视频、文档和阅读任务', icon: 'play', accent: true },
          { keyword: '学习通刷课状态', description: '查看进度、暂停原因和断点', icon: 'chart' },
          { keyword: '学习通停止刷课', description: '停止任务并保留当前进度', icon: 'stop' },
        ],
      },
      {
        title: '章节答题',
        icon: 'edit',
        items: [
          { keyword: '学习通答题 <课程>', description: '准备章节测验答案并发送预览', icon: 'edit', accent: true },
          { keyword: '学习通答题补充 <任务ID> <题号> <答案>', description: '补充或修正预览中的答案', icon: 'edit' },
          { keyword: '学习通答题保存 <任务ID>', description: '只填入答案并保存', icon: 'tasks' },
          { keyword: '学习通答题提交 <任务ID>', description: '确认后提交章节测验', icon: 'check' },
          { keyword: '学习通错题', description: '查看历史错题记录', icon: 'list' },
          { keyword: '学习通停止答题', description: '停止当前答题任务', icon: 'stop' },
        ],
      },
      {
        title: '任务',
        icon: 'tasks',
        items: [
          { keyword: '学习通任务状态', description: '查看签到、刷课和答题长任务', icon: 'tasks', accent: true },
        ],
      },
    ],
  };
}

export function renderChaoxingMenuHtml(view = buildChaoxingMenuView()): string {
  return renderFeatureMenuHtml(view);
}

export function renderChaoxingMenuImage(puppeteer: ChaoxingMenuPuppeteerLike, view = buildChaoxingMenuView()) {
  return renderFeatureMenuImage(puppeteer, view);
}
