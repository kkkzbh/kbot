import { constants as fsConstants, existsSync } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import type {
  AdminApplyReason,
  AdminApplyRestartTarget,
  AdminEnvFilesState,
  AdminTtsHealthSnapshot,
  AdminTtsState,
  AdminTtsStyleId,
  BotServiceStatus,
  BotServiceUnit,
  EnvPatch,
  SaveTtsSettingsRequest,
  SaveTtsSettingsResponse,
  SynthesizeTtsSampleRequest,
  ServiceAction,
} from '../../types/admin.js';
import type {
  AdminLogEntry,
  AdminLogsResponse,
} from '../../admin/contracts/index.js';
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
  section: 'features';
};

type ExecResult = {
  stdout: string;
  stderr: string;
};

type ProcessOptions = {
  cwd?: string;
  timeout?: number;
};

type ProcessLinesResult = {
  lines: string[];
  stderr: string;
};

export type ScheduledRestartJobPhase =
  | 'scheduled'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export type ScheduledRestartHandle = {
  targetUnit: BotServiceUnit;
  transientUnit: string;
  serviceUnit: string;
  timerUnit: string;
  scheduledAt: number;
};

export type ScheduledRestartJobStatus = ScheduledRestartHandle & {
  phase: ScheduledRestartJobPhase;
  result: string;
  execMainStatus: number | null;
  checkedAt: number;
};

export type ScheduledRestartSupervisionOutcome =
  | {
      state: 'restart_observed';
      job: ScheduledRestartJobStatus | null;
    }
  | {
      state: 'safe_to_release';
      reason: 'job_succeeded_without_restart' | 'job_failed' | 'job_cancelled' | 'monitor_timeout' | 'inspection_failed';
      job: ScheduledRestartJobStatus | null;
    };

export type AdminRestartJobErrorStage = 'schedule' | 'inspect' | 'cancel' | 'verify';

export class AdminRestartJobError extends Error {
  readonly code = 'restart_job_failed';
  readonly operation = 'restart_service';
  readonly stage: AdminRestartJobErrorStage;
  readonly targetUnit: BotServiceUnit;
  readonly transientUnit: string;
  readonly jobPhase: ScheduledRestartJobPhase | null;
  readonly systemdResult: string | null;

  constructor(options: {
    message: string;
    stage: AdminRestartJobErrorStage;
    targetUnit: BotServiceUnit;
    transientUnit: string;
    jobPhase?: ScheduledRestartJobPhase | null;
    systemdResult?: string | null;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = 'AdminRestartJobError';
    this.stage = options.stage;
    this.targetUnit = options.targetUnit;
    this.transientUnit = options.transientUnit;
    this.jobPhase = options.jobPhase ?? null;
    this.systemdResult = normalizeSystemdResult(options.systemdResult);
  }
}

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
  chmod: typeof chmod;
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
  fs?: FsLike;
  execFile?: (file: string, args: string[], options?: ProcessOptions) => Promise<ExecResult>;
  readProcessLines?: (file: string, args: string[], options?: ProcessOptions) => Promise<ProcessLinesResult>;
  fetchFn?: typeof fetch;
};

type SystemdScope = 'system' | 'user';

type RestartUnitControllerState = {
  loadState: string;
  activeState: string;
  subState: string;
  result: string;
  execMainStatus: number | null;
  execMainStarted: boolean;
};

type RestartTargetControllerState = {
  activeState: string;
  subState: string;
  invocationId: string | null;
  job: string | null;
};

type EnvLine =
  | { type: 'kv'; key: string; rawValue: string }
  | { type: 'other'; value: string };

type ResolvedEnvFiles = {
  mode: 'single' | 'layered';
  baseFilePath: string | null;
  overrideFilePath: string | null;
  editTarget: string;
};

const DEFAULT_ROOT_DIR = resolve(process.cwd());
const LOCAL_ENV_FILE_BASENAME = '.env.local';
const SERVER_ENV_FILE_BASENAME = '.env.server';
const RUNTIME_ENV_FILE_BASENAME = '.env.runtime';
const LOCAL_RUNTIME_ENV_RELATIVE = join('.runtime', RUNTIME_ENV_FILE_BASENAME);
const RUNTIME_LOG_RETENTION_LIMIT_BYTES = 4 * 1_024 * 1_024 * 1_024;
const KOISHI_JOURNAL_MESSAGE_PATTERN = /^(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} )?\[([SEWID])\]\s+([^\s]+)\s*(.*)$/u;
const KOISHI_LEVELS: Record<string, AdminLogEntry['level']> = {
  S: 'success',
  E: 'error',
  W: 'warn',
  I: 'info',
  D: 'debug',
};

function journalPriorityLevel(priority: unknown): AdminLogEntry['level'] {
  const value = Number(priority);
  if (Number.isInteger(value) && value <= 3) return 'error';
  if (value === 4) return 'warn';
  if (value === 7) return 'debug';
  return 'info';
}

function runtimeLogEntryFromJournal(record: Record<string, unknown>): AdminLogEntry | null {
  const cursor = String(record.__CURSOR ?? '').trim();
  const id = Number(record.__SEQNUM);
  const timestampMicros = Number(record.__REALTIME_TIMESTAMP);
  const message = typeof record.MESSAGE === 'string' ? record.MESSAGE : '';
  if (!cursor || !Number.isSafeInteger(id) || id < 1 || !Number.isFinite(timestampMicros) || !message) return null;

  const koishi = message.match(KOISHI_JOURNAL_MESSAGE_PATTERN);
  const unit = String(record._SYSTEMD_UNIT ?? record._SYSTEMD_USER_UNIT ?? '').replace(/\.service$/u, '');
  return {
    id,
    cursor,
    timestamp: Math.floor(timestampMicros / 1_000),
    level: koishi ? KOISHI_LEVELS[koishi[1]] ?? journalPriorityLevel(record.PRIORITY) : journalPriorityLevel(record.PRIORITY),
    namespace: koishi?.[2] ?? (unit || String(record.SYSLOG_IDENTIFIER ?? 'runtime')),
    content: koishi?.[3] || message,
  };
}

export function parseJournalDiskUsageBytes(output: string): number {
  const matches = [...output.matchAll(/(\d+(?:\.\d+)?)\s*([KMGT]?)(?:i?B)?/giu)];
  const match = matches.at(-1);
  if (!match) return 0;
  const value = Number(match[1]);
  const multipliers: Record<string, number> = {
    '': 1,
    K: 1_024,
    M: 1_024 ** 2,
    G: 1_024 ** 3,
    T: 1_024 ** 4,
  };
  const bytes = value * (multipliers[match[2]?.toUpperCase() ?? ''] ?? 1);
  return Number.isSafeInteger(Math.round(bytes)) ? Math.round(bytes) : 0;
}

export const ADMIN_ENV_FIELDS: ManagedEnvField[] = [
  { key: 'QQBOT_ANTI_RECALL_ENABLED', label: '防撤回', type: 'toggle', section: 'features' },
  { key: 'QQBOT_ANTI_RECALL_ALLOWED_GROUPS', label: '防撤回生效群', type: 'text', section: 'features' },
  { key: 'QQBOT_REALTIME_MESSAGE_ENABLED', label: '实时消息', type: 'toggle', section: 'features' },
  { key: 'QQ_VOICE_INPUT_ENABLED', label: '语音转文字', type: 'toggle', section: 'features' },
  { key: 'QQ_VOICE_OUTPUT_ENABLED', label: '语音回复', type: 'toggle', section: 'features' },
  { key: 'QQ_VOICE_TTS_BASE_URL', label: 'TTS 服务地址', type: 'text', section: 'features' },
  { key: 'QQ_VOICE_TTS_API_KEY', label: 'TTS 服务密钥', type: 'secret', section: 'features' },
  { key: 'QQ_VOICE_OUTPUT_LANGUAGE', label: '语音文本语言', type: 'text', section: 'features' },
  { key: 'QQ_VOICE_OUTPUT_MAX_WORDS', label: '语音单段字数上限', type: 'number', section: 'features' },
  { key: 'QQ_VOICE_OUTPUT_MAX_SECONDS', label: '语音单段最长秒数', type: 'number', section: 'features' },
  { key: 'QQ_VOICE_SYNTH_TIMEOUT_MS', label: '语音合成超时', type: 'number', section: 'features' },
  { key: 'HBU_JW_ALLOWED_GROUPS', label: '教务系统白名单群', type: 'text', section: 'features' },
  { key: 'HBU_JW_NATURAL_TRIGGER_ENABLED', label: '教务裸命令触发', type: 'toggle', section: 'features' },
  { key: 'HBU_JW_NATURAL_TRIGGER_GROUPS', label: '教务裸命令群', type: 'text', section: 'features' },
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
  { key: 'CHAOXING_NATURAL_TRIGGER_ENABLED', label: '学习通裸命令触发', type: 'toggle', section: 'features' },
  { key: 'CHAOXING_NATURAL_TRIGGER_GROUPS', label: '学习通裸命令群', type: 'text', section: 'features' },
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
  { key: 'GENSHIN_NATURAL_TRIGGER_ENABLED', label: '原神裸命令触发', type: 'toggle', section: 'features' },
  { key: 'GENSHIN_NATURAL_TRIGGER_GROUPS', label: '原神裸命令群', type: 'text', section: 'features' },
  { key: 'GENSHIN_PUBLIC_BASE_URL', label: '原神绑定外部地址', type: 'text', section: 'features' },
  { key: 'GENSHIN_BIND_PAGE_PATH', label: '原神绑定页路径', type: 'text', section: 'features' },
  { key: 'GENSHIN_BIND_TOKEN_TTL_MS', label: '原神绑定链接有效期', type: 'number', section: 'features' },
  { key: 'GENSHIN_CREDENTIAL_KEK_PATH', label: '原神凭据 KEK 路径', type: 'text', section: 'features' },
  { key: 'GENSHIN_AUTO_SIGN_ENABLED', label: '原神自动签到', type: 'toggle', section: 'features' },
  { key: 'GENSHIN_AUTO_SIGN_CRON', label: '原神自动签到时间', type: 'text', section: 'features' },
  { key: 'GENSHIN_TIMEZONE', label: '原神时区', type: 'text', section: 'features' },
  { key: 'GENSHIN_TAKUMI_APP_VERSION', label: '原神米游社 App 版本', type: 'text', section: 'features' },
  { key: 'GENSHIN_SIGN_ACT_ID', label: '原神签到活动 ID', type: 'text', section: 'features' },
  { key: 'CHATLUNA_COMMON_FS_ALLOWED_GROUPS', label: '文件系统工具白名单群', type: 'text', section: 'features' },
  { key: 'QQBOT_REALTIME_MESSAGE_MAX_INJECT_COUNT', label: '实时消息注入条数上限', type: 'number', section: 'features' },
  { key: 'QQBOT_REPLY_INTERRUPT_ENABLED', label: '回复期中断', type: 'toggle', section: 'features' },
  { key: 'CHATLUNA_COMMON_FS', label: '文件系统工具总开关', type: 'toggle', section: 'features' },
  { key: 'CHATLUNA_COMMON_FS_SCOPE_PATH', label: '文件系统作用域目录', type: 'text', section: 'features' },
  { key: 'MEMORY_ENABLED', label: '长期记忆', type: 'toggle', section: 'features' },
  { key: 'MEMORY_READ_ENABLED', label: '长期记忆召回', type: 'toggle', section: 'features' },
  { key: 'MEMORY_WRITE_ENABLED', label: '长期记忆写入', type: 'toggle', section: 'features' },
  { key: 'MEMORY_EXTRACT_IDLE_MS', label: '记忆提炼静默窗口', type: 'number', section: 'features' },
  { key: 'MEMORY_EXTRACT_MESSAGE_BATCH', label: '记忆提炼消息数', type: 'number', section: 'features' },
  { key: 'MEMORY_ARCHIVE_DAYS', label: '记忆归档天数', type: 'number', section: 'features' },
  { key: 'MEMORY_MAX_JOB_RETRIES', label: '记忆任务重试', type: 'number', section: 'features' },
  { key: 'MEMORY_JOB_LOCK_TIMEOUT_MS', label: '记忆任务锁超时', type: 'number', section: 'features' },
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
const RESTART_MONITOR_TIMEOUT_MS = 15_000;
const RESTART_MONITOR_POLL_INTERVAL_MS = 250;

function defaultFs(): FsLike {
  return {
    access,
    chmod,
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

function defaultExec(file: string, args: string[], options?: ProcessOptions): Promise<ExecResult> {
  return execFile(file, args, options) as Promise<ExecResult>;
}

export function readProcessLines(
  file: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<ProcessLinesResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const timer = options.timeout == null
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeout);

    output.on('line', (line) => lines.push(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      output.close();
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise({ lines, stderr });
    };

    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (timedOut) {
        finish(new Error(`${file} timed out after ${options.timeout}ms`));
        return;
      }
      if (code !== 0) {
        const exit = signal ? `signal ${signal}` : `exit code ${code}`;
        const detail = stderr.trim();
        finish(new Error(`${file} failed with ${exit}${detail ? `: ${detail}` : ''}`));
        return;
      }
      finish();
    });
  });
}

function ensureManagedKey(key: string): void {
  if (!ADMIN_ENV_KEYS.has(key)) {
    throw new Error(`不支持这个配置项：${key}`);
  }
}

function normalizeManagedScopePath(value: string): string {
  const normalized = value.trim();
  if (normalized === '~') return homedir();
  if (normalized.startsWith('~/')) return join(homedir(), normalized.slice(2));
  return normalized;
}

function normalizeManagedGroupList(value: string): string {
  return value
    .split(/[,\s，、]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(',');
}

function normalizeAntiRecallAllowedGroups(value: string): string {
  const normalized = normalizeManagedGroupList(value);
  const invalidGroupId = normalized
    .split(',')
    .find((groupId) => groupId && !/^(?:(?:group|guild):)?\d+$/u.test(groupId));
  if (invalidGroupId) {
    throw new Error(`防撤回生效群包含无效 QQ 群号：${invalidGroupId}`);
  }
  return normalized;
}

function normalizeManagedEnvValue(key: string, value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  if (key === 'CHATLUNA_COMMON_FS_SCOPE_PATH') {
    return normalizeManagedScopePath(value);
  }
  if (key === 'QQBOT_ANTI_RECALL_ALLOWED_GROUPS') {
    return normalizeAntiRecallAllowedGroups(value);
  }
  if (
    key === 'CHATLUNA_COMMON_FS_ALLOWED_GROUPS' ||
    key === 'HBU_JW_ALLOWED_GROUPS' ||
    key === 'HBU_JW_NATURAL_TRIGGER_GROUPS' ||
    key === 'ZYH_ALLOWED_GROUPS' ||
    key === 'ZYH_NATURAL_TRIGGER_GROUPS' ||
    key === 'HBU_SECOND_CLASS_ALLOWED_GROUPS' ||
    key === 'HBU_SECOND_CLASS_NATURAL_TRIGGER_GROUPS' ||
    key === 'CHAOXING_ALLOWED_GROUPS' ||
    key === 'CHAOXING_NATURAL_TRIGGER_GROUPS' ||
    key === 'GENSHIN_ALLOWED_GROUPS' ||
    key === 'GENSHIN_NATURAL_TRIGGER_GROUPS'
  ) {
    return normalizeManagedGroupList(value);
  }
  return value;
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
    await fsLike.chmod(tempPath, 0o600);
    await fsLike.rename(tempPath, filePath);
  } catch (error) {
    await fsLike.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return { backupPath, tempPath };
}

function parseSystemdProperties(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf('=');
        if (index < 0) return [line, ''];
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

function parseOptionalInteger(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeSystemdResult(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(normalized) ? normalized : null;
}

export function parseSystemdShowOutput(text: string, unit: BotServiceUnit): BotServiceStatus {
  const values = parseSystemdProperties(text);

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

function resolveScheduledRestartJobPhase(
  timer: RestartUnitControllerState,
  service: RestartUnitControllerState,
): ScheduledRestartJobPhase {
  if (['active', 'activating', 'deactivating', 'reloading'].includes(service.activeState)) {
    return 'running';
  }
  if (timer.activeState === 'active') return 'scheduled';

  const result = normalizeSystemdResult(service.result);
  const timerResult = normalizeSystemdResult(timer.result);
  if (
    timer.activeState === 'failed'
    || (timerResult !== null && timerResult !== 'success' && timerResult !== 'unknown')
    || service.activeState === 'failed'
    || (service.execMainStarted && result !== null && result !== 'success')
    || (service.execMainStarted && service.execMainStatus !== null && service.execMainStatus !== 0)
  ) {
    return 'failed';
  }
  if (service.execMainStarted && result === 'success' && service.execMainStatus === 0) {
    return 'succeeded';
  }
  if (
    (timer.loadState === 'not-found' && service.loadState === 'not-found')
    || (
      timer.activeState === 'inactive'
      && service.activeState === 'inactive'
      && !service.execMainStarted
    )
  ) {
    return 'cancelled';
  }
  return 'unknown';
}

function restartWasObserved(
  previousInvocationId: string | null,
  target: RestartTargetControllerState,
): boolean {
  return target.activeState !== 'active'
    || target.invocationId !== previousInvocationId
    || target.job !== null;
}

export class AdminRuntimeManager {
  readonly rootDir: string;
  readonly envFiles: ResolvedEnvFiles;
  readonly ttsEnvFilePath: string;
  readonly fs: FsLike;
  readonly execFile: (file: string, args: string[], options?: ProcessOptions) => Promise<ExecResult>;
  readonly readProcessLines: (file: string, args: string[], options?: ProcessOptions) => Promise<ProcessLinesResult>;
  readonly fetchFn: typeof fetch;
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
    this.ttsEnvFilePath = options.ttsEnvFilePath
      ? resolve(this.rootDir, options.ttsEnvFilePath)
      : resolveTtsEnvFilePath(this.rootDir);
    this.fs = options.fs ?? defaultFs();
    this.execFile = options.execFile ?? defaultExec;
    this.readProcessLines = options.readProcessLines ?? readProcessLines;
    this.fetchFn = options.fetchFn ?? fetch;
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
    return mergeManagedEnvRecords(
      readManagedEnvPatchFromContent(baseContent),
      readManagedEnvPatchFromContent(nextTargetContent),
    );
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

  async scheduleRestart(unit: BotServiceUnit): Promise<ScheduledRestartHandle> {
    validateServiceAction(unit, 'restart');
    if (!this.managedServiceUnits.includes(unit)) {
      throw new Error(`当前运行角色不支持这个服务：${unit}`);
    }
    const transientUnit = `${unit.replaceAll(/[^A-Za-z0-9]+/g, '-')}-restart-${Date.now()}`;
    const scope = this.systemdScope;
    try {
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
    } catch (error) {
      throw new AdminRestartJobError({
        message: `无法调度 ${unit} 重启任务`,
        stage: 'schedule',
        targetUnit: unit,
        transientUnit,
        cause: error,
      });
    }
    return {
      targetUnit: unit,
      transientUnit,
      serviceUnit: `${transientUnit}.service`,
      timerUnit: `${transientUnit}.timer`,
      scheduledAt: Date.now(),
    };
  }

  async inspectScheduledRestart(handle: ScheduledRestartHandle): Promise<ScheduledRestartJobStatus> {
    this.validateScheduledRestartHandle(handle);
    let timer: RestartUnitControllerState;
    let service: RestartUnitControllerState;
    try {
      [timer, service] = await Promise.all([
        this.readRestartUnitControllerState(handle.timerUnit),
        this.readRestartUnitControllerState(handle.serviceUnit),
      ]);
    } catch (error) {
      throw new AdminRestartJobError({
        message: `无法读取 ${handle.targetUnit} 重启任务状态`,
        stage: 'inspect',
        targetUnit: handle.targetUnit,
        transientUnit: handle.transientUnit,
        cause: error,
      });
    }

    const phase = resolveScheduledRestartJobPhase(timer, service);
    return {
      ...handle,
      phase,
      result: normalizeSystemdResult(service.result) ?? 'unknown',
      execMainStatus: service.execMainStatus,
      checkedAt: Date.now(),
    };
  }

  async superviseScheduledRestart(
    handle: ScheduledRestartHandle,
    previousInvocationId: string | null,
    options: {
      timeoutMs?: number;
      pollIntervalMs?: number;
    } = {},
  ): Promise<ScheduledRestartSupervisionOutcome> {
    this.validateScheduledRestartHandle(handle);
    const timeoutMs = options.timeoutMs ?? RESTART_MONITOR_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? RESTART_MONITOR_POLL_INTERVAL_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError('restart monitor timeout must be a non-negative finite number');
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
      throw new TypeError('restart monitor poll interval must be a non-negative finite number');
    }

    const deadline = Date.now() + timeoutMs;
    let lastJob: ScheduledRestartJobStatus | null = null;
    while (true) {
      try {
        const target = await this.readRestartTargetControllerState(handle.targetUnit);
        if (restartWasObserved(previousInvocationId, target)) {
          return { state: 'restart_observed', job: lastJob };
        }

        lastJob = await this.inspectScheduledRestart(handle);
        if (
          lastJob.phase === 'succeeded'
          || lastJob.phase === 'failed'
          || lastJob.phase === 'cancelled'
        ) {
          return this.cancelRestartAndResolveLease(
            handle,
            previousInvocationId,
            lastJob.phase === 'succeeded'
              ? 'job_succeeded_without_restart'
              : lastJob.phase === 'failed'
                ? 'job_failed'
                : 'job_cancelled',
            lastJob,
          );
        }
      } catch {
        return this.cancelRestartAndResolveLease(
          handle,
          previousInvocationId,
          'inspection_failed',
          lastJob,
        );
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return this.cancelRestartAndResolveLease(
          handle,
          previousInvocationId,
          'monitor_timeout',
          lastJob,
        );
      }
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, Math.min(pollIntervalMs, remainingMs));
      });
    }
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

  private validateScheduledRestartHandle(handle: ScheduledRestartHandle): void {
    if (!this.managedServiceUnits.includes(handle.targetUnit)) {
      throw new AdminRestartJobError({
        message: '重启任务引用了当前运行角色不管理的服务',
        stage: 'inspect',
        targetUnit: handle.targetUnit,
        transientUnit: handle.transientUnit,
      });
    }
    const expectedServiceUnit = `${handle.transientUnit}.service`;
    const expectedTimerUnit = `${handle.transientUnit}.timer`;
    if (
      !/^[A-Za-z0-9_.:-]{1,200}$/.test(handle.transientUnit)
      || handle.serviceUnit !== expectedServiceUnit
      || handle.timerUnit !== expectedTimerUnit
    ) {
      throw new AdminRestartJobError({
        message: '重启任务 handle 无效',
        stage: 'inspect',
        targetUnit: handle.targetUnit,
        transientUnit: 'invalid',
      });
    }
  }

  private async readRestartUnitControllerState(unit: string): Promise<RestartUnitControllerState> {
    const { stdout } = await this.execFile(
      'systemctl',
      withSystemdScope(this.systemdScope, [
        'show',
        unit,
        '--property',
        'LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestampMonotonic',
      ]),
      { cwd: this.rootDir, timeout: 5_000 },
    );
    const values = parseSystemdProperties(stdout);
    return {
      loadState: values.LoadState || 'unknown',
      activeState: values.ActiveState || 'unknown',
      subState: values.SubState || 'unknown',
      result: values.Result || 'unknown',
      execMainStatus: parseOptionalInteger(values.ExecMainStatus),
      execMainStarted: Boolean(
        values.ExecMainStartTimestampMonotonic
        && values.ExecMainStartTimestampMonotonic !== '0',
      ),
    };
  }

  private async readRestartTargetControllerState(
    unit: BotServiceUnit,
  ): Promise<RestartTargetControllerState> {
    let stdout: string;
    try {
      ({ stdout } = await this.execFile(
        'systemctl',
        withSystemdScope(this.systemdScope, [
          'show',
          unit,
          '--property',
          'ActiveState,SubState,InvocationID,Job',
        ]),
        { cwd: this.rootDir, timeout: 5_000 },
      ));
    } catch (error) {
      throw new AdminRestartJobError({
        message: `无法核对 ${unit} 重启状态`,
        stage: 'verify',
        targetUnit: unit,
        transientUnit: 'target-state',
        cause: error,
      });
    }
    const values = parseSystemdProperties(stdout);
    return {
      activeState: values.ActiveState || 'unknown',
      subState: values.SubState || 'unknown',
      invocationId: values.InvocationID || null,
      job: values.Job && values.Job !== '0' ? values.Job : null,
    };
  }

  private async cancelRestartAndResolveLease(
    handle: ScheduledRestartHandle,
    previousInvocationId: string | null,
    reason: Extract<ScheduledRestartSupervisionOutcome, { state: 'safe_to_release' }>['reason'],
    job: ScheduledRestartJobStatus | null,
  ): Promise<ScheduledRestartSupervisionOutcome> {
    try {
      await this.execFile(
        'systemctl',
        withSystemdScope(this.systemdScope, [
          'stop',
          handle.timerUnit,
          handle.serviceUnit,
        ]),
        { cwd: this.rootDir, timeout: 5_000 },
      );
    } catch (error) {
      throw new AdminRestartJobError({
        message: `无法取消 ${handle.targetUnit} 重启任务，配置应用 reservation 保持锁定`,
        stage: 'cancel',
        targetUnit: handle.targetUnit,
        transientUnit: handle.transientUnit,
        jobPhase: job?.phase,
        systemdResult: job?.result,
        cause: error,
      });
    }

    const target = await this.readRestartTargetControllerState(handle.targetUnit);
    if (restartWasObserved(previousInvocationId, target)) {
      return { state: 'restart_observed', job };
    }
    return {
      state: 'safe_to_release',
      reason,
      job,
    };
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

  async readRuntimeLogs(input: {
    cursor?: string;
    direction: 'older' | 'newer';
    limit: number;
  }): Promise<AdminLogsResponse> {
    const initial = !input.cursor;
    const reverse = initial || input.direction === 'older';
    const requestedLines = input.limit + 2;
    const args = [
      ...(this.systemdScope === 'user' ? ['--user'] : []),
      '--no-pager',
      '--quiet',
      '--output=json',
      '--output-fields=MESSAGE,PRIORITY,SYSLOG_IDENTIFIER,_SYSTEMD_UNIT,_SYSTEMD_USER_UNIT',
      `--lines=${requestedLines}`,
      ...(reverse ? ['--reverse'] : []),
      ...(input.cursor
        ? [input.direction === 'older' ? `--cursor=${input.cursor}` : `--after-cursor=${input.cursor}`]
        : []),
      ...this.managedServiceUnits.flatMap((unit) => ['--unit', unit]),
    ];
    const [journal, diskUsage] = await Promise.all([
      this.readProcessLines('journalctl', args, { cwd: this.rootDir, timeout: 15_000 }),
      this.execFile('journalctl', ['--disk-usage'], { cwd: this.rootDir, timeout: 15_000 }),
    ]);
    let entries = journal.lines.flatMap((line) => {
      if (!line.startsWith('{')) return [];
      try {
        const entry = runtimeLogEntryFromJournal(JSON.parse(line) as Record<string, unknown>);
        return entry ? [entry] : [];
      } catch {
        return [];
      }
    });
    if (input.cursor && input.direction === 'older') {
      entries = entries.filter((entry) => entry.cursor !== input.cursor);
    }

    const hasOverflow = entries.length > input.limit;
    entries = entries.slice(0, input.limit);
    if (reverse) entries.reverse();

    return {
      entries,
      oldestCursor: entries[0]?.cursor ?? input.cursor ?? null,
      newestCursor: entries.at(-1)?.cursor ?? input.cursor ?? null,
      hasOlder: reverse ? hasOverflow : Boolean(input.cursor),
      hasNewer: reverse ? Boolean(input.cursor) : hasOverflow,
      retainedBytes: parseJournalDiskUsageBytes(`${diskUsage.stdout}\n${diskUsage.stderr}`),
      retentionLimitBytes: RUNTIME_LOG_RETENTION_LIMIT_BYTES,
    };
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
      '--output-fields=MESSAGE,MESSAGE_ID,UNIT,INVOCATION_ID,JOB_RESULT',
      '--show-cursor',
      ...(afterCursor ? [`--after-cursor=${afterCursor}`] : ['--boot']),
      'MESSAGE_ID=be02cf6855d2428ba40df7e9d022f03d',
    ];
    const result = await this.readProcessLines('journalctl', args, { cwd: this.rootDir, timeout: 15_000 });
    const lines = result.lines.filter(Boolean);
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

  async readRuntimeIssueJournal(afterCursor: string | null): Promise<{
    entries: Array<{
      cursor: string;
      unit: BotServiceUnit;
      invocationId: string | null;
      priority: number | null;
      syslogIdentifier: string | null;
      messageId: string | null;
      message: string;
      occurredAt: number;
    }>;
    cursor: string | null;
  }> {
    const args = [
      ...(this.systemdScope === 'user' ? ['--user'] : []),
      '--no-pager',
      '--output=json',
      '--output-fields=MESSAGE,_SYSTEMD_USER_UNIT,_SYSTEMD_UNIT,UNIT,_SYSTEMD_INVOCATION_ID,INVOCATION_ID,PRIORITY,SYSLOG_IDENTIFIER,MESSAGE_ID',
      '--show-cursor',
      ...(afterCursor ? [`--after-cursor=${afterCursor}`] : ['--boot', '--lines=5000']),
      ...this.managedServiceUnits.flatMap((unit) => ['--unit', unit]),
    ];
    const result = await this.readProcessLines('journalctl', args, { cwd: this.rootDir, timeout: 15_000 });
    const lines = result.lines.filter(Boolean);
    const cursorLine = lines.filter((line) => line.startsWith('-- cursor: ')).at(-1);
    const entries = lines.flatMap((line) => {
      if (!line.startsWith('{')) return [];
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return [];
      }
      const unit = String(record._SYSTEMD_USER_UNIT ?? record._SYSTEMD_UNIT ?? record.UNIT ?? '');
      if (!this.managedServiceUnits.includes(unit as BotServiceUnit)) return [];
      const cursor = String(record.__CURSOR ?? '');
      if (!cursor) return [];
      const realtimeMicros = Number(record.__REALTIME_TIMESTAMP ?? 0);
      const priority = Number(record.PRIORITY);
      const invocationId = String(record._SYSTEMD_INVOCATION_ID ?? record.INVOCATION_ID ?? '');
      const syslogIdentifier = String(record.SYSLOG_IDENTIFIER ?? '');
      const messageId = String(record.MESSAGE_ID ?? '');
      return [{
        cursor,
        unit: unit as BotServiceUnit,
        invocationId: invocationId || null,
        priority: Number.isInteger(priority) ? priority : null,
        syslogIdentifier: syslogIdentifier || null,
        messageId: messageId || null,
        message: typeof record.MESSAGE === 'string' ? record.MESSAGE : '',
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
    const result = await this.readProcessLines('journalctl', [
      ...(this.systemdScope === 'user' ? ['--user'] : []),
      '--no-pager',
      '--output=short-iso',
      '--lines=200',
      `_SYSTEMD_INVOCATION_ID=${invocationId}`,
      '+',
      `INVOCATION_ID=${invocationId}`,
    ], { cwd: this.rootDir, timeout: 15_000 });
    return result.lines.filter(Boolean);
  }


}
