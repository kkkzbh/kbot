// ─── Label maps ───────────────────────────────────────────────────────────────

export const FIELD_LABELS: Record<string, string> = {
  QQBOT_REALTIME_MESSAGE_ENABLED: '实时消息',
  QQ_VOICE_INPUT_ENABLED: '语音转文字',
  QQ_VOICE_OUTPUT_ENABLED: '语音回复',
  QQ_VOICE_TTS_BASE_URL: 'TTS 地址',
  QQ_VOICE_TTS_API_KEY: 'TTS API Key',
  QQ_VOICE_OUTPUT_LANGUAGE: '语音文本语言',
  QQ_VOICE_OUTPUT_MAX_WORDS: '单段字数上限',
  QQ_VOICE_OUTPUT_MAX_SECONDS: '单段最长秒数',
  QQ_VOICE_SYNTH_TIMEOUT_MS: '合成超时时间',
  CHAT_NATURAL_TRIGGER_ENABLED: '群聊自然触发',
  QQBOT_REALTIME_MESSAGE_MAX_INJECT_COUNT: '实时消息注入条数上限',
  QQBOT_REPLY_INTERRUPT_ENABLED: '回复期中断',
  CHATLUNA_COMMON_FS: '文件系统工具总开关',
  CHATLUNA_COMMON_FS_SCOPE_PATH: '文件系统作用域目录',
  CHATLUNA_COMMON_FS_ALLOWED_GROUPS: '文件系统工具白名单群',
  CHATLUNA_ACTIVE_TAB: '当前对话模型 Tab',
  CHATLUNA_PLATFORM: '当前对话模型平台',
  CHATLUNA_BASE_URL: '对话模型接口地址',
  CHATLUNA_API_KEY: '对话模型接口密钥',
  CHATLUNA_DEFAULT_MODEL: '对话默认模型',
  CHATLUNA_MAX_CONTEXT_RATIO: '上下文窗口使用比例',
  CHATLUNA_SILICONFLOW_BASE_URL: '硅基流动接口地址',
  CHATLUNA_SILICONFLOW_API_KEY: '硅基流动接口密钥',
  CHATLUNA_SILICONFLOW_DEFAULT_MODEL: '硅基流动默认模型',
  CHATLUNA_OPENAI_BASE_URL: 'OpenAI 接口地址',
  CHATLUNA_OPENAI_API_KEY: 'OpenAI 接口密钥',
  CHATLUNA_OPENAI_DEFAULT_MODEL: 'OpenAI 默认模型',
  CHATLUNA_COPILOT_BASE_URL: 'GitHub Copilot Bridge 地址',
  CHATLUNA_COPILOT_API_KEY: 'GitHub Copilot Bridge 密钥',
  CHATLUNA_COPILOT_DEFAULT_MODEL: 'GitHub Copilot 默认模型',
  CHATLUNA_DEEPSEEK_BASE_URL: 'DeepSeek 接口地址',
  CHATLUNA_DEEPSEEK_API_KEY: 'DeepSeek 接口密钥',
  CHATLUNA_DEEPSEEK_DEFAULT_MODEL: 'DeepSeek 默认模型',
  CHATLUNA_MIMO_BASE_URL: 'MIMO 接口地址',
  CHATLUNA_MIMO_API_KEY: 'MIMO 接口密钥',
  CHATLUNA_MIMO_DEFAULT_MODEL: 'MIMO 默认模型',
  CHATLUNA_DEFAULT_PRESET: '默认预设',
  CHAT_NATURAL_TRIGGER_GROUPS: '自然触发白名单群',
  HBU_JW_ALLOWED_GROUPS: '教务系统白名单群',
  HBU_JW_PUBLIC_BASE_URL: '绑定外部地址',
  HBU_JW_BIND_PAGE_PATH: '绑定页路径',
  HBU_JW_BIND_TOKEN_TTL_MS: '绑定链接有效期',
  HBU_JW_CREDENTIAL_KEK_PATH: '凭据 KEK 路径',
  HBU_JW_AUTO_RELOGIN_ENABLED: '自动重新登录',
  HBU_JW_KEEP_ALIVE_ENABLED: '登录态保活',
  HBU_JW_KEEP_ALIVE_INTERVAL_MS: '保活周期',
  HBU_JW_KEEP_ALIVE_RECENT_USE_WINDOW_MS: '保活最近使用窗口',
  CHAT_NATURAL_TRIGGER_ALIASES: '触发别名',
  CHATLUNA_COMMAND_AUTHORITY: '命令权限等级',
}

export const FIELD_HINTS: Record<string, string> = {
  CHATLUNA_BASE_URL:
    '普通聊天默认走这里配置的接口地址。它只影响 ChatLuna 主聊天链路，不会覆盖任务自动化、自然触发判定和记忆抽取。',
  CHATLUNA_API_KEY:
    '普通聊天默认走这里配置的接口密钥。主聊天切换供应商时，优先改这里。',
  CHATLUNA_COMMON_FS:
    '控制是否向 ChatLuna 注入整组 file_* 与 bash 工具。当前模式下 bash 以宿主机高权限运行且允许联网，关闭后这些工具不会真正提供给模型。',
  CHATLUNA_COMMON_FS_SCOPE_PATH:
    '作为文件工具与 bash 的默认工作目录。当前高权限模式下它不再是强隔离边界；支持填写 ~/...，保存时会展开成当前运行用户的 home 绝对路径。',
  CHATLUNA_COMMON_FS_ALLOWED_GROUPS:
    '只有填在这里的群号才会在群聊里向模型暴露 file_*、grep、glob、bash。多个群号用英文逗号分隔；留空时群聊不暴露这些工具。',
  CHATLUNA_DEFAULT_MODEL:
    '普通聊天默认走这里配置的模型。硅基流动当前固定使用 Pro/moonshotai/Kimi-K2.5。',
  CHATLUNA_MAX_CONTEXT_RATIO:
    '控制主聊天可使用的模型上下文窗口比例。会跟随当前实际 room model 动态计算 token limit，不按 tab 名硬编码。',
  CHATLUNA_OPENAI_DEFAULT_MODEL:
    'OpenAI Tab 当前按 OpenAI 兼容 provider 处理，并通过 chat/completions + response_format 输出结构化结果，默认推荐 openai/gpt-5.4-medium-thinking。',
  CHATLUNA_COPILOT_DEFAULT_MODEL:
    'GitHub Copilot Tab 当前按 OAuth + 本地 bridge 处理，只暴露 openai/auto，具体模型由 Copilot Auto session 决定。',
  CHAT_NATURAL_TRIGGER_GROUPS:
    '只有填在这里的群号才会命中群聊自然触发。多个群号用英文逗号分隔；留空时不会在任何群自动触发。',
  HBU_JW_ALLOWED_GROUPS:
    '只有填在这里的群号才可以在群聊里使用教务绑定、状态、解绑和 GPA 查询。裸教务触发由自然触发白名单控制；留空时群聊不可用，私聊仍可用。',
  HBU_JW_PUBLIC_BASE_URL:
    '群聊或私聊回复绑定链接时使用的外部可访问地址。留空时运行时使用本机 Koishi 端口。',
  HBU_JW_BIND_PAGE_PATH:
    '教务绑定网页路径，必须以 / 开头。留空时使用 /jw/bind。',
  HBU_JW_BIND_TOKEN_TTL_MS:
    '绑定链接有效期，单位毫秒。',
  HBU_JW_CREDENTIAL_KEK_PATH:
    '本机加密密钥文件路径。用于加密保存教务凭据，文件权限必须只允许运行用户读取。',
  HBU_JW_AUTO_RELOGIN_ENABLED:
    '教务 cookie 失效后，是否使用已加密保存的凭据自动重新登录。',
  HBU_JW_KEEP_ALIVE_ENABLED:
    '是否定期探活最近使用过的教务登录态。',
  HBU_JW_KEEP_ALIVE_INTERVAL_MS:
    '登录态保活检查间隔，单位毫秒。',
  HBU_JW_KEEP_ALIVE_RECENT_USE_WINDOW_MS:
    '只对最近这段时间内验证过的登录态执行保活，单位毫秒。',
  QQBOT_REALTIME_MESSAGE_MAX_INJECT_COUNT:
    '每次主链路触发时，最多注入这么多条尚未写入会话历史的实时消息；注入后旧缓存会整体清空。',
  QQ_VOICE_TTS_BASE_URL:
    '主机器人调用的 TTS 网关地址。本地通常是 127.0.0.1:5162，服务器应填写笔记本 Tailnet 地址。',
  QQ_VOICE_OUTPUT_LANGUAGE:
    '模型生成 voice.content 的目标语言。TTS 只朗读这段文本，不负责翻译；建议和 TTS 输入语言保持一致。',
  QQ_VOICE_SYNTH_TIMEOUT_MS:
    '主机器人等待整次 TTS 请求的最长时间，单位毫秒。',
}

export const ROLE_LABELS: Record<string, string> = {
  system: '系统',
  user: '用户',
  assistant: '助手',
  tool: '工具',
}

export const SERVICE_LABELS: Record<string, string> = {
  'qqbot.target': '机器人总控',
  'qqbot-pmhq.service': 'PMHQ 容器服务',
  'qqbot-llbot.service': 'LLBot 服务',
  'qqbot-koishi.service': '主机器人服务',
  'cloudflared-qqbot-hbu-jw.service': '教务公网隧道',
  'cloudflared-qqbot-genshin.service': '原神公网隧道',
  'qqbot-voice-tts.service': '语音合成服务',
  'qqbot-voice-tts-tailnet.service': '语音 Tailnet 发布',
}

export const SERVICE_HINTS: Record<string, string> = {
  'qqbot.target':
    '整套本地链路总控，用于一键启动、停止或全栈重启主机器人和依赖服务。',
  'qqbot-pmhq.service': 'QQ 登录与 PMHQ HTTP 接口所在的容器服务。',
  'qqbot-llbot.service': '宿主机上的 OneBot 与 WebUI 进程，负责桥接 PMHQ。',
  'qqbot-koishi.service': '机器人主程序。大多数聊天和控制功能依赖它。',
  'cloudflared-qqbot-hbu-jw.service': 'Cloudflare Tunnel，负责公开教务绑定页。',
  'cloudflared-qqbot-genshin.service': 'Cloudflare Tunnel，负责公开原神绑定页。',
  'qqbot-voice-tts.service': '只有用到语音播报或语音回复时才需要。',
  'qqbot-voice-tts-tailnet.service':
    '仅在服务器需要经由 Tailnet 访问本机 TTS 时启用。它不会再启动第二份模型。',
}

export const VISIBLE_SERVICE_UNITS = [
  'qqbot.target',
  'qqbot-pmhq.service',
  'qqbot-llbot.service',
  'qqbot-koishi.service',
  'cloudflared-qqbot-hbu-jw.service',
  'cloudflared-qqbot-genshin.service',
  'qqbot-voice-tts.service',
  'qqbot-voice-tts-tailnet.service',
] as const

export const ALL_SERVICE_UNITS = [
  'qqbot.target',
  'qqbot-pmhq.service',
  'qqbot-llbot.service',
  'qqbot-koishi.service',
  'cloudflared-qqbot-hbu-jw.service',
  'cloudflared-qqbot-genshin.service',
  'qqbot-voice-tts.service',
  'qqbot-voice-tts-tailnet.service',
] as const

export const ACTIVE_STATE_LABELS: Record<string, string> = {
  active: '已运行',
  inactive: '未运行',
  failed: '运行失败',
  activating: '正在启动',
  deactivating: '正在停止',
  reloading: '正在重载',
  unknown: '未知',
}

export const SUB_STATE_LABELS: Record<string, string> = {
  active: '已激活',
  running: '运行中',
  dead: '未运行',
  exited: '已退出',
  failed: '失败',
  start: '启动中',
  stop: '停止中',
  auto_restart: '自动重启中',
  listening: '监听中',
  plugged: '已接入',
  mounted: '已挂载',
  unknown: '未知',
}

export const UNIT_FILE_STATE_LABELS: Record<string, string> = {
  enabled: '已启用开机自启',
  disabled: '未启用开机自启',
  static: '固定服务',
  indirect: '间接启用',
  masked: '已屏蔽',
  generated: '自动生成',
  transient: '临时服务',
  unknown: '未知',
}

/** Items shown in the Overview panel's features chip list. */
export const OVERVIEW_FEATURE_ITEMS: [string, string][] = [
  ['QQBOT_REALTIME_MESSAGE_ENABLED', '实时消息'],
  ['QQ_VOICE_INPUT_ENABLED', '语音转文字'],
  ['QQ_VOICE_OUTPUT_ENABLED', '语音回复'],
  ['CHAT_NATURAL_TRIGGER_ENABLED', '自然触发'],
  ['QQBOT_REPLY_INTERRUPT_ENABLED', '回复期中断'],
]

// ─── Lookup helpers ───────────────────────────────────────────────────────────

export function getFieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key
}

export function getFieldHint(key: string): string {
  return FIELD_HINTS[key] ?? ''
}

export function getServiceLabel(unit: string, fallbackDescription?: string): string {
  return SERVICE_LABELS[unit] ?? fallbackDescription ?? unit
}

export function getServiceHint(unit: string): string {
  return SERVICE_HINTS[unit] ?? '这是机器人运行过程中的一个服务组件。'
}

export function getActiveStateLabel(value: string): string {
  return ACTIVE_STATE_LABELS[value] ?? value
}

export function getSubStateLabel(value: string): string {
  return SUB_STATE_LABELS[value] ?? value
}

export function getUnitFileStateLabel(value: string): string {
  return UNIT_FILE_STATE_LABELS[value] ?? value
}

// ─── Tone / status helpers ────────────────────────────────────────────────────

export type StatusTone = 'success' | 'warning' | 'danger' | 'muted' | 'primary'

/**
 * Maps a systemd activeState to a badge tone.
 */
export function getActiveStateTone(activeState: string): StatusTone {
  switch (activeState) {
    case 'active':
      return 'success'
    case 'failed':
      return 'danger'
    case 'activating':
    case 'deactivating':
    case 'reloading':
      return 'warning'
    default:
      return 'muted'
  }
}

/**
 * Maps a systemd activeState to the CSS class suffix used on `.bc-status-dot`.
 * Returns one of: 'active' | 'failed' | 'inactive'
 */
export function getStatusDotClass(activeState: string): 'active' | 'failed' | 'inactive' {
  if (activeState === 'active') return 'active'
  if (activeState === 'failed') return 'failed'
  return 'inactive'
}

/**
 * Returns the label for the auto-start toggle button based on current state.
 */
export function getAutoStartButtonLabel(canEnable: boolean): string {
  return canEnable ? '启用开机自启' : '已启用开机自启'
}
