import { createRouter, createWebHistory } from 'vue-router';
import { resolveAdminScroll } from './router-scroll';

export const router = createRouter({
  history: createWebHistory('/'),
  scrollBehavior: resolveAdminScroll,
  routes: [
    { path: '/', name: 'overview', component: () => import('@/pages/OverviewPage.vue'), meta: { title: '运行总览', description: '服务管理、异常处置、模型与运行状态' } },
    { path: '/runtime/logs', name: 'logs', component: () => import('@/pages/LogsPage.vue'), meta: { title: '运行日志', description: 'Koishi 进程实时日志' } },
    { path: '/intelligence/models', name: 'models', component: () => import('@/pages/ModelsPage.vue'), meta: { title: '模型配置', description: '统一管理认证连接、模型目录与全部大模型设置' } },
    { path: '/intelligence/context-presets', name: 'context-presets', component: () => import('@/pages/PresetsPage.vue'), meta: { title: '上下文预设', description: '编排角色、记忆、知识与模型输入输出结构' } },
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

router.afterEach((to) => {
  document.title = `${String(to.meta.title || '管理端')} · QQBot`;
});
