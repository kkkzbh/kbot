<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useToast } from '../../composables/useToast'
import {
  BUILTIN_MAIN_CHAT_TAB_UI_SCHEMA,
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_EFFORT_OPTIONS,
  DEEPSEEK_MODEL_OPTIONS,
  MIMO_MODEL_OPTIONS,
  MODEL_TAB_IDS,
} from '../../composables/useBotConsole'
import type { BotConsoleModelOption, BotConsoleModelTabId, BotConsoleModelListSource } from '../../types'
import type { useBotConsole } from '../../composables/useBotConsole'

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()

const {
  activeModelTab,
  copilotAuthAttempt,
  codexAuthAttempt,
  currentModelTabDraft,
  canSaveModelSettings,
  modelTabsChanged,
  dirtyModelTabIds,
  currentModelValidation,
  selectModelTab,
} = bc

const {
  startCopilotAuth,
  pollCopilotAuth,
  cancelCopilotAuth,
  logoutCopilotAuth,
  startCodexAuth,
  pollCodexAuth,
  cancelCodexAuth,
  logoutCodexAuth,
  refreshCopilotAuthStatus,
  refreshCodexAuthStatus,
  listCodexModels,
  listCopilotModels,
  listDeepSeekModels,
  listMimoModels,
} = bc

const tabTitles: Record<BotConsoleModelTabId, string> = {
  siliconflow: '硅基流动',
  openai: 'OpenAI',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  deepseek: 'DeepSeek',
  mimo: 'MIMO',
}

type ModelOptionTag = {
  id: string
  label: string
  title: string
  kind: 'rate' | 'mode'
  mode?: 'responses' | 'schema' | 'chat'
}

const currentSchema = computed(() => BUILTIN_MAIN_CHAT_TAB_UI_SCHEMA[activeModelTab.value])
const currentTabModelHint = computed(() => currentModelTabDraft.value.modelHint)

const isCopilotTab = computed(() => activeModelTab.value === 'copilot')
const isCodexTab = computed(() => activeModelTab.value === 'codex')
const isDeepseekTab = computed(() => activeModelTab.value === 'deepseek')
const isMimoTab = computed(() => activeModelTab.value === 'mimo')

const codexModelOptions = ref<BotConsoleModelOption[]>(CODEX_MODEL_OPTIONS.map(option => ({ ...option })))
const codexModelSource = ref<BotConsoleModelListSource>('static')
const codexModelError = ref<string | null>(null)
const codexModelLoading = ref(false)
const copilotModelOptions = ref<BotConsoleModelOption[]>([])
const copilotModelSource = ref<BotConsoleModelListSource>('dynamic')
const copilotModelError = ref<string | null>(null)
const copilotModelLoading = ref(false)
const deepseekModelOptions = ref<BotConsoleModelOption[]>(DEEPSEEK_MODEL_OPTIONS.map(option => ({ ...option })))
const deepseekModelSource = ref<BotConsoleModelListSource>('static')
const deepseekModelError = ref<string | null>(null)
const deepseekModelLoading = ref(false)
const mimoModelOptions = ref<BotConsoleModelOption[]>(MIMO_MODEL_OPTIONS.map(option => ({ ...option })))
const mimoModelSource = ref<BotConsoleModelListSource>('static')
const mimoModelError = ref<string | null>(null)
const mimoModelLoading = ref(false)
const modelSelectRoot = ref<HTMLElement | null>(null)
const modelDropdownOpen = ref(false)

const currentDeepSeekModelId = computed(() => {
  const value = currentModelTabDraft.value.defaultModel.trim()
  return value.startsWith('deepseek/') ? value.slice('deepseek/'.length) : value
})
const currentMimoModelId = computed(() => {
  const value = currentModelTabDraft.value.defaultModel.trim()
  return value.startsWith('mimo/') ? value.slice('mimo/'.length) : value
})
const currentCopilotModelId = computed(() => {
  const value = currentModelTabDraft.value.defaultModel.trim()
  if (value.startsWith('openai/')) return value.slice('openai/'.length)
  if (value.startsWith('github-copilot/')) return value.slice('github-copilot/'.length)
  return value
})
const currentCodexModelId = computed(() => {
  const value = currentModelTabDraft.value.defaultModel.trim()
  if (value.startsWith('openai/')) return value.slice('openai/'.length)
  return value
})

const currentModelOptions = computed(() => {
  if (isCodexTab.value) return codexModelOptions.value
  if (isCopilotTab.value) return copilotModelOptions.value
  if (isDeepseekTab.value) return deepseekModelOptions.value
  if (isMimoTab.value) return mimoModelOptions.value
  return [...currentSchema.value.modelOptions]
})

const currentModelSelectValue = computed(() => {
  if (isDeepseekTab.value) return currentDeepSeekModelId.value
  if (isMimoTab.value) return currentMimoModelId.value
  if (isCodexTab.value) return currentCodexModelId.value
  if (isCopilotTab.value) return currentCopilotModelId.value
  return currentModelTabDraft.value.defaultModel
})

const currentModelSelectDisabled = computed(() => {
  return (isCopilotTab.value && copilotModelOptions.value.length === 0)
    || (isCodexTab.value && codexModelOptions.value.length === 0)
})

const selectedModelOption = computed(() => {
  return currentModelOptions.value.find(option => option.modelId === currentModelSelectValue.value) ?? null
})

const currentModelSelectLabel = computed(() => {
  if (selectedModelOption.value) return selectedModelOption.value.label
  if (isCodexTab.value && codexModelOptions.value.length === 0) return '暂无 Codex 可用模型'
  if (isCopilotTab.value && copilotModelOptions.value.length === 0) return '暂无 OAuth 可用模型'
  return currentModelSelectValue.value || '请选择模型'
})

const codexSourceLabel = computed(() => codexModelError.value ? (codexModelSource.value === 'static' ? '静态兜底' : '不可用') : (codexModelSource.value === 'dynamic' ? 'Codex 动态' : '静态兜底'))
const copilotSourceLabel = computed(() => copilotModelError.value ? '不可用' : 'OAuth 动态')
const deepseekSourceLabel = computed(() => deepseekModelSource.value === 'dynamic' ? '官方动态' : '官方兜底')
const mimoSourceLabel = computed(() => mimoModelSource.value === 'dynamic' ? '官方动态' : '静态兜底')

const oauthStatusTone = computed(() => {
  switch (currentModelTabDraft.value.authStatus) {
    case 'ready':
      return 'is-success'
    case 'pending':
      return 'is-warning'
    case 'error':
    case 'expired':
      return 'is-danger'
    default:
      return 'is-muted'
  }
})

const oauthStatusLabel = computed(() => {
  switch (currentModelTabDraft.value.authStatus) {
    case 'ready':
      return '已登录'
    case 'pending':
      return '登录中'
    case 'expired':
      return '已过期'
    case 'error':
      return '错误'
    default:
      return '未登录'
  }
})

const codexTokenExpiresLabel = computed(() => {
  const value = currentModelTabDraft.value.tokenExpiresAt
  if (!value) return ''
  return new Date(value).toLocaleString()
})

const dirtyBadgeLabel = computed(() => {
  const ids = dirtyModelTabIds.value
  if (ids.length === 0) return ''
  return `${ids.length} 个 Tab 待保存`
})

let deepseekRefreshTimer: number | null = null
let mimoRefreshTimer: number | null = null
let copilotPollTimer: number | null = null
let codexPollTimer: number | null = null

function setTabField(key: 'baseUrl' | 'apiKey' | 'defaultModel', value: string) {
  currentModelTabDraft.value[key] = value
}

function setCodexReasoningEffort(value: string) {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
    currentModelTabDraft.value.reasoningEffort = value
  }
}

function modelModeTag(option: BotConsoleModelOption): ModelOptionTag | null {
  if (option.requestMode === 'responses') {
    return {
      id: 'mode-responses',
      label: 'R',
      title: 'Responses API',
      kind: 'mode',
      mode: 'responses',
    }
  }

  if (option.structuredOutputProtocol === 'native_responses_json_schema' || option.structuredOutputProtocol === 'native_chat_json_schema') {
    return {
      id: 'mode-schema',
      label: '{}',
      title: 'JSON Schema',
      kind: 'mode',
      mode: 'schema',
    }
  }

  if (option.requestMode === 'chat_completions' || option.structuredOutputProtocol === 'chat_reply_v1') {
    return {
      id: 'mode-chat',
      label: 'C',
      title: 'Chat',
      kind: 'mode',
      mode: 'chat',
    }
  }

  return null
}

function modelOptionTags(option: BotConsoleModelOption | null): ModelOptionTag[] {
  if (!option) return []
  const tags: ModelOptionTag[] = []
  const rateLabel = option.rateLabel?.trim()
  if (rateLabel) {
    tags.push({
      id: `rate-${rateLabel}`,
      label: rateLabel,
      title: `倍率 ${rateLabel}`,
      kind: 'rate',
    })
  }
  const modeTag = modelModeTag(option)
  if (modeTag) tags.push(modeTag)
  return tags
}

function closeModelDropdown() {
  modelDropdownOpen.value = false
}

function toggleModelDropdown() {
  if (currentModelSelectDisabled.value) return
  modelDropdownOpen.value = !modelDropdownOpen.value
}

function selectModelOption(option: BotConsoleModelOption) {
  setTabField('defaultModel', option.modelId)
  closeModelDropdown()
}

function handleDocumentPointerDown(event: PointerEvent) {
  const root = modelSelectRoot.value
  if (!root || root.contains(event.target as Node)) return
  closeModelDropdown()
}

function stopDeepSeekRefreshTimer() {
  if (deepseekRefreshTimer != null) {
    window.clearTimeout(deepseekRefreshTimer)
    deepseekRefreshTimer = null
  }
}

function stopMimoRefreshTimer() {
  if (mimoRefreshTimer != null) {
    window.clearTimeout(mimoRefreshTimer)
    mimoRefreshTimer = null
  }
}

async function refreshCopilotModels() {
  copilotModelLoading.value = true
  try {
    const result = await listCopilotModels()
    copilotModelOptions.value = result.models.map(option => ({ ...option }))
    copilotModelSource.value = result.source
    copilotModelError.value = result.error
  } catch (err: unknown) {
    copilotModelOptions.value = []
    copilotModelSource.value = 'dynamic'
    copilotModelError.value = err instanceof Error ? err.message : String(err)
  } finally {
    copilotModelLoading.value = false
  }
}

async function refreshCodexModels() {
  codexModelLoading.value = true
  try {
    const result = await listCodexModels()
    codexModelOptions.value = result.models.length > 0
      ? result.models.map(option => ({ ...option }))
      : CODEX_MODEL_OPTIONS.map(option => ({ ...option }))
    codexModelSource.value = result.source
    codexModelError.value = result.error
  } catch (err: unknown) {
    codexModelOptions.value = CODEX_MODEL_OPTIONS.map(option => ({ ...option }))
    codexModelSource.value = 'static'
    codexModelError.value = err instanceof Error ? err.message : String(err)
  } finally {
    codexModelLoading.value = false
  }
}

async function refreshDeepSeekModels() {
  deepseekModelLoading.value = true
  try {
    const result = await listDeepSeekModels({
      baseUrl: currentModelTabDraft.value.baseUrl,
      apiKey: currentModelTabDraft.value.apiKey,
    })
    deepseekModelOptions.value = result.models.length > 0
      ? result.models.map(option => ({ ...option }))
      : DEEPSEEK_MODEL_OPTIONS.map(option => ({ ...option }))
    deepseekModelSource.value = result.source
    deepseekModelError.value = result.error
  } catch (err: unknown) {
    deepseekModelOptions.value = DEEPSEEK_MODEL_OPTIONS.map(option => ({ ...option }))
    deepseekModelSource.value = 'static'
    deepseekModelError.value = err instanceof Error ? err.message : String(err)
  } finally {
    deepseekModelLoading.value = false
  }
}

async function refreshMimoModels() {
  mimoModelLoading.value = true
  try {
    const result = await listMimoModels({
      baseUrl: currentModelTabDraft.value.baseUrl,
      apiKey: currentModelTabDraft.value.apiKey,
    })
    mimoModelOptions.value = result.models.length > 0
      ? result.models.map(option => ({ ...option }))
      : MIMO_MODEL_OPTIONS.map(option => ({ ...option }))
    mimoModelSource.value = result.source
    mimoModelError.value = result.error
  } catch (err: unknown) {
    mimoModelOptions.value = MIMO_MODEL_OPTIONS.map(option => ({ ...option }))
    mimoModelSource.value = 'static'
    mimoModelError.value = err instanceof Error ? err.message : String(err)
  } finally {
    mimoModelLoading.value = false
  }
}

function scheduleDeepSeekRefresh() {
  stopDeepSeekRefreshTimer()
  if (activeModelTab.value !== 'deepseek') return
  deepseekRefreshTimer = window.setTimeout(() => {
    void refreshDeepSeekModels()
  }, 350)
}

function scheduleMimoRefresh() {
  stopMimoRefreshTimer()
  if (activeModelTab.value !== 'mimo') return
  mimoRefreshTimer = window.setTimeout(() => {
    void refreshMimoModels()
  }, 350)
}

function stopCopilotPolling() {
  if (copilotPollTimer != null) {
    window.clearTimeout(copilotPollTimer)
    copilotPollTimer = null
  }
}

function stopCodexPolling() {
  if (codexPollTimer != null) {
    window.clearTimeout(codexPollTimer)
    codexPollTimer = null
  }
}

function scheduleCopilotPolling() {
  stopCopilotPolling()
  const attempt = copilotAuthAttempt.value
  if (!attempt || attempt.state !== 'pending') return
  const delay = Math.max(250, attempt.nextPollAt - Date.now())
  copilotPollTimer = window.setTimeout(async () => {
    try {
      const result = await pollCopilotAuth(attempt.attemptId)
      if (result.authStatus === 'ready') {
        await refreshCopilotModels()
        toastAdd('GitHub Copilot OAuth 登录成功', 'success')
      } else if (result.authStatus === 'error' || result.authStatus === 'expired') {
        toastAdd(result.authError || 'GitHub Copilot OAuth 登录失败', 'error')
      }
    } catch (err: unknown) {
      toastAdd(formatError(err) ?? 'GitHub Copilot 状态轮询失败', 'error')
    } finally {
      scheduleCopilotPolling()
    }
  }, delay)
}

async function handleStartCopilotAuth() {
  try {
    const result = await startCopilotAuth()
    scheduleCopilotPolling()
    toastAdd(`请在浏览器中输入验证码 ${result.attempt?.userCode ?? ''}`, 'success')
  } catch (err: unknown) {
    toastAdd(formatError(err) ?? '发起 GitHub Copilot OAuth 失败', 'error')
  }
}

function scheduleCodexPolling() {
  stopCodexPolling()
  const attempt = codexAuthAttempt.value
  if (!attempt || attempt.state !== 'pending') return
  const delay = Math.max(250, attempt.nextPollAt - Date.now())
  codexPollTimer = window.setTimeout(async () => {
    try {
      const result = await pollCodexAuth(attempt.attemptId)
      if (result.authStatus === 'ready') {
        await refreshCodexModels()
        toastAdd('Codex OAuth 登录成功', 'success')
      } else if (result.authStatus === 'error' || result.authStatus === 'expired') {
        toastAdd(result.authError || 'Codex OAuth 登录失败', 'error')
      }
    } catch (err: unknown) {
      toastAdd(formatError(err) ?? 'Codex OAuth 状态轮询失败', 'error')
    } finally {
      scheduleCodexPolling()
    }
  }, delay)
}

async function handleStartCodexAuth() {
  try {
    const result = await startCodexAuth()
    scheduleCodexPolling()
    toastAdd(`请在浏览器中输入验证码 ${result.attempt?.userCode ?? ''}`, 'success')
  } catch (err: unknown) {
    toastAdd(formatError(err) ?? '发起 Codex OAuth 失败', 'error')
  }
}

async function handleCancelCodexAuth() {
  try {
    await cancelCodexAuth()
    stopCodexPolling()
    toastAdd('已取消 Codex OAuth 登录', 'success')
  } catch (err: unknown) {
    toastAdd(formatError(err) ?? '取消 Codex OAuth 失败', 'error')
  }
}

async function handleLogoutCodexAuth() {
  try {
    await logoutCodexAuth()
    stopCodexPolling()
    toastAdd('Codex OAuth 授权已清除', 'success')
  } catch (err: unknown) {
    toastAdd(formatError(err) ?? '退出 Codex OAuth 失败', 'error')
  }
}

async function handleCancelCopilotAuth() {
  try {
    await cancelCopilotAuth()
    stopCopilotPolling()
    toastAdd('已取消 GitHub Copilot OAuth 登录', 'success')
  } catch (err: unknown) {
    toastAdd(formatError(err) ?? '取消 GitHub Copilot OAuth 失败', 'error')
  }
}

async function handleLogoutCopilotAuth() {
  try {
    await logoutCopilotAuth()
    stopCopilotPolling()
    copilotModelOptions.value = []
    copilotModelError.value = null
    toastAdd('GitHub Copilot 授权已清除', 'success')
  } catch (err: unknown) {
    toastAdd(formatError(err) ?? '退出 GitHub Copilot OAuth 失败', 'error')
  }
}

async function handleRefreshCopilotAuth() {
  try {
    await refreshCopilotAuthStatus()
    await refreshCopilotModels()
    toastAdd('GitHub Copilot 状态已刷新', 'success')
  } catch (err: unknown) {
    toastAdd(formatError(err) ?? '刷新 GitHub Copilot 状态失败', 'error')
  }
}

async function handleRefreshCodexAuth() {
  try {
    await refreshCodexAuthStatus()
    await refreshCodexModels()
    toastAdd('Codex OAuth 状态已刷新', 'success')
  } catch (err: unknown) {
    toastAdd(formatError(err) ?? '刷新 Codex OAuth 状态失败', 'error')
  }
}

function formatError(err: unknown): string | null {
  if (err == null) return null
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err.trim()) return err
  if (typeof err === 'object') {
    const maybe = (err as { message?: unknown }).message
    if (typeof maybe === 'string' && maybe.trim()) return maybe
    try { return JSON.stringify(err) } catch { /* fall through */ }
  }
  return null
}

async function copyText(value: string | null | undefined, label: string) {
  const text = value?.trim()
  if (!text) {
    toastAdd(`${label}为空，无法复制`, 'error')
    return
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const input = document.createElement('textarea')
      input.value = text
      input.setAttribute('readonly', 'true')
      input.style.position = 'fixed'
      input.style.opacity = '0'
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      document.body.removeChild(input)
    }
    toastAdd(`已复制${label}`, 'success')
  } catch (err: unknown) {
    toastAdd(formatError(err) ?? `复制${label}失败`, 'error')
  }
}

async function handleSave() {
  if (!modelTabsChanged.value) return
  if (!currentModelValidation.value.ok) {
    toastAdd(currentModelValidation.value.message ?? '当前默认模型不合法', 'error')
    return
  }
  try {
    const result = await bc.saveModelSettings(false)
    if (result?.hotSwitched) {
      toastAdd('模型已热切换，下一轮对话对所有房间生效', 'success')
    } else if (result?.restartRequired) {
      toastAdd(result.restartReason ?? '模型配置已保存，重启后生效', 'success')
    } else {
      toastAdd('模型配置已保存', 'success')
    }
  } catch (err: unknown) {
    toastAdd(formatError(err) ?? '保存失败', 'error')
  }
}

watch(copilotAuthAttempt, () => {
  scheduleCopilotPolling()
})

watch(codexAuthAttempt, () => {
  scheduleCodexPolling()
})

watch(activeModelTab, (tabId) => {
  closeModelDropdown()
  if (tabId === 'codex') {
    void refreshCodexAuthStatus().catch(() => null)
    void refreshCodexModels().catch(() => null)
    stopCopilotPolling()
  } else if (tabId === 'copilot') {
    void refreshCopilotAuthStatus().catch(() => null)
    void refreshCopilotModels().catch(() => null)
    stopCodexPolling()
	  } else if (tabId === 'deepseek') {
	    scheduleDeepSeekRefresh()
	    stopCopilotPolling()
	    stopCodexPolling()
	  } else if (tabId === 'mimo') {
	    scheduleMimoRefresh()
	    stopCopilotPolling()
	    stopCodexPolling()
	  } else {
	    stopCopilotPolling()
	    stopCodexPolling()
	  }
})

watch(
  () => [activeModelTab.value, currentModelTabDraft.value.baseUrl, currentModelTabDraft.value.apiKey] as const,
	  ([tabId]) => {
	    if (tabId === 'deepseek') scheduleDeepSeekRefresh()
	    if (tabId === 'mimo') scheduleMimoRefresh()
	  },
	)

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown)
  if (activeModelTab.value === 'codex') {
    void refreshCodexAuthStatus().catch(() => null)
    void refreshCodexModels().catch(() => null)
  } else if (activeModelTab.value === 'copilot') {
    void refreshCopilotAuthStatus().catch(() => null)
    void refreshCopilotModels().catch(() => null)
	  } else if (activeModelTab.value === 'deepseek') {
	    scheduleDeepSeekRefresh()
	  } else if (activeModelTab.value === 'mimo') {
	    scheduleMimoRefresh()
  }
  scheduleCopilotPolling()
  scheduleCodexPolling()
})

onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', handleDocumentPointerDown)
	  stopDeepSeekRefreshTimer()
	  stopMimoRefreshTimer()
	  stopCopilotPolling()
	  stopCodexPolling()
	})
</script>

<template>
  <article class="bc-panel">
    <div class="bc-panel-head">
      <div>
        <h2>模型接口</h2>
	        <p>固定内置六个主聊天 provider Tab。本页配置的就是 chat 主模型；其它功能（语音、回复等）若没有单独配置则回落到当前激活 Tab。保存后重启机器人生效。</p>
      </div>
      <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
        <span
          v-if="dirtyBadgeLabel"
          class="bc-badge bc-badge-primary"
        >{{ dirtyBadgeLabel }}</span>
        <button
          class="bc-btn bc-btn-primary"
          type="button"
          :disabled="!canSaveModelSettings"
          @click="handleSave"
        >
          保存配置
        </button>
      </div>
    </div>

    <section class="bc-model-tabs">
      <div class="bc-model-tab-row">
        <button
          v-for="tabId in MODEL_TAB_IDS"
          :key="tabId"
          type="button"
          :class="['bc-model-tab', activeModelTab === tabId && 'is-active', dirtyModelTabIds.includes(tabId) && 'is-dirty']"
          @click="selectModelTab(tabId)"
        >
          {{ tabTitles[tabId] }}
          <span
            v-if="dirtyModelTabIds.includes(tabId)"
            class="bc-model-tab-dot"
            aria-hidden="true"
          />
        </button>
      </div>

      <div class="bc-model-tab-card">
        <div class="bc-model-tab-head">
          <div>
            <strong>{{ tabTitles[activeModelTab] }}</strong>
            <p>{{ currentModelTabDraft.description }}</p>
          </div>
          <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
            <span class="bc-status-badge is-muted">provider: {{ currentModelTabDraft.provider }}</span>
            <span class="bc-status-badge is-muted">strategy: {{ currentModelTabDraft.strategyId }}</span>
            <span class="bc-status-badge is-muted">mode: {{ currentModelTabDraft.requestMode }}</span>
            <span
              v-if="isCopilotTab || isCodexTab"
              :class="['bc-status-badge', oauthStatusTone]"
            >OAuth：{{ oauthStatusLabel }}</span>
          </div>
        </div>

        <div
          class="bc-field-grid"
          style="margin-top: 1rem;"
        >
          <label
            v-if="!isCodexTab"
            class="bc-field"
          >
            <span class="bc-field-label">
              <span>对话模型接口地址</span>
              <span
                v-if="!currentSchema.baseUrlEditable"
                class="bc-field-note"
              >只读</span>
            </span>
            <input
              type="text"
              :value="currentModelTabDraft.baseUrl"
              spellcheck="false"
              autocomplete="off"
              :readonly="!currentSchema.baseUrlEditable"
              @input="(e) => {
                if (currentSchema.baseUrlEditable) setTabField('baseUrl', (e.target as HTMLInputElement).value)
              }"
            >
          </label>

          <label
            v-if="!isCodexTab"
            class="bc-field"
          >
            <span class="bc-field-label">
              <span>对话模型接口密钥</span>
              <span
                v-if="!currentSchema.apiKeyEditable"
                class="bc-field-note"
              >由 Bridge 自动管理</span>
            </span>
            <input
              v-if="currentSchema.apiKeyVisible"
              type="password"
              :value="currentModelTabDraft.apiKey"
              spellcheck="false"
              autocomplete="off"
              :readonly="!currentSchema.apiKeyEditable"
              :placeholder="currentSchema.apiKeyEditable ? '' : '由 OAuth bridge 自动注入'"
              @input="(e) => {
                if (currentSchema.apiKeyEditable) setTabField('apiKey', (e.target as HTMLInputElement).value)
              }"
            >
            <input
              v-else
              type="text"
              value="(由 OAuth bridge 自动注入)"
              readonly
              tabindex="-1"
            >
          </label>

          <div class="bc-field">
            <span class="bc-field-label">
              <span>对话默认模型</span>
              <span
                class="bc-field-help"
                tabindex="0"
                :aria-label="currentTabModelHint"
              >
                <span aria-hidden="true">!</span>
                <span class="bc-field-tooltip" role="tooltip">{{ currentTabModelHint }}</span>
              </span>
            </span>
            <div
              v-if="currentSchema.modelInputKind !== 'free-text'"
              ref="modelSelectRoot"
              :class="['bc-model-select', modelDropdownOpen && 'is-open']"
              @keydown.esc.stop.prevent="closeModelDropdown"
            >
              <button
                type="button"
                class="bc-model-select-button"
                :disabled="currentModelSelectDisabled"
                aria-haspopup="listbox"
                :aria-expanded="modelDropdownOpen"
                @click="toggleModelDropdown"
              >
                <span class="bc-model-select-label">{{ currentModelSelectLabel }}</span>
                <span
                  v-if="modelOptionTags(selectedModelOption).length > 0"
                  class="bc-model-select-tags"
                >
                  <span
                    v-for="tag in modelOptionTags(selectedModelOption)"
                    :key="tag.id"
                    :class="['bc-model-select-tag', `is-${tag.kind}`, tag.mode && `is-${tag.mode}`]"
                    :title="tag.title"
                    :aria-label="tag.title"
                  >{{ tag.label }}</span>
                </span>
                <span class="bc-model-select-chevron" aria-hidden="true" />
              </button>
              <div
                v-if="modelDropdownOpen"
                class="bc-model-select-list"
                role="listbox"
              >
                <button
                  v-for="option in currentModelOptions"
                  :key="option.modelId"
                  type="button"
                  :class="['bc-model-select-option', option.modelId === currentModelSelectValue && 'is-selected']"
                  role="option"
                  :aria-selected="option.modelId === currentModelSelectValue"
                  :title="option.modelId"
                  @click="selectModelOption(option)"
                >
                  <span class="bc-model-select-option-text">
                    <span class="bc-model-select-option-label">{{ option.label }}</span>
                    <span
                      v-if="option.modelId !== option.label"
                      class="bc-model-select-option-id"
                    >{{ option.modelId }}</span>
                  </span>
                  <span
                    v-if="modelOptionTags(option).length > 0"
                    class="bc-model-select-tags"
                  >
                    <span
                      v-for="tag in modelOptionTags(option)"
                      :key="tag.id"
                      :class="['bc-model-select-tag', `is-${tag.kind}`, tag.mode && `is-${tag.mode}`]"
                      :title="tag.title"
                      :aria-label="tag.title"
                    >{{ tag.label }}</span>
                  </span>
                </button>
              </div>
            </div>
            <input
              v-else
              type="text"
              :value="currentModelTabDraft.defaultModel"
              spellcheck="false"
              autocomplete="off"
              @input="(e) => setTabField('defaultModel', (e.target as HTMLInputElement).value)"
            >
          </div>

          <label
            v-if="isCodexTab"
            class="bc-field"
          >
            <span class="bc-field-label">
              <span>思考程度</span>
            </span>
            <select
              :value="currentModelTabDraft.reasoningEffort || 'medium'"
              @change="(e) => setCodexReasoningEffort((e.target as HTMLSelectElement).value)"
            >
              <option
                v-for="option in CODEX_REASONING_EFFORT_OPTIONS"
                :key="option.id"
                :value="option.id"
              >
                {{ option.label }}
              </option>
            </select>
          </label>
        </div>

        <p
          v-if="!currentModelValidation.ok"
          class="bc-model-validation"
        >{{ currentModelValidation.message }}</p>

        <section class="bc-model-secondary">
	          <template v-if="currentSchema.secondaryAction === 'deepseek-refresh'">
	            <div class="bc-model-secondary-row">
	              <span class="bc-status-badge is-muted">models: {{ deepseekSourceLabel }}</span>
              <span
                v-if="deepseekModelLoading"
                class="bc-status-badge is-muted"
              >刷新中</span>
              <span
                v-if="deepseekModelError"
                class="bc-status-badge is-warning"
              >{{ deepseekModelError }}</span>
              <button
                class="bc-btn"
                type="button"
                :disabled="deepseekModelLoading"
                @click="refreshDeepSeekModels"
              >
                刷新官方列表
              </button>
	            </div>
	          </template>

	          <template v-else-if="currentSchema.secondaryAction === 'mimo-refresh'">
	            <div class="bc-model-secondary-row">
	              <span class="bc-status-badge is-muted">models: {{ mimoSourceLabel }}</span>
	              <span
	                v-if="mimoModelLoading"
	                class="bc-status-badge is-muted"
	              >刷新中</span>
	              <span
	                v-if="mimoModelError"
	                class="bc-status-badge is-warning"
	              >{{ mimoModelError }}</span>
	              <button
	                class="bc-btn"
	                type="button"
	                :disabled="mimoModelLoading"
	                @click="refreshMimoModels"
	              >
	                刷新官方列表
	              </button>
	            </div>
	          </template>

	          <template v-else-if="currentSchema.secondaryAction === 'codex-oauth'">
            <div class="bc-model-secondary-row bc-model-secondary-row-stack">
              <div class="bc-model-secondary-info">
                <span><strong>模型：</strong>{{ codexSourceLabel }}</span>
                <span
                  v-if="codexModelLoading"
                  class="bc-model-secondary-muted"
                >刷新中</span>
                <span
                  v-if="codexModelError"
                  class="bc-model-secondary-error"
                >
                  <strong>模型错误：</strong>{{ codexModelError }}
                </span>
                <span><strong>账号：</strong>{{ currentModelTabDraft.accountLabel || '未登录' }}</span>
                <span v-if="codexTokenExpiresLabel"><strong>Token 过期：</strong>{{ codexTokenExpiresLabel }}</span>
                <span v-if="currentModelTabDraft.authError" class="bc-model-secondary-error">
                  <strong>错误：</strong>{{ currentModelTabDraft.authError }}
                </span>
                <span
                  v-if="codexAuthAttempt"
                >
                  <strong>验证码：</strong>
                  <code>{{ codexAuthAttempt.userCode }}</code>
                  <button
                    class="bc-btn bc-btn-sm"
                    type="button"
                    style="margin-left: 0.5rem;"
                    @click="copyText(codexAuthAttempt.userCode, 'Codex 验证码')"
                  >
                    复制验证码
                  </button>
                  <a
                    :href="codexAuthAttempt.verificationUri"
                    target="_blank"
                    rel="noopener noreferrer"
                    style="margin-left: 0.5rem;"
                  >打开 Codex 授权页</a>
                  <button
                    class="bc-btn bc-btn-sm"
                    type="button"
                    style="margin-left: 0.5rem;"
                    @click="copyText(codexAuthAttempt.verificationUri, 'Codex 授权链接')"
                  >
                    复制链接
                  </button>
                </span>
                <span
                  v-if="codexAuthAttempt"
                  class="bc-model-secondary-muted"
                >OpenAI 授权页若在选择账号时报 Route Error，请换无痕窗口或清理 auth.openai.com Cookie 后重新打开链接；本地只负责设备码申请和轮询，不接收页面账号选择内容。</span>
                <span class="bc-model-secondary-muted">OAuth 由机器人控制台独立维护，不读取本机 Codex CLI 登录状态。</span>
              </div>
              <div class="bc-model-secondary-actions">
                <button
                  class="bc-btn bc-btn-primary"
                  type="button"
                  :disabled="currentModelTabDraft.authStatus === 'pending'"
                  @click="handleStartCodexAuth"
                >
                  开始 OAuth 登录
                </button>
                <button
                  class="bc-btn"
                  type="button"
                  :disabled="!codexAuthAttempt || currentModelTabDraft.authStatus !== 'pending'"
                  @click="handleCancelCodexAuth"
                >
                  取消登录
                </button>
                <button
                  class="bc-btn"
                  type="button"
                  :disabled="currentModelTabDraft.authStatus === 'unauthenticated'"
                  @click="handleLogoutCodexAuth"
                >
                  退出登录
                </button>
                <button
                  class="bc-btn"
                  type="button"
                  :disabled="codexModelLoading"
                  @click="refreshCodexModels"
                >
                  刷新模型列表
                </button>
                <button
                  class="bc-btn"
                  type="button"
                  @click="handleRefreshCodexAuth"
                >
                  刷新状态
                </button>
              </div>
            </div>
          </template>

	          <template v-else-if="currentSchema.secondaryAction === 'copilot-oauth'">
            <div class="bc-model-secondary-row bc-model-secondary-row-stack">
              <div class="bc-model-secondary-info">
                <span><strong>模型：</strong>{{ copilotSourceLabel }}</span>
                <span
                  v-if="copilotModelLoading"
                  class="bc-model-secondary-muted"
                >刷新中</span>
                <span
                  v-if="copilotModelError"
                  class="bc-model-secondary-error"
                >
                  <strong>模型错误：</strong>{{ copilotModelError }}
                </span>
                <span><strong>账号：</strong>{{ currentModelTabDraft.accountLabel || '未登录' }}</span>
                <span v-if="currentModelTabDraft.authError" class="bc-model-secondary-error">
                  <strong>错误：</strong>{{ currentModelTabDraft.authError }}
                </span>
                <span v-if="copilotAuthAttempt">
                  <strong>验证码：</strong>
                  <code>{{ copilotAuthAttempt.userCode }}</code>
                  <button
                    class="bc-btn bc-btn-sm"
                    type="button"
                    style="margin-left: 0.5rem;"
                    @click="copyText(copilotAuthAttempt.userCode, 'GitHub Copilot 验证码')"
                  >
                    复制验证码
                  </button>
                  <a
                    :href="copilotAuthAttempt.verificationUri"
                    target="_blank"
                    rel="noopener noreferrer"
                    style="margin-left: 0.5rem;"
                  >打开 GitHub 授权页</a>
                  <button
                    class="bc-btn bc-btn-sm"
                    type="button"
                    style="margin-left: 0.5rem;"
                    @click="copyText(copilotAuthAttempt.verificationUri, 'GitHub Copilot 授权链接')"
                  >
                    复制链接
                  </button>
                </span>
              </div>
              <div class="bc-model-secondary-actions">
                <button
                  class="bc-btn bc-btn-primary"
                  type="button"
                  :disabled="currentModelTabDraft.authStatus === 'pending'"
                  @click="handleStartCopilotAuth"
                >
                  开始 OAuth 登录
                </button>
                <button
                  class="bc-btn"
                  type="button"
                  :disabled="!copilotAuthAttempt || currentModelTabDraft.authStatus !== 'pending'"
                  @click="handleCancelCopilotAuth"
                >
                  取消登录
                </button>
                <button
                  class="bc-btn"
                  type="button"
                  :disabled="currentModelTabDraft.authStatus === 'unauthenticated'"
                  @click="handleLogoutCopilotAuth"
                >
                  退出登录
                </button>
                <button
                  class="bc-btn"
                  type="button"
                  :disabled="copilotModelLoading"
                  @click="refreshCopilotModels"
                >
                  刷新模型列表
                </button>
                <button
                  class="bc-btn"
                  type="button"
                  @click="handleRefreshCopilotAuth"
                >
                  刷新状态
                </button>
              </div>
            </div>
          </template>

          <template v-else>
            <span class="bc-muted bc-model-secondary-empty">本 Tab 没有附加配置项。</span>
          </template>
        </section>
      </div>
    </section>
  </article>
</template>
