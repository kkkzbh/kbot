import { ref, reactive, computed } from 'vue'
import { send } from '@koishijs/client'
import type {
  BotConsoleBuiltinModelTab,
  BotConsoleMemoryMutationResponse,
  BotConsoleMemoryState,
  BotConsoleModelTabId,
  BotConsoleModelTabsState,
  BotConsoleToolPolicyState,
  BotConsoleState,
  BotConsoleTtsStyleId,
  BotConsoleTtsState,
  AffinitySettings,
  AffinityWhitelistInput,
  AdjustAffinityUserResponse,
  ClearConversationHistoryResponse,
  ConversationTarget,
  DeleteConversationRoomResponse,
  DeepSeekModelListRequest,
  DeepSeekModelListResponse,
  MimoModelListRequest,
  MimoModelListResponse,
  FeatureOverrideInput,
  FeatureScopeKind,
  GetMemoryStateResponse,
  PresetDocument,
  PresetPrompt,
  ReorderPresetsResponse,
  SaveEnvResponse,
  SaveAffinitySettingsResponse,
  SaveAffinityWhitelistResponse,
  SaveFeatureOverridesResponse,
  SaveModelTabsRequest,
  SaveModelTabsResponse,
  SavePresetResponse,
  SaveTtsSettingsResponse,
  SaveToolOverridesResponse,
  ServiceActionResponse,
  ProbeTtsHealthResponse,
  SynthesizeTtsSampleResponse,
  BotConsoleProbeResponse,
  CopilotAuthAttempt,
  CopilotAuthCancelResponse,
  CopilotAuthLogoutResponse,
  CopilotAuthPollResponse,
  CopilotAuthStartResponse,
  CopilotAuthStatusResponse,
  CopilotModelListResponse,
  CodexAuthAttempt,
  CodexAuthCancelResponse,
  CodexAuthLogoutResponse,
  CodexAuthPollResponse,
  CodexAuthStartResponse,
  CodexAuthStatusResponse,
  CodexModelListResponse,
  ScopedFeatureKey,
  ToolCatalogEntry,
  ToolPolicyOverrideInput,
  ToolOverrideMode,
  ToolPolicyScope,
  ToolRouteProfile,
  MemoryRecordType,
  MemoryVisibility,
} from '../types'
import {
  buildToolOverrideKey,
  buildToolScopeKey,
  denormalizeToolOverrideMode,
  getToolRouteLabel,
  getToolScopeLabel,
  normalizeToolOverrideMode,
  TOOL_CATALOG,
  TOOL_GLOBAL_DEFAULT_SCOPE_ID,
  TOOL_PRIVATE_DEFAULT_SCOPE_ID,
  TOOL_ROUTE_PROFILES,
} from './toolPolicy'
import {
  BUILTIN_MAIN_CHAT_TAB_UI_SCHEMA as SHARED_BUILTIN_MAIN_CHAT_TAB_UI_SCHEMA,
  CODEX_BRIDGE_DEFAULT_BASE_URL as SHARED_CODEX_BRIDGE_DEFAULT_BASE_URL,
  CODEX_DEFAULT_MODEL as SHARED_CODEX_DEFAULT_MODEL,
  CODEX_DEFAULT_REASONING_EFFORT as SHARED_CODEX_DEFAULT_REASONING_EFFORT,
  CODEX_MODEL_OPTIONS as SHARED_CODEX_MODEL_OPTIONS,
  CODEX_REASONING_EFFORT_OPTIONS as SHARED_CODEX_REASONING_EFFORT_OPTIONS,
  COPILOT_DEFAULT_MODEL as SHARED_COPILOT_DEFAULT_MODEL,
  COPILOT_MODEL_OPTIONS as SHARED_COPILOT_MODEL_OPTIONS,
  DEEPSEEK_DEFAULT_BASE_URL as SHARED_DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL as SHARED_DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_OFFICIAL_MODEL_OPTIONS as SHARED_DEEPSEEK_MODEL_OPTIONS,
  MIMO_CHAT_MODEL_OPTIONS as SHARED_MIMO_MODEL_OPTIONS,
  MIMO_DEFAULT_BASE_URL as SHARED_MIMO_DEFAULT_BASE_URL,
  MIMO_DEFAULT_MODEL as SHARED_MIMO_DEFAULT_MODEL,
  formatDeepSeekModelOptionLabel as formatSharedDeepSeekModelOptionLabel,
  formatCopilotModelOptionLabel as formatSharedCopilotModelOptionLabel,
  getCopilotModelOption,
  validateMainChatTabModel as sharedValidateMainChatTabModel,
} from '../../../shared/llm/main-chat-tabs'
import type { BuiltinTabUiSchema, MainChatModelValidationResult } from '../../../shared/llm/main-chat-tabs'

// ─── Env key groups ───────────────────────────────────────────────────────────

export const FEATURE_KEYS = [
  'QQBOT_REALTIME_MESSAGE_ENABLED',
  'QQ_VOICE_INPUT_ENABLED',
  'QQ_VOICE_OUTPUT_ENABLED',
  'CHAT_NATURAL_TRIGGER_ENABLED',
  'QQBOT_REPLY_INTERRUPT_ENABLED',
] as const

export const FEATURE_TEXT_KEYS = [
  'CHAT_NATURAL_TRIGGER_GROUPS',
] as const

export const FEATURE_NUMBER_KEYS = [
  'QQBOT_REALTIME_MESSAGE_MAX_INJECT_COUNT',
] as const

export const FEATURE_ENV_KEYS = [
  ...FEATURE_KEYS,
  ...FEATURE_TEXT_KEYS,
  ...FEATURE_NUMBER_KEYS,
] as const

export const TTS_BOT_ENV_KEYS = [
  'QQ_VOICE_OUTPUT_ENABLED',
  'QQ_VOICE_TTS_BASE_URL',
  'QQ_VOICE_TTS_API_KEY',
  'QQ_VOICE_OUTPUT_LANGUAGE',
  'QQ_VOICE_OUTPUT_MAX_WORDS',
  'QQ_VOICE_OUTPUT_MAX_SECONDS',
  'QQ_VOICE_SYNTH_TIMEOUT_MS',
] as const

export const TTS_LOCAL_ENV_KEYS = [
  'VOICE_TTS_HOST',
  'VOICE_TTS_PORT',
  'VOICE_TTS_API_KEY',
  'VOICE_TTS_DEVICE',
  'VOICE_TTS_IS_HALF',
  'VOICE_TTS_VERSION',
  'VOICE_TTS_INTERNAL_HOST',
  'VOICE_TTS_INTERNAL_PORT',
  'VOICE_TTS_LAUNCH_TIMEOUT_SECONDS',
  'VOICE_TTS_REQUEST_TIMEOUT_SECONDS',
  'VOICE_TTS_MAX_TEXT_CHARS',
  'VOICE_TTS_UPSTREAM_ROOT',
  'VOICE_TTS_PRETRAINED_ROOT',
  'VOICE_TTS_MODEL_ROOT',
  'VOICE_TTS_REFERENCE_ROOT',
  'VOICE_TTS_GPT_WEIGHTS',
  'VOICE_TTS_SOVITS_WEIGHTS',
  'VOICE_TTS_BERT_BASE',
  'VOICE_TTS_HUBERT_BASE',
  'VOICE_TTS_REF_WHITE',
  'VOICE_TTS_REF_BLACK',
  'VOICE_TTS_PROMPT_TEXT_WHITE',
  'VOICE_TTS_PROMPT_TEXT_BLACK',
  'VOICE_TTS_PROMPT_LANG',
  'VOICE_TTS_PROMPT_LANG_WHITE',
  'VOICE_TTS_PROMPT_LANG_BLACK',
  'VOICE_TTS_TEXT_LANG',
  'VOICE_TTS_MEDIA_TYPE',
  'VOICE_TTS_SPLIT_METHOD',
  'VOICE_TTS_BATCH_SIZE',
  'VOICE_TTS_PARALLEL_INFER',
] as const

export const FILE_SYSTEM_CONTROL_KEYS = [
  'CHATLUNA_COMMON_FS',
  'CHATLUNA_COMMON_FS_SCOPE_PATH',
  'CHATLUNA_COMMON_FS_ALLOWED_GROUPS',
] as const

export const HBU_JW_ENV_KEYS = [
  'HBU_JW_ALLOWED_GROUPS',
  'HBU_JW_PUBLIC_BASE_URL',
  'HBU_JW_BIND_PAGE_PATH',
  'HBU_JW_BIND_TOKEN_TTL_MS',
  'HBU_JW_CREDENTIAL_KEK_PATH',
  'HBU_JW_AUTO_RELOGIN_ENABLED',
  'HBU_JW_KEEP_ALIVE_ENABLED',
  'HBU_JW_KEEP_ALIVE_INTERVAL_MS',
  'HBU_JW_KEEP_ALIVE_RECENT_USE_WINDOW_MS',
] as const

export const CAMPUS_AUTH_ENV_KEYS = [
  'CAMPUS_AUTH_PUBLIC_BASE_URL',
  'CAMPUS_AUTH_BIND_PAGE_PATH',
  'CAMPUS_AUTH_BIND_TOKEN_TTL_MS',
  'CAMPUS_AUTH_CREDENTIAL_KEK_PATH',
  'CAMPUS_AUTH_MAX_BINDING_ATTEMPTS',
] as const

export const ZYH_ENV_KEYS = [
  ...CAMPUS_AUTH_ENV_KEYS,
  'ZYH_ALLOWED_GROUPS',
  'ZYH_NATURAL_TRIGGER_ENABLED',
  'ZYH_NATURAL_TRIGGER_GROUPS',
] as const

export const HBU_SECOND_CLASS_ENV_KEYS = [
  ...CAMPUS_AUTH_ENV_KEYS,
  'HBU_SECOND_CLASS_ALLOWED_GROUPS',
  'HBU_SECOND_CLASS_NATURAL_TRIGGER_ENABLED',
  'HBU_SECOND_CLASS_NATURAL_TRIGGER_GROUPS',
] as const

export const CHAOXING_ENV_KEYS = [
  'CHAOXING_ALLOWED_GROUPS',
  'CHAOXING_PUBLIC_BASE_URL',
  'CHAOXING_BIND_PAGE_PATH',
  'CHAOXING_BIND_TOKEN_TTL_MS',
  'CHAOXING_CREDENTIAL_KEK_PATH',
  'CHAOXING_AUTO_RELOGIN_ENABLED',
  'CHAOXING_SESSION_VALIDATION_TTL_MS',
  'CHAOXING_REQUEST_INTERVAL_MS',
  'CHAOXING_WORKER_POLL_INTERVAL_MS',
  'CHAOXING_SIGN_WATCH_INTERVAL_MS',
  'CHAOXING_DEADLINE_SYNC_INTERVAL_MS',
  'CHAOXING_DEADLINE_REMINDER_LEAD_MS',
  'CHAOXING_STUDY_PLAYBACK_RATE',
  'CHAOXING_VIDEO_REPORT_INTERVAL_MS',
  'CHAOXING_ANSWER_PROVIDER_URL',
  'CHAOXING_ANSWER_PROVIDER_API_KEY',
  'CHAOXING_ANSWER_PROVIDER_TIMEOUT_MS',
] as const

export const GENSHIN_ENV_KEYS = [
  'GENSHIN_ALLOWED_GROUPS',
  'GENSHIN_PUBLIC_BASE_URL',
  'GENSHIN_BIND_PAGE_PATH',
  'GENSHIN_BIND_TOKEN_TTL_MS',
  'GENSHIN_CREDENTIAL_KEK_PATH',
  'GENSHIN_AUTO_SIGN_ENABLED',
  'GENSHIN_AUTO_SIGN_CRON',
  'GENSHIN_TIMEZONE',
  'GENSHIN_TAKUMI_APP_VERSION',
  'GENSHIN_SIGN_ACT_ID',
  'GENSHIN_REDEEM_GAME_VERSION',
] as const

export const PRIVATE_DEFAULT_SCOPE_ID = 'private-default'
export const PRIVATE_UNSUPPORTED_FEATURE_KEYS = ['CHAT_NATURAL_TRIGGER_ENABLED', 'QQBOT_REALTIME_MESSAGE_ENABLED'] as const

export const PRESET_SCOPE_KEYS = ['CHATLUNA_DEFAULT_PRESET'] as const

export const MODEL_TAB_IDS = ['siliconflow', 'openai', 'codex', 'copilot', 'deepseek', 'mimo'] as const satisfies readonly BotConsoleModelTabId[]
export const SILICONFLOW_FIXED_BASE_URL = 'https://api.siliconflow.cn/v1'
export const SILICONFLOW_FIXED_MODEL = 'Pro/moonshotai/Kimi-K2.5'
export const CODEX_BRIDGE_DEFAULT_BASE_URL = SHARED_CODEX_BRIDGE_DEFAULT_BASE_URL
export const CODEX_DEFAULT_MODEL = SHARED_CODEX_DEFAULT_MODEL
export const CODEX_DEFAULT_REASONING_EFFORT = SHARED_CODEX_DEFAULT_REASONING_EFFORT
export const COPILOT_DEFAULT_MODEL = SHARED_COPILOT_DEFAULT_MODEL
export const CODEX_MODEL_OPTIONS = SHARED_CODEX_MODEL_OPTIONS
export const CODEX_REASONING_EFFORT_OPTIONS = SHARED_CODEX_REASONING_EFFORT_OPTIONS
export const DEEPSEEK_DEFAULT_BASE_URL = SHARED_DEEPSEEK_DEFAULT_BASE_URL
export const DEEPSEEK_DEFAULT_MODEL = SHARED_DEEPSEEK_DEFAULT_MODEL
export const MIMO_DEFAULT_BASE_URL = SHARED_MIMO_DEFAULT_BASE_URL
export const MIMO_DEFAULT_MODEL = SHARED_MIMO_DEFAULT_MODEL
export const COPILOT_MODEL_OPTIONS = SHARED_COPILOT_MODEL_OPTIONS
export const DEEPSEEK_MODEL_OPTIONS = SHARED_DEEPSEEK_MODEL_OPTIONS
export const MIMO_MODEL_OPTIONS = SHARED_MIMO_MODEL_OPTIONS
export const BUILTIN_MAIN_CHAT_TAB_UI_SCHEMA = SHARED_BUILTIN_MAIN_CHAT_TAB_UI_SCHEMA
export const formatCopilotModelOptionLabel = formatSharedCopilotModelOptionLabel
export const formatDeepSeekModelOptionLabel = formatSharedDeepSeekModelOptionLabel
export const validateMainChatTabModel = sharedValidateMainChatTabModel
export type { BuiltinTabUiSchema, MainChatModelValidationResult }

export const BASIC_KEYS = [
  'CHAT_NATURAL_TRIGGER_ALIASES',
  'CHATLUNA_COMMAND_AUTHORITY',
  'CHATLUNA_MAX_CONTEXT_RATIO',
] as const

export const MEMORY_KEYS = [
  'MEMORY_ENABLED',
  'MEMORY_READ_ENABLED',
  'MEMORY_WRITE_ENABLED',
  'MEMORY_EXTRACT_BASE_URL',
  'MEMORY_EXTRACT_API_KEY',
  'MEMORY_EXTRACT_MODEL',
  'MEMORY_EXTRACT_TIMEOUT_MS',
  'MEMORY_EXTRACT_REQUEST_MODE',
  'MEMORY_EXTRACT_STRUCTURED_OUTPUT_PROTOCOL',
  'MEMORY_EXTRACT_SUPPORTS_JSON_MODE',
  'MEMORY_EMBED_BASE_URL',
  'MEMORY_EMBED_API_KEY',
  'MEMORY_EMBED_MODEL',
  'MEMORY_EMBED_TIMEOUT_MS',
  'MEMORY_QUERY_TOPK',
  'MEMORY_PROMPT_BUDGET_TOKENS',
  'MEMORY_EMBED_BATCH_SIZE',
  'MEMORY_EXTRACT_IDLE_MS',
  'MEMORY_EXTRACT_MESSAGE_BATCH',
  'MEMORY_ARCHIVE_DAYS',
  'MEMORY_MAX_JOB_RETRIES',
  'MEMORY_JOB_LOCK_TIMEOUT_MS',
] as const

export const ALL_ENV_KEYS = [
  ...FEATURE_ENV_KEYS,
  ...TTS_BOT_ENV_KEYS,
  ...FILE_SYSTEM_CONTROL_KEYS,
  ...HBU_JW_ENV_KEYS,
  ...ZYH_ENV_KEYS,
  ...HBU_SECOND_CLASS_ENV_KEYS,
  ...CHAOXING_ENV_KEYS,
  ...GENSHIN_ENV_KEYS,
  ...PRESET_SCOPE_KEYS,
  ...BASIC_KEYS,
  ...MEMORY_KEYS,
] as const
const BOT_RUNTIME_UNIT = 'qqbot-koishi.service'

// ─── Exported helpers ─────────────────────────────────────────────────────────

/**
 * Treats any string value other than the literal string "false" (case-insensitive)
 * as true. Used for boolean env vars stored as strings.
 */
export function normalizeBoolean(v: string | undefined): boolean {
  return String(v ?? '').toLowerCase() !== 'false'
}

export function createEmptyPreset(): PresetDocument {
  return {
    name: '',
    originalName: '',
    source: 'runtime',
    keywords: [],
    prompts: [{ role: 'system', content: '' }],
  }
}

export type FeatureOverrideMode = 'inherit' | 'enabled' | 'disabled'

// ─── Internal helpers ─────────────────────────────────────────────────────────

function clonePreset(p: PresetDocument): PresetDocument {
  return {
    name: p.name,
    originalName: p.originalName ?? p.name,
    path: p.path,
    source: p.source ?? 'runtime',
    keywords: [...p.keywords],
    prompts: p.prompts.map(x => ({ role: x.role, content: x.content })),
  }
}

function createEmptyBuiltinModelTab(id: BotConsoleModelTabId): BotConsoleBuiltinModelTab {
  const copilotDefaultOption = getCopilotModelOption(COPILOT_DEFAULT_MODEL)
  const tabMeta: Record<BotConsoleModelTabId, Omit<BotConsoleBuiltinModelTab, 'id' | 'baseUrl' | 'apiKey' | 'defaultModel'>> = {
    siliconflow: {
      title: '硅基流动',
      provider: 'siliconflow',
      strategyId: 'siliconflow-kimi-main-chat',
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'native_chat_json_schema',
      description: '当前主聊天固定走硅基流动 provider，接口地址锁定为官方 API，默认使用 Kimi-K2.5。',
      modelHint: '当前仅支持 Pro/moonshotai/Kimi-K2.5。',
      authKind: 'manual',
      authStatus: 'ready',
      accountLabel: null,
      authError: null,
    },
    openai: {
      title: 'OpenAI',
      provider: 'openai',
      strategyId: 'openai-gpt54-main-chat',
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'native_chat_json_schema',
      description: '当前按 OpenAI 兼容 provider 处理，默认预填 wyzai + gpt-5.4-medium-thinking，并走 chat/completions 结构化输出。',
      modelHint: '推荐填写 openai/gpt-5.4-medium-thinking。当前 OpenAI Tab 默认接入 wyzai。',
      authKind: 'manual',
      authStatus: 'ready',
      accountLabel: null,
      authError: null,
    },
    codex: {
      title: 'Codex',
      provider: 'openai',
      strategyId: 'codex-chatgpt-oauth-main-chat',
      requestMode: 'responses',
      structuredOutputProtocol: 'native_responses_json_schema',
      description: '当前由机器人维护独立 Codex OAuth，运行时通过本地 bridge 注入 OAuth token，并固定走 Responses API + native_responses_json_schema。',
      modelHint: '当前从 Codex 可见 API 模型列表选择；只支持 Responses API，不会回退到 chat/completions。',
      authKind: 'codex_oauth',
      authStatus: 'unauthenticated',
      accountLabel: null,
      authError: null,
      tokenExpiresAt: null,
    },
    copilot: {
      title: 'GitHub Copilot',
      provider: 'openai',
      strategyId: 'copilot-github-oauth-main-chat',
      requestMode: copilotDefaultOption?.requestMode ?? 'responses',
      structuredOutputProtocol: copilotDefaultOption?.structuredOutputProtocol ?? 'native_responses_json_schema',
      description: `当前按 GitHub Copilot OAuth 设备登录接入，运行时通过本地 bridge 使用 ${copilotDefaultOption ? formatSharedCopilotModelOptionLabel(copilotDefaultOption) : 'Copilot Auto'}。`,
      modelHint: copilotDefaultOption
        ? `当前选择 ${formatSharedCopilotModelOptionLabel(copilotDefaultOption)}，具体模型由 Copilot Auto session 决定。`
        : '当前选择 Copilot Auto，具体模型由 Copilot Auto session 决定。',
      authKind: 'oauth_device',
      authStatus: 'unauthenticated',
      accountLabel: null,
      authError: null,
    },
    deepseek: {
      title: 'DeepSeek',
      provider: 'deepseek',
      strategyId: 'deepseek-official-main-chat',
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'chat_reply_v1',
      description: '当前按 DeepSeek 官方 OpenAI 兼容接口接入，走 chat/completions + CHAT_REPLY_V1 纯文本结构化协议。',
      modelHint: '当前固定从 DeepSeek 官方模型列表选择，发给 provider 的模型 ID 保持官方原始字符串；输出走纯文本协议。',
      authKind: 'manual',
      authStatus: 'ready',
      accountLabel: null,
      authError: null,
    },
    mimo: {
      title: 'MIMO',
      provider: 'mimo',
      strategyId: 'mimo-official-main-chat',
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'native_chat_json_schema',
      description: '当前按 Xiaomi MIMO Token Plan 的 OpenAI 兼容 chat/completions 接口接入，聊天模型限定为已验证列表。',
      modelHint: '仅支持已验证可走 chat/completions 的 MIMO 模型；TTS 模型不会出现在此列表。',
      authKind: 'manual',
      authStatus: 'ready',
      accountLabel: null,
      authError: null,
    },
  }

  return {
    id,
    ...tabMeta[id],
    baseUrl: id === 'siliconflow'
      ? SILICONFLOW_FIXED_BASE_URL
      : id === 'codex'
        ? CODEX_BRIDGE_DEFAULT_BASE_URL
      : id === 'deepseek'
        ? DEEPSEEK_DEFAULT_BASE_URL
        : id === 'mimo'
          ? MIMO_DEFAULT_BASE_URL
          : '',
    apiKey: '',
    defaultModel: id === 'siliconflow' ? SILICONFLOW_FIXED_MODEL : id === 'codex' ? CODEX_DEFAULT_MODEL : id === 'deepseek' ? DEEPSEEK_DEFAULT_MODEL : id === 'mimo' ? MIMO_DEFAULT_MODEL : '',
    reasoningEffort: id === 'codex' ? CODEX_DEFAULT_REASONING_EFFORT : null,
    canonicalModel: id === 'siliconflow' ? SILICONFLOW_FIXED_MODEL : id === 'codex' ? CODEX_DEFAULT_MODEL : id === 'deepseek' ? `deepseek/${DEEPSEEK_DEFAULT_MODEL}` : id === 'mimo' ? `mimo/${MIMO_DEFAULT_MODEL}` : '',
    transportModel: id === 'siliconflow' ? SILICONFLOW_FIXED_MODEL : id === 'codex' ? CODEX_DEFAULT_MODEL.replace(/^openai\//, '') : id === 'deepseek' ? DEEPSEEK_DEFAULT_MODEL : id === 'mimo' ? MIMO_DEFAULT_MODEL : '',
  }
}

function buildModelTabsState(state: BotConsoleState | null): BotConsoleModelTabsState {
  const fallbackTabs = MODEL_TAB_IDS.map(id => createEmptyBuiltinModelTab(id))
  const tabs = MODEL_TAB_IDS.map(id => {
    const found = state?.modelTabs?.tabs?.find(tab => tab.id === id)
    return found ? { ...found } : createEmptyBuiltinModelTab(id)
  })
  const activeTab = state?.modelTabs?.activeTab
  return {
    activeTab: MODEL_TAB_IDS.includes(activeTab as BotConsoleModelTabId) ? activeTab as BotConsoleModelTabId : 'siliconflow',
    tabs: tabs.length > 0 ? tabs : fallbackTabs,
  }
}

function serializeModelTabsState(state: BotConsoleModelTabsState): string {
  return JSON.stringify({
    activeTab: state.activeTab,
    tabs: MODEL_TAB_IDS.map(id => {
      const tab = state.tabs.find(item => item.id === id) ?? createEmptyBuiltinModelTab(id)
      return {
        id: tab.id,
        provider: tab.provider,
        strategyId: tab.strategyId,
        requestMode: tab.requestMode,
        structuredOutputProtocol: tab.structuredOutputProtocol,
        baseUrl: tab.baseUrl,
        apiKey: tab.apiKey,
        defaultModel: tab.defaultModel,
        reasoningEffort: tab.reasoningEffort ?? null,
        canonicalModel: tab.canonicalModel,
        transportModel: tab.transportModel,
      }
    }),
  })
}

function buildFeatureOverrideKey(scopeKind: FeatureScopeKind, scopeId: string, featureKey: ScopedFeatureKey): string {
  return `${scopeKind}:${scopeId}:${featureKey}`
}

function normalizeOverrideMode(enabled: number | boolean | null | undefined): FeatureOverrideMode {
  if (enabled == null) return 'inherit'
  return Number(enabled) === 1 || enabled === true ? 'enabled' : 'disabled'
}

function denormalizeOverrideMode(mode: FeatureOverrideMode): boolean | null {
  if (mode === 'inherit') return null
  return mode === 'enabled'
}

function isPrivateUnsupportedFeatureKey(featureKey: string): boolean {
  return (PRIVATE_UNSUPPORTED_FEATURE_KEYS as readonly string[]).includes(featureKey)
}

function buildToolScopeMap(state: BotConsoleState | null): ToolPolicyScope[] {
  const scopes = new Map<string, ToolPolicyScope>()

  const addScope = (scope: ToolPolicyScope) => {
    scopes.set(buildToolScopeKey(scope), scope)
  }

  addScope({
    scopeKind: 'global_default',
    scopeId: TOOL_GLOBAL_DEFAULT_SCOPE_ID,
    roomId: null,
    roomName: '全局默认',
    groupId: null,
    conversationId: null,
    visibility: null,
    updatedAt: null,
  })

  addScope({
    scopeKind: 'private_default',
    scopeId: TOOL_PRIVATE_DEFAULT_SCOPE_ID,
    roomId: null,
    roomName: '所有私聊',
    groupId: null,
    conversationId: null,
    visibility: 'private',
    updatedAt: null,
  })

  for (const scope of state?.toolPolicy?.scopes ?? []) {
    addScope(scope)
  }

  for (const scope of state?.featureScopes ?? []) {
    if (scope.scopeKind !== 'group') continue
    addScope({
      scopeKind: 'group',
      scopeId: scope.scopeId,
      roomId: scope.roomId,
      roomName: scope.roomName,
      groupId: scope.groupId,
      conversationId: scope.conversationId,
      visibility: scope.visibility,
      updatedAt: scope.updatedAt,
    })
  }

  for (const target of state?.conversationTargets ?? []) {
    if (target.scopeKind !== 'private') continue
    addScope({
      scopeKind: 'private_conversation',
      scopeId: String(target.roomId),
      roomId: target.roomId,
      roomName: target.roomName,
      groupId: target.groupId,
      conversationId: target.conversationId,
      visibility: 'private',
      updatedAt: target.updatedAt,
    })
  }

  return [...scopes.values()].sort((left, right) => {
    const order = toolScopeSortRank(left) - toolScopeSortRank(right)
    if (order !== 0) return order
    const timeDelta = (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    if (timeDelta !== 0) return timeDelta
    return left.scopeId.localeCompare(right.scopeId, 'zh-CN')
  })
}

function toolScopeSortRank(scope: ToolPolicyScope): number {
  switch (scope.scopeKind) {
    case 'global_default':
      return 0
    case 'private_default':
      return 1
    case 'group':
      return 2
    case 'private_conversation':
      return 3
    default:
      return 9
  }
}

function buildToolCatalog(state: BotConsoleState | null): ToolCatalogEntry[] {
  const catalog = state?.toolPolicy?.catalog ?? TOOL_CATALOG
  return [...catalog].sort((left, right) => {
    if ((left.registered ?? true) !== (right.registered ?? true)) {
      return (left.registered ?? true) ? -1 : 1
    }
    const categoryDelta = left.category.localeCompare(right.category, 'zh-CN')
    if (categoryDelta !== 0) return categoryDelta
    return left.title.localeCompare(right.title, 'zh-CN')
  })
}

function buildToolRouteProfiles(state: BotConsoleState | null): ToolRouteProfile[] {
  const routes = state?.toolPolicy?.routeProfiles?.length ? state.toolPolicy.routeProfiles : [...TOOL_ROUTE_PROFILES]
  return [...new Set(routes)]
}

function buildToolOverrideMap(state: BotConsoleState | null): Record<string, ToolOverrideMode> {
  const next: Record<string, ToolOverrideMode> = {}
  for (const item of state?.toolPolicy?.overrides ?? []) {
    next[buildToolOverrideKey(item.scopeKind, item.scopeId, item.routeProfile, item.toolName)] = normalizeToolOverrideMode(item.enabled)
  }
  return next
}

function resolveToolOverrideKey(scope: ToolPolicyScope, routeProfile: ToolRouteProfile, toolName: string): string {
  return buildToolOverrideKey(scope.scopeKind, scope.scopeId, routeProfile, toolName)
}

// ─── Composable ───────────────────────────────────────────────────────────────

export function useBotConsole() {
  // ── Core state ──────────────────────────────────────────────────────────────
  const loading = ref(true)
  const botState = ref<BotConsoleState | null>(null)
  const memoryState = ref<BotConsoleMemoryState | null>(null)
  const memoryLoading = ref(false)

  /**
   * Live-editable env values. Keyed by env var name.
   * Always mutated in-place so reactive consumers stay connected.
   */
  const envDraft = reactive<Record<string, string>>({})

  /** Last successfully saved / loaded env values. Used to compute changedKeys. */
  const originalEnv = ref<Record<string, string>>({})

  /** Live-editable laptop-local TTS gateway env values. */
  const ttsEnvDraft = reactive<Record<string, string>>({})

  /** Last successfully saved / loaded TTS gateway env values. */
  const originalTtsEnv = ref<Record<string, string>>({})

  /** The preset currently open in the editor. */
  const currentPreset = ref<PresetDocument>(createEmptyPreset())

  /** Fixed built-in model tabs for the main ChatLuna chain. */
	  const modelTabsDraft = reactive<Record<BotConsoleModelTabId, BotConsoleBuiltinModelTab>>({
	    siliconflow: createEmptyBuiltinModelTab('siliconflow'),
	    openai: createEmptyBuiltinModelTab('openai'),
	    codex: createEmptyBuiltinModelTab('codex'),
	    copilot: createEmptyBuiltinModelTab('copilot'),
	    deepseek: createEmptyBuiltinModelTab('deepseek'),
	    mimo: createEmptyBuiltinModelTab('mimo'),
	  })

  /** Active built-in model tab currently being edited. */
  const activeModelTab = ref<BotConsoleModelTabId>('siliconflow')

  /** Last successfully loaded model tabs state. */
  const originalModelTabs = ref<BotConsoleModelTabsState>(buildModelTabsState(null))
  const copilotAuthAttempt = ref<CopilotAuthAttempt | null>(null)
  const codexAuthAttempt = ref<CodexAuthAttempt | null>(null)

  /** True while an embedding probe request is in-flight. */
  const probePending = ref(false)

  /** Live-editable scoped feature overrides keyed by `${scopeKind}:${scopeId}:${featureKey}`. */
  const featureOverrideDraft = reactive<Record<string, FeatureOverrideMode>>({})

  /** Last successfully loaded scoped feature overrides. */
  const originalFeatureOverrides = ref<Record<string, FeatureOverrideMode>>({})

  /** Tracks in-flight conversation clear requests keyed by conversationId. */
  const conversationPending = reactive<Record<string, boolean>>({})

  /** Tracks in-flight room delete requests keyed by conversationId. */
  const conversationDeletePending = reactive<Record<string, boolean>>({})

  /**
   * Tracks in-flight service actions keyed by unit name.
   * Value is the action string (e.g. 'restart') while pending, null otherwise.
   */
  const servicePending = reactive<Record<string, string | null>>({})

  /** Currently edited tool route profile. */
  const toolRouteProfile = ref<ToolRouteProfile>('agent')

  /** Currently selected tool policy scope. */
  const selectedToolScopeKey = ref<string>(
    buildToolScopeKey({
      scopeKind: 'global_default',
      scopeId: TOOL_GLOBAL_DEFAULT_SCOPE_ID,
    }),
  )

  /** Live-editable tool overrides keyed by `${route}:${scopeKind}:${scopeId}:${toolName}`. */
  const toolOverrideDraft = reactive<Record<string, ToolOverrideMode>>({})

  /** Last successfully loaded tool overrides. */
  const originalToolOverrides = ref<Record<string, ToolOverrideMode>>({})

  /** True while every pending settings domain is being saved before a restart. */
  const savingAllSettings = ref(false)

  // ── Computed ─────────────────────────────────────────────────────────────────

  /** Set of env keys whose current draft value differs from the last saved value. */
  const changedKeys = computed<Set<string>>(() => {
    const keys = new Set<string>()
    for (const key of ALL_ENV_KEYS) {
      if ((envDraft[key] ?? '') !== (originalEnv.value[key] ?? '')) {
        keys.add(key)
      }
    }
    return keys
  })

  const canSaveEnv = computed(() => changedKeys.value.size > 0)

  const changedTtsEnvKeys = computed<Set<string>>(() => {
    const keys = new Set<string>()
    for (const key of TTS_LOCAL_ENV_KEYS) {
      if ((ttsEnvDraft[key] ?? '') !== (originalTtsEnv.value[key] ?? '')) {
        keys.add(key)
      }
    }
    return keys
  })

  const changedTtsBotEnvKeys = computed<Set<string>>(() => {
    const keys = new Set<string>()
    for (const key of TTS_BOT_ENV_KEYS) {
      if (changedKeys.value.has(key)) keys.add(key)
    }
    return keys
  })

  const canSaveTtsSettings = computed(() => changedTtsBotEnvKeys.value.size > 0 || changedTtsEnvKeys.value.size > 0)

  const changedHbuJwEnvKeys = computed<Set<string>>(() => {
    const keys = new Set<string>()
    for (const key of HBU_JW_ENV_KEYS) {
      if (changedKeys.value.has(key)) keys.add(key)
    }
    return keys
  })

  const canSaveHbuJwSettings = computed(() => changedHbuJwEnvKeys.value.size > 0)

  const changedGenshinEnvKeys = computed<Set<string>>(() => {
    const keys = new Set<string>()
    for (const key of GENSHIN_ENV_KEYS) {
      if (changedKeys.value.has(key)) keys.add(key)
    }
    return keys
  })

  const canSaveGenshinSettings = computed(() => changedGenshinEnvKeys.value.size > 0)

  const dirtyModelTabIds = computed<BotConsoleModelTabId[]>(() => {
    const dirty: BotConsoleModelTabId[] = []
    const originalById = new Map<BotConsoleModelTabId, BotConsoleBuiltinModelTab>()
    for (const tab of originalModelTabs.value.tabs) originalById.set(tab.id, tab)
    for (const id of MODEL_TAB_IDS) {
      const draft = modelTabsDraft[id]
      const original = originalById.get(id)
      if (!original) {
        dirty.push(id)
        continue
      }
      if (
        draft.baseUrl !== original.baseUrl ||
        draft.apiKey !== original.apiKey ||
        draft.defaultModel !== original.defaultModel ||
        (draft.reasoningEffort ?? null) !== (original.reasoningEffort ?? null)
      ) {
        dirty.push(id)
      }
    }
    return dirty
  })

  const modelTabsChanged = computed<boolean>(() => {
    if (activeModelTab.value !== originalModelTabs.value.activeTab) return true
    return dirtyModelTabIds.value.length > 0
  })

  const currentModelValidation = computed<MainChatModelValidationResult>(() => {
    const draft = modelTabsDraft[activeModelTab.value]
    return validateMainChatTabModel(activeModelTab.value, draft.defaultModel)
  })

  const canSaveModelSettings = computed(() => modelTabsChanged.value && currentModelValidation.value.ok)

  const changedFeatureOverrideKeys = computed<Set<string>>(() => {
    const keys = new Set<string>()
    const allKeys = new Set([
      ...Object.keys(featureOverrideDraft),
      ...Object.keys(originalFeatureOverrides.value),
    ])
    for (const key of allKeys) {
      if ((featureOverrideDraft[key] ?? 'inherit') !== (originalFeatureOverrides.value[key] ?? 'inherit')) {
        keys.add(key)
      }
    }
    return keys
  })

  const changedFeatureEnvKeys = computed<Set<string>>(() => {
    const keys = new Set<string>()
    for (const key of FEATURE_ENV_KEYS) {
      if (changedKeys.value.has(key)) keys.add(key)
    }
    return keys
  })

  const canSaveFeatureOverrides = computed(() => changedFeatureOverrideKeys.value.size > 0)
  const canSaveFeatureSettings = computed(() => changedFeatureEnvKeys.value.size > 0 || canSaveFeatureOverrides.value)

  const toolPolicyScopes = computed<ToolPolicyScope[]>(() => buildToolScopeMap(botState.value))
  const toolPolicyCatalog = computed<ToolCatalogEntry[]>(() => buildToolCatalog(botState.value))
  const toolPolicyRouteProfiles = computed<ToolRouteProfile[]>(() => buildToolRouteProfiles(botState.value))

  const changedToolOverrideKeys = computed<Set<string>>(() => {
    const keys = new Set<string>()
    const allKeys = new Set([
      ...Object.keys(toolOverrideDraft),
      ...Object.keys(originalToolOverrides.value),
    ])
    for (const key of allKeys) {
      if ((toolOverrideDraft[key] ?? 'inherit') !== (originalToolOverrides.value[key] ?? 'inherit')) {
        keys.add(key)
      }
    }
    return keys
  })

  const canSaveToolPolicyOverrides = computed(() => changedToolOverrideKeys.value.size > 0)
  const canSaveToolPolicySettings = computed(() => canSaveToolPolicyOverrides.value)

  const pendingSettingsCount = computed(() => {
    const activeModelTabChanged = activeModelTab.value !== originalModelTabs.value.activeTab
    return changedKeys.value.size
      + changedTtsEnvKeys.value.size
      + dirtyModelTabIds.value.length
      + (activeModelTabChanged ? 1 : 0)
      + changedFeatureOverrideKeys.value.size
      + changedToolOverrideKeys.value.size
  })

  const canSaveAllSettings = computed(() => pendingSettingsCount.value > 0 && !savingAllSettings.value)

  const canSavePreset = computed(() => {
    const p = currentPreset.value
    return (
      p.name.trim().length > 0 &&
      p.prompts.some((x: PresetPrompt) => x.content.trim().length > 0)
    )
  })

  const defaultPreset = computed(() => botState.value?.defaultPreset ?? 'sakiko')

  const selectedToolScope = computed<ToolPolicyScope | null>(() => {
    const current = toolPolicyScopes.value.find(scope => buildToolScopeKey(scope) === selectedToolScopeKey.value)
    return current ?? toolPolicyScopes.value[0] ?? null
  })

  const selectedToolScopeLabel = computed(() => {
    const scope = selectedToolScope.value
    return scope ? getToolScopeLabel(scope) : '未选择'
  })

  const selectedToolRouteLabel = computed(() => getToolRouteLabel(toolRouteProfile.value))

  const currentModelTabDraft = computed<BotConsoleBuiltinModelTab>(() => modelTabsDraft[activeModelTab.value])

  function syncCopilotTabState(partial: Partial<BotConsoleBuiltinModelTab>): void {
    modelTabsDraft.copilot = {
      ...modelTabsDraft.copilot,
      ...partial,
      id: 'copilot',
    }

    originalModelTabs.value = {
      activeTab: originalModelTabs.value.activeTab,
      tabs: MODEL_TAB_IDS.map((id) => {
        if (id !== 'copilot') {
          return originalModelTabs.value.tabs.find(tab => tab.id === id) ?? createEmptyBuiltinModelTab(id)
        }
        return {
          ...(originalModelTabs.value.tabs.find(tab => tab.id === 'copilot') ?? createEmptyBuiltinModelTab('copilot')),
          ...partial,
          id: 'copilot',
        }
      }),
    }

    if (botState.value) {
      botState.value = {
        ...botState.value,
        modelTabs: {
          activeTab: botState.value.modelTabs.activeTab,
          tabs: MODEL_TAB_IDS.map((id) => {
            if (id !== 'copilot') {
              return botState.value?.modelTabs.tabs.find(tab => tab.id === id) ?? createEmptyBuiltinModelTab(id)
            }
            return {
              ...(botState.value?.modelTabs.tabs.find(tab => tab.id === 'copilot') ?? createEmptyBuiltinModelTab('copilot')),
              ...partial,
              id: 'copilot',
            }
          }),
        },
      }
    }
  }

  function syncCodexTabState(partial: Partial<BotConsoleBuiltinModelTab>): void {
    modelTabsDraft.codex = {
      ...modelTabsDraft.codex,
      ...partial,
      id: 'codex',
    }

    originalModelTabs.value = {
      activeTab: originalModelTabs.value.activeTab,
      tabs: MODEL_TAB_IDS.map((id) => {
        if (id !== 'codex') {
          return originalModelTabs.value.tabs.find(tab => tab.id === id) ?? createEmptyBuiltinModelTab(id)
        }
        return {
          ...(originalModelTabs.value.tabs.find(tab => tab.id === 'codex') ?? createEmptyBuiltinModelTab('codex')),
          ...partial,
          id: 'codex',
        }
      }),
    }

    if (botState.value) {
      botState.value = {
        ...botState.value,
        modelTabs: {
          activeTab: botState.value.modelTabs.activeTab,
          tabs: MODEL_TAB_IDS.map((id) => {
            if (id !== 'codex') {
              return botState.value?.modelTabs.tabs.find(tab => tab.id === id) ?? createEmptyBuiltinModelTab(id)
            }
            return {
              ...(botState.value?.modelTabs.tabs.find(tab => tab.id === 'codex') ?? createEmptyBuiltinModelTab('codex')),
              ...partial,
              id: 'codex',
            }
          }),
        },
      }
    }
  }

  function applyCopilotAuthState(
    state:
      | CopilotAuthStartResponse
      | CopilotAuthPollResponse
      | CopilotAuthStatusResponse
      | CopilotAuthCancelResponse
      | CopilotAuthLogoutResponse,
  ): void {
    copilotAuthAttempt.value = state.attempt ?? null
    syncCopilotTabState({
      authKind: state.authKind,
      authStatus: state.authStatus,
      accountLabel: state.accountLabel,
      authError: state.authError,
    })
  }

  function applyCodexAuthState(
    state:
      | CodexAuthStartResponse
      | CodexAuthPollResponse
      | CodexAuthStatusResponse
      | CodexAuthCancelResponse
      | CodexAuthLogoutResponse,
  ): void {
    codexAuthAttempt.value = state.attempt ?? null
    syncCodexTabState({
      authKind: state.authKind,
      authStatus: state.authStatus,
      accountLabel: state.accountLabel,
      authError: state.authError,
      tokenExpiresAt: state.tokenExpiresAt,
    })
  }

  // ── Actions ───────────────────────────────────────────────────────────────────

  /**
   * Fetches full bot state from the backend and syncs local draft state.
   * If no preset is currently open and the backend has presets, opens the first one.
   */
  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const state = await send<BotConsoleState>('bot-console/get-state')
      const toolPolicy = await send<BotConsoleToolPolicyState>('bot-console/get-tool-policy-state').catch(() => null)
      const mergedState: BotConsoleState = {
        ...state,
        toolPolicy: toolPolicy ?? state?.toolPolicy ?? null,
      }
      botState.value = mergedState

      const env = mergedState?.env ?? {}
      originalEnv.value = { ...env }

      // Mutate envDraft in-place to preserve reactive bindings
      for (const key of Object.keys(envDraft)) {
        delete envDraft[key]
      }
      Object.assign(envDraft, env)

      const ttsEnv = mergedState.tts?.localGateway?.env ?? {}
      originalTtsEnv.value = { ...ttsEnv }
      for (const key of Object.keys(ttsEnvDraft)) {
        delete ttsEnvDraft[key]
      }
      Object.assign(ttsEnvDraft, ttsEnv)

      const modelTabs = buildModelTabsState(mergedState)
      originalModelTabs.value = modelTabs
      activeModelTab.value = modelTabs.activeTab
      for (const id of MODEL_TAB_IDS) {
        modelTabsDraft[id] = { ...modelTabs.tabs.find(tab => tab.id === id) ?? createEmptyBuiltinModelTab(id) }
      }
      copilotAuthAttempt.value = null

      const nextOverrides: Record<string, FeatureOverrideMode> = {}
      for (const item of mergedState?.featureOverrides ?? []) {
        nextOverrides[buildFeatureOverrideKey(item.scopeKind, item.scopeId, item.featureKey)] = normalizeOverrideMode(item.enabled)
      }
      originalFeatureOverrides.value = nextOverrides
      for (const key of Object.keys(featureOverrideDraft)) {
        delete featureOverrideDraft[key]
      }
      Object.assign(featureOverrideDraft, nextOverrides)

      for (const scope of mergedState?.featureScopes ?? []) {
        for (const featureKey of FEATURE_KEYS) {
          if (scope.scopeKind === 'private_default' && isPrivateUnsupportedFeatureKey(featureKey)) continue
          const key = buildFeatureOverrideKey(scope.scopeKind, scope.scopeId, featureKey)
          featureOverrideDraft[key] = nextOverrides[key] ?? 'inherit'
        }
      }

      const toolScopes = toolPolicyScopes.value
      const toolRoutes = toolPolicyRouteProfiles.value
      const toolCatalog = toolPolicyCatalog.value
      const nextToolOverrides = buildToolOverrideMap(mergedState)
      originalToolOverrides.value = nextToolOverrides
      for (const key of Object.keys(toolOverrideDraft)) {
        delete toolOverrideDraft[key]
      }
      for (const scope of toolScopes) {
        for (const routeProfile of toolRoutes) {
          for (const tool of toolCatalog) {
            const key = resolveToolOverrideKey(scope, routeProfile, tool.toolName)
            toolOverrideDraft[key] = nextToolOverrides[key] ?? 'inherit'
          }
        }
      }

      if (!toolRoutes.includes(toolRouteProfile.value)) {
        toolRouteProfile.value = toolRoutes[0] ?? 'agent'
      }

      const foundToolScope = toolScopes.find(scope => buildToolScopeKey(scope) === selectedToolScopeKey.value)
      if (!foundToolScope) {
        selectedToolScopeKey.value = buildToolScopeKey(toolScopes[0] ?? {
          scopeKind: 'global_default',
          scopeId: TOOL_GLOBAL_DEFAULT_SCOPE_ID,
          roomId: null,
          roomName: '全局默认',
          groupId: null,
          conversationId: null,
          visibility: null,
          updatedAt: null,
        })
      }

      // Auto-open first preset when none is selected
      if (!currentPreset.value.name && mergedState?.presets?.length) {
        await openPreset(mergedState.presets[0].name)
      }

      if (memoryState.value) {
        await refreshMemoryState().catch(() => null)
      }
    } finally {
      loading.value = false
    }
  }

  async function refreshMemoryState(): Promise<GetMemoryStateResponse> {
    memoryLoading.value = true
    try {
      const result = await send<GetMemoryStateResponse>('bot-console/get-memory-state')
      memoryState.value = result
      return result
    } finally {
      memoryLoading.value = false
    }
  }

  /**
   * Saves the selected managed env keys to the backend.
   */
  function syncEnvState(env: Record<string, string>, submittedEnv: Record<string, string> = {}): void {
    const pendingDraft: Record<string, string> = {}
    for (const key of changedKeys.value) {
      const wasSubmitted = Object.prototype.hasOwnProperty.call(submittedEnv, key)
      if (!wasSubmitted || (envDraft[key] ?? '') !== submittedEnv[key]) {
        pendingDraft[key] = envDraft[key] ?? ''
      }
    }

    originalEnv.value = { ...env }
    for (const key of Object.keys(envDraft)) {
      delete envDraft[key]
    }
    Object.assign(envDraft, env, pendingDraft)
  }

  async function saveEnvPatch(keys: readonly string[]): Promise<SaveEnvResponse> {
    const payload: Record<string, string> = {}
    for (const key of keys) {
      if (changedKeys.value.has(key)) {
        payload[key] = envDraft[key] ?? ''
      }
    }

    const result = await send<SaveEnvResponse>('bot-console/save-env', payload)
    const savedEnv = result?.env ?? {}

    syncEnvState(savedEnv, payload)

    if (botState.value) {
      botState.value = {
        ...botState.value,
        env: savedEnv,
      }
    }

    return result
  }

  async function saveEnv(): Promise<SaveEnvResponse> {
    return saveEnvPatch(ALL_ENV_KEYS)
  }

  function syncTtsState(
    env: Record<string, string>,
    tts: BotConsoleTtsState,
    submittedBotEnv: Record<string, string>,
    submittedLocalEnv: Record<string, string>,
  ): void {
    syncEnvState(env, submittedBotEnv)

    const pendingLocalDraft: Record<string, string> = {}
    for (const key of changedTtsEnvKeys.value) {
      const wasSubmitted = Object.prototype.hasOwnProperty.call(submittedLocalEnv, key)
      if (!wasSubmitted || (ttsEnvDraft[key] ?? '') !== submittedLocalEnv[key]) {
        pendingLocalDraft[key] = ttsEnvDraft[key] ?? ''
      }
    }

    originalTtsEnv.value = { ...(tts.localGateway.env ?? {}) }
    for (const key of Object.keys(ttsEnvDraft)) {
      delete ttsEnvDraft[key]
    }
    Object.assign(ttsEnvDraft, tts.localGateway.env ?? {}, pendingLocalDraft)

    if (botState.value) {
      botState.value = {
        ...botState.value,
        env,
        tts,
        runtimeStatus: {
          ...botState.value.runtimeStatus,
          tts: tts.health,
        },
      }
    }
  }

  async function saveTtsSettings(): Promise<SaveTtsSettingsResponse> {
    const botEnv: Record<string, string> = {}
    for (const key of TTS_BOT_ENV_KEYS) {
      if (changedTtsBotEnvKeys.value.has(key)) {
        botEnv[key] = envDraft[key] ?? ''
      }
    }

    const localEnv: Record<string, string> = {}
    for (const key of TTS_LOCAL_ENV_KEYS) {
      if (changedTtsEnvKeys.value.has(key)) {
        localEnv[key] = ttsEnvDraft[key] ?? ''
      }
    }

    const result = await send<SaveTtsSettingsResponse>('bot-console/save-tts-settings', {
      botEnv,
      localEnv,
    })
    syncTtsState(result.env, result.tts, botEnv, localEnv)
    return result
  }

  async function saveHbuJwSettings(): Promise<SaveEnvResponse> {
    return saveEnvPatch(HBU_JW_ENV_KEYS)
  }

  async function saveGenshinSettings(): Promise<SaveEnvResponse> {
    return saveEnvPatch(GENSHIN_ENV_KEYS)
  }

  async function probeTtsHealth(): Promise<ProbeTtsHealthResponse> {
    const result = await send<ProbeTtsHealthResponse>('bot-console/probe-tts-health')
    if (botState.value) {
      const nextTts = {
        ...botState.value.tts,
        health: result.health,
      }
      botState.value = {
        ...botState.value,
        tts: nextTts,
        runtimeStatus: {
          ...botState.value.runtimeStatus,
          tts: result.health,
        },
      }
    }
    return result
  }

  async function synthesizeTtsSample(text: string, style: BotConsoleTtsStyleId): Promise<SynthesizeTtsSampleResponse> {
    return send<SynthesizeTtsSampleResponse>('bot-console/synthesize-tts-sample', { text, style })
  }

  async function saveModelTabs(): Promise<SaveModelTabsResponse> {
    const payload: SaveModelTabsRequest = {
      activeTab: activeModelTab.value,
      tabs: MODEL_TAB_IDS.map(id => ({
        ...modelTabsDraft[id],
        id,
        title: modelTabsDraft[id].title,
        provider: modelTabsDraft[id].provider,
      })),
      dirtyTabIds: dirtyModelTabIds.value.length > 0 ? [...dirtyModelTabIds.value] : [activeModelTab.value],
    }

    const result = await send<SaveModelTabsResponse>('bot-console/save-model-tabs', payload)

    syncEnvState(result?.env ?? {})

    const nextTabs = result?.modelTabs ?? buildModelTabsState(botState.value)
    originalModelTabs.value = nextTabs
    activeModelTab.value = nextTabs.activeTab
    for (const id of MODEL_TAB_IDS) {
      modelTabsDraft[id] = { ...nextTabs.tabs.find(tab => tab.id === id) ?? createEmptyBuiltinModelTab(id) }
    }

    if (botState.value) {
      botState.value = {
        ...botState.value,
        env: result?.env ?? botState.value.env,
        modelTabs: nextTabs,
      }
    }

    return result
  }

  async function saveModelSettings(): Promise<SaveModelTabsResponse | undefined> {
    // Single source of truth: model tabs only. Auxiliary fields (preset, context ratio) live on
    // their own panels now and are saved through saveEnv there.
    let result: SaveModelTabsResponse | undefined
    if (modelTabsChanged.value) {
      result = await saveModelTabs()
    }
    return result
  }

  function selectModelTab(id: BotConsoleModelTabId): void {
    activeModelTab.value = id
  }

  async function listDeepSeekModels(request: DeepSeekModelListRequest): Promise<DeepSeekModelListResponse> {
    return send<DeepSeekModelListResponse>('bot-console/list-deepseek-models', request)
  }

  async function listCopilotModels(): Promise<CopilotModelListResponse> {
    return send<CopilotModelListResponse>('bot-console/list-copilot-models')
  }

  async function listCodexModels(): Promise<CodexModelListResponse> {
    return send<CodexModelListResponse>('bot-console/list-codex-models')
  }

  async function listMimoModels(request: MimoModelListRequest): Promise<MimoModelListResponse> {
    return send<MimoModelListResponse>('bot-console/list-mimo-models', request)
  }

  async function refreshCodexAuthStatus(): Promise<CodexAuthStatusResponse> {
    const result = await send<CodexAuthStatusResponse>('bot-console/codex-auth/status')
    applyCodexAuthState(result)
    return result
  }

  async function startCodexAuth(): Promise<CodexAuthStartResponse> {
    const result = await send<CodexAuthStartResponse>('bot-console/codex-auth/start')
    applyCodexAuthState(result)
    return result
  }

  async function pollCodexAuth(attemptId: string): Promise<CodexAuthPollResponse> {
    const result = await send<CodexAuthPollResponse>('bot-console/codex-auth/poll', attemptId)
    applyCodexAuthState(result)
    return result
  }

  async function cancelCodexAuth(): Promise<CodexAuthCancelResponse> {
    const result = await send<CodexAuthCancelResponse>(
      'bot-console/codex-auth/cancel',
      codexAuthAttempt.value?.attemptId ?? '',
    )
    applyCodexAuthState(result)
    return result
  }

  async function logoutCodexAuth(): Promise<CodexAuthLogoutResponse> {
    const result = await send<CodexAuthLogoutResponse>('bot-console/codex-auth/logout')
    applyCodexAuthState(result)
    return result
  }

  async function refreshCopilotAuthStatus(): Promise<CopilotAuthStatusResponse> {
    const result = await send<CopilotAuthStatusResponse>('bot-console/copilot-auth/status')
    applyCopilotAuthState(result)
    return result
  }

  async function startCopilotAuth(): Promise<CopilotAuthStartResponse> {
    const result = await send<CopilotAuthStartResponse>('bot-console/copilot-auth/start')
    applyCopilotAuthState(result)
    return result
  }

  async function pollCopilotAuth(attemptId: string): Promise<CopilotAuthPollResponse> {
    const result = await send<CopilotAuthPollResponse>('bot-console/copilot-auth/poll', attemptId)
    applyCopilotAuthState(result)
    return result
  }

  async function cancelCopilotAuth(): Promise<CopilotAuthCancelResponse> {
    const result = await send<CopilotAuthCancelResponse>(
      'bot-console/copilot-auth/cancel',
      copilotAuthAttempt.value?.attemptId ?? '',
    )
    applyCopilotAuthState(result)
    return result
  }

  async function logoutCopilotAuth(): Promise<CopilotAuthLogoutResponse> {
    const result = await send<CopilotAuthLogoutResponse>('bot-console/copilot-auth/logout')
    applyCopilotAuthState(result)
    return result
  }

  async function saveFeatureOverrides(): Promise<SaveFeatureOverridesResponse> {
    const overrides: FeatureOverrideInput[] = []
    const scopes = botState.value?.featureScopes ?? []
    for (const scope of scopes) {
      for (const featureKey of FEATURE_KEYS) {
        if (scope.scopeKind === 'private_default' && isPrivateUnsupportedFeatureKey(featureKey)) continue
        const draftKey = buildFeatureOverrideKey(scope.scopeKind, scope.scopeId, featureKey)
        const mode = featureOverrideDraft[draftKey] ?? 'inherit'
        const enabled = denormalizeOverrideMode(mode)
        if (enabled == null) continue
        overrides.push({
          featureKey,
          scopeKind: scope.scopeKind,
          scopeId: scope.scopeId,
          enabled,
        })
      }
    }

    const result = await send<SaveFeatureOverridesResponse>(
      'bot-console/save-feature-overrides',
      { overrides },
    )

    const nextOverrides: Record<string, FeatureOverrideMode> = {}
    for (const item of result?.overrides ?? []) {
      nextOverrides[buildFeatureOverrideKey(item.scopeKind, item.scopeId, item.featureKey)] = normalizeOverrideMode(item.enabled)
    }
    originalFeatureOverrides.value = nextOverrides
    for (const key of Object.keys(featureOverrideDraft)) {
      featureOverrideDraft[key] = nextOverrides[key] ?? 'inherit'
    }

    if (botState.value) {
      botState.value = {
        ...botState.value,
        featureOverrides: result?.overrides ?? [],
      }
    }

    return result
  }

  async function saveFeatureSettings(): Promise<void> {
    if (changedFeatureEnvKeys.value.size > 0) {
      await saveEnvPatch(FEATURE_ENV_KEYS)
    }
    if (canSaveFeatureOverrides.value) {
      await saveFeatureOverrides()
    }
  }

  function getToolOverrideMode(scope: ToolPolicyScope, routeProfile: ToolRouteProfile, toolName: string): ToolOverrideMode {
    return toolOverrideDraft[resolveToolOverrideKey(scope, routeProfile, toolName)] ?? 'inherit'
  }

  function resolveEffectiveToolEnabled(
    scope: ToolPolicyScope,
    routeProfile: ToolRouteProfile,
    toolName: string,
  ): boolean {
    const tool = toolPolicyCatalog.value.find(item => item.toolName === toolName)
    if (tool?.registered === false) return false
    let enabled = tool?.defaultEnabledByRoute?.[routeProfile] ?? true

    const resolveMode = (targetScopeKind: ToolPolicyScope['scopeKind'], targetScopeId: string): ToolOverrideMode =>
      toolOverrideDraft[buildToolOverrideKey(targetScopeKind, targetScopeId, routeProfile, toolName)] ?? 'inherit'

    const applyMode = (mode: ToolOverrideMode) => {
      if (mode === 'enabled') enabled = true
      if (mode === 'disabled') enabled = false
    }

    applyMode(resolveMode('global_default', TOOL_GLOBAL_DEFAULT_SCOPE_ID))

    if (scope.scopeKind === 'private_default' || scope.scopeKind === 'private_conversation') {
      applyMode(resolveMode('private_default', TOOL_PRIVATE_DEFAULT_SCOPE_ID))
    }

    if (scope.scopeKind === 'group' || scope.scopeKind === 'private_conversation') {
      applyMode(resolveMode(scope.scopeKind, scope.scopeId))
    }

    return enabled
  }

  function resolveEffectiveToolStatusLabel(
    scope: ToolPolicyScope,
    routeProfile: ToolRouteProfile,
    toolName: string,
  ): string {
    const tool = toolPolicyCatalog.value.find(item => item.toolName === toolName)
    if (tool?.registered === false) return '未注册'
    return resolveEffectiveToolEnabled(scope, routeProfile, toolName) ? '启用' : '禁用'
  }

  function setToolOverrideMode(
    scope: ToolPolicyScope,
    routeProfile: ToolRouteProfile,
    toolName: string,
    mode: ToolOverrideMode,
  ): void {
    const tool = toolPolicyCatalog.value.find(item => item.toolName === toolName)
    if (tool?.registered === false) return
    toolOverrideDraft[resolveToolOverrideKey(scope, routeProfile, toolName)] = mode
  }

  function selectToolPolicyScope(scope: ToolPolicyScope): void {
    selectedToolScopeKey.value = buildToolScopeKey(scope)
  }

  function setToolRouteProfile(routeProfile: ToolRouteProfile): void {
    toolRouteProfile.value = routeProfile
  }

  function validateToolPolicyDraft(): string[] {
    const scopes = toolPolicyScopes.value
    const catalog = toolPolicyCatalog.value
    const errors: string[] = []
    const catalogByName = new Map(catalog.map(tool => [tool.toolName, tool]))

    for (const scope of scopes) {
      for (const routeProfile of toolPolicyRouteProfiles.value) {
        for (const tool of catalog) {
          const key = resolveToolOverrideKey(scope, routeProfile, tool.toolName)
          if (toolOverrideDraft[key] !== 'enabled') continue

          for (const dependency of tool.hardDependencies) {
            const dependencyTool = catalogByName.get(dependency)
            if (!dependencyTool) {
              errors.push(
                `${getToolRouteLabel(routeProfile)} · ${getToolScopeLabel(scope)}：工具 ${tool.title} 依赖的 ${dependency} 不在目录中`,
              )
              continue
            }

            const dependencyKey = resolveToolOverrideKey(scope, routeProfile, dependencyTool.toolName)
            if (toolOverrideDraft[dependencyKey] === 'disabled') {
              errors.push(
                `${getToolRouteLabel(routeProfile)} · ${getToolScopeLabel(scope)}：启用 ${tool.title} 前请不要禁用 ${dependencyTool.title}`,
              )
            }
          }
        }
      }
    }

    return errors
  }

  async function saveToolOverrides(): Promise<SaveToolOverridesResponse> {
    const validationErrors = validateToolPolicyDraft()
    if (validationErrors.length > 0) {
      throw new Error(validationErrors[0])
    }

    const overrides: ToolPolicyOverrideInput[] = []
    const scopes = toolPolicyScopes.value
    const routes = toolPolicyRouteProfiles.value
    const catalog = toolPolicyCatalog.value

    for (const scope of scopes) {
      for (const routeProfile of routes) {
        for (const tool of catalog) {
          if (tool.registered === false) continue
          const key = resolveToolOverrideKey(scope, routeProfile, tool.toolName)
          const mode = toolOverrideDraft[key] ?? 'inherit'
          const enabled = denormalizeToolOverrideMode(mode)
          if (enabled == null) continue
          overrides.push({
            toolName: tool.toolName,
            routeProfile,
            scopeKind: scope.scopeKind,
            scopeId: scope.scopeId,
            enabled,
          })
        }
      }
    }

    const result = await send<SaveToolOverridesResponse>('bot-console/save-tool-overrides', { overrides })

    const nextOverrides: Record<string, ToolOverrideMode> = {}
    for (const item of result?.overrides ?? []) {
      nextOverrides[buildToolOverrideKey(item.scopeKind, item.scopeId, item.routeProfile, item.toolName)] =
        normalizeToolOverrideMode(item.enabled)
    }

    originalToolOverrides.value = nextOverrides
    for (const key of Object.keys(toolOverrideDraft)) {
      toolOverrideDraft[key] = nextOverrides[key] ?? 'inherit'
    }

    if (botState.value) {
      botState.value = {
        ...botState.value,
        toolPolicy: {
          ...(botState.value.toolPolicy ?? {
            routeProfiles: toolPolicyRouteProfiles.value,
            catalog: toolPolicyCatalog.value,
            scopes: toolPolicyScopes.value,
            overrides: [],
          }),
          overrides: result?.overrides ?? [],
        },
      }
    }

    return result
  }

  function validatePendingModelSettings(): void {
    if (!modelTabsChanged.value) return

    const tabIds = dirtyModelTabIds.value.length > 0
      ? dirtyModelTabIds.value
      : [activeModelTab.value]
    for (const id of tabIds) {
      const validation = validateMainChatTabModel(id, modelTabsDraft[id].defaultModel)
      if (!validation.ok) {
        throw new Error(validation.message ?? `${modelTabsDraft[id].title}模型配置无效`)
      }
    }
  }

  async function saveAllSettingsAndRestart(): Promise<void> {
    if (pendingSettingsCount.value === 0 || savingAllSettings.value) return

    validatePendingModelSettings()
    if (changedToolOverrideKeys.value.size > 0) {
      const validationErrors = validateToolPolicyDraft()
      if (validationErrors.length > 0) throw new Error(validationErrors[0])
    }

    savingAllSettings.value = true
    try {
      if (changedKeys.value.size > 0) {
        await saveEnv()
      }
      if (modelTabsChanged.value) {
        await saveModelTabs()
      }
      if (changedTtsEnvKeys.value.size > 0) {
        await saveTtsSettings()
      }
      if (changedFeatureOverrideKeys.value.size > 0) {
        await saveFeatureOverrides()
      }
      if (changedToolOverrideKeys.value.size > 0) {
        await saveToolOverrides()
      }
      await restartBot()
    } finally {
      savingAllSettings.value = false
    }
  }

  async function clearConversationHistory(target: ConversationTarget): Promise<ClearConversationHistoryResponse> {
    conversationPending[target.conversationId] = true
    try {
      const result = await send<ClearConversationHistoryResponse>(
        'bot-console/clear-conversation-history',
        {
          roomId: target.roomId,
          conversationId: target.conversationId,
        },
      )

      if (botState.value) {
        botState.value = {
          ...botState.value,
          conversationTargets: botState.value.conversationTargets.map(item =>
            item.conversationId === target.conversationId
              ? { ...item, updatedAt: result.result.updatedAt }
              : item,
          ),
        }
      }

      return result
    } finally {
      conversationPending[target.conversationId] = false
    }
  }

  async function deleteConversationRoom(target: ConversationTarget): Promise<DeleteConversationRoomResponse> {
    conversationDeletePending[target.conversationId] = true
    try {
      const result = await send<DeleteConversationRoomResponse>(
        'bot-console/delete-conversation-room',
        {
          roomId: target.roomId,
          conversationId: target.conversationId,
        },
      )

      await refresh()
      return result
    } finally {
      conversationDeletePending[target.conversationId] = false
    }
  }

  /**
   * Loads a named preset from the backend and opens it in the editor.
   */
  async function openPreset(name: string): Promise<void> {
    const preset = await send<PresetDocument>('bot-console/get-preset', name)
    currentPreset.value = clonePreset(preset)
  }

  /**
   * Saves the currently open preset to the backend, refreshes state,
   * then re-opens the preset by the name returned from the server
   * (handles renames transparently).
   */
  async function saveCurrentPreset(): Promise<SavePresetResponse> {
    const preset = clonePreset(currentPreset.value)
    const result = await send<SavePresetResponse>('bot-console/save-preset', preset)
    await refresh()
    await openPreset(result?.preset?.name ?? preset.name)
    return result
  }

  /**
   * Deletes a named preset, resets the editor, and refreshes state.
   */
  async function deletePreset(name: string): Promise<{ ok: boolean }> {
    const result = await send<{ ok: boolean }>(
      'bot-console/delete-preset',
      name,
      botState.value?.defaultPreset ?? 'sakiko',
    )
    currentPreset.value = createEmptyPreset()
    await refresh()
    return result
  }

  async function reorderPresets(names: string[]): Promise<ReorderPresetsResponse> {
    const result = await send<ReorderPresetsResponse>('bot-console/reorder-presets', { names })
    if (botState.value) {
      botState.value = {
        ...botState.value,
        presets: result?.presets ?? botState.value.presets,
      }
    }
    return result
  }

  /**
   * Runs a systemd service action (start / stop / restart / enable).
   * Tracks pending state per unit so UI can show loading indicators.
   */
  async function runServiceAction(
    unit: string,
    action: string,
  ): Promise<ServiceActionResponse | undefined> {
    servicePending[unit] = action
    try {
      const result = await send<ServiceActionResponse>(
        'bot-console/service-action',
        unit,
        action,
      )
      await refresh()
      return result
    } finally {
      servicePending[unit] = null
    }
  }

  async function restartBot(): Promise<ServiceActionResponse | undefined> {
    return runServiceAction(BOT_RUNTIME_UNIT, 'restart')
  }

  /**
   * Runs a memory health probe, updates the in-memory memory snapshot,
   * and returns the full probe result for callers to handle toasts / feedback.
   */
  async function probeEmbedding(target: BotConsoleProbeResponse['target'] = 'embedding'): Promise<BotConsoleProbeResponse> {
    probePending.value = true
    try {
      const result = await send<BotConsoleProbeResponse>(
        'bot-console/run-status-probe',
        target,
      )

      // Patch the in-memory snapshot so the Overview panel updates without a full refresh
      if (result?.memory?.snapshot && botState.value) {
        botState.value = {
          ...botState.value,
          runtimeStatus: {
            ...botState.value.runtimeStatus,
            memory: result.memory.snapshot,
          },
        }
      }

      return result
    } finally {
      probePending.value = false
    }
  }

  async function updateMemoryVisibility(payload: {
    userKey: string
    type: MemoryRecordType
    id: number
    visibility: MemoryVisibility
  }): Promise<BotConsoleMemoryMutationResponse> {
    const result = await send<BotConsoleMemoryMutationResponse>('bot-console/memory/update-visibility', payload)
    memoryState.value = result.memory
    return result
  }

  async function editMemory(payload: {
    userKey: string
    type: MemoryRecordType
    id: number
    content: string
  }): Promise<BotConsoleMemoryMutationResponse> {
    const result = await send<BotConsoleMemoryMutationResponse>('bot-console/memory/edit', payload)
    memoryState.value = result.memory
    return result
  }

  async function forgetMemory(payload: {
    userKey: string
    type?: MemoryRecordType
    id?: number
    topicKey?: string
    contextKey?: string
    all?: boolean
  }): Promise<BotConsoleMemoryMutationResponse> {
    const result = await send<BotConsoleMemoryMutationResponse>('bot-console/memory/forget', payload)
    memoryState.value = result.memory
    return result
  }

  async function reviewMemoryCandidate(payload: {
    candidateId: number
    action: 'approve' | 'reject' | 'private'
  }): Promise<BotConsoleMemoryMutationResponse> {
    const result = await send<BotConsoleMemoryMutationResponse>('bot-console/memory/review', payload)
    memoryState.value = result.memory
    return result
  }

  async function saveAffinitySettings(settings: Partial<AffinitySettings>): Promise<SaveAffinitySettingsResponse> {
    const result = await send<SaveAffinitySettingsResponse>('bot-console/affinity/save-settings', { settings })
    if (botState.value) {
      botState.value = {
        ...botState.value,
        affinity: result.affinity,
      }
    }
    return result
  }

  async function saveAffinityWhitelist(scopes: AffinityWhitelistInput[]): Promise<SaveAffinityWhitelistResponse> {
    const result = await send<SaveAffinityWhitelistResponse>('bot-console/affinity/save-whitelist', { scopes })
    if (botState.value) {
      botState.value = {
        ...botState.value,
        affinity: result.affinity,
      }
    }
    return result
  }

  async function adjustAffinityUser(payload: {
    userKey: string
    reason: string
    trust?: number
    familiarity?: number
    comfort?: number
    tension?: number
  }): Promise<AdjustAffinityUserResponse> {
    const result = await send<AdjustAffinityUserResponse>('bot-console/affinity/adjust-user', payload)
    if (botState.value) {
      botState.value = {
        ...botState.value,
        affinity: result.affinity,
      }
    }
    return result
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  return {
    // State
    loading,
    botState,
    memoryState,
    memoryLoading,
    envDraft,
    originalEnv,
    ttsEnvDraft,
    originalTtsEnv,
    modelTabsDraft,
    activeModelTab,
    originalModelTabs,
    copilotAuthAttempt,
    codexAuthAttempt,
    featureOverrideDraft,
    originalFeatureOverrides,
    currentPreset,
    probePending,
    servicePending,
    conversationPending,
    conversationDeletePending,
    toolRouteProfile,
    selectedToolScopeKey,
    toolOverrideDraft,
    originalToolOverrides,
    savingAllSettings,

    // Computed
    changedKeys,
    canSaveEnv,
    changedTtsEnvKeys,
    changedTtsBotEnvKeys,
    changedHbuJwEnvKeys,
    changedGenshinEnvKeys,
    canSaveTtsSettings,
    canSaveHbuJwSettings,
    canSaveGenshinSettings,
    modelTabsChanged,
    dirtyModelTabIds,
    currentModelValidation,
    canSaveModelSettings,
    changedFeatureEnvKeys,
    changedFeatureOverrideKeys,
    canSaveFeatureOverrides,
    canSaveFeatureSettings,
    toolPolicyScopes,
    toolPolicyCatalog,
    toolPolicyRouteProfiles,
    selectedToolScope,
    selectedToolScopeLabel,
    selectedToolRouteLabel,
    changedToolOverrideKeys,
    canSaveToolPolicyOverrides,
    canSaveToolPolicySettings,
    pendingSettingsCount,
    canSaveAllSettings,
    canSavePreset,
    defaultPreset,
    currentModelTabDraft,

    // Actions
    refresh,
    refreshMemoryState,
    saveEnv,
    saveEnvPatch,
    saveTtsSettings,
    saveHbuJwSettings,
    saveGenshinSettings,
    probeTtsHealth,
    synthesizeTtsSample,
    saveModelTabs,
    saveModelSettings,
    selectModelTab,
    refreshCodexAuthStatus,
    startCodexAuth,
    pollCodexAuth,
    cancelCodexAuth,
    logoutCodexAuth,
    refreshCopilotAuthStatus,
    startCopilotAuth,
    pollCopilotAuth,
    cancelCopilotAuth,
    logoutCopilotAuth,
    listCodexModels,
    listCopilotModels,
    listDeepSeekModels,
    listMimoModels,
    saveFeatureOverrides,
    saveFeatureSettings,
    getToolOverrideMode,
    resolveEffectiveToolEnabled,
    resolveEffectiveToolStatusLabel,
    setToolOverrideMode,
    selectToolPolicyScope,
    setToolRouteProfile,
    validateToolPolicyDraft,
    saveToolOverrides,
    saveAllSettingsAndRestart,
    clearConversationHistory,
    deleteConversationRoom,
    openPreset,
    saveCurrentPreset,
    deletePreset,
    reorderPresets,
    runServiceAction,
    restartBot,
    probeEmbedding,
    updateMemoryVisibility,
    editMemory,
    forgetMemory,
    reviewMemoryCandidate,
    saveAffinitySettings,
    saveAffinityWhitelist,
    adjustAffinityUser,
  }
}
