<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch, type Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import {
  Award,
  Blocks,
  BookOpenCheck,
  ChevronDown,
  Cpu,
  Database,
  Gamepad2,
  GraduationCap,
  HandHeart,
  HeartHandshake,
  KeyRound,
  LayoutDashboard,
  MonitorPlay,
  RotateCw,
  School,
  ScrollText,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  UserRoundCog,
  Volume2,
} from '@lucide/vue';
import { useSessionStore } from '@/stores/session';
import { useRuntimeStore } from '@/stores/runtime';

type NavItem = {
  key: string;
  label: string;
  icon: Component;
  path?: string;
  children?: NavItem[];
};
type NavGroup = { label: string; items: NavItem[] };

const groups: NavGroup[] = [
  { label: '总览', items: [{ key: 'overview', label: '运行总览', path: '/', icon: LayoutDashboard }] },
  { label: '运行与监控', items: [
    { key: 'services', label: '服务管理', path: '/runtime/services', icon: Server },
    { key: 'logs', label: '运行日志', path: '/runtime/logs', icon: ScrollText },
  ] },
  { label: '对话智能', items: [
    { key: 'models', label: '模型接口', path: '/intelligence/models', icon: Cpu },
    { key: 'presets', label: '角色预设', path: '/intelligence/presets', icon: UserRoundCog },
    { key: 'memory', label: '长期记忆', path: '/intelligence/memory', icon: Database },
    { key: 'affinity', label: '关系事件', path: '/intelligence/affinity', icon: HeartHandshake },
  ] },
  { label: '策略与权限', items: [{ key: 'policies', label: '功能与工具策略', path: '/policies', icon: ShieldCheck }] },
  { label: '扩展服务', items: [
    {
      key: 'campus',
      label: '校园扩展',
      icon: GraduationCap,
      children: [
        { key: 'campus-auth', label: '校园认证', path: '/extensions/campus/auth', icon: KeyRound },
        { key: 'hbu-jw', label: '教务系统', path: '/extensions/campus/hbu-jw', icon: School },
        { key: 'zyh', label: '志愿汇', path: '/extensions/campus/zyh', icon: HandHeart },
        { key: 'second-class', label: '第二课堂', path: '/extensions/campus/second-class', icon: Award },
        { key: 'chaoxing', label: '学习通', path: '/extensions/campus/chaoxing', icon: MonitorPlay },
      ],
    },
    { key: 'genshin', label: '原神服务', path: '/extensions/genshin', icon: Gamepad2 },
    { key: 'tts', label: '语音服务', path: '/extensions/tts', icon: Volume2 },
  ] },
  { label: '系统设置', items: [
    { key: 'basic', label: '基础设置', path: '/system/basic', icon: SlidersHorizontal },
    { key: 'features', label: '功能设置', path: '/system/features', icon: Blocks },
  ] },
];

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const runtime = useRuntimeStore();
const mobileOpen = ref(false);
const commandOpen = ref(false);
const commandQuery = ref('');
const expandedBranches = reactive<Record<string, boolean>>({});
const isLogin = computed(() => route.name === 'login');
const filteredCommands = computed(() => {
  const query = commandQuery.value.trim().toLowerCase();
  return groups.flatMap((group) => group.items.flatMap((item) => item.children
    ? item.children.map((child) => ({ ...child, group: `${group.label} / ${item.label}` }))
    : item.path ? [{ ...item, group: group.label }] : []))
    .filter((item) => !query || `${item.label} ${item.group}`.toLowerCase().includes(query));
});
const restartTitle = computed(() => runtime.restartReasons.length
  ? `配置等待重启：${runtime.restartReasons.join(' · ')}`
  : '配置等待重启');

function isActive(item: NavItem): boolean {
  return item.path === route.path;
}

function isBranchActive(item: NavItem): boolean {
  return item.children?.some((child) => child.path === route.path) ?? false;
}

function toggleBranch(item: NavItem): void {
  expandedBranches[item.key] = !expandedBranches[item.key];
}

function activateRouteBranch(path: string): void {
  for (const group of groups) {
    for (const item of group.items) {
      if (item.children?.some((child) => child.path === path)) expandedBranches[item.key] = true;
    }
  }
}

async function navigate(path: string) {
  commandOpen.value = false;
  mobileOpen.value = false;
  await router.push(path);
}

async function logout() {
  await session.logout();
  ElMessage.success('管理会话已退出');
  await router.push('/login');
}

function handleKeyboard(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    commandOpen.value = true;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    window.dispatchEvent(new CustomEvent('admin-save'));
  }
}

onMounted(() => window.addEventListener('keydown', handleKeyboard));
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeyboard));
watch(() => route.path, activateRouteBranch, { immediate: true });
</script>

<template>
  <el-config-provider :locale="zhCn">
    <router-view v-if="isLogin" />
    <div v-else class="app-shell">
    <aside class="sidebar" :class="{ 'is-open': mobileOpen }">
      <nav class="nav-scroll">
        <section v-for="group in groups" :key="group.label" class="nav-group">
          <h2>{{ group.label }}</h2>
          <div v-for="item in group.items" :key="item.key" class="nav-entry">
            <button
              class="nav-item"
              :class="{ active: isActive(item), 'branch-active': isBranchActive(item), 'has-children': item.children }"
              :aria-expanded="item.children ? Boolean(expandedBranches[item.key]) : undefined"
              @click="item.children ? toggleBranch(item) : navigate(item.path!)"
            >
              <component :is="item.icon" :size="18" :stroke-width="1.8" class="nav-icon" />
              <span>{{ item.label }}</span>
              <ChevronDown v-if="item.children" :size="15" class="nav-chevron" :class="{ expanded: expandedBranches[item.key] }" />
            </button>
            <div v-if="item.children" v-show="expandedBranches[item.key]" class="nav-submenu">
              <button
                v-for="child in item.children"
                :key="child.key"
                class="nav-subitem"
                :class="{ active: isActive(child) }"
                @click="navigate(child.path!)"
              >
                <component :is="child.icon" :size="16" :stroke-width="1.8" class="nav-icon" />
                <span>{{ child.label }}</span>
              </button>
            </div>
          </div>
        </section>
      </nav>
      <div class="sidebar-footer">
        <span class="status-dot" :class="runtime.running === runtime.total && runtime.total > 0 ? 'ok' : 'warn'" />
        {{ runtime.running }}/{{ runtime.total }} 服务运行中
      </div>
    </aside>
    <div v-if="mobileOpen" class="sidebar-backdrop" @click="mobileOpen = false" />

    <div class="workspace">
      <header class="topbar">
        <button class="mobile-menu" aria-label="打开导航" @click="mobileOpen = true">☰</button>
        <button class="command-trigger" @click="commandOpen = true">
          <span>搜索页面和操作</span><kbd>⌘ K</kbd>
        </button>
        <div class="topbar-state">
          <span class="model-chip">{{ runtime.currentModel }}</span>
          <router-link v-if="runtime.restartRequired" class="restart-chip" to="/runtime/services" :title="restartTitle">
            <RotateCw :size="13" :stroke-width="2" />
            <span>待重启</span>
          </router-link>
          <span class="topbar-health"><i class="status-dot ok" />运行中</span>
          <el-button text @click="logout">退出</el-button>
        </div>
      </header>
      <main class="content" :class="{ 'content-logs': route.name === 'logs' }">
        <router-view />
      </main>
    </div>
    </div>

    <el-dialog v-model="commandOpen" width="min(620px, calc(100vw - 32px))" class="command-dialog" :show-close="false">
      <el-input v-model="commandQuery" autofocus size="large" placeholder="输入页面名称…" />
      <div class="command-list">
        <button v-for="item in filteredCommands" :key="item.path" @click="navigate(item.path!)">
          <span><small>{{ item.group }}</small>{{ item.label }}</span><kbd>↵</kbd>
        </button>
      </div>
    </el-dialog>
  </el-config-provider>
</template>
