<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import PageHeader from '@/components/PageHeader.vue';
import { api, jsonBody } from '@/api/client';
import { useRuntimeStore } from '@/stores/runtime';

const modelState = ref<any | null>(null);
const activeTab = ref('siliconflow');
const drafts = reactive<Record<string, any>>({});
const modelOptions = reactive<Record<string, any[]>>({});
const modelCatalogLoading = reactive<Record<string, boolean>>({});
const dynamicModelTabIds = new Set(['codex', 'copilot', 'deepseek', 'mimo']);
const loading = ref(false);
const saving = ref(false);
const oauthBusy = ref(false);
const runtime = useRuntimeStore();
const current = computed(() => drafts[activeTab.value]);
const supportsOAuth = computed(() => ['copilot', 'codex'].includes(activeTab.value));
const hasUnsavedChanges = computed(() => {
  const saved = modelState.value;
  if (!saved || saved.activeTab !== activeTab.value) return Boolean(saved);
  return saved.tabs.some((tab: any) => {
    const draft = drafts[tab.id];
    if (!draft) return true;
    return draft.baseUrl !== tab.baseUrl
      || draft.defaultModel !== tab.defaultModel
      || draft.reasoningEffort !== tab.reasoningEffort
      || draft.apiKey.length > 0
      || draft.clearApiKey;
  });
});
const oauthStatusLabels: Record<string, string> = {
  unauthenticated: '尚未连接',
  pending: '等待设备确认',
  ready: '已连接',
  expired: '登录已过期',
  error: '连接异常',
};
const expiryFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
});

function oauthStatusLabel(status: string): string {
  return oauthStatusLabels[status] ?? status;
}

function oauthStatusClass(status: string): 'ok' | 'warn' | 'error' {
  if (status === 'ready') return 'ok';
  if (status === 'error') return 'error';
  return 'warn';
}

function oauthStatusDetail(tab: any): string {
  if (tab.authStatus === 'pending' && tab.oauthAttempt) return '请在验证页面输入下方设备码';
  if (tab.authStatus === 'pending') return '登录信息不可用，请重新登录';
  if (tab.authStatus === 'ready') return tab.accountLabel || 'OAuth 凭据可用';
  return tab.authError || '尚未连接账号';
}

function formatAttemptExpiry(expiresAt: unknown): string {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return '有效期由验证页面显示';
  return `有效至 ${expiryFormatter.format(new Date(expiresAt))}`;
}

async function copyOAuthCode() {
  const code = current.value?.oauthAttempt?.userCode;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    ElMessage.success('设备码已复制');
  } catch {
    ElMessage.error('设备码复制失败，请手动选择复制');
  }
}

function openOAuthVerification() {
  const verificationUri = current.value?.oauthAttempt?.verificationUri;
  if (!verificationUri) return;
  window.open(verificationUri, '_blank', 'noopener,noreferrer');
}

function supportsDynamicModelList(tabId: string): boolean {
  return dynamicModelTabIds.has(tabId);
}

async function loadModelOptions(tabId: string): Promise<void> {
  if (!supportsDynamicModelList(tabId)
    || Object.prototype.hasOwnProperty.call(modelOptions, tabId)
    || modelCatalogLoading[tabId]) return;
  const tab = drafts[tabId];
  if (!tab) return;
  modelCatalogLoading[tabId] = true;
  try {
    const result = await api<any>(`/models/${tab.id}/list`, {
      method: 'POST',
      body: jsonBody({ baseUrl: tab.baseUrl, ...(tab.apiKey ? { apiKey: tab.apiKey } : {}) }),
    });
    modelOptions[tab.id] = result.models;
    if (tab.id === 'codex') tab.catalog = result.catalog;
    if (result.error) ElMessage.warning(result.error);
  } catch (error) {
    delete modelOptions[tab.id];
    ElMessage.error(error instanceof Error ? error.message : '模型列表自动更新失败');
  } finally {
    modelCatalogLoading[tabId] = false;
  }
}

async function load() {
  loading.value = true;
  try {
    for (const id of Object.keys(modelOptions)) delete modelOptions[id];
    const result = await api<any>('/models');
    modelState.value = result;
    activeTab.value = result.activeTab;
    for (const tab of result.tabs) {
      drafts[tab.id] = { ...tab, apiKey: '', clearApiKey: false };
    }
    await loadModelOptions(result.activeTab);
  } finally { loading.value = false; }
}

async function refreshSavedState() {
  if (hasUnsavedChanges.value) {
    try {
      await ElMessageBox.confirm(
        '当前页面的未保存修改会被丢弃，并重新读取服务端已保存配置与运行状态。',
        '放弃未保存修改？',
        { type: 'warning', confirmButtonText: '放弃并刷新', cancelButtonText: '继续编辑' },
      );
    } catch {
      return;
    }
  }
  await load();
}

async function save() {
  if (!current.value) return;
  saving.value = true;
  try {
    const tab = current.value;
    const payload: any = {
      id: tab.id,
      baseUrl: tab.baseUrl,
      defaultModel: tab.defaultModel,
      reasoningEffort: tab.reasoningEffort,
    };
    if (tab.apiKey) payload.apiKey = tab.apiKey;
    if (tab.clearApiKey) payload.clearApiKey = true;
    const result = await api<any>('/models', {
      method: 'PATCH',
      body: jsonBody({ activeTab: activeTab.value, tabs: [payload], dirtyTabIds: [activeTab.value] }),
    });
    modelState.value = result.modelTabs;
    for (const next of result.modelTabs.tabs) drafts[next.id] = { ...drafts[next.id], ...next, apiKey: '', clearApiKey: false };
    runtime.currentModel = drafts[activeTab.value]?.defaultModel || activeTab.value;
    runtime.updateApply(result.apply);
    ElMessage.success(result.hotSwitched ? '模型已热切换' : '模型配置已保存，重启后生效');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '模型保存失败'); }
  finally { saving.value = false; }
}

async function oauth(action: 'start' | 'poll' | 'logout') {
  const provider = activeTab.value;
  oauthBusy.value = true;
  try {
    let result: any;
    if (action === 'start') result = await api(`/oauth/${provider}/start`, { method: 'POST', body: '{}' });
    else if (action === 'poll') {
      const attemptId = current.value?.oauthAttempt?.attemptId;
      if (!attemptId) return;
      result = await api(`/oauth/${provider}/poll`, { method: 'POST', body: jsonBody({ attemptId }) });
    } else {
      await ElMessageBox.confirm(`退出 ${provider} OAuth？`, '确认退出', { type: 'warning' });
      result = await api(`/oauth/${provider}/logout`, { method: 'POST', body: '{}' });
    }
    current.value.authStatus = result.authStatus;
    current.value.accountLabel = result.accountLabel;
    current.value.authError = result.authError;
    current.value.oauthAttempt = result.attempt;
    ElMessage.success(action === 'start' ? 'OAuth 设备登录已启动' : action === 'logout' ? 'OAuth 已退出' : `OAuth 状态：${result.authStatus}`);
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : 'OAuth 操作失败'); }
  finally { oauthBusy.value = false; }
}

function handleSave() { save(); }
watch(activeTab, (tabId) => {
  void loadModelOptions(tabId);
});
onMounted(() => {
  load();
  window.addEventListener('admin-save', handleSave);
});
onBeforeUnmount(() => {
  window.removeEventListener('admin-save', handleSave);
});
</script>

<template>
  <PageHeader :saving="saving" @save="save">
    <template #actions>
      <el-button
        :loading="loading"
        :title="hasUnsavedChanges ? '丢弃未保存修改并读取服务端状态' : '读取最新服务端配置与运行状态'"
        @click="refreshSavedState"
      >
        {{ hasUnsavedChanges ? '放弃修改' : '刷新状态' }}
      </el-button>
    </template>
  </PageHeader>
  <article class="panel model-panel" v-loading="loading && !modelState">
    <el-tabs v-if="modelState" v-model="activeTab" class="model-tabs">
      <el-tab-pane v-for="tab in modelState.tabs" :key="tab.id" :name="tab.id">
        <template #label><span class="tab-label"><i class="status-dot" :class="tab.authStatus === 'ready' || tab.authKind === 'manual' && tab.apiKeyConfigured ? 'ok' : 'warn'" />{{ tab.title }}</span></template>
      </el-tab-pane>
    </el-tabs>
    <div v-if="current" class="model-content">
      <div class="model-intro"><div><p class="eyebrow">{{ current.strategyId }}</p><h2>{{ current.title }}</h2><p>{{ current.description }}</p></div><el-tag effect="plain">{{ current.requestMode }}</el-tag></div>
      <div v-if="supportsOAuth" class="oauth-card">
        <div class="oauth-summary">
          <span class="status-dot" :class="oauthStatusClass(current.authStatus)" />
          <strong>{{ oauthStatusLabel(current.authStatus) }}</strong>
          <small>{{ oauthStatusDetail(current) }}</small>
        </div>
        <div class="oauth-actions">
          <el-button v-if="current.authStatus !== 'ready' && (current.authStatus !== 'pending' || !current.oauthAttempt)" :loading="oauthBusy" @click="oauth('start')">{{ current.authStatus === 'unauthenticated' ? '启动登录' : '重新登录' }}</el-button>
          <el-button v-if="current.authStatus === 'ready'" type="danger" plain :loading="oauthBusy" @click="oauth('logout')">退出 OAuth</el-button>
        </div>
        <div v-if="current.authStatus === 'pending' && current.oauthAttempt" class="oauth-attempt">
          <div class="oauth-code">
            <span>设备码</span>
            <div><code>{{ current.oauthAttempt.userCode }}</code><el-button text size="small" @click="copyOAuthCode">复制</el-button></div>
            <small>{{ formatAttemptExpiry(current.oauthAttempt.expiresAt) }}</small>
          </div>
          <div class="oauth-attempt-actions">
            <el-button @click="openOAuthVerification">打开验证页</el-button>
            <el-button type="primary" :loading="oauthBusy" @click="oauth('poll')">我已完成，检查状态</el-button>
          </div>
        </div>
      </div>
      <el-form label-position="top" class="model-form">
        <el-form-item label="API base URL"><el-input v-model="current.baseUrl" /></el-form-item>
        <el-form-item v-if="!supportsOAuth" label="API key">
          <el-input v-model="current.apiKey" type="password" show-password :placeholder="current.apiKeyConfigured ? '已配置，留空保持原值' : '输入新的 API key'" :disabled="current.clearApiKey" />
          <el-checkbox v-if="current.apiKeyConfigured" v-model="current.clearApiKey">显式清空现有 API key</el-checkbox>
        </el-form-item>
        <el-form-item label="默认模型">
          <el-select
            v-if="supportsDynamicModelList(current.id)"
            v-model="current.defaultModel"
            class="model-select"
            filterable
            :loading="modelCatalogLoading[current.id]"
          >
            <el-option v-for="item in modelOptions[current.id] ?? []" :key="item.modelId" :label="item.label || item.modelId" :value="item.modelId" />
          </el-select>
          <el-input v-else v-model="current.defaultModel" />
        </el-form-item>
        <el-form-item v-if="current.id === 'codex'" label="Reasoning effort"><el-segmented v-model="current.reasoningEffort" :options="['low','medium','high','xhigh']" /></el-form-item>
      </el-form>
      <div class="contract-strip"><span>Structured output</span><strong>{{ current.structuredOutputProtocol }}</strong><span>Transport model</span><strong>{{ current.transportModel || current.defaultModel }}</strong></div>
    </div>
  </article>
</template>

<style scoped>
.model-panel { overflow:hidden; }.model-tabs { padding:0 20px; }.model-tabs :deep(.el-tabs__header) { margin:0; }.tab-label { display:inline-flex; align-items:center; gap:7px; }.model-content { max-width:900px; padding:28px; }.model-intro { display:flex; justify-content:space-between; gap:20px; margin-bottom:22px; }.model-intro h2 { margin:3px 0 5px; font-size:20px; }.model-intro p { margin:0; color:var(--muted); font-size:11px; }.eyebrow { color:#8290a7 !important; font-size:9px !important; letter-spacing:.08em; }.oauth-card { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:14px 20px; padding:14px 16px; margin-bottom:22px; border:1px solid #dce4f5; border-radius:10px; background:#f7f9fe; }.oauth-summary { display:grid; grid-template-columns:auto 1fr; align-items:center; column-gap:9px; }.oauth-summary strong { color:#273348; font-size:13px; }.oauth-summary small { grid-column:2; margin-top:1px; color:#788397; font-size:10px; }.oauth-actions { display:flex; align-items:center; }.oauth-attempt { grid-column:1 / -1; display:flex; align-items:flex-end; justify-content:space-between; gap:22px; padding-top:13px; border-top:1px solid #e1e7f2; }.oauth-code > span { display:block; margin-bottom:5px; color:#7d8899; font-size:9px; font-weight:700; letter-spacing:.08em; }.oauth-code > div { display:flex; align-items:center; gap:4px; }.oauth-code code { min-width:148px; padding:7px 10px; border:1px solid #d9e1ee; border-radius:7px; color:#26344d; background:#fff; font-family:"SFMono-Regular",Consolas,monospace; font-size:15px; font-weight:700; letter-spacing:.08em; line-height:1; text-align:center; user-select:all; }.oauth-code small { display:block; margin-top:5px; color:#8a94a4; font-size:9px; }.oauth-attempt-actions { display:flex; align-items:center; gap:8px; }.oauth-attempt-actions :deep(.el-button + .el-button) { margin-left:0; }.model-form { max-width:720px; }.model-select { width:100%; }.contract-strip { display:grid; grid-template-columns:140px 1fr; gap:7px 18px; margin-top:24px; padding:14px; border-radius:8px; color:#727d8f; background:#f7f8fa; font-size:10px; }.contract-strip strong { color:#455064; font-family:monospace; }
@media (max-width:760px) {
  .model-content { padding:20px 16px; }
  .oauth-card { grid-template-columns:1fr; }
  .oauth-actions { justify-content:flex-start; }
  .oauth-attempt { align-items:flex-start; flex-direction:column; gap:14px; }
  .oauth-attempt-actions { width:100%; flex-wrap:wrap; }
}
</style>
