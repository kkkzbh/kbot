<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import EmptyState from '@/components/EmptyState.vue';
import PendingChangesBar from '@/components/PendingChangesBar.vue';
import { rawApi, rawJsonBody } from '@/api/client';

const state = ref<any | null>(null);
const settings = reactive<any>({});
const scopes = ref<any[]>([]);
const savedSettingsText = ref('{}');
const savedScopesText = ref('[]');
const saving = ref(false);
const adjustOpen = ref(false);
const adjustment = reactive<any>({ userKey: '', reason: '', trust: undefined, familiarity: undefined, comfort: undefined, tension: undefined });

const directions = ['local_thread','daily_greeting','music_rehearsal','contest_discussion','computer_knowledge','web_hot_topic','relationship_scene'];
const cleanSettings = computed(() => JSON.parse(JSON.stringify(settings)));
const scopePayload = computed(() => scopes.value.map(({
  characterId,
  scopeKind,
  scopeId,
  enabled,
  proactiveEnabled,
  label,
  platform,
  botSelfId,
  channelId,
  guildId,
  conversationId,
}: any) => ({
  characterId,
  scopeKind,
  scopeId,
  enabled,
  proactiveEnabled,
  label,
  platform,
  botSelfId,
  channelId,
  guildId,
  conversationId,
})));
const settingsChanged = computed(() => JSON.stringify(cleanSettings.value) !== savedSettingsText.value);
const scopesChanged = computed(() => JSON.stringify(scopePayload.value) !== savedScopesText.value);
const hasUnsavedChanges = computed(() => settingsChanged.value || scopesChanged.value);

function hydrate(result: any) {
  state.value = result;
  Object.assign(settings, JSON.parse(JSON.stringify(result.settings)));
  scopes.value = result.scopes.map((scope: any) => ({ ...scope, enabled: Boolean(scope.enabled), proactiveEnabled: Boolean(scope.proactiveEnabled) }));
  savedSettingsText.value = JSON.stringify(cleanSettings.value);
  savedScopesText.value = JSON.stringify(scopePayload.value);
}

async function load() { hydrate(await rawApi('/affinity')); }

async function save() {
  if (!hasUnsavedChanges.value) return;
  saving.value = true;
  try {
    let result = state.value;
    if (settingsChanged.value) {
      result = await rawApi<any>('/affinity/settings', {
        method: 'PATCH',
        body: rawJsonBody({ settings: cleanSettings.value }),
      });
    }
    if (scopesChanged.value) {
      result = await rawApi<any>('/affinity/whitelist', {
        method: 'PATCH',
        body: rawJsonBody({ scopes: scopePayload.value }),
      });
    }
    hydrate(result);
    ElMessage.success('关系事件配置已保存并生效。');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '设置保存失败'); }
  finally { saving.value = false; }
}

async function discardChanges(): Promise<void> {
  if (!hasUnsavedChanges.value) return;
  try {
    await ElMessageBox.confirm(
      '将丢弃尚未保存的关系事件设置与范围修改。',
      '放弃未保存修改？',
      { type: 'warning', confirmButtonText: '放弃修改', cancelButtonText: '继续编辑' },
    );
  } catch {
    return;
  }
  await load();
}

function openAdjust(user: any) {
  Object.assign(adjustment, { userKey: user.userKey, reason: '', trust: undefined, familiarity: undefined, comfort: undefined, tension: undefined });
  adjustOpen.value = true;
}

async function adjust() {
  const body = Object.fromEntries(Object.entries(adjustment).filter(([, value]) => value !== undefined && value !== ''));
  const result = await rawApi<any>('/affinity/adjust', { method: 'POST', body: rawJsonBody(body) });
  if (state.value) state.value.users = result.users;
  adjustOpen.value = false;
  ElMessage.success('用户关系状态已调整');
}

function beforeUnload(event: BeforeUnloadEvent): void {
  if (!hasUnsavedChanges.value) return;
  event.preventDefault();
  event.returnValue = '';
}

onBeforeRouteLeave(async () => {
  if (!hasUnsavedChanges.value) return true;
  try {
    await ElMessageBox.confirm(
      '关系事件配置仍有未保存修改。',
      '离开关系事件？',
      { type: 'warning', confirmButtonText: '放弃并离开', cancelButtonText: '继续编辑' },
    );
    return true;
  } catch {
    return false;
  }
});

function handleSave() { void save(); }
onMounted(() => {
  void load();
  window.addEventListener('admin-save', handleSave);
  window.addEventListener('beforeunload', beforeUnload);
});
onBeforeUnmount(() => {
  window.removeEventListener('admin-save', handleSave);
  window.removeEventListener('beforeunload', beforeUnload);
});
</script>

<template>
  <template v-if="state">
    <section class="form-section">
      <div class="section-head">
        <h2 class="section-title">运行开关与主动事件</h2>
        <el-tag :type="state.available ? 'success' : 'danger'">
          {{ state.available ? '服务可用' : '服务不可用' }}
        </el-tag>
      </div>
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
      <div class="model-owner">
        <h2 class="section-title">分析模型</h2>
        <el-button tag="a" href="/intelligence/models">前往模型配置</el-button>
      </div>
    </section>
    <article class="panel data-panel">
      <div class="panel-head"><h2>范围白名单</h2></div>
      <el-table :data="scopes" style="width:100%"><el-table-column prop="label" label="范围" min-width="160"><template #default="scope">{{ scope.row.label || scope.row.scopeId }}</template></el-table-column><el-table-column prop="scopeKind" label="类型" width="100" /><el-table-column prop="scopeId" label="Scope ID" min-width="160" /><el-table-column label="启用" width="90"><template #default="scope"><el-switch v-model="scope.row.enabled" /></template></el-table-column><el-table-column label="主动事件" width="110"><template #default="scope"><el-switch v-model="scope.row.proactiveEnabled" /></template></el-table-column></el-table>
    </article>
    <article class="panel data-panel">
      <div class="panel-head"><h2>用户关系状态</h2></div>
      <el-table v-if="state.users.length" :data="state.users" style="width:100%"><el-table-column label="用户" min-width="170"><template #default="scope"><strong>{{ scope.row.displayName || scope.row.userKey }}</strong></template></el-table-column><el-table-column prop="stage" label="阶段" width="100" /><el-table-column prop="mood" label="Mood" width="100" /><el-table-column prop="trust" label="Trust" width="80" /><el-table-column prop="familiarity" label="熟悉" width="80" /><el-table-column prop="comfort" label="舒适" width="80" /><el-table-column prop="tension" label="紧张" width="80" /><el-table-column label="操作" width="90"><template #default="scope"><el-button size="small" @click="openAdjust(scope.row)">调整</el-button></template></el-table-column></el-table>
      <EmptyState v-else title="暂无关系用户" />
    </article>
    <PendingChangesBar
      v-if="hasUnsavedChanges"
      :saving="saving"
      save-label="保存关系配置"
      @discard="discardChanges"
      @save="save"
    />
  </template>
  <el-drawer v-model="adjustOpen" title="调整关系状态" size="min(440px, 90vw)"><el-form label-position="top"><el-form-item label="User key"><el-input v-model="adjustment.userKey" disabled /></el-form-item><el-form-item label="审计原因"><el-input v-model="adjustment.reason" /></el-form-item><el-form-item v-for="axis in ['trust','familiarity','comfort','tension']" :key="axis" :label="`${axis}（留空保持）`"><el-input-number v-model="adjustment[axis]" :controls="false" style="width:100%" /></el-form-item><el-button type="primary" :disabled="!adjustment.reason" @click="adjust">应用调整</el-button></el-form></el-drawer>
</template>

<style scoped>.section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 24px}.span-2{grid-column:1/-1}.model-owner{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 16px;border:1px solid #dfe6f2;border-radius:10px;background:#f8faff}.model-owner .section-title{margin:0}.data-panel{max-width:1100px;margin-top:18px;overflow:hidden}.data-panel strong{font-size:11px}@media(max-width:760px){.settings-grid{grid-template-columns:1fr}.span-2{grid-column:auto}.model-owner{align-items:flex-start;flex-direction:column}}</style>
