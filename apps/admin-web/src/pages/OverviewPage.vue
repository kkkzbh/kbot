<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import EmptyState from '@/components/EmptyState.vue';
import RuntimeLogPanel from '@/components/RuntimeLogPanel.vue';
import { api } from '@/api/client';
import { useRuntimeStore } from '@/stores/runtime';

type Overview = any;
const state = ref<Overview | null>(null);
const loading = ref(true);
const router = useRouter();
const runtime = useRuntimeStore();
let timer: number | undefined;

const unhealthy = computed(() => state.value?.services?.filter((item: any) => item.activeState !== 'active') ?? []);

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    const next = await api<Overview>('/overview');
    state.value = next;
    runtime.currentModel = next.currentModel?.model || '未配置模型';
    runtime.running = next.serviceSummary.running;
    runtime.total = next.serviceSummary.total;
    runtime.updateApply(next.apply);
  } catch (error) {
    if (!silent) ElMessage.error(error instanceof Error ? error.message : '总览加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  load();
  timer = window.setInterval(() => load(true), 10_000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <el-skeleton v-if="loading && !state" :rows="8" animated />
  <div v-else-if="state" class="overview-page">
    <section class="panel overview-summary">
      <article class="summary-item">
        <span>运行服务</span>
        <div><strong>{{ state.serviceSummary.running }}/{{ state.serviceSummary.total }}</strong><small>{{ state.serviceSummary.failed ? `${state.serviceSummary.failed} 个失败` : '全部正常' }}</small></div>
      </article>
      <article class="summary-item summary-model">
        <span>当前模型</span>
        <div><strong>{{ state.currentModel?.model || '未配置' }}</strong><small>{{ state.currentModel?.title || '没有 Provider' }}</small></div>
      </article>
      <article class="summary-item">
        <span>长期记忆</span>
        <div><strong>{{ state.memory.summary.factCount + state.memory.summary.episodeCount }}</strong><small>{{ state.memory.summary.pendingReviewCount }} 项待审核</small></div>
      </article>
      <article class="summary-item">
        <span>默认预设</span>
        <div><strong>{{ state.defaultPreset || '—' }}</strong><small>{{ state.apply.restartRequired ? '等待重启' : '已应用' }}</small></div>
      </article>
      <button class="summary-refresh" :disabled="loading" @click="load()">{{ loading ? '刷新中' : '刷新' }}</button>
    </section>
    <section class="overview-operations">
      <article class="panel compact-panel">
        <div class="panel-head"><div><h2>服务健康</h2><p>{{ state.serviceSummary.running }}/{{ state.serviceSummary.total }} 正在运行</p></div><el-button text @click="router.push('/runtime/services')">管理 →</el-button></div>
        <div class="service-list">
          <div v-for="service in state.services" :key="service.unit" class="service-row">
            <div><strong>{{ service.description }}</strong><span class="mono muted">{{ service.unit }}</span></div>
            <span class="service-state"><i class="status-dot" :class="service.activeState === 'active' ? 'ok' : 'error'" />{{ service.subState }}</span>
          </div>
        </div>
      </article>
      <article class="panel compact-panel">
          <div class="panel-head"><div><h2>待处理事项</h2><p>需要人工关注的运行状态</p></div></div>
          <div v-if="unhealthy.length || state.memory.summary.pendingReviewCount || state.memory.summary.deadLetterJobs" class="issue-list">
            <button v-for="service in unhealthy" :key="service.unit" @click="router.push('/runtime/services')"><i class="status-dot error" /><span><strong>{{ service.description }}</strong><small>{{ service.activeState }} / {{ service.subState }}</small></span></button>
            <button v-if="state.memory.summary.pendingReviewCount" @click="router.push('/intelligence/memory')"><i class="status-dot warn" /><span><strong>{{ state.memory.summary.pendingReviewCount }} 项记忆待审核</strong><small>进入长期记忆处理候选记录</small></span></button>
            <button v-if="state.memory.summary.deadLetterJobs" @click="router.push('/intelligence/memory')"><i class="status-dot error" /><span><strong>{{ state.memory.summary.deadLetterJobs }} 个 dead letter job</strong><small>检查记忆任务失败原因</small></span></button>
          </div>
          <EmptyState v-else title="当前没有待处理事项" description="轮询每 10 秒更新一次。" />
      </article>
    </section>
    <RuntimeLogPanel class="overview-log" />
  </div>
</template>

<style scoped>
.overview-page { display: grid; gap: 12px; }
.overview-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) 72px; overflow: hidden; }
.summary-item { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 11px 16px; border-right: 1px solid var(--line); }
.summary-item > span { flex: none; color: #7b8595; font-size: 10px; }
.summary-item div { min-width: 0; text-align: right; }
.summary-item strong, .summary-item small { display: block; }
.summary-item strong { overflow: hidden; color: #1f2937; font-size: 18px; line-height: 1.25; text-overflow: ellipsis; white-space: nowrap; }
.summary-item small { margin-top: 2px; color: #929aa8; font-size: 9px; }
.summary-model strong { font-size: 13px; }
.summary-refresh { border: 0; color: #52647f; background: #fbfcfe; font-size: 11px; }
.summary-refresh:hover { color: #315abd; background: #f0f4fc; }
.summary-refresh:disabled { cursor: wait; opacity: .6; }
.overview-operations { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(280px, .8fr); gap: 12px; }
.compact-panel { min-width: 0; overflow: hidden; }
.compact-panel .panel-head { min-height: 44px; padding: 8px 14px; }
.service-list { display: grid; }
.service-row { min-width: 0; min-height: 36px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 6px 14px; border-top: 1px solid var(--line); }
.service-row:first-child { border-top: 0; }
.service-row > div { min-width: 0; display: flex; align-items: center; gap: 16px; }
.service-row strong { min-width: 140px; color: #364152; font-size: 11px; font-weight: 600; }
.service-row .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.service-state { display: inline-flex; align-items: center; gap: 8px; font-size: 11px; }
.issue-list { padding: 5px 8px; }
.issue-list button { width: 100%; display: flex; align-items: flex-start; gap: 10px; padding: 7px 9px; border: 0; border-radius: 7px; background: transparent; text-align: left; }
.issue-list button:hover { background: #f7f8fb; }
.issue-list .status-dot { margin-top: 4px; }
.issue-list strong, .issue-list small { display: block; }
.issue-list strong { color: #374151; font-size: 11px; }
.issue-list small { margin-top: 2px; color: #8b94a3; font-size: 9px; }
:deep(.overview-log) { min-height: 0; }

@media (min-width: 1101px) {
  .overview-page { height: 100%; grid-template-rows: auto auto minmax(0, 1fr); }
  :deep(.overview-log .log-viewport) { height: auto; min-height: 0; flex: 1; }
}

@media (max-width: 1100px) {
  .overview-summary { grid-template-columns: repeat(4, minmax(0, 1fr)) 64px; }
  .summary-item { align-items: flex-start; flex-direction: column; gap: 5px; }
  .summary-item div { width: 100%; text-align: left; }
  .overview-operations { grid-template-columns: 1fr; }
}

@media (max-width: 760px) {
  .overview-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .summary-item:nth-child(2) { border-right: 0; }
  .summary-item:nth-child(-n+2) { border-bottom: 1px solid var(--line); }
  .summary-refresh { grid-column: 1 / -1; min-height: 36px; border-top: 1px solid var(--line); }
  .service-row > div { align-items: flex-start; flex-direction: column; gap: 2px; }
  .service-row strong { min-width: 0; }
}
</style>
