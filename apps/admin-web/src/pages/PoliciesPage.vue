<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import PageHeader from '@/components/PageHeader.vue';
import EmptyState from '@/components/EmptyState.vue';
import { api, jsonBody } from '@/api/client';

const state = ref<any | null>(null);
const featureOverrides = ref<any[]>([]);
const toolOverrides = ref<any[]>([]);
const activeTab = ref('features');
const saving = ref(false);
const addFeatureOpen = ref(false);
const addToolOpen = ref(false);
const featureDraft = reactive<any>({ featureKey: 'QQBOT_REALTIME_MESSAGE_ENABLED', scopeKind: 'private_default', scopeId: 'default', enabled: true });
const toolDraft = reactive<any>({ toolName: '', routeProfile: 'agent', scopeKind: 'global_default', scopeId: 'global', enabled: true });
const featureKeys = ['QQBOT_REALTIME_MESSAGE_ENABLED','QQ_VOICE_INPUT_ENABLED','QQ_VOICE_OUTPUT_ENABLED','CHAT_NATURAL_TRIGGER_ENABLED','QQBOT_REPLY_INTERRUPT_ENABLED'];

async function load() {
  const result = await api<any>('/policies');
  state.value = result;
  featureOverrides.value = result.featureOverrides.map((item: any) => ({ ...item, enabled: Boolean(item.enabled) }));
  toolOverrides.value = result.tools.overrides.map((item: any) => ({ ...item, enabled: Boolean(item.enabled) }));
}

function addFeature() {
  featureOverrides.value.push({ ...featureDraft });
  addFeatureOpen.value = false;
}
function addTool() {
  toolOverrides.value.push({ ...toolDraft });
  addToolOpen.value = false;
}

async function save() {
  saving.value = true;
  try {
    await Promise.all([
      api('/policies/features', { method: 'PATCH', body: jsonBody({ overrides: featureOverrides.value.map(({ featureKey,scopeKind,scopeId,enabled }) => ({ featureKey,scopeKind,scopeId,enabled })) }) }),
      api('/policies/tools', { method: 'PATCH', body: jsonBody({ overrides: toolOverrides.value.map(({ toolName,routeProfile,scopeKind,scopeId,enabled }) => ({ toolName,routeProfile,scopeKind,scopeId,enabled })) }) }),
    ]);
    ElMessage.success('功能与工具策略已保存');
    await load();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '策略保存失败'); }
  finally { saving.value = false; }
}

async function conversationAction(target: any, action: 'clear'|'delete') {
  await ElMessageBox.confirm(action === 'clear' ? `清空 ${target.roomName} 的聊天记录？` : `永久删除 ${target.roomName} 及关联房间？`, action === 'clear' ? '清空会话' : '删除会话', { type: 'warning' });
  const result = await api<any>(action === 'clear' ? '/conversations/clear' : '/conversations', {
    method: action === 'clear' ? 'POST' : 'DELETE',
    body: jsonBody({ roomId: target.roomId, conversationId: target.conversationId }),
  });
  ElMessage.success(action === 'clear' ? `已清理 ${result.result.deletedMessages} 条消息` : '会话与房间已删除');
  await load();
}

function selectFeatureScope(scope: any) { featureDraft.scopeKind = scope.scopeKind; featureDraft.scopeId = scope.scopeId; }
function selectToolScope(scope: any) { toolDraft.scopeKind = scope.scopeKind; toolDraft.scopeId = scope.scopeId; }
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
      <div class="panel-head subhead"><div><h2>功能范围覆盖</h2><p>未列出的范围继承 env 全局配置</p></div><el-button size="small" @click="addFeatureOpen=true">添加覆盖</el-button></div>
      <el-table v-if="featureOverrides.length" :data="featureOverrides" style="width:100%"><el-table-column prop="featureKey" label="功能" min-width="240" /><el-table-column prop="scopeKind" label="范围类型" width="140" /><el-table-column prop="scopeId" label="范围 ID" min-width="160" /><el-table-column label="启用" width="90"><template #default="scope"><el-switch v-model="scope.row.enabled" /></template></el-table-column><el-table-column label="操作" width="80"><template #default="scope"><el-button text type="danger" @click="featureOverrides.splice(scope.$index,1)">移除</el-button></template></el-table-column></el-table>
      <EmptyState v-else title="没有功能覆盖" description="所有会话当前继承全局功能设置。" />
    </template>
    <template v-else-if="activeTab==='tools'">
      <div class="panel-head subhead"><div><h2>工具权限覆盖</h2><p>{{ state.tools.catalog.length }} 个工具 · {{ state.tools.routeProfiles.length }} 条 route</p></div><el-button size="small" @click="addToolOpen=true">添加覆盖</el-button></div>
      <el-table v-if="toolOverrides.length" :data="toolOverrides" style="width:100%"><el-table-column prop="toolName" label="工具" min-width="190" /><el-table-column prop="routeProfile" label="Route" width="110" /><el-table-column prop="scopeKind" label="范围类型" width="160" /><el-table-column prop="scopeId" label="范围 ID" min-width="150" /><el-table-column label="启用" width="90"><template #default="scope"><el-switch v-model="scope.row.enabled" /></template></el-table-column><el-table-column label="操作" width="80"><template #default="scope"><el-button text type="danger" @click="toolOverrides.splice(scope.$index,1)">移除</el-button></template></el-table-column></el-table>
      <EmptyState v-else title="没有工具覆盖" description="所有工具当前使用 route 的默认工具集。" />
    </template>
    <template v-else>
      <div class="panel-head subhead"><div><h2>会话数据管理</h2><p>清空消息或删除完整 room 边界</p></div></div>
      <el-table :data="state.conversationTargets" style="width:100%"><el-table-column prop="roomName" label="会话" min-width="180" /><el-table-column prop="scopeKind" label="类型" width="90" /><el-table-column prop="scopeId" label="Scope" min-width="130" /><el-table-column prop="conversationId" label="Conversation ID" min-width="220"><template #default="scope"><span class="mono">{{ scope.row.conversationId }}</span></template></el-table-column><el-table-column label="操作" width="180"><template #default="scope"><el-button size="small" @click="conversationAction(scope.row,'clear')">清空</el-button><el-button size="small" type="danger" plain @click="conversationAction(scope.row,'delete')">删除</el-button></template></el-table-column></el-table>
    </template>
  </article>

  <el-dialog v-model="addFeatureOpen" title="添加功能覆盖" width="min(520px, calc(100vw - 32px))"><el-form label-position="top"><el-form-item label="功能"><el-select v-model="featureDraft.featureKey" style="width:100%"><el-option v-for="key in featureKeys" :key="key" :value="key" /></el-select></el-form-item><el-form-item label="范围"><el-select style="width:100%" @change="selectFeatureScope(JSON.parse($event))"><el-option v-for="scope in state?.featureScopes" :key="`${scope.scopeKind}:${scope.scopeId}`" :label="scope.roomName" :value="JSON.stringify(scope)" /></el-select></el-form-item><el-form-item label="启用"><el-switch v-model="featureDraft.enabled" /></el-form-item></el-form><template #footer><el-button @click="addFeatureOpen=false">取消</el-button><el-button type="primary" @click="addFeature">添加</el-button></template></el-dialog>
  <el-dialog v-model="addToolOpen" title="添加工具覆盖" width="min(520px, calc(100vw - 32px))"><el-form label-position="top"><el-form-item label="工具"><el-select v-model="toolDraft.toolName" filterable style="width:100%"><el-option v-for="tool in state?.tools.catalog" :key="tool.toolName" :label="tool.title || tool.toolName" :value="tool.toolName" /></el-select></el-form-item><el-form-item label="Route"><el-select v-model="toolDraft.routeProfile" style="width:100%"><el-option v-for="route in state?.tools.routeProfiles" :key="route" :value="route" /></el-select></el-form-item><el-form-item label="范围"><el-select style="width:100%" @change="selectToolScope(JSON.parse($event))"><el-option v-for="scope in [...(state?.tools.defaultScopes||[]),...(state?.tools.scopes||[])]" :key="`${scope.scopeKind}:${scope.scopeId}`" :label="scope.title || scope.roomName" :value="JSON.stringify(scope)" /></el-select></el-form-item><el-form-item label="启用"><el-switch v-model="toolDraft.enabled" /></el-form-item></el-form><template #footer><el-button @click="addToolOpen=false">取消</el-button><el-button type="primary" :disabled="!toolDraft.toolName" @click="addTool">添加</el-button></template></el-dialog>
</template>

<style scoped>.policy-panel{overflow:hidden}.policy-tabs{padding:0 20px}.policy-tabs :deep(.el-tabs__header){margin:0}.subhead{border-top:0}.policy-panel :deep(.el-table__cell){font-size:11px}</style>
