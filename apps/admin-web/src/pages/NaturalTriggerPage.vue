<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { naturalTriggerFeatureSettingKeys } from '@contracts';
import PageHeader from '@/components/PageHeader.vue';
import ManagedSettingsGrid from '@/components/ManagedSettingsGrid.vue';
import { useManagedFeatureSettings } from './managed-settings';

const saving = ref(false);
const {
  fields,
  draft,
  clearSecrets,
  loading,
  load,
  save: saveSettings,
} = useManagedFeatureSettings(naturalTriggerFeatureSettingKeys);

async function save(): Promise<void> {
  saving.value = true;
  try {
    const changed = await saveSettings();
    if (!changed) {
      ElMessage.info('当前页面没有变更');
      return;
    }
    ElMessage.success('自然触发配置已保存，重启后生效');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '自然触发配置保存失败');
  } finally {
    saving.value = false;
  }
}

function handleSave(): void {
  void save();
}

onMounted(() => {
  void load();
  window.addEventListener('admin-save', handleSave);
});
onBeforeUnmount(() => window.removeEventListener('admin-save', handleSave));
</script>

<template>
  <PageHeader :saving="saving" @save="save">
    <template #actions>
      <el-button :loading="loading" @click="load">放弃变更</el-button>
    </template>
  </PageHeader>
  <el-skeleton v-if="loading && !fields.length" :rows="5" animated />
  <section v-else class="form-section">
    <h2 class="section-title">群聊触发</h2>
    <p class="field-help">控制群聊自然触发、允许触发的群聊范围和机器人触发别名。</p>
    <ManagedSettingsGrid
      v-model="draft"
      v-model:clear-secrets="clearSecrets"
      :fields="fields"
    />
  </section>
</template>
