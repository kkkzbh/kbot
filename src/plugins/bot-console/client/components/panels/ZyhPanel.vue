<script setup lang="ts">
import { ZYH_ENV_KEYS } from '../../composables/useBotConsole'
import CampusModulePanel from './CampusModulePanel.vue'
</script>

<template>
  <CampusModulePanel
    title="志愿汇"
    description="管理志愿汇绑定、活动查询、签到定位入口和群白名单。"
    :env-keys="ZYH_ENV_KEYS"
    group-key="ZYH_ALLOWED_GROUPS"
    natural-trigger-key="ZYH_NATURAL_TRIGGER_ENABLED"
  />
</template>
