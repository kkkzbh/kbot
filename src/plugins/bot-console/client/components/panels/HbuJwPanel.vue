<script setup lang="ts">
import { computed, inject } from 'vue'
import { useToast } from '../../composables/useToast'
import {
  HBU_JW_ENV_KEYS,
  normalizeBoolean,
} from '../../composables/useBotConsole'
import { getFieldHint, getFieldLabel } from '../../utils/constants'
import { formatErrorMessage } from '../../utils/format'
import type { useBotConsole } from '../../composables/useBotConsole'
import ToggleCard from '../ToggleCard.vue'

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()

const {
  envDraft,
  changedHbuJwEnvKeys,
  canSaveHbuJwSettings,
} = bc

const textKeys = [
  'HBU_JW_ALLOWED_GROUPS',
  'HBU_JW_PUBLIC_BASE_URL',
  'HBU_JW_BIND_PAGE_PATH',
  'HBU_JW_CREDENTIAL_KEK_PATH',
] as const

const numberKeys = [
  'HBU_JW_BIND_TOKEN_TTL_MS',
  'HBU_JW_KEEP_ALIVE_INTERVAL_MS',
  'HBU_JW_KEEP_ALIVE_RECENT_USE_WINDOW_MS',
] as const

const hbuJwChangedCount = computed(() => HBU_JW_ENV_KEYS.filter(key => changedHbuJwEnvKeys.value.has(key)).length)
const allowedGroupsLabel = computed(() => {
  const value = (envDraft.HBU_JW_ALLOWED_GROUPS ?? '').trim()
  return value || '未配置群聊白名单'
})
const publicBaseUrlLabel = computed(() => (envDraft.HBU_JW_PUBLIC_BASE_URL ?? '').trim() || '跟随 Koishi 本地端口')
const bindPagePathLabel = computed(() => (envDraft.HBU_JW_BIND_PAGE_PATH ?? '').trim() || '/jw/bind')

function setEnv(key: string, value: string): void {
  envDraft[key] = value
}

function setBooleanEnv(key: string, value: boolean): void {
  envDraft[key] = String(value)
}

function isDirty(key: string): boolean {
  return changedHbuJwEnvKeys.value.has(key)
}

function inputType(key: string): string {
  return key === 'HBU_JW_CREDENTIAL_KEK_PATH' ? 'text' : 'text'
}

function placeholder(key: string): string {
  if (key === 'HBU_JW_ALLOWED_GROUPS') return '829573670,921554872'
  if (key === 'HBU_JW_PUBLIC_BASE_URL') return 'https://bot.example.com'
  if (key === 'HBU_JW_BIND_PAGE_PATH') return '/jw/bind'
  if (key === 'HBU_JW_CREDENTIAL_KEK_PATH') return './.runtime/hbu-jw/credential-kek.key'
  if (key === 'HBU_JW_BIND_TOKEN_TTL_MS') return '600000'
  if (key === 'HBU_JW_KEEP_ALIVE_INTERVAL_MS') return '180000'
  if (key === 'HBU_JW_KEEP_ALIVE_RECENT_USE_WINDOW_MS') return '86400000'
  return ''
}

async function handleSave(restartAfter = false): Promise<void> {
  try {
    await bc.saveHbuJwSettings(restartAfter)
    toastAdd(restartAfter ? '教务系统配置已保存，正在重启机器人…' : '教务系统配置已保存', 'success')
  } catch (error: unknown) {
    toastAdd(formatErrorMessage(error, restartAfter ? '保存并重启失败' : '保存教务系统配置失败'), 'error')
  }
}
</script>

<template>
  <section class="bc-panel">
    <div class="bc-panel-head">
      <div>
        <h2>教务系统</h2>
        <p class="bc-muted">管理教务绑定、GPA 查询、群聊白名单和登录态刷新。保存后通常需要重启机器人生效。</p>
      </div>
      <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
        <span
          v-if="hbuJwChangedCount > 0"
          class="bc-badge bc-badge-primary"
        >{{ hbuJwChangedCount }} 项已修改</span>
        <button
          class="bc-btn"
          type="button"
          :disabled="!canSaveHbuJwSettings"
          @click="handleSave(false)"
        >
          保存配置
        </button>
        <button
          class="bc-btn bc-btn-primary"
          type="button"
          :disabled="!canSaveHbuJwSettings"
          @click="handleSave(true)"
        >
          保存并重启
        </button>
      </div>
    </div>

    <div class="bc-status-grid">
      <div class="bc-status-card">
        <span class="bc-status-label">群聊白名单</span>
        <strong>{{ allowedGroupsLabel }}</strong>
        <p class="bc-muted">私聊始终允许使用教务功能。</p>
      </div>
      <div class="bc-status-card">
        <span class="bc-status-label">绑定入口</span>
        <strong>{{ bindPagePathLabel }}</strong>
        <p class="bc-muted">{{ publicBaseUrlLabel }}</p>
      </div>
      <div class="bc-status-card">
        <span class="bc-status-label">登录态刷新</span>
        <strong>{{ normalizeBoolean(envDraft.HBU_JW_AUTO_RELOGIN_ENABLED) ? '自动重登开启' : '自动重登关闭' }}</strong>
        <p class="bc-muted">{{ normalizeBoolean(envDraft.HBU_JW_KEEP_ALIVE_ENABLED) ? '保活开启' : '保活关闭' }}</p>
      </div>
    </div>

    <div class="bc-toggle-grid" style="margin-top: 1rem;">
      <ToggleCard
        label="自动重新登录"
        :model-value="normalizeBoolean(envDraft.HBU_JW_AUTO_RELOGIN_ENABLED)"
        :is-dirty="isDirty('HBU_JW_AUTO_RELOGIN_ENABLED')"
        @update:model-value="value => setBooleanEnv('HBU_JW_AUTO_RELOGIN_ENABLED', value)"
      />
      <ToggleCard
        label="登录态保活"
        :model-value="normalizeBoolean(envDraft.HBU_JW_KEEP_ALIVE_ENABLED)"
        :is-dirty="isDirty('HBU_JW_KEEP_ALIVE_ENABLED')"
        @update:model-value="value => setBooleanEnv('HBU_JW_KEEP_ALIVE_ENABLED', value)"
      />
    </div>

    <div class="bc-field-grid" style="margin-top: 1rem;">
      <label
        v-for="key in textKeys"
        :key="key"
        class="bc-field"
        :class="{ 'bc-field-span': key === 'HBU_JW_ALLOWED_GROUPS' }"
      >
        <span class="bc-field-label">
          {{ getFieldLabel(key) }}
          <span
            v-if="getFieldHint(key)"
            class="bc-field-help"
            tabindex="0"
            role="note"
            :aria-label="getFieldHint(key)"
          >
            <span aria-hidden="true">!</span>
            <span class="bc-field-tooltip" role="tooltip">{{ getFieldHint(key) }}</span>
          </span>
          <span
            v-if="isDirty(key)"
            class="bc-field-modified"
          >已修改</span>
        </span>

        <textarea
          v-if="key === 'HBU_JW_ALLOWED_GROUPS'"
          :value="envDraft[key] ?? ''"
          rows="2"
          spellcheck="false"
          :placeholder="placeholder(key)"
          @input="event => setEnv(key, (event.target as HTMLTextAreaElement).value)"
        />
        <input
          v-else
          :type="inputType(key)"
          :value="envDraft[key] ?? ''"
          spellcheck="false"
          :placeholder="placeholder(key)"
          @input="event => setEnv(key, (event.target as HTMLInputElement).value)"
        />
      </label>
    </div>

    <div class="bc-field-grid" style="margin-top: 1rem;">
      <label
        v-for="key in numberKeys"
        :key="key"
        class="bc-field"
      >
        <span class="bc-field-label">
          {{ getFieldLabel(key) }}
          <span
            v-if="getFieldHint(key)"
            class="bc-field-help"
            tabindex="0"
            role="note"
            :aria-label="getFieldHint(key)"
          >
            <span aria-hidden="true">!</span>
            <span class="bc-field-tooltip" role="tooltip">{{ getFieldHint(key) }}</span>
          </span>
          <span
            v-if="isDirty(key)"
            class="bc-field-modified"
          >已修改</span>
        </span>

        <input
          type="number"
          min="1"
          step="1"
          :value="envDraft[key] ?? ''"
          :placeholder="placeholder(key)"
          @input="event => setEnv(key, (event.target as HTMLInputElement).value)"
        />
      </label>
    </div>
  </section>
</template>
