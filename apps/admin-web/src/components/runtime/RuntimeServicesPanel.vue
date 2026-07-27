<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { BotServiceRuntimeState, BotServiceStatus } from '@contracts';
import EmptyState from '@/components/EmptyState.vue';
import { rawApi, rawJsonBody } from '@/api/client';
import { useRuntimeStore } from '@/stores/runtime';

export type ServiceSummary = {
  total: number;
  running: number;
  healthy: number;
  degraded: number;
  stopped: number;
};

const emit = defineEmits<{ summary: [value: ServiceSummary] }>();
const route = useRoute();
const runtime = useRuntimeStore();
const services = ref<BotServiceStatus[]>([]);
const loading = ref(false);
const loadError = ref('');
const activeAction = ref('');
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

function publishSummary(): void {
  const summary: ServiceSummary = {
    total: services.value.length,
    running: services.value.filter((item) => item.runtimeState === 'healthy' || item.runtimeState === 'degraded').length,
    healthy: services.value.filter((item) => item.runtimeState === 'healthy').length,
    degraded: services.value.filter((item) => item.runtimeState === 'degraded').length,
    stopped: services.value.filter((item) => item.runtimeState === 'stopped').length,
  };
  runtime.running = summary.running;
  runtime.total = summary.total;
  emit('summary', summary);
}

async function focusSelectedService(): Promise<void> {
  const selectedUnit = typeof route.query.service === 'string' ? route.query.service : '';
  if (!selectedUnit) return;
  await nextTick();
  document.getElementById(`runtime-service-${selectedUnit}`)?.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
  });
}

async function load(silent = false): Promise<void> {
  if (!silent) loading.value = true;
  try {
    services.value = await rawApi<BotServiceStatus[]>('/services');
    loadError.value = '';
    publishSummary();
    await focusSelectedService();
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '服务状态加载失败';
    if (!silent) ElMessage.error(loadError.value);
  } finally {
    if (!silent) loading.value = false;
  }
}

async function confirmAction(unit: string, action: 'stop' | 'restart'): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      `${action === 'stop' ? '停止' : '重启'} ${unit}？`,
      '确认服务操作',
      { type: 'warning' },
    );
    return true;
  } catch {
    return false;
  }
}

async function run(unit: string, action: 'start' | 'stop' | 'restart' | 'enable'): Promise<void> {
  if ((action === 'stop' || action === 'restart') && !await confirmAction(unit, action)) return;
  activeAction.value = `${unit}:${action}`;
  try {
    const result = await rawApi<{ status: BotServiceStatus; apply: { restartRequired: boolean; reasons: string[] } }>('/services/action', {
      method: 'POST',
      body: rawJsonBody({ unit, action }),
    });
    const index = services.value.findIndex((item) => item.unit === unit);
    if (index >= 0) services.value[index] = result.status;
    publishSummary();
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

watch(() => route.query.service, () => void focusSelectedService());
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

defineExpose({ refresh: load });
</script>

<template>
  <article class="panel service-panel">
    <div class="panel-head">
      <div>
        <h2>服务管理</h2>
        <p>实时健康、systemd 控制状态与生命周期操作</p>
      </div>
      <el-button size="small" :loading="loading" @click="load()">刷新状态</el-button>
    </div>
    <div v-if="loadError" class="panel-error" role="alert">
      <div><strong>服务状态加载失败</strong><p>{{ loadError }}</p></div>
      <el-button size="small" @click="load()">重试</el-button>
    </div>
    <div v-if="services.length" v-loading="loading" class="service-list">
      <section
        v-for="service in services"
        :id="`runtime-service-${service.unit}`"
        :key="service.unit"
        class="service-row"
        :class="{ selected: route.query.service === service.unit }"
      >
        <div class="service-identity">
          <strong>{{ service.description }}</strong>
          <span class="mono muted">{{ service.unit }}</span>
        </div>
        <div class="service-health">
          <span class="service-state">
            <i class="status-dot" :class="stateClass(service.runtimeState)" />
            {{ runtimeLabels[service.runtimeState] }}
          </span>
          <p>{{ service.healthDetail }}</p>
          <small>
            systemd {{ service.controllerState.activeState }}/{{ service.controllerState.subState }}
            · result {{ service.controllerState.result }}
            · {{ service.controllerState.unitFileState }}
            · {{ new Date(service.checkedAt).toLocaleTimeString() }}
          </small>
        </div>
        <div class="service-actions">
          <el-button
            v-if="service.canEnable"
            size="small"
            :loading="activeAction === `${service.unit}:enable`"
            @click="run(service.unit, 'enable')"
          >
            启用
          </el-button>
          <el-button
            size="small"
            :disabled="!service.canStart"
            :loading="activeAction === `${service.unit}:start`"
            @click="run(service.unit, 'start')"
          >
            启动
          </el-button>
          <el-button
            size="small"
            :disabled="!service.canRestart"
            :loading="activeAction === `${service.unit}:restart`"
            @click="run(service.unit, 'restart')"
          >
            重启
          </el-button>
          <el-button
            size="small"
            type="danger"
            plain
            :disabled="!service.canStop"
            :loading="activeAction === `${service.unit}:stop`"
            @click="run(service.unit, 'stop')"
          >
            停止
          </el-button>
        </div>
      </section>
    </div>
    <EmptyState v-else title="没有可管理的服务" description="服务清单为空或尚未加载。" />
  </article>
</template>

<style scoped>
.service-panel { min-width: 0; overflow: hidden; }
.panel-error { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 14px; border-bottom: 1px solid #f3c9cf; color: #9b3141; background: #fff4f5; }
.panel-error strong { font-size: 11px; }
.panel-error p { margin: 3px 0 0; font-size: 10px; line-height: 1.45; }
.service-list { max-height: 720px; overflow: auto; }
.service-row {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(170px, .75fr) minmax(260px, 1.25fr) auto;
  align-items: center;
  gap: 16px;
  padding: 12px 14px;
  border-top: 1px solid var(--line);
  transition: background .16s ease, box-shadow .16s ease;
}
.service-row:first-child { border-top: 0; }
.service-row.selected { background: #f1f5ff; box-shadow: inset 3px 0 0 var(--accent); }
.service-identity, .service-health { min-width: 0; }
.service-identity strong, .service-identity span { display: block; }
.service-identity strong { color: #364152; font-size: 11px; }
.service-identity span { margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.service-state { display: inline-flex; align-items: center; gap: 8px; color: #364152; font-size: 11px; font-weight: 650; }
.service-health p { margin: 5px 0 0; color: #7d8797; font-size: 10px; line-height: 1.45; }
.service-health small { display: block; margin-top: 4px; color: #9aa2af; font-size: 9px; line-height: 1.45; }
.service-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
.service-actions :deep(.el-button + .el-button) { margin-left: 0; }

@media (max-width: 900px) {
  .service-row { grid-template-columns: minmax(150px, .7fr) minmax(230px, 1.3fr); }
  .service-actions { grid-column: 1 / -1; justify-content: flex-start; }
}

@media (max-width: 620px) {
  .service-row { grid-template-columns: 1fr; }
  .service-actions { grid-column: auto; }
}
</style>
