<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRouter } from 'vue-router';
import {
  emptyRequestSchema,
  modelListRequestSchema,
  modelListResponseSchema,
  modelRuntimeStateSchema,
  modelTabsPatchRequestSchema,
  modelTabsResponseSchema,
  oauthAttemptRequestSchema,
  oauthMutationResponseSchema,
  saveModelsResponseSchema,
  type ModelAuthStatus,
  type ModelOption,
  type ModelRuntimeState,
  type ModelTabId,
  type ModelTabsResponse,
  type OAuthMutationResponse,
} from '@contracts';
import PageHeader from '@/components/PageHeader.vue';
import { api, jsonBody } from '@/api/client';
import { useRuntimeStore } from '@/stores/runtime';
import {
  buildModelTabsPatchRequest,
  errorMessage,
  loadModelPageConfiguration,
  modelOptionValue,
  omitProviderModelOptions,
  requireCacheableModelOptions,
  toModelDraft,
  type ModelDraft,
} from './model-page-state';

const MODEL_TAB_IDS: readonly ModelTabId[] = ['siliconflow', 'openai', 'codex', 'copilot', 'deepseek', 'mimo'];
const DYNAMIC_MODEL_TAB_IDS = new Set<ModelTabId>(['codex', 'copilot', 'deepseek', 'mimo']);

type OAuthProvider = Extract<ModelTabId, 'copilot' | 'codex'>;

const modelState = ref<ModelTabsResponse | null>(null);
const modelRuntime = ref<ModelRuntimeState | null>(null);
const modelLoadError = ref<string | null>(null);
const runtimeLoadError = ref<string | null>(null);
const activeTab = ref<ModelTabId>('siliconflow');
const drafts = reactive<Partial<Record<ModelTabId, ModelDraft>>>({});
const modelOptions = ref<Partial<Record<ModelTabId, ModelOption[]>>>({});
const modelCatalogLoading = reactive<Partial<Record<ModelTabId, boolean>>>({});
const loading = ref(false);
const runtimeLoading = ref(false);
const saving = ref(false);
const oauthBusy = ref(false);
const runtime = useRuntimeStore();
const router = useRouter();
const current = computed(() => drafts[activeTab.value]);
const supportsOAuth = computed(() => ['copilot', 'codex'].includes(activeTab.value));
const hasUnsavedChanges = computed(() => {
  const saved = modelState.value;
  return saved
    ? buildModelTabsPatchRequest(saved, drafts, activeTab.value) !== null
    : false;
});
const oauthStatusLabels: Record<ModelAuthStatus, string> = {
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
const runtimeUpdatedFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function oauthStatusLabel(status: ModelAuthStatus): string {
  return oauthStatusLabels[status];
}

function oauthStatusClass(status: ModelAuthStatus): 'ok' | 'warn' | 'error' {
  if (status === 'ready') return 'ok';
  if (status === 'error') return 'error';
  return 'warn';
}

function oauthStatusDetail(tab: ModelDraft): string {
  if (tab.authStatus === 'pending' && tab.oauthAttempt) return '请在验证页面输入下方设备码';
  if (tab.authStatus === 'pending') return '登录信息不可用，请重新登录';
  if (tab.authStatus === 'ready') return tab.accountLabel || 'OAuth 凭据可用';
  return tab.authError || '尚未连接账号';
}

function formatAttemptExpiry(expiresAt: unknown): string {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return '有效期由验证页面显示';
  return `有效至 ${expiryFormatter.format(new Date(expiresAt))}`;
}

function formatContextLimit(value: number | null): string {
  return value === null ? '未上报' : `${value.toLocaleString('zh-CN')} tokens`;
}

function formatRuntimeUpdatedAt(value: string | null): string {
  if (!value) return '未上报';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? runtimeUpdatedFormatter.format(timestamp) : value;
}

function isOAuthProvider(value: ModelTabId): value is OAuthProvider {
  return value === 'copilot' || value === 'codex';
}

function apiKeyPlaceholder(tab: ModelDraft): string {
  if (!tab.apiKeyConfigured) return '输入新的 API key';
  const saved = modelState.value?.tabs.find((item) => item.id === tab.id);
  if (saved && saved.baseUrl.trim().replace(/\/+$/u, '') !== tab.baseUrl.trim().replace(/\/+$/u, '')) {
    return '接口地址已改变，请输入对应 API key 或显式清空现有密钥';
  }
  return '已配置，留空保持原值';
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

async function loadModelRuntime() {
  modelRuntime.value = await api('/models/runtime', modelRuntimeStateSchema);
  runtimeLoadError.value = null;
}

async function retryModelRuntime() {
  if (runtimeLoading.value) return;
  runtimeLoading.value = true;
  try {
    await loadModelRuntime();
  } catch (error) {
    modelRuntime.value = null;
    runtimeLoadError.value = errorMessage(error, '模型运行状态加载失败');
  } finally {
    runtimeLoading.value = false;
  }
}

function supportsDynamicModelList(tabId: ModelTabId): boolean {
  return DYNAMIC_MODEL_TAB_IDS.has(tabId);
}

async function loadModelOptions(tabId: ModelTabId): Promise<void> {
  if (!supportsDynamicModelList(tabId)
    || Object.prototype.hasOwnProperty.call(modelOptions.value, tabId)
    || modelCatalogLoading[tabId]) return;
  const tab = drafts[tabId];
  if (!tab) return;
  modelCatalogLoading[tabId] = true;
  try {
    const result = await api(`/models/${tab.id}/list`, modelListResponseSchema, {
      method: 'POST',
      body: jsonBody(
        modelListRequestSchema,
        { baseUrl: tab.baseUrl, ...(tab.apiKey ? { apiKey: tab.apiKey } : {}) },
      ),
    });
    if (tab.id === 'codex') {
      if (!result.catalog) throw new Error('Codex 模型目录响应缺少 catalog。');
      tab.catalog = result.catalog;
    }
    requireCacheableModelOptions(result);
    modelOptions.value[tab.id] = result.models;
    if (result.error) ElMessage.warning(result.error);
  } catch (error) {
    modelOptions.value = omitProviderModelOptions(modelOptions.value, tab.id);
    ElMessage.error(error instanceof Error ? error.message : '模型列表自动更新失败');
  } finally {
    modelCatalogLoading[tabId] = false;
  }
}

async function load() {
  if (loading.value) return;
  loading.value = true;
  void retryModelRuntime();
  try {
    const result = await loadModelPageConfiguration(api('/models', modelTabsResponseSchema));
    modelLoadError.value = result.requiredError;
    if (result.modelState) {
      for (const id of MODEL_TAB_IDS) delete drafts[id];
      for (const tab of result.modelState.tabs) drafts[tab.id] = toModelDraft(tab);
      modelOptions.value = {};
      activeTab.value = result.modelState.activeTab;
      modelState.value = result.modelState;
      await loadModelOptions(result.modelState.activeTab);
    } else {
      for (const id of MODEL_TAB_IDS) delete drafts[id];
      modelOptions.value = {};
      modelState.value = null;
    }
  } finally {
    loading.value = false;
  }
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
  if (!modelState.value || !current.value || saving.value) return;
  const request = buildModelTabsPatchRequest(modelState.value, drafts, activeTab.value);
  if (!request) return;
  saving.value = true;
  try {
    const result = await api('/models', saveModelsResponseSchema, {
      method: 'PATCH',
      body: jsonBody(modelTabsPatchRequestSchema, request),
    });
    modelState.value = result.modelTabs;
    for (const next of result.modelTabs.tabs) drafts[next.id] = toModelDraft(next);
    runtime.currentModel = drafts[activeTab.value]?.defaultModel ?? activeTab.value;
    runtime.updateApply(result.apply);
    try {
      await loadModelRuntime();
    } catch (error) {
      modelRuntime.value = null;
      runtimeLoadError.value = errorMessage(error, '模型运行状态加载失败');
      ElMessage.warning(`模型配置已保存，运行态刷新失败：${runtimeLoadError.value}`);
      return;
    }
    ElMessage.success(result.hotSwitched ? '模型已热切换' : '模型配置已保存，重启后生效');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '模型保存失败'); }
  finally { saving.value = false; }
}

async function oauth(action: 'start' | 'poll' | 'logout') {
  const provider = activeTab.value;
  const tab = current.value;
  if (!isOAuthProvider(provider) || !tab) {
    ElMessage.error('当前模型接口不支持 OAuth。');
    return;
  }
  if (oauthBusy.value) return;
  oauthBusy.value = true;
  try {
    let result: OAuthMutationResponse;
    if (action === 'start') {
      result = await api(`/oauth/${provider}/start`, oauthMutationResponseSchema, {
        method: 'POST',
        body: jsonBody(emptyRequestSchema, {}),
      });
    }
    else if (action === 'poll') {
      const attemptId = tab.oauthAttempt?.attemptId;
      if (!attemptId) throw new Error('当前没有可检查的 OAuth 登录流程。');
      result = await api(`/oauth/${provider}/poll`, oauthMutationResponseSchema, {
        method: 'POST',
        body: jsonBody(oauthAttemptRequestSchema, { attemptId }),
      });
    } else {
      await ElMessageBox.confirm(`退出 ${provider} OAuth？`, '确认退出', { type: 'warning' });
      result = await api(`/oauth/${provider}/logout`, oauthMutationResponseSchema, {
        method: 'POST',
        body: jsonBody(emptyRequestSchema, {}),
      });
    }
    tab.authStatus = result.authStatus;
    tab.accountLabel = result.accountLabel;
    tab.authError = result.authError;
    tab.tokenExpiresAt = result.tokenExpiresAt;
    tab.oauthAttempt = result.attempt;
    modelOptions.value = omitProviderModelOptions(modelOptions.value, provider);
    await loadModelOptions(provider);
    ElMessage.success(action === 'start' ? 'OAuth 设备登录已启动' : action === 'logout' ? 'OAuth 已退出' : `OAuth 状态：${result.authStatus}`);
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error(error instanceof Error ? error.message : 'OAuth 操作失败');
    }
  }
  finally { oauthBusy.value = false; }
}

function openContextInspector() {
  router.push({ path: '/intelligence/presets', hash: '#context-inspector' });
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
  <PageHeader
    :saving="saving"
    :save-disabled="!hasUnsavedChanges || !current"
    @save="save"
  >
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
    <section v-if="modelLoadError" class="load-error-card">
      <div>
        <strong>模型配置加载失败</strong>
        <p>{{ modelLoadError }}</p>
      </div>
      <el-button type="primary" plain :loading="loading" @click="load">重试加载</el-button>
    </section>
    <el-tabs v-if="modelState" v-model="activeTab" class="model-tabs">
      <el-tab-pane v-for="tab in modelState.tabs" :key="tab.id" :name="tab.id">
        <template #label><span class="tab-label"><i class="status-dot" :class="tab.authStatus === 'ready' || tab.authKind === 'manual' && tab.apiKeyConfigured ? 'ok' : 'warn'" />{{ tab.title }}</span></template>
      </el-tab-pane>
    </el-tabs>
    <section v-if="modelState && runtimeLoadError" class="runtime-error-card">
      <div>
        <strong>运行状态暂时不可用</strong>
        <p>{{ runtimeLoadError }}。已保存的模型配置仍可查看和编辑。</p>
      </div>
      <el-button plain :loading="runtimeLoading" @click="retryModelRuntime">重试运行状态</el-button>
    </section>
    <section v-if="modelState && modelRuntime" class="runtime-overview">
      <div class="runtime-overview-head">
        <div>
          <p class="eyebrow">MODEL RUNTIME</p>
          <h2>当前模型请求状态</h2>
          <p>区分已保存配置、内存中正在使用的模型，以及 provider transport 层实际发送的模型名称。</p>
        </div>
        <div class="runtime-actions">
          <el-tag :type="modelRuntime.pending ? 'warning' : 'success'" effect="light">
            {{ modelRuntime.pending ? 'Pending · 需要重启' : 'Live · 已同步' }}
          </el-tag>
          <el-button type="primary" plain @click="openContextInspector">打开上下文检查器</el-button>
        </div>
      </div>
      <dl class="runtime-grid">
        <div>
          <dt>Configured model</dt>
          <dd>{{ modelRuntime.configuredModel ?? '未配置' }}</dd>
          <small>管理端保存的目标模型</small>
        </div>
        <div>
          <dt>Live model</dt>
          <dd>{{ modelRuntime.liveModel ?? '未加载' }}</dd>
          <small>当前进程实际使用的模型</small>
        </div>
        <div>
          <dt>Transport model</dt>
          <dd>{{ modelRuntime.transportModel ?? '未上报' }}</dd>
          <small>发送到 provider 的模型标识</small>
        </div>
        <div>
          <dt>Request mode</dt>
          <dd>{{ modelRuntime.requestMode ?? '未上报' }}</dd>
          <small>chat_completions / responses</small>
        </div>
        <div>
          <dt>Physical context size</dt>
          <dd>{{ formatContextLimit(modelRuntime.modelContextSize) }}</dd>
          <small>模型目录声明的物理上下文容量</small>
        </div>
        <div>
          <dt>Effective crop limit</dt>
          <dd>{{ formatContextLimit(modelRuntime.contextLimit) }}</dd>
          <small>最近请求最终裁剪使用的有效上限</small>
        </div>
        <div>
          <dt>Runtime updated</dt>
          <dd>{{ formatRuntimeUpdatedAt(modelRuntime.updatedAt) }}</dd>
          <small>最近一次运行态更新</small>
        </div>
      </dl>
      <p v-if="modelRuntime.pendingReason" class="pending-reason">
        <strong>Pending reason</strong>
        {{ modelRuntime.pendingReason }}
      </p>
    </section>
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
          <el-input v-model="current.apiKey" type="password" show-password :placeholder="apiKeyPlaceholder(current)" :disabled="current.clearApiKey" />
          <el-checkbox v-if="current.apiKeyConfigured" v-model="current.clearApiKey">显式清空现有 API key</el-checkbox>
        </el-form-item>
        <el-form-item label="默认模型">
          <el-select
            v-if="supportsDynamicModelList(current.id)"
            v-model="current.defaultModel"
            class="model-select"
            :loading="modelCatalogLoading[current.id]"
            filterable
            placeholder="请选择模型"
          >
            <el-option
              v-for="item in modelOptions[current.id] ?? []"
              :key="modelOptionValue(item)"
              :label="item.label"
              :value="modelOptionValue(item)"
            >
              <div class="model-option">
                <span>{{ item.label }}</span>
                <small>{{ item.transportModel }}</small>
              </div>
            </el-option>
          </el-select>
          <el-input v-else v-model="current.defaultModel" placeholder="请输入模型 ID" />
        </el-form-item>
        <el-form-item v-if="current.id === 'codex'" label="Reasoning effort"><el-segmented v-model="current.reasoningEffort" :options="['low','medium','high','xhigh']" /></el-form-item>
      </el-form>
      <div class="contract-strip"><span>Structured output</span><strong>{{ current.structuredOutputProtocol }}</strong><span>Transport model</span><strong>{{ current.transportModel || current.defaultModel }}</strong></div>
    </div>
  </article>
</template>

<style scoped>
.model-panel { overflow:hidden; }.model-tabs { padding:0 20px; }.model-tabs :deep(.el-tabs__header) { margin:0; }.tab-label { display:inline-flex; align-items:center; gap:7px; }.model-content { max-width:900px; padding:28px; }.model-intro { display:flex; justify-content:space-between; gap:20px; margin-bottom:22px; }.model-intro h2 { margin:3px 0 5px; font-size:20px; }.model-intro p { margin:0; color:var(--muted); font-size:11px; }.eyebrow { color:#8290a7 !important; font-size:9px !important; letter-spacing:.08em; }.oauth-card { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:14px 20px; padding:14px 16px; margin-bottom:22px; border:1px solid #dce4f5; border-radius:10px; background:#f7f9fe; }.oauth-summary { display:grid; grid-template-columns:auto 1fr; align-items:center; column-gap:9px; }.oauth-summary strong { color:#273348; font-size:13px; }.oauth-summary small { grid-column:2; margin-top:1px; color:#788397; font-size:10px; }.oauth-actions { display:flex; align-items:center; }.oauth-attempt { grid-column:1 / -1; display:flex; align-items:flex-end; justify-content:space-between; gap:22px; padding-top:13px; border-top:1px solid #e1e7f2; }.oauth-code > span { display:block; margin-bottom:5px; color:#7d8899; font-size:9px; font-weight:700; letter-spacing:.08em; }.oauth-code > div { display:flex; align-items:center; gap:4px; }.oauth-code code { min-width:148px; padding:7px 10px; border:1px solid #d9e1ee; border-radius:7px; color:#26344d; background:#fff; font-family:"SFMono-Regular",Consolas,monospace; font-size:15px; font-weight:700; letter-spacing:.08em; line-height:1; text-align:center; user-select:all; }.oauth-code small { display:block; margin-top:5px; color:#8a94a4; font-size:9px; }.oauth-attempt-actions { display:flex; align-items:center; gap:8px; }.oauth-attempt-actions :deep(.el-button + .el-button) { margin-left:0; }.model-form { max-width:720px; }.model-select { width:100%; }.contract-strip { display:grid; grid-template-columns:140px 1fr; gap:7px 18px; margin-top:24px; padding:14px; border-radius:8px; color:#727d8f; background:#f7f8fa; font-size:10px; }.contract-strip strong { color:#455064; font-family:monospace; }
.runtime-overview { padding:22px 28px; border-bottom:1px solid #e8edf5; background:linear-gradient(135deg, #f9fbff 0%, #f4f7fd 100%); }
.runtime-overview-head { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; }
.runtime-overview-head h2 { margin:3px 0 5px; color:#26344d; font-size:18px; }
.runtime-overview-head p { max-width:680px; margin:0; color:#788397; font-size:11px; line-height:1.6; }
.runtime-actions { display:flex; align-items:center; justify-content:flex-end; gap:10px; flex-wrap:wrap; }
.runtime-grid { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px; margin:18px 0 0; }
.runtime-grid > div { min-width:0; padding:12px 14px; border:1px solid #e0e7f2; border-radius:9px; background:rgba(255, 255, 255, .86); }
.runtime-grid dt { color:#7d8899; font-size:9px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; }
.runtime-grid dd { overflow:hidden; margin:5px 0 3px; color:#2f3c52; font-family:"SFMono-Regular",Consolas,monospace; font-size:12px; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
.runtime-grid small { color:#929baa; font-size:9px; }
.pending-reason { display:flex; gap:8px; margin:12px 0 0; padding:9px 12px; border-radius:7px; color:#865f1f; background:#fff7e8; font-size:10px; }
.pending-reason strong { flex:0 0 auto; }
.load-error-card, .runtime-error-card { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:16px 20px; border-bottom:1px solid #f2c7c7; color:#9b3535; background:#fff4f4; }
.runtime-error-card { border-bottom-color:#f1d7a6; color:#805d1f; background:#fff9ed; }
.load-error-card strong, .runtime-error-card strong { display:block; font-size:13px; }
.load-error-card p, .runtime-error-card p { margin:4px 0 0; font-size:10px; line-height:1.5; }
.model-option { display:flex; align-items:center; justify-content:space-between; gap:18px; width:100%; }
.model-option small { overflow:hidden; color:#929baa; font-family:"SFMono-Regular",Consolas,monospace; font-size:9px; text-overflow:ellipsis; white-space:nowrap; }
@media (max-width:760px) {
  .model-content { padding:20px 16px; }
  .runtime-overview { padding:18px 16px; }
  .runtime-overview-head { flex-direction:column; gap:14px; }
  .runtime-actions { justify-content:flex-start; }
  .runtime-grid { grid-template-columns:1fr; }
  .oauth-card { grid-template-columns:1fr; }
  .oauth-actions { justify-content:flex-start; }
  .oauth-attempt { align-items:flex-start; flex-direction:column; gap:14px; }
  .oauth-attempt-actions { width:100%; flex-wrap:wrap; }
  .load-error-card, .runtime-error-card { align-items:flex-start; flex-direction:column; }
}
</style>
