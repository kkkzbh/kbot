<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import PageHeader from '@/components/PageHeader.vue';
import { rawApi, rawJsonBody } from '@/api/client';
import { useRuntimeStore } from '@/stores/runtime';
import type { SettingsField, SettingsSection } from '@contracts';

type SettingsMode = 'all' | 'system' | 'campus-auth' | 'hbu-jw' | 'zyh' | 'second-class' | 'chaoxing' | 'genshin';

const props = defineProps<{ section: SettingsSection; mode: SettingsMode }>();
const fields = ref<SettingsField[]>([]);
const draft = reactive<Record<string, string>>({});
const original = reactive<Record<string, string>>({});
const clearSecrets = reactive<Record<string, boolean>>({});
const loading = ref(false);
const saving = ref(false);
const runtime = useRuntimeStore();

const extensionPrefixes = ['HBU_', 'CAMPUS_', 'ZYH_', 'CHAOXING_', 'GENSHIN_'];
const modePrefixes: Partial<Record<SettingsMode, string[]>> = {
  'campus-auth': ['CAMPUS_AUTH_'],
  'hbu-jw': ['HBU_JW_'],
  zyh: ['ZYH_'],
  'second-class': ['HBU_SECOND_CLASS_'],
  chaoxing: ['CHAOXING_'],
  genshin: ['GENSHIN_'],
};
const visibleFields = computed(() => fields.value.filter((field) => {
  const prefixes = modePrefixes[props.mode];
  if (prefixes) return prefixes.some((prefix) => field.key.startsWith(prefix));
  const extension = extensionPrefixes.some((prefix) => field.key.startsWith(prefix));
  if (props.mode === 'system') return !extension && !field.key.startsWith('QQ_VOICE_TTS_');
  return true;
}));
const grouped = computed(() => {
  const result = new Map<string, SettingsField[]>();
  for (const field of visibleFields.value) {
    const group = groupName(field.key);
    result.set(group, [...(result.get(group) ?? []), field]);
  }
  return [...result.entries()];
});

function groupName(key: string) {
  if (key.startsWith('HBU_JW_')) return '河北大学教务';
  if (key.startsWith('HBU_SECOND_')) return '第二课堂';
  if (key.startsWith('CAMPUS_')) return '校园认证';
  if (key.startsWith('ZYH_')) return '志愿汇';
  if (key.startsWith('CHAOXING_')) return '学习通';
  if (key.startsWith('GENSHIN_')) return '原神服务';
  if (key.startsWith('MEMORY_')) return '长期记忆';
  if (key.startsWith('QQ_VOICE_')) return '语音交互';
  if (key.startsWith('CHAT_NATURAL_')) return '自然触发';
  if (key.startsWith('CHATLUNA_COMMON_FS')) return '文件系统工具';
  if (key.startsWith('QQBOT_')) return '运行体验';
  return '基础参数';
}

async function load() {
  loading.value = true;
  try {
    const result = await rawApi<any>(`/settings/${props.section}`);
    fields.value = result.fields;
    for (const field of result.fields) {
      draft[field.key] = field.value ?? '';
      original[field.key] = field.value ?? '';
      clearSecrets[field.key] = false;
    }
    runtime.updateApply(result);
  } finally { loading.value = false; }
}

async function save() {
  const changes: any[] = [];
  for (const field of visibleFields.value) {
    if (field.type === 'secret') {
      if (clearSecrets[field.key]) changes.push({ key: field.key, clear: true });
      else if (draft[field.key]) changes.push({ key: field.key, value: draft[field.key] });
    } else if (draft[field.key] !== original[field.key]) {
      changes.push({ key: field.key, value: draft[field.key] });
    }
  }
  if (!changes.length) { ElMessage.info('当前页面没有变更'); return; }
  saving.value = true;
  try {
    const result = await rawApi<any>(`/settings/${props.section}`, { method: 'PATCH', body: rawJsonBody({ changes }) });
    runtime.updateApply(result);
    ElMessage.success('配置已原子写入，重启后生效');
    await load();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '配置保存失败'); }
  finally { saving.value = false; }
}

function handleSave() { save(); }
watch(() => [props.section, props.mode], load);
onMounted(() => { load(); window.addEventListener('admin-save', handleSave); });
onBeforeUnmount(() => window.removeEventListener('admin-save', handleSave));
</script>

<template>
  <PageHeader :saving="saving" @save="save"><template #actions><el-button :loading="loading" @click="load">放弃变更</el-button></template></PageHeader>
  <el-skeleton v-if="loading && !fields.length" :rows="9" animated />
  <template v-else>
    <section v-for="[group,items] in grouped" :key="group" class="form-section">
      <h2 class="section-title">{{ group }}</h2>
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
  </template>
</template>

<style scoped>
.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:24px}.settings-grid :deep(.el-form-item){align-content:start}@media(max-width:760px){.settings-grid{grid-template-columns:1fr}}
</style>
