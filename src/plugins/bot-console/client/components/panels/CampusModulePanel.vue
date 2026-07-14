<script setup lang="ts">
import { computed, inject } from 'vue'
import type { useBotConsole } from '../../composables/useBotConsole'
import { getFieldHint, getFieldLabel } from '../../utils/constants'
import { formatErrorMessage } from '../../utils/format'
import { useToast } from '../../composables/useToast'
import ToggleCard from '../ToggleCard.vue'

const props = defineProps<{
  title: string
  description: string
  envKeys: readonly string[]
  groupKey: string
  naturalTriggerKey: string
}>()

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()
const { envDraft, changedKeys, canSaveAllSettings } = bc

const changedCount = computed(() => props.envKeys.filter(key => changedKeys.value.has(key)).length)
const canSave = computed(() => changedCount.value > 0)
const toggleKeys = computed(() => props.envKeys.filter(key => key.endsWith('_ENABLED')))
const numberKeys = computed(() => props.envKeys.filter(key => key.endsWith('_TTL_MS') || key.endsWith('_ATTEMPTS')))
const textKeys = computed(() => props.envKeys.filter(key => !toggleKeys.value.includes(key) && !numberKeys.value.includes(key)))
const allowedGroups = computed(() => normalizeGroupList(envDraft[props.groupKey] ?? '') || '未配置群聊白名单')
const publicBaseUrl = computed(() => (envDraft.CAMPUS_AUTH_PUBLIC_BASE_URL ?? '').trim() || '跟随教务绑定地址')
const bindPath = computed(() => (envDraft.CAMPUS_AUTH_BIND_PAGE_PATH ?? '').trim() || '/campus/bind')

function normalizeGroupList(value: string): string {
  return value.split(/[,\s，、]+/).map(part => part.trim()).filter(Boolean).join(',')
}

function setEnv(key: string, value: string): void {
  envDraft[key] = value
}

function setBooleanEnv(key: string, value: boolean): void {
  envDraft[key] = String(value)
}

function placeholder(key: string): string {
  if (key.endsWith('_ALLOWED_GROUPS') || key.endsWith('_TRIGGER_GROUPS')) return '829573670,921554872'
  if (key === 'CAMPUS_AUTH_PUBLIC_BASE_URL') return 'https://jw.example.com'
  if (key === 'CAMPUS_AUTH_BIND_PAGE_PATH') return '/campus/bind'
  if (key === 'CAMPUS_AUTH_CREDENTIAL_KEK_PATH') return './.runtime/campus-auth/credential-kek.key'
  if (key === 'CAMPUS_AUTH_BIND_TOKEN_TTL_MS') return '600000'
  if (key === 'CAMPUS_AUTH_MAX_BINDING_ATTEMPTS') return '5'
  return ''
}

async function handleSave(restartAfter = false): Promise<void> {
  try {
    for (const key of props.envKeys.filter(key => key.endsWith('_GROUPS'))) {
      envDraft[key] = normalizeGroupList(envDraft[key] ?? '')
    }
    if (restartAfter) {
      await bc.saveAllSettingsAndRestart()
      toastAdd('全部配置已保存，正在重启机器人…', 'success')
      return
    }
    await bc.saveEnvPatch(props.envKeys)
    toastAdd(`${props.title}配置已保存`, 'success')
  } catch (error: unknown) {
    toastAdd(formatErrorMessage(error, `保存${props.title}配置失败`), 'error')
  }
}
</script>

<template>
  <section class="bc-panel">
    <div class="bc-panel-head">
      <div>
        <h2>{{ title }}</h2>
        <p class="bc-muted">{{ description }}</p>
      </div>
      <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
        <span v-if="changedCount" class="bc-badge bc-badge-primary">{{ changedCount }} 项已修改</span>
        <button class="bc-btn" type="button" :disabled="!canSave" @click="handleSave(false)">保存配置</button>
        <button class="bc-btn bc-btn-primary" type="button" :disabled="!canSaveAllSettings" @click="handleSave(true)">保存全部并重启</button>
      </div>
    </div>

    <div class="bc-status-grid">
      <div class="bc-status-card"><span class="bc-status-label">群聊白名单</span><strong>{{ allowedGroups }}</strong><p class="bc-muted">私聊始终可用。</p></div>
      <div class="bc-status-card"><span class="bc-status-label">自然触发</span><strong>{{ String(envDraft[naturalTriggerKey] ?? '').toLowerCase() === 'true' ? '已开启' : '已关闭' }}</strong><p class="bc-muted">群聊 at 触发不受此开关影响。</p></div>
      <div class="bc-status-card"><span class="bc-status-label">统一绑定入口</span><strong>{{ bindPath }}</strong><p class="bc-muted">{{ publicBaseUrl }}</p></div>
      <div class="bc-status-card"><span class="bc-status-label">认证存储</span><strong>KEK envelope encryption</strong><p class="bc-muted">Token、凭据和待确认状态均加密保存。</p></div>
    </div>

    <div v-if="toggleKeys.length" class="bc-toggle-grid" style="margin-top:1rem">
      <ToggleCard
        v-for="key in toggleKeys"
        :key="key"
        :label="getFieldLabel(key)"
        :model-value="String(envDraft[key] ?? '').toLowerCase() === 'true'"
        :is-dirty="changedKeys.has(key)"
        @update:model-value="value => setBooleanEnv(key, value)"
      />
    </div>

    <div class="bc-field-grid" style="margin-top:1rem">
      <label v-for="key in textKeys" :key="key" class="bc-field" :class="{ 'bc-field-span': key.endsWith('_GROUPS') }">
        <span class="bc-field-label">
          {{ getFieldLabel(key) }}
          <span v-if="getFieldHint(key)" class="bc-field-help" tabindex="0" role="note" :aria-label="getFieldHint(key)"><span aria-hidden="true">!</span><span class="bc-field-tooltip" role="tooltip">{{ getFieldHint(key) }}</span></span>
          <span v-if="changedKeys.has(key)" class="bc-field-modified">已修改</span>
        </span>
        <textarea v-if="key.endsWith('_GROUPS')" :value="envDraft[key] ?? ''" rows="2" spellcheck="false" :placeholder="placeholder(key)" @input="event => setEnv(key, (event.target as HTMLTextAreaElement).value)" />
        <input v-else type="text" :value="envDraft[key] ?? ''" spellcheck="false" :placeholder="placeholder(key)" @input="event => setEnv(key, (event.target as HTMLInputElement).value)" />
      </label>
    </div>

    <div class="bc-field-grid" style="margin-top:1rem">
      <label v-for="key in numberKeys" :key="key" class="bc-field">
        <span class="bc-field-label">{{ getFieldLabel(key) }}<span v-if="changedKeys.has(key)" class="bc-field-modified">已修改</span></span>
        <input type="number" min="1" step="1" :value="envDraft[key] ?? ''" :placeholder="placeholder(key)" @input="event => setEnv(key, (event.target as HTMLInputElement).value)" />
      </label>
    </div>
  </section>
</template>
