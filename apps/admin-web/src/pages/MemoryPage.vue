<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';
import {
  memoryAssertionsResponseSchema,
  memoryArchiveRequestSchema,
  memoryArchiveResponseSchema,
  memoryBackfillRequestSchema,
  memoryBackfillResponseSchema,
  memoryForgetRequestSchema,
  memoryForgetResponseSchema,
  memoryOverviewResponseSchema,
  memoryProbeResponseSchema,
  memoryReviewRequestSchema,
  memoryReviewResponseSchema,
  memoryReviewsResponseSchema,
  type MemoryAssertionItem,
  type MemoryOverviewResponse,
} from '@contracts';
import PageHeader from '@/components/PageHeader.vue';
import EmptyState from '@/components/EmptyState.vue';
import { api, jsonBody } from '@/api/client';
import { isMemoryDialogCancellation } from './memory-page-state';

type ViewId = 'assertions' | 'reviews';
type MemoryBinding = MemoryOverviewResponse['bindings']['extraction'];

const route = useRoute();
const router = useRouter();
const activeView = ref<ViewId>(route.query.tab === 'reviews' ? 'reviews' : 'assertions');
const overview = ref<MemoryOverviewResponse | null>(null);
const rows = ref<MemoryAssertionItem[]>([]);
const loading = ref(false);
const activeOperation = ref('');
const loadError = ref('');
const page = reactive({ current: 1, pageSize: 20, total: 0 });
const filters = reactive({
  subjectKey: '',
  contextKey: '',
  state: '',
  assertionType: '',
});

const runtimeLabel = computed(() => {
  const status = overview.value?.status;
  if (!status?.available) return '不可用';
  if (status.maintenance) return '维护中';
  if (!status.enabled) return '已停用';
  if (status.readEnabled && status.writeEnabled) return '运行中';
  return '受限运行';
});

const runtimeTone = computed<'success' | 'warning' | 'danger' | 'info'>(() => {
  const status = overview.value?.status;
  if (!status?.available) return 'danger';
  if (status.maintenance) return 'warning';
  if (!status.enabled) return 'info';
  return status.counts.stranded === 0 ? 'success' : 'danger';
});

const queueTotal = computed(() => {
  const jobs = overview.value?.status.jobs;
  return jobs ? jobs.pending + jobs.leased + jobs.failed + jobs.deadLetter : 0;
});

const strandedDetail = computed(() => {
  const reasons = overview.value?.status.counts.strandedByReason;
  if (!reasons) return '';
  return Object.entries(reasons)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(' · ');
});

function queryString(): string {
  const query = new URLSearchParams({
    page: String(page.current),
    pageSize: String(page.pageSize),
  });
  if (filters.subjectKey.trim()) query.set('subjectKey', filters.subjectKey.trim());
  if (filters.contextKey.trim()) query.set('contextKey', filters.contextKey.trim());
  if (filters.assertionType) query.set('assertionType', filters.assertionType);
  if (activeView.value === 'assertions' && filters.state) query.set('state', filters.state);
  return query.toString();
}

async function loadOverview(): Promise<void> {
  overview.value = await api('/memory', memoryOverviewResponseSchema);
}

async function loadRows(): Promise<void> {
  const query = queryString();
  const result = activeView.value === 'reviews'
    ? await api(`/memory/reviews?${query}`, memoryReviewsResponseSchema)
    : await api(`/memory/assertions?${query}`, memoryAssertionsResponseSchema);
  rows.value = result.items;
  page.total = result.total;
}

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    await Promise.all([loadOverview(), loadRows()]);
    loadError.value = '';
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '记忆数据加载失败';
  } finally {
    loading.value = false;
  }
}

async function applyFilters(): Promise<void> {
  page.current = 1;
  await loadRows();
}

async function forget(row: MemoryAssertionItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '删除会清空正文、证据摘录、向量和检索投影，并阻止旧任务复活。',
      '永久遗忘这条记忆',
      {
        type: 'warning',
        confirmButtonText: '确认遗忘',
      },
    );
  } catch (error) {
    if (isMemoryDialogCancellation(error)) return;
    throw error;
  }
  activeOperation.value = `forget:${row.streamId}`;
  try {
    const result = await api('/memory/forget', memoryForgetResponseSchema, {
      method: 'POST',
      body: jsonBody(memoryForgetRequestSchema, {
        streamId: row.streamId,
        reasonCode: 'operator-delete',
      }),
    });
    ElMessage.success(`已遗忘 ${result.forgotten} 条记忆`);
    await refresh();
  } finally {
    activeOperation.value = '';
  }
}

async function reject(row: MemoryAssertionItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '拒绝后该候选不会进入可召回状态。',
      '拒绝记忆候选',
      { type: 'warning' },
    );
  } catch (error) {
    if (isMemoryDialogCancellation(error)) return;
    throw error;
  }
  activeOperation.value = `review:${row.streamId}`;
  try {
    await api(
      `/memory/reviews/${encodeURIComponent(row.streamId)}`,
      memoryReviewResponseSchema,
      {
        method: 'POST',
        body: jsonBody(memoryReviewRequestSchema, { decision: 'reject' }),
      },
    );
    ElMessage.success('候选已拒绝');
    await refresh();
  } finally {
    activeOperation.value = '';
  }
}

async function archive(row: MemoryAssertionItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '归档会停止召回并移除向量与检索投影，正文和证据仍保留供审核。',
      '归档这条记忆',
      {
        type: 'warning',
        confirmButtonText: '确认归档',
      },
    );
  } catch (error) {
    if (isMemoryDialogCancellation(error)) return;
    throw error;
  }
  activeOperation.value = `archive:${row.streamId}`;
  try {
    await api('/memory/archive', memoryArchiveResponseSchema, {
      method: 'POST',
      body: jsonBody(memoryArchiveRequestSchema, {
        streamId: row.streamId,
        reasonCode: 'operator-archive',
      }),
    });
    ElMessage.success('记忆已归档');
    await refresh();
  } finally {
    activeOperation.value = '';
  }
}

async function backfill(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '只会为当前 active 记录补齐当前模型的向量和检索投影。',
      '创建向量回填任务',
      { type: 'warning' },
    );
  } catch (error) {
    if (isMemoryDialogCancellation(error)) return;
    throw error;
  }
  activeOperation.value = 'backfill';
  try {
    const result = await api('/memory/backfill', memoryBackfillResponseSchema, {
      method: 'POST',
      body: jsonBody(memoryBackfillRequestSchema, {}),
    });
    ElMessage.success(`已创建 ${result.queued} 个回填任务`);
    await loadOverview();
  } finally {
    activeOperation.value = '';
  }
}

async function probe(workload: 'memory.extract' | 'memory.embedding'): Promise<void> {
  activeOperation.value = `probe:${workload}`;
  try {
    const result = await api(
      `/memory/probe/${workload}`,
      memoryProbeResponseSchema,
      { method: 'POST', body: '{}' },
    );
    if (result.ok) {
      const dimensions = result.dimensions == null ? '' : ` · ${result.dimensions} 维`;
      ElMessage.success(`${result.canonicalModel} · schema 有效${dimensions}`);
    }
    else ElMessage.error(result.error || `${workload} 探测失败`);
    overview.value = overview.value
      ? { ...overview.value, status: result.snapshot }
      : await api('/memory', memoryOverviewResponseSchema);
  } finally {
    activeOperation.value = '';
  }
}

function bindingModel(binding: MemoryBinding): string {
  if (binding.mode === 'disabled') return '已禁用';
  return binding.canonicalModel || '等待调用上下文';
}

function assertionTypeLabel(type: MemoryAssertionItem['assertionType']): string {
  return {
    userAssertion: '个人事实',
    groupArtifact: '群体信息',
    assistantCommitment: '机器人承诺',
    episode: '群聊事件',
  }[type];
}

function audienceLabel(row: MemoryAssertionItem): string {
  return {
    subjectPrivate: '仅主体私聊',
    sourceContext: '仅来源群',
    captureAudience: '捕获时成员',
    subjectAllContexts: '主体已授权跨群',
    explicitContexts: '指定上下文',
  }[row.audiencePolicy];
}

function stateLabel(state: MemoryAssertionItem['state']): string {
  return {
    active: '生效',
    pendingReview: '待审核',
    archived: '已归档',
    retracted: '已撤回',
    forgotten: '已遗忘',
  }[state];
}

watch(activeView, async () => {
  page.current = 1;
  filters.state = '';
  await router.replace({
    query: {
      ...route.query,
      tab: activeView.value === 'reviews' ? 'reviews' : undefined,
    },
  });
  await loadRows();
});

onMounted(() => void refresh());
</script>

<template>
  <PageHeader hide-save>
    <template #actions>
      <el-button @click="router.push('/intelligence/models')">模型配置</el-button>
      <el-dropdown>
        <el-button :disabled="Boolean(activeOperation)">运行探测</el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item @click="probe('memory.extract')">提炼模型</el-dropdown-item>
            <el-dropdown-item @click="probe('memory.embedding')">向量模型</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-button
        :loading="activeOperation === 'backfill'"
        :disabled="overview?.status.maintenance"
        @click="backfill"
      >
        向量回填
      </el-button>
      <el-button :loading="loading" @click="refresh">刷新</el-button>
    </template>
  </PageHeader>

  <article v-if="loadError" class="load-error" role="alert">
    <span>{{ loadError }}</span>
    <el-button size="small" @click="refresh">重试</el-button>
  </article>

  <template v-if="overview">
    <section class="metric-strip">
      <div>
        <span>运行状态</span>
        <el-tag :type="runtimeTone" effect="light">{{ runtimeLabel }}</el-tag>
      </div>
      <div><span>生效记忆</span><strong>{{ overview.status.counts.active }}</strong></div>
      <div><span>待审核</span><strong>{{ overview.status.counts.pendingReview }}</strong></div>
      <div>
        <span>不完整</span>
        <strong :class="{ danger: overview.status.counts.stranded > 0 }">
          {{ overview.status.counts.stranded }}
        </strong>
      </div>
      <div>
        <span>任务队列</span>
        <strong :class="{ danger: overview.status.jobs.deadLetter > 0 }">{{ queueTotal }}</strong>
      </div>
    </section>

    <el-alert
      v-if="overview.status.maintenance"
      type="warning"
      :closable="false"
      title="维护模式已开启：召回、提炼、审核、探测和回填均已冻结。"
    />
    <el-alert
      v-else-if="overview.status.counts.stranded > 0"
      type="error"
      :closable="false"
      :title="`存在 ${overview.status.counts.stranded} 条不完整记录：${strandedDetail}`"
    />

    <section class="binding-bar">
      <div>
        <span>提炼</span>
        <strong>{{ bindingModel(overview.bindings.extraction) }}</strong>
        <small>{{ overview.bindings.extraction.mode }}</small>
      </div>
      <div>
        <span>向量</span>
        <strong>{{ bindingModel(overview.bindings.embedding) }}</strong>
        <small>{{ overview.bindings.embedding.mode }}</small>
      </div>
      <div class="queue-detail">
        <span>任务</span>
        <strong>
          待执行 {{ overview.status.jobs.pending }} · 执行中 {{ overview.status.jobs.leased }}
          · 失败 {{ overview.status.jobs.failed }} · Dead letter {{ overview.status.jobs.deadLetter }}
        </strong>
      </div>
    </section>
  </template>

  <section class="records-panel">
    <div class="records-toolbar">
      <el-segmented v-model="activeView" :options="[
        { label: '记忆数据', value: 'assertions' },
        { label: `待审核 ${overview?.status.counts.pendingReview ?? 0}`, value: 'reviews' },
      ]" />
      <div class="filters">
        <el-input
          v-model="filters.subjectKey"
          clearable
          placeholder="主体 ID"
          @keyup.enter="applyFilters"
        />
        <el-input
          v-model="filters.contextKey"
          clearable
          placeholder="来源群 / 上下文"
          @keyup.enter="applyFilters"
        />
        <el-select v-model="filters.assertionType" clearable placeholder="记忆类型">
          <el-option label="个人事实" value="userAssertion" />
          <el-option label="群体信息" value="groupArtifact" />
          <el-option label="机器人承诺" value="assistantCommitment" />
          <el-option label="群聊事件" value="episode" />
        </el-select>
        <el-select
          v-if="activeView === 'assertions'"
          v-model="filters.state"
          clearable
          placeholder="状态"
        >
          <el-option label="生效" value="active" />
          <el-option label="已归档" value="archived" />
          <el-option label="已撤回" value="retracted" />
          <el-option label="已遗忘" value="forgotten" />
        </el-select>
        <el-button @click="applyFilters">筛选</el-button>
      </div>
    </div>

    <el-alert
      v-if="activeView === 'reviews'"
      class="review-rule"
      type="info"
      :closable="false"
      title="管理员可拒绝候选；个人记忆的跨群授权只能由记忆主体在私聊完成。"
    />

    <div v-loading="loading" class="record-list">
      <article v-for="row in rows" :key="row.streamId" class="record-row">
        <div class="record-identity">
          <strong>{{ assertionTypeLabel(row.assertionType) }}</strong>
          <code>{{ row.subjectKey }}</code>
          <el-tag size="small" effect="plain">{{ stateLabel(row.state) }}</el-tag>
        </div>
        <div class="record-content">
          <p v-if="row.content">{{ row.content }}</p>
          <p v-else class="content-cleared">正文已清除</p>
          <small>{{ row.evidenceMessageIds.length }} 条证据 · 置信度 {{ Math.round(row.confidence * 100) }}%</small>
        </div>
        <div class="record-scope">
          <strong>{{ audienceLabel(row) }}</strong>
          <code>{{ row.sourceContextKey }}</code>
          <small>{{ new Date(row.updatedAt).toLocaleString() }}</small>
        </div>
        <div class="record-actions">
          <el-button
            v-if="activeView === 'reviews'"
            size="small"
            type="danger"
            plain
            :loading="activeOperation === `review:${row.streamId}`"
            @click="reject(row)"
          >
            拒绝
          </el-button>
          <template v-else-if="row.state !== 'forgotten'">
            <el-button
              v-if="row.state === 'active'"
              size="small"
              :loading="activeOperation === `archive:${row.streamId}`"
              @click="archive(row)"
            >
              归档
            </el-button>
            <el-button
              size="small"
              type="danger"
              plain
              :loading="activeOperation === `forget:${row.streamId}`"
              @click="forget(row)"
            >
              遗忘
            </el-button>
          </template>
        </div>
      </article>
      <EmptyState
        v-if="!loading && rows.length === 0"
        title="当前筛选没有记录"
        description="调整主体、来源、类型或状态后重试。"
      />
    </div>

    <el-pagination
      class="pagination"
      layout="total, prev, pager, next"
      :current-page="page.current"
      :page-size="page.pageSize"
      :total="page.total"
      @current-change="page.current = $event; loadRows()"
    />
  </section>
</template>

<style scoped>
.load-error{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px;padding:12px 14px;border:1px solid #f0c7c7;border-radius:10px;background:#fff6f6;color:#a53a3a;font-size:11px}.metric-strip{display:grid;grid-template-columns:1.2fr repeat(4,1fr);margin-bottom:14px;overflow:hidden;border:1px solid var(--line);border-radius:12px;background:#fff}.metric-strip>div{display:flex;min-height:62px;align-items:center;justify-content:space-between;gap:12px;padding:0 16px;border-right:1px solid var(--line)}.metric-strip>div:last-child{border-right:0}.metric-strip span{color:var(--muted);font-size:10px}.metric-strip strong{color:#24324a;font-size:17px}.metric-strip strong.danger{color:#d44b58}.binding-bar{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(260px,1.2fr);margin:14px 0;border:1px solid var(--line);border-radius:10px;background:#fff}.binding-bar>div{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;padding:11px 14px;border-right:1px solid var(--line)}.binding-bar>div:last-child{border-right:0}.binding-bar span,.binding-bar small{color:var(--muted);font-size:9px}.binding-bar strong{overflow:hidden;color:#354158;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.queue-detail{grid-template-columns:auto minmax(0,1fr)!important}.records-panel{overflow:hidden;border:1px solid var(--line);border-radius:12px;background:#fff}.records-toolbar{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 14px;border-bottom:1px solid var(--line)}.filters{display:flex;min-width:0;align-items:center;gap:8px}.filters .el-input{width:150px}.filters .el-select{width:130px}.review-rule{border-radius:0}.record-list{min-height:180px}.record-row{display:grid;grid-template-columns:minmax(145px,.8fr) minmax(280px,2fr) minmax(190px,1fr) auto;align-items:center;gap:18px;padding:14px 16px;border-bottom:1px solid var(--line)}.record-identity,.record-content,.record-scope{min-width:0}.record-identity{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 8px;align-items:center}.record-identity code{grid-column:1/-1}.record-row strong{color:#344057;font-size:11px}.record-row code,.record-row small{display:block;overflow:hidden;color:var(--muted);font:9px/1.45 "SFMono-Regular",Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.record-content p{display:-webkit-box;overflow:hidden;margin:0 0 6px;color:#48556b;font-size:11px;line-height:1.55;-webkit-box-orient:vertical;-webkit-line-clamp:3}.record-content .content-cleared{color:#a56b6b;font-style:italic}.record-scope{display:flex;flex-direction:column;gap:4px}.record-actions{display:flex;justify-content:flex-end;gap:6px}.record-actions :deep(.el-button+.el-button){margin-left:0}.pagination{justify-content:flex-end;padding:12px 14px}
@media(max-width:1050px){.metric-strip{grid-template-columns:repeat(3,1fr)}.metric-strip>div{border-bottom:1px solid var(--line)}.binding-bar{grid-template-columns:1fr}.binding-bar>div{border-right:0;border-bottom:1px solid var(--line)}.binding-bar>div:last-child{border-bottom:0}.records-toolbar{align-items:stretch;flex-direction:column}.filters{flex-wrap:wrap}.filters .el-input,.filters .el-select{flex:1 1 150px;width:auto}.record-row{grid-template-columns:minmax(135px,.8fr) minmax(240px,2fr) auto}.record-scope{grid-column:1/3;grid-row:2}.record-actions{grid-column:3;grid-row:1/3}}
@media(max-width:720px){.metric-strip{grid-template-columns:1fr 1fr}.metric-strip>div{min-height:54px}.binding-bar>div{grid-template-columns:auto minmax(0,1fr)}.binding-bar small{display:none}.record-row{grid-template-columns:1fr auto;gap:12px}.record-content,.record-scope{grid-column:1/-1}.record-scope{grid-row:auto}.record-actions{grid-column:2;grid-row:1}.pagination{overflow:auto;justify-content:flex-start}}
</style>
