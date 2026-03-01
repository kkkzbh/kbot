import { defineConfig } from 'vitepress';

export default defineConfig({
  lang: 'zh-CN',
  title: 'QQBot 开发者文档',
  description: 'Koishi + OneBot + LLOneBot + ChatLuna 项目开发者文档',
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: 'Koishi 插件与功能', link: '/developer/koishi-plugins' },
      { text: '配置说明', link: '/developer/configuration' },
      { text: '聊天链路说明', link: '/developer/chatluna-migration' },
      { text: '自动化使用介绍', link: '/developer/automation-usage' },
    ],
    sidebar: {
      '/developer/': [
        {
          text: '开发者文档',
          items: [
            { text: 'Koishi 插件与功能', link: '/developer/koishi-plugins' },
            { text: '配置说明', link: '/developer/configuration' },
            { text: '聊天链路说明', link: '/developer/chatluna-migration' },
            { text: '自动化使用功能介绍', link: '/developer/automation-usage' },
          ],
        },
      ],
    },
    search: {
      provider: 'local',
    },
    docFooter: {
      prev: false,
      next: false,
    },
  },
});
