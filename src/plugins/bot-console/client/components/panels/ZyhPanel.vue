<script setup lang="ts">
import { ZYH_ENV_KEYS } from '../../composables/useBotConsole'
import CampusModulePanel from './CampusModulePanel.vue'
</script>

<template>
  <CampusModulePanel
    title="志愿汇"
    description="管理志愿汇绑定、志愿时长与活动查询、群白名单和统一认证入口。"
    :env-keys="ZYH_ENV_KEYS"
    group-key="ZYH_ALLOWED_GROUPS"
    natural-trigger-key="ZYH_NATURAL_TRIGGER_ENABLED"
  />
</template>
