import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ProxyAgent, type Dispatcher } from 'undici';
import type {
  BotConsoleAuthStatus,
  CopilotAuthAttempt,
  CopilotAuthState,
} from '../../types/bot-console.js';
import {
  COPILOT_AUTO_MODEL_ID,
  COPILOT_MODEL_OPTIONS,
  type CopilotModelOption,
  type MainChatRequestMode,
} from '../shared/llm/index.js';

const DEFAULT_KOISHI_PORT = '5140';
const DEFAULT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const DEFAULT_COPILOT_API_BASE_URL = 'https://api.individual.githubcopilot.com';
const SESSION_EXPIRY_SKEW_MS = 5 * 60 * 1000;
const AUTO_ROUTER_TIMEOUT_MS = 2500;
const proxyAgents = new Map<string, ProxyAgent>();

type ResolvedEnvFiles = {
  mode: 'single' | 'layered';
  baseFilePath: string | null;
  overrideFilePath: string | null;
  editTarget: string;
};

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
};

type DeviceTokenPendingResponse = {
  error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | string;
};

type DeviceTokenSuccessResponse = {
  access_token: string;
};

type GitHubUserResponse = {
  login?: string | null;
  id?: number | null;
};

type CopilotTokenResponse = {
  token?: string;
  expires_at?: number | string;
};

type CopilotOAuthRecord = {
  githubToken: string;
  accountLogin: string | null;
  accountId: string | null;
  updatedAt: number;
};

type CopilotSessionRecord = {
  token: string;
  baseUrl: string;
  expiresAt: number;
  updatedAt: number;
};

type CopilotBridgeRuntimeConfig = {
  baseUrl: string;
  apiKey: string;
};

type CopilotAutoSessionResponse = {
  session_token?: string;
  available_models?: unknown;
  discounted_costs?: unknown;
  expires_at?: number | string;
};

type CopilotAutoSessionRecord = {
  token: string;
  availableModels: string[];
  discountedCosts: Record<string, number>;
  expiresAt: number;
  updatedAt: number;
  copilotToken: string;
  baseUrl: string;
};

type CopilotRouterDecisionResponse = {
  predicted_label?: string;
  confidence?: number;
  latency_ms?: number;
  candidate_models?: unknown;
  chosen_model?: unknown;
  fallback?: boolean;
  fallback_reason?: string;
};

type DeviceLoginAttempt = CopilotAuthAttempt & {
  deviceCode: string;
  intervalMs: number;
};

type FetchInitWithDispatcher = RequestInit & {
  dispatcher?: Dispatcher;
};

export type CopilotConsoleStatus = Pick<
  CopilotAuthState,
  'authKind' | 'authStatus' | 'accountLabel' | 'authError' | 'attempt'
>;

export interface CopilotBridgeStateProvider {
  getRuntimeConfig(): Promise<CopilotBridgeRuntimeConfig>;
  getConsoleStatus(options?: { probe?: boolean }): Promise<CopilotConsoleStatus>;
  proxyModels?(): Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

type CopilotModelPayload = {
  object: 'list';
  data: Array<{
    id: string;
    object: 'model';
    name: string;
    owned_by: 'github-copilot-auto';
    supported_endpoints: string[];
    capabilities: {
      type: 'chat';
      supports: {
        structured_outputs: boolean;
        streaming: true;
        tool_calls: true;
      };
    };
    qqbot: {
      rateLabel?: string;
      requestMode: MainChatRequestMode;
      structuredOutputProtocol: CopilotModelOption['structuredOutputProtocol'];
      availableModels?: string[];
    };
  }>;
};

function trimOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function buildJsonError(message: string) {
  return {
    error: {
      message,
      type: 'invalid_request_error',
    },
  };
}

function deriveCopilotApiBaseUrlFromToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return DEFAULT_COPILOT_API_BASE_URL;
  const proxyEp = trimmed.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i)?.[1]?.trim();
  if (!proxyEp) return DEFAULT_COPILOT_API_BASE_URL;
  const host = proxyEp.replace(/^https?:\/\//, '').replace(/^proxy\./i, 'api.');
  if (!host) return DEFAULT_COPILOT_API_BASE_URL;
  return `https://${host}`;
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readHttpErrorDetail(response: Response): Promise<string | null> {
  const text = (await response.text().catch(() => '')).trim();
  return text ? text.slice(0, 240) : null;
}

async function buildHttpError(prefix: string, response: Response): Promise<Error> {
  const detail = await readHttpErrorDetail(response);
  return new Error(detail ? `${prefix}：HTTP ${response.status} ${detail}` : `${prefix}：HTTP ${response.status}`);
}

function defaultPortForProtocol(protocol: string): string {
  if (protocol === 'http:') return '80';
  if (protocol === 'https:') return '443';
  return '';
}

function parseNoProxyEntry(entry: string): { host: string; port: string | null } {
  const value = entry.trim().toLowerCase();
  if (!value) return { host: '', port: null };
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end >= 0) {
      const host = value.slice(1, end);
      const rest = value.slice(end + 1);
      return { host, port: rest.startsWith(':') ? rest.slice(1) : null };
    }
  }
  const lastColon = value.lastIndexOf(':');
  if (lastColon > 0 && value.indexOf(':') === lastColon) {
    const port = value.slice(lastColon + 1);
    if (/^\d+$/.test(port)) return { host: value.slice(0, lastColon), port };
  }
  return { host: value, port: null };
}

function matchesNoProxyHost(host: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  if (pattern.startsWith('.')) {
    const suffix = pattern.slice(1);
    return host === suffix || host.endsWith(pattern);
  }
  return host === pattern;
}

function shouldBypassProxy(url: URL, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = trimOptionalText(env.NO_PROXY) ?? trimOptionalText(env.no_proxy);
  if (!raw) return false;
  const host = url.hostname.toLowerCase();
  const port = url.port || defaultPortForProtocol(url.protocol);
  return raw.split(',').some((entry) => {
    const parsed = parseNoProxyEntry(entry);
    if (!parsed.host) return false;
    if (parsed.port && parsed.port !== port) return false;
    return matchesNoProxyHost(host, parsed.host);
  });
}

function resolveProxyUrl(target: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const url = new URL(target);
  if (shouldBypassProxy(url, env)) return null;
  const proxy =
    url.protocol === 'http:'
      ? trimOptionalText(env.HTTP_PROXY) ?? trimOptionalText(env.http_proxy) ?? trimOptionalText(env.ALL_PROXY) ?? trimOptionalText(env.all_proxy)
      : trimOptionalText(env.HTTPS_PROXY) ?? trimOptionalText(env.https_proxy) ?? trimOptionalText(env.ALL_PROXY) ?? trimOptionalText(env.all_proxy);
  if (!proxy) return null;
  const parsed = new URL(proxy);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Copilot OAuth 代理协议不支持：${parsed.protocol}，请使用 http 或 https 代理。`);
  }
  return parsed.toString();
}

function redactProxyUrl(proxyUrl: string): string {
  const url = new URL(proxyUrl);
  if (url.username || url.password) {
    url.username = '***';
    url.password = '';
  }
  return url.toString();
}

function getProxyAgent(proxyUrl: string): ProxyAgent {
  const current = proxyAgents.get(proxyUrl);
  if (current) return current;
  const agent = new ProxyAgent(proxyUrl);
  proxyAgents.set(proxyUrl, agent);
  return agent;
}

function createFetchInit(target: string, init: RequestInit = {}): { init: FetchInitWithDispatcher; proxyUrl: string | null } {
  const proxyUrl = resolveProxyUrl(target);
  if (!proxyUrl) return { init, proxyUrl: null };
  return {
    init: {
      ...init,
      dispatcher: getProxyAgent(proxyUrl),
    },
    proxyUrl,
  };
}

function formatFetchFailure(label: string, target: string, proxyUrl: string | null, error: unknown): string {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : null;
  const causeCode = typeof cause === 'object' && cause && 'code' in cause ? String((cause as { code?: unknown }).code ?? '') : '';
  const causeMessage = cause instanceof Error ? cause.message : '';
  const message = error instanceof Error ? error.message : String(error);
  const detail = [causeCode, causeMessage || message].filter(Boolean).join(' ');
  const proxy = proxyUrl ? `，proxy=${redactProxyUrl(proxyUrl)}` : '';
  return `${label}失败：${detail || message}（url=${target}${proxy}）`;
}

async function fetchExternal(target: string, label: string, init: RequestInit = {}): Promise<Response> {
  const request = createFetchInit(target, init);
  try {
    return await fetch(target, request.init);
  } catch (error) {
    throw new Error(formatFetchFailure(label, target, request.proxyUrl, error));
  }
}

function isSessionUsable(record: CopilotSessionRecord, now = Date.now()): boolean {
  return record.expiresAt - now > SESSION_EXPIRY_SKEW_MS;
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  const raw = await readTextIfExists(filePath);
  if (!raw) return null;
  return parseJson<T>(raw, filePath);
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function resolveCopilotStateDir(rootDir: string, envFiles: ResolvedEnvFiles): string {
  if (envFiles.mode === 'layered') {
    return dirname(envFiles.editTarget);
  }
  return join(rootDir, '.runtime');
}

export function buildCopilotBridgeBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const port = trimOptionalText(env.KOISHI_PORT) || DEFAULT_KOISHI_PORT;
  return `http://127.0.0.1:${port}/api/internal/copilot/v1`;
}

export function normalizeCopilotModelId(model: string | null | undefined): string | null {
  const value = trimOptionalText(model);
  if (!value) return null;
  if (value.startsWith('openai/')) {
    const normalized = trimOptionalText(value.slice('openai/'.length));
    return normalized?.toLowerCase() === COPILOT_AUTO_MODEL_ID ? COPILOT_AUTO_MODEL_ID : normalized;
  }
  if (value.startsWith('github-copilot/')) {
    const normalized = trimOptionalText(value.slice('github-copilot/'.length));
    return normalized?.toLowerCase() === COPILOT_AUTO_MODEL_ID ? COPILOT_AUTO_MODEL_ID : normalized;
  }
  if (value.toLowerCase() === COPILOT_AUTO_MODEL_ID) return COPILOT_AUTO_MODEL_ID;
  return value;
}

export class CopilotOAuthBridgeService implements CopilotBridgeStateProvider {
  readonly rootDir: string;
  readonly envFiles: ResolvedEnvFiles;
  readonly stateDir: string;
  readonly oauthFilePath: string;
  readonly sessionFilePath: string;
  readonly secretFilePath: string;
  private readonly attempts = new Map<string, DeviceLoginAttempt>();
  private sessionRefreshPromise: Promise<CopilotSessionRecord> | null = null;
  private autoSession: CopilotAutoSessionRecord | null = null;
  private autoSessionPromise: Promise<CopilotAutoSessionRecord> | null = null;

  constructor(args: { rootDir: string; envFiles: ResolvedEnvFiles }) {
    this.rootDir = args.rootDir;
    this.envFiles = args.envFiles;
    this.stateDir = resolveCopilotStateDir(this.rootDir, this.envFiles);
    this.oauthFilePath = join(this.stateDir, 'github-copilot.oauth.json');
    this.sessionFilePath = join(this.stateDir, 'github-copilot.session.json');
    this.secretFilePath = join(this.stateDir, 'github-copilot.bridge-secret');
  }

  async getRuntimeConfig(): Promise<CopilotBridgeRuntimeConfig> {
    return {
      baseUrl: buildCopilotBridgeBaseUrl(process.env),
      apiKey: await this.ensureBridgeSecret(),
    };
  }

  async getConsoleStatus(options: { probe?: boolean } = {}): Promise<CopilotConsoleStatus> {
    const attempt = [...this.attempts.values()].find((item) => item.state === 'pending') ?? null;
    if (attempt) {
      return {
        authKind: 'oauth_device',
        authStatus: 'pending',
        accountLabel: null,
        authError: null,
        attempt: sanitizeAttempt(attempt),
      };
    }

    const oauth = await this.readOAuthRecord();
    if (!oauth) {
      return {
        authKind: 'oauth_device',
        authStatus: 'unauthenticated',
        accountLabel: null,
        authError: null,
        attempt: null,
      };
    }

    const accountLabel = formatAccountLabel(oauth);
    if (!options.probe) {
      return {
        authKind: 'oauth_device',
        authStatus: 'ready',
        accountLabel,
        authError: null,
        attempt: null,
      };
    }

    try {
      await this.resolveCopilotSession({ forceRefresh: false });
      return {
        authKind: 'oauth_device',
        authStatus: 'ready',
        accountLabel,
        authError: null,
        attempt: null,
      };
    } catch (error) {
      return {
        authKind: 'oauth_device',
        authStatus: classifyAuthErrorStatus(error),
        accountLabel,
        authError: error instanceof Error ? error.message : String(error),
        attempt: null,
      };
    }
  }

  async startLogin(): Promise<CopilotConsoleStatus> {
    const payload = await this.requestDeviceCode();
    const now = Date.now();
    const attempt: DeviceLoginAttempt = {
      attemptId: randomUUID(),
      userCode: payload.user_code,
      verificationUri: payload.verification_uri,
      expiresAt: now + payload.expires_in * 1000,
      intervalSec: Math.max(1, payload.interval ?? 5),
      nextPollAt: now + Math.max(1, payload.interval ?? 5) * 1000,
      state: 'pending',
      error: null,
      deviceCode: payload.device_code,
      intervalMs: Math.max(1, payload.interval ?? 5) * 1000,
    };
    this.attempts.set(attempt.attemptId, attempt);
    return {
      authKind: 'oauth_device',
      authStatus: 'pending',
      accountLabel: null,
      authError: null,
      attempt: sanitizeAttempt(attempt),
    };
  }

  async pollLogin(attemptId: string): Promise<CopilotConsoleStatus> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      return this.getConsoleStatus();
    }
    if (attempt.state !== 'pending') {
      this.attempts.delete(attemptId);
      return this.getConsoleStatus();
    }
    if (Date.now() >= attempt.expiresAt) {
      attempt.state = 'expired';
      attempt.error = 'GitHub 设备验证码已过期，请重新发起登录。';
      this.attempts.delete(attemptId);
      return {
        authKind: 'oauth_device',
        authStatus: 'expired',
        accountLabel: null,
        authError: attempt.error,
        attempt: sanitizeAttempt(attempt),
      };
    }
    if (Date.now() < attempt.nextPollAt) {
      return {
        authKind: 'oauth_device',
        authStatus: 'pending',
        accountLabel: null,
        authError: null,
        attempt: sanitizeAttempt(attempt),
      };
    }

    const result = await this.pollDeviceAccessToken(attempt.deviceCode);
    if ('access_token' in result && typeof result.access_token === 'string') {
      const oauth = await this.persistOAuthLogin(result.access_token);
      try {
        await this.resolveCopilotSession({ forceRefresh: true });
      } catch (error) {
        attempt.state = 'failed';
        attempt.error = error instanceof Error ? error.message : String(error);
        this.attempts.delete(attemptId);
        return {
          authKind: 'oauth_device',
          authStatus: 'error',
          accountLabel: formatAccountLabel(oauth),
          authError: attempt.error,
          attempt: sanitizeAttempt(attempt),
        };
      }

      attempt.state = 'authorized';
      attempt.error = null;
      this.attempts.delete(attemptId);
      return {
        authKind: 'oauth_device',
        authStatus: 'ready',
        accountLabel: formatAccountLabel(oauth),
        authError: null,
        attempt: sanitizeAttempt(attempt),
      };
    }

    const pendingError = 'error' in result ? result.error : 'unknown';

    if (pendingError === 'authorization_pending') {
      attempt.nextPollAt = Date.now() + attempt.intervalMs;
      return {
        authKind: 'oauth_device',
        authStatus: 'pending',
        accountLabel: null,
        authError: null,
        attempt: sanitizeAttempt(attempt),
      };
    }

    if (pendingError === 'slow_down') {
      attempt.nextPollAt = Date.now() + attempt.intervalMs + 2000;
      return {
        authKind: 'oauth_device',
        authStatus: 'pending',
        accountLabel: null,
        authError: null,
        attempt: sanitizeAttempt(attempt),
      };
    }

    if (pendingError === 'expired_token') {
      attempt.state = 'expired';
      attempt.error = 'GitHub 设备验证码已过期，请重新发起登录。';
      this.attempts.delete(attemptId);
      return {
        authKind: 'oauth_device',
        authStatus: 'expired',
        accountLabel: null,
        authError: attempt.error,
        attempt: sanitizeAttempt(attempt),
      };
    }

    attempt.state = pendingError === 'access_denied' ? 'cancelled' : 'failed';
    attempt.error =
      pendingError === 'access_denied'
        ? 'GitHub 授权已取消。'
        : `GitHub 设备登录失败：${pendingError}`;
    this.attempts.delete(attemptId);
    return {
      authKind: 'oauth_device',
      authStatus: pendingError === 'access_denied' ? 'unauthenticated' : 'error',
      accountLabel: null,
      authError: attempt.error,
      attempt: sanitizeAttempt(attempt),
    };
  }

  async cancelLogin(attemptId: string): Promise<CopilotConsoleStatus> {
    const attempt = this.attempts.get(attemptId);
    if (attempt) {
      attempt.state = 'cancelled';
      attempt.error = '已取消本次 GitHub 设备登录。';
      this.attempts.delete(attemptId);
    }
    return this.getConsoleStatus();
  }

  async logout(): Promise<CopilotConsoleStatus> {
    this.attempts.clear();
    this.invalidateAutoSession();
    await Promise.all([
      rm(this.oauthFilePath, { force: true }),
      rm(this.sessionFilePath, { force: true }),
    ]);
    return {
      authKind: 'oauth_device',
      authStatus: 'unauthenticated',
      accountLabel: null,
      authError: null,
      attempt: null,
    };
  }

  async proxyModels(): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    try {
      const session = await this.resolveCopilotSession({ forceRefresh: false });
      const autoSession = await this.resolveCopilotAutoSession(session);
      return {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(buildCopilotAutoModelPayload(autoSession)),
      };
    } catch (error) {
      return this.buildProxyErrorResponse(error);
    }
  }

  async proxyResponses(body: unknown): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const normalizedBody = normalizeCopilotRequestBody(body);
    try {
      await this.assertCopilotModelCallable(normalizedBody, 'responses');
      return await this.doProxyResponses(normalizedBody, false);
    } catch (error) {
      return this.buildProxyErrorResponse(error);
    }
  }

  async proxyChatCompletions(body: unknown): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const normalizedBody = normalizeCopilotRequestBody(body);
    try {
      await this.assertCopilotModelCallable(normalizedBody, 'chat_completions');
      return await this.doProxyChatCompletions(normalizedBody, false);
    } catch (error) {
      return this.buildProxyErrorResponse(error);
    }
  }

  private async doProxyChatCompletions(
    body: unknown,
    retried: boolean,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const session = await this.resolveCopilotSession({ forceRefresh: retried });
    const prepared = await this.prepareCopilotChatCompletionsRequest(session, body);
    const response = await fetchExternal(`${session.baseUrl}/chat/completions`, 'Copilot upstream 请求', {
      method: 'POST',
      headers: buildCopilotRequestHeaders(session.token, {
        autoSessionToken: prepared.autoSession.token,
      }),
      body: JSON.stringify(prepared.body),
    });

    if (response.status === 401 && !retried) {
      this.invalidateAutoSession();
      return this.doProxyChatCompletions(body, true);
    }

    const responseBody = await response.text();
    return {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8',
      },
      body: responseBody,
    };
  }

  private async doProxyResponses(
    body: unknown,
    retried: boolean,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const session = await this.resolveCopilotSession({ forceRefresh: retried });
    const prepared = await this.prepareCopilotResponsesRequest(session, body);
    const response = await fetchExternal(`${session.baseUrl}/responses`, 'Copilot upstream 请求', {
      method: 'POST',
      headers: buildCopilotRequestHeaders(session.token, {
        autoSessionToken: prepared.autoSession.token,
      }),
      body: JSON.stringify(prepared.body),
    });

    if (response.status === 401 && !retried) {
      this.invalidateAutoSession();
      return this.doProxyResponses(body, true);
    }

    const responseBody = await response.text();
    return {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8',
      },
      body: responseBody,
    };
  }

  private async ensureBridgeSecret(): Promise<string> {
    const persisted = trimOptionalText(await readTextIfExists(this.secretFilePath));
    if (persisted) return persisted;

    const fallback =
      trimOptionalText(process.env.CHATLUNA_COPILOT_API_KEY) ??
      `qqbot-copilot-${randomBytes(24).toString('hex')}`;

    await writeFileAtomic(this.secretFilePath, `${fallback}\n`);
    return fallback;
  }

  private async readOAuthRecord(): Promise<CopilotOAuthRecord | null> {
    return readJsonIfExists<CopilotOAuthRecord>(this.oauthFilePath);
  }

  private async readSessionRecord(): Promise<CopilotSessionRecord | null> {
    return readJsonIfExists<CopilotSessionRecord>(this.sessionFilePath);
  }

  private async requestDeviceCode(): Promise<DeviceCodeResponse> {
    const body = new URLSearchParams({
      client_id: trimOptionalText(process.env.CHATLUNA_COPILOT_OAUTH_CLIENT_ID) ?? DEFAULT_CLIENT_ID,
      scope: 'read:user',
    });
    const response = await fetchExternal(DEVICE_CODE_URL, 'GitHub 设备码申请', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!response.ok) {
      throw await buildHttpError('GitHub 设备码申请失败', response);
    }
    const payload = (await response.json()) as DeviceCodeResponse;
    if (!payload.device_code || !payload.user_code || !payload.verification_uri || !payload.expires_in) {
      throw new Error('GitHub 设备码响应缺少必要字段。');
    }
    return payload;
  }

  private async pollDeviceAccessToken(deviceCode: string): Promise<DeviceTokenSuccessResponse | DeviceTokenPendingResponse> {
    const body = new URLSearchParams({
      client_id: trimOptionalText(process.env.CHATLUNA_COPILOT_OAUTH_CLIENT_ID) ?? DEFAULT_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    const response = await fetchExternal(ACCESS_TOKEN_URL, 'GitHub 设备登录换 token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!response.ok) {
      throw await buildHttpError('GitHub 设备登录换 token 失败', response);
    }
    return (await response.json()) as DeviceTokenSuccessResponse | DeviceTokenPendingResponse;
  }

  private async fetchGitHubAccount(accessToken: string): Promise<{ login: string | null; id: string | null }> {
    const response = await fetchExternal(GITHUB_USER_URL, 'GitHub 账号信息读取', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) {
      return { login: null, id: null };
    }
    const payload = (await response.json()) as GitHubUserResponse;
    return {
      login: trimOptionalText(payload.login) ?? null,
      id: payload.id == null ? null : String(payload.id),
    };
  }

  private async persistOAuthLogin(accessToken: string): Promise<CopilotOAuthRecord> {
    const account = await this.fetchGitHubAccount(accessToken);
    const record: CopilotOAuthRecord = {
      githubToken: accessToken,
      accountLogin: account.login,
      accountId: account.id,
      updatedAt: Date.now(),
    };
    await writeJsonFile(this.oauthFilePath, record);
    return record;
  }

  async resolveCopilotSession(options: { forceRefresh?: boolean } = {}): Promise<CopilotSessionRecord> {
    if (!options.forceRefresh) {
      const cached = await this.readSessionRecord();
      if (cached && isSessionUsable(cached)) {
        return cached;
      }
    }

    if (!this.sessionRefreshPromise) {
      this.sessionRefreshPromise = this.exchangeCopilotSession(options.forceRefresh ?? false).finally(() => {
        this.sessionRefreshPromise = null;
      });
    }
    return this.sessionRefreshPromise;
  }

  private async exchangeCopilotSession(forceRefresh: boolean): Promise<CopilotSessionRecord> {
    if (!forceRefresh) {
      const cached = await this.readSessionRecord();
      if (cached && isSessionUsable(cached)) {
        return cached;
      }
    }

    const oauth = await this.readOAuthRecord();
    if (!oauth?.githubToken) {
      throw new Error('GitHub Copilot 尚未完成 OAuth 登录。');
    }

    const response = await fetchExternal(COPILOT_TOKEN_URL, 'Copilot session token 换取', {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${oauth.githubToken}`,
      },
    });
    if (!response.ok) {
      throw await buildHttpError('Copilot session token 换取失败', response);
    }
    const payload = (await response.json()) as CopilotTokenResponse;
    const token = trimOptionalText(payload.token);
    if (!token) {
      throw new Error('Copilot session token 响应缺少 token。');
    }
    const expiresAtRaw = payload.expires_at;
    const numericExpiresAt =
      typeof expiresAtRaw === 'number'
        ? expiresAtRaw
        : typeof expiresAtRaw === 'string'
          ? Number.parseInt(expiresAtRaw, 10)
          : NaN;
    if (!Number.isFinite(numericExpiresAt)) {
      throw new Error('Copilot session token 响应缺少 expires_at。');
    }

    const record: CopilotSessionRecord = {
      token,
      baseUrl: deriveCopilotApiBaseUrlFromToken(token),
      expiresAt: numericExpiresAt > 1e10 ? numericExpiresAt : numericExpiresAt * 1000,
      updatedAt: Date.now(),
    };
    await writeJsonFile(this.sessionFilePath, record);
    return record;
  }

  private invalidateAutoSession(): void {
    this.autoSession = null;
    this.autoSessionPromise = null;
  }

  private async resolveCopilotAutoSession(session: CopilotSessionRecord): Promise<CopilotAutoSessionRecord> {
    if (this.autoSession && isAutoSessionUsable(this.autoSession, session)) {
      return this.autoSession;
    }
    if (!this.autoSessionPromise) {
      this.autoSessionPromise = this.requestCopilotAutoSession(session).finally(() => {
        this.autoSessionPromise = null;
      });
    }
    this.autoSession = await this.autoSessionPromise;
    return this.autoSession;
  }

  private async requestCopilotAutoSession(session: CopilotSessionRecord): Promise<CopilotAutoSessionRecord> {
    const response = await fetchExternal(`${session.baseUrl}/models/session`, 'Copilot Auto session 开启', {
      method: 'POST',
      headers: buildCopilotRequestHeaders(session.token),
      body: JSON.stringify({
        auto_mode: {
          model_hints: [COPILOT_AUTO_MODEL_ID],
        },
      }),
    });
    if (!response.ok) {
      throw await buildHttpError('Copilot Auto session 开启失败', response);
    }

    const payload = (await response.json()) as CopilotAutoSessionResponse;
    const token = trimOptionalText(payload.session_token);
    if (!token) {
      throw new Error('Copilot Auto session 响应缺少 session_token。');
    }
    const availableModels = normalizeStringList(payload.available_models);
    if (availableModels.length === 0) {
      throw new Error('Copilot Auto session 响应缺少 available_models。');
    }
    const responsesModels = availableModels.filter(isCopilotAutoResponsesModelId);
    if (responsesModels.length === 0) {
      throw new Error(`Copilot Auto session 未返回可走 Responses API 的模型：${availableModels.join(' / ')}`);
    }

    return {
      token,
      availableModels,
      discountedCosts: normalizeDiscountedCosts(payload.discounted_costs),
      expiresAt: normalizeExpiresAt(payload.expires_at, 'Copilot Auto session 响应缺少 expires_at。'),
      updatedAt: Date.now(),
      copilotToken: session.token,
      baseUrl: session.baseUrl,
    };
  }

  private async prepareCopilotChatCompletionsRequest(
    session: CopilotSessionRecord,
    body: unknown,
  ): Promise<{ body: unknown; autoSession: CopilotAutoSessionRecord; selectedModel: string }> {
    await this.assertCopilotModelCallable(body, 'chat_completions');
    const model = readCopilotRequestModel(body);
    if (model !== COPILOT_AUTO_MODEL_ID) {
      throw new CopilotBridgeHttpError(400, `GitHub Copilot bridge 只接受 Auto 入口模型：${model ?? '<empty>'}`);
    }
    const autoSession = await this.resolveCopilotAutoSession(session);
    const selectedModel = await this.resolveCopilotAutoModel(session, autoSession, body);
    return {
      body: withCopilotRequestModel(body, selectedModel),
      autoSession,
      selectedModel,
    };
  }

  private async prepareCopilotResponsesRequest(
    session: CopilotSessionRecord,
    body: unknown,
  ): Promise<{ body: unknown; autoSession: CopilotAutoSessionRecord; selectedModel: string }> {
    await this.assertCopilotModelCallable(body, 'responses');
    const model = readCopilotRequestModel(body);
    if (model !== COPILOT_AUTO_MODEL_ID) {
      throw new CopilotBridgeHttpError(400, `GitHub Copilot bridge 只接受 Auto 入口模型：${model ?? '<empty>'}`);
    }
    const autoSession = await this.resolveCopilotAutoSession(session);
    const selectedModel = await this.resolveCopilotAutoModel(session, autoSession, body);
    return {
      body: withCopilotRequestModel(body, selectedModel),
      autoSession,
      selectedModel,
    };
  }

  private async resolveCopilotAutoModel(
    session: CopilotSessionRecord,
    autoSession: CopilotAutoSessionRecord,
    body: unknown,
  ): Promise<string> {
    const prompt = extractCopilotRequestPrompt(body);
    if (!prompt) {
      throw new CopilotBridgeHttpError(400, 'GitHub Copilot Auto 路由需要请求体中存在 user 文本。');
    }
    const availableModels = autoSession.availableModels.filter(isCopilotAutoResponsesModelId);
    const response = await this.requestCopilotRouterDecision(session, autoSession, prompt, availableModels);
    const candidates = normalizeStringList(response.candidate_models);
    const chosen = trimOptionalText(response.chosen_model);
    const selected = pickCopilotAutoCandidate([chosen, ...candidates], availableModels);
    if (selected) return selected;
    throw new CopilotBridgeHttpError(
      502,
      `Copilot Auto router 未返回可走 Responses API 的候选模型。available=${availableModels.join(' / ')} candidates=${candidates.join(' / ') || '<empty>'}`,
    );
  }

  private async requestCopilotRouterDecision(
    session: CopilotSessionRecord,
    autoSession: CopilotAutoSessionRecord,
    prompt: string,
    availableModels: readonly string[],
  ): Promise<CopilotRouterDecisionResponse> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), AUTO_ROUTER_TIMEOUT_MS);
    try {
      const response = await fetchExternal(`${session.baseUrl}/models/session/intent`, 'Copilot Auto 模型路由', {
        method: 'POST',
        headers: buildCopilotRequestHeaders(session.token, {
          autoSessionToken: autoSession.token,
        }),
        body: JSON.stringify({
          prompt,
          available_models: [...availableModels],
        }),
        signal: abortController.signal,
      });
      if (!response.ok) {
        throw await buildHttpError('Copilot Auto 模型路由失败', response);
      }
      return (await response.json()) as CopilotRouterDecisionResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async proxyUpstream(args: {
    method: 'GET' | 'POST';
    path: '/chat/completions' | '/v1/responses';
    body?: unknown;
  }): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    try {
      return await this.doProxyUpstream(args, false);
    } catch (error) {
      return this.buildProxyErrorResponse(error);
    }
  }

  private buildProxyErrorResponse(error: unknown): { status: number; headers: Record<string, string>; body: string } {
    const status = error instanceof CopilotBridgeHttpError ? error.status : 401;
    return {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(buildJsonError(error instanceof Error ? error.message : String(error))),
    };
  }

  private async doProxyUpstream(
    args: {
      method: 'GET' | 'POST';
      path: '/chat/completions' | '/v1/responses';
      body?: unknown;
    },
    retried: boolean,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const session = await this.resolveCopilotSession({ forceRefresh: retried });
    const response = await fetchExternal(`${session.baseUrl}${args.path}`, 'Copilot upstream 请求', {
      method: args.method,
      headers: buildCopilotRequestHeaders(session.token),
      body: args.body == null ? undefined : JSON.stringify(args.body),
    });

    if (response.status === 401 && !retried) {
      return this.doProxyUpstream(args, true);
    }

    const body = await response.text();
    return {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8',
      },
      body,
    };
  }

  private async assertCopilotModelCallable(body: unknown, requestMode: MainChatRequestMode): Promise<void> {
    const model = readCopilotRequestModel(body);
    if (!model) {
      throw new CopilotBridgeHttpError(400, 'GitHub Copilot 请求缺少 model。');
    }
    const option = getStaticCopilotModelOption(model);
    if (!option) {
      throw new CopilotBridgeHttpError(400, `GitHub Copilot Auto 入口列表不支持：${model}`);
    }
    if (option.requestMode !== requestMode) {
      const modeLabel = requestMode === 'responses' ? 'Responses API' : 'chat/completions';
      throw new CopilotBridgeHttpError(400, `GitHub Copilot Auto 入口不支持 ${modeLabel}：${model}`);
    }
  }
}

class CopilotBridgeHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function buildCopilotRequestHeaders(token: string, options: { autoSessionToken?: string } = {}): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Editor-Version': 'vscode/1.126.0',
    'Editor-Plugin-Version': 'copilot-chat/0.48.1',
    'Copilot-Integration-Id': 'vscode-chat',
    'User-Agent': 'GitHubCopilotChat/0.48.1',
    'X-GitHub-Api-Version': '2026-06-01',
  };
  if (options.autoSessionToken) {
    headers['Copilot-Session-Token'] = options.autoSessionToken;
  }
  return headers;
}

function sanitizeAttempt(attempt: DeviceLoginAttempt): CopilotAuthAttempt {
  return {
    attemptId: attempt.attemptId,
    userCode: attempt.userCode,
    verificationUri: attempt.verificationUri,
    expiresAt: attempt.expiresAt,
    intervalSec: attempt.intervalSec,
    nextPollAt: attempt.nextPollAt,
    state: attempt.state,
    error: attempt.error,
  };
}

function formatAccountLabel(record: CopilotOAuthRecord): string | null {
  if (record.accountLogin && record.accountId) return `${record.accountLogin} (#${record.accountId})`;
  return record.accountLogin ?? record.accountId ?? null;
}

function classifyAuthErrorStatus(error: unknown): BotConsoleAuthStatus {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('HTTP 401') || message.includes('HTTP 403')) return 'expired';
  return 'error';
}

function normalizeCopilotRequestBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  const normalized = { ...(body as Record<string, unknown>) };
  const model = normalized.model;
  if (typeof model === 'string') {
    normalized.model = normalizeCopilotModelId(model) ?? model.trim();
  }
  return normalized;
}

function withCopilotRequestModel(body: unknown, model: string): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CopilotBridgeHttpError(400, 'GitHub Copilot 请求体必须是 JSON object。');
  }
  return {
    ...(body as Record<string, unknown>),
    model,
  };
}

function readCopilotRequestModel(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const model = (body as Record<string, unknown>).model;
  return typeof model === 'string' ? normalizeCopilotModelId(model) : null;
}

function getStaticCopilotModelOption(model: string): CopilotModelOption | null {
  const normalized = normalizeCopilotModelId(model);
  if (!normalized) return null;
  return COPILOT_MODEL_OPTIONS.find((option) => option.modelId === normalized) ?? null;
}

function copilotModelEndpoint(option: CopilotModelOption): string {
  return option.requestMode === 'responses' ? '/v1/responses' : '/chat/completions';
}

function buildCopilotAutoModelPayload(autoSession: CopilotAutoSessionRecord): CopilotModelPayload {
  return {
    object: 'list',
    data: COPILOT_MODEL_OPTIONS.map((option) => ({
      id: option.modelId,
      object: 'model',
      name: option.label,
      owned_by: 'github-copilot-auto',
      supported_endpoints: [copilotModelEndpoint(option)],
      capabilities: {
        type: 'chat',
        supports: {
          structured_outputs: true,
          streaming: true,
          tool_calls: true,
        },
      },
      qqbot: {
        rateLabel: formatDiscountRateLabel(autoSession, option),
        requestMode: option.requestMode,
        structuredOutputProtocol: option.structuredOutputProtocol,
        availableModels: autoSession.availableModels,
      },
    })),
  };
}

function isAutoSessionUsable(
  record: CopilotAutoSessionRecord,
  session: CopilotSessionRecord,
  now = Date.now(),
): boolean {
  return record.copilotToken === session.token
    && record.baseUrl === session.baseUrl
    && record.expiresAt - now > SESSION_EXPIRY_SKEW_MS;
}

function normalizeExpiresAt(value: unknown, missingMessage: string): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : NaN;
  if (!Number.isFinite(numeric)) {
    throw new Error(missingMessage);
  }
  return numeric > 1e10 ? numeric : numeric * 1000;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const normalized = trimOptionalText(typeof item === 'string' ? item : null);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeDiscountedCosts(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [model, rawCost] of Object.entries(value)) {
    const normalizedModel = trimOptionalText(model);
    const cost = typeof rawCost === 'number' ? rawCost : typeof rawCost === 'string' ? Number(rawCost) : NaN;
    if (!normalizedModel || !Number.isFinite(cost)) continue;
    result[normalizedModel] = cost;
  }
  return result;
}

function isCopilotAutoResponsesModelId(model: string): boolean {
  const normalized = normalizeCopilotModelId(model);
  return Boolean(normalized && /^gpt-/i.test(normalized));
}

function pickCopilotAutoCandidate(candidates: readonly (string | null)[], availableModels: readonly string[]): string | null {
  const available = new Set(availableModels);
  for (const candidate of candidates) {
    const normalized = trimOptionalText(candidate);
    if (normalized && available.has(normalized) && isCopilotAutoResponsesModelId(normalized)) {
      return normalized;
    }
  }
  return null;
}

function extractCopilotRequestPrompt(body: unknown): string | null {
  return extractCopilotResponsesPrompt(body) ?? extractCopilotChatPrompt(body);
}

function extractCopilotResponsesPrompt(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = (body as Record<string, unknown>).input;
  if (typeof input === 'string') return trimOptionalText(input);
  if (!Array.isArray(input)) return null;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if ((item as Record<string, unknown>).role !== 'user') continue;
    const text = extractCopilotContentText((item as Record<string, unknown>).content);
    if (text) return text;
  }
  return null;
}

function extractCopilotChatPrompt(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    if ((message as Record<string, unknown>).role !== 'user') continue;
    const text = extractCopilotContentText((message as Record<string, unknown>).content);
    if (text) return text;
  }
  return null;
}

function extractCopilotContentText(content: unknown): string | null {
  if (typeof content === 'string') return trimOptionalText(content);
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((part): string[] => {
    if (typeof part === 'string') return [part];
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const text = (part as Record<string, unknown>).text;
    return typeof text === 'string' ? [text] : [];
  });
  return trimOptionalText(parts.join('\n'));
}

function formatDiscountRateLabel(autoSession: CopilotAutoSessionRecord, option: CopilotModelOption): string | undefined {
  if (option.rateLabel?.trim()) return option.rateLabel.trim();
  const rates = autoSession.availableModels
    .map((model) => autoSession.discountedCosts[model])
    .filter((rate): rate is number => Number.isFinite(rate));
  if (rates.length === 0) return undefined;
  const uniqueRates = [...new Set(rates)].sort((left, right) => left - right);
  if (uniqueRates.length === 1) return `${formatRateNumber(uniqueRates[0])}x`;
  return `${formatRateNumber(uniqueRates[0])}-${formatRateNumber(uniqueRates[uniqueRates.length - 1])}x`;
}

function formatRateNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
