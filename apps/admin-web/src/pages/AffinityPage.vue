<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import PageHeader from '@/components/PageHeader.vue';
import EmptyState from '@/components/EmptyState.vue';
import { rawApi, rawJsonBody } from '@/api/client';

const state = ref<any | null>(null);
const settings = reactive<any>({});
const scopes = ref<any[]>([]);
const apiKey = ref('');
const clearApiKey = ref(false);
const saving = ref(false);
const adjustOpen = ref(false);
const adjustment = reactive<any>({ userKey: '', reason: '', trust: undefined, familiarity: undefined, comfort: undefined, tension: undefined });

const directions = ['local_thread','daily_greeting','music_rehearsal','contest_discussion','computer_knowledge','web_hot_topic','relationship_scene'];

function hydrate(result: any) {
  state.value = result;
  Object.assign(settings, JSON.parse(JSON.stringify(result.settings)));
  settings.analysisModel.apiKey = '';
  scopes.value = result.scopes.map((scope: any) => ({ ...scope, enabled: Boolean(scope.enabled), proactiveEnabled: Boolean(scope.proactiveEnabled) }));
  apiKey.value = '';
  clearApiKey.value = false;
}

async function load() { hydrate(await rawApi('/affinity')); }

async function save() {
  saving.value = true;
  try {
    const clean = JSON.parse(JSON.stringify(settings));
    delete clean.analysisModel.apiKey;
    delete clean.analysisModel.apiKeyConfigured;
    const result = await rawApi<any>('/affinity/settings', {
      method: 'PATCH',
      body: rawJsonBody({ settings: clean, ...(apiKey.value ? { analysisModelApiKey: apiKey.value } : {}), ...(clearApiKey.value ? { clearAnalysisModelApiKey: true } : {}) }),
    });
    hydrate(result);
    ElMessage.success('关系事件设置已应用');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '设置保存失败'); }
  finally { saving.value = false; }
}

async function saveScopes() {
  try {
    const payload = scopes.value.map(({ characterId, scopeKind, scopeId, enabled, proactiveEnabled, label, platform, botSelfId, channelId, guildId, conversationId }: any) => ({ characterId, scopeKind, scopeId, enabled, proactiveEnabled, label, platform, botSelfId, channelId, guildId, conversationId }));
    hydrate(await rawApi('/affinity/whitelist', { method: 'PATCH', body: rawJsonBody({ scopes: payload }) }));
    ElMessage.success('范围白名单已更新');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '白名单保存失败'); }
}

function openAdjust(user: any) {
  Object.assign(adjustment, { userKey: user.userKey, reason: '', trust: undefined, familiarity: undefined, comfort: undefined, tension: undefined });
  adjustOpen.value = true;
}

async function adjust() {
  const body = Object.fromEntries(Object.entries(adjustment).filter(([, value]) => value !== undefined && value !== ''));
  hydrate(await rawApi('/affinity/adjust', { method: 'POST', body: rawJsonBody(body) }));
  adjustOpen.value = false;
  ElMessage.success('用户关系状态已调整');
}

function handleSave() { save(); }
onMounted(() => { load(); window.addEventListener('admin-save', handleSave); });
onBeforeUnmount(() => window.removeEventListener('admin-save', handleSave));
</script>

<template>
  <PageHeader :saving="saving" @save="save"><template #actions><el-tag v-if="state" :type="state.available ? 'success' : 'danger'">{{ state.available ? 'Service ready' : 'Unavailable' }}</el-tag></template></PageHeader>
  <template v-if="state">
    <section class="form-section">
      <h2 class="section-title">运行开关与主动事件</h2>
      <el-form label-position="top" class="settings-grid">
        <el-form-item label="关系系统"><el-switch v-model="settings.enabled" /></el-form-item>
        <el-form-item label="主动事件"><el-switch v-model="settings.proactiveEnabled" /></el-form-item>
        <el-form-item label="随机窗口开始"><el-input-number v-model="settings.randomWindowStartHour" :min="0" :max="23" style="width:100%" /></el-form-item>
        <el-form-item label="随机窗口结束"><el-input-number v-model="settings.randomWindowEndHour" :min="0" :max="23" style="width:100%" /></el-form-item>
        <el-form-item class="span-2" label="启用方向"><el-checkbox-group v-model="settings.enabledDirections"><el-checkbox v-for="direction in directions" :key="direction" :value="direction">{{ direction }}</el-checkbox></el-checkbox-group></el-form-item>
        <el-form-item label="允许 Web source"><el-switch v-model="settings.webSourceEnabled" /></el-form-item>
      </el-form>
    </section>
    <section class="form-section">
      <h2 class="section-title">分析模型</h2>
      <el-form label-position="top" class="settings-grid">
        <el-form-item label="Base URL"><el-input v-model="settings.analysisModel.baseUrl" /></el-form-item>
        <el-form-item label="Model"><el-input v-model="settings.analysisModel.model" /></el-form-item>
        <el-form-item label="Request mode"><el-select v-model="settings.analysisModel.requestMode" style="width:100%"><el-option value="chat_completions" /><el-option value="responses" /></el-select></el-form-item>
        <el-form-item label="Timeout (ms)"><el-input-number v-model="settings.analysisModel.timeoutMs" :controls="false" style="width:100%" /></el-form-item>
        <el-form-item label="API Key"><el-input v-model="apiKey" type="password" show-password :disabled="clearApiKey" :placeholder="settings.analysisModel.apiKeyConfigured ? '已配置，留空保持原值' : '输入新的 Secret'" /><el-checkbox v-if="settings.analysisModel.apiKeyConfigured" v-model="clearApiKey">显式清空</el-checkbox></el-form-item>
      </el-form>
    </section>
    <article class="panel data-panel">
      <div class="panel-head"><div><h2>范围白名单</h2><p>群聊/私聊范围与主动事件权限</p></div><el-button size="small" type="primary" @click="saveScopes">保存范围</el-button></div>
      <el-table :data="scopes" style="width:100%"><el-table-column prop="label" label="范围" min-width="160"><template #default="scope">{{ scope.row.label || scope.row.scopeId }}</template></el-table-column><el-table-column prop="scopeKind" label="类型" width="100" /><el-table-column prop="scopeId" label="Scope ID" min-width="160" /><el-table-column label="启用" width="90"><template #default="scope"><el-switch v-model="scope.row.enabled" /></template></el-table-column><el-table-column label="主动事件" width="110"><template #default="scope"><el-switch v-model="scope.row.proactiveEnabled" /></template></el-table-column></el-table>
    </article>
    <article class="panel data-panel">
      <div class="panel-head"><div><h2>用户关系状态</h2><p>{{ state.users.length }} 个用户</p></div></div>
      <el-table v-if="state.users.length" :data="state.users" style="width:100%"><el-table-column label="用户" min-width="170"><template #default="scope"><strong>{{ scope.row.displayName || scope.row.userKey }}</strong><div class="mono muted">{{ scope.row.userKey }}</div></template></el-table-column><el-table-column prop="stage" label="阶段" width="100" /><el-table-column prop="mood" label="Mood" width="100" /><el-table-column prop="trust" label="Trust" width="80" /><el-table-column prop="familiarity" label="熟悉" width="80" /><el-table-column prop="comfort" label="舒适" width="80" /><el-table-column prop="tension" label="紧张" width="80" /><el-table-column label="操作" width="90"><template #default="scope"><el-button size="small" @click="openAdjust(scope.row)">调整</el-button></template></el-table-column></el-table>
      <EmptyState v-else title="暂无关系用户" />
    </article>
  </template>
  <el-drawer v-model="adjustOpen" title="调整关系状态" size="min(440px, 90vw)"><el-form label-position="top"><el-form-item label="User key"><el-input v-model="adjustment.userKey" disabled /></el-form-item><el-form-item label="审计原因"><el-input v-model="adjustment.reason" /></el-form-item><el-form-item v-for="axis in ['trust','familiarity','comfort','tension']" :key="axis" :label="`${axis}（留空保持）`"><el-input-number v-model="adjustment[axis]" :controls="false" style="width:100%" /></el-form-item><el-button type="primary" :disabled="!adjustment.reason" @click="adjust">应用调整</el-button></el-form></el-drawer>
</template>

<style scoped>.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 24px}.span-2{grid-column:1/-1}.data-panel{max-width:1100px;margin-top:18px;overflow:hidden}.data-panel strong{font-size:11px}@media(max-width:760px){.settings-grid{grid-template-columns:1fr}.span-2{grid-column:auto}}</style>
