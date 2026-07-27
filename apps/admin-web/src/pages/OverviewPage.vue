<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import RuntimeServicesPanel, {
  type ServiceSummary,
} from '@/components/runtime/RuntimeServicesPanel.vue';
import OperationalEventsPanel from '@/components/runtime/OperationalEventsPanel.vue';
import { rawApi } from '@/api/client';
import {
  useRuntimeStore,
  type RuntimeOverviewState,
} from '@/stores/runtime';

type Overview = RuntimeOverviewState & {
  serviceSummary: ServiceSummary;
  globalDefaultPresetId: string;
  memory: { summary: { factCount: number; episodeCount: number; pendingReviewCount: number } };
};
type RefreshablePanel = { refresh: (silent?: boolean) => Promise<void> };

const state = ref<Overview | null>(null);
const loading = ref(true);
const loadError = ref('');
const servicesPanel = ref<RefreshablePanel | null>(null);
const eventsPanel = ref<RefreshablePanel | null>(null);
const runtime = useRuntimeStore();

async function loadOverview(silent = false): Promise<void> {
  if (!silent) loading.value = true;
  try {
    const next = await rawApi<Overview>('/overview');
    loadError.value = '';
    state.value = next;
    runtime.updateOverview(next);
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '总览加载失败';
    if (!silent) ElMessage.error(loadError.value);
  } finally {
    loading.value = false;
  }
}

async function refreshAll(): Promise<void> {
  loading.value = true;
  await Promise.all([
    loadOverview(true),
    servicesPanel.value?.refresh(true),
    eventsPanel.value?.refresh(true),
  ]);
  loading.value = false;
}

function updateServiceSummary(summary: ServiceSummary): void {
  if (state.value) state.value.serviceSummary = summary;
  runtime.running = summary.running;
  runtime.total = summary.total;
}

function updateEventSummary(openCount: number): void {
  if (state.value) state.value.events.openCount = openCount;
  runtime.openEventCount = openCount;
}

onMounted(() => void loadOverview());
</script>

<template>
  <el-skeleton v-if="loading && !state" :rows="8" animated />
  <div v-else class="overview-page">
    <article v-if="loadError" class="panel overview-error" role="alert">
      <div><strong>运行总览加载失败</strong><p>{{ loadError }}</p></div>
      <el-button size="small" :loading="loading" @click="refreshAll">重试</el-button>
    </article>
    <section v-if="state" class="panel overview-summary">
      <article class="summary-item">
        <span>运行服务</span>
        <div><strong>{{ state.serviceSummary.running }}/{{ state.serviceSummary.total }}</strong><small>{{ state.serviceSummary.degraded ? `${state.serviceSummary.degraded} 个需关注` : state.serviceSummary.stopped ? `${state.serviceSummary.stopped} 个已停止` : '全部正常' }}</small></div>
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
        <span>全局默认预设</span>
        <div><strong>{{ state.globalDefaultPresetId }}</strong><small>运行时已生效</small></div>
      </article>
      <article class="summary-item summary-events" :class="{ attention: state.events.openCount > 0 }">
        <span>待处理异常</span>
        <div><strong>{{ state.events.openCount }}</strong><small>{{ state.events.openCount ? '需要确认或处置' : '当前无异常' }}</small></div>
      </article>
      <button class="summary-refresh" :disabled="loading" @click="refreshAll">{{ loading ? '刷新中' : '刷新' }}</button>
    </section>
    <section v-if="state" class="overview-operations">
      <RuntimeServicesPanel ref="servicesPanel" @summary="updateServiceSummary" />
      <OperationalEventsPanel ref="eventsPanel" @summary="updateEventSummary" />
    </section>
  </div>
</template>

<style scoped>
.overview-page { display: grid; gap: 12px; }
.overview-error { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 13px 16px; border-color: #f3c9cf; color: #9b3141; background: #fff4f5; }
.overview-error strong { font-size: 12px; }
.overview-error p { margin: 4px 0 0; font-size: 10px; line-height: 1.5; }
.overview-summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)) 72px; overflow: hidden; }
.summary-item { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 11px 16px; border-right: 1px solid var(--line); }
.summary-item > span { flex: none; color: #7b8595; font-size: 10px; }
.summary-item div { min-width: 0; text-align: right; }
.summary-item strong, .summary-item small { display: block; }
.summary-item strong { overflow: hidden; color: #1f2937; font-size: 18px; line-height: 1.25; text-overflow: ellipsis; white-space: nowrap; }
.summary-item small { margin-top: 2px; color: #929aa8; font-size: 9px; }
.summary-model strong { font-size: 13px; }
.summary-events.attention strong { color: var(--danger); }
.summary-refresh { border: 0; color: #52647f; background: #fbfcfe; font-size: 11px; }
.summary-refresh:hover { color: #315abd; background: #f0f4fc; }
.summary-refresh:disabled { cursor: wait; opacity: .6; }
.overview-operations { display: grid; grid-template-columns: 1fr; gap: 12px; }
.overview-operations > * { min-width: 0; }

@media (max-width: 1100px) {
  .overview-summary { grid-template-columns: repeat(5, minmax(0, 1fr)) 64px; }
  .summary-item { align-items: flex-start; flex-direction: column; gap: 5px; }
  .summary-item div { width: 100%; text-align: left; }
}

@media (max-width: 760px) {
  .overview-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .summary-item { border-bottom: 1px solid var(--line); }
  .summary-item:nth-child(even) { border-right: 0; }
  .summary-events { grid-column: 1 / -1; border-right: 0; }
  .summary-refresh { grid-column: 1 / -1; min-height: 36px; border-top: 1px solid var(--line); }
}
</style>
