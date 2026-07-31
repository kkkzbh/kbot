<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch, type Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import {
  Award,
  Bot,
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
  MessageCircleMore,
  MonitorPlay,
  RotateCw,
  School,
  ScrollText,
  UserRoundCog,
  Volume2,
} from '@lucide/vue';
import type { BotServiceStatus, BotServiceUnit } from '@contracts';
import {
  useRuntimeStore,
  type ApplyState,
} from '@/stores/runtime';
import { refreshRuntimeOverview } from '@/stores/runtime-refresh';
import { rawApi, rawJsonBody } from '@/api/client';

type NavItem = {
  key: string;
  label: string;
  icon: Component;
  path?: string;
  children?: NavItem[];
};
type NavGroup = { label: string; items: NavItem[] };
type ApplyRestartTarget = {
  unit: BotServiceUnit;
  previousInvocationId: string | null;
};
type ApplyRestartResponse = {
  targets: ApplyRestartTarget[];
  apply: ApplyState;
};

const groups: NavGroup[] = [
  { label: '总览', items: [{ key: 'overview', label: '运行总览', path: '/', icon: LayoutDashboard }] },
  { label: '运行与监控', items: [
    { key: 'logs', label: '运行日志', path: '/runtime/logs', icon: ScrollText },
  ] },
  { label: '对话智能', items: [
    { key: 'models', label: '模型配置', path: '/intelligence/models', icon: Cpu },
    { key: 'context-presets', label: '上下文', path: '/intelligence/context-presets', icon: UserRoundCog },
    { key: 'memory', label: '长期记忆', path: '/intelligence/memory', icon: Database },
    { key: 'natural-trigger', label: '自然触发', path: '/intelligence/natural-trigger', icon: MessageCircleMore },
    { key: 'agent', label: 'Agent', path: '/intelligence/agent', icon: Bot },
  ] },
  { label: '扩展服务', items: [
    { key: 'affinity', label: '关系事件', path: '/extensions/affinity', icon: HeartHandshake },
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
];

const route = useRoute();
const router = useRouter();
const runtime = useRuntimeStore();
const mobileOpen = ref(false);
const commandOpen = ref(false);
const commandQuery = ref('');
const expandedBranches = reactive<Record<string, boolean>>({});
const filteredCommands = computed(() => {
  const query = commandQuery.value.trim().toLowerCase();
  return groups.flatMap((group) => group.items.flatMap((item) => item.children
    ? item.children.map((child) => ({ ...child, group: `${group.label} / ${item.label}` }))
    : item.path ? [{ ...item, group: group.label }] : []))
    .filter((item) => !query || `${item.label} ${item.group}`.toLowerCase().includes(query));
});
const restartReasonLabels: Record<string, string> = {
  features: '运行功能配置',
  naturalTrigger: '自然触发配置',
  model: '模型配置',
  preset: '上下文',
  tts: '语音服务',
};
const restartTitle = computed(() => runtime.restartReasons.length
  ? `重启以应用：${runtime.restartReasons.map((reason) => restartReasonLabels[reason] ?? reason).join(' · ')}`
  : '配置等待重启');
const currentModelLabel = computed(() => {
  const separatorIndex = runtime.currentModel.lastIndexOf('/');
  return separatorIndex >= 0
    ? runtime.currentModel.slice(separatorIndex + 1)
    : runtime.currentModel;
});
const restartUnitLabels: Partial<Record<BotServiceUnit, string>> = {
  'qqbot-koishi.service': 'Koishi',
  'qqbot-voice-tts.service': '语音服务',
};
let runtimeTimer: number | undefined;

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForRestartTargets(targets: ApplyRestartTarget[]): Promise<void> {
  await delay(1_200);
  for (let attempt = 0; attempt < 45; attempt += 1) {
    try {
      const services = await rawApi<BotServiceStatus[]>('/services');
      runtime.running = services.filter((service) => service.runtimeState === 'healthy' || service.runtimeState === 'degraded').length;
      runtime.total = services.length;
      const current = new Map(services.map((service) => [service.unit, service]));
      const ready = targets.every((target) => {
        const status = current.get(target.unit);
        if (!status || (status.runtimeState !== 'healthy' && status.runtimeState !== 'degraded')) return false;
        const invocationId = status.controllerState.invocationId;
        return target.previousInvocationId === null || invocationId !== target.previousInvocationId;
      });
      if (ready) return;
    } catch {
      // Koishi 的计划重启会短暂中断 Admin API，恢复后继续验证新的 invocation。
    }
    await delay(1_000);
  }
  throw new Error('相关服务已收到重启指令，但 45 秒内没有恢复为新的运行实例。');
}

async function applyPendingRestart(): Promise<void> {
  if (!runtime.restartRequired || runtime.restartInProgress) return;
  runtime.beginRestart();
  let submitted = false;
  let completed = false;
  try {
    const result = await rawApi<ApplyRestartResponse>('/apply/restart', {
      method: 'POST',
      body: rawJsonBody({}),
    });
    submitted = result.targets.length > 0;
    runtime.updateApply(result.apply);
    if (!submitted) {
      ElMessage.info('当前没有等待应用的重启项');
      return;
    }
    await waitForRestartTargets(result.targets);
    await refreshRuntimeOverview();
    completed = true;
    const labels = result.targets.map((target) => restartUnitLabels[target.unit] ?? target.unit);
    ElMessage.success(`${labels.join('、')} 已重启，配置已生效`);
  } catch (error) {
    const message = error instanceof Error ? error.message : '智能重启失败';
    if (submitted) {
      await refreshRuntimeOverview();
      ElMessage.warning(message);
    } else {
      ElMessage.error(message);
    }
  } finally {
    runtime.finishRestart(completed);
  }
}

function refreshRuntimeWhenVisible(): void {
  if (document.visibilityState === 'visible') void refreshRuntimeOverview();
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

onMounted(() => {
  window.addEventListener('keydown', handleKeyboard);
  window.addEventListener('focus', refreshRuntimeWhenVisible);
  document.addEventListener('visibilitychange', refreshRuntimeWhenVisible);
  void refreshRuntimeOverview();
  runtimeTimer = window.setInterval(() => void refreshRuntimeOverview(), 10_000);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeyboard);
  window.removeEventListener('focus', refreshRuntimeWhenVisible);
  document.removeEventListener('visibilitychange', refreshRuntimeWhenVisible);
  window.clearInterval(runtimeTimer);
});
watch(() => route.path, activateRouteBranch, { immediate: true });
</script>

<template>
  <el-config-provider :locale="zhCn">
    <div class="app-shell">
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
              <span v-if="item.key === 'overview' && runtime.openEventCount" class="nav-badge">{{ runtime.openEventCount > 99 ? '99+' : runtime.openEventCount }}</span>
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
    </aside>
    <div v-if="mobileOpen" class="sidebar-backdrop" @click="mobileOpen = false" />

    <div class="workspace">
      <header class="topbar">
        <button class="mobile-menu" aria-label="打开导航" @click="mobileOpen = true">☰</button>
        <button class="command-trigger" @click="commandOpen = true">
          <span>搜索页面和操作</span><kbd>⌘ K</kbd>
        </button>
        <div class="topbar-state">
          <span class="model-chip" :title="runtime.shellError || undefined">
            {{ runtime.shellState === 'loading' ? '加载中' : runtime.shellState === 'error' ? '状态不可用' : currentModelLabel }}
          </span>
          <button
            v-if="runtime.restartRequired || runtime.restartInProgress"
            class="restart-chip"
            :class="{ busy: runtime.restartInProgress }"
            :disabled="runtime.restartInProgress"
            :title="runtime.restartInProgress ? '正在重启待应用配置涉及的服务' : restartTitle"
            @click="applyPendingRestart"
          >
            <RotateCw :size="13" :stroke-width="2" />
            <span>{{ runtime.restartInProgress ? '重启中' : '重启' }}</span>
          </button>
          <span class="topbar-health"><i class="status-dot ok" />运行中</span>
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
