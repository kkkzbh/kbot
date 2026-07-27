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
import { rawApi, rawJsonBody } from '@/api/client';
import { useRuntimeStore } from '@/stores/runtime';

const emit = defineEmits<{ summary: [openCount: number] }>();
const route = useRoute();
const router = useRouter();
const runtime = useRuntimeStore();
const view = ref<'pending' | 'history'>(route.query.eventView === 'history' ? 'history' : 'pending');
const items = ref<OperationalEventItem[]>([]);
const loading = ref(false);
const loadError = ref('');
const activeAction = ref('');
const bulkAcknowledging = ref(false);
const detail = ref<OperationalEventDetail | null>(null);
const drawerOpen = ref(false);
const page = reactive({ current: 1, pageSize: 20, total: 0 });
let mounted = false;
let timer: number | undefined;

function sourceLabel(item: OperationalEventItem): string {
  if (item.source === 'systemd') return '服务';
  if (item.source === 'runtime') return item.component || '运行时';
  return item.type === 'memory_job_dead_letter' ? '记忆任务' : '记忆审核';
}

function statusLabel(item: OperationalEventItem): string {
  if (item.status === 'open') return '待处理';
  if (item.status === 'acknowledged') return '已确认';
  const resolution = {
    recovered: '已恢复',
    retried: '已重试',
    discarded: '已丢弃',
    completed: '已完成',
    deduplicated: '已合并',
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
    const requestPage = async (): Promise<OperationalEventPage> => {
      const query = new URLSearchParams({
        view: view.value,
        page: String(page.current),
        pageSize: String(page.pageSize),
      });
      return rawApi<OperationalEventPage>(`/events?${query}`);
    };
    let result = await requestPage();
    const lastPage = Math.max(1, Math.ceil(result.total / page.pageSize));
    if (page.current > lastPage) {
      page.current = lastPage;
      result = await requestPage();
    }
    loadError.value = '';
    items.value = result.items;
    page.total = result.total;
    runtime.openEventCount = result.openCount;
    emit('summary', result.openCount);
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '事件列表加载失败';
    if (!silent) ElMessage.error(loadError.value);
  } finally {
    if (!silent) loading.value = false;
  }
}

async function loadDetail(id: number): Promise<void> {
  drawerOpen.value = true;
  detail.value = null;
  try {
    detail.value = await rawApi<OperationalEventDetail>(`/events/${id}`);
  } catch (error) {
    drawerOpen.value = false;
    ElMessage.error(error instanceof Error ? error.message : '事件详情加载失败');
  }
}

async function openDetail(item: OperationalEventItem): Promise<void> {
  await router.replace({
    query: {
      ...route.query,
      event: String(item.id),
      eventView: view.value,
    },
  });
}

async function confirmEventAction(action: 'retry' | 'discard'): Promise<boolean> {
  const label = action === 'retry' ? '重试这个事件对应的操作' : '永久丢弃这个 dead-letter job';
  try {
    await ElMessageBox.confirm(
      `${label}？`,
      '确认事件操作',
      { type: action === 'discard' ? 'error' : 'warning' },
    );
    return true;
  } catch {
    return false;
  }
}

async function runAction(item: OperationalEventItem, action: OperationalEventAction): Promise<void> {
  if ((action === 'retry' || action === 'discard') && !await confirmEventAction(action)) return;
  activeAction.value = `${item.id}:${action}`;
  try {
    const updated = await rawApi<OperationalEventItem>(`/events/${item.id}/action`, {
      method: 'POST',
      body: rawJsonBody({ action }),
    });
    ElMessage.success(action === 'acknowledge' ? '事件已确认' : action === 'retry' ? '重试已执行' : '任务已丢弃');
    await load(true);
    if (drawerOpen.value && detail.value?.id === item.id) {
      detail.value = await rawApi<OperationalEventDetail>(`/events/${updated.id}`);
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '事件操作失败');
  } finally {
    activeAction.value = '';
  }
}

async function acknowledgeAll(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认全部 ${runtime.openEventCount} 条待处理事件？事件会保留在历史记录中。`,
      '确认全部事件',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  bulkAcknowledging.value = true;
  try {
    const result = await rawApi<OperationalEventBulkAcknowledgeResult>('/events/acknowledge-all', { method: 'POST' });
    page.current = 1;
    page.total = 0;
    items.value = [];
    runtime.openEventCount = 0;
    emit('summary', 0);
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

async function closeDrawer(): Promise<void> {
  if (route.name !== 'overview' || route.query.event === undefined) return;
  const query = { ...route.query };
  delete query.event;
  await router.replace({ query });
}

async function openTarget(): Promise<void> {
  if (!detail.value) return;
  drawerOpen.value = false;
  await router.push(detail.value.targetPath);
}

async function changePage(current: number): Promise<void> {
  page.current = current;
  await load();
}

watch(view, async () => {
  if (!mounted) return;
  page.current = 1;
  const query = { ...route.query };
  query.eventView = view.value;
  delete query.event;
  await router.replace({ query });
  await load();
});

watch(() => route.query.event, (value) => {
  if (!mounted) return;
  const selectedId = Number(value);
  if (Number.isInteger(selectedId) && selectedId > 0) {
    if (detail.value?.id !== selectedId) void loadDetail(selectedId);
    return;
  }
  drawerOpen.value = false;
  detail.value = null;
});

onMounted(async () => {
  mounted = true;
  await load();
  const selectedId = Number(route.query.event);
  if (Number.isInteger(selectedId) && selectedId > 0) await loadDetail(selectedId);
  timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void load(true);
  }, 10_000);
});
onBeforeUnmount(() => window.clearInterval(timer));

defineExpose({ refresh: load });
</script>

<template>
  <article class="panel event-panel">
    <div class="panel-head">
      <div>
        <h2>异常与事件</h2>
        <p>服务、模型、工具、后台任务及业务插件异常的统一处理入口</p>
      </div>
      <el-button size="small" :loading="loading" @click="load()">刷新事件</el-button>
    </div>
    <div v-if="loadError" class="panel-error" role="alert">
      <div><strong>异常事件加载失败</strong><p>{{ loadError }}</p></div>
      <el-button size="small" @click="load()">重试</el-button>
    </div>
    <div class="event-tabs-toolbar">
      <el-tabs v-model="view" class="event-tabs">
        <el-tab-pane name="pending">
          <template #label>
            待处理
            <span v-if="runtime.openEventCount" class="event-count">
              {{ runtime.openEventCount > 99 ? '99+' : runtime.openEventCount }}
            </span>
          </template>
        </el-tab-pane>
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
        全部确认
      </el-button>
    </div>
    <div v-if="items.length" v-loading="loading" class="event-list">
      <article
        v-for="item in items"
        :key="item.id"
        class="event-row"
      >
        <button type="button" class="event-open" @click="openDetail(item)">
          <div class="event-row-head">
            <div class="event-title">
              <i class="status-dot" :class="item.severity === 'error' ? 'error' : 'warn'" />
              <strong>{{ item.title }}</strong>
              <el-tag v-if="item.occurrenceCount > 1" size="small" type="info" effect="plain">
                {{ item.occurrenceCount }} 次
              </el-tag>
            </div>
            <el-tag size="small" :type="statusType(item)" effect="light">{{ statusLabel(item) }}</el-tag>
          </div>
          <p>{{ item.summary }}</p>
          <div class="event-meta">
            <span>{{ sourceLabel(item) }}</span>
            <span>{{ new Date(item.lastOccurredAt).toLocaleString() }}</span>
          </div>
        </button>
        <div v-if="view === 'pending'" class="event-actions" @click.stop>
          <el-button
            v-if="item.availableActions.includes('acknowledge')"
            size="small"
            :disabled="bulkAcknowledging"
            :loading="activeAction === `${item.id}:acknowledge`"
            @click="runAction(item, 'acknowledge')"
          >
            确认
          </el-button>
          <el-button
            v-if="item.availableActions.includes('retry')"
            size="small"
            type="primary"
            plain
            :disabled="bulkAcknowledging"
            :loading="activeAction === `${item.id}:retry`"
            @click="runAction(item, 'retry')"
          >
            重试
          </el-button>
          <el-button
            v-if="item.availableActions.includes('discard')"
            size="small"
            type="danger"
            plain
            :disabled="bulkAcknowledging"
            :loading="activeAction === `${item.id}:discard`"
            @click="runAction(item, 'discard')"
          >
            丢弃
          </el-button>
        </div>
      </article>
    </div>
    <EmptyState
      v-else
      :title="view === 'pending' ? '当前没有待处理事件' : '当前没有历史事件'"
      description="事件采集器每 10 秒同步一次。"
    />
    <div v-if="page.total > page.pageSize" class="event-pagination">
      <span>共 {{ page.total }} 条</span>
      <el-pagination
        size="small"
        :pager-count="5"
        layout="prev, pager, next"
        :current-page="page.current"
        :page-size="page.pageSize"
        :total="page.total"
        @current-change="changePage"
      />
    </div>
  </article>

  <el-drawer v-model="drawerOpen" title="事件详情" size="min(720px, 92vw)" @closed="closeDrawer">
    <div v-if="detail" class="event-detail">
      <header>
        <el-tag :type="statusType(detail)" effect="light">{{ statusLabel(detail) }}</el-tag>
        <span>{{ sourceLabel(detail) }}</span>
      </header>
      <h2>{{ detail.title }}</h2>
      <p>{{ detail.summary }}</p>
      <dl>
        <dt>首次发生</dt><dd>{{ new Date(detail.occurredAt).toLocaleString() }}</dd>
        <dt>最近发生</dt><dd>{{ new Date(detail.lastOccurredAt).toLocaleString() }}</dd>
        <dt>累计次数</dt><dd>{{ detail.occurrenceCount }}</dd>
        <dt v-if="detail.occurrences.length">内容类型</dt><dd v-if="detail.occurrences.length">{{ detail.occurrences.length }}</dd>
        <dt v-if="detail.component">组件</dt><dd v-if="detail.component" class="mono">{{ detail.component }}</dd>
        <dt>当前状态</dt><dd>{{ statusLabel(detail) }}</dd>
        <dt v-if="detail.resolvedAt">解决时间</dt><dd v-if="detail.resolvedAt">{{ new Date(detail.resolvedAt).toLocaleString() }}</dd>
        <dt v-if="detail.unit">服务</dt><dd v-if="detail.unit" class="mono">{{ detail.unit }}</dd>
        <dt v-if="detail.invocationId">Invocation</dt><dd v-if="detail.invocationId" class="mono">{{ detail.invocationId }}</dd>
        <dt v-if="detail.fingerprint">Fingerprint</dt><dd v-if="detail.fingerprint" class="mono">{{ detail.fingerprint }}</dd>
      </dl>
      <div class="detail-actions">
        <el-button @click="openTarget">打开对应位置</el-button>
        <el-button
          v-if="detail.availableActions.includes('acknowledge')"
          :disabled="bulkAcknowledging"
          @click="runAction(detail, 'acknowledge')"
        >
          确认已知
        </el-button>
        <el-button
          v-if="detail.availableActions.includes('retry')"
          type="primary"
          plain
          :disabled="bulkAcknowledging"
          @click="runAction(detail, 'retry')"
        >
          重试
        </el-button>
        <el-button
          v-if="detail.availableActions.includes('discard')"
          type="danger"
          plain
          :disabled="bulkAcknowledging"
          @click="runAction(detail, 'discard')"
        >
          丢弃
        </el-button>
      </div>
      <section v-if="!detail.occurrences.length" class="cause">
        <h3>异常原因</h3>
        <pre>{{ detail.details }}</pre>
      </section>
      <section v-if="detail.occurrences.length" class="occurrences">
        <h3>归并内容</h3>
        <p>按实际内容与来源归并，同一事件的不同原因均保留在这里。</p>
        <article v-for="occurrence in detail.occurrences" :key="occurrence.id">
          <header>
            <strong>{{ occurrence.occurrenceCount }} 次</strong>
            <span v-if="occurrence.unit" class="mono">{{ occurrence.unit }}</span>
            <span>{{ new Date(occurrence.firstOccurredAt).toLocaleString() }} – {{ new Date(occurrence.lastOccurredAt).toLocaleString() }}</span>
          </header>
          <p>{{ occurrence.summary }}</p>
          <pre>{{ occurrence.details }}</pre>
        </article>
      </section>
      <section v-if="detail.journal.length" class="journal">
        <h3>对应 journal</h3>
        <pre>{{ detail.journal.join('\n') }}</pre>
      </section>
    </div>
  </el-drawer>
</template>

<style scoped>
.event-panel { min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.panel-error { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 14px; border-bottom: 1px solid #f3c9cf; color: #9b3141; background: #fff4f5; }
.panel-error strong { font-size: 11px; }
.panel-error p { margin: 3px 0 0; font-size: 10px; line-height: 1.45; }
.event-tabs-toolbar { display: flex; align-items: center; gap: 16px; padding: 0 16px; border-bottom: 1px solid var(--line); }
.event-tabs { min-width: 0; flex: 1; }
.event-tabs :deep(.el-tabs__header) { margin: 0; }
.event-tabs :deep(.el-tabs__nav-wrap::after) { display: none; }
.event-count { min-width: 18px; height: 17px; display: inline-flex; align-items: center; justify-content: center; margin-left: 7px; padding: 0 5px; border-radius: 9px; color: #fff; background: var(--danger); font-size: 9px; font-weight: 700; }
.event-list { max-height: 640px; overflow: auto; }
.event-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 11px 14px; border-top: 1px solid var(--line); transition: background .16s ease; }
.event-row:first-child { border-top: 0; }
.event-row:hover { background: #f7f9fd; }
.event-open { width: 100%; padding: 0; border: 0; outline: 0; color: inherit; background: transparent; text-align: left; }
.event-open:focus-visible { border-radius: 5px; box-shadow: 0 0 0 2px rgba(60, 103, 227, .22); }
.event-row-head, .event-title, .event-meta, .event-actions { display: flex; align-items: center; }
.event-row-head { justify-content: space-between; gap: 10px; }
.event-title { min-width: 0; gap: 8px; }
.event-title .status-dot { flex: none; }
.event-title strong { overflow: hidden; color: #374151; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.event-open p { display: -webkit-box; overflow: hidden; margin: 5px 0 0 15px; color: #7d8797; font-size: 10px; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.event-meta { justify-content: space-between; gap: 12px; margin: 6px 0 0 15px; color: #9aa2af; font-size: 9px; }
.event-actions { align-items: stretch; flex-direction: column; justify-content: center; gap: 4px; }
.event-actions :deep(.el-button + .el-button) { margin-left: 0; }
.event-pagination { min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 14px; border-top: 1px solid var(--line); color: #8a94a3; font-size: 10px; }
.event-pagination > span { flex: none; }
.event-pagination :deep(.el-pagination) { min-width: 0; overflow: hidden; }
.event-detail header { display: flex; align-items: center; gap: 10px; color: #7d8797; font-size: 11px; }
.event-detail h2 { margin: 18px 0 8px; color: #273142; font-size: 20px; }
.event-detail > p { color: #657084; line-height: 1.65; }
.event-detail dl { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 9px 14px; margin: 22px 0; padding: 16px; border: 1px solid var(--line); border-radius: 9px; background: #fafbfc; font-size: 11px; }
.event-detail dt { color: #8a94a3; }
.event-detail dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: #4b5565; }
.detail-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.cause, .occurrences, .journal { margin-top: 24px; }
.cause h3, .occurrences h3, .journal h3 { color: #3c4658; font-size: 12px; }
.occurrences > p { margin: -4px 0 12px; color: #8a94a3; font-size: 10px; line-height: 1.5; }
.occurrences article { padding: 12px 0; border-top: 1px solid var(--line); }
.occurrences article header { display: flex; flex-wrap: wrap; gap: 7px 12px; color: #8a94a3; font-size: 10px; }
.occurrences article header strong { color: #53627a; }
.occurrences article > p { margin: 8px 0; color: #5f6b7d; font-size: 11px; line-height: 1.5; }
.cause pre, .journal pre { max-height: 420px; overflow: auto; padding: 14px; border-radius: 8px; color: #d9e2ef; background: #18202c; font-size: 10px; line-height: 1.55; white-space: pre-wrap; }
.occurrences pre { max-height: 180px; overflow: auto; margin: 0; padding: 10px; border-radius: 7px; color: #657084; background: #f7f8fa; font-size: 10px; line-height: 1.5; white-space: pre-wrap; }

@media (max-width: 420px) {
  .event-list { max-height: 68dvh; }
  .event-tabs-toolbar { gap: 8px; padding-inline: 12px; }
  .event-row { padding-inline: 12px; }
  .event-open p, .event-meta { margin-left: 0; }
  .event-pagination { padding-inline: 10px; }
}
</style>
