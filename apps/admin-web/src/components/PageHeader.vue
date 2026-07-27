<script setup lang="ts">
import { useRoute } from 'vue-router';

defineProps<{
  saving?: boolean;
  saveLabel?: string;
  hideSave?: boolean;
  saveDisabled?: boolean;
}>();
defineEmits<{ save: [] }>();
const route = useRoute();
</script>

<template>
  <header class="page-header">
    <div>
      <h1>{{ route.meta.title }}</h1>
    </div>
    <div class="page-actions">
      <slot name="actions" />
      <el-button
        v-if="!hideSave"
        type="primary"
        :loading="saving"
        :disabled="saveDisabled"
        @click="$emit('save')"
      >
        {{ saveLabel || '保存当前页面' }}
      </el-button>
    </div>
  </header>
</template>
