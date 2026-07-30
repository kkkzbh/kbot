<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import PendingChangesBar from '@/components/PendingChangesBar.vue';
import { rawApi, rawJsonBody } from '@/api/client';
import { useRuntimeStore } from '@/stores/runtime';
import type { SettingsField } from '@contracts';

type SettingsMode = 'campus-auth' | 'hbu-jw' | 'zyh' | 'second-class' | 'chaoxing' | 'genshin';

const props = defineProps<{ mode: SettingsMode }>();
const fields = ref<SettingsField[]>([]);
const draft = reactive<Record<string, string>>({});
const original = reactive<Record<string, string>>({});
const clearSecrets = reactive<Record<string, boolean>>({});
const loading = ref(false);
const saving = ref(false);
const runtime = useRuntimeStore();

const modePrefixes: Record<SettingsMode, string[]> = {
  'campus-auth': ['CAMPUS_AUTH_'],
  'hbu-jw': ['HBU_JW_'],
  zyh: ['ZYH_'],
  'second-class': ['HBU_SECOND_CLASS_'],
  chaoxing: ['CHAOXING_'],
  genshin: ['GENSHIN_'],
};
const visibleFields = computed(() => fields.value.filter((field) => {
  const prefixes = modePrefixes[props.mode];
  return prefixes.some((prefix) => field.key.startsWith(prefix));
}));
const grouped = computed(() => {
  const result = new Map<string, SettingsField[]>();
  for (const field of visibleFields.value) {
    const group = groupName(field.key);
    result.set(group, [...(result.get(group) ?? []), field]);
  }
  return [...result.entries()];
});
const pendingChanges = computed(() => collectChanges());
const hasUnsavedChanges = computed(() => pendingChanges.value.length > 0);

function groupName(key: string) {
  if (key.startsWith('HBU_JW_')) return '河北大学教务';
  if (key.startsWith('HBU_SECOND_')) return '第二课堂';
  if (key.startsWith('CAMPUS_')) return '校园认证';
  if (key.startsWith('ZYH_')) return '志愿汇';
  if (key.startsWith('CHAOXING_')) return '学习通';
  if (key.startsWith('GENSHIN_')) return '原神服务';
  throw new Error(`扩展设置字段没有所属分组：${key}`);
}

async function load() {
  loading.value = true;
  try {
    const result = await rawApi<any>('/settings/features');
    fields.value = result.fields;
    for (const field of result.fields) {
      draft[field.key] = field.value ?? '';
      original[field.key] = field.value ?? '';
      clearSecrets[field.key] = false;
    }
    runtime.updateApply(result);
  } finally { loading.value = false; }
}

function collectChanges(): any[] {
  const changes: any[] = [];
  for (const field of visibleFields.value) {
    if (field.type === 'secret') {
      if (clearSecrets[field.key]) changes.push({ key: field.key, clear: true });
      else if (draft[field.key]) changes.push({ key: field.key, value: draft[field.key] });
    } else if (draft[field.key] !== original[field.key]) {
      changes.push({ key: field.key, value: draft[field.key] });
    }
  }
  return changes;
}

async function discardChanges() {
  if (!hasUnsavedChanges.value) return;
  try {
    await ElMessageBox.confirm(
      '将丢弃当前页面尚未保存的配置修改。',
      '放弃未保存修改？',
      { type: 'warning', confirmButtonText: '放弃修改', cancelButtonText: '继续编辑' },
    );
  } catch {
    return;
  }
  await load();
}

async function save() {
  if (!hasUnsavedChanges.value || runtime.restartInProgress) return;
  saving.value = true;
  try {
    const changes = pendingChanges.value;
    const result = await rawApi<any>('/settings/features', { method: 'PATCH', body: rawJsonBody({ changes }) });
    runtime.updateApply(result);
    await load();
    ElMessage.success('配置已保存，可从右上角重启使其生效。');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '配置保存失败'); }
  finally { saving.value = false; }
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
      '当前页面仍有未保存修改。',
      '离开当前页面？',
      { type: 'warning', confirmButtonText: '放弃并离开', cancelButtonText: '继续编辑' },
    );
    return true;
  } catch {
    return false;
  }
});

function handleSave() { void save(); }
watch(() => props.mode, load);
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
  <el-skeleton v-if="loading && !fields.length" :rows="9" animated />
  <template v-else>
    <section v-for="[group,items] in grouped" :key="group" class="form-section">
      <el-form label-position="top" class="settings-grid">
        <el-form-item v-for="field in items" :key="field.key" :label="field.label">
          <el-switch v-if="field.type === 'toggle'" v-model="draft[field.key]" active-value="true" inactive-value="false" />
          <el-input-number v-else-if="field.type === 'number'" :model-value="Number(draft[field.key] || 0)" :controls="false" style="width:100%" @update:model-value="draft[field.key]=String($event ?? '')" />
          <template v-else-if="field.type === 'secret'">
            <el-input v-model="draft[field.key]" type="password" show-password :disabled="clearSecrets[field.key]" :placeholder="field.configured ? '已配置，留空保持原值' : '输入新的 Secret'" />
            <el-checkbox v-if="field.configured" v-model="clearSecrets[field.key]">显式清空已配置的 Secret</el-checkbox>
          </template>
          <el-input v-else v-model="draft[field.key]" />
        </el-form-item>
      </el-form>
    </section>
    <PendingChangesBar
      v-if="hasUnsavedChanges"
      :saving="saving"
      :disabled="runtime.restartInProgress"
      @discard="discardChanges"
      @save="save"
    />
  </template>
</template>

<style scoped>
.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:24px}.settings-grid :deep(.el-form-item){align-content:start}@media(max-width:760px){.settings-grid{grid-template-columns:1fr}}
</style>
