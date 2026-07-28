<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <div class="empty-state">
    <span class="empty-mark">◇</span>
    <strong>{{ title }}</strong>
  </div>
</template>
