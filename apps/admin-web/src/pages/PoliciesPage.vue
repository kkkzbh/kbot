<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { onBeforeRouteLeave } from 'vue-router';
import { fileSystemToolSettingKeys } from '@contracts';
import EmptyState from '@/components/EmptyState.vue';
import ManagedSettingsGrid from '@/components/ManagedSettingsGrid.vue';
import PendingChangesBar from '@/components/PendingChangesBar.vue';
import { rawApi, rawJsonBody } from '@/api/client';
import { useRuntimeStore } from '@/stores/runtime';
import { useManagedFeatureSettings } from './managed-settings';
import {
  buildToolOverride,
  canAddToolOverride,
  createPolicyScopeOptions,
  createToolOverrideDraft,
  hasToolOverride,
  type PolicyScopeOption,
  type ToolOverrideInput,
} from './policy-page-state';

const state = ref<any | null>(null);
const toolOverrides = ref<any[]>([]);
const savedToolOverridesText = ref('[]');
const activeTab = ref('tools');
const saving = ref(false);
const addToolOpen = ref(false);
const toolDraft = reactive(createToolOverrideDraft());
const toolScope = ref<PolicyScopeOption | null>(null);
const toolScopeOptions = computed(() => createPolicyScopeOptions(
  state.value?.tools.defaultScopes || [],
  state.value?.tools.scopes || [],
));
const {
  fields: fileSystemFields,
  draft: fileSystemDraft,
  clearSecrets: fileSystemClearSecrets,
  hasChanges: hasFileSystemChanges,
  load: loadFileSystemSettings,
  save: saveFileSystemSettings,
} = useManagedFeatureSettings(fileSystemToolSettingKeys);
const memorySearchPolicy = computed(() =>
  state.value?.tools.catalog.find((tool: any) => tool.toolName === 'memory_search') ?? null);
const toolOverrideDuplicate = computed(() => hasToolOverride(
  toolOverrides.value as ToolOverrideInput[],
  toolDraft,
  toolScope.value,
));
const toolOverrideReady = computed(() =>
  canAddToolOverride(toolDraft, toolScope.value) && !toolOverrideDuplicate.value);
const runtime = useRuntimeStore();
const serializedToolOverrides = computed(() => JSON.stringify(
  toolOverrides.value.map(({ toolName, routeProfile, scopeKind, scopeId, enabled }) => ({
    toolName,
    routeProfile,
    scopeKind,
    scopeId,
    enabled,
  })),
));
const toolOverridesChanged = computed(() => (
  serializedToolOverrides.value !== savedToolOverridesText.value
));
const hasUnsavedChanges = computed(() => (
  toolOverridesChanged.value || hasFileSystemChanges.value
));

async function load() {
  const [result] = await Promise.all([
    rawApi<any>('/policies'),
    loadFileSystemSettings(),
  ]);
  state.value = result;
  toolOverrides.value = result.tools.overrides.map((item: any) => ({ ...item, enabled: Boolean(item.enabled) }));
  savedToolOverridesText.value = serializedToolOverrides.value;
}

function addTool() {
  toolOverrides.value.push(buildToolOverride(toolDraft, toolScope.value));
  addToolOpen.value = false;
}

function openToolDialog() {
  Object.assign(toolDraft, createToolOverrideDraft());
  toolScope.value = null;
  addToolOpen.value = true;
}

async function save() {
  if (!hasUnsavedChanges.value || runtime.restartInProgress) return;
  saving.value = true;
  try {
    if (toolOverridesChanged.value) {
      await rawApi('/policies/tools', {
        method: 'PATCH',
        body: rawJsonBody({ overrides: JSON.parse(serializedToolOverrides.value) }),
      });
    }
    if (hasFileSystemChanges.value) await saveFileSystemSettings();
    ElMessage.success('工具策略已保存');
    await load();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '策略保存失败'); }
  finally { saving.value = false; }
}

async function discardChanges(): Promise<void> {
  if (!hasUnsavedChanges.value) return;
  try {
    await ElMessageBox.confirm(
      '将丢弃尚未保存的工具权限与文件系统配置。',
      '放弃未保存修改？',
      { type: 'warning', confirmButtonText: '放弃修改', cancelButtonText: '继续编辑' },
    );
  } catch {
    return;
  }
  await load();
}

async function conversationAction(target: any, action: 'clear'|'delete') {
  await ElMessageBox.confirm(action === 'clear' ? `清空 ${target.roomName} 的聊天记录？` : `永久删除 ${target.roomName} 及关联房间？`, action === 'clear' ? '清空会话' : '删除会话', { type: 'warning' });
  const result = await rawApi<any>(action === 'clear' ? '/conversations/clear' : '/conversations', {
    method: action === 'clear' ? 'POST' : 'DELETE',
    body: rawJsonBody({ roomId: target.roomId, conversationId: target.conversationId }),
  });
  ElMessage.success(action === 'clear' ? `已清理 ${result.result.deletedMessages} 条消息` : '会话与房间已删除');
  const latest = await rawApi<any>('/policies');
  if (state.value) state.value.conversationTargets = latest.conversationTargets;
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
      '工具策略仍有未保存修改。',
      '离开策略配置？',
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
  <article v-if="state" class="panel policy-panel">
    <el-tabs v-model="activeTab" class="policy-tabs">
      <el-tab-pane label="工具策略" name="tools" />
      <el-tab-pane label="会话数据" name="conversations" />
    </el-tabs>
    <template v-if="activeTab==='tools'">
      <section class="domain-settings">
        <div class="panel-head subhead">
          <h2>文件系统工具</h2>
        </div>
        <ManagedSettingsGrid
          v-model="fileSystemDraft"
          v-model:clear-secrets="fileSystemClearSecrets"
          :fields="fileSystemFields"
        />
      </section>
      <div v-if="memorySearchPolicy" class="core-tool-row">
        <div class="core-tool-copy">
          <strong>{{ memorySearchPolicy.title }}</strong>
        </div>
        <div class="core-tool-access" aria-label="记忆检索可用范围">
          <span class="allowed">主 Agent</span>
          <span class="allowed">Automation</span>
          <span class="blocked">Sub-Agent 禁止</span>
        </div>
      </div>
      <div class="panel-head subhead"><h2>工具权限覆盖</h2><el-button size="small" @click="openToolDialog">添加覆盖</el-button></div>
      <el-table v-if="toolOverrides.length" :data="toolOverrides" style="width:100%"><el-table-column prop="toolName" label="工具" min-width="190" /><el-table-column prop="routeProfile" label="Route" width="110" /><el-table-column prop="scopeKind" label="范围类型" width="160" /><el-table-column prop="scopeId" label="范围 ID" min-width="150" /><el-table-column label="启用" width="90"><template #default="scope"><el-switch v-model="scope.row.enabled" /></template></el-table-column><el-table-column label="操作" width="80"><template #default="scope"><el-button text type="danger" @click="toolOverrides.splice(scope.$index,1)">移除</el-button></template></el-table-column></el-table>
      <EmptyState v-else title="没有工具覆盖" />
    </template>
    <template v-else>
      <div class="panel-head subhead"><h2>会话数据管理</h2></div>
      <el-table :data="state.conversationTargets" style="width:100%"><el-table-column prop="roomName" label="会话" min-width="180" /><el-table-column prop="scopeKind" label="类型" width="90" /><el-table-column prop="scopeId" label="Scope" min-width="130" /><el-table-column prop="conversationId" label="Conversation ID" min-width="220"><template #default="scope"><span class="mono">{{ scope.row.conversationId }}</span></template></el-table-column><el-table-column label="操作" width="180"><template #default="scope"><el-button size="small" @click="conversationAction(scope.row,'clear')">清空</el-button><el-button size="small" type="danger" plain @click="conversationAction(scope.row,'delete')">删除</el-button></template></el-table-column></el-table>
    </template>
  </article>
  <PendingChangesBar
    v-if="hasUnsavedChanges"
    :saving="saving"
    :disabled="runtime.restartInProgress"
    save-label="保存策略"
    @discard="discardChanges"
    @save="save"
  />

  <el-dialog v-model="addToolOpen" title="添加工具覆盖" width="min(520px, calc(100vw - 32px))"><el-form label-position="top"><el-form-item label="工具"><el-select v-model="toolDraft.toolName" filterable style="width:100%"><el-option v-for="tool in state?.tools.catalog" :key="tool.toolName" :label="tool.title || tool.toolName" :value="tool.toolName" /></el-select></el-form-item><el-form-item label="Route"><el-select v-model="toolDraft.routeProfile" style="width:100%"><el-option v-for="route in state?.tools.routeProfiles" :key="route" :value="route" /></el-select></el-form-item><el-form-item label="范围" :error="toolOverrideDuplicate ? '该范围已有此工具与 Route 覆盖' : ''"><el-select v-model="toolScope" value-key="key" placeholder="请选择范围" style="width:100%"><el-option v-for="scope in toolScopeOptions" :key="scope.key" :label="scope.label" :value="scope" /></el-select></el-form-item><el-form-item label="启用"><el-switch v-model="toolDraft.enabled" /></el-form-item></el-form><template #footer><el-button @click="addToolOpen=false">取消</el-button><el-button type="primary" :disabled="!toolOverrideReady" @click="addTool">添加</el-button></template></el-dialog>
</template>

<style scoped>
.policy-panel{overflow:hidden}
.policy-tabs{padding:0 20px}
.policy-tabs :deep(.el-tabs__header){margin:0}
.subhead{border-top:0}
.policy-panel :deep(.el-table__cell){font-size:11px}
.domain-settings{padding:0 20px 18px;border-bottom:1px solid var(--line)}
.domain-settings .panel-head{padding-right:0;padding-left:0}
.core-tool-row{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:16px 20px 0;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:#f8fafc}
.core-tool-copy{min-width:0}
.core-tool-copy strong{font-size:14px;color:var(--ink)}
.core-tool-access{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.core-tool-access span{padding:3px 8px;border-radius:999px;font-size:11px;line-height:1.4}
.core-tool-access .allowed{color:#287659;background:#eaf7f0}
.core-tool-access .blocked{color:#a64c4c;background:#fff0f0}
@media(max-width:720px){
  .core-tool-row{align-items:flex-start;flex-direction:column;gap:10px}
  .core-tool-access{flex-wrap:wrap}
}
</style>
