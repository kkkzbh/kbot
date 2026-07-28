<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
} from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  naturalTriggerAdminResponseSchema,
  naturalTriggerConfigPutSchema,
  type NaturalTriggerAdminResponse,
} from '@contracts';
import PageHeader from '@/components/PageHeader.vue';
import { ApiError, api, jsonBody } from '@/api/client';
import { useRuntimeStore } from '@/stores/runtime';

type NaturalTriggerConfig = NaturalTriggerAdminResponse['config'];

const router = useRouter();
const runtime = useRuntimeStore();
const saved = ref<NaturalTriggerAdminResponse | null>(null);
const draft = ref<NaturalTriggerConfig | null>(null);
const loading = ref(false);
const saving = ref(false);

const hasUnsavedChanges = computed(() => Boolean(
  saved.value
  && draft.value
  && JSON.stringify(saved.value.config) !== JSON.stringify(draft.value),
));
const selectedGroupOptions = computed(() => {
  const options = new Map(
    (saved.value?.groupOptions ?? []).map((option) => [option.groupId, option]),
  );
  for (const groupId of draft.value?.allowedGroupIds ?? []) {
    if (!options.has(groupId)) options.set(groupId, { groupId, roomName: groupId });
  }
  return [...options.values()];
});
const decisionStatus = computed(() => {
  const binding = saved.value?.decisionBinding;
  if (!binding || binding.mode === 'disabled') return { label: '已禁用', type: 'info' as const };
  if (!binding.compatible) return { label: '不兼容', type: 'danger' as const };
  if (!binding.available) return { label: '不可用', type: 'danger' as const };
  return { label: '可用', type: 'success' as const };
});

function millisecondsToSeconds(value: number): number {
  return value / 1_000;
}

function secondsToMilliseconds(value: number | undefined): number {
  return Math.round(Number(value ?? 0) * 1_000);
}

function millisecondsToMinutes(value: number): number {
  return value / 60_000;
}

function minutesToMilliseconds(value: number | undefined): number {
  return Math.round(Number(value ?? 0) * 60_000);
}

function toPercent(value: number): number {
  return value * 100;
}

function fromPercent(value: number | undefined): number {
  return Number(value ?? 0) / 100;
}

function groupOptionLabel(option: { groupId: string; roomName: string }): string {
  return option.roomName === option.groupId
    ? option.groupId
    : `${option.roomName} · ${option.groupId}`;
}

function hydrate(value: NaturalTriggerAdminResponse): void {
  saved.value = value;
  draft.value = structuredClone(value.config);
  runtime.updateApply({
    restartRequired: value.restartRequired,
    reasons: value.reasons,
  });
}

async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    hydrate(await api('/natural-trigger', naturalTriggerAdminResponseSchema));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '自然触发配置加载失败');
  } finally {
    loading.value = false;
  }
}

async function discardChanges(): Promise<void> {
  if (!hasUnsavedChanges.value) {
    await load();
    return;
  }
  try {
    await ElMessageBox.confirm(
      '当前自然触发草稿尚未保存。',
      '放弃变更？',
      {
        type: 'warning',
        confirmButtonText: '放弃并重新加载',
        cancelButtonText: '继续编辑',
      },
    );
    await load();
  } catch {
    // The draft remains authoritative until the user confirms.
  }
}

async function save(): Promise<void> {
  if (!saved.value || !draft.value || !hasUnsavedChanges.value) return;
  saving.value = true;
  try {
    const result = await api('/natural-trigger', naturalTriggerAdminResponseSchema, {
      method: 'PUT',
      body: jsonBody(naturalTriggerConfigPutSchema, {
        expectedRevision: saved.value.savedRevision,
        config: draft.value,
      }),
    });
    hydrate(result);
    ElMessage.success('自然触发配置已保存，重启后生效');
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      try {
        await ElMessageBox.confirm(
          '服务端 revision 已更新，重新加载会放弃当前草稿。',
          '配置冲突',
          {
            type: 'warning',
            confirmButtonText: '重新加载',
            cancelButtonText: '保留草稿',
          },
        );
        await load();
      } catch {
        // Keep the local draft for manual recovery.
      }
      return;
    }
    ElMessage.error(error instanceof Error ? error.message : '自然触发配置保存失败');
  } finally {
    saving.value = false;
  }
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
      '当前自然触发草稿尚未保存，离开页面会丢失修改。',
      '离开自然触发？',
      {
        type: 'warning',
        confirmButtonText: '放弃并离开',
        cancelButtonText: '继续编辑',
      },
    );
    return true;
  } catch {
    return false;
  }
});

function handleSave(): void {
  void save();
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
  <PageHeader
    :saving="saving"
    :save-disabled="!hasUnsavedChanges || !draft"
    save-label="保存自然触发"
    @save="save"
  >
    <template #actions>
      <el-button :loading="loading" @click="discardChanges">
        {{ hasUnsavedChanges ? '放弃变更' : '刷新状态' }}
      </el-button>
    </template>
  </PageHeader>

  <el-skeleton v-if="loading && !draft" :rows="10" animated />

  <template v-else-if="draft && saved">
    <section v-if="hasUnsavedChanges || saved.pending" class="trigger-status">
      <el-tag v-if="hasUnsavedChanges" type="warning">有未保存修改</el-tag>
      <el-tag v-else type="warning">等待重启</el-tag>
    </section>

    <section class="form-section">
      <h2 class="section-title">启用范围</h2>
      <el-form label-position="top" class="settings-grid">
        <el-form-item label="自然触发">
          <el-switch v-model="draft.enabled" />
        </el-form-item>
        <el-form-item label="允许群">
          <el-select
            v-model="draft.allowedGroupIds"
            multiple
            filterable
            allow-create
            default-first-option
            :disabled="!draft.enabled"
            placeholder="选择或输入群 ID"
          >
            <el-option
              v-for="option in selectedGroupOptions"
              :key="option.groupId"
              :value="option.groupId"
              :label="groupOptionLabel(option)"
            />
          </el-select>
        </el-form-item>
      </el-form>
    </section>

    <section class="form-section">
      <h2 class="section-title">识别机制</h2>
      <div class="mechanism-grid">
        <article class="mechanism-item">
          <div class="mechanism-head">
            <strong>引用</strong>
            <el-switch v-model="draft.mechanisms.quote.enabled" :disabled="!draft.enabled" />
          </div>
        </article>

        <article class="mechanism-item mechanism-wide">
          <div class="mechanism-head">
            <strong>别名</strong>
            <el-switch v-model="draft.mechanisms.alias.enabled" :disabled="!draft.enabled" />
          </div>
          <el-select
            v-model="draft.mechanisms.alias.aliases"
            multiple
            filterable
            allow-create
            default-first-option
            :disabled="!draft.enabled || !draft.mechanisms.alias.enabled"
            placeholder="输入别名后回车"
          />
        </article>

        <article class="mechanism-item">
          <div class="mechanism-head">
            <strong>语言规则</strong>
            <el-switch v-model="draft.mechanisms.heuristic.enabled" :disabled="!draft.enabled" />
          </div>
        </article>

        <article class="mechanism-item">
          <div class="mechanism-head">
            <strong>会话焦点</strong>
            <el-switch v-model="draft.mechanisms.focus.enabled" :disabled="!draft.enabled" />
          </div>
          <el-form label-position="top">
            <el-form-item label="窗口（秒）">
              <el-input-number
                :model-value="millisecondsToSeconds(draft.mechanisms.focus.windowMs)"
                :min="0"
                :max="86400"
                :controls="false"
                :disabled="!draft.enabled || !draft.mechanisms.focus.enabled"
                @update:model-value="draft.mechanisms.focus.windowMs = secondsToMilliseconds($event)"
              />
            </el-form-item>
          </el-form>
        </article>

        <article class="mechanism-item">
          <div class="mechanism-head">
            <strong>模型判断</strong>
            <el-tag :type="decisionStatus.type">{{ decisionStatus.label }}</el-tag>
          </div>
          <el-form label-position="top">
            <el-form-item label="最低置信度（%）">
              <el-input-number
                :model-value="toPercent(draft.modelDecision.minConfidence)"
                :min="0"
                :max="100"
                :precision="0"
                :controls="false"
                :disabled="!draft.enabled || saved.decisionBinding.mode === 'disabled'"
                @update:model-value="draft.modelDecision.minConfidence = fromPercent($event)"
              />
            </el-form-item>
          </el-form>
          <el-button
            text
            type="primary"
            @click="router.push('/intelligence/models?workload=naturalTrigger.decision')"
          >
            {{ saved.decisionBinding.displayName || '配置判断模型' }}
          </el-button>
        </article>

        <article class="mechanism-item">
          <div class="mechanism-head">
            <strong>随机触发</strong>
            <el-switch v-model="draft.mechanisms.random.enabled" :disabled="!draft.enabled" />
          </div>
          <el-form label-position="top">
            <el-form-item label="概率（%）">
              <el-input-number
                :model-value="toPercent(draft.mechanisms.random.probability)"
                :min="0"
                :max="100"
                :precision="1"
                :controls="false"
                :disabled="!draft.enabled || !draft.mechanisms.random.enabled"
                @update:model-value="draft.mechanisms.random.probability = fromPercent($event)"
              />
            </el-form-item>
          </el-form>
        </article>
      </div>
    </section>

    <section class="form-section">
      <h2 class="section-title">输入通道</h2>
      <el-form label-position="top" class="settings-grid">
        <el-form-item label="未点名群语音准入">
          <el-switch
            v-model="draft.voiceAdmission.enabled"
            :disabled="!draft.enabled"
          />
        </el-form-item>
        <el-form-item label="语音输入服务">
          <el-tag :type="saved.voiceInputEnabled ? 'success' : 'info'">
            {{ saved.voiceInputEnabled ? '已开启' : '已关闭' }}
          </el-tag>
        </el-form-item>
      </el-form>
    </section>

    <section class="form-section">
      <h2 class="section-title">节流与保护</h2>
      <el-form label-position="top" class="settings-grid">
        <el-form-item label="最小回复间隔（秒）">
          <el-input-number
            :model-value="millisecondsToSeconds(draft.pacing.minReplyIntervalMs)"
            :min="0"
            :max="3600"
            :controls="false"
            :disabled="!draft.enabled"
            @update:model-value="draft.pacing.minReplyIntervalMs = secondsToMilliseconds($event)"
          />
        </el-form-item>
        <el-form-item label="防刷屏">
          <el-switch v-model="draft.antiSpam.enabled" :disabled="!draft.enabled" />
        </el-form-item>
        <el-form-item label="统计窗口（秒）">
          <el-input-number
            :model-value="millisecondsToSeconds(draft.antiSpam.windowMs)"
            :min="0.001"
            :max="3600"
            :controls="false"
            :disabled="!draft.enabled || !draft.antiSpam.enabled"
            @update:model-value="draft.antiSpam.windowMs = secondsToMilliseconds($event)"
          />
        </el-form-item>
        <el-form-item label="消息阈值">
          <el-input-number
            v-model="draft.antiSpam.threshold"
            :min="1"
            :max="10000"
            :precision="0"
            :controls="false"
            :disabled="!draft.enabled || !draft.antiSpam.enabled"
          />
        </el-form-item>
        <el-form-item label="忽略时长（分钟）">
          <el-input-number
            :model-value="millisecondsToMinutes(draft.antiSpam.muteMs)"
            :min="0"
            :max="1440"
            :controls="false"
            :disabled="!draft.enabled || !draft.antiSpam.enabled"
            @update:model-value="draft.antiSpam.muteMs = minutesToMilliseconds($event)"
          />
        </el-form-item>
      </el-form>
    </section>
  </template>
</template>

<style scoped>
.trigger-status {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  margin-bottom: 16px;
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 24px;
}

.settings-grid :deep(.el-select),
.settings-grid :deep(.el-input-number),
.mechanism-item :deep(.el-select),
.mechanism-item :deep(.el-input-number) {
  width: 100%;
}

.mechanism-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.mechanism-item {
  display: flex;
  min-height: 104px;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
}

.mechanism-wide {
  grid-column: span 2;
}

.mechanism-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.mechanism-item :deep(.el-form-item) {
  margin-bottom: 0;
}

.mechanism-item > .el-button {
  align-self: flex-start;
  margin-top: auto;
  padding-left: 0;
}

@media (max-width: 900px) {
  .mechanism-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 680px) {
  .settings-grid,
  .mechanism-grid {
    grid-template-columns: 1fr;
  }

  .mechanism-wide {
    grid-column: auto;
  }
}
</style>
