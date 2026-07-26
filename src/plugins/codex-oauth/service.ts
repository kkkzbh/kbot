import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AdminAuthStatus,
  CodexCatalogState,
  CodexAuthAttempt,
  CodexAuthState,
} from '../../types/admin.js';
import {
  createProxyFetchRequest,
  formatProxyFetchFailure,
} from '../shared/proxy-fetch.js';
import {
  CodexReleaseMetadataError,
  CodexReleaseMetadataProvider,
  type CodexReleaseMetadataRecord,
} from './release-metadata.js';
import {
  readJsonIfExists,
  readTextIfExists,
  writeFileAtomic,
  writeJsonFile,
} from './state-files.js';

const DEFAULT_KOISHI_PORT = '5140';
const DEFAULT_CODEX_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_CODEX_AUTH_BASE_URL = 'https://auth.openai.com';
const DEFAULT_CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_CODEX_ORIGINATOR = 'codex_cli_rs';
const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
const CODEX_BRIDGE_PATH = '/api/internal/codex/v1';
const CODEX_DEVICE_POLL_INTERVAL_SEC = 5;
const CODEX_DEVICE_EXPIRES_IN_SEC = 15 * 60;

type ResolvedEnvFiles = {
  mode: 'single' | 'layered';
  baseFilePath: string | null;
  overrideFilePath: string | null;
  editTarget: string;
};

type CodexBridgeRuntimeConfig = {
  baseUrl: string;
  apiKey: string;
};

type CodexAuthTokens = {
  access_token?: string | null;
  refresh_token?: string | null;
  id_token?: string | null;
  account_id?: string | null;
};

type CodexAuthRecord = {
  auth_mode?: string | null;
  tokens?: CodexAuthTokens | null;
  last_refresh?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
};

type CodexTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  account_id?: string;
};

type CodexDeviceCodeResponse = {
  device_code?: string;
  deviceCode?: string;
  device_auth_id?: string;
  deviceAuthId?: string;
  user_code?: string;
  userCode?: string;
  usercode?: string;
  verification_uri?: string;
  verification_url?: string;
  verificationUri?: string;
  expires_in?: number;
  interval?: number;
};

type CodexDeviceTokenResponse = CodexTokenResponse & {
  error?: string;
  error_description?: string;
  code?: string;
  authorization_code?: string;
  auth_code?: string;
  code_challenge?: string;
  code_verifier?: string;
};

type CodexModelCatalogEntry = {
  slug?: unknown;
  id?: unknown;
  display_name?: unknown;
  name?: unknown;
  visibility?: unknown;
  supported_in_api?: unknown;
};

type StoredCodexAuthAttempt = CodexAuthAttempt & {
  deviceCode: string;
  codeVerifier: string;
  clientId: string;
};

type CodexBackendAuthContext = {
  accessToken: string;
  accountId: string;
  isFedrampAccount: boolean;
};

type CachedCodexModelCatalog = {
  clientVersion: string;
  etag: string | null;
  fetchedAt: number;
  models: CodexModelOption[];
};

class CodexModelCatalogError extends Error {
  readonly code = 'codex_model_catalog_unavailable';
  readonly upstreamStatus: number | null;

  constructor(message: string, upstreamStatus: number | null = null) {
    super(message);
    this.name = 'CodexModelCatalogError';
    this.upstreamStatus = upstreamStatus;
  }
}

export interface CodexModelOption {
  modelId: string;
  label: string;
}

export type CodexAdminStatus = Pick<
  CodexAuthState,
  'authKind' | 'authStatus' | 'accountLabel' | 'authError' | 'tokenExpiresAt' | 'attempt'
>;

export interface CodexBridgeStateProvider {
  getRuntimeConfig(): Promise<CodexBridgeRuntimeConfig>;
  getAdminStatus(options?: { probe?: boolean }): Promise<CodexAdminStatus>;
  getCatalogStatus(): Promise<CodexCatalogState>;
  refreshReleaseMetadata(options?: { force?: boolean }): Promise<CodexCatalogState>;
  startLogin?: () => Promise<CodexAdminStatus>;
  pollLogin?: (attemptId: string) => Promise<CodexAdminStatus>;
  cancelLogin?: (attemptId: string) => Promise<CodexAdminStatus>;
  logout?: () => Promise<CodexAdminStatus>;
  proxyModels?: (options?: { forceRefresh?: boolean }) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
  proxyResponses?: (body: unknown) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

function trimOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function buildJsonError(message: string, type = 'invalid_request_error', code?: string) {
  return {
    error: {
      message,
      type,
      ...(code ? { code } : {}),
    },
  };
}

export function resolveCodexStateDir(rootDir: string, envFiles: ResolvedEnvFiles): string {
  if (envFiles.mode === 'layered') {
    return dirname(envFiles.editTarget);
  }
  return join(rootDir, '.runtime');
}

export function buildCodexBridgeBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const port = trimOptionalText(env.KOISHI_PORT) || DEFAULT_KOISHI_PORT;
  return `http://127.0.0.1:${port}${CODEX_BRIDGE_PATH}`;
}

function codexAuthBaseUrl(): string {
  return (trimOptionalText(process.env.CODEX_OAUTH_BASE_URL) ?? DEFAULT_CODEX_AUTH_BASE_URL).replace(/\/+$/, '');
}

function codexTokenUrl(): string {
  return `${codexAuthBaseUrl()}/oauth/token`;
}

function codexDeviceCodeUrl(): string {
  return `${codexAuthBaseUrl()}/api/accounts/deviceauth/usercode`;
}

function codexDeviceTokenUrl(): string {
  return `${codexAuthBaseUrl()}/api/accounts/deviceauth/token`;
}

function codexDeviceVerificationUri(): string {
  return `${codexAuthBaseUrl()}/codex/device`;
}

function codexDeviceRedirectUri(): string {
  return `${codexAuthBaseUrl()}/deviceauth/callback`;
}

function codexBackendBaseUrl(): string {
  return (trimOptionalText(process.env.CHATLUNA_CODEX_UPSTREAM_BASE_URL) ?? DEFAULT_CODEX_BACKEND_BASE_URL).replace(/\/+$/, '');
}

function codexBackendUrl(pathname: string): string {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${codexBackendBaseUrl()}${normalizedPath}`;
}

function codexOriginator(): string {
  return trimOptionalText(process.env.CODEX_ORIGINATOR) ?? DEFAULT_CODEX_ORIGINATOR;
}

function formatOpenAiErrorPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string') return trimOptionalText(error);
  if (!error || typeof error !== 'object') return null;
  const record = error as { code?: unknown; type?: unknown; message?: unknown };
  const code = trimOptionalText(record.code);
  const type = trimOptionalText(record.type);
  const message = trimOptionalText(record.message);
  return [code, type, message].filter(Boolean).join(' / ') || null;
}

async function fetchCodexExternal(target: string, label: string, init: RequestInit = {}): Promise<Response> {
  return (await fetchCodexExternalWithContext(target, label, init)).response;
}

class CodexUpstreamTransportError extends Error {
  readonly providerCode = 'upstream_transport_error';

  constructor(message: string) {
    super(message);
    this.name = 'CodexUpstreamTransportError';
  }
}

type CodexExternalFetchResult = {
  response: Response;
  target: string;
  proxyUrl: string | null;
};

async function fetchCodexExternalWithContext(
  target: string,
  label: string,
  init: RequestInit = {},
): Promise<CodexExternalFetchResult> {
  const request = createProxyFetchRequest(target, init);
  try {
    return {
      response: await fetch(target, request.init),
      target,
      proxyUrl: request.proxyUrl,
    };
  } catch (error) {
    throw new CodexUpstreamTransportError(
      formatProxyFetchFailure(label, target, request.proxyUrl, error),
    );
  }
}

async function readCodexExternalText(
  result: CodexExternalFetchResult,
  label: string,
): Promise<string> {
  try {
    return await result.response.text();
  } catch (error) {
    throw new CodexUpstreamTransportError(
      formatProxyFetchFailure(label, result.target, result.proxyUrl, error),
    );
  }
}

function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  const value = trimOptionalText(token);
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function decodeJwtExpiresAtMs(token: string | null | undefined): number | null {
  const exp = decodeJwtPayload(token)?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  return exp * 1000;
}

function readObjectField(payload: unknown, key: string): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readOpenAiAuthClaims(payload: unknown): Record<string, unknown> | null {
  return readObjectField(payload, 'https://api.openai.com/auth');
}

function readOpenAiProfileClaims(payload: unknown): Record<string, unknown> | null {
  return readObjectField(payload, 'https://api.openai.com/profile');
}

function resolveChatGptAccountIdFromPayload(payload: unknown): string | null {
  return readPayloadString(payload, ['chatgpt_account_id', 'account_id'])
    ?? readPayloadString(readOpenAiAuthClaims(payload), ['chatgpt_account_id', 'account_id']);
}

function resolveChatGptAccountId(auth?: CodexAuthRecord | null): string | null {
  return trimOptionalText(auth?.tokens?.account_id)
    ?? resolveChatGptAccountIdFromPayload(decodeJwtPayload(auth?.tokens?.id_token))
    ?? resolveChatGptAccountIdFromPayload(decodeJwtPayload(auth?.tokens?.access_token));
}

function resolveChatGptAccountIsFedrampFromPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  if (record.chatgpt_account_is_fedramp === true) return true;
  return readOpenAiAuthClaims(payload)?.chatgpt_account_is_fedramp === true;
}

function resolveChatGptAccountIsFedramp(auth?: CodexAuthRecord | null): boolean {
  return resolveChatGptAccountIsFedrampFromPayload(decodeJwtPayload(auth?.tokens?.id_token))
    || resolveChatGptAccountIsFedrampFromPayload(decodeJwtPayload(auth?.tokens?.access_token));
}

function resolveClientId(auth?: CodexAuthRecord | null): string {
  const accessPayload = decodeJwtPayload(auth?.tokens?.access_token);
  const idPayload = decodeJwtPayload(auth?.tokens?.id_token);
  const fromAccess = trimOptionalText(accessPayload?.client_id);
  if (fromAccess) return fromAccess;
  const fromId = idPayload?.aud;
  if (typeof fromId === 'string') return trimOptionalText(fromId) ?? DEFAULT_CODEX_OAUTH_CLIENT_ID;
  if (Array.isArray(fromId)) {
    return fromId.map((value) => trimOptionalText(value)).find((value): value is string => Boolean(value)) ?? DEFAULT_CODEX_OAUTH_CLIENT_ID;
  }
  return trimOptionalText(process.env.CODEX_OAUTH_CLIENT_ID) ?? DEFAULT_CODEX_OAUTH_CLIENT_ID;
}

function formatAccountLabel(auth: CodexAuthRecord): string | null {
  const idPayload = decodeJwtPayload(auth.tokens?.id_token);
  const accessPayload = decodeJwtPayload(auth.tokens?.access_token);
  const email =
    trimOptionalText(idPayload?.email) ??
    trimOptionalText(readOpenAiProfileClaims(idPayload)?.email) ??
    trimOptionalText(readOpenAiProfileClaims(accessPayload)?.email);
  if (email) return email;
  return resolveChatGptAccountId(auth);
}

function assertManagedChatGptAuth(auth: CodexAuthRecord | null): asserts auth is CodexAuthRecord & { tokens: CodexAuthTokens } {
  if (!auth) {
    throw new Error('Codex 尚未登录；请在控制台 Codex Tab 发起 OAuth 登录。');
  }
  if (trimOptionalText(auth.auth_mode) !== 'chatgpt') {
    throw new Error('Codex OAuth 状态不是 ChatGPT OAuth 登录模式；请在控制台 Codex Tab 重新登录。');
  }
  if (!auth.tokens || typeof auth.tokens !== 'object') {
    throw new Error('Codex OAuth 状态缺少 tokens；请在控制台 Codex Tab 重新登录。');
  }
  if (!trimOptionalText(auth.tokens.access_token)) {
    throw new Error('Codex OAuth 状态缺少 access_token；请在控制台 Codex Tab 重新登录。');
  }
}

function assertCodexBackendAccount(auth: CodexAuthRecord): string {
  const accountId = resolveChatGptAccountId(auth);
  if (!accountId) {
    throw new Error('Codex OAuth 状态缺少 ChatGPT account id；请退出登录后在控制台 Codex Tab 重新登录。');
  }
  return accountId;
}

function classifyAuthErrorStatus(error: unknown): AdminAuthStatus {
  const message = error instanceof Error ? error.message : String(error);
  if (/ChatGPT account id/i.test(message)) return 'error';
  if (/尚未登录|缺少|not found|enoent/i.test(message)) return 'unauthenticated';
  if (/过期|expired|刷新失败|refresh/i.test(message)) return 'expired';
  return 'error';
}

function normalizeCodexModelId(model: unknown): string | null {
  const value = trimOptionalText(model);
  if (!value) return null;
  if (value.startsWith('openai/')) {
    const normalized = value.slice('openai/'.length).trim();
    return normalized && !normalized.includes('/') ? normalized : null;
  }
  return value.includes('/') ? null : value;
}

export function filterCodexModelCatalog(payload: unknown): CodexModelOption[] {
  const models = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { models?: unknown }).models)
      ? (payload as { models: unknown[] }).models
      : [];
  const result: CodexModelOption[] = [];
  const seen = new Set<string>();
  for (const item of models) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as CodexModelCatalogEntry;
    if (entry.supported_in_api !== true) continue;
    if (trimOptionalText(entry.visibility) !== 'list') continue;
    const rawModelId = trimOptionalText(entry.slug ?? entry.id);
    if (!rawModelId || rawModelId.includes('/')) continue;
    const modelId = normalizeCodexModelId(rawModelId);
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    result.push({
      modelId,
      label: trimOptionalText(entry.display_name ?? entry.name) ?? modelId,
    });
  }
  return result;
}

function buildOpenAIModelsPayload(models: readonly CodexModelOption[], catalog: CodexCatalogState) {
  return {
    object: 'list',
    data: models.map((model) => ({
      id: model.modelId,
      object: 'model',
      name: model.label,
      owned_by: 'codex',
      supported_endpoints: ['/v1/responses'],
      capabilities: {
        structured_outputs: true,
      },
    })),
    qqbot: {
      source: 'dynamic',
      catalog,
    },
  };
}

function withCodexClientMetadata(
  body: unknown,
  ids: { installationId: string; sessionId: string; threadId: string; turnId: string; windowId: string },
): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const source = body as Record<string, unknown>;
  const existingMetadata =
    source.client_metadata && typeof source.client_metadata === 'object' && !Array.isArray(source.client_metadata)
      ? source.client_metadata as Record<string, unknown>
      : {};
  const turnMetadata = {
    installation_id: ids.installationId,
    session_id: ids.sessionId,
    thread_id: ids.threadId,
    turn_id: ids.turnId,
    window_id: ids.windowId,
  };
  return {
    ...source,
    prompt_cache_key: trimOptionalText(source.prompt_cache_key) ?? ids.threadId,
    client_metadata: {
      ...existingMetadata,
      'x-codex-installation-id': ids.installationId,
      session_id: ids.sessionId,
      thread_id: ids.threadId,
      turn_id: ids.turnId,
      'x-codex-window-id': ids.windowId,
      'x-codex-turn-metadata': JSON.stringify(turnMetadata),
    },
  };
}

function readResponsesTextContent(content: unknown): string | null {
  if (typeof content === 'string') return trimOptionalText(content);
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((item): string[] => {
    if (typeof item === 'string') return [item];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const text = trimOptionalText((item as Record<string, unknown>).text);
    return text ? [text] : [];
  });
  return trimOptionalText(parts.join('\n'));
}

function liftCodexInstructionsFromInput(input: unknown): { input: unknown; instructions: string | null } {
  if (!Array.isArray(input)) {
    return { input, instructions: null };
  }

  const retained: unknown[] = [];
  const instructionParts: string[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      retained.push(item);
      continue;
    }
    const record = item as Record<string, unknown>;
    const role = trimOptionalText(record.role);
    if (role === 'system' || role === 'developer') {
      const content = readResponsesTextContent(record.content);
      if (content) instructionParts.push(content);
      continue;
    }
    retained.push(item);
  }

  return {
    input: retained,
    instructions: trimOptionalText(instructionParts.join('\n\n')),
  };
}

function normalizeCodexRequestBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const source = body as Record<string, unknown>;
  const model = normalizeCodexModelId(source.model);
  const { input, instructions: liftedInstructions } = liftCodexInstructionsFromInput(source.input);
  const existingInstructions = trimOptionalText(source.instructions);
  const instructions = [existingInstructions, liftedInstructions].filter((value): value is string => Boolean(value)).join('\n\n');
  const {
    temperature: _temperature,
    top_p: _topP,
    stop: _stop,
    max_output_tokens: _maxOutputTokens,
    ...codexBody
  } = source;
  return {
    ...codexBody,
    ...(model ? { model } : {}),
    ...(input !== source.input ? { input } : {}),
    instructions: instructions || 'You are ChatGPT, a helpful assistant.',
    store: false,
    stream: true,
  };
}

type ServerSentEvent = {
  event: string | null;
  data: string;
};

type NormalizedCodexUpstreamResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
} | null;

function parseServerSentEvents(raw: string): ServerSentEvent[] {
  const events: ServerSentEvent[] = [];
  let event: string | null = null;
  let dataLines: string[] = [];

  const flush = () => {
    if (event == null && dataLines.length === 0) return;
    events.push({ event, data: dataLines.join('\n') });
    event = null;
    dataLines = [];
  };

  for (const line of raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'data') dataLines.push(value);
  }
  flush();
  return events;
}

function readPayloadObject(payload: unknown, key: string): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readPayloadTextField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function readPayloadIndex(payload: unknown, key: string): number | null {
  const value = readPayloadNumber(payload, [key]);
  return value == null ? null : Math.max(0, Math.trunc(value));
}

function readOutputItem(payload: unknown): Record<string, unknown> | null {
  return readPayloadObject(payload, 'item');
}

function groupOutputTextParts(partsByIndex: Map<string, string>): Map<number, Map<number, string>> {
  const grouped = new Map<number, Map<number, string>>();
  for (const [key, text] of partsByIndex) {
    if (!text) continue;
    const [outputIndexText, contentIndexText] = key.split(':');
    const outputIndex = Number(outputIndexText);
    const contentIndex = Number(contentIndexText);
    if (!Number.isInteger(outputIndex) || !Number.isInteger(contentIndex)) continue;
    const content = grouped.get(outputIndex) ?? new Map<number, string>();
    content.set(contentIndex, text);
    grouped.set(outputIndex, content);
  }
  return grouped;
}

function patchMessageOutputText(item: unknown, textByContentIndex: Map<number, string>): Record<string, unknown> {
  const source = item && typeof item === 'object' && !Array.isArray(item)
    ? item as Record<string, unknown>
    : {};
  const contentByIndex = new Map<number, unknown>();
  const existingContent = Array.isArray(source.content) ? source.content : [];
  existingContent.forEach((part, index) => {
    contentByIndex.set(index, part);
  });
  for (const [contentIndex, text] of textByContentIndex) {
    const existing = contentByIndex.get(contentIndex);
    const base = existing && typeof existing === 'object' && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {};
    contentByIndex.set(contentIndex, {
      ...base,
      type: 'output_text',
      text,
    });
  }
  const content = [...contentByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, part]) => part);
  return {
    ...source,
    type: 'message',
    role: trimOptionalText(source.role) ?? 'assistant',
    content,
  };
}

function responseWithStreamedOutput(
  response: Record<string, unknown>,
  outputItemsByIndex: Map<number, Record<string, unknown>>,
  textPartsByIndex: Map<string, string>,
): Record<string, unknown> {
  const outputByIndex = new Map<number, unknown>();
  if (Array.isArray(response.output)) {
    response.output.forEach((item, index) => {
      outputByIndex.set(index, item);
    });
  }
  for (const [index, item] of outputItemsByIndex) {
    outputByIndex.set(index, item);
  }
  for (const [outputIndex, textByContentIndex] of groupOutputTextParts(textPartsByIndex)) {
    const current = outputByIndex.get(outputIndex);
    outputByIndex.set(outputIndex, patchMessageOutputText(current, textByContentIndex));
  }
  const output = [...outputByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, item]) => item)
    .filter((item) => item != null);
  if (output.length === 0 && Array.isArray(response.output)) return response;
  return {
    ...response,
    output,
  };
}

function normalizeCodexResponsesSse(raw: string): NormalizedCodexUpstreamResponse {
  let latestResponse: Record<string, unknown> | null = null;
  let terminalError: string | null = null;
  const outputTextParts = new Map<string, string>();
  const outputItemsByIndex = new Map<number, Record<string, unknown>>();

  for (const event of parseServerSentEvents(raw)) {
    const data = trimOptionalText(event.data);
    if (!data || data === '[DONE]') continue;

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      terminalError = `Codex SSE 响应包含非法 JSON：${data.slice(0, 200)}`;
      continue;
    }

    const response = readPayloadObject(payload, 'response');
    if (response) latestResponse = response;

    const type = trimOptionalText((payload as Record<string, unknown> | null)?.type) ?? event.event;
    if (type === 'response.output_text.delta') {
      const delta = readPayloadTextField(payload, 'delta');
      if (delta != null) {
        const outputIndex = readPayloadIndex(payload, 'output_index') ?? 0;
        const contentIndex = readPayloadIndex(payload, 'content_index') ?? 0;
        const key = `${outputIndex}:${contentIndex}`;
        outputTextParts.set(key, `${outputTextParts.get(key) ?? ''}${delta}`);
      }
    }
    if (type === 'response.output_text.done') {
      const text = readPayloadTextField(payload, 'text');
      if (text != null) {
        const outputIndex = readPayloadIndex(payload, 'output_index') ?? 0;
        const contentIndex = readPayloadIndex(payload, 'content_index') ?? 0;
        outputTextParts.set(`${outputIndex}:${contentIndex}`, text);
      }
    }
    if (type === 'response.output_item.done') {
      const outputIndex = readPayloadIndex(payload, 'output_index');
      const item = readOutputItem(payload);
      if (outputIndex != null && item) outputItemsByIndex.set(outputIndex, item);
    }
    if (type === 'response.completed' && response) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(responseWithStreamedOutput(response, outputItemsByIndex, outputTextParts)),
      };
    }

    if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') {
      const message = trimOptionalText(readPayloadObject(response, 'error')?.message)
        ?? trimOptionalText(readPayloadObject(payload, 'error')?.message)
        ?? readPayloadString(payload, ['message'])
        ?? `Codex SSE ended with ${type}`;
      terminalError = message;
    }
  }

  if (latestResponse && trimOptionalText(latestResponse.status) === 'completed') {
    return {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(responseWithStreamedOutput(latestResponse, outputItemsByIndex, outputTextParts)),
    };
  }
  if (!latestResponse && !terminalError) return null;
  return {
    status: 502,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(buildJsonError(terminalError ?? 'Codex SSE 响应没有 completed 事件。')),
  };
}

function looksLikeServerSentEvents(raw: string): boolean {
  const trimmed = raw.replace(/^\uFEFF/, '').trimStart();
  return trimmed.startsWith('event:') || trimmed.startsWith('data:');
}

function readPayloadString(payload: unknown, keys: readonly string[]): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = trimOptionalText(record[key]);
    if (value) return value;
  }
  return null;
}

function readPayloadNumber(payload: unknown, keys: readonly string[]): number | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function publicAttempt(attempt: StoredCodexAuthAttempt | null | undefined): CodexAuthAttempt | null {
  if (!attempt) return null;
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

function buildAttemptStatus(attempt: StoredCodexAuthAttempt): CodexAdminStatus {
  return {
    authKind: 'codex_oauth',
    authStatus: attempt.state === 'pending' ? 'pending' : attempt.state === 'authorized' ? 'ready' : attempt.state === 'expired' ? 'expired' : 'error',
    accountLabel: null,
    authError: attempt.error,
    tokenExpiresAt: null,
    attempt: publicAttempt(attempt),
  };
}

export class CodexOAuthBridgeService implements CodexBridgeStateProvider {
  readonly rootDir: string;
  readonly envFiles: ResolvedEnvFiles;
  readonly stateDir: string;
  readonly authFilePath: string;
  readonly secretFilePath: string;
  readonly releaseMetadataProvider: CodexReleaseMetadataProvider;
  private refreshPromise: Promise<CodexAuthRecord> | null = null;
  private readonly modelCatalogCache = new Map<string, CachedCodexModelCatalog>();
  private activeCatalogClientVersion: string | null = null;
  private modelCatalogError: string | null = null;
  private modelCatalogSyncedAt: string | null = null;
  private readonly loginAttempts = new Map<string, StoredCodexAuthAttempt>();
  private readonly installationId = randomUUID();
  private readonly sessionId = randomUUID();
  private readonly windowId = 'qqbot-koishi-codex-bridge';

  constructor(args: {
    rootDir: string;
    envFiles: ResolvedEnvFiles;
    releaseMetadataProvider?: CodexReleaseMetadataProvider;
  }) {
    this.rootDir = args.rootDir;
    this.envFiles = args.envFiles;
    this.stateDir = resolveCodexStateDir(this.rootDir, this.envFiles);
    this.authFilePath = join(this.stateDir, 'codex-chatgpt.oauth.json');
    this.secretFilePath = join(this.stateDir, 'codex-oauth.bridge-secret');
    this.releaseMetadataProvider = args.releaseMetadataProvider
      ?? new CodexReleaseMetadataProvider({ stateDir: this.stateDir });
  }

  async getRuntimeConfig(): Promise<CodexBridgeRuntimeConfig> {
    return {
      baseUrl: buildCodexBridgeBaseUrl(process.env),
      apiKey: await this.ensureBridgeSecret(),
    };
  }

  async getCatalogStatus(): Promise<CodexCatalogState> {
    const release = await this.releaseMetadataProvider.getState();
    if (release.status === 'unavailable') return release;
    if (this.modelCatalogError) {
      return {
        ...release,
        status: 'degraded',
        fetchedAt: this.modelCatalogSyncedAt ?? release.fetchedAt,
        error: this.modelCatalogError,
      };
    }
    return {
      ...release,
      fetchedAt: this.modelCatalogSyncedAt ?? release.fetchedAt,
    };
  }

  async refreshReleaseMetadata(options: { force?: boolean } = {}): Promise<CodexCatalogState> {
    const previousVersion = (await this.releaseMetadataProvider.getState()).clientVersion;
    const state = await this.releaseMetadataProvider.refresh(options);
    if (state.clientVersion && previousVersion && state.clientVersion !== previousVersion) {
      this.modelCatalogCache.clear();
      this.activeCatalogClientVersion = state.clientVersion;
      this.modelCatalogSyncedAt = null;
    }
    return state;
  }

  async getAdminStatus(options: { probe?: boolean } = {}): Promise<CodexAdminStatus> {
    const pending = [...this.loginAttempts.values()].find((attempt) => attempt.state === 'pending');
    if (pending) {
      if (pending.expiresAt <= Date.now()) {
        pending.state = 'expired';
        pending.error = 'Codex OAuth 登录验证码已过期，请重新开始登录。';
      }
      return buildAttemptStatus(pending);
    }

    try {
      const auth = await this.readAuthRecord();
      assertManagedChatGptAuth(auth);
      const expiresAt = decodeJwtExpiresAtMs(auth.tokens.access_token);
      const accountId = assertCodexBackendAccount(auth);
      const accountLabel = formatAccountLabel(auth) ?? accountId;
      if (options.probe) {
        const refreshed = await this.resolveAuthRecord({ forceRefresh: false });
        const refreshedAccountId = assertCodexBackendAccount(refreshed);
        return {
          authKind: 'codex_oauth',
          authStatus: 'ready',
          accountLabel: formatAccountLabel(refreshed) ?? refreshedAccountId,
          authError: null,
          tokenExpiresAt: decodeJwtExpiresAtMs(refreshed.tokens?.access_token),
          attempt: null,
        };
      }
      return {
        authKind: 'codex_oauth',
        authStatus: expiresAt != null && expiresAt <= Date.now() ? 'expired' : 'ready',
        accountLabel,
        authError: null,
        tokenExpiresAt: expiresAt,
        attempt: null,
      };
    } catch (error) {
      return {
        authKind: 'codex_oauth',
        authStatus: classifyAuthErrorStatus(error),
        accountLabel: null,
        authError: error instanceof Error ? error.message : String(error),
        tokenExpiresAt: null,
        attempt: null,
      };
    }
  }

  async startLogin(): Promise<CodexAdminStatus> {
    const response = await this.requestDeviceCode();
    const attemptId = randomUUID();
    const now = Date.now();
    const expiresInSec = Math.max(60, readPayloadNumber(response, ['expires_in']) ?? CODEX_DEVICE_EXPIRES_IN_SEC);
    const intervalSec = Math.max(1, readPayloadNumber(response, ['interval']) ?? CODEX_DEVICE_POLL_INTERVAL_SEC);
    const attempt: StoredCodexAuthAttempt = {
      attemptId,
      userCode: readPayloadString(response, ['user_code', 'userCode', 'usercode']) ?? '',
      verificationUri: readPayloadString(response, ['verification_uri', 'verification_url', 'verificationUri']) ?? codexDeviceVerificationUri(),
      expiresAt: now + expiresInSec * 1000,
      intervalSec,
      nextPollAt: now,
      state: 'pending',
      error: null,
      deviceCode: readPayloadString(response, ['device_auth_id', 'deviceAuthId', 'device_code', 'deviceCode']) ?? '',
      codeVerifier: '',
      clientId: String(response.__client_id ?? resolveClientId(null)),
    };
    if (!attempt.deviceCode) {
      throw new Error('Codex OAuth 设备登录失败：设备码响应缺少 device_code。');
    }
    if (!attempt.userCode) {
      throw new Error('Codex OAuth 设备登录失败：设备码响应缺少 user_code。');
    }
    this.loginAttempts.clear();
    this.loginAttempts.set(attemptId, attempt);
    return buildAttemptStatus(attempt);
  }

  async pollLogin(attemptId: string): Promise<CodexAdminStatus> {
    const attempt = this.loginAttempts.get(String(attemptId ?? ''));
    if (!attempt) {
      return this.getAdminStatus();
    }
    if (attempt.state !== 'pending') {
      return buildAttemptStatus(attempt);
    }
    if (attempt.expiresAt <= Date.now()) {
      attempt.state = 'expired';
      attempt.error = 'Codex OAuth 登录验证码已过期，请重新开始登录。';
      return buildAttemptStatus(attempt);
    }
    if (attempt.nextPollAt > Date.now()) {
      return buildAttemptStatus(attempt);
    }

    try {
      const payload = await this.pollDeviceToken(attempt);
      const error = trimOptionalText(payload.error);
      if (error === 'authorization_pending') {
        attempt.nextPollAt = Date.now() + attempt.intervalSec * 1000;
        return buildAttemptStatus(attempt);
      }
      if (error === 'slow_down') {
        attempt.intervalSec += 2;
        attempt.nextPollAt = Date.now() + attempt.intervalSec * 1000;
        return buildAttemptStatus(attempt);
      }
      if (error) {
        attempt.state = error === 'expired_token' ? 'expired' : 'failed';
        attempt.error = trimOptionalText(payload.error_description) ?? `Codex OAuth 登录失败：${error}`;
        return buildAttemptStatus(attempt);
      }

      const codeVerifier = readPayloadString(payload, ['code_verifier']);
      if (codeVerifier) {
        attempt.codeVerifier = codeVerifier;
      }
      const tokens = trimOptionalText(payload.access_token)
        ? payload
        : await this.exchangeAuthorizationCode(
          readPayloadString(payload, ['authorization_code', 'code', 'auth_code']),
          attempt,
        );
      const auth = await this.persistTokenResponse(tokens);
      const accountId = assertCodexBackendAccount(auth);
      attempt.state = 'authorized';
      attempt.error = null;
      this.loginAttempts.delete(attempt.attemptId);
      return {
        authKind: 'codex_oauth',
        authStatus: 'ready',
        accountLabel: formatAccountLabel(auth) ?? accountId,
        authError: null,
        tokenExpiresAt: decodeJwtExpiresAtMs(auth.tokens?.access_token),
        attempt: null,
      };
    } catch (error) {
      attempt.state = 'failed';
      attempt.error = error instanceof Error ? error.message : String(error);
      return buildAttemptStatus(attempt);
    }
  }

  async cancelLogin(attemptId: string): Promise<CodexAdminStatus> {
    const attempt = this.loginAttempts.get(String(attemptId ?? ''));
    if (attempt) {
      attempt.state = 'cancelled';
      attempt.error = 'Codex OAuth 登录已取消。';
      this.loginAttempts.delete(attempt.attemptId);
    }
    return this.getAdminStatus();
  }

  async logout(): Promise<CodexAdminStatus> {
    this.loginAttempts.clear();
    await rm(this.authFilePath, { force: true });
    return {
      authKind: 'codex_oauth',
      authStatus: 'unauthenticated',
      accountLabel: null,
      authError: null,
      tokenExpiresAt: null,
      attempt: null,
    };
  }

  async proxyModels(options: { forceRefresh?: boolean } = {}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    try {
      const models = await this.listModelOptions(options);
      const catalog = await this.getCatalogStatus();
      return {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(buildOpenAIModelsPayload(models, catalog)),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const releaseError = error instanceof CodexReleaseMetadataError;
      const catalogError = error instanceof CodexModelCatalogError;
      return {
        status: releaseError ? 503 : 502,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(buildJsonError(
          message,
          'upstream_error',
          releaseError
            ? error.code
            : catalogError
              ? error.code
              : 'codex_model_catalog_unavailable',
        )),
      };
    }
  }

  async proxyResponses(body: unknown): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return this.proxyUpstreamResponses(normalizeCodexRequestBody(body), false);
  }

  async listModelOptions(options: { forceRefresh?: boolean } = {}): Promise<CodexModelOption[]> {
    try {
      const models = await this.readModelCatalogFromBackend(options);
      this.modelCatalogError = null;
      return models;
    } catch (error) {
      this.modelCatalogError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private async ensureBridgeSecret(): Promise<string> {
    const persisted = trimOptionalText(await readTextIfExists(this.secretFilePath));
    if (persisted) return persisted;

    const generated = `qqbot-codex-${randomBytes(24).toString('hex')}`;
    await writeFileAtomic(this.secretFilePath, `${generated}\n`);
    return generated;
  }

  private async readAuthRecord(): Promise<CodexAuthRecord | null> {
    return readJsonIfExists<CodexAuthRecord>(this.authFilePath);
  }

  private async resolveBackendAuthContext(options: { forceRefresh?: boolean }): Promise<CodexBackendAuthContext> {
    const auth = await this.resolveAuthRecord(options);
    const token = trimOptionalText(auth.tokens?.access_token);
    if (!token) throw new Error('Codex OAuth 状态缺少 access_token；请在控制台 Codex Tab 重新登录。');
    return {
      accessToken: token,
      accountId: assertCodexBackendAccount(auth),
      isFedrampAccount: resolveChatGptAccountIsFedramp(auth),
    };
  }

  private async resolveAuthRecord(options: { forceRefresh?: boolean }): Promise<CodexAuthRecord> {
    const auth = await this.readAuthRecord();
    assertManagedChatGptAuth(auth);
    const expiresAt = decodeJwtExpiresAtMs(auth.tokens.access_token);
    const usable = expiresAt == null || expiresAt - Date.now() > TOKEN_EXPIRY_SKEW_MS;
    if (!options.forceRefresh && usable) return auth;

    const refreshToken = trimOptionalText(auth.tokens.refresh_token);
    if (!refreshToken) {
      throw new Error('Codex OAuth access token 已过期，且状态文件缺少 refresh_token；请在控制台 Codex Tab 重新登录。');
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAuthRecord(auth, refreshToken).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async requestDeviceCode(): Promise<CodexDeviceCodeResponse & { __code_verifier: string; __client_id: string }> {
    const clientId = resolveClientId(null);
    const response = await fetchCodexExternal(codexDeviceCodeUrl(), 'Codex OAuth 设备码申请', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as CodexDeviceCodeResponse;
    if (!response.ok) {
      const detail = formatOpenAiErrorPayload(payload);
      const hint = response.status === 404
        ? '；OpenAI 文档说明 device code 登录需要在 ChatGPT 账号或工作区权限中启用。'
        : '';
      throw new Error(`Codex OAuth 设备码申请失败：HTTP ${response.status}${detail ? ` (${detail})` : ''}${hint}`);
    }
    return {
      ...payload,
      __code_verifier: '',
      __client_id: clientId,
    };
  }

  private async pollDeviceToken(attempt: StoredCodexAuthAttempt): Promise<CodexDeviceTokenResponse> {
    const response = await fetchCodexExternal(codexDeviceTokenUrl(), 'Codex OAuth 登录轮询', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        device_auth_id: attempt.deviceCode,
        user_code: attempt.userCode,
      }),
    });
    if (response.status === 403 || response.status === 404) {
      return { error: 'authorization_pending' };
    }
    const payload = (await response.json().catch(() => ({}))) as CodexDeviceTokenResponse;
    if (!response.ok && !payload.error) {
      throw new Error(`Codex OAuth 登录轮询失败：HTTP ${response.status}`);
    }
    return payload;
  }

  private async exchangeAuthorizationCode(code: string | null, attempt: StoredCodexAuthAttempt): Promise<CodexTokenResponse> {
    if (!code) {
      throw new Error('Codex OAuth 登录失败：轮询响应缺少 authorization code。');
    }
    if (!attempt.codeVerifier) {
      throw new Error('Codex OAuth 登录失败：轮询响应缺少 code_verifier。');
    }
    const response = await fetchCodexExternal(codexTokenUrl(), 'Codex OAuth token 交换', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: codexDeviceRedirectUri(),
        client_id: attempt.clientId,
        code_verifier: attempt.codeVerifier,
      }),
    });
    if (!response.ok) {
      throw new Error(`Codex OAuth token 交换失败：HTTP ${response.status}`);
    }
    return (await response.json()) as CodexTokenResponse;
  }

  private async persistTokenResponse(payload: CodexTokenResponse, previousAuth?: CodexAuthRecord | null): Promise<CodexAuthRecord> {
    const accessToken = trimOptionalText(payload.access_token);
    if (!accessToken) {
      throw new Error('Codex OAuth token 响应缺少 access_token。');
    }
    const idToken = trimOptionalText(payload.id_token) ?? previousAuth?.tokens?.id_token ?? null;
    const accountId = trimOptionalText(payload.account_id)
      ?? resolveChatGptAccountIdFromPayload(decodeJwtPayload(idToken))
      ?? resolveChatGptAccountIdFromPayload(decodeJwtPayload(accessToken))
      ?? previousAuth?.tokens?.account_id
      ?? null;
    const nextAuth: CodexAuthRecord = {
      ...(previousAuth ?? {}),
      auth_mode: 'chatgpt',
      tokens: {
        ...(previousAuth?.tokens ?? {}),
        access_token: accessToken,
        refresh_token: trimOptionalText(payload.refresh_token) ?? previousAuth?.tokens?.refresh_token ?? null,
        id_token: idToken,
        account_id: accountId,
      },
      last_refresh: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await writeJsonFile(this.authFilePath, nextAuth);
    return nextAuth;
  }

  private async refreshAuthRecord(auth: CodexAuthRecord, refreshToken: string): Promise<CodexAuthRecord> {
    const clientId = resolveClientId(auth);
    const response = await fetchCodexExternal(codexTokenUrl(), 'Codex OAuth token 刷新', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
    if (!response.ok) {
      throw new Error(`Codex OAuth token 刷新失败：HTTP ${response.status}`);
    }
    return this.persistTokenResponse((await response.json()) as CodexTokenResponse, auth);
  }

  private buildCodexBackendHeaders(
    auth: CodexBackendAuthContext,
    accept: string,
    clientVersion: string,
    requestIds?: { threadId: string },
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: accept,
      Authorization: `Bearer ${auth.accessToken}`,
      'ChatGPT-Account-ID': auth.accountId,
      originator: codexOriginator(),
      'User-Agent': `${codexOriginator()}/${clientVersion}`,
      version: clientVersion,
    };
    if (requestIds) {
      headers['session-id'] = this.sessionId;
      headers['thread-id'] = requestIds.threadId;
    }
    if (auth.isFedrampAccount) {
      headers['X-OpenAI-Fedramp'] = 'true';
    }
    return headers;
  }

  private async readModelCatalogFromBackend(options: { forceRefresh?: boolean }): Promise<CodexModelOption[]> {
    const release = await this.releaseMetadataProvider.requireFresh();
    this.activateCatalogVersion(release);
    const cached = this.modelCatalogCache.get(release.version);
    if (!options.forceRefresh && cached && Date.now() - cached.fetchedAt < MODEL_CATALOG_TTL_MS) {
      return cached.models.map((model) => ({ ...model }));
    }

    const url = new URL(codexBackendUrl('/models'));
    url.searchParams.set('client_version', release.version);
    const request = async (forceAuthRefresh: boolean): Promise<Response> => {
      const auth = await this.resolveBackendAuthContext({ forceRefresh: forceAuthRefresh });
      const headers = this.buildCodexBackendHeaders(auth, 'application/json', release.version);
      if (cached?.etag) headers['If-None-Match'] = cached.etag;
      return fetchCodexExternal(url.toString(), 'Codex 模型列表请求', {
        method: 'GET',
        headers,
      });
    };

    let response = await request(false);
    if (response.status === 401) {
      response = await request(true);
    }
    if (response.status === 304) {
      if (!cached) {
        throw new CodexModelCatalogError('Codex 模型列表返回 HTTP 304，但当前 clientVersion 没有可复用缓存。', 304);
      }
      cached.fetchedAt = Date.now();
      this.modelCatalogSyncedAt = new Date(cached.fetchedAt).toISOString();
      return cached.models.map((model) => ({ ...model }));
    }
    if (!response.ok) {
      const raw = await response.text();
      let detail = trimOptionalText(raw);
      try {
        detail = formatOpenAiErrorPayload(JSON.parse(raw)) ?? detail;
      } catch {
        // Preserve the upstream text when the error body is not JSON.
      }
      throw new CodexModelCatalogError(
        `Codex 模型列表请求失败：HTTP ${response.status}${detail ? ` / ${detail.slice(0, 240)}` : ''}`,
        response.status,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new CodexModelCatalogError(
        `Codex 模型列表响应不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        response.status,
      );
    }
    const models = filterCodexModelCatalog(payload);
    if (models.length === 0) {
      throw new CodexModelCatalogError('Codex 模型列表没有可见且支持 API 的模型。', response.status);
    }
    this.modelCatalogCache.set(release.version, {
      clientVersion: release.version,
      etag: trimOptionalText(response.headers.get('etag')),
      fetchedAt: Date.now(),
      models: models.map((model) => ({ ...model })),
    });
    this.modelCatalogSyncedAt = new Date().toISOString();
    return models;
  }

  private activateCatalogVersion(release: CodexReleaseMetadataRecord): void {
    if (this.activeCatalogClientVersion === release.version) return;
    this.modelCatalogCache.clear();
    this.activeCatalogClientVersion = release.version;
    this.modelCatalogSyncedAt = null;
  }

  private async proxyUpstreamResponses(
    body: unknown,
    retried: boolean,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    try {
      const auth = await this.resolveBackendAuthContext({ forceRefresh: retried });
      const release = await this.releaseMetadataProvider.requireLastKnown();
      const threadId = randomUUID();
      const turnId = randomUUID();
      const upstreamBody = withCodexClientMetadata(body ?? {}, {
        installationId: this.installationId,
        sessionId: this.sessionId,
        threadId,
        turnId,
        windowId: this.windowId,
      });
      const upstream = await fetchCodexExternalWithContext(codexBackendUrl('/responses'), 'Codex Responses 请求', {
        method: 'POST',
        headers: {
          ...this.buildCodexBackendHeaders(auth, 'text/event-stream, application/json', release.version, { threadId }),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(upstreamBody),
      });
      const { response } = upstream;
      if (response.status === 401 && !retried) {
        return this.proxyUpstreamResponses(body, true);
      }
      const text = await readCodexExternalText(upstream, 'Codex Responses 响应体读取');
      const contentType = response.headers.get('content-type') ?? 'application/json; charset=utf-8';
      if (contentType.toLowerCase().includes('text/event-stream') || looksLikeServerSentEvents(text)) {
        const normalized = normalizeCodexResponsesSse(text);
        if (normalized) return normalized;
      }
      return {
        status: response.status,
        headers: { 'content-type': contentType },
        body: text,
      };
    } catch (error) {
      const releaseError = error instanceof CodexReleaseMetadataError;
      const transportError = error instanceof CodexUpstreamTransportError;
      return {
        status: releaseError ? 503 : transportError ? 502 : 401,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(buildJsonError(
          error instanceof Error ? error.message : String(error),
          releaseError || transportError ? 'upstream_error' : 'invalid_request_error',
          releaseError ? error.code : transportError ? error.providerCode : undefined,
        )),
      };
    }
  }
}
