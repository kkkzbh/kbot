<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import PageHeader from '@/components/PageHeader.vue';
import { api, jsonBody } from '@/api/client';
import { useRuntimeStore } from '@/stores/runtime';

const services = ref<any[]>([]);
const loading = ref(false);
const activeAction = ref('');
const runtime = useRuntimeStore();

async function load() {
  loading.value = true;
  try {
    services.value = await api<any[]>('/services');
    runtime.running = services.value.filter((item) => item.activeState === 'active').length;
    runtime.total = services.value.length;
  } finally { loading.value = false; }
}

async function run(unit: string, action: string) {
  if (action === 'stop' || action === 'restart') {
    await ElMessageBox.confirm(`${action === 'stop' ? '停止' : '重启'} ${unit}？`, '确认服务操作', { type: 'warning' });
  }
  activeAction.value = `${unit}:${action}`;
  try {
    const result = await api<any>('/services/action', { method: 'POST', body: jsonBody({ unit, action }) });
    const index = services.value.findIndex((item) => item.unit === unit);
    if (index >= 0) services.value[index] = result.status;
    runtime.updateApply(result.apply);
    ElMessage.success('服务操作已提交');
    window.setTimeout(load, action === 'restart' ? 1800 : 400);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '服务操作失败');
  } finally { activeAction.value = ''; }
}

onMounted(load);
</script>

<template>
  <PageHeader hide-save>
    <template #actions><el-button :loading="loading" @click="load">刷新状态</el-button></template>
  </PageHeader>
  <article class="panel">
    <div class="panel-head"><div><h2>受管服务</h2><p>操作直接作用于当前运行角色允许管理的 systemd units</p></div></div>
    <el-table v-loading="loading" :data="services" style="width:100%">
      <el-table-column label="服务" min-width="230"><template #default="scope"><strong>{{ scope.row.description }}</strong><div class="mono muted">{{ scope.row.unit }}</div></template></el-table-column>
      <el-table-column label="Load" width="100" prop="loadState" />
      <el-table-column label="Active" width="120"><template #default="scope"><span class="state"><i class="status-dot" :class="scope.row.activeState === 'active' ? 'ok' : scope.row.activeState === 'failed' ? 'error' : 'warn'" />{{ scope.row.activeState }}</span></template></el-table-column>
      <el-table-column label="Sub" width="110" prop="subState" />
      <el-table-column label="开机状态" width="120" prop="unitFileState" />
      <el-table-column label="操作" width="260" fixed="right"><template #default="scope"><div class="table-actions"><el-button size="small" :disabled="!scope.row.canStart" :loading="activeAction === `${scope.row.unit}:start`" @click="run(scope.row.unit, 'start')">启动</el-button><el-button size="small" :disabled="!scope.row.canRestart" :loading="activeAction === `${scope.row.unit}:restart`" @click="run(scope.row.unit, 'restart')">重启</el-button><el-button size="small" type="danger" plain :disabled="!scope.row.canStop" :loading="activeAction === `${scope.row.unit}:stop`" @click="run(scope.row.unit, 'stop')">停止</el-button></div></template></el-table-column>
    </el-table>
  </article>
</template>

<style scoped>.state { display:inline-flex; align-items:center; gap:8px; font-size:11px; } strong { font-size:12px; }</style>
