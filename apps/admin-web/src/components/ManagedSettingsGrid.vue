<script setup lang="ts">
import type { SettingsField } from '@contracts';

const props = defineProps<{
  fields: SettingsField[];
  modelValue: Record<string, string>;
  clearSecrets: Record<string, boolean>;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: Record<string, string>];
  'update:clearSecrets': [value: Record<string, boolean>];
}>();

function updateValue(key: string, value: string): void {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

function updateClearSecret(key: string, value: boolean): void {
  emit('update:clearSecrets', { ...props.clearSecrets, [key]: value });
}
</script>

<template>
  <el-form label-position="top" class="managed-settings-grid">
    <el-form-item v-for="field in fields" :key="field.key" :label="field.label">
      <el-switch
        v-if="field.type === 'toggle'"
        :model-value="modelValue[field.key]"
        active-value="true"
        inactive-value="false"
        @update:model-value="updateValue(field.key, String($event))"
      />
      <el-input-number
        v-else-if="field.type === 'number'"
        :model-value="Number(modelValue[field.key] || 0)"
        :controls="false"
        style="width: 100%"
        @update:model-value="updateValue(field.key, String($event ?? ''))"
      />
      <template v-else-if="field.type === 'secret'">
        <el-input
          :model-value="modelValue[field.key]"
          type="password"
          show-password
          :disabled="clearSecrets[field.key]"
          :placeholder="field.configured ? '已配置，留空保持原值' : '输入新的 Secret'"
          @update:model-value="updateValue(field.key, String($event))"
        />
        <el-checkbox
          v-if="field.configured"
          :model-value="clearSecrets[field.key]"
          @update:model-value="updateClearSecret(field.key, Boolean($event))"
        >
          显式清空已配置的 Secret
        </el-checkbox>
      </template>
      <el-input
        v-else
        :model-value="modelValue[field.key]"
        @update:model-value="updateValue(field.key, String($event))"
      />
    </el-form-item>
  </el-form>
</template>

<style scoped>
.managed-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:24px}
.managed-settings-grid :deep(.el-form-item){align-content:start}
@media(max-width:760px){.managed-settings-grid{grid-template-columns:1fr}}
</style>
