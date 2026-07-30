<script setup lang="ts">
withDefaults(defineProps<{
  saving?: boolean;
  disabled?: boolean;
  message?: string;
  saveLabel?: string;
  discardLabel?: string;
}>(), {
  saving: false,
  disabled: false,
  message: '有未保存修改',
  saveLabel: '保存配置',
  discardLabel: '放弃修改',
});

defineEmits<{
  save: [];
  discard: [];
}>();
</script>

<template>
  <div class="pending-changes-spacer" aria-hidden="true" />
  <Transition name="pending-changes" appear>
    <aside class="pending-changes-bar" aria-label="未保存修改" aria-live="polite">
      <div class="pending-changes-state">
        <span aria-hidden="true" />
        <strong>{{ message }}</strong>
      </div>
      <div class="pending-changes-actions">
        <el-button :disabled="saving || disabled" @click="$emit('discard')">
          {{ discardLabel }}
        </el-button>
        <el-button
          type="primary"
          :loading="saving"
          :disabled="disabled"
          @click="$emit('save')"
        >
          {{ saveLabel }}
        </el-button>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.pending-changes-spacer {
  height: 76px;
}

.pending-changes-bar {
  position: fixed;
  left: calc(232px + (100vw - 232px) / 2);
  bottom: 24px;
  z-index: 19;
  width: min(620px, calc(100vw - 296px));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 10px 12px 10px 16px;
  border: 1px solid #cad6ee;
  border-radius: 12px;
  background: rgba(255, 255, 255, .96);
  box-shadow: 0 14px 38px rgba(39, 55, 89, .17);
  backdrop-filter: blur(14px);
  transform: translateX(-50%);
}

.pending-changes-state,
.pending-changes-actions {
  display: flex;
  align-items: center;
}

.pending-changes-state {
  gap: 9px;
  color: #39455a;
  font-size: 12px;
}

.pending-changes-state > span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warning);
  box-shadow: 0 0 0 4px rgba(217, 144, 38, .14);
}

.pending-changes-actions {
  gap: 8px;
}

.pending-changes-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.pending-changes-enter-active,
.pending-changes-leave-active {
  transition: opacity .18s ease, transform .18s ease;
}

.pending-changes-enter-from,
.pending-changes-leave-to {
  opacity: 0;
  transform: translate(-50%, 12px) scale(.98);
}

@media (prefers-reduced-motion: reduce) {
  .pending-changes-enter-active,
  .pending-changes-leave-active {
    transition: none;
  }
}

@media (max-width: 760px) {
  .pending-changes-bar {
    left: 50%;
    bottom: 14px;
    width: calc(100vw - 28px);
  }

  .pending-changes-state strong {
    display: none;
  }
}
</style>
