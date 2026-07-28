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
.overview-operations { display: grid; grid-template-columns: 1fr; gap: 12px; }
.overview-operations > * { min-width: 0; }
</style>
