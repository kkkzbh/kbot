<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { generalFeatureSettingKeys } from '@contracts';
import PendingChangesBar from '@/components/PendingChangesBar.vue';
import { useRuntimeStore } from '@/stores/runtime';
import { useManagedFeatureSettings } from './managed-settings';

const runtime = useRuntimeStore();
const saving = ref(false);
const {
  draft,
  loading,
  hasChanges,
  load,
  reset,
  save,
} = useManagedFeatureSettings(generalFeatureSettingKeys);

const antiRecallEnabled = computed({
  get: () => draft.value.QQBOT_ANTI_RECALL_ENABLED === 'true',
  set: (value: boolean) => {
    draft.value = {
      ...draft.value,
      QQBOT_ANTI_RECALL_ENABLED: String(value),
    };
  },
});

const antiRecallAllowedGroups = computed({
  get: () => draft.value.QQBOT_ANTI_RECALL_ALLOWED_GROUPS ?? '',
  set: (value: string) => {
    draft.value = {
      ...draft.value,
      QQBOT_ANTI_RECALL_ALLOWED_GROUPS: value,
    };
  },
});

async function saveChanges(): Promise<void> {
  if (!hasChanges.value || runtime.restartInProgress) return;
  saving.value = true;
  try {
    await save();
    ElMessage.success('通用配置已保存，可从右上角重启使其生效。');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '通用配置保存失败');
  } finally {
    saving.value = false;
  }
}

async function discardChanges(): Promise<void> {
  if (!hasChanges.value) return;
  try {
    await ElMessageBox.confirm(
      '将丢弃当前页面尚未保存的配置修改。',
      '放弃未保存修改？',
      { type: 'warning', confirmButtonText: '放弃修改', cancelButtonText: '继续编辑' },
    );
    reset();
  } catch {
    // User kept editing.
  }
}

function beforeUnload(event: BeforeUnloadEvent): void {
  if (!hasChanges.value) return;
  event.preventDefault();
  event.returnValue = '';
}

onBeforeRouteLeave(async () => {
  if (!hasChanges.value) return true;
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

function handleSave(): void {
  void saveChanges();
}

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
  <el-skeleton v-if="loading" :rows="5" animated />
  <section v-else class="form-section general-section">
    <div class="setting-row">
      <div>
        <h2 class="section-title">防撤回</h2>
        <p class="section-copy">白名单群内的消息被撤回时，立即公开发送原消息。</p>
      </div>
      <el-switch v-model="antiRecallEnabled" aria-label="防撤回" />
    </div>
    <div class="scope-setting">
      <label class="field-label" for="anti-recall-groups">生效群</label>
      <p class="field-copy">填写允许启用防撤回的 QQ 群号，留空时不在任何群生效。</p>
      <el-input
        id="anti-recall-groups"
        v-model="antiRecallAllowedGroups"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 4 }"
        placeholder="每行一个群号，也可使用逗号分隔"
        aria-label="防撤回生效群"
      />
    </div>
    <div class="message-preview" aria-label="防撤回消息格式预览">
      <span class="preview-avatar">头像</span>
      <span>[QQ号]撤回了一条消息: {撤回的消息}</span>
    </div>
  </section>
  <PendingChangesBar
    v-if="hasChanges"
    :saving="saving"
    :disabled="runtime.restartInProgress"
    @discard="discardChanges"
    @save="saveChanges"
  />
</template>

<style scoped>
.general-section{display:grid;gap:22px}.setting-row{display:flex;align-items:center;justify-content:space-between;gap:24px}.section-title{margin:0}.section-copy,.field-copy{margin:6px 0 0;color:var(--muted);font-size:12px}.scope-setting{display:grid;gap:10px;padding-top:18px;border-top:1px solid var(--line)}.field-label{font-size:13px;font-weight:600;color:#202735}.field-copy{margin-top:-4px}.scope-setting :deep(.el-textarea__inner){min-height:58px;padding:10px 12px;line-height:1.6;resize:none}.message-preview{display:flex;align-items:center;gap:10px;padding-top:18px;border-top:1px solid var(--line);color:#3b4350;font-size:13px}.preview-avatar{display:grid;width:34px;height:34px;place-items:center;border-radius:50%;background:#e8edf5;color:#727d8d;font-size:9px;flex:0 0 auto}@media(max-width:560px){.setting-row{align-items:flex-start}.message-preview{align-items:flex-start}}
</style>
