<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';
import {
  memoryAssertionsResponseSchema,
  memoryArchiveRequestSchema,
  memoryArchiveResponseSchema,
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
      '删除会清空正文、证据摘录和 lexical projection，并阻止旧任务复活。',
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

async function review(row: MemoryAssertionItem, decision: 'approve' | 'reject'): Promise<void> {
  if (decision === 'reject') {
    try {
      await ElMessageBox.confirm(
        '拒绝后该候选不会进入可检索状态。',
        '拒绝记忆候选',
        { type: 'warning' },
      );
    } catch (error) {
      if (isMemoryDialogCancellation(error)) return;
      throw error;
    }
  }
  activeOperation.value = `review:${row.streamId}`;
  try {
    await api(
      `/memory/reviews/${encodeURIComponent(row.streamId)}`,
      memoryReviewResponseSchema,
      {
        method: 'POST',
        body: jsonBody(memoryReviewRequestSchema, { decision }),
      },
    );
    ElMessage.success(decision === 'approve' ? '候选已批准' : '候选已拒绝');
    await refresh();
  } finally {
    activeOperation.value = '';
  }
}

async function archive(row: MemoryAssertionItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '归档会停止检索并移除 lexical projection，正文和证据仍保留供审核。',
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

async function probe(): Promise<void> {
  activeOperation.value = 'probe:memory.extract';
  try {
    const result = await api(
      '/memory/probe/memory.extract',
      memoryProbeResponseSchema,
      { method: 'POST', body: '{}' },
    );
    if (result.ok) {
      ElMessage.success(`${result.canonicalModel} · structured output 有效`);
    }
    else ElMessage.error(result.error || '记忆提炼探测失败');
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
      <el-button
        :loading="activeOperation === 'probe:memory.extract'"
        :disabled="overview?.status.maintenance"
        @click="probe"
      >
        探测提炼
      </el-button>
      <el-button :loading="loading" @click="refresh">刷新</el-button>
    </template>
  </PageHeader>

  <article v-if="loadError" class="load-error" role="alert">
    <span>{{ loadError }}</span>
    <el-button size="small" @click="refresh">重试</el-button>
  </article>

  <template v-if="overview">
    <section class="runtime-strip">
      <div>
        <span>运行状态</span>
        <el-tag :type="runtimeTone" effect="light">{{ runtimeLabel }}</el-tag>
      </div>
      <div>
        <span>记忆提炼</span>
        <strong>{{ bindingModel(overview.bindings.extraction) }}</strong>
      </div>
      <div>
        <span>记忆检索 Tool</span>
        <strong :class="{ danger: !overview.status.toolReady }">
          {{ overview.status.toolReady ? '可用' : '不可用' }}
        </strong>
      </div>
      <div>
        <span>生效 / 待审核</span>
        <strong>{{ overview.status.counts.active }} / {{ overview.status.counts.pendingReview }}</strong>
      </div>
      <div>
        <span>Lexical index</span>
        <strong>{{ overview.status.counts.lexicalDocuments }} 文档 · {{ overview.status.counts.lexicalTerms }} 词项</strong>
      </div>
      <div>
        <span>队列 / 不完整</span>
        <strong :class="{ danger: overview.status.jobs.deadLetter > 0 || overview.status.counts.stranded > 0 }">
          {{ queueTotal }} / {{ overview.status.counts.stranded }}
        </strong>
      </div>
    </section>

    <el-alert
      v-if="overview.status.maintenance"
      type="warning"
      :closable="false"
      title="维护模式已开启：检索、提炼、审核与探测已冻结。"
    />
    <el-alert
      v-else-if="overview.status.counts.stranded > 0"
      type="error"
      :closable="false"
      :title="`存在 ${overview.status.counts.stranded} 条不完整记录：${strandedDetail}`"
    />
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
          <small v-if="row.kind">{{ row.kind }} · {{ row.topicKey }}</small>
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
            type="primary"
            plain
            :loading="activeOperation === `review:${row.streamId}`"
            @click="review(row, 'approve')"
          >
            批准
          </el-button>
          <el-button
            v-if="activeView === 'reviews'"
            size="small"
            type="danger"
            plain
            :loading="activeOperation === `review:${row.streamId}`"
            @click="review(row, 'reject')"
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
.load-error{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px;padding:12px 14px;border:1px solid #f0c7c7;border-radius:10px;background:#fff6f6;color:#a53a3a;font-size:11px}.runtime-strip{display:grid;grid-template-columns:.9fr 1.7fr .9fr 1fr 1.3fr 1fr;margin-bottom:14px;overflow:hidden;border:1px solid var(--line);border-radius:12px;background:#fff}.runtime-strip>div{display:flex;min-width:0;min-height:62px;align-items:center;justify-content:space-between;gap:10px;padding:0 14px;border-right:1px solid var(--line)}.runtime-strip>div:last-child{border-right:0}.runtime-strip span{flex:none;color:var(--muted);font-size:9px}.runtime-strip strong{overflow:hidden;color:#24324a;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.runtime-strip strong.danger{color:#d44b58}.records-panel{overflow:hidden;border:1px solid var(--line);border-radius:12px;background:#fff}.records-toolbar{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 14px;border-bottom:1px solid var(--line)}.filters{display:flex;min-width:0;align-items:center;gap:8px}.filters .el-input{width:150px}.filters .el-select{width:130px}.review-rule{border-radius:0}.record-list{min-height:180px}.record-row{display:grid;grid-template-columns:minmax(145px,.8fr) minmax(280px,2fr) minmax(190px,1fr) auto;align-items:center;gap:18px;padding:14px 16px;border-bottom:1px solid var(--line)}.record-identity,.record-content,.record-scope{min-width:0}.record-identity{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 8px;align-items:center}.record-identity code,.record-identity small{grid-column:1/-1}.record-row strong{color:#344057;font-size:11px}.record-row code,.record-row small{display:block;overflow:hidden;color:var(--muted);font:9px/1.45 "SFMono-Regular",Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.record-content p{display:-webkit-box;overflow:hidden;margin:0 0 6px;color:#48556b;font-size:11px;line-height:1.55;-webkit-box-orient:vertical;-webkit-line-clamp:3}.record-content .content-cleared{color:#a56b6b;font-style:italic}.record-scope{display:flex;flex-direction:column;gap:4px}.record-actions{display:flex;justify-content:flex-end;gap:6px}.record-actions :deep(.el-button+.el-button){margin-left:0}.pagination{justify-content:flex-end;padding:12px 14px}
@media(max-width:1050px){.runtime-strip{grid-template-columns:repeat(3,1fr)}.runtime-strip>div:nth-child(3){border-right:0}.runtime-strip>div:nth-child(-n+3){border-bottom:1px solid var(--line)}.records-toolbar{align-items:stretch;flex-direction:column}.filters{flex-wrap:wrap}.filters .el-input,.filters .el-select{flex:1 1 150px;width:auto}.record-row{grid-template-columns:minmax(135px,.8fr) minmax(240px,2fr) auto}.record-scope{grid-column:1/3;grid-row:2}.record-actions{grid-column:3;grid-row:1/3}}
@media(max-width:720px){.runtime-strip{grid-template-columns:1fr 1fr}.runtime-strip>div{min-height:54px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}.runtime-strip>div:nth-child(2n){border-right:0}.runtime-strip>div:nth-last-child(-n+2){border-bottom:0}.record-row{grid-template-columns:1fr auto;gap:12px}.record-content,.record-scope{grid-column:1/-1}.record-scope{grid-row:auto}.record-actions{grid-column:2;grid-row:1}.pagination{overflow:auto;justify-content:flex-start}}
</style>
