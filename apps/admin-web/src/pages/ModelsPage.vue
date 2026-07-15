<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import PageHeader from '@/components/PageHeader.vue';
import { api, jsonBody } from '@/api/client';
import { useRuntimeStore } from '@/stores/runtime';

const modelState = ref<any | null>(null);
const activeTab = ref('siliconflow');
const drafts = reactive<Record<string, any>>({});
const modelOptions = reactive<Record<string, any[]>>({});
const loading = ref(false);
const saving = ref(false);
const oauthBusy = ref(false);
const runtime = useRuntimeStore();
const current = computed(() => drafts[activeTab.value]);
const supportsOAuth = computed(() => ['copilot', 'codex'].includes(activeTab.value));

async function load() {
  loading.value = true;
  try {
    const result = await api<any>('/models');
    modelState.value = result;
    activeTab.value = result.activeTab;
    for (const tab of result.tabs) {
      drafts[tab.id] = { ...tab, apiKey: '', clearApiKey: false };
    }
  } finally { loading.value = false; }
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

async function fetchModels() {
  const tab = current.value;
  if (!tab) return;
  loading.value = true;
  try {
    const result = await api<any>(`/models/${tab.id}/list`, {
      method: 'POST',
      body: jsonBody({ baseUrl: tab.baseUrl, ...(tab.apiKey ? { apiKey: tab.apiKey } : {}) }),
    });
    modelOptions[tab.id] = result.models;
    if (result.error) ElMessage.warning(result.error);
    else ElMessage.success(`已加载 ${result.models.length} 个模型`);
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '模型列表加载失败'); }
  finally { loading.value = false; }
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
    if (result.attempt?.verificationUri) window.open(result.attempt.verificationUri, '_blank', 'noopener');
    ElMessage.success(action === 'start' ? 'OAuth 设备登录已启动' : action === 'logout' ? 'OAuth 已退出' : `OAuth 状态：${result.authStatus}`);
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : 'OAuth 操作失败'); }
  finally { oauthBusy.value = false; }
}

function handleSave() { save(); }
onMounted(() => { load(); window.addEventListener('admin-save', handleSave); });
onBeforeUnmount(() => window.removeEventListener('admin-save', handleSave));
</script>

<template>
  <PageHeader :saving="saving" @save="save"><template #actions><el-button :loading="loading" @click="load">重新载入</el-button></template></PageHeader>
  <article class="panel model-panel" v-loading="loading && !modelState">
    <el-tabs v-if="modelState" v-model="activeTab" class="model-tabs">
      <el-tab-pane v-for="tab in modelState.tabs" :key="tab.id" :name="tab.id">
        <template #label><span class="tab-label"><i class="status-dot" :class="tab.authStatus === 'ready' || tab.authKind === 'manual' && tab.apiKeyConfigured ? 'ok' : 'warn'" />{{ tab.title }}</span></template>
      </el-tab-pane>
    </el-tabs>
    <div v-if="current" class="model-content">
      <div class="model-intro"><div><p class="eyebrow">{{ current.strategyId }}</p><h2>{{ current.title }}</h2><p>{{ current.description }}</p></div><el-tag effect="plain">{{ current.requestMode }}</el-tag></div>
      <div v-if="supportsOAuth" class="oauth-card">
        <div><span class="status-dot" :class="current.authStatus === 'ready' ? 'ok' : 'warn'" /><strong>OAuth {{ current.authStatus }}</strong><small>{{ current.accountLabel || current.authError || '尚未连接账号' }}</small></div>
        <div><el-button v-if="current.authStatus !== 'ready'" :loading="oauthBusy" @click="oauth('start')">启动登录</el-button><el-button v-if="current.oauthAttempt" :loading="oauthBusy" @click="oauth('poll')">检查状态</el-button><el-button v-if="current.authStatus === 'ready'" type="danger" plain :loading="oauthBusy" @click="oauth('logout')">退出 OAuth</el-button></div>
      </div>
      <el-form label-position="top" class="model-form">
        <el-form-item label="API base URL"><el-input v-model="current.baseUrl" /></el-form-item>
        <el-form-item v-if="!supportsOAuth" label="API key">
          <el-input v-model="current.apiKey" type="password" show-password :placeholder="current.apiKeyConfigured ? '已配置，留空保持原值' : '输入新的 API key'" :disabled="current.clearApiKey" />
          <el-checkbox v-if="current.apiKeyConfigured" v-model="current.clearApiKey">显式清空现有 API key</el-checkbox>
        </el-form-item>
        <el-form-item label="默认模型">
          <el-select v-if="modelOptions[current.id]?.length" v-model="current.defaultModel" filterable style="width:100%"><el-option v-for="item in modelOptions[current.id]" :key="item.modelId" :label="item.label || item.modelId" :value="item.modelId" /></el-select>
          <el-input v-else v-model="current.defaultModel"><template #append><el-button v-if="['deepseek','mimo','copilot','codex'].includes(current.id)" @click="fetchModels">拉取列表</el-button></template></el-input>
        </el-form-item>
        <el-form-item v-if="current.id === 'codex'" label="Reasoning effort"><el-segmented v-model="current.reasoningEffort" :options="['low','medium','high','xhigh']" /></el-form-item>
      </el-form>
      <div class="contract-strip"><span>Structured output</span><strong>{{ current.structuredOutputProtocol }}</strong><span>Transport model</span><strong>{{ current.transportModel || current.defaultModel }}</strong></div>
    </div>
  </article>
</template>

<style scoped>
.model-panel { overflow:hidden; }.model-tabs { padding:0 20px; }.model-tabs :deep(.el-tabs__header) { margin:0; }.tab-label { display:inline-flex; align-items:center; gap:7px; }.model-content { max-width:900px; padding:28px; }.model-intro { display:flex; justify-content:space-between; gap:20px; margin-bottom:22px; }.model-intro h2 { margin:3px 0 5px; font-size:20px; }.model-intro p { margin:0; color:var(--muted); font-size:11px; }.eyebrow { color:#8290a7 !important; font-size:9px !important; letter-spacing:.08em; }.oauth-card { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:14px 16px; margin-bottom:22px; border:1px solid #dce4f5; border-radius:10px; background:#f7f9fe; }.oauth-card > div:first-child { display:grid; grid-template-columns:auto 1fr; align-items:center; column-gap:9px; }.oauth-card small { grid-column:2; color:#788397; font-size:10px; }.model-form { max-width:720px; }.contract-strip { display:grid; grid-template-columns:140px 1fr; gap:7px 18px; margin-top:24px; padding:14px; border-radius:8px; color:#727d8f; background:#f7f8fa; font-size:10px; }.contract-strip strong { color:#455064; font-family:monospace; }
</style>
