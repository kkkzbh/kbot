<script setup lang="ts">
import { computed, inject } from 'vue'
import type { useBotConsole } from '../../composables/useBotConsole'
import {
  CHAOXING_ENV_KEYS,
  normalizeBoolean,
} from '../../composables/useBotConsole'
import { useToast } from '../../composables/useToast'
import { getFieldHint, getFieldLabel } from '../../utils/constants'
import { formatErrorMessage } from '../../utils/format'
import ToggleCard from '../ToggleCard.vue'

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()
const { envDraft, changedKeys, canSaveAllSettings } = bc

const textKeys = [
  'CHAOXING_ALLOWED_GROUPS',
  'CHAOXING_PUBLIC_BASE_URL',
  'CHAOXING_BIND_PAGE_PATH',
  'CHAOXING_CREDENTIAL_KEK_PATH',
  'CHAOXING_ANSWER_PROVIDER_URL',
  'CHAOXING_ANSWER_PROVIDER_API_KEY',
] as const

const numberKeys = [
  'CHAOXING_BIND_TOKEN_TTL_MS',
  'CHAOXING_SESSION_VALIDATION_TTL_MS',
  'CHAOXING_REQUEST_INTERVAL_MS',
  'CHAOXING_WORKER_POLL_INTERVAL_MS',
  'CHAOXING_SIGN_WATCH_INTERVAL_MS',
  'CHAOXING_DEADLINE_SYNC_INTERVAL_MS',
  'CHAOXING_DEADLINE_REMINDER_LEAD_MS',
  'CHAOXING_STUDY_PLAYBACK_RATE',
  'CHAOXING_VIDEO_REPORT_INTERVAL_MS',
  'CHAOXING_ANSWER_PROVIDER_TIMEOUT_MS',
] as const

const changedCount = computed(() => CHAOXING_ENV_KEYS.filter(key => changedKeys.value.has(key)).length)
const canSave = computed(() => changedCount.value > 0)
const allowedGroupsLabel = computed(() => normalizeGroupList(envDraft.CHAOXING_ALLOWED_GROUPS ?? '') || '未配置群聊白名单')
const naturalTriggerLabel = computed(() => {
  if (!normalizeExplicitTrue(envDraft.CHAT_NATURAL_TRIGGER_ENABLED)) return '自然触发未开启'
  return normalizeGroupList(envDraft.CHAT_NATURAL_TRIGGER_GROUPS ?? '') || '未配置自然触发白名单'
})
const publicBaseUrlLabel = computed(() => (envDraft.CHAOXING_PUBLIC_BASE_URL ?? '').trim() || '跟随 Koishi 本地端口')
const bindPagePathLabel = computed(() => (envDraft.CHAOXING_BIND_PAGE_PATH ?? '').trim() || '/chaoxing/bind')
const workerScheduleLabel = computed(() => {
  const worker = (envDraft.CHAOXING_WORKER_POLL_INTERVAL_MS ?? '').trim() || '5000'
  const sign = (envDraft.CHAOXING_SIGN_WATCH_INTERVAL_MS ?? '').trim() || '15000'
  return `任务 ${worker} ms · 签到 ${sign} ms`
})

function setEnv(key: string, value: string): void {
  envDraft[key] = value
}

function setBooleanEnv(key: string, value: boolean): void {
  envDraft[key] = String(value)
}

function isDirty(key: string): boolean {
  return changedKeys.value.has(key)
}

function normalizeGroupList(value: string): string {
  return value
    .split(/[,\s，、]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .join(',')
}

function normalizeExplicitTrue(value: string | undefined): boolean {
  return String(value ?? '').trim().toLowerCase() === 'true'
}

function placeholder(key: string): string {
  const values: Record<string, string> = {
    CHAOXING_ALLOWED_GROUPS: '829573670,921554872',
    CHAOXING_PUBLIC_BASE_URL: 'https://jw.example.com',
    CHAOXING_BIND_PAGE_PATH: '/chaoxing/bind',
    CHAOXING_CREDENTIAL_KEK_PATH: './.runtime/chaoxing/credential-kek.key',
    CHAOXING_ANSWER_PROVIDER_URL: 'https://answer.example.com/api',
    CHAOXING_ANSWER_PROVIDER_API_KEY: '留空表示不使用密钥',
    CHAOXING_BIND_TOKEN_TTL_MS: '600000',
    CHAOXING_SESSION_VALIDATION_TTL_MS: '600000',
    CHAOXING_REQUEST_INTERVAL_MS: '1200',
    CHAOXING_WORKER_POLL_INTERVAL_MS: '5000',
    CHAOXING_SIGN_WATCH_INTERVAL_MS: '15000',
    CHAOXING_DEADLINE_SYNC_INTERVAL_MS: '900000',
    CHAOXING_DEADLINE_REMINDER_LEAD_MS: '86400000',
    CHAOXING_STUDY_PLAYBACK_RATE: '1',
    CHAOXING_VIDEO_REPORT_INTERVAL_MS: '60000',
    CHAOXING_ANSWER_PROVIDER_TIMEOUT_MS: '15000',
  }
  return values[key] ?? ''
}

function numberMin(key: string): number {
  return key === 'CHAOXING_STUDY_PLAYBACK_RATE' ? 0.1 : 1
}

function numberMax(key: string): number | undefined {
  return key === 'CHAOXING_STUDY_PLAYBACK_RATE' ? 2 : undefined
}

function numberStep(key: string): number {
  return key === 'CHAOXING_STUDY_PLAYBACK_RATE' ? 0.1 : 1
}

async function handleSave(restartAfter = false): Promise<void> {
  try {
    envDraft.CHAOXING_ALLOWED_GROUPS = normalizeGroupList(envDraft.CHAOXING_ALLOWED_GROUPS ?? '')
    if (restartAfter) {
      await bc.saveAllSettingsAndRestart()
      toastAdd('全部配置已保存，正在重启机器人…', 'success')
      return
    }
    await bc.saveEnvPatch(CHAOXING_ENV_KEYS)
    toastAdd('学习通配置已保存', 'success')
  } catch (error: unknown) {
    toastAdd(formatErrorMessage(error, restartAfter ? '保存并重启失败' : '保存学习通配置失败'), 'error')
  }
}
</script>

<template>
  <section class="bc-panel">
    <div class="bc-panel-head">
      <div>
        <h2>学习通</h2>
        <p class="bc-muted">管理学习通绑定、课程任务、签到监听、截止提醒、群聊白名单和答案源。保存后通常需要重启机器人生效。</p>
      </div>
      <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
        <span v-if="changedCount > 0" class="bc-badge bc-badge-primary">{{ changedCount }} 项已修改</span>
        <button class="bc-btn" type="button" :disabled="!canSave" @click="handleSave(false)">保存配置</button>
        <button class="bc-btn bc-btn-primary" type="button" :disabled="!canSaveAllSettings" @click="handleSave(true)">保存全部并重启</button>
      </div>
    </div>

    <div class="bc-status-grid">
      <div class="bc-status-card">
        <span class="bc-status-label">群聊白名单</span>
        <strong>{{ allowedGroupsLabel }}</strong>
        <p class="bc-muted">私聊始终可以使用学习通功能。</p>
      </div>
      <div class="bc-status-card">
        <span class="bc-status-label">裸学习通触发</span>
        <strong>{{ naturalTriggerLabel }}</strong>
        <p class="bc-muted">复用全局自然触发开关和群白名单。</p>
      </div>
      <div class="bc-status-card">
        <span class="bc-status-label">绑定入口</span>
        <strong>{{ bindPagePathLabel }}</strong>
        <p class="bc-muted">{{ publicBaseUrlLabel }}</p>
      </div>
      <div class="bc-status-card">
        <span class="bc-status-label">后台任务</span>
        <strong>{{ normalizeBoolean(envDraft.CHAOXING_AUTO_RELOGIN_ENABLED) ? '自动重登开启' : '自动重登关闭' }}</strong>
        <p class="bc-muted">{{ workerScheduleLabel }}</p>
      </div>
    </div>

    <div class="bc-toggle-grid" style="margin-top: 1rem;">
      <ToggleCard
        label="自动重新登录"
        :model-value="normalizeBoolean(envDraft.CHAOXING_AUTO_RELOGIN_ENABLED)"
        :is-dirty="isDirty('CHAOXING_AUTO_RELOGIN_ENABLED')"
        @update:model-value="value => setBooleanEnv('CHAOXING_AUTO_RELOGIN_ENABLED', value)"
      />
    </div>

    <div class="bc-field-grid" style="margin-top: 1rem;">
      <label
        v-for="key in textKeys"
        :key="key"
        class="bc-field"
        :class="{ 'bc-field-span': key === 'CHAOXING_ALLOWED_GROUPS' }"
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
          <span v-if="isDirty(key)" class="bc-field-modified">已修改</span>
        </span>

        <textarea
          v-if="key === 'CHAOXING_ALLOWED_GROUPS'"
          :value="envDraft[key] ?? ''"
          rows="2"
          spellcheck="false"
          :placeholder="placeholder(key)"
          @input="event => setEnv(key, (event.target as HTMLTextAreaElement).value)"
        />
        <input
          v-else
          :type="key === 'CHAOXING_ANSWER_PROVIDER_API_KEY' ? 'password' : 'text'"
          :value="envDraft[key] ?? ''"
          spellcheck="false"
          :autocomplete="key === 'CHAOXING_ANSWER_PROVIDER_API_KEY' ? 'new-password' : 'off'"
          :placeholder="placeholder(key)"
          @input="event => setEnv(key, (event.target as HTMLInputElement).value)"
        />
      </label>
    </div>

    <div class="bc-field-grid" style="margin-top: 1rem;">
      <label v-for="key in numberKeys" :key="key" class="bc-field">
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
          <span v-if="isDirty(key)" class="bc-field-modified">已修改</span>
        </span>

        <input
          type="number"
          :min="numberMin(key)"
          :max="numberMax(key)"
          :step="numberStep(key)"
          :value="envDraft[key] ?? ''"
          :placeholder="placeholder(key)"
          @input="event => setEnv(key, (event.target as HTMLInputElement).value)"
        />
      </label>
    </div>
  </section>
</template>
