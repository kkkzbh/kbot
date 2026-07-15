<script setup lang="ts">
import RuntimeLogPanel from '@/components/RuntimeLogPanel.vue';
</script>

<template>
  <div class="logs-page">
    <RuntimeLogPanel />
  </div>
</template>

<style scoped>
.logs-page {
  height: 100%;
  min-height: 0;
}
</style>
