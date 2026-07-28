import { createRouter, createWebHistory } from 'vue-router';
import { resolveAdminScroll } from './router-scroll';

export const router = createRouter({
  history: createWebHistory('/'),
  scrollBehavior: resolveAdminScroll,
  routes: [
    { path: '/', name: 'overview', component: () => import('@/pages/OverviewPage.vue'), meta: { title: '运行总览' } },
    { path: '/runtime/logs', name: 'logs', component: () => import('@/pages/LogsPage.vue'), meta: { title: '运行日志' } },
    { path: '/intelligence/models', name: 'models', component: () => import('@/pages/ModelsPage.vue'), meta: { title: '模型配置' } },
    { path: '/intelligence/context-presets', name: 'context-presets', component: () => import('@/pages/PresetsPage.vue'), meta: { title: '上下文预设' } },
    { path: '/intelligence/memory', name: 'memory', component: () => import('@/pages/MemoryPage.vue'), meta: { title: '长期记忆' } },
    { path: '/intelligence/natural-trigger', name: 'natural-trigger', component: () => import('@/pages/NaturalTriggerPage.vue'), meta: { title: '自然触发' } },
    { path: '/policies', name: 'policies', component: () => import('@/pages/PoliciesPage.vue'), meta: { title: '策略与权限' } },
    { path: '/extensions/affinity', name: 'affinity', component: () => import('@/pages/AffinityPage.vue'), meta: { title: '关系事件' } },
    { path: '/extensions/campus', redirect: { name: 'campus-auth' } },
    { path: '/extensions/campus/auth', name: 'campus-auth', component: () => import('@/pages/SettingsPage.vue'), props: { mode: 'campus-auth' }, meta: { title: '校园认证' } },
    { path: '/extensions/campus/hbu-jw', name: 'hbu-jw', component: () => import('@/pages/SettingsPage.vue'), props: { mode: 'hbu-jw' }, meta: { title: '教务系统' } },
    { path: '/extensions/campus/zyh', name: 'zyh', component: () => import('@/pages/SettingsPage.vue'), props: { mode: 'zyh' }, meta: { title: '志愿汇' } },
    { path: '/extensions/campus/second-class', name: 'second-class', component: () => import('@/pages/SettingsPage.vue'), props: { mode: 'second-class' }, meta: { title: '第二课堂' } },
    { path: '/extensions/campus/chaoxing', name: 'chaoxing', component: () => import('@/pages/SettingsPage.vue'), props: { mode: 'chaoxing' }, meta: { title: '学习通' } },
    { path: '/extensions/genshin', name: 'genshin', component: () => import('@/pages/SettingsPage.vue'), props: { mode: 'genshin' }, meta: { title: '原神服务' } },
    { path: '/extensions/tts', name: 'tts', component: () => import('@/pages/TtsPage.vue'), meta: { title: '语音服务' } },
  ],
});

router.afterEach((to) => {
  document.title = `${String(to.meta.title || '管理端')} · QQBot`;
});
