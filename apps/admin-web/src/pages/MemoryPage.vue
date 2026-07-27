<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';
import PageHeader from '@/components/PageHeader.vue';
import EmptyState from '@/components/EmptyState.vue';
import { rawApi, rawJsonBody } from '@/api/client';
import { resolveVisibleUserSelection } from './memory-page-state';

const state = ref<any | null>(null);
const users = ref<any[]>([]);
const records = ref<any[]>([]);
const selectedUser = ref('');
const route = useRoute();
const router = useRouter();
const requestedTab = String(route.query.tab || '');
const activeKind = ref<'facts'|'episodes'|'reviews'|'jobs'|'audit'>(
  ['facts', 'episodes', 'reviews', 'jobs', 'audit'].includes(requestedTab)
    ? requestedTab as 'facts'|'episodes'|'reviews'|'jobs'|'audit'
    : 'facts',
);
const probing = ref('');
const userPage = reactive({ page: 1, pageSize: 15, total: 0, search: '' });
const recordPage = reactive({ page: 1, pageSize: 20, total: 0 });
const pendingLoads = ref(0);
const loading = computed(() => pendingLoads.value > 0);
const loadError = ref('');
const tabs = [
  { id: 'facts', label: '事实记忆' },
  { id: 'episodes', label: '事件记忆' },
  { id: 'reviews', label: '待审核' },
  { id: 'jobs', label: '任务队列' },
  { id: 'audit', label: '审计记录' },
] as const;
const probeTargets = ['embedding', 'extraction'] as const;
const currentUser = computed(() => users.value.find((item) => item.userKey === selectedUser.value));

async function withLoading<T>(operation: () => Promise<T>): Promise<T> {
  pendingLoads.value += 1;
  try {
    return await operation();
  } finally {
    pendingLoads.value -= 1;
  }
}

async function loadState() {
  state.value = await withLoading(() => rawApi('/memory'));
}

async function loadUsers() {
  return withLoading(async () => {
    const query = new URLSearchParams({ page: String(userPage.page), pageSize: String(userPage.pageSize) });
    if (userPage.search) query.set('search', userPage.search);
    const result = await rawApi<any>(`/memory/users?${query}`);
    users.value = result.items;
    userPage.total = result.total;
    const nextSelectedUser = resolveVisibleUserSelection(result.items, selectedUser.value);
    const selectionChanged = nextSelectedUser !== selectedUser.value;
    selectedUser.value = nextSelectedUser;
    return selectionChanged;
  });
}

async function loadRecords() {
  await withLoading(async () => {
    const query = new URLSearchParams({ page: String(recordPage.page), pageSize: String(recordPage.pageSize) });
    if (selectedUser.value && !['jobs'].includes(activeKind.value)) query.set('userKey', selectedUser.value);
    const result = await rawApi<any>(`/memory/${activeKind.value}?${query}`);
    records.value = result.items;
    recordPage.total = result.total;
  });
}

function describeLoadError(error: unknown): string {
  return error instanceof Error ? error.message : '长期记忆数据加载失败';
}

async function refreshPage() {
  try {
    await Promise.all([loadState(), loadUsers()]);
    await loadRecords();
    loadError.value = '';
  } catch (error) {
    loadError.value = describeLoadError(error);
  }
}

async function refreshUsers() {
  try {
    const selectionChanged = await loadUsers();
    if (selectionChanged) {
      recordPage.page = 1;
      await loadRecords();
    }
    loadError.value = '';
  } catch (error) {
    loadError.value = describeLoadError(error);
  }
}

async function refreshRecords() {
  try {
    await loadRecords();
    loadError.value = '';
  } catch (error) {
    loadError.value = describeLoadError(error);
  }
}

async function selectUser(userKey: string) {
  selectedUser.value = userKey;
  recordPage.page = 1;
  await refreshRecords();
}

async function mutate(body: any, success: string) {
  try {
    const result = await rawApi<any>('/memory/mutations', { method: 'POST', body: rawJsonBody(body) });
    if (!result.ok) ElMessage.warning('没有找到可变更的记录');
    else ElMessage.success(success);
    await Promise.all([loadState(), loadUsers(), loadRecords()]);
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '记忆操作失败'); }
}

async function edit(row: any) {
  const original = activeKind.value === 'episodes' ? row.summary : row.content;
  const result = await ElMessageBox.prompt('编辑记忆内容', '编辑记忆', { inputType: 'textarea', inputValue: original, inputValidator: (value) => Boolean(value.trim()) });
  await mutate({ action: 'edit', userKey: row.userKey, type: activeKind.value === 'episodes' ? 'episode' : 'fact', id: row.id, content: result.value }, '记忆已更新');
}

async function forget(row: any) {
  await ElMessageBox.confirm('永久删除这条记忆？此操作会写入遗忘记录。', '确认遗忘', { type: 'warning' });
  await mutate({ action: 'forget', userKey: row.userKey, type: activeKind.value === 'episodes' ? 'episode' : 'fact', id: row.id }, '记忆已遗忘');
}

async function review(row: any, decision: string) {
  await mutate({ action: 'review', candidateId: row.id, decision }, decision === 'reject' ? '候选已拒绝' : '候选已通过');
}

async function probe(target: 'embedding' | 'extraction') {
  probing.value = target;
  try { await rawApi(`/memory/probe/${target}`, { method: 'POST', body: '{}' }); ElMessage.success(`${target} 探测完成`); await loadState(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '探测失败'); }
  finally { probing.value = ''; }
}

async function exportUser() {
  if (!selectedUser.value) return;
  const data = await rawApi(`/memory/export/${encodeURIComponent(selectedUser.value)}`);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `memory-${selectedUser.value.replaceAll(':','-')}.json`; anchor.click();
  URL.revokeObjectURL(url);
}

watch(activeKind, () => {
  recordPage.page = 1;
  void router.replace({ query: { ...route.query, tab: activeKind.value } });
  void refreshRecords();
});
onMounted(() => void refreshPage());
</script>

<template>
  <PageHeader hide-save>
    <template #actions><el-button :disabled="!selectedUser" @click="exportUser">导出当前用户</el-button><el-dropdown><el-button>运行探测</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item v-for="target in probeTargets" :key="target" :disabled="Boolean(probing)" @click="probe(target)">{{ target }}</el-dropdown-item></el-dropdown-menu></template></el-dropdown></template>
  </PageHeader>
  <article v-if="loadError" class="panel memory-error" role="alert">
    <div><strong>长期记忆加载失败</strong><p>{{ loadError }}</p></div>
    <el-button size="small" :loading="loading" @click="refreshPage">重试</el-button>
  </article>
  <section class="model-owner">
    <div>
      <strong>记忆模型由模型接口统一管理</strong>
      <p><code>memory.extract</code> 控制提炼模型，<code>memory.embedding</code> 控制向量模型；本页只管理记忆数据、队列和探测。</p>
    </div>
    <el-button tag="a" href="/intelligence/models">查看用途绑定</el-button>
  </section>
  <section v-if="state" class="metric-grid">
    <article class="metric-card"><span class="label">记忆用户</span><strong>{{ state.summary.userCount }}</strong><small>具有 canonical memory profile</small></article>
    <article class="metric-card"><span class="label">事实 / 事件</span><strong>{{ state.summary.factCount }} / {{ state.summary.episodeCount }}</strong><small>{{ state.summary.provenanceCount }} 条来源记录</small></article>
    <article class="metric-card"><span class="label">等待审核</span><strong>{{ state.summary.pendingReviewCount }}</strong><small>privacy review candidates</small></article>
    <article class="metric-card"><span class="label">任务异常</span><strong>{{ state.summary.deadLetterJobs }}</strong><small>{{ state.summary.processingJobs }} 个任务处理中</small></article>
  </section>
  <section class="memory-layout">
    <aside class="panel user-panel">
      <div class="panel-head"><div><h2>用户</h2><p>服务端分页与聚合统计</p></div></div>
      <div class="user-search"><el-input v-model="userPage.search" clearable placeholder="昵称 / QQ / userKey" @keyup.enter="userPage.page=1;refreshUsers()" /></div>
      <button v-for="user in users" :key="user.userKey" :class="{ active: selectedUser === user.userKey }" @click="selectUser(user.userKey)">
        <el-avatar :size="32" :src="user.avatarUrl || undefined">{{ user.label.slice(0,1) }}</el-avatar>
        <span><strong>{{ user.label }}</strong><small>{{ user.factCount }} facts · {{ user.episodeCount }} episodes</small></span>
      </button>
      <el-pagination size="small" layout="prev, next" :current-page="userPage.page" :page-size="userPage.pageSize" :total="userPage.total" @current-change="userPage.page=$event;refreshUsers()" />
    </aside>
    <article class="panel records-panel">
      <div class="panel-head"><div><h2>{{ currentUser?.label || '全部记录' }}</h2><p class="mono">{{ selectedUser || '未选择用户' }}</p></div></div>
      <el-tabs v-model="activeKind" class="record-tabs"><el-tab-pane v-for="tab in tabs" :key="tab.id" :label="tab.label" :name="tab.id" /></el-tabs>
      <el-table v-if="records.length" v-loading="loading" :data="records" style="width:100%">
        <el-table-column label="内容" min-width="300"><template #default="scope"><template v-if="activeKind==='facts'"><strong>{{ scope.row.topicKey }}</strong><p>{{ scope.row.content }}</p></template><template v-else-if="activeKind==='episodes'"><strong>{{ scope.row.title }}</strong><p>{{ scope.row.summary }}</p></template><template v-else-if="activeKind==='reviews'"><strong>{{ scope.row.candidateType }}</strong><p class="mono">{{ scope.row.payload }}</p></template><template v-else-if="activeKind==='jobs'"><strong>{{ scope.row.jobType }} · {{ scope.row.status }}</strong><p>{{ scope.row.lastError || scope.row.conversationId || '无错误' }}</p></template><template v-else><strong>{{ scope.row.eventType }}</strong><p>{{ scope.row.detail || '—' }}</p></template></template></el-table-column>
        <el-table-column v-if="['facts','episodes'].includes(activeKind)" prop="visibility" label="可见性" width="150" />
        <el-table-column v-if="['facts','episodes'].includes(activeKind)" label="置信度" width="95"><template #default="scope">{{ Math.round(scope.row.confidence*100) }}%</template></el-table-column>
        <el-table-column label="更新时间" width="160"><template #default="scope">{{ new Date(scope.row.lastSeenAt || scope.row.updatedAt || scope.row.createdAt).toLocaleString() }}</template></el-table-column>
        <el-table-column v-if="['facts','episodes','reviews'].includes(activeKind)" label="操作" width="190" fixed="right"><template #default="scope"><div class="table-actions" v-if="activeKind==='reviews'"><el-button size="small" type="success" plain @click="review(scope.row,'approve')">通过</el-button><el-button size="small" @click="review(scope.row,'private')">私密</el-button><el-button size="small" type="danger" plain @click="review(scope.row,'reject')">拒绝</el-button></div><div v-else class="table-actions"><el-button size="small" @click="edit(scope.row)">编辑</el-button><el-button size="small" type="danger" plain @click="forget(scope.row)">遗忘</el-button></div></template></el-table-column>
      </el-table>
      <EmptyState v-else title="当前筛选没有记录" description="切换用户或记录类型查看其他数据。" />
      <div class="record-pagination"><el-pagination layout="total, prev, pager, next" :current-page="recordPage.page" :page-size="recordPage.pageSize" :total="recordPage.total" @current-change="recordPage.page=$event;refreshRecords()" /></div>
    </article>
  </section>
</template>

<style scoped>
.memory-error{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px;padding:14px 16px;border-color:#f1c7c7;background:#fff7f7}.memory-error strong{color:#b13b3b;font-size:12px}.memory-error p{margin:3px 0 0;color:#7a5555;font-size:10px}.model-owner{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:16px;padding:14px 16px;border:1px solid #dfe6f2;border-radius:10px;background:#f8faff}.model-owner strong{color:#344056;font-size:12px}.model-owner p{margin:4px 0 0;color:var(--muted);font-size:10px}.model-owner code{font-family:"SFMono-Regular",Consolas,monospace}.memory-layout{display:grid;grid-template-columns:280px minmax(0,1fr);gap:18px}.user-panel{overflow:hidden;align-self:start}.user-search{padding:12px}.user-panel>button{width:100%;display:flex;align-items:center;gap:10px;padding:10px 13px;border:0;border-top:1px solid #f1f3f6;background:#fff;text-align:left}.user-panel>button:hover,.user-panel>button.active{background:#f5f8ff}.user-panel>button.active{box-shadow:inset 3px 0 #3c67e3}.user-panel strong,.user-panel small{display:block}.user-panel strong{color:#414b5d;font-size:11px}.user-panel small{margin-top:3px;color:#9099a8;font-size:9px}.user-panel .el-pagination{justify-content:center;padding:12px}.records-panel{min-width:0;overflow:hidden}.record-tabs{padding:0 16px}.record-tabs :deep(.el-tabs__header){margin:0}.records-panel p{max-height:70px;overflow:hidden;margin:4px 0 0;color:#707b8e;font-size:10px;line-height:1.5}.records-panel strong{font-size:11px}.record-pagination{display:flex;justify-content:flex-end;padding:14px 18px;border-top:1px solid var(--line)}
@media(max-width:900px){.memory-layout{grid-template-columns:1fr}.user-panel{max-height:340px;overflow:auto}}@media(max-width:760px){.model-owner{align-items:flex-start;flex-direction:column}}
</style>
