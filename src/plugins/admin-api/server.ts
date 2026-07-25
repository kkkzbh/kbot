import { constants as fsConstants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import YAML from 'yaml';
import type {
  AdminApplyReason,
  AdminApplyRestartTarget,
  AdminEnvFilesState,
  AdminBuiltinModelTab,
  AdminAuthStatus,
  CodexAuthAttempt,
  CodexCatalogState,
  CopilotAuthAttempt,
  AdminModelOption,
  AdminModelTabId,
  AdminModelTabsState,
  AdminTtsHealthSnapshot,
  AdminTtsState,
  AdminTtsStyleId,
  BotServiceStatus,
  BotServiceUnit,
  CopilotModelListResponse,
  CodexModelListResponse,
  DeepSeekModelListRequest,
  DeepSeekModelListResponse,
  EnvPatch,
  MimoModelListRequest,
  MimoModelListResponse,
  PresetDocument,
  PresetSource,
  PresetSummary,
  SaveModelTabsRequest,
  SaveTtsSettingsRequest,
  SaveTtsSettingsResponse,
  SynthesizeTtsSampleRequest,
  ServiceAction,
} from '../../types/admin.js';
import {
  buildMainChatRuntimeEnvPatch,
  CODEX_DEFAULT_REASONING_EFFORT,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_OFFICIAL_MODEL_OPTIONS,
  getBuiltinMainChatTabDefinition,
  getMainChatProviderStrategy,
  MAIN_CHAT_BUILTIN_TAB_IDS,
  MIMO_CHAT_MODEL_OPTIONS,
  MIMO_DEFAULT_BASE_URL,
  normalizeCodexModelId,
  normalizeCodexReasoningEffort,
  normalizeCopilotModelId,
  normalizeDeepSeekModelId,
  normalizeMainChatBuiltinTabId,
  normalizeMimoModelId,
  resolveMainChatActiveTabFromEnv,
  resolveMainChatTabStateFromEnv,
  validateMainChatTabModel,
} from '../shared/llm/index.js';
import {
  applyTtsLocalEnvPatchToContent,
  buildTtsLocalGatewayState,
  createUnknownTtsHealth,
  createUnreachableTtsHealth,
  mergeTtsLocalEnvRecords,
  parseTtsHealthPayload,
  parseWavInfo,
  readTtsLocalEnvPatchFromContent,
  resolveConfiguredTtsBaseUrl,
  resolveTtsEnvFilePath,
} from './tts.js';

const execFile = promisify(execFileCallback);

export type ManagedEnvField = {
  key: string;
  label: string;
  type: 'toggle' | 'text' | 'secret' | 'number';
  section: 'features' | 'model' | 'basic';
};

type ExecResult = {
  stdout: string;
  stderr: string;
};

export type TtsAudioSample = {
  data: Uint8Array;
  contentType: string;
  elapsedMs: number;
  durationSeconds: number | null;
  sampleRate: number | null;
  channels: number | null;
};

type FsLike = {
  access: typeof access;
  copyFile: typeof copyFile;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  readdir: typeof readdir;
  rename: typeof rename;
  rm: typeof rm;
  stat: typeof stat;
  writeFile: typeof writeFile;
};

export type AdminRuntimeManagerOptions = {
  rootDir?: string;
  envFilePath?: string;
  envBaseFilePath?: string;
  envOverrideFilePath?: string;
  ttsEnvFilePath?: string;
  presetDirPath?: string;
  runtimePresetDirPath?: string;
  bundledPresetDirPaths?: string[];
  fs?: FsLike;
  execFile?: (file: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;
  fetchFn?: typeof fetch;
  copilotBridge?: CopilotBridgeStateProvider;
  codexBridge?: CodexBridgeStateProvider;
};

type SystemdScope = 'system' | 'user';

type EnvLine =
  | { type: 'kv'; key: string; rawValue: string }
  | { type: 'other'; value: string };

type CopilotBridgeRuntimeConfig = {
  baseUrl: string;
  apiKey: string;
};

type CopilotBridgeAdminState = {
  authKind: 'oauth_device';
  authStatus: AdminAuthStatus;
  accountLabel: string | null;
  authError: string | null;
  attempt: CopilotAuthAttempt | null;
};

type CopilotBridgeStateProvider = {
  getRuntimeConfig: () => Promise<CopilotBridgeRuntimeConfig>;
  getAdminStatus: (options?: { probe?: boolean }) => Promise<CopilotBridgeAdminState>;
  proxyModels?: () => Promise<{ status: number; headers: Record<string, string>; body: string }>;
};

type CodexBridgeRuntimeConfig = {
  baseUrl: string;
  apiKey: string;
};

type CodexBridgeAdminState = {
  authKind: 'codex_oauth';
  authStatus: AdminAuthStatus;
  accountLabel: string | null;
  authError: string | null;
  tokenExpiresAt: number | null;
  attempt: CodexAuthAttempt | null;
};

type CodexBridgeStateProvider = {
  getRuntimeConfig: () => Promise<CodexBridgeRuntimeConfig>;
  getAdminStatus: (options?: { probe?: boolean }) => Promise<CodexBridgeAdminState>;
  getCatalogStatus: () => Promise<CodexCatalogState>;
  proxyModels?: (options?: { forceRefresh?: boolean }) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
};

type ResolvedEnvFiles = {
  mode: 'single' | 'layered';
  baseFilePath: string | null;
  overrideFilePath: string | null;
  editTarget: string;
};

type ResolvedPresetPaths = {
  mode: 'single' | 'layered';
  runtimeDirPath: string;
  bundledDirPaths: string[];
  allDirPaths: string[];
};

type PresetOrderDocument = {
  names?: unknown;
};

const DEFAULT_ROOT_DIR = resolve(process.cwd());
const LOCAL_ENV_FILE_BASENAME = '.env.local';
const SERVER_ENV_FILE_BASENAME = '.env.server';
const PRESET_DIR_RELATIVE = 'data/chathub/presets';
const PRESET_ORDER_FILENAME = '.admin-preset-order.json';
const PRESET_ROLE_SET = new Set(['system', 'user', 'assistant', 'tool']);
const RUNTIME_ENV_FILE_BASENAME = '.env.runtime';
const LOCAL_RUNTIME_ENV_RELATIVE = join('.runtime', RUNTIME_ENV_FILE_BASENAME);
const CHATLUNA_AGENT_CONFIG_RELATIVE = join('data', 'chatluna', 'agent', 'config.json');
const DEEPSEEK_MODEL_LIST_TIMEOUT_MS = 5000;
const MIMO_MODEL_LIST_TIMEOUT_MS = 5000;

export const ADMIN_ENV_FIELDS: ManagedEnvField[] = [
  { key: 'QQBOT_REALTIME_MESSAGE_ENABLED', label: '实时消息', type: 'toggle', section: 'features' },
  { key: 'QQ_VOICE_INPUT_ENABLED', label: '语音转文字', type: 'toggle', section: 'features' },
  { key: 'QQ_VOICE_OUTPUT_ENABLED', label: '语音回复', type: 'toggle', section: 'features' },
  { key: 'QQ_VOICE_TTS_BASE_URL', label: 'TTS 服务地址', type: 'text', section: 'features' },
  { key: 'QQ_VOICE_TTS_API_KEY', label: 'TTS 服务密钥', type: 'secret', section: 'features' },
  { key: 'QQ_VOICE_OUTPUT_LANGUAGE', label: '语音文本语言', type: 'text', section: 'features' },
  { key: 'QQ_VOICE_OUTPUT_MAX_WORDS', label: '语音单段字数上限', type: 'number', section: 'features' },
  { key: 'QQ_VOICE_OUTPUT_MAX_SECONDS', label: '语音单段最长秒数', type: 'number', section: 'features' },
  { key: 'QQ_VOICE_SYNTH_TIMEOUT_MS', label: '语音合成超时', type: 'number', section: 'features' },
  { key: 'CHAT_NATURAL_TRIGGER_ENABLED', label: '群聊自然触发', type: 'toggle', section: 'features' },
  { key: 'CHAT_NATURAL_TRIGGER_GROUPS', label: '自然触发白名单群', type: 'text', section: 'features' },
  { key: 'HBU_JW_ALLOWED_GROUPS', label: '教务系统白名单群', type: 'text', section: 'features' },
  { key: 'HBU_JW_PUBLIC_BASE_URL', label: '教务绑定外部地址', type: 'text', section: 'features' },
  { key: 'HBU_JW_BIND_PAGE_PATH', label: '教务绑定页路径', type: 'text', section: 'features' },
  { key: 'HBU_JW_BIND_TOKEN_TTL_MS', label: '教务绑定链接有效期', type: 'number', section: 'features' },
  { key: 'HBU_JW_CREDENTIAL_KEK_PATH', label: '教务凭据 KEK 路径', type: 'text', section: 'features' },
  { key: 'HBU_JW_AUTO_RELOGIN_ENABLED', label: '教务自动重新登录', type: 'toggle', section: 'features' },
  { key: 'HBU_JW_KEEP_ALIVE_ENABLED', label: '教务登录态保活', type: 'toggle', section: 'features' },
  { key: 'HBU_JW_KEEP_ALIVE_INTERVAL_MS', label: '教务保活周期', type: 'number', section: 'features' },
  { key: 'HBU_JW_KEEP_ALIVE_RECENT_USE_WINDOW_MS', label: '教务保活最近使用窗口', type: 'number', section: 'features' },
  { key: 'HBU_JW_WEBVPN_BROKER_URL', label: '教务 WebVPN Broker 地址', type: 'text', section: 'features' },
  { key: 'HBU_JW_WEBVPN_BROKER_TOKEN_FILE', label: '教务 WebVPN Broker 凭据文件', type: 'text', section: 'features' },
  { key: 'CAMPUS_AUTH_PUBLIC_BASE_URL', label: '校园绑定外部地址', type: 'text', section: 'features' },
  { key: 'CAMPUS_AUTH_BIND_PAGE_PATH', label: '校园绑定页路径', type: 'text', section: 'features' },
  { key: 'CAMPUS_AUTH_BIND_TOKEN_TTL_MS', label: '校园绑定链接有效期', type: 'number', section: 'features' },
  { key: 'CAMPUS_AUTH_ACTION_PAGE_PATH', label: '校园定位操作页路径', type: 'text', section: 'features' },
  { key: 'CAMPUS_AUTH_ACTION_TOKEN_TTL_MS', label: '校园定位操作链接有效期', type: 'number', section: 'features' },
  { key: 'CAMPUS_AUTH_CREDENTIAL_KEK_PATH', label: '校园认证 KEK 路径', type: 'text', section: 'features' },
  { key: 'CAMPUS_AUTH_MAX_BINDING_ATTEMPTS', label: '校园绑定最多尝试次数', type: 'number', section: 'features' },
  { key: 'ZYH_ALLOWED_GROUPS', label: '志愿汇白名单群', type: 'text', section: 'features' },
  { key: 'ZYH_NATURAL_TRIGGER_ENABLED', label: '志愿汇自然触发', type: 'toggle', section: 'features' },
  { key: 'ZYH_NATURAL_TRIGGER_GROUPS', label: '志愿汇自然触发群', type: 'text', section: 'features' },
  { key: 'HBU_SECOND_CLASS_ALLOWED_GROUPS', label: '二课白名单群', type: 'text', section: 'features' },
  { key: 'HBU_SECOND_CLASS_NATURAL_TRIGGER_ENABLED', label: '二课自然触发', type: 'toggle', section: 'features' },
  { key: 'HBU_SECOND_CLASS_NATURAL_TRIGGER_GROUPS', label: '二课自然触发群', type: 'text', section: 'features' },
  { key: 'CHAOXING_ALLOWED_GROUPS', label: '学习通白名单群', type: 'text', section: 'features' },
  { key: 'CHAOXING_PUBLIC_BASE_URL', label: '学习通绑定外部地址', type: 'text', section: 'features' },
  { key: 'CHAOXING_BIND_PAGE_PATH', label: '学习通绑定页路径', type: 'text', section: 'features' },
  { key: 'CHAOXING_BIND_TOKEN_TTL_MS', label: '学习通绑定链接有效期', type: 'number', section: 'features' },
  { key: 'CHAOXING_SIGN_ACTION_PAGE_PATH', label: '学习通签到交互页路径', type: 'text', section: 'features' },
  { key: 'CHAOXING_SIGN_ACTION_TOKEN_TTL_MS', label: '学习通签到链接有效期', type: 'number', section: 'features' },
  { key: 'CHAOXING_CREDENTIAL_KEK_PATH', label: '学习通凭据 KEK 路径', type: 'text', section: 'features' },
  { key: 'CHAOXING_AUTO_RELOGIN_ENABLED', label: '学习通自动重新登录', type: 'toggle', section: 'features' },
  { key: 'CHAOXING_SESSION_VALIDATION_TTL_MS', label: '学习通登录态缓存时间', type: 'number', section: 'features' },
  { key: 'CHAOXING_REQUEST_INTERVAL_MS', label: '学习通请求间隔', type: 'number', section: 'features' },
  { key: 'CHAOXING_WORKER_POLL_INTERVAL_MS', label: '学习通任务轮询间隔', type: 'number', section: 'features' },
  { key: 'CHAOXING_SIGN_WATCH_INTERVAL_MS', label: '学习通签到监听间隔', type: 'number', section: 'features' },
  { key: 'CHAOXING_DEADLINE_SYNC_INTERVAL_MS', label: '学习通截止任务同步间隔', type: 'number', section: 'features' },
  { key: 'CHAOXING_DEADLINE_REMINDER_LEAD_MS', label: '学习通截止提醒提前量', type: 'number', section: 'features' },
  { key: 'CHAOXING_STUDY_PLAYBACK_RATE', label: '学习通视频计时倍率', type: 'number', section: 'features' },
  { key: 'CHAOXING_VIDEO_REPORT_INTERVAL_MS', label: '学习通视频上报间隔', type: 'number', section: 'features' },
  { key: 'CHAOXING_ANSWER_PROVIDER_URL', label: '学习通答案源地址', type: 'text', section: 'features' },
  { key: 'CHAOXING_ANSWER_PROVIDER_API_KEY', label: '学习通答案源密钥', type: 'secret', section: 'features' },
  { key: 'CHAOXING_ANSWER_PROVIDER_TIMEOUT_MS', label: '学习通答案源超时', type: 'number', section: 'features' },
  { key: 'GENSHIN_ALLOWED_GROUPS', label: '原神白名单群', type: 'text', section: 'features' },
  { key: 'GENSHIN_PUBLIC_BASE_URL', label: '原神绑定外部地址', type: 'text', section: 'features' },
  { key: 'GENSHIN_BIND_PAGE_PATH', label: '原神绑定页路径', type: 'text', section: 'features' },
  { key: 'GENSHIN_BIND_TOKEN_TTL_MS', label: '原神绑定链接有效期', type: 'number', section: 'features' },
  { key: 'GENSHIN_CREDENTIAL_KEK_PATH', label: '原神凭据 KEK 路径', type: 'text', section: 'features' },
  { key: 'GENSHIN_AUTO_SIGN_ENABLED', label: '原神自动签到', type: 'toggle', section: 'features' },
  { key: 'GENSHIN_AUTO_SIGN_CRON', label: '原神自动签到时间', type: 'text', section: 'features' },
  { key: 'GENSHIN_TIMEZONE', label: '原神时区', type: 'text', section: 'features' },
  { key: 'GENSHIN_TAKUMI_APP_VERSION', label: '原神米游社 App 版本', type: 'text', section: 'features' },
  { key: 'GENSHIN_SIGN_ACT_ID', label: '原神签到活动 ID', type: 'text', section: 'features' },
  { key: 'GENSHIN_REDEEM_GAME_VERSION', label: '原神兑换接口版本', type: 'text', section: 'features' },
  { key: 'CHATLUNA_COMMON_FS_ALLOWED_GROUPS', label: '文件系统工具白名单群', type: 'text', section: 'features' },
  { key: 'QQBOT_REALTIME_MESSAGE_MAX_INJECT_COUNT', label: '实时消息注入条数上限', type: 'number', section: 'features' },
  { key: 'QQBOT_REPLY_INTERRUPT_ENABLED', label: '回复期中断', type: 'toggle', section: 'features' },
  { key: 'CHATLUNA_COMMON_FS', label: '文件系统工具总开关', type: 'toggle', section: 'features' },
  { key: 'CHATLUNA_COMMON_FS_SCOPE_PATH', label: '文件系统作用域目录', type: 'text', section: 'features' },
  { key: 'CHATLUNA_ACTIVE_TAB', label: '当前对话模型 Tab', type: 'text', section: 'model' },
  { key: 'CHATLUNA_PLATFORM', label: '当前对话模型平台', type: 'text', section: 'model' },
  { key: 'CHATLUNA_BASE_URL', label: '对话模型接口地址', type: 'text', section: 'model' },
  { key: 'CHATLUNA_API_KEY', label: '对话模型接口密钥', type: 'secret', section: 'model' },
  { key: 'CHATLUNA_DEFAULT_MODEL', label: '对话默认模型', type: 'text', section: 'model' },
  { key: 'CHATLUNA_MAX_CONTEXT_RATIO', label: '上下文窗口使用比例', type: 'number', section: 'model' },
  { key: 'CHATLUNA_SILICONFLOW_BASE_URL', label: '硅基流动接口地址', type: 'text', section: 'model' },
  { key: 'CHATLUNA_SILICONFLOW_API_KEY', label: '硅基流动接口密钥', type: 'secret', section: 'model' },
  { key: 'CHATLUNA_SILICONFLOW_DEFAULT_MODEL', label: '硅基流动默认模型', type: 'text', section: 'model' },
  { key: 'CHATLUNA_OPENAI_BASE_URL', label: 'OpenAI 接口地址', type: 'text', section: 'model' },
  { key: 'CHATLUNA_OPENAI_API_KEY', label: 'OpenAI 接口密钥', type: 'secret', section: 'model' },
  { key: 'CHATLUNA_OPENAI_DEFAULT_MODEL', label: 'OpenAI 默认模型', type: 'text', section: 'model' },
  { key: 'CHATLUNA_CODEX_BASE_URL', label: 'Codex 接口地址', type: 'text', section: 'model' },
  { key: 'CHATLUNA_CODEX_API_KEY', label: 'Codex Bridge 密钥', type: 'secret', section: 'model' },
  { key: 'CHATLUNA_CODEX_DEFAULT_MODEL', label: 'Codex 默认模型', type: 'text', section: 'model' },
  { key: 'CHATLUNA_CODEX_REASONING_EFFORT', label: 'Codex 思考程度', type: 'text', section: 'model' },
  { key: 'CHATLUNA_COPILOT_BASE_URL', label: 'GitHub Copilot 接口地址', type: 'text', section: 'model' },
  { key: 'CHATLUNA_COPILOT_API_KEY', label: 'GitHub Copilot Bridge 密钥', type: 'secret', section: 'model' },
  { key: 'CHATLUNA_COPILOT_DEFAULT_MODEL', label: 'GitHub Copilot 默认模型', type: 'text', section: 'model' },
  { key: 'CHATLUNA_DEEPSEEK_BASE_URL', label: 'DeepSeek 接口地址', type: 'text', section: 'model' },
  { key: 'CHATLUNA_DEEPSEEK_API_KEY', label: 'DeepSeek 接口密钥', type: 'secret', section: 'model' },
  { key: 'CHATLUNA_DEEPSEEK_DEFAULT_MODEL', label: 'DeepSeek 默认模型', type: 'text', section: 'model' },
  { key: 'CHATLUNA_MIMO_BASE_URL', label: 'MIMO 接口地址', type: 'text', section: 'model' },
  { key: 'CHATLUNA_MIMO_API_KEY', label: 'MIMO 接口密钥', type: 'secret', section: 'model' },
  { key: 'CHATLUNA_MIMO_DEFAULT_MODEL', label: 'MIMO 默认模型', type: 'text', section: 'model' },
  { key: 'MEMORY_ENABLED', label: '长期记忆', type: 'toggle', section: 'features' },
  { key: 'MEMORY_READ_ENABLED', label: '长期记忆召回', type: 'toggle', section: 'features' },
  { key: 'MEMORY_WRITE_ENABLED', label: '长期记忆写入', type: 'toggle', section: 'features' },
  { key: 'MEMORY_EXTRACT_BASE_URL', label: '记忆提炼接口地址', type: 'text', section: 'model' },
  { key: 'MEMORY_EXTRACT_API_KEY', label: '记忆提炼接口密钥', type: 'secret', section: 'model' },
  { key: 'MEMORY_EXTRACT_MODEL', label: '记忆提炼模型', type: 'text', section: 'model' },
  { key: 'MEMORY_EXTRACT_TIMEOUT_MS', label: '记忆提炼超时', type: 'number', section: 'model' },
  { key: 'MEMORY_EXTRACT_REQUEST_MODE', label: '记忆提炼请求模式', type: 'text', section: 'model' },
  { key: 'MEMORY_EXTRACT_STRUCTURED_OUTPUT_PROTOCOL', label: '记忆提炼输出协议', type: 'text', section: 'model' },
  { key: 'MEMORY_EXTRACT_SUPPORTS_JSON_MODE', label: '记忆提炼 JSON mode', type: 'toggle', section: 'model' },
  { key: 'MEMORY_EMBED_BASE_URL', label: '记忆向量接口地址', type: 'text', section: 'model' },
  { key: 'MEMORY_EMBED_API_KEY', label: '记忆向量接口密钥', type: 'secret', section: 'model' },
  { key: 'MEMORY_EMBED_MODEL', label: '记忆向量模型', type: 'text', section: 'model' },
  { key: 'MEMORY_EMBED_TIMEOUT_MS', label: '记忆向量超时', type: 'number', section: 'model' },
  { key: 'MEMORY_QUERY_TOPK', label: '记忆召回 TopK', type: 'number', section: 'model' },
  { key: 'MEMORY_PROMPT_BUDGET_TOKENS', label: '记忆 prompt 预算', type: 'number', section: 'model' },
  { key: 'MEMORY_EMBED_BATCH_SIZE', label: '记忆向量批量', type: 'number', section: 'model' },
  { key: 'MEMORY_EXTRACT_IDLE_MS', label: '记忆提炼静默窗口', type: 'number', section: 'model' },
  { key: 'MEMORY_EXTRACT_MESSAGE_BATCH', label: '记忆提炼消息数', type: 'number', section: 'model' },
  { key: 'MEMORY_ARCHIVE_DAYS', label: '记忆归档天数', type: 'number', section: 'model' },
  { key: 'MEMORY_MAX_JOB_RETRIES', label: '记忆任务重试', type: 'number', section: 'model' },
  { key: 'MEMORY_JOB_LOCK_TIMEOUT_MS', label: '记忆任务锁超时', type: 'number', section: 'model' },
  { key: 'CHATLUNA_DEFAULT_PRESET', label: '默认预设', type: 'text', section: 'model' },
  { key: 'CHAT_NATURAL_TRIGGER_ALIASES', label: '触发别名', type: 'text', section: 'basic' },
];

export const ADMIN_ENV_KEYS = new Set(ADMIN_ENV_FIELDS.map((field) => field.key));
export const ADMIN_SERVICE_UNITS: readonly BotServiceUnit[] = [
  'qqbot.target',
  'qqbot-pmhq.service',
  'qqbot-llbot.service',
  'qqbot-koishi.service',
  'cloudflared-qqbot-hbu-jw.service',
  'cloudflared-qqbot-genshin.service',
  'qqbot-voice-tts.service',
  'qqbot-voice-tts-tailnet.service',
] as const;

const ADMIN_SERVER_SERVICE_UNITS: readonly BotServiceUnit[] = [
  'qqbot.target',
  'qqbot-pmhq.service',
  'qqbot-llbot.service',
  'qqbot-koishi.service',
  'cloudflared-qqbot-hbu-jw.service',
  'cloudflared-qqbot-genshin.service',
] as const;

const ASYNC_RESTART_UNITS = new Set<BotServiceUnit>([
  'qqbot.target',
  'qqbot-koishi.service',
]);

function defaultFs(): FsLike {
  return {
    access,
    copyFile,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
  };
}

function defaultExec(file: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<ExecResult> {
  return execFile(file, args, options) as Promise<ExecResult>;
}

function ensureManagedKey(key: string): void {
  if (!ADMIN_ENV_KEYS.has(key)) {
    throw new Error(`不支持这个配置项：${key}`);
  }
}

function expandHomePath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function normalizeManagedGroupList(value: string): string {
  return value
    .split(/[,\s，、]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(',');
}

function normalizeManagedEnvValue(key: string, value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  if (key === 'CHATLUNA_COMMON_FS_SCOPE_PATH') {
    return expandHomePath(value.trim());
  }
  if (
    key === 'CHAT_NATURAL_TRIGGER_GROUPS' ||
    key === 'CHATLUNA_COMMON_FS_ALLOWED_GROUPS' ||
    key === 'HBU_JW_ALLOWED_GROUPS' ||
    key === 'ZYH_ALLOWED_GROUPS' ||
    key === 'ZYH_NATURAL_TRIGGER_GROUPS' ||
    key === 'HBU_SECOND_CLASS_ALLOWED_GROUPS' ||
    key === 'HBU_SECOND_CLASS_NATURAL_TRIGGER_GROUPS' ||
    key === 'CHAOXING_ALLOWED_GROUPS' ||
    key === 'GENSHIN_ALLOWED_GROUPS'
  ) {
    return normalizeManagedGroupList(value);
  }
  return value;
}

function isExplicitTrue(value: string | undefined): boolean {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

function readManagedEnvPatchFromFileSync(filePath: string | null | undefined): Partial<Record<string, string>> {
  if (!filePath || !existsSync(filePath)) return {};
  return readManagedEnvPatchFromContent(readFileSync(filePath, 'utf8'));
}

function buildManagedAgentComputerConfig(env: Record<string, string>) {
  return {
    defaultProvider: 'local',
    idleTimeoutMs: 600000,
    local: {
      enabled: isExplicitTrue(env.CHATLUNA_COMMON_FS),
      sandboxMode: 'workspace-write',
      approvalMode: 'never',
      dangerouslySkipPermissions: true,
      preferredShell: 'auto',
      scopePath: String(normalizeManagedEnvValue('CHATLUNA_COMMON_FS_SCOPE_PATH', env.CHATLUNA_COMMON_FS_SCOPE_PATH) ?? ''),
      writableRoots: [],
      readOnlyRoots: [],
      denyRoots: [],
      ignores: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/.yarn/**',
        '**/coverage/**',
        '**/.next/**',
        '**/.nuxt/**',
        '**/out/**',
        '**/.cache/**',
        '**/.vscode/**',
        '**/.idea/**',
        '**/temp/**',
        '**/tmp/**',
      ],
      allowedCommands: [],
      blockedCommands: [],
      commandTimeoutMs: 30000,
      networkPolicy: 'allow',
    },
    e2b: {
      enabled: false,
      apiKey: '',
      template: 'base',
      desktopTemplate: '',
      timeoutMs: 300000,
      keepAlive: true,
    },
    openTerminal: {
      enabled: false,
      baseUrl: '',
      apiKey: '',
      deploymentMode: 'unknown',
      userIsolation: false,
    },
  };
}

function readJsonRecordSync(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function syncManagedChatLunaAgentConfig(rootDir: string, env: Record<string, string>): string {
  const configPath = join(rootDir, CHATLUNA_AGENT_CONFIG_RELATIVE);
  const existing = existsSync(configPath) ? readJsonRecordSync(configPath) : {};
  const next = {
    ...existing,
    version: typeof existing.version === 'number' ? existing.version : 4,
    computer: buildManagedAgentComputerConfig(env),
  };
  const nextContent = `${JSON.stringify(next, null, 2)}\n`;
  const currentContent = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;
  if (currentContent === nextContent) return configPath;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, nextContent, 'utf8');
  return configPath;
}

export function buildModelTabsStateFromEnv(env: Record<string, string>): AdminModelTabsState {
  const activeTab = resolveMainChatActiveTabFromEnv(env) as AdminModelTabId;
  const tabs = MAIN_CHAT_BUILTIN_TAB_IDS.map((id) => resolveMainChatTabStateFromEnv(id, env) as AdminBuiltinModelTab);

  return {
    activeTab,
    tabs,
  };
}

function cloneStaticDeepSeekModelOptions(): AdminModelOption[] {
  return DEEPSEEK_OFFICIAL_MODEL_OPTIONS.map((option) => ({ ...option }));
}

function cloneStaticMimoModelOptions(): AdminModelOption[] {
  return MIMO_CHAT_MODEL_OPTIONS.map((option) => ({ ...option }));
}

function normalizeProviderBaseUrl(value: unknown, fallback: string): string {
  const normalized = String(value ?? '').trim().replace(/\/+$/u, '');
  return normalized || fallback;
}

function normalizeDeepSeekBaseUrl(value: unknown): string {
  return normalizeProviderBaseUrl(value, DEEPSEEK_DEFAULT_BASE_URL);
}

function normalizeMimoBaseUrl(value: unknown): string {
  return normalizeProviderBaseUrl(value, MIMO_DEFAULT_BASE_URL);
}

function normalizeDeepSeekModelList(models: readonly AdminModelOption[]): AdminModelOption[] {
  const result: AdminModelOption[] = [];
  const seen = new Set<string>();
  for (const item of models) {
    const modelId = normalizeDeepSeekModelId(item.modelId);
    if (!modelId || seen.has(modelId)) continue;
    const staticOption = DEEPSEEK_OFFICIAL_MODEL_OPTIONS.find((option) => option.modelId === modelId) as AdminModelOption | undefined;
    result.push({
      modelId,
      label: item.label?.trim() || staticOption?.label || modelId,
      deprecated: item.deprecated ?? staticOption?.deprecated,
      deprecationDate: item.deprecationDate ?? staticOption?.deprecationDate,
    });
    seen.add(modelId);
  }
  return result;
}

function normalizeMimoModelList(models: readonly AdminModelOption[]): AdminModelOption[] {
  const result: AdminModelOption[] = [];
  const seen = new Set<string>();
  for (const item of models) {
    const modelId = normalizeMimoModelId(item.modelId);
    if (!modelId || seen.has(modelId)) continue;
    const staticOption = MIMO_CHAT_MODEL_OPTIONS.find((option) => option.modelId === modelId) as AdminModelOption | undefined;
    if (!staticOption) continue;
    result.push({
      modelId,
      label: item.label?.trim() || staticOption.label || modelId,
      deprecated: item.deprecated,
      deprecationDate: item.deprecationDate,
    });
    seen.add(modelId);
  }
  return result;
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCopilotModelList(models: readonly AdminModelOption[]): AdminModelOption[] {
  const result: AdminModelOption[] = [];
  const seen = new Set<string>();
  for (const item of models) {
    const modelId = normalizeCopilotModelId(item.modelId);
    if (!modelId || seen.has(modelId)) continue;
    const metadataTags = item.metadataTags
      ?.map((tag) => tag.trim())
      .filter(Boolean);
    result.push({
      modelId,
      label: item.label?.trim() || modelId,
      rateLabel: item.rateLabel?.trim() || undefined,
      requestMode: item.requestMode,
      structuredOutputProtocol: item.structuredOutputProtocol,
      metadataTags: metadataTags && metadataTags.length > 0 ? [...new Set(metadataTags)] : undefined,
      deprecated: item.deprecated,
      deprecationDate: item.deprecationDate,
    });
    seen.add(modelId);
  }
  return result;
}

function normalizeCodexModelList(models: readonly AdminModelOption[]): AdminModelOption[] {
  const result: AdminModelOption[] = [];
  const seen = new Set<string>();
  for (const item of models) {
    const modelId = normalizeCodexModelId(item.modelId);
    if (!modelId || seen.has(modelId)) continue;
    result.push({
      modelId,
      label: item.label?.trim() || modelId,
      requestMode: 'responses',
      structuredOutputProtocol: 'native_responses_json_schema',
      deprecated: item.deprecated,
      deprecationDate: item.deprecationDate,
    });
    seen.add(modelId);
  }
  return result;
}

function parseCodexModelListPayload(payload: unknown): AdminModelOption[] {
  if (!isObjectRecord(payload)) return [];
  const data = payload.data;
  if (!Array.isArray(data)) return [];
  return normalizeCodexModelList(
    data.flatMap((item): AdminModelOption[] => {
      if (!isObjectRecord(item)) return [];
      const id = readStringField(item, 'id');
      if (!id) return [];
      return [{
        modelId: id,
        label: readStringField(item, 'name') ?? id,
        requestMode: 'responses',
        structuredOutputProtocol: 'native_responses_json_schema',
      }];
    }),
  );
}

function parseCopilotModelListPayload(payload: unknown): AdminModelOption[] {
  if (!isObjectRecord(payload)) return [];
  const data = payload.data;
  if (!Array.isArray(data)) return [];
  return normalizeCopilotModelList(
    data.flatMap((item): AdminModelOption[] => {
      if (!isObjectRecord(item)) return [];
      const id = readStringField(item, 'id');
      if (!id) return [];
      const qqbot = isObjectRecord(item.qqbot) ? item.qqbot : {};
      const requestMode = readStringField(qqbot, 'requestMode');
      const structuredOutputProtocol = readStringField(qqbot, 'structuredOutputProtocol');
      return [{
        modelId: id,
        label: readStringField(item, 'name') ?? id,
        rateLabel: readStringField(qqbot, 'rateLabel') ?? undefined,
        requestMode: requestMode === 'responses' ? 'responses' : 'chat_completions',
        structuredOutputProtocol: structuredOutputProtocol === 'native_responses_json_schema'
          ? 'native_responses_json_schema'
          : structuredOutputProtocol === 'chat_reply_v1'
            ? 'chat_reply_v1'
            : 'native_chat_json_schema',
      }];
    }),
  );
}

function staticDeepSeekModelList(error: string | null): DeepSeekModelListResponse {
  return {
    source: 'static',
    models: cloneStaticDeepSeekModelOptions(),
    error,
  };
}

function staticMimoModelList(error: string | null): MimoModelListResponse {
  return {
    source: 'static',
    models: cloneStaticMimoModelOptions(),
    error,
  };
}

function parseDeepSeekModelListPayload(payload: unknown): AdminModelOption[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return normalizeDeepSeekModelList(
    data.flatMap((item): AdminModelOption[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const id = (item as { id?: unknown }).id;
      if (typeof id !== 'string' || !id.trim()) return [];
      return [{ modelId: id.trim(), label: id.trim() }];
    }),
  );
}

function parseMimoModelListPayload(payload: unknown): AdminModelOption[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return normalizeMimoModelList(
    data.flatMap((item): AdminModelOption[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const id = (item as { id?: unknown }).id;
      if (typeof id !== 'string' || !id.trim()) return [];
      return [{ modelId: id.trim(), label: id.trim() }];
    }),
  );
}

function unavailableCopilotModelList(error: string | null): CopilotModelListResponse {
  return {
    source: 'dynamic',
    models: [],
    error,
  };
}

function unavailableCodexCatalog(error: string): CodexCatalogState {
  return {
    source: 'dynamic',
    status: 'unavailable',
    clientVersion: null,
    fetchedAt: null,
    error,
  };
}

function unavailableCodexModelList(error: string | null, catalog: CodexCatalogState): CodexModelListResponse {
  return {
    source: 'dynamic',
    models: [],
    error,
    catalog,
  };
}

function parseCodexCatalogState(payload: unknown): CodexCatalogState | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const qqbot = (payload as { qqbot?: unknown }).qqbot;
  if (!qqbot || typeof qqbot !== 'object' || Array.isArray(qqbot)) return null;
  const catalog = (qqbot as { catalog?: unknown }).catalog;
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return null;
  const value = catalog as Partial<CodexCatalogState>;
  if (value.source !== 'dynamic') return null;
  if (!['ready', 'degraded', 'unavailable'].includes(String(value.status))) return null;
  return {
    source: 'dynamic',
    status: value.status as CodexCatalogState['status'],
    clientVersion: typeof value.clientVersion === 'string' ? value.clientVersion : null,
    fetchedAt: typeof value.fetchedAt === 'string' ? value.fetchedAt : null,
    error: typeof value.error === 'string' ? value.error : null,
  };
}

function parseBridgeErrorMessage(body: string): string | null {
  try {
    const payload = JSON.parse(body) as { error?: { message?: unknown } };
    return typeof payload.error?.message === 'string' && payload.error.message.trim()
      ? payload.error.message.trim()
      : null;
  } catch {
    return null;
  }
}

export async function listCopilotModelsFromOAuthBridge(
  bridge: CopilotBridgeStateProvider | undefined,
): Promise<CopilotModelListResponse> {
  if (!bridge?.proxyModels) {
    return unavailableCopilotModelList('GitHub Copilot OAuth bridge is unavailable.');
  }

  try {
    const status = await bridge.getAdminStatus({ probe: true });
    if (status.authStatus !== 'ready') {
      throw new Error(status.authError ?? `GitHub Copilot OAuth status is ${status.authStatus}.`);
    }
    const response = await bridge.proxyModels();
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub Copilot /models returned HTTP ${response.status}: ${response.body.slice(0, 240)}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(response.body) as unknown;
    } catch (error) {
      throw new Error(`GitHub Copilot /models returned non-JSON response: ${error instanceof Error ? error.message : String(error)}`);
    }

    const models = parseCopilotModelListPayload(payload);
    if (models.length === 0) {
      throw new Error('GitHub Copilot /models returned no Auto entry.');
    }
    return {
      source: 'dynamic',
      models,
      error: null,
    };
  } catch (error) {
    return unavailableCopilotModelList(error instanceof Error ? error.message : String(error));
  }
}

export async function listCodexModelsFromOAuthBridge(
  bridge: CodexBridgeStateProvider | undefined,
): Promise<CodexModelListResponse> {
  const bridgeUnavailable = 'Codex OAuth bridge is unavailable.';
  if (!bridge?.proxyModels) {
    return unavailableCodexModelList(bridgeUnavailable, unavailableCodexCatalog(bridgeUnavailable));
  }

  let catalog = await bridge.getCatalogStatus().catch((error) => unavailableCodexCatalog(
    error instanceof Error ? error.message : String(error),
  ));
  try {
    const response = await bridge.proxyModels({ forceRefresh: true });
    catalog = await bridge.getCatalogStatus().catch(() => catalog);
    if (response.status < 200 || response.status >= 300) {
      const detail = parseBridgeErrorMessage(response.body) ?? response.body.slice(0, 240);
      throw new Error(`Codex /models returned HTTP ${response.status}: ${detail}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(response.body) as unknown;
    } catch (error) {
      throw new Error(`Codex /models returned non-JSON response: ${error instanceof Error ? error.message : String(error)}`);
    }

    const models = parseCodexModelListPayload(payload);
    catalog = parseCodexCatalogState(payload) ?? catalog;
    if (models.length === 0) {
      throw new Error('Codex /models returned no visible API-supported models.');
    }
    return {
      source: 'dynamic',
      models,
      error: null,
      catalog,
    };
  } catch (error) {
    return unavailableCodexModelList(error instanceof Error ? error.message : String(error), catalog);
  }
}

export async function listDeepSeekModelsFromOfficialSource(
  request: DeepSeekModelListRequest,
): Promise<DeepSeekModelListResponse> {
  const baseUrl = normalizeDeepSeekBaseUrl(request.baseUrl);
  const apiKey = String(request.apiKey ?? '').trim();
  if (!apiKey) {
    return staticDeepSeekModelList('DeepSeek API key is missing; using official static fallback.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEEPSEEK_MODEL_LIST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`DeepSeek /models returned HTTP ${response.status}: ${text.slice(0, 240)}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`DeepSeek /models returned non-JSON response: ${error instanceof Error ? error.message : String(error)}`);
    }

    const models = parseDeepSeekModelListPayload(payload);
    if (models.length === 0) {
      throw new Error('DeepSeek /models returned no model ids.');
    }

    return {
      source: 'dynamic',
      models,
      error: null,
    };
  } catch (error) {
    return staticDeepSeekModelList(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

export async function listMimoModelsFromOfficialSource(
  request: MimoModelListRequest,
): Promise<MimoModelListResponse> {
  const baseUrl = normalizeMimoBaseUrl(request.baseUrl);
  const apiKey = String(request.apiKey ?? '').trim();
  if (!apiKey) {
    return staticMimoModelList('MIMO API key is missing; using static fallback.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MIMO_MODEL_LIST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MIMO /models returned HTTP ${response.status}: ${text.slice(0, 240)}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`MIMO /models returned non-JSON response: ${error instanceof Error ? error.message : String(error)}`);
    }

    const models = parseMimoModelListPayload(payload);
    if (models.length === 0) {
      throw new Error('MIMO /models returned no allowed chat model ids.');
    }

    return {
      source: 'dynamic',
      models,
      error: null,
    };
  } catch (error) {
    return staticMimoModelList(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

type NormalizeModelTabInputOptions = {
  codexModelIds?: readonly string[];
  copilotModelIds?: readonly string[];
  deepseekModelIds?: readonly string[];
  mimoModelIds?: readonly string[];
  /** When false, validation errors are skipped (used for tabs the user did not touch in this save). */
  validate?: boolean;
  /** Existing env-derived state for this tab; used to fill blanks instead of zero defaults. */
  existing?: AdminBuiltinModelTab;
};

function normalizeModelTabInput(
  input: Partial<AdminBuiltinModelTab> | null | undefined,
  options: NormalizeModelTabInputOptions = {},
): AdminBuiltinModelTab {
  const id = normalizeMainChatBuiltinTabId(input?.id) as AdminModelTabId;
  const fallbackTab = options.existing ?? (resolveMainChatTabStateFromEnv(id, readManagedEnvFromContent('')) as AdminBuiltinModelTab);
  const definition = getBuiltinMainChatTabDefinition(id);
  const strategy = getMainChatProviderStrategy(definition.strategyId);
  const rawModel = String(input?.defaultModel ?? fallbackTab.defaultModel ?? '').trim();
  const normalizedModel = strategy.normalizeModel(rawModel) ?? '';
  const reasoningEffort = id === 'codex'
    ? normalizeCodexReasoningEffort(input?.reasoningEffort ?? fallbackTab.reasoningEffort) ?? CODEX_DEFAULT_REASONING_EFFORT
    : null;
  if (options.validate !== false) {
    const validation = validateMainChatTabModel(id, normalizedModel || rawModel, {
      codexDynamicModelIds: options.codexModelIds,
      copilotModelIds: options.copilotModelIds,
      deepseekDynamicModelIds: options.deepseekModelIds,
      mimoDynamicModelIds: options.mimoModelIds,
    });
    if (!validation.ok) {
      throw new Error(validation.message ?? `${definition.title} Tab 的默认模型不合法：${normalizedModel || rawModel || '空值'}`);
    }
  }
  const requestMode = strategy.resolveRequestMode(normalizedModel);
  const structuredOutputProtocol = strategy.resolveStructuredOutputProtocol(normalizedModel);
  const adminDescription = strategy.describeForAdmin(normalizedModel, { reasoningEffort });
  const normalized: AdminBuiltinModelTab = {
    id,
    title: definition.title,
    provider: definition.provider,
    strategyId: fallbackTab.strategyId,
    requestMode,
    structuredOutputProtocol,
    description: adminDescription.description,
    modelHint: adminDescription.modelHint,
    authKind: fallbackTab.authKind,
    authStatus: fallbackTab.authStatus,
    accountLabel: fallbackTab.accountLabel,
    authError: fallbackTab.authError,
    tokenExpiresAt: fallbackTab.tokenExpiresAt,
    baseUrl: id === 'siliconflow'
      ? definition.defaultBaseUrl
      : id === 'deepseek'
        ? normalizeDeepSeekBaseUrl(input?.baseUrl ?? fallbackTab.baseUrl)
        : id === 'mimo'
          ? normalizeMimoBaseUrl(input?.baseUrl ?? fallbackTab.baseUrl)
          : id === 'codex'
            ? String(input?.baseUrl ?? fallbackTab.baseUrl ?? definition.defaultBaseUrl).trim()
          : String(input?.baseUrl ?? fallbackTab.baseUrl ?? '').trim(),
    apiKey: String(input?.apiKey !== undefined ? input.apiKey : fallbackTab.apiKey || '').trim(),
    defaultModel: normalizedModel,
    reasoningEffort,
    canonicalModel: normalizedModel,
    transportModel: strategy.transportModel(normalizedModel) ?? normalizedModel,
  };

  return normalized;
}

export function parseEnvLines(content: string): EnvLine[] {
  return content.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return { type: 'other', value: line };
    return { type: 'kv', key: match[1], rawValue: match[2] };
  });
}

export function parseEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return trimmed;
}

export function readManagedEnvFromContent(content: string): Record<string, string> {
  return mergeManagedEnvRecords(readManagedEnvPatchFromContent(content));
}

export function readManagedEnvPatchFromContent(content: string): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {};
  for (const line of parseEnvLines(content)) {
    if (line.type !== 'kv' || !ADMIN_ENV_KEYS.has(line.key)) continue;
    result[line.key] = parseEnvValue(line.rawValue);
  }
  return result;
}

export function mergeManagedEnvRecords(...records: Array<Partial<Record<string, string>>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ADMIN_ENV_KEYS) {
    result[key] = '';
  }

  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (!ADMIN_ENV_KEYS.has(key)) continue;
      const normalized = value ?? '';
      if (normalized === '' && result[key]) continue;
      result[key] = normalized;
    }
  }
  return result;
}

export function formatEnvValue(value: string): string {
  if (value === '') return '';
  if (/^[A-Za-z0-9_./,:@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function applyEnvPatchToContent(content: string, patch: EnvPatch): string {
  for (const key of Object.keys(patch)) {
    ensureManagedKey(key);
  }

  const lines = parseEnvLines(content);
  const pending = new Map<string, string | null>();
  for (const [key, value] of Object.entries(patch)) {
    pending.set(key, value == null ? null : String(value));
  }

  const output: string[] = [];
  for (const line of lines) {
    if (line.type !== 'kv' || !pending.has(line.key)) {
      output.push(line.type === 'kv' ? `${line.key}=${line.rawValue}` : line.value);
      continue;
    }

    const nextValue = pending.get(line.key);
    pending.delete(line.key);
    if (nextValue == null) continue;
    output.push(`${line.key}=${formatEnvValue(nextValue)}`);
  }

  if (output.length && output[output.length - 1] !== '') {
    output.push('');
  }

  for (const [key, value] of pending.entries()) {
    if (value == null) continue;
    output.push(`${key}=${formatEnvValue(value)}`);
  }

  return `${output.join('\n').replace(/\n+$/g, '')}\n`;
}

export function resolveBotEnvFilePath(rootDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.QQBOT_ENV_FILE?.trim();
  if (explicit) {
    return explicit.startsWith('/') ? explicit : resolve(rootDir, explicit);
  }

  const localEnvPath = join(rootDir, LOCAL_ENV_FILE_BASENAME);
  if (existsSync(localEnvPath)) {
    return localEnvPath;
  }

  const serverEnvPath = join(rootDir, SERVER_ENV_FILE_BASENAME);
  if (existsSync(serverEnvPath)) {
    return serverEnvPath;
  }

  return localEnvPath;
}

function resolvePathLike(rootDir: string, filePath: string): string {
  return filePath.startsWith('/') ? filePath : resolve(rootDir, filePath);
}

export function resolveBotEnvFiles(rootDir: string, env: NodeJS.ProcessEnv = process.env): ResolvedEnvFiles {
  const explicitBase = env.QQBOT_ENV_BASE_FILE?.trim();
  const explicitOverride = env.QQBOT_ENV_OVERRIDE_FILE?.trim();
  if (!explicitBase && !explicitOverride) {
    const envFilePath = resolveBotEnvFilePath(rootDir, env);
    if (envFilePath.endsWith(`/${LOCAL_ENV_FILE_BASENAME}`) || envFilePath.endsWith(`\\${LOCAL_ENV_FILE_BASENAME}`)) {
      const overrideFilePath = join(rootDir, LOCAL_RUNTIME_ENV_RELATIVE);
      return {
        mode: 'layered',
        baseFilePath: envFilePath,
        overrideFilePath,
        editTarget: overrideFilePath,
      };
    }
    return {
      mode: 'single',
      baseFilePath: envFilePath,
      overrideFilePath: null,
      editTarget: envFilePath,
    };
  }

  return {
    mode: 'layered',
    baseFilePath: resolvePathLike(rootDir, explicitBase || join(rootDir, SERVER_ENV_FILE_BASENAME)),
    overrideFilePath: resolvePathLike(rootDir, explicitOverride || join(rootDir, RUNTIME_ENV_FILE_BASENAME)),
    editTarget: resolvePathLike(rootDir, explicitOverride || join(rootDir, RUNTIME_ENV_FILE_BASENAME)),
  };
}

function splitPresetDirs(rawValue: string | undefined, rootDir: string): string[] {
  return [...new Set(
    String(rawValue ?? '')
      .split(delimiter)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => resolvePathLike(rootDir, part)),
  )];
}

export function resolveBotPresetPaths(rootDir: string, env: NodeJS.ProcessEnv = process.env): ResolvedPresetPaths {
  const runtimeDir = env.CHATLUNA_RUNTIME_PRESET_DIR?.trim();
  const configuredDirs = splitPresetDirs(env.CHATLUNA_PRESET_DIRS, rootDir);
  if (!runtimeDir && configuredDirs.length === 0) {
    const singleDirPath = join(rootDir, PRESET_DIR_RELATIVE);
    return {
      mode: 'single',
      runtimeDirPath: singleDirPath,
      bundledDirPaths: [],
      allDirPaths: [singleDirPath],
    };
  }

  const runtimeDirPath = resolvePathLike(rootDir, runtimeDir || configuredDirs[0] || join(rootDir, PRESET_DIR_RELATIVE));
  const allDirPaths = [...new Set([runtimeDirPath, ...configuredDirs])];

  return {
    mode: 'layered',
    runtimeDirPath,
    bundledDirPaths: allDirPaths.filter((dirPath) => dirPath !== runtimeDirPath),
    allDirPaths,
  };
}

async function readFileIfExists(fsLike: FsLike, filePath: string | null): Promise<string> {
  if (!filePath) return '';
  try {
    return await fsLike.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

type WriteFileAtomicWithBackupOptions = {
  backupDir: string;
  fs?: FsLike;
  timestamp?: Date;
};

export function resolveBackupDirectory(rootDir: string, filePath: string): string {
  const absoluteRootDir = resolve(rootDir);
  const absoluteFilePath = resolve(filePath);
  const relativeFilePath = relative(absoluteRootDir, absoluteFilePath);
  const isInsideRoot = relativeFilePath && !relativeFilePath.startsWith('..') && !relativeFilePath.startsWith('/');

  if (!isInsideRoot) {
    return join(dirname(absoluteFilePath), 'backup');
  }

  const [topLevelDir] = relativeFilePath.split('/');
  if (topLevelDir === 'data') return join(absoluteRootDir, 'data', 'backup');
  if (topLevelDir === 'config') return join(absoluteRootDir, 'config', 'backup');
  if (topLevelDir === '.runtime') return join(absoluteRootDir, '.runtime', 'backup');
  return join(absoluteRootDir, 'backup');
}

export async function writeFileAtomicWithBackup(
  filePath: string,
  content: string,
  options: WriteFileAtomicWithBackupOptions,
): Promise<{ backupPath: string; tempPath: string }> {
  const fsLike = options.fs ?? defaultFs();
  const timestamp = options.timestamp ?? new Date();
  const stamp = timestamp.toISOString().replace(/[:.]/g, '-');
  const backupPath = join(options.backupDir, `${basename(filePath)}.bak.${stamp}`);
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;

  await fsLike.mkdir(dirname(filePath), { recursive: true });
  await fsLike.mkdir(options.backupDir, { recursive: true });
  try {
    await fsLike.copyFile(filePath, backupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    await fsLike.writeFile(tempPath, content, 'utf8');
    await fsLike.rename(tempPath, filePath);
  } catch (error) {
    await fsLike.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return { backupPath, tempPath };
}

export function parseSystemdShowOutput(text: string, unit: BotServiceUnit): BotServiceStatus {
  const values = Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf('=');
        if (index < 0) return [line, ''];
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );

  const activeState = values.ActiveState || 'unknown';
  const unitFileState = values.UnitFileState || 'unknown';
  const subState = values.SubState || 'unknown';
  const runtimeState = activeState === 'active'
    ? 'healthy'
    : activeState === 'inactive' || activeState === 'failed'
      ? 'stopped'
      : 'unknown';
  return {
    unit,
    description: values.Description || unit,
    runtimeState,
    controllerState: {
      loadState: values.LoadState || 'unknown',
      activeState,
      subState,
      unitFileState,
      result: values.Result || 'unknown',
      invocationId: values.InvocationID || null,
    },
    checkedAt: Date.now(),
    healthDetail: `systemd 当前状态为 ${activeState}/${subState}`,
    canStart: activeState !== 'active',
    canStop: activeState === 'active',
    canRestart: activeState === 'active',
    canEnable: !['enabled', 'static', 'generated'].includes(unitFileState),
  };
}

export function validateServiceAction(unit: string, action: string): asserts unit is BotServiceUnit & string {
  if (!ADMIN_SERVICE_UNITS.includes(unit as BotServiceUnit)) {
    throw new Error(`不支持这个服务：${unit}`);
  }
  if (!['start', 'stop', 'restart', 'enable'].includes(action)) {
    throw new Error(`不支持这个操作：${action}`);
  }
}

function isServerEnvFilePath(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  return filePath.endsWith(`/${SERVER_ENV_FILE_BASENAME}`) || filePath.endsWith(`\\${SERVER_ENV_FILE_BASENAME}`);
}

export function resolveManagedServiceUnits(baseFilePath: string | null | undefined): readonly BotServiceUnit[] {
  if (isServerEnvFilePath(baseFilePath)) {
    return ADMIN_SERVER_SERVICE_UNITS;
  }
  return ADMIN_SERVICE_UNITS;
}

export function resolveApplyRestartUnits(
  reasons: readonly AdminApplyReason[],
  managedUnits: readonly BotServiceUnit[],
): BotServiceUnit[] {
  const managed = new Set(managedUnits);
  const units: BotServiceUnit[] = [];
  if (reasons.includes('tts')) {
    if (!managed.has('qqbot-voice-tts.service')) {
      throw new Error('当前运行角色无法重启待应用的 TTS 服务。');
    }
    units.push('qqbot-voice-tts.service');
  }
  if (reasons.some((reason) => reason !== 'tts')) {
    if (!managed.has('qqbot-koishi.service')) {
      throw new Error('当前运行角色无法重启待应用的 Koishi 服务。');
    }
    units.push('qqbot-koishi.service');
  }
  return units;
}

function resolveSystemdScope(baseFilePath: string | null | undefined): SystemdScope {
  return isServerEnvFilePath(baseFilePath) ? 'system' : 'user';
}

function withSystemdScope(scope: SystemdScope, args: string[]): string[] {
  return scope === 'user' ? ['--user', ...args] : args;
}

export function normalizePresetDocument(input: PresetDocument): PresetDocument {
  const name = input.name.trim();
  if (!name) throw new Error('预设名不能为空。');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error('预设名只能包含字母、数字、点号、下划线或短横线。');
  }

  const keywords = (input.keywords ?? []).map((item) => item.trim()).filter(Boolean);
  const prompts = (input.prompts ?? []).map((prompt) => ({
    role: prompt.role,
    content: prompt.content.trim(),
  }));

  if (!prompts.length) {
    throw new Error('至少需要保留一段提示词。');
  }

  for (const prompt of prompts) {
    if (!PRESET_ROLE_SET.has(prompt.role)) {
      throw new Error(`不支持这个角色类型：${prompt.role}`);
    }
    if (!prompt.content) {
      throw new Error('提示词内容不能为空。');
    }
  }

  return {
    name,
    originalName: input.originalName?.trim() || undefined,
    path: input.path,
    source: input.source ?? 'runtime',
    keywords,
    prompts,
  };
}

export function serializePresetDocument(input: PresetDocument): string {
  const document = normalizePresetDocument(input);
  return YAML.stringify({
    keywords: document.keywords,
    prompts: document.prompts,
  });
}

export function parsePresetDocument(name: string, path: string, raw: string, source: PresetSource = 'runtime'): PresetDocument {
  const parsed = YAML.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('预设文件格式不正确。');
  }
  const keywords = Array.isArray((parsed as { keywords?: unknown }).keywords)
    ? (parsed as { keywords: unknown[] }).keywords.map((item) => String(item))
    : [];
  const prompts = Array.isArray((parsed as { prompts?: unknown }).prompts)
    ? (parsed as { prompts: Array<{ role?: unknown; content?: unknown }> }).prompts.map((item) => ({
        role: String(item?.role ?? '') as PresetDocument['prompts'][number]['role'],
        content: String(item?.content ?? ''),
      }))
    : [];

  return normalizePresetDocument({
    name,
    path,
    source,
    raw,
    keywords,
    prompts,
  });
}

export class AdminRuntimeManager {
  readonly rootDir: string;
  readonly envFiles: ResolvedEnvFiles;
  readonly runtimePresetDirPath: string;
  readonly bundledPresetDirPaths: string[];
  readonly allPresetDirPaths: string[];
  readonly ttsEnvFilePath: string;
  readonly fs: FsLike;
  readonly execFile: (file: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;
  readonly fetchFn: typeof fetch;
  readonly copilotBridge?: CopilotBridgeStateProvider;
  readonly codexBridge?: CodexBridgeStateProvider;
  private ttsHealth: AdminTtsHealthSnapshot | null = null;

  constructor(options: AdminRuntimeManagerOptions = {}) {
    this.rootDir = options.rootDir ? resolve(options.rootDir) : DEFAULT_ROOT_DIR;
    this.envFiles =
      options.envBaseFilePath || options.envOverrideFilePath
        ? {
            mode: 'layered',
            baseFilePath: options.envBaseFilePath ? resolve(this.rootDir, options.envBaseFilePath) : join(this.rootDir, SERVER_ENV_FILE_BASENAME),
            overrideFilePath: options.envOverrideFilePath
              ? resolve(this.rootDir, options.envOverrideFilePath)
              : join(this.rootDir, RUNTIME_ENV_FILE_BASENAME),
            editTarget: options.envOverrideFilePath
              ? resolve(this.rootDir, options.envOverrideFilePath)
              : join(this.rootDir, RUNTIME_ENV_FILE_BASENAME),
          }
        : options.envFilePath
          ? {
              mode: 'single',
              baseFilePath: resolve(this.rootDir, options.envFilePath),
              overrideFilePath: null,
              editTarget: resolve(this.rootDir, options.envFilePath),
            }
          : resolveBotEnvFiles(this.rootDir);
    if (options.runtimePresetDirPath || options.bundledPresetDirPaths) {
      this.runtimePresetDirPath = options.runtimePresetDirPath
        ? resolve(this.rootDir, options.runtimePresetDirPath)
        : options.presetDirPath
          ? resolve(this.rootDir, options.presetDirPath)
          : join(this.rootDir, PRESET_DIR_RELATIVE);
      this.bundledPresetDirPaths = (options.bundledPresetDirPaths ?? []).map((dirPath) => resolve(this.rootDir, dirPath));
      this.allPresetDirPaths = [...new Set([this.runtimePresetDirPath, ...this.bundledPresetDirPaths])];
    } else if (options.presetDirPath) {
      this.runtimePresetDirPath = resolve(this.rootDir, options.presetDirPath);
      this.bundledPresetDirPaths = [];
      this.allPresetDirPaths = [this.runtimePresetDirPath];
    } else {
      const presetPaths = resolveBotPresetPaths(this.rootDir);
      this.runtimePresetDirPath = presetPaths.runtimeDirPath;
      this.bundledPresetDirPaths = presetPaths.bundledDirPaths;
      this.allPresetDirPaths = presetPaths.allDirPaths;
    }
    this.ttsEnvFilePath = options.ttsEnvFilePath
      ? resolve(this.rootDir, options.ttsEnvFilePath)
      : resolveTtsEnvFilePath(this.rootDir);
    this.fs = options.fs ?? defaultFs();
    this.execFile = options.execFile ?? defaultExec;
    this.fetchFn = options.fetchFn ?? fetch;
    this.copilotBridge = options.copilotBridge;
    this.codexBridge = options.codexBridge;
  }

  get managedServiceUnits(): readonly BotServiceUnit[] {
    return resolveManagedServiceUnits(this.envFiles.baseFilePath);
  }

  private get systemdScope(): SystemdScope {
    return resolveSystemdScope(this.envFiles.baseFilePath);
  }

  private get canManageLocalTtsGateway(): boolean {
    return this.managedServiceUnits.includes('qqbot-voice-tts.service');
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await this.fs.access(filePath, fsConstants.F_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  private async readTtsLocalEnvState(): Promise<{
    content: string;
    envFileExists: boolean;
    env: Record<string, string>;
  }> {
    const [content, envFileExists] = await Promise.all([
      readFileIfExists(this.fs, this.ttsEnvFilePath),
      this.fileExists(this.ttsEnvFilePath),
    ]);
    return {
      content,
      envFileExists,
      env: mergeTtsLocalEnvRecords(this.rootDir, readTtsLocalEnvPatchFromContent(content)),
    };
  }

  private async readCurrentBotEnv(): Promise<Record<string, string>> {
    const [baseEnvContent, overrideEnvContent] = await Promise.all([
      readFileIfExists(this.fs, this.envFiles.baseFilePath),
      readFileIfExists(this.fs, this.envFiles.overrideFilePath),
    ]);
    return mergeManagedEnvRecords(
      readManagedEnvPatchFromContent(baseEnvContent),
      readManagedEnvPatchFromContent(overrideEnvContent),
    );
  }

  async getManagedEnv(): Promise<Record<string, string>> {
    return this.readCurrentBotEnv();
  }

  getEnvFilesState(): AdminEnvFilesState {
    return {
      mode: this.envFiles.mode,
      baseFile: this.envFiles.baseFilePath,
      overrideFile: this.envFiles.overrideFilePath,
      editTarget: this.envFiles.editTarget,
    };
  }

  async getModelTabsState(): Promise<AdminModelTabsState> {
    const env = await this.readCurrentBotEnv();
    return this.decorateModelTabsState(buildModelTabsStateFromEnv(env));
  }

  async getTtsState(): Promise<AdminTtsState> {
    return this.buildTtsState(await this.readCurrentBotEnv());
  }

  private async buildTtsState(botEnv: Record<string, string>): Promise<AdminTtsState> {
    const local = await this.readTtsLocalEnvState();
    const localGateway = buildTtsLocalGatewayState({
      rootDir: this.rootDir,
      envFile: this.ttsEnvFilePath,
      envFileExists: local.envFileExists,
      manageable: this.canManageLocalTtsGateway,
      env: local.env,
    });
    const targetBaseUrl = resolveConfiguredTtsBaseUrl(botEnv, localGateway);
    const health = this.ttsHealth?.targetBaseUrl === targetBaseUrl
      ? this.ttsHealth
      : createUnknownTtsHealth(targetBaseUrl);
    return {
      localGateway,
      health,
    };
  }

  async getPreset(name: string): Promise<PresetDocument> {
    const normalized = normalizePresetDocument({ name, keywords: [], prompts: [{ role: 'system', content: 'x' }] }).name;
    const summary = await this.findPresetSummaryByName(normalized);
    if (!summary) {
      throw new Error(`找不到预设：${normalized}`);
    }
    const raw = await this.fs.readFile(summary.path, 'utf8');
    return parsePresetDocument(normalized, summary.path, raw, summary.source);
  }

  syncManagedChatLunaAgentConfig(env?: Record<string, string>): string {
    const mergedEnv = env ?? mergeManagedEnvRecords(
      readManagedEnvPatchFromFileSync(this.envFiles.baseFilePath),
      readManagedEnvPatchFromFileSync(this.envFiles.overrideFilePath),
    );
    return syncManagedChatLunaAgentConfig(this.rootDir, mergedEnv);
  }

  async saveEnv(patch: EnvPatch): Promise<Record<string, string>> {
    const normalizedPatch = Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [key, normalizeManagedEnvValue(key, value)]),
    ) as EnvPatch;
    const [baseContent, currentTargetContent] = await Promise.all([
      readFileIfExists(this.fs, this.envFiles.baseFilePath),
      readFileIfExists(this.fs, this.envFiles.editTarget),
    ]);
    const nextTargetContent = applyEnvPatchToContent(currentTargetContent, normalizedPatch);
    await writeFileAtomicWithBackup(this.envFiles.editTarget, nextTargetContent, {
      backupDir: resolveBackupDirectory(this.rootDir, this.envFiles.editTarget),
      fs: this.fs,
    });
    const env = mergeManagedEnvRecords(
      readManagedEnvPatchFromContent(baseContent),
      readManagedEnvPatchFromContent(nextTargetContent),
    );
    this.syncManagedChatLunaAgentConfig(env);
    return env;
  }

  async saveTtsSettings(input: SaveTtsSettingsRequest): Promise<SaveTtsSettingsResponse> {
    const botEnvPatch = input.botEnv ?? {};
    const localEnvPatch = input.localEnv ?? {};
    const hasBotEnvPatch = Object.keys(botEnvPatch).length > 0;
    const hasLocalEnvPatch = Object.keys(localEnvPatch).length > 0;

    let env: Record<string, string>;
    if (hasBotEnvPatch) {
      env = await this.saveEnv(botEnvPatch);
    } else {
      const [baseEnvContent, overrideEnvContent] = await Promise.all([
        readFileIfExists(this.fs, this.envFiles.baseFilePath),
        readFileIfExists(this.fs, this.envFiles.overrideFilePath),
      ]);
      env = mergeManagedEnvRecords(
        readManagedEnvPatchFromContent(baseEnvContent),
        readManagedEnvPatchFromContent(overrideEnvContent),
      );
    }

    if (hasLocalEnvPatch) {
      if (!this.canManageLocalTtsGateway) {
        throw new Error('当前运行角色不管理本机 TTS 网关配置。');
      }
      const local = await this.readTtsLocalEnvState();
      const nextContent = applyTtsLocalEnvPatchToContent(local.content, localEnvPatch);
      await writeFileAtomicWithBackup(this.ttsEnvFilePath, nextContent, {
        backupDir: resolveBackupDirectory(this.rootDir, this.ttsEnvFilePath),
        fs: this.fs,
      });
      this.ttsHealth = null;
    }

    return {
      env,
      tts: await this.buildTtsState(env),
      restartRequired: {
        bot: hasBotEnvPatch,
        tts: hasLocalEnvPatch,
      },
    };
  }

  private async resolveTtsHttpTarget(): Promise<{
    botEnv: Record<string, string>;
    localGateway: AdminTtsState['localGateway'];
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  }> {
    const botEnv = await this.readCurrentBotEnv();
    const tts = await this.buildTtsState(botEnv);
    const baseUrl = resolveConfiguredTtsBaseUrl(botEnv, tts.localGateway);
    const apiKey = botEnv.QQ_VOICE_TTS_API_KEY || tts.localGateway.env.VOICE_TTS_API_KEY || '';
    const timeoutMs = Number(botEnv.QQ_VOICE_SYNTH_TIMEOUT_MS || '') || tts.localGateway.resolved.requestTimeoutSeconds * 1000;
    if (!baseUrl) {
      throw new Error('TTS 服务地址未配置。');
    }
    return {
      botEnv,
      localGateway: tts.localGateway,
      baseUrl,
      apiKey,
      timeoutMs,
    };
  }

  async probeTtsHealth(): Promise<AdminTtsHealthSnapshot> {
    const target = await this.resolveTtsHttpTarget();
    const checkedAt = Date.now();
    const startedAt = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(target.timeoutMs, 10_000));
    try {
      const response = await fetch(`${target.baseUrl}/healthz`, {
        headers: target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {},
        signal: controller.signal,
      });
      const latencyMs = Math.round(performance.now() - startedAt);
      const text = await response.text();
      let payload: unknown = {};
      try {
        payload = text ? JSON.parse(text) as unknown : {};
      } catch {
        payload = { status: response.ok ? 'ok' : 'degraded', lastError: text.slice(0, 240) };
      }
      const health = parseTtsHealthPayload(target.baseUrl, checkedAt, latencyMs, payload);
      this.ttsHealth = response.ok
        ? health
        : {
            ...health,
            status: 'degraded',
            error: health.error ?? `TTS health returned HTTP ${response.status}`,
          };
      return this.ttsHealth;
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startedAt);
      this.ttsHealth = createUnreachableTtsHealth(
        target.baseUrl,
        checkedAt,
        latencyMs,
        error instanceof Error ? error.message : String(error),
      );
      return this.ttsHealth;
    } finally {
      clearTimeout(timer);
    }
  }

  async synthesizeTtsAudio(input: SynthesizeTtsSampleRequest): Promise<TtsAudioSample> {
    const text = String(input.text ?? '').trim();
    const style: AdminTtsStyleId = input.style === 'black' ? 'black' : 'white';
    if (!text) {
      throw new Error('试听文本不能为空。');
    }
    if (text.length > 500) {
      throw new Error('试听文本不能超过 500 字符。');
    }

    const target = await this.resolveTtsHttpTarget();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), target.timeoutMs);
    const startedAt = performance.now();
    try {
      const response = await fetch(`${target.baseUrl}/synthesize`, {
        method: 'POST',
        headers: {
          ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          speaker: 'sakiko',
          style,
          format: 'wav',
        }),
        signal: controller.signal,
      });
      const elapsedMs = Math.round(performance.now() - startedAt);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!response.ok) {
        const detail = Buffer.from(bytes).toString('utf8').slice(0, 240);
        throw new Error(detail || `TTS synthesize returned HTTP ${response.status}`);
      }
      const audio = parseWavInfo(bytes);
      const contentType = response.headers.get('content-type') || 'audio/wav';
      return {
        data: bytes,
        elapsedMs,
        contentType,
        durationSeconds: audio.durationSeconds,
        sampleRate: audio.sampleRate,
        channels: audio.channels,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async saveModelTabs(input: SaveModelTabsRequest): Promise<{ env: Record<string, string>; modelTabs: AdminModelTabsState }> {
    const env = await this.saveEnv(await this.buildModelTabsPatch(input));
    return {
      env,
      modelTabs: await this.decorateModelTabsState(buildModelTabsStateFromEnv(env)),
    };
  }

  async listDeepSeekModels(input: DeepSeekModelListRequest): Promise<DeepSeekModelListResponse> {
    return listDeepSeekModelsFromOfficialSource(input);
  }

  async listCopilotModels(): Promise<CopilotModelListResponse> {
    return listCopilotModelsFromOAuthBridge(this.copilotBridge);
  }

  async listCodexModels(): Promise<CodexModelListResponse> {
    return listCodexModelsFromOAuthBridge(this.codexBridge);
  }

  async listMimoModels(input: MimoModelListRequest): Promise<MimoModelListResponse> {
    return listMimoModelsFromOfficialSource(input);
  }

  async savePreset(document: PresetDocument): Promise<PresetDocument> {
    const normalized = normalizePresetDocument(document);
    const targetPath = this.resolveRuntimePresetPath(normalized.name);
    const sourceName = normalized.originalName?.trim() || normalized.name;
    const sourceSummary = sourceName ? await this.findPresetSummaryByName(sourceName) : null;

    if (sourceName !== normalized.name && !sourceSummary) {
      throw new Error(`找不到预设：${sourceName}`);
    }

    const raw = serializePresetDocument(normalized);
    await this.fs.mkdir(this.runtimePresetDirPath, { recursive: true });
    await this.fs.writeFile(targetPath, raw, 'utf8');

    if (sourceName !== normalized.name && normalized.source === 'runtime' && sourceSummary?.source === 'runtime') {
      const sourcePath = this.resolveRuntimePresetPath(sourceName);
      await this.fs.rm(sourcePath, { force: true });
    }

    await this.updatePresetOrder((names) => {
      if (sourceName !== normalized.name) {
        if (normalized.source === 'runtime') {
          const sourceIndex = names.indexOf(sourceName);
          if (sourceIndex >= 0) {
            names.splice(sourceIndex, 1, normalized.name);
          } else if (!names.includes(normalized.name)) {
            names.push(normalized.name);
          }
          return names;
        }

        if (!names.includes(normalized.name)) {
          names.push(normalized.name);
        }
        return names;
      }

      if (!names.includes(normalized.name)) {
        names.push(normalized.name);
      }
      return names;
    });

    return {
      ...normalized,
      path: targetPath,
      source: 'runtime',
      raw,
    };
  }

  async deletePreset(name: string, defaultPreset: string): Promise<void> {
    const normalized = normalizePresetDocument({ name, keywords: [], prompts: [{ role: 'system', content: 'x' }] }).name;
    if (normalized === defaultPreset) {
      throw new Error('不能删除当前正在使用的默认预设。');
    }
    const preset = await this.findPresetSummaryByName(normalized);
    if (!preset) {
      throw new Error(`找不到预设：${normalized}`);
    }
    if (preset.source !== 'runtime') {
      throw new Error('只能删除运行时预设；仓库内置预设请通过代码仓库修改。');
    }
    await this.fs.rm(this.resolveRuntimePresetPath(normalized), { force: true });
    const bundledFallback = await this.findBundledPresetSummaryByName(normalized);
    await this.updatePresetOrder((names) => (bundledFallback ? names : names.filter((item) => item !== normalized)));
  }

  async reorderPresets(names: string[]): Promise<PresetSummary[]> {
    const normalizedNames = names.map((name) =>
      normalizePresetDocument({ name, keywords: [], prompts: [{ role: 'system', content: 'x' }] }).name,
    );
    const uniqueNames = [...new Set(normalizedNames)];
    const presets = await this.readPresetSummariesFromDisk();
    const presetNames = presets.map((preset) => preset.name);

    if (uniqueNames.length !== presetNames.length) {
      throw new Error('预设排序数据不完整。');
    }

    const presetNameSet = new Set(presetNames);
    if (uniqueNames.some((name) => !presetNameSet.has(name))) {
      throw new Error('预设排序包含不存在的预设。');
    }

    await this.writePresetOrder(uniqueNames);
    return this.sortPresetSummaries(presets, uniqueNames);
  }

  async scheduleRestart(unit: BotServiceUnit): Promise<void> {
    const transientUnit = `${unit.replaceAll(/[^A-Za-z0-9]+/g, '-')}-restart-${Date.now()}`;
    const scope = this.systemdScope;
    await this.execFile(
      'systemd-run',
      [
        ...withSystemdScope(scope, []),
        '--quiet',
        '--on-active=1s',
        `--unit=${transientUnit}`,
        'systemctl',
        ...withSystemdScope(scope, []),
        'restart',
        unit,
      ],
      { cwd: this.rootDir, timeout: 15_000 },
    );
  }

  async runServiceAction(unit: BotServiceUnit, action: ServiceAction): Promise<BotServiceStatus> {
    validateServiceAction(unit, action);
    if (!this.managedServiceUnits.includes(unit)) {
      throw new Error(`当前运行角色不支持这个服务：${unit}`);
    }
    if (action === 'restart' && ASYNC_RESTART_UNITS.has(unit)) {
      // Hand restarts that can terminate the current request off to a transient
      // user unit so the admin response can return before systemd stops Koishi.
      await this.scheduleRestart(unit);
      return this.getServiceStatus(unit);
    }
    const timeout = unit === 'qqbot-pmhq.service' && (action === 'start' || action === 'restart') ? 180_000 : 15_000;
    await this.execFile('systemctl', withSystemdScope(this.systemdScope, [action, unit]), { cwd: this.rootDir, timeout });
    return this.getServiceStatus(unit);
  }

  async restartForApplyReasons(reasons: readonly AdminApplyReason[]): Promise<AdminApplyRestartTarget[]> {
    const units = resolveApplyRestartUnits(reasons, this.managedServiceUnits);
    const targets = await Promise.all(units.map(async (unit) => {
      const status = await this.getServiceStatus(unit);
      return {
        unit,
        previousInvocationId: status.controllerState.invocationId,
      };
    }));
    for (const unit of units) {
      await this.runServiceAction(unit, 'restart');
    }
    return targets;
  }

  async getServiceStatuses(): Promise<BotServiceStatus[]> {
    return Promise.all(this.managedServiceUnits.map((unit) => this.getServiceStatus(unit)));
  }

  async getServiceStatus(unit: BotServiceUnit): Promise<BotServiceStatus> {
    validateServiceAction(unit, 'start');
    if (!this.managedServiceUnits.includes(unit)) {
      throw new Error(`当前运行角色不支持这个服务：${unit}`);
    }
    const { stdout } = await this.execFile(
      'systemctl',
      withSystemdScope(this.systemdScope, [
        'show',
        unit,
        '--property',
        'Description,LoadState,ActiveState,SubState,UnitFileState,Result,InvocationID',
      ]),
      { cwd: this.rootDir, timeout: 15_000 },
    );
    const status = parseSystemdShowOutput(stdout, unit);
    if (unit !== 'qqbot-pmhq.service') return status;
    return this.probePmhqHealth(status);
  }

  private async probePmhqHealth(status: BotServiceStatus): Promise<BotServiceStatus> {
    try {
      const response = await this.fetchFn('http://127.0.0.1:13000/health', {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        return {
          ...status,
          runtimeState: status.controllerState.activeState === 'active' ? 'degraded' : 'stopped',
          checkedAt: Date.now(),
          healthDetail: `PMHQ health endpoint 返回 HTTP ${response.status}`,
        };
      }
      const controllerActive = status.controllerState.activeState === 'active';
      return {
        ...status,
        runtimeState: controllerActive ? 'healthy' : 'degraded',
        checkedAt: Date.now(),
        healthDetail: controllerActive
          ? 'PMHQ health endpoint 正常'
          : `PMHQ 工作负载健康，systemd 控制状态为 ${status.controllerState.activeState}/${status.controllerState.subState}`,
      };
    } catch (error) {
      return {
        ...status,
        runtimeState: status.controllerState.activeState === 'active' ? 'degraded' : 'stopped',
        checkedAt: Date.now(),
        healthDetail: `PMHQ health endpoint 无法访问：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async readServiceFailureJournal(afterCursor: string | null): Promise<{
    entries: Array<{
      cursor: string;
      bootId: string;
      invocationId: string;
      unit: BotServiceUnit;
      result: string;
      message: string;
      occurredAt: number;
    }>;
    cursor: string | null;
  }> {
    const args = [
      ...(this.systemdScope === 'user' ? ['--user'] : []),
      '--no-pager',
      '--output=json',
      '--show-cursor',
      ...(afterCursor ? [`--after-cursor=${afterCursor}`] : ['--boot']),
      'MESSAGE_ID=be02cf6855d2428ba40df7e9d022f03d',
    ];
    const { stdout } = await this.execFile('journalctl', args, { cwd: this.rootDir, timeout: 15_000 });
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const cursorLine = lines.filter((line) => line.startsWith('-- cursor: ')).at(-1);
    const entries = lines.flatMap((line) => {
      if (!line.startsWith('{')) return [];
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return [];
      }
      const unit = String(record.UNIT ?? '');
      if (!this.managedServiceUnits.includes(unit as BotServiceUnit)) return [];
      const invocationId = String(record.INVOCATION_ID ?? '');
      const cursor = String(record.__CURSOR ?? '');
      const bootId = String(record._BOOT_ID ?? '');
      if (!invocationId || !cursor || !bootId) return [];
      const realtimeMicros = Number(record.__REALTIME_TIMESTAMP ?? 0);
      return [{
        cursor,
        bootId,
        invocationId,
        unit: unit as BotServiceUnit,
        result: String(record.JOB_RESULT ?? 'failed'),
        message: typeof record.MESSAGE === 'string' ? record.MESSAGE : `Failed to start ${unit}`,
        occurredAt: Number.isFinite(realtimeMicros) ? Math.floor(realtimeMicros / 1_000) : Date.now(),
      }];
    });
    return {
      entries,
      cursor: cursorLine?.slice('-- cursor: '.length).trim() || entries.at(-1)?.cursor || afterCursor,
    };
  }

  async readServiceInvocationJournal(unit: BotServiceUnit, invocationId: string): Promise<string[]> {
    validateServiceAction(unit, 'start');
    if (!this.managedServiceUnits.includes(unit)) throw new Error(`当前运行角色不支持这个服务：${unit}`);
    if (!/^[a-f0-9]{32}$/i.test(invocationId)) throw new Error('systemd invocation id 格式无效');
    const { stdout } = await this.execFile('journalctl', [
      ...(this.systemdScope === 'user' ? ['--user'] : []),
      '--no-pager',
      '--output=short-iso',
      '--lines=200',
      `_SYSTEMD_INVOCATION_ID=${invocationId}`,
      '+',
      `INVOCATION_ID=${invocationId}`,
    ], { cwd: this.rootDir, timeout: 15_000 });
    return stdout.split(/\r?\n/).filter(Boolean);
  }

  async listPresetSummaries(): Promise<PresetSummary[]> {
    await this.fs.mkdir(this.runtimePresetDirPath, { recursive: true });
    const presets = await this.readPresetSummariesFromDisk();
    const order = await this.readPresetOrder();
    return this.sortPresetSummaries(presets, order);
  }

  private async readPresetSummariesFromDisk(): Promise<PresetSummary[]> {
    const presets = new Map<string, PresetSummary>();
    for (const dirPath of this.allPresetDirPaths) {
      let entries: Array<{ isFile(): boolean; name: string }>;
      try {
        entries = (await this.fs.readdir(dirPath, { withFileTypes: true })) as Array<{ isFile(): boolean; name: string }>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
          continue;
        }
        throw error;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.yml')) continue;
        const name = entry.name.slice(0, -4);
        if (presets.has(name)) continue;
        presets.set(name, {
          name,
          path: join(dirPath, entry.name),
          source: dirPath === this.runtimePresetDirPath ? 'runtime' : 'bundled',
        });
      }
    }

    return [...presets.values()];
  }

  private sortPresetSummaries(presets: PresetSummary[], order: readonly string[]): PresetSummary[] {
    const rank = new Map(order.map((name, index) => [name, index]));
    return [...presets].sort((left, right) => {
      const leftRank = rank.get(left.name);
      const rightRank = rank.get(right.name);
      if (leftRank != null || rightRank != null) {
        if (leftRank == null) return 1;
        if (rightRank == null) return -1;
        return leftRank - rightRank;
      }
      return left.name.localeCompare(right.name, 'zh-CN');
    });
  }

  private async readPresetOrder(): Promise<string[]> {
    try {
      const raw = await this.fs.readFile(this.getPresetOrderFilePath(), 'utf8');
      const parsed = JSON.parse(raw) as PresetOrderDocument;
      return Array.isArray(parsed?.names)
        ? [...new Set(parsed.names.map((name) => String(name ?? '').trim()).filter(Boolean))]
        : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') return [];
      return [];
    }
  }

  private async writePresetOrder(names: readonly string[]): Promise<void> {
    const filePath = this.getPresetOrderFilePath();
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    const content = `${JSON.stringify({ names }, null, 2)}\n`;
    await this.fs.mkdir(this.runtimePresetDirPath, { recursive: true });
    await this.fs.writeFile(tempPath, content, 'utf8');
    await this.fs.rename(tempPath, filePath);
  }

  private async updatePresetOrder(mutator: (names: string[]) => string[]): Promise<void> {
    const current = await this.readPresetOrder();
    const next = [...new Set(mutator([...current]).map((name) => name.trim()).filter(Boolean))];
    await this.writePresetOrder(next);
  }

  private getPresetOrderFilePath(): string {
    return join(this.runtimePresetDirPath, PRESET_ORDER_FILENAME);
  }

  resolvePresetPath(name: string): string {
    return this.resolveRuntimePresetPath(name);
  }

  resolveRuntimePresetPath(name: string): string {
    return join(this.runtimePresetDirPath, `${name}.yml`);
  }

  private async assertPresetExists(name: string): Promise<void> {
    const filePath = this.resolveRuntimePresetPath(name);
    await this.fs.access(filePath, fsConstants.F_OK);
  }

  private async findPresetSummaryByName(name: string): Promise<PresetSummary | null> {
    const presets = await this.readPresetSummariesFromDisk();
    return presets.find((preset) => preset.name === name) ?? null;
  }

  private async findBundledPresetSummaryByName(name: string): Promise<PresetSummary | null> {
    for (const dirPath of this.bundledPresetDirPaths) {
      const filePath = join(dirPath, `${name}.yml`);
      try {
        await this.fs.access(filePath, fsConstants.F_OK);
        return { name, path: filePath, source: 'bundled' };
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
          throw error;
        }
      }
    }
    return null;
  }

  private async buildModelTabsPatch(input: SaveModelTabsRequest): Promise<EnvPatch> {
    const activeTab = normalizeMainChatBuiltinTabId(input?.activeTab) as AdminModelTabId;
    const providedTabs = Array.isArray(input?.tabs) ? input.tabs : [];
    const dirtyIds = new Set<AdminModelTabId>();
    if (!Array.isArray(input?.dirtyTabIds) || input.dirtyTabIds.length === 0) {
      throw new Error('保存模型 Tab 必须携带已修改的 Tab 列表。');
    }
    for (const value of input.dirtyTabIds) {
      try {
        dirtyIds.add(normalizeMainChatBuiltinTabId(value) as AdminModelTabId);
      } catch {
        throw new Error(`未知模型 Tab：${String(value ?? '')}`);
      }
    }
    if (dirtyIds.size === 0) {
      throw new Error('保存模型 Tab 必须携带已修改的 Tab 列表。');
    }
    dirtyIds.add(activeTab);

    const currentEnvFromDisk = await this.readEffectiveEnv();
    const existingByTab = Object.fromEntries(
      MAIN_CHAT_BUILTIN_TAB_IDS.map((id) => [
        id,
        resolveMainChatTabStateFromEnv(id, currentEnvFromDisk) as AdminBuiltinModelTab,
      ]),
    ) as Record<AdminModelTabId, AdminBuiltinModelTab>;

    let codexModelIds: string[] | undefined;
    if (dirtyIds.has('codex')) {
      const codexModels = await this.listCodexModels();
      if (codexModels.error || codexModels.models.length === 0) {
        throw new Error(`Codex OAuth 模型列表不可用：${codexModels.error ?? '未返回可用模型'}`);
      }
      codexModelIds = codexModels.models.map((model) => model.modelId);
    }

    let copilotModelIds: string[] | undefined;
    if (dirtyIds.has('copilot')) {
      const copilotModels = await this.listCopilotModels();
      if (copilotModels.error || copilotModels.models.length === 0) {
        throw new Error(`GitHub Copilot OAuth 模型列表不可用：${copilotModels.error ?? '未返回可用模型'}`);
      }
      copilotModelIds = copilotModels.models.map((model) => model.modelId);
    }

    const deepseekInput = providedTabs.find((item) => String(item?.id ?? '').trim() === 'deepseek');
    const deepseekModels = await this.listDeepSeekModels({
      baseUrl: deepseekInput?.baseUrl ?? existingByTab.deepseek.baseUrl,
      apiKey: deepseekInput?.apiKey !== undefined ? deepseekInput.apiKey : existingByTab.deepseek.apiKey,
    });
    const deepseekModelIds = deepseekModels.models.map((model) => model.modelId);
    const mimoInput = providedTabs.find((item) => String(item?.id ?? '').trim() === 'mimo');
    const mimoModels = await this.listMimoModels({
      baseUrl: mimoInput?.baseUrl ?? existingByTab.mimo.baseUrl,
      apiKey: mimoInput?.apiKey !== undefined ? mimoInput.apiKey : existingByTab.mimo.apiKey,
    });
    const mimoModelIds = mimoModels.models.map((model) => model.modelId);

    const providedById = new Map<AdminModelTabId, Partial<AdminBuiltinModelTab>>();
    for (const item of providedTabs) {
      const rawId = String(item?.id ?? '').trim();
      let id: AdminModelTabId;
      try {
        id = normalizeMainChatBuiltinTabId(rawId) as AdminModelTabId;
      } catch {
        throw new Error(`未知模型 Tab：${rawId}`);
      }
      if (providedById.has(id)) {
        throw new Error(`重复模型 Tab：${id}`);
      }
      providedById.set(id, item);
    }

    const tabs: AdminBuiltinModelTab[] = MAIN_CHAT_BUILTIN_TAB_IDS.map((id) => {
      const provided = providedById.get(id);
      const existing = existingByTab[id];
      return normalizeModelTabInput(provided ?? existing, {
        codexModelIds,
        copilotModelIds,
        deepseekModelIds,
        mimoModelIds,
        existing,
        validate: dirtyIds.has(id),
      });
    });

    if (this.copilotBridge) {
      const runtime = await this.copilotBridge.getRuntimeConfig().catch(() => null);
      if (runtime) {
        const copilotTab = tabs.find((tab) => tab.id === 'copilot');
        if (copilotTab) {
          if (typeof runtime.baseUrl === 'string' && runtime.baseUrl.trim()) {
            copilotTab.baseUrl = runtime.baseUrl.trim();
          }
          if (typeof runtime.apiKey === 'string' && runtime.apiKey.trim()) {
            copilotTab.apiKey = runtime.apiKey.trim();
          }
        }
      }
    }

    if (this.codexBridge) {
      const runtime = await this.codexBridge.getRuntimeConfig().catch(() => null);
      if (runtime) {
        const codexTab = tabs.find((tab) => tab.id === 'codex');
        if (codexTab) {
          if (typeof runtime.baseUrl === 'string' && runtime.baseUrl.trim()) {
            codexTab.baseUrl = runtime.baseUrl.trim();
          }
          if (typeof runtime.apiKey === 'string' && runtime.apiKey.trim()) {
            codexTab.apiKey = runtime.apiKey.trim();
          }
        }
      }
    }

    return buildMainChatRuntimeEnvPatch(activeTab, tabs);
  }

  private async readEffectiveEnv(): Promise<Record<string, string>> {
    const [baseContent, targetContent] = await Promise.all([
      readFileIfExists(this.fs, this.envFiles.baseFilePath),
      readFileIfExists(this.fs, this.envFiles.editTarget),
    ]);
    return mergeManagedEnvRecords(
      readManagedEnvPatchFromContent(baseContent),
      readManagedEnvPatchFromContent(targetContent),
    );
  }

  private async decorateModelTabsState(state: AdminModelTabsState): Promise<AdminModelTabsState> {
    if (!this.copilotBridge && !this.codexBridge) {
      return state;
    }

    const [copilotRuntime, copilotState, codexRuntime, codexState, codexCatalog] = await Promise.all([
      this.copilotBridge?.getRuntimeConfig().catch(() => null) ?? Promise.resolve(null),
      this.copilotBridge?.getAdminStatus({ probe: false }).catch((error) => ({
        authKind: 'oauth_device' as const,
        authStatus: 'error' as const,
        accountLabel: null,
        authError: error instanceof Error ? error.message : String(error),
        attempt: null,
      })) ?? Promise.resolve(null),
      this.codexBridge?.getRuntimeConfig().catch(() => null) ?? Promise.resolve(null),
      this.codexBridge?.getAdminStatus({ probe: false }).catch((error) => ({
        authKind: 'codex_oauth' as const,
        authStatus: 'error' as const,
        accountLabel: null,
        authError: error instanceof Error ? error.message : String(error),
        tokenExpiresAt: null,
        attempt: null,
      })) ?? Promise.resolve(null),
      this.codexBridge?.getCatalogStatus().catch((error) => unavailableCodexCatalog(
        error instanceof Error ? error.message : String(error),
      )) ?? Promise.resolve(null),
    ]);
    return {
      activeTab: state.activeTab,
      tabs: state.tabs.map((tab) => {
        if (tab.id === 'copilot' && copilotRuntime && copilotState) {
          return {
            ...tab,
            authKind: copilotState.authKind,
            authStatus: copilotState.authStatus,
            accountLabel: copilotState.accountLabel,
            authError: copilotState.authError,
            oauthAttempt: copilotState.attempt,
            baseUrl: copilotRuntime.baseUrl,
            apiKey: copilotRuntime.apiKey,
          };
        }
        if (tab.id === 'codex' && codexRuntime && codexState) {
          return {
            ...tab,
            authKind: codexState.authKind,
            authStatus: codexState.authStatus,
            accountLabel: codexState.accountLabel,
            authError: codexState.authError,
            tokenExpiresAt: codexState.tokenExpiresAt,
            oauthAttempt: codexState.attempt,
            catalog: codexCatalog,
            baseUrl: codexRuntime.baseUrl,
            apiKey: codexRuntime.apiKey,
          };
        }
        return tab;
      }),
    };
  }
}
