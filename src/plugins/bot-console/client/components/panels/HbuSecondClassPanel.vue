<script setup lang="ts">
import { HBU_SECOND_CLASS_ENV_KEYS } from '../../composables/useBotConsole'
import CampusModulePanel from './CampusModulePanel.vue'
</script>

<template>
  <CampusModulePanel
    title="河北大学二课"
    description="管理二课账号、学分与成绩单查询、群白名单和统一认证入口。"
    :env-keys="HBU_SECOND_CLASS_ENV_KEYS"
    group-key="HBU_SECOND_CLASS_ALLOWED_GROUPS"
    natural-trigger-key="HBU_SECOND_CLASS_NATURAL_TRIGGER_ENABLED"
  />
</template>
