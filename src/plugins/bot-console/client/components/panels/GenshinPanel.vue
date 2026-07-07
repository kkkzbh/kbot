<script setup lang="ts">
import { computed, inject } from 'vue'
import { useToast } from '../../composables/useToast'
import {
  GENSHIN_ENV_KEYS,
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
  changedGenshinEnvKeys,
  canSaveGenshinSettings,
} = bc

const textKeys = [
  'GENSHIN_ALLOWED_GROUPS',
  'GENSHIN_PUBLIC_BASE_URL',
  'GENSHIN_BIND_PAGE_PATH',
  'GENSHIN_CREDENTIAL_KEK_PATH',
  'GENSHIN_AUTO_SIGN_CRON',
  'GENSHIN_TIMEZONE',
  'GENSHIN_TAKUMI_APP_VERSION',
  'GENSHIN_SIGN_ACT_ID',
  'GENSHIN_REDEEM_GAME_VERSION',
] as const

const numberKeys = [
  'GENSHIN_BIND_TOKEN_TTL_MS',
] as const

const genshinChangedCount = computed(() => GENSHIN_ENV_KEYS.filter(key => changedGenshinEnvKeys.value.has(key)).length)
const allowedGroupsLabel = computed(() => {
  const value = normalizeGroupList(envDraft.GENSHIN_ALLOWED_GROUPS ?? '')
  return value || '未配置群聊白名单'
})
const naturalTriggerEnabled = computed(() => normalizeExplicitTrue(envDraft.CHAT_NATURAL_TRIGGER_ENABLED))
const naturalTriggerGroupsLabel = computed(() => {
  if (!naturalTriggerEnabled.value) return '自然触发未开启'
  const value = normalizeGroupList(envDraft.CHAT_NATURAL_TRIGGER_GROUPS ?? '')
  return value || '未配置自然触发白名单'
})
const publicBaseUrlLabel = computed(() => (envDraft.GENSHIN_PUBLIC_BASE_URL ?? '').trim() || '跟随 Koishi 本地端口')
const bindPagePathLabel = computed(() => (envDraft.GENSHIN_BIND_PAGE_PATH ?? '').trim() || '/genshin/bind')
const autoSignLabel = computed(() => normalizeBoolean(envDraft.GENSHIN_AUTO_SIGN_ENABLED) ? '自动签到开启' : '自动签到关闭')
const autoSignScheduleLabel = computed(() => {
  const cron = (envDraft.GENSHIN_AUTO_SIGN_CRON ?? '').trim() || '10 9 * * *'
  const timezone = (envDraft.GENSHIN_TIMEZONE ?? '').trim() || 'Asia/Shanghai'
  return `${cron} · ${timezone}`
})

function setEnv(key: string, value: string): void {
  envDraft[key] = value
}

function setBooleanEnv(key: string, value: boolean): void {
  envDraft[key] = String(value)
}

function isDirty(key: string): boolean {
  return changedGenshinEnvKeys.value.has(key)
}

function placeholder(key: string): string {
  if (key === 'GENSHIN_ALLOWED_GROUPS') return '829573670,921554872'
  if (key === 'GENSHIN_PUBLIC_BASE_URL') return 'https://genshin.example.com'
  if (key === 'GENSHIN_BIND_PAGE_PATH') return '/genshin/bind'
  if (key === 'GENSHIN_CREDENTIAL_KEK_PATH') return './.runtime/genshin/credential-kek.key'
  if (key === 'GENSHIN_AUTO_SIGN_CRON') return '10 9 * * *'
  if (key === 'GENSHIN_TIMEZONE') return 'Asia/Shanghai'
  if (key === 'GENSHIN_TAKUMI_APP_VERSION') return '2.70.1'
  if (key === 'GENSHIN_SIGN_ACT_ID') return 'e202311201442471'
  if (key === 'GENSHIN_REDEEM_GAME_VERSION') return 'CNRELWin6.0.0'
  if (key === 'GENSHIN_BIND_TOKEN_TTL_MS') return '600000'
  return ''
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

async function handleSave(restartAfter = false): Promise<void> {
  try {
    envDraft.GENSHIN_ALLOWED_GROUPS = normalizeGroupList(envDraft.GENSHIN_ALLOWED_GROUPS ?? '')
    await bc.saveGenshinSettings(restartAfter)
    toastAdd(restartAfter ? '原神配置已保存，正在重启机器人…' : '原神配置已保存', 'success')
  } catch (error: unknown) {
    toastAdd(formatErrorMessage(error, restartAfter ? '保存并重启失败' : '保存原神配置失败'), 'error')
  }
}
</script>

<template>
  <section class="bc-panel">
    <div class="bc-panel-head">
      <div>
        <h2>原神</h2>
        <p class="bc-muted">管理原神绑定、签到、兑换、群聊白名单和米游社接口参数。保存后通常需要重启机器人生效。</p>
      </div>
      <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
        <span
          v-if="genshinChangedCount > 0"
          class="bc-badge bc-badge-primary"
        >{{ genshinChangedCount }} 项已修改</span>
        <button
          class="bc-btn"
          type="button"
          :disabled="!canSaveGenshinSettings"
          @click="handleSave(false)"
        >
          保存配置
        </button>
        <button
          class="bc-btn bc-btn-primary"
          type="button"
          :disabled="!canSaveGenshinSettings"
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
        <p class="bc-muted">控制群聊是否允许使用原神功能。</p>
      </div>
      <div class="bc-status-card">
        <span class="bc-status-label">裸原神触发</span>
        <strong>{{ naturalTriggerGroupsLabel }}</strong>
        <p class="bc-muted">不在自然触发白名单的群需要 at 小祥。</p>
      </div>
      <div class="bc-status-card">
        <span class="bc-status-label">绑定入口</span>
        <strong>{{ bindPagePathLabel }}</strong>
        <p class="bc-muted">{{ publicBaseUrlLabel }}</p>
      </div>
      <div class="bc-status-card">
        <span class="bc-status-label">每日签到</span>
        <strong>{{ autoSignLabel }}</strong>
        <p class="bc-muted">{{ autoSignScheduleLabel }}</p>
      </div>
    </div>

    <div class="bc-toggle-grid" style="margin-top: 1rem;">
      <ToggleCard
        label="自动签到"
        :model-value="normalizeBoolean(envDraft.GENSHIN_AUTO_SIGN_ENABLED)"
        :is-dirty="isDirty('GENSHIN_AUTO_SIGN_ENABLED')"
        @update:model-value="value => setBooleanEnv('GENSHIN_AUTO_SIGN_ENABLED', value)"
      />
    </div>

    <div class="bc-field-grid" style="margin-top: 1rem;">
      <label
        v-for="key in textKeys"
        :key="key"
        class="bc-field"
        :class="{ 'bc-field-span': key === 'GENSHIN_ALLOWED_GROUPS' }"
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
          v-if="key === 'GENSHIN_ALLOWED_GROUPS'"
          :value="envDraft[key] ?? ''"
          rows="2"
          spellcheck="false"
          :placeholder="placeholder(key)"
          @input="event => setEnv(key, (event.target as HTMLTextAreaElement).value)"
        />
        <input
          v-else
          type="text"
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
