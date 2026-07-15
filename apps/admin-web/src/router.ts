import { createRouter, createWebHistory } from 'vue-router';
import { useSessionStore } from '@/stores/session';

export const router = createRouter({
  history: createWebHistory('/'),
  routes: [
    { path: '/login', name: 'login', component: () => import('@/pages/LoginPage.vue'), meta: { public: true, title: '登录' } },
    { path: '/', name: 'overview', component: () => import('@/pages/OverviewPage.vue'), meta: { title: '总览', description: '服务、模型与运行风险一览' } },
    { path: '/runtime/services', name: 'services', component: () => import('@/pages/ServicesPage.vue'), meta: { title: '服务管理', description: 'systemd 服务状态与生命周期操作' } },
    { path: '/intelligence/models', name: 'models', component: () => import('@/pages/ModelsPage.vue'), meta: { title: '模型接口', description: 'Provider、模型与 OAuth 连接' } },
    { path: '/intelligence/presets', name: 'presets', component: () => import('@/pages/PresetsPage.vue'), meta: { title: '角色预设', description: '角色 prompt 与默认预设' } },
    { path: '/intelligence/memory', name: 'memory', component: () => import('@/pages/MemoryPage.vue'), meta: { title: '长期记忆', description: '分页查看、审核与清理记忆' } },
    { path: '/intelligence/affinity', name: 'affinity', component: () => import('@/pages/AffinityPage.vue'), meta: { title: '关系事件', description: '关系状态、主动事件与白名单' } },
    { path: '/policies', name: 'policies', component: () => import('@/pages/PoliciesPage.vue'), meta: { title: '策略与权限', description: '功能、工具与会话数据控制' } },
    { path: '/extensions/campus', redirect: { name: 'campus-auth' } },
    { path: '/extensions/campus/auth', name: 'campus-auth', component: () => import('@/pages/SettingsPage.vue'), props: { section: 'features', mode: 'campus-auth' }, meta: { title: '校园认证', description: '校园服务统一认证、绑定页面与操作链接' } },
    { path: '/extensions/campus/hbu-jw', name: 'hbu-jw', component: () => import('@/pages/SettingsPage.vue'), props: { section: 'features', mode: 'hbu-jw' }, meta: { title: '教务系统', description: '河北大学教务绑定、登录态与群聊权限' } },
    { path: '/extensions/campus/zyh', name: 'zyh', component: () => import('@/pages/SettingsPage.vue'), props: { section: 'features', mode: 'zyh' }, meta: { title: '志愿汇', description: '志愿汇群聊范围与自然触发策略' } },
    { path: '/extensions/campus/second-class', name: 'second-class', component: () => import('@/pages/SettingsPage.vue'), props: { section: 'features', mode: 'second-class' }, meta: { title: '第二课堂', description: '第二课堂群聊范围与自然触发策略' } },
    { path: '/extensions/campus/chaoxing', name: 'chaoxing', component: () => import('@/pages/SettingsPage.vue'), props: { section: 'features', mode: 'chaoxing' }, meta: { title: '学习通', description: '学习通绑定、签到、任务同步与答案源' } },
    { path: '/extensions/genshin', name: 'genshin', component: () => import('@/pages/SettingsPage.vue'), props: { section: 'features', mode: 'genshin' }, meta: { title: '原神服务', description: '米游社绑定、自动签到与兑换接口' } },
    { path: '/extensions/tts', name: 'tts', component: () => import('@/pages/TtsPage.vue'), meta: { title: '语音服务', description: 'TTS 网关、健康探测与流式试听' } },
    { path: '/system/basic', name: 'basic', component: () => import('@/pages/SettingsPage.vue'), props: { section: 'basic', mode: 'all' }, meta: { title: '基础设置', description: '触发别名与权限基础参数' } },
    { path: '/system/features', name: 'features', component: () => import('@/pages/SettingsPage.vue'), props: { section: 'features', mode: 'system' }, meta: { title: '功能设置', description: '运行功能与集成配置' } },
  ],
});

router.beforeEach(async (to) => {
  const session = useSessionStore();
  if (!session.checked) {
    try {
      await session.check();
    } catch {
      session.$patch({ checked: true, authenticated: false, expiresAt: null });
    }
  }
  if (to.meta.public) return session.authenticated ? { name: 'overview' } : true;
  if (!session.authenticated) return { name: 'login', query: { redirect: to.fullPath } };
  return true;
});

router.afterEach((to) => {
  document.title = `${String(to.meta.title || '管理端')} · QQBot`;
});
