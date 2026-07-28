<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import PageHeader from '@/components/PageHeader.vue';
import EmptyState from '@/components/EmptyState.vue';
import { rawApi, rawJsonBody } from '@/api/client';
import {
  buildFeatureOverride,
  buildToolOverride,
  canAddFeatureOverride,
  canAddToolOverride,
  createPolicyScopeOptions,
  createFeatureOverrideDraft,
  createToolOverrideDraft,
  hasFeatureOverride,
  hasToolOverride,
  type FeatureOverrideInput,
  type PolicyScopeOption,
  type ToolOverrideInput,
} from './policy-page-state';

const state = ref<any | null>(null);
const featureOverrides = ref<any[]>([]);
const toolOverrides = ref<any[]>([]);
const activeTab = ref('features');
const saving = ref(false);
const addFeatureOpen = ref(false);
const addToolOpen = ref(false);
const featureDraft = reactive(createFeatureOverrideDraft());
const toolDraft = reactive(createToolOverrideDraft());
const featureScope = ref<PolicyScopeOption | null>(null);
const toolScope = ref<PolicyScopeOption | null>(null);
const featureScopeOptions = computed(() => createPolicyScopeOptions(state.value?.featureScopes || []));
const toolScopeOptions = computed(() => createPolicyScopeOptions(
  state.value?.tools.defaultScopes || [],
  state.value?.tools.scopes || [],
));
const memorySearchPolicy = computed(() =>
  state.value?.tools.catalog.find((tool: any) => tool.toolName === 'memory_search') ?? null);
const featureOverrideDuplicate = computed(() => hasFeatureOverride(
  featureOverrides.value as FeatureOverrideInput[],
  featureDraft,
  featureScope.value,
));
const toolOverrideDuplicate = computed(() => hasToolOverride(
  toolOverrides.value as ToolOverrideInput[],
  toolDraft,
  toolScope.value,
));
const featureOverrideReady = computed(() =>
  canAddFeatureOverride(featureScope.value) && !featureOverrideDuplicate.value);
const toolOverrideReady = computed(() =>
  canAddToolOverride(toolDraft, toolScope.value) && !toolOverrideDuplicate.value);
const featureKeys = ['QQBOT_REALTIME_MESSAGE_ENABLED','QQ_VOICE_INPUT_ENABLED','QQ_VOICE_OUTPUT_ENABLED','CHAT_NATURAL_TRIGGER_ENABLED','QQBOT_REPLY_INTERRUPT_ENABLED'];

async function load() {
  const result = await rawApi<any>('/policies');
  state.value = result;
  featureOverrides.value = result.featureOverrides.map((item: any) => ({ ...item, enabled: Boolean(item.enabled) }));
  toolOverrides.value = result.tools.overrides.map((item: any) => ({ ...item, enabled: Boolean(item.enabled) }));
}

function addFeature() {
  featureOverrides.value.push(buildFeatureOverride(featureDraft, featureScope.value));
  addFeatureOpen.value = false;
}
function addTool() {
  toolOverrides.value.push(buildToolOverride(toolDraft, toolScope.value));
  addToolOpen.value = false;
}

function openFeatureDialog() {
  Object.assign(featureDraft, createFeatureOverrideDraft());
  featureScope.value = null;
  addFeatureOpen.value = true;
}

function openToolDialog() {
  Object.assign(toolDraft, createToolOverrideDraft());
  toolScope.value = null;
  addToolOpen.value = true;
}

async function save() {
  saving.value = true;
  try {
    await Promise.all([
      rawApi('/policies/features', { method: 'PATCH', body: rawJsonBody({ overrides: featureOverrides.value.map(({ featureKey,scopeKind,scopeId,enabled }) => ({ featureKey,scopeKind,scopeId,enabled })) }) }),
      rawApi('/policies/tools', { method: 'PATCH', body: rawJsonBody({ overrides: toolOverrides.value.map(({ toolName,routeProfile,scopeKind,scopeId,enabled }) => ({ toolName,routeProfile,scopeKind,scopeId,enabled })) }) }),
    ]);
    ElMessage.success('功能与工具策略已保存');
    await load();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '策略保存失败'); }
  finally { saving.value = false; }
}

async function conversationAction(target: any, action: 'clear'|'delete') {
  await ElMessageBox.confirm(action === 'clear' ? `清空 ${target.roomName} 的聊天记录？` : `永久删除 ${target.roomName} 及关联房间？`, action === 'clear' ? '清空会话' : '删除会话', { type: 'warning' });
  const result = await rawApi<any>(action === 'clear' ? '/conversations/clear' : '/conversations', {
    method: action === 'clear' ? 'POST' : 'DELETE',
    body: rawJsonBody({ roomId: target.roomId, conversationId: target.conversationId }),
  });
  ElMessage.success(action === 'clear' ? `已清理 ${result.result.deletedMessages} 条消息` : '会话与房间已删除');
  await load();
}

function handleSave() { save(); }
onMounted(() => { load(); window.addEventListener('admin-save', handleSave); });
onBeforeUnmount(() => window.removeEventListener('admin-save', handleSave));
</script>

<template>
  <PageHeader :saving="saving" @save="save"><template #actions><el-button :loading="!state" @click="load">重新载入</el-button></template></PageHeader>
  <article v-if="state" class="panel policy-panel">
    <el-tabs v-model="activeTab" class="policy-tabs">
      <el-tab-pane label="功能策略" name="features" />
      <el-tab-pane label="工具策略" name="tools" />
      <el-tab-pane label="会话数据" name="conversations" />
    </el-tabs>
    <template v-if="activeTab==='features'">
      <div class="panel-head subhead"><div><h2>功能范围覆盖</h2><p>未列出的范围继承 env 全局配置</p></div><el-button size="small" @click="openFeatureDialog">添加覆盖</el-button></div>
      <el-table v-if="featureOverrides.length" :data="featureOverrides" style="width:100%"><el-table-column prop="featureKey" label="功能" min-width="240" /><el-table-column prop="scopeKind" label="范围类型" width="140" /><el-table-column prop="scopeId" label="范围 ID" min-width="160" /><el-table-column label="启用" width="90"><template #default="scope"><el-switch v-model="scope.row.enabled" /></template></el-table-column><el-table-column label="操作" width="80"><template #default="scope"><el-button text type="danger" @click="featureOverrides.splice(scope.$index,1)">移除</el-button></template></el-table-column></el-table>
      <EmptyState v-else title="没有功能覆盖" description="所有会话当前继承全局功能设置。" />
    </template>
    <template v-else-if="activeTab==='tools'">
      <div v-if="memorySearchPolicy" class="core-tool-row">
        <div class="core-tool-copy">
          <strong>{{ memorySearchPolicy.title }}</strong>
          <span>{{ memorySearchPolicy.description }}</span>
        </div>
        <div class="core-tool-access" aria-label="记忆检索可用范围">
          <span class="allowed">主 Agent</span>
          <span class="allowed">Automation</span>
          <span class="blocked">Sub-Agent 禁止</span>
        </div>
      </div>
      <div class="panel-head subhead"><div><h2>工具权限覆盖</h2><p>{{ state.tools.catalog.length }} 个工具 · {{ state.tools.routeProfiles.length }} 条 route</p></div><el-button size="small" @click="openToolDialog">添加覆盖</el-button></div>
      <el-table v-if="toolOverrides.length" :data="toolOverrides" style="width:100%"><el-table-column prop="toolName" label="工具" min-width="190" /><el-table-column prop="routeProfile" label="Route" width="110" /><el-table-column prop="scopeKind" label="范围类型" width="160" /><el-table-column prop="scopeId" label="范围 ID" min-width="150" /><el-table-column label="启用" width="90"><template #default="scope"><el-switch v-model="scope.row.enabled" /></template></el-table-column><el-table-column label="操作" width="80"><template #default="scope"><el-button text type="danger" @click="toolOverrides.splice(scope.$index,1)">移除</el-button></template></el-table-column></el-table>
      <EmptyState v-else title="没有工具覆盖" description="所有工具当前使用 route 的默认工具集。" />
    </template>
    <template v-else>
      <div class="panel-head subhead"><div><h2>会话数据管理</h2><p>清空消息或删除完整 room 边界</p></div></div>
      <el-table :data="state.conversationTargets" style="width:100%"><el-table-column prop="roomName" label="会话" min-width="180" /><el-table-column prop="scopeKind" label="类型" width="90" /><el-table-column prop="scopeId" label="Scope" min-width="130" /><el-table-column prop="conversationId" label="Conversation ID" min-width="220"><template #default="scope"><span class="mono">{{ scope.row.conversationId }}</span></template></el-table-column><el-table-column label="操作" width="180"><template #default="scope"><el-button size="small" @click="conversationAction(scope.row,'clear')">清空</el-button><el-button size="small" type="danger" plain @click="conversationAction(scope.row,'delete')">删除</el-button></template></el-table-column></el-table>
    </template>
  </article>

  <el-dialog v-model="addFeatureOpen" title="添加功能覆盖" width="min(520px, calc(100vw - 32px))"><el-form label-position="top"><el-form-item label="功能"><el-select v-model="featureDraft.featureKey" style="width:100%"><el-option v-for="key in featureKeys" :key="key" :value="key" /></el-select></el-form-item><el-form-item label="范围" :error="featureOverrideDuplicate ? '该范围已有此功能覆盖' : ''"><el-select v-model="featureScope" value-key="key" placeholder="请选择范围" style="width:100%"><el-option v-for="scope in featureScopeOptions" :key="scope.key" :label="scope.label" :value="scope" /></el-select></el-form-item><el-form-item label="启用"><el-switch v-model="featureDraft.enabled" /></el-form-item></el-form><template #footer><el-button @click="addFeatureOpen=false">取消</el-button><el-button type="primary" :disabled="!featureOverrideReady" @click="addFeature">添加</el-button></template></el-dialog>
  <el-dialog v-model="addToolOpen" title="添加工具覆盖" width="min(520px, calc(100vw - 32px))"><el-form label-position="top"><el-form-item label="工具"><el-select v-model="toolDraft.toolName" filterable style="width:100%"><el-option v-for="tool in state?.tools.catalog" :key="tool.toolName" :label="tool.title || tool.toolName" :value="tool.toolName" /></el-select></el-form-item><el-form-item label="Route"><el-select v-model="toolDraft.routeProfile" style="width:100%"><el-option v-for="route in state?.tools.routeProfiles" :key="route" :value="route" /></el-select></el-form-item><el-form-item label="范围" :error="toolOverrideDuplicate ? '该范围已有此工具与 Route 覆盖' : ''"><el-select v-model="toolScope" value-key="key" placeholder="请选择范围" style="width:100%"><el-option v-for="scope in toolScopeOptions" :key="scope.key" :label="scope.label" :value="scope" /></el-select></el-form-item><el-form-item label="启用"><el-switch v-model="toolDraft.enabled" /></el-form-item></el-form><template #footer><el-button @click="addToolOpen=false">取消</el-button><el-button type="primary" :disabled="!toolOverrideReady" @click="addTool">添加</el-button></template></el-dialog>
</template>

<style scoped>
.policy-panel{overflow:hidden}
.policy-tabs{padding:0 20px}
.policy-tabs :deep(.el-tabs__header){margin:0}
.subhead{border-top:0}
.policy-panel :deep(.el-table__cell){font-size:11px}
.core-tool-row{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:16px 20px 0;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:#f8fafc}
.core-tool-copy{display:grid;gap:3px;min-width:0}
.core-tool-copy strong{font-size:14px;color:var(--ink)}
.core-tool-copy span{font-size:12px;color:var(--muted)}
.core-tool-access{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.core-tool-access span{padding:3px 8px;border-radius:999px;font-size:11px;line-height:1.4}
.core-tool-access .allowed{color:#287659;background:#eaf7f0}
.core-tool-access .blocked{color:#a64c4c;background:#fff0f0}
@media(max-width:720px){
  .core-tool-row{align-items:flex-start;flex-direction:column;gap:10px}
  .core-tool-access{flex-wrap:wrap}
}
</style>
