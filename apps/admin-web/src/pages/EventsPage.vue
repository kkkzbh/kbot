<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type {
  OperationalEventAction,
  OperationalEventBulkAcknowledgeResult,
  OperationalEventDetail,
  OperationalEventItem,
  OperationalEventPage,
} from '@contracts';
import EmptyState from '@/components/EmptyState.vue';
import PageHeader from '@/components/PageHeader.vue';
import { rawApi, rawJsonBody } from '@/api/client';
import { useRuntimeStore } from '@/stores/runtime';

const route = useRoute();
const router = useRouter();
const runtime = useRuntimeStore();
const view = ref<'pending' | 'history'>(route.query.view === 'history' ? 'history' : 'pending');
const items = ref<OperationalEventItem[]>([]);
const loading = ref(false);
const activeAction = ref('');
const bulkAcknowledging = ref(false);
const detail = ref<OperationalEventDetail | null>(null);
const drawerOpen = ref(false);
const page = reactive({ current: 1, pageSize: 20, total: 0 });
let timer: number | undefined;

function sourceLabel(item: OperationalEventItem): string {
  return item.source === 'systemd' ? '服务' : item.type === 'memory_job_dead_letter' ? '记忆任务' : '记忆审核';
}

function statusLabel(item: OperationalEventItem): string {
  if (item.status === 'open') return '待处理';
  if (item.status === 'acknowledged') return '已确认';
  const resolution = {
    recovered: '已恢复',
    retried: '已重试',
    discarded: '已丢弃',
    completed: '已完成',
  } as const;
  return item.resolution ? resolution[item.resolution] : '已解决';
}

function statusType(item: OperationalEventItem): 'danger' | 'warning' | 'success' | 'info' {
  if (item.status === 'resolved') return 'success';
  if (item.status === 'acknowledged') return 'info';
  return item.severity === 'error' ? 'danger' : 'warning';
}

async function load(silent = false): Promise<void> {
  if (!silent) loading.value = true;
  try {
    const query = new URLSearchParams({ view: view.value, page: String(page.current), pageSize: String(page.pageSize) });
    const result = await rawApi<OperationalEventPage>(`/events?${query}`);
    items.value = result.items;
    page.total = result.total;
    runtime.openEventCount = result.openCount;
  } catch (error) {
    if (!silent) ElMessage.error(error instanceof Error ? error.message : '事件列表加载失败');
  } finally {
    if (!silent) loading.value = false;
  }
}

async function openDetail(item: OperationalEventItem): Promise<void> {
  drawerOpen.value = true;
  detail.value = null;
  try {
    detail.value = await rawApi<OperationalEventDetail>(`/events/${item.id}`);
    await router.replace({ query: { ...route.query, id: String(item.id), view: view.value } });
  } catch (error) {
    drawerOpen.value = false;
    ElMessage.error(error instanceof Error ? error.message : '事件详情加载失败');
  }
}

async function runAction(item: OperationalEventItem, action: OperationalEventAction): Promise<void> {
  if (action === 'retry' || action === 'discard') {
    const label = action === 'retry' ? '重试这个事件对应的操作' : '永久丢弃这个 dead-letter job';
    await ElMessageBox.confirm(`${label}？`, '确认事件操作', { type: action === 'discard' ? 'error' : 'warning' });
  }
  activeAction.value = `${item.id}:${action}`;
  try {
    const updated = await rawApi<OperationalEventItem>(`/events/${item.id}/action`, {
      method: 'POST',
      body: rawJsonBody({ action }),
    });
    ElMessage.success(action === 'acknowledge' ? '事件已确认' : action === 'retry' ? '重试已执行' : '任务已丢弃');
    await load(true);
    if (drawerOpen.value && detail.value?.id === item.id) detail.value = await rawApi<OperationalEventDetail>(`/events/${updated.id}`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '事件操作失败');
  } finally {
    activeAction.value = '';
  }
}

async function acknowledgeAll(): Promise<void> {
  bulkAcknowledging.value = true;
  try {
    const result = await rawApi<OperationalEventBulkAcknowledgeResult>('/events/acknowledge-all', { method: 'POST' });
    page.current = 1;
    page.total = 0;
    items.value = [];
    runtime.openEventCount = 0;
    await load(true);
    if (drawerOpen.value && detail.value) {
      try {
        detail.value = await rawApi<OperationalEventDetail>(`/events/${detail.value.id}`);
      } catch (error) {
        ElMessage.warning(error instanceof Error ? `事件详情刷新失败：${error.message}` : '事件详情刷新失败');
      }
    }
    ElMessage.success(result.acknowledgedCount
      ? `已确认 ${result.acknowledgedCount} 条待处理事件`
      : '当前没有待处理事件');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '一键确认失败');
  } finally {
    bulkAcknowledging.value = false;
  }
}

function closeDrawer(): void {
  const query = { ...route.query };
  delete query.id;
  void router.replace({ query });
}

watch(view, async () => {
  page.current = 1;
  await router.replace({ query: { view: view.value } });
  await load();
});

onMounted(async () => {
  await load();
  const selectedId = Number(route.query.id);
  if (Number.isInteger(selectedId) && selectedId > 0) {
    const selected = items.value.find((item) => item.id === selectedId);
    if (selected) await openDetail(selected);
  }
  timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void load(true);
  }, 10_000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <PageHeader hide-save>
    <template #actions><el-button :loading="loading" @click="load()">刷新事件</el-button></template>
  </PageHeader>
  <article class="panel event-panel">
    <div class="panel-head"><div><h2>事件中心</h2><p>运行故障、dead letter 与人工审核的统一处理入口</p></div></div>
    <div class="event-tabs-toolbar">
      <el-tabs v-model="view" class="event-tabs">
        <el-tab-pane name="pending"><template #label>待处理 <el-badge v-if="runtime.openEventCount" :value="runtime.openEventCount" :max="99" /></template></el-tab-pane>
        <el-tab-pane label="事件历史" name="history" />
      </el-tabs>
      <el-button
        v-if="view === 'pending'"
        size="small"
        type="primary"
        plain
        :disabled="runtime.openEventCount === 0 || Boolean(activeAction)"
        :loading="bulkAcknowledging"
        @click="acknowledgeAll"
      >
        一键确认
      </el-button>
    </div>
    <el-table v-if="items.length" v-loading="loading" :data="items" style="width:100%" @row-click="openDetail">
      <el-table-column label="事件" min-width="340"><template #default="scope"><strong>{{ scope.row.title }}</strong><p>{{ scope.row.summary }}</p></template></el-table-column>
      <el-table-column label="来源" width="110"><template #default="scope">{{ sourceLabel(scope.row) }}</template></el-table-column>
      <el-table-column label="状态" width="110"><template #default="scope"><el-tag size="small" :type="statusType(scope.row)" effect="light">{{ statusLabel(scope.row) }}</el-tag></template></el-table-column>
      <el-table-column label="发生时间" width="175"><template #default="scope">{{ new Date(scope.row.occurredAt).toLocaleString() }}</template></el-table-column>
      <el-table-column v-if="view === 'pending'" label="操作" width="230" fixed="right"><template #default="scope"><div class="table-actions" @click.stop><el-button v-if="scope.row.availableActions.includes('acknowledge')" size="small" :disabled="bulkAcknowledging" :loading="activeAction === `${scope.row.id}:acknowledge`" @click="runAction(scope.row, 'acknowledge')">确认</el-button><el-button v-if="scope.row.availableActions.includes('retry')" size="small" type="primary" plain :disabled="bulkAcknowledging" :loading="activeAction === `${scope.row.id}:retry`" @click="runAction(scope.row, 'retry')">重试</el-button><el-button v-if="scope.row.availableActions.includes('discard')" size="small" type="danger" plain :disabled="bulkAcknowledging" :loading="activeAction === `${scope.row.id}:discard`" @click="runAction(scope.row, 'discard')">丢弃</el-button></div></template></el-table-column>
    </el-table>
    <EmptyState v-else :title="view === 'pending' ? '当前没有待处理事件' : '当前没有历史事件'" description="事件采集器每 10 秒同步一次。" />
    <div v-if="page.total > page.pageSize" class="event-pagination"><el-pagination layout="total, prev, pager, next" :current-page="page.current" :page-size="page.pageSize" :total="page.total" @current-change="page.current=$event;load()" /></div>
  </article>

  <el-drawer v-model="drawerOpen" title="事件详情" size="min(720px, 92vw)" @closed="closeDrawer">
    <div v-if="detail" class="event-detail">
      <header><el-tag :type="statusType(detail)" effect="light">{{ statusLabel(detail) }}</el-tag><span>{{ sourceLabel(detail) }}</span></header>
      <h2>{{ detail.title }}</h2>
      <p>{{ detail.summary }}</p>
      <dl>
        <dt>发生时间</dt><dd>{{ new Date(detail.occurredAt).toLocaleString() }}</dd>
        <dt>当前状态</dt><dd>{{ statusLabel(detail) }}</dd>
        <dt v-if="detail.resolvedAt">解决时间</dt><dd v-if="detail.resolvedAt">{{ new Date(detail.resolvedAt).toLocaleString() }}</dd>
        <dt v-if="detail.unit">服务</dt><dd v-if="detail.unit" class="mono">{{ detail.unit }}</dd>
        <dt v-if="detail.invocationId">Invocation</dt><dd v-if="detail.invocationId" class="mono">{{ detail.invocationId }}</dd>
      </dl>
      <div class="detail-actions"><el-button @click="router.push(detail.targetPath)">打开对应页面</el-button><el-button v-if="detail.availableActions.includes('acknowledge')" :disabled="bulkAcknowledging" @click="runAction(detail, 'acknowledge')">确认已知</el-button><el-button v-if="detail.availableActions.includes('retry')" type="primary" plain :disabled="bulkAcknowledging" @click="runAction(detail, 'retry')">重试</el-button><el-button v-if="detail.availableActions.includes('discard')" type="danger" plain :disabled="bulkAcknowledging" @click="runAction(detail, 'discard')">丢弃</el-button></div>
      <section v-if="detail.journal.length" class="journal"><h3>对应 journal</h3><pre>{{ detail.journal.join('\n') }}</pre></section>
    </div>
  </el-drawer>
</template>

<style scoped>
.event-panel { overflow:hidden; }
.event-tabs-toolbar { display:flex; align-items:center; gap:16px; padding:0 16px; border-bottom:1px solid var(--line); }
.event-tabs { min-width:0; flex:1; }
.event-tabs :deep(.el-tabs__header) { margin:0; }
.event-tabs :deep(.el-tabs__nav-wrap::after) { display:none; }
.event-tabs :deep(.el-badge) { margin-left:8px; }
.event-panel strong { color:#374151; font-size:11px; }
.event-panel p { max-width:680px; overflow:hidden; margin:4px 0 0; color:#7d8797; font-size:10px; line-height:1.45; text-overflow:ellipsis; white-space:nowrap; }
.event-pagination { display:flex; justify-content:flex-end; padding:14px 18px; border-top:1px solid var(--line); }
.event-detail header { display:flex; align-items:center; gap:10px; color:#7d8797; font-size:11px; }
.event-detail h2 { margin:18px 0 8px; color:#273142; font-size:20px; }
.event-detail > p { color:#657084; line-height:1.65; }
.event-detail dl { display:grid; grid-template-columns:100px minmax(0,1fr); gap:9px 14px; margin:22px 0; padding:16px; border:1px solid var(--line); border-radius:9px; background:#fafbfc; font-size:11px; }
.event-detail dt { color:#8a94a3; }
.event-detail dd { min-width:0; margin:0; overflow-wrap:anywhere; color:#4b5565; }
.detail-actions { display:flex; flex-wrap:wrap; gap:8px; }
.journal { margin-top:24px; }
.journal h3 { color:#3c4658; font-size:12px; }
.journal pre { max-height:420px; overflow:auto; padding:14px; border-radius:8px; color:#d9e2ef; background:#18202c; font-size:10px; line-height:1.55; white-space:pre-wrap; }
</style>
