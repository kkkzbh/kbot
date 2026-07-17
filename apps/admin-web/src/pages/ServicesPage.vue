<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { BotServiceRuntimeState, BotServiceStatus } from '@contracts';
import PageHeader from '@/components/PageHeader.vue';
import { api, jsonBody } from '@/api/client';
import { useRuntimeStore } from '@/stores/runtime';

const services = ref<BotServiceStatus[]>([]);
const loading = ref(false);
const activeAction = ref('');
const runtime = useRuntimeStore();
const route = useRoute();
let timer: number | undefined;

const runtimeLabels: Record<BotServiceRuntimeState, string> = {
  healthy: '运行正常',
  degraded: '运行中 · 管理状态异常',
  stopped: '已停止',
  unknown: '状态未知',
};

function stateClass(state: BotServiceRuntimeState): string {
  if (state === 'healthy') return 'ok';
  if (state === 'degraded' || state === 'unknown') return 'warn';
  return 'error';
}

function runtimeLabel(state: BotServiceRuntimeState): string {
  return runtimeLabels[state];
}

async function load(silent = false): Promise<void> {
  if (!silent) loading.value = true;
  try {
    services.value = await api<BotServiceStatus[]>('/services');
    runtime.running = services.value.filter((item) => item.runtimeState === 'healthy' || item.runtimeState === 'degraded').length;
    runtime.total = services.value.length;
  } catch (error) {
    if (!silent) ElMessage.error(error instanceof Error ? error.message : '服务状态加载失败');
  } finally {
    if (!silent) loading.value = false;
  }
}

async function run(unit: string, action: string): Promise<void> {
  if (action === 'stop' || action === 'restart') {
    await ElMessageBox.confirm(`${action === 'stop' ? '停止' : '重启'} ${unit}？`, '确认服务操作', { type: 'warning' });
  }
  activeAction.value = `${unit}:${action}`;
  try {
    const result = await api<{ status: BotServiceStatus; apply: { restartRequired: boolean; reasons: string[] } }>('/services/action', {
      method: 'POST',
      body: jsonBody({ unit, action }),
    });
    const index = services.value.findIndex((item) => item.unit === unit);
    if (index >= 0) services.value[index] = result.status;
    runtime.updateApply(result.apply);
    await load(true);
    window.setTimeout(() => void load(true), action === 'restart' ? 1_800 : 500);
    ElMessage.success('服务操作已提交');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '服务操作失败');
  } finally {
    activeAction.value = '';
  }
}

function handleVisibility(): void {
  if (document.visibilityState === 'visible') void load(true);
}

function rowClassName({ row }: { row: BotServiceStatus }): string {
  return route.query.unit === row.unit ? 'selected-service-row' : '';
}

onMounted(() => {
  void load();
  timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void load(true);
  }, 5_000);
  document.addEventListener('visibilitychange', handleVisibility);
});
onBeforeUnmount(() => {
  window.clearInterval(timer);
  document.removeEventListener('visibilitychange', handleVisibility);
});
</script>

<template>
  <PageHeader hide-save>
    <template #actions><el-button :loading="loading" @click="load()">刷新状态</el-button></template>
  </PageHeader>
  <article class="panel">
    <div class="panel-head"><div><h2>受管服务</h2><p>每 5 秒刷新工作负载健康状态；systemd 控制状态保留为诊断信息</p></div></div>
    <el-table v-loading="loading" :data="services" :row-class-name="rowClassName" style="width:100%">
      <el-table-column label="服务" min-width="220"><template #default="scope"><strong>{{ scope.row.description }}</strong><div class="mono muted">{{ scope.row.unit }}</div></template></el-table-column>
      <el-table-column label="实时状态" min-width="190"><template #default="scope"><span class="state"><i class="status-dot" :class="stateClass(scope.row.runtimeState)" />{{ runtimeLabel(scope.row.runtimeState) }}</span><div class="health-detail">{{ scope.row.healthDetail }}</div></template></el-table-column>
      <el-table-column label="systemd" min-width="165"><template #default="scope"><strong class="controller-state">{{ scope.row.controllerState.activeState }} / {{ scope.row.controllerState.subState }}</strong><div class="mono muted">result: {{ scope.row.controllerState.result }}</div></template></el-table-column>
      <el-table-column label="开机状态" width="110"><template #default="scope">{{ scope.row.controllerState.unitFileState }}</template></el-table-column>
      <el-table-column label="检查时间" width="110"><template #default="scope">{{ new Date(scope.row.checkedAt).toLocaleTimeString() }}</template></el-table-column>
      <el-table-column label="操作" width="260" fixed="right"><template #default="scope"><div class="table-actions"><el-button size="small" :disabled="!scope.row.canStart" :loading="activeAction === `${scope.row.unit}:start`" @click="run(scope.row.unit, 'start')">启动</el-button><el-button size="small" :disabled="!scope.row.canRestart" :loading="activeAction === `${scope.row.unit}:restart`" @click="run(scope.row.unit, 'restart')">重启</el-button><el-button size="small" type="danger" plain :disabled="!scope.row.canStop" :loading="activeAction === `${scope.row.unit}:stop`" @click="run(scope.row.unit, 'stop')">停止</el-button></div></template></el-table-column>
    </el-table>
  </article>
</template>

<style scoped>
.state { display:inline-flex; align-items:center; gap:8px; color:#364152; font-size:11px; font-weight:650; }
strong { font-size:12px; }
.health-detail { max-width:360px; margin-top:4px; color:#8b94a3; font-size:9px; line-height:1.45; }
.controller-state { color:#505b6e; font-size:10px; }
:deep(.selected-service-row td) { background:#f2f6ff !important; }
</style>
