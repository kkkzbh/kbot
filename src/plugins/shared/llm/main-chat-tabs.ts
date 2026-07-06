import {
  createReplyOutputContract,
  type ReplyOutputContract,
  type ReplyOutputProtocol,
} from './reply-output-contract.js';

export type MainChatBuiltinTabId = 'siliconflow' | 'openai' | 'codex' | 'copilot' | 'deepseek' | 'mimo';
export type MainChatProvider = 'siliconflow' | 'openai' | 'deepseek' | 'mimo';
export type MainChatRequestMode = 'chat_completions' | 'responses';
export type OutputProtocolId = ReplyOutputProtocol;
export type StructuredOutputProtocol = OutputProtocolId;
export type MainChatAuthKind = 'manual' | 'oauth_device' | 'codex_oauth';
export type MainChatAuthStatus = 'unauthenticated' | 'pending' | 'ready' | 'expired' | 'error';
export type MainChatReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface MainChatTabEnvKeys {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  reasoningEffort?: string;
}

export interface BuiltinTabDefinition {
  id: MainChatBuiltinTabId;
  title: string;
  provider: MainChatProvider;
  envKeys: MainChatTabEnvKeys;
  defaultBaseUrl: string;
  defaultModel: string;
  strategyId: MainChatProviderStrategy['id'];
}

export type MainChatReplyOutputContract = ReplyOutputContract;

export interface MainChatConsoleDescription {
  description: string;
  modelHint: string;
}

export interface CopilotModelOption {
  modelId: string;
  label: string;
  rateLabel?: string;
  requestMode: MainChatRequestMode;
  structuredOutputProtocol: OutputProtocolId;
  deprecated?: boolean;
}

export interface CodexModelOption {
  modelId: string;
  label: string;
}

export interface DeepSeekModelOption {
  modelId: string;
  label: string;
  deprecated?: boolean;
  deprecationDate?: string;
}

export interface MimoModelOption {
  modelId: string;
  label: string;
}

export interface MainChatProviderStrategy {
  id: 'siliconflow-kimi-main-chat' | 'openai-gpt54-main-chat' | 'codex-chatgpt-oauth-main-chat' | 'copilot-github-oauth-main-chat' | 'deepseek-official-main-chat' | 'mimo-official-main-chat';
  platform: MainChatProvider;
  supportsModel: (model?: string | null) => boolean;
  buildRequestOverride: (model?: string | null, options?: MainChatStrategyOptions) => Record<string, unknown> | null;
  buildReplyOutputContract: (model?: string | null, options?: MainChatStrategyOptions) => MainChatReplyOutputContract;
  normalizeModel: (model?: string | null) => string | null;
  transportModel: (model?: string | null) => string | null;
  resolveRequestMode: (model?: string | null) => MainChatRequestMode;
  resolveStructuredOutputProtocol: (model?: string | null) => StructuredOutputProtocol;
  describeForConsole: (model?: string | null, options?: MainChatStrategyOptions) => MainChatConsoleDescription;
}

export interface MainChatStrategyOptions {
  reasoningEffort?: MainChatReasoningEffort | null;
}

function buildMainChatReplyOutputContract(args: {
  requestMode: MainChatRequestMode;
  protocol: StructuredOutputProtocol;
  overrideRequestParams: Record<string, unknown> | null;
}): MainChatReplyOutputContract {
  return createReplyOutputContract({
    requestMode: args.requestMode,
    protocol: args.protocol,
    overrideRequestParams: args.overrideRequestParams,
  });
}

export interface MainChatModelDescriptor {
  tabId: MainChatBuiltinTabId;
  provider: MainChatProvider;
  strategyId: MainChatProviderStrategy['id'];
  requestMode: MainChatRequestMode;
  canonicalModel: string;
  transportModel: string;
}

export interface MainChatRuntimeProfile {
  tabId: MainChatBuiltinTabId;
  title: string;
  provider: MainChatProvider;
  strategyId: MainChatProviderStrategy['id'];
  requestMode: MainChatRequestMode;
  structuredOutputProtocol: StructuredOutputProtocol;
  authKind: MainChatAuthKind;
  authStatus: MainChatAuthStatus;
  accountLabel?: string | null;
  authError?: string | null;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  reasoningEffort?: MainChatReasoningEffort | null;
  canonicalModel: string;
  transportModel: string;
  description: string;
  modelHint: string;
}

export interface MainChatBuiltinTabState extends MainChatRuntimeProfile {
  id: MainChatBuiltinTabId;
}

export const WYZAI_DEFAULT_BASE_URL = 'https://shell.wyzai.top/v1';
export const WYZAI_DEFAULT_API_KEY = 'sk-AU2PaFWvQImSIbTtXkx9t286QyCgUUh8Ith5R0mBa9yOsr43';
export const OPENAI_DEFAULT_MODEL = 'openai/gpt-5.4-medium-thinking';
export const SILICONFLOW_DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1';
export const SILICONFLOW_DEFAULT_MODEL = 'Pro/moonshotai/Kimi-K2.5';
export const CODEX_BRIDGE_DEFAULT_BASE_URL = 'http://127.0.0.1:5140/api/internal/codex/v1';
export const CODEX_DEFAULT_MODEL = 'openai/gpt-5.5';
export const CODEX_DEFAULT_REASONING_EFFORT = 'medium' as const satisfies MainChatReasoningEffort;
export const COPILOT_BRIDGE_DEFAULT_BASE_URL = 'http://127.0.0.1:5140/api/internal/copilot/v1';
export const COPILOT_AUTO_MODEL_ID = 'auto';
export const COPILOT_DEFAULT_MODEL = `openai/${COPILOT_AUTO_MODEL_ID}`;
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
export const MIMO_DEFAULT_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';
export const MIMO_DEFAULT_MODEL = 'mimo-v2.5-pro';
export const MAIN_CHAT_BUILTIN_TAB_IDS = ['siliconflow', 'openai', 'codex', 'copilot', 'deepseek', 'mimo'] as const satisfies readonly MainChatBuiltinTabId[];
export const COPILOT_MODEL_OPTIONS = [
  {
    modelId: COPILOT_AUTO_MODEL_ID,
    label: 'Auto',
    requestMode: 'responses',
    structuredOutputProtocol: 'native_responses_json_schema',
  },
] as const satisfies readonly CopilotModelOption[];

export const DEEPSEEK_OFFICIAL_MODEL_OPTIONS = [
  {
    modelId: 'deepseek-v4-flash',
    label: 'deepseek-v4-flash',
  },
  {
    modelId: 'deepseek-v4-pro',
    label: 'deepseek-v4-pro',
  },
  {
    modelId: 'deepseek-chat',
    label: 'deepseek-chat',
    deprecated: true,
    deprecationDate: '2026-07-24',
  },
  {
    modelId: 'deepseek-reasoner',
    label: 'deepseek-reasoner',
    deprecated: true,
    deprecationDate: '2026-07-24',
  },
] as const satisfies readonly DeepSeekModelOption[];

export const MIMO_CHAT_MODEL_OPTIONS = [
  { modelId: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro' },
  { modelId: 'mimo-v2.5', label: 'MiMo V2.5' },
  { modelId: 'mimo-v2-pro', label: 'MiMo V2 Pro' },
  { modelId: 'mimo-v2-omni', label: 'MiMo V2 Omni' },
] as const satisfies readonly MimoModelOption[];

export const CODEX_MODEL_OPTIONS = [
  { modelId: 'gpt-5.5', label: 'GPT-5.5' },
  { modelId: 'gpt-5.4', label: 'GPT-5.4' },
  { modelId: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
] as const satisfies readonly CodexModelOption[];

export const CODEX_REASONING_EFFORT_OPTIONS = [
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '极高' },
] as const satisfies readonly { id: MainChatReasoningEffort; label: string }[];

export function formatCopilotModelOptionLabel(option: CopilotModelOption): string {
  const rateLabel = option.rateLabel?.trim();
  if (option.deprecated && rateLabel) return `${option.label} (${rateLabel}, 可能弃用)`;
  if (option.deprecated) return `${option.label} (可能弃用)`;
  return rateLabel ? `${option.label} (${rateLabel})` : option.label;
}

export function getCopilotModelOption(model?: string | null): CopilotModelOption | null {
  const normalized = normalizeCopilotModelId(model);
  if (!normalized) return null;
  return COPILOT_MODEL_OPTIONS.find((option) => option.modelId === normalized) ?? null;
}

const codexDynamicModelOptions = new Map<string, CodexModelOption>();

export function getCodexModelOption(model?: string | null): CodexModelOption | null {
  const normalized = normalizeCodexModelId(model);
  if (!normalized) return null;
  return codexDynamicModelOptions.get(normalized) ?? CODEX_MODEL_OPTIONS.find((option) => option.modelId === normalized) ?? null;
}

export function registerCodexDynamicModelOptions(models: readonly CodexModelOption[]): void {
  for (const model of models) {
    const modelId = normalizeCodexModelId(model.modelId);
    if (!modelId) continue;
    codexDynamicModelOptions.set(modelId, {
      ...model,
      modelId,
    });
  }
}

export function formatDeepSeekModelOptionLabel(option: DeepSeekModelOption): string {
  return option.deprecated && option.deprecationDate
    ? `${option.label} (deprecated ${option.deprecationDate})`
    : option.label;
}

export function getDeepSeekOfficialModelOption(model?: string | null): DeepSeekModelOption | null {
  const normalized = normalizeDeepSeekModelId(model);
  if (!normalized) return null;
  return DEEPSEEK_OFFICIAL_MODEL_OPTIONS.find((option) => option.modelId === normalized) ?? null;
}

export function getMimoChatModelOption(model?: string | null): MimoModelOption | null {
  const normalized = normalizeMimoModelId(model);
  if (!normalized) return null;
  return MIMO_CHAT_MODEL_OPTIONS.find((option) => option.modelId === normalized) ?? null;
}

export const BUILTIN_MAIN_CHAT_TABS: readonly BuiltinTabDefinition[] = [
  {
    id: 'siliconflow',
    title: '硅基流动',
    provider: 'siliconflow',
    envKeys: {
      baseUrl: 'CHATLUNA_SILICONFLOW_BASE_URL',
      apiKey: 'CHATLUNA_SILICONFLOW_API_KEY',
      defaultModel: 'CHATLUNA_SILICONFLOW_DEFAULT_MODEL',
    },
    defaultBaseUrl: SILICONFLOW_DEFAULT_BASE_URL,
    defaultModel: SILICONFLOW_DEFAULT_MODEL,
    strategyId: 'siliconflow-kimi-main-chat',
  },
  {
    id: 'openai',
    title: 'OpenAI',
    provider: 'openai',
    envKeys: {
      baseUrl: 'CHATLUNA_OPENAI_BASE_URL',
      apiKey: 'CHATLUNA_OPENAI_API_KEY',
      defaultModel: 'CHATLUNA_OPENAI_DEFAULT_MODEL',
    },
    defaultBaseUrl: WYZAI_DEFAULT_BASE_URL,
    defaultModel: OPENAI_DEFAULT_MODEL,
    strategyId: 'openai-gpt54-main-chat',
  },
  {
    id: 'codex',
    title: 'Codex',
    provider: 'openai',
    envKeys: {
      baseUrl: 'CHATLUNA_CODEX_BASE_URL',
      apiKey: 'CHATLUNA_CODEX_API_KEY',
      defaultModel: 'CHATLUNA_CODEX_DEFAULT_MODEL',
      reasoningEffort: 'CHATLUNA_CODEX_REASONING_EFFORT',
    },
    defaultBaseUrl: CODEX_BRIDGE_DEFAULT_BASE_URL,
    defaultModel: CODEX_DEFAULT_MODEL,
    strategyId: 'codex-chatgpt-oauth-main-chat',
  },
  {
    id: 'copilot',
    title: 'GitHub Copilot',
    provider: 'openai',
    envKeys: {
      baseUrl: 'CHATLUNA_COPILOT_BASE_URL',
      apiKey: 'CHATLUNA_COPILOT_API_KEY',
      defaultModel: 'CHATLUNA_COPILOT_DEFAULT_MODEL',
    },
    defaultBaseUrl: COPILOT_BRIDGE_DEFAULT_BASE_URL,
    defaultModel: COPILOT_DEFAULT_MODEL,
    strategyId: 'copilot-github-oauth-main-chat',
  },
  {
    id: 'deepseek',
    title: 'DeepSeek',
    provider: 'deepseek',
    envKeys: {
      baseUrl: 'CHATLUNA_DEEPSEEK_BASE_URL',
      apiKey: 'CHATLUNA_DEEPSEEK_API_KEY',
      defaultModel: 'CHATLUNA_DEEPSEEK_DEFAULT_MODEL',
    },
    defaultBaseUrl: DEEPSEEK_DEFAULT_BASE_URL,
    defaultModel: DEEPSEEK_DEFAULT_MODEL,
    strategyId: 'deepseek-official-main-chat',
  },
  {
    id: 'mimo',
    title: 'MIMO',
    provider: 'mimo',
    envKeys: {
      baseUrl: 'CHATLUNA_MIMO_BASE_URL',
      apiKey: 'CHATLUNA_MIMO_API_KEY',
      defaultModel: 'CHATLUNA_MIMO_DEFAULT_MODEL',
    },
    defaultBaseUrl: MIMO_DEFAULT_BASE_URL,
    defaultModel: MIMO_DEFAULT_MODEL,
    strategyId: 'mimo-official-main-chat',
  },
] as const;

export const MAIN_CHAT_PROVIDER_STRATEGIES: readonly MainChatProviderStrategy[] = [
  {
    id: 'siliconflow-kimi-main-chat',
    platform: 'siliconflow',
    supportsModel: isSiliconFlowKimiK25Model,
    buildRequestOverride(model) {
      if (!isSiliconFlowKimiK25Model(model)) return null;
      return {
        thinking: {
          type: 'disabled',
        },
      };
    },
    buildReplyOutputContract(model) {
      return buildMainChatReplyOutputContract({
        requestMode: this.resolveRequestMode(model),
        protocol: this.resolveStructuredOutputProtocol(model),
        overrideRequestParams: this.buildRequestOverride(model),
      });
    },
    normalizeModel(model) {
      return normalizeSiliconFlowKimiK25ModelId(model);
    },
    transportModel(model) {
      return normalizeSiliconFlowKimiK25ModelId(model);
    },
    resolveRequestMode() {
      return 'chat_completions';
    },
    resolveStructuredOutputProtocol() {
      return 'native_chat_json_schema';
    },
    describeForConsole() {
      return {
        description: '当前主聊天固定走硅基流动 provider，接口地址锁定为官方 API，默认使用 Kimi-K2.5。',
        modelHint: '当前仅支持 Pro/moonshotai/Kimi-K2.5。',
      };
    },
  },
  {
    id: 'openai-gpt54-main-chat',
    platform: 'openai',
    supportsModel: isOpenAIGpt54ModelFamily,
    buildRequestOverride(model) {
      if (!isOpenAIGpt54ModelFamily(model)) return null;
      const canonicalModel = this.normalizeModel(model);
      const transportModel = this.transportModel(canonicalModel);
      return {
        qqbot_canonical_model: canonicalModel,
        qqbot_transport_model: transportModel,
        qqbot_tool_profile: 'qqbot_openai_main_chat',
        reasoning: {
          effort: resolveOpenAIGpt54ReasoningEffort(model),
        },
      };
    },
    buildReplyOutputContract(model) {
      return buildMainChatReplyOutputContract({
        requestMode: this.resolveRequestMode(model),
        protocol: this.resolveStructuredOutputProtocol(model),
        overrideRequestParams: this.buildRequestOverride(model),
      });
    },
    normalizeModel(model) {
      return normalizeOpenAICanonicalModelId(model);
    },
    transportModel(model) {
      return normalizeProviderTransportModel(model);
    },
    resolveRequestMode() {
      return 'chat_completions';
    },
    resolveStructuredOutputProtocol() {
      return 'native_chat_json_schema';
    },
    describeForConsole() {
      return {
        description: '当前按 OpenAI 兼容 provider 处理，默认预填 wyzai + gpt-5.4-medium-thinking，并走 chat/completions 结构化输出。',
        modelHint: '推荐填写 openai/gpt-5.4-medium-thinking。当前 OpenAI Tab 默认接入 wyzai。',
      };
    },
  },
  {
    id: 'codex-chatgpt-oauth-main-chat',
    platform: 'openai',
    supportsModel: isCodexModelId,
    buildRequestOverride(model, options) {
      const canonicalModel = this.normalizeModel(model);
      if (!canonicalModel) return null;
      const transportModel = this.transportModel(canonicalModel);
      if (!transportModel) return null;
      return {
        qqbot_request_mode: 'responses',
        qqbot_canonical_model: canonicalModel,
        qqbot_transport_model: transportModel,
        qqbot_tool_profile: 'qqbot_openai_main_chat',
        reasoning: {
          effort: normalizeCodexReasoningEffort(options?.reasoningEffort) ?? CODEX_DEFAULT_REASONING_EFFORT,
        },
      };
    },
    buildReplyOutputContract(model, options) {
      return buildMainChatReplyOutputContract({
        requestMode: this.resolveRequestMode(model),
        protocol: this.resolveStructuredOutputProtocol(model),
        overrideRequestParams: this.buildRequestOverride(model, options),
      });
    },
    normalizeModel(model) {
      return normalizeCodexCanonicalModelId(model);
    },
    transportModel(model) {
      return normalizeCodexModelId(model);
    },
    resolveRequestMode() {
      return 'responses';
    },
    resolveStructuredOutputProtocol() {
      return 'native_responses_json_schema';
    },
    describeForConsole(model, options) {
      const option = getCodexModelOption(model);
      const effort = normalizeCodexReasoningEffort(options?.reasoningEffort) ?? CODEX_DEFAULT_REASONING_EFFORT;
      return {
        description: '当前由机器人维护独立 Codex OAuth，运行时通过本地 bridge 注入 OAuth token，并固定走 Responses API + native_responses_json_schema。',
        modelHint: option
          ? `当前从 Codex 可见 API 模型列表选择，已选 ${option.label}，思考程度 ${effort}。保存为 openai/${option.modelId}，上游请求发送 ${option.modelId}。`
          : `当前从 Codex 可见 API 模型列表选择，思考程度 ${effort}；只支持 Responses API，不会回退到 chat/completions。`,
      };
    },
  },
  {
    id: 'copilot-github-oauth-main-chat',
    platform: 'openai',
    supportsModel: isCopilotModelId,
    buildRequestOverride(model) {
      const canonicalModel = this.normalizeModel(model);
      if (!canonicalModel) return null;
      const transportModel = this.transportModel(canonicalModel);
      if (!transportModel) return null;
      const requestMode = this.resolveRequestMode(canonicalModel);
      return {
        ...(requestMode === 'responses' ? { qqbot_request_mode: 'responses' } : {}),
        qqbot_canonical_model: canonicalModel,
        qqbot_transport_model: transportModel,
        qqbot_tool_profile: 'qqbot_openai_main_chat',
      };
    },
    buildReplyOutputContract(model) {
      return buildMainChatReplyOutputContract({
        requestMode: this.resolveRequestMode(model),
        protocol: this.resolveStructuredOutputProtocol(model),
        overrideRequestParams: this.buildRequestOverride(model),
      });
    },
    normalizeModel(model) {
      return normalizeCopilotCanonicalModelId(model);
    },
    transportModel(model) {
      return normalizeCopilotModelId(model);
    },
    resolveRequestMode(model) {
      return getCopilotRequestMode(model);
    },
    resolveStructuredOutputProtocol(model) {
      return getCopilotStructuredOutputProtocol(model);
    },
    describeForConsole(model) {
      const option = getCopilotModelOption(model);
      const mode = this.resolveRequestMode(model) === 'responses' ? 'Responses API' : 'chat/completions';
      return {
        description: `当前按 GitHub Copilot OAuth 设备登录接入，运行时通过本地 bridge 使用 ${option ? formatCopilotModelOptionLabel(option) : '未配置'}，由 bridge 开启 Copilot Auto session 后选择具体模型，并走 ${mode} / ${this.resolveStructuredOutputProtocol(model)}。`,
        modelHint: option
          ? `当前选择 ${formatCopilotModelOptionLabel(option)}。保存为 openai/${option.modelId}，上游请求发送 ${option.modelId}，具体模型由 Copilot Auto session 决定。`
          : '当前模型不在 Copilot Auto 入口列表中。',
      };
    },
  },
  {
    id: 'deepseek-official-main-chat',
    platform: 'deepseek',
    supportsModel: isDeepSeekModelId,
    buildRequestOverride(model) {
      if (!isDeepSeekModelId(model)) return null;
      const canonicalModel = this.normalizeModel(model);
      const transportModel = this.transportModel(canonicalModel);
      return {
        qqbot_canonical_model: canonicalModel,
        qqbot_transport_model: transportModel,
        qqbot_tool_profile: 'qqbot_openai_main_chat',
      };
    },
    buildReplyOutputContract(model) {
      return buildMainChatReplyOutputContract({
        requestMode: this.resolveRequestMode(model),
        protocol: this.resolveStructuredOutputProtocol(model),
        overrideRequestParams: this.buildRequestOverride(model),
      });
    },
    normalizeModel(model) {
      return normalizeDeepSeekCanonicalModelId(model);
    },
    transportModel(model) {
      return normalizeDeepSeekModelId(model);
    },
    resolveRequestMode() {
      return 'chat_completions';
    },
    resolveStructuredOutputProtocol() {
      return 'chat_reply_v1';
    },
    describeForConsole(model) {
      const option = getDeepSeekOfficialModelOption(model);
      return {
        description: '当前按 DeepSeek 官方 OpenAI 兼容接口接入，走 chat/completions + CHAT_REPLY_V1 纯文本结构化协议。',
        modelHint: option
          ? `当前选择 ${formatDeepSeekModelOptionLabel(option)}；DeepSeek 不使用 response_format/json_schema。`
          : '当前固定从 DeepSeek 官方模型列表选择，发给 provider 的模型 ID 保持官方原始字符串；输出走纯文本协议。',
      };
    },
  },
  {
    id: 'mimo-official-main-chat',
    platform: 'mimo',
    supportsModel: isMimoChatModelId,
    buildRequestOverride(model) {
      if (!isMimoChatModelId(model)) return null;
      const canonicalModel = this.normalizeModel(model);
      const transportModel = this.transportModel(canonicalModel);
      return {
        qqbot_canonical_model: canonicalModel,
        qqbot_transport_model: transportModel,
        qqbot_tool_profile: 'qqbot_openai_main_chat',
      };
    },
    buildReplyOutputContract(model) {
      return buildMainChatReplyOutputContract({
        requestMode: this.resolveRequestMode(model),
        protocol: this.resolveStructuredOutputProtocol(model),
        overrideRequestParams: this.buildRequestOverride(model),
      });
    },
    normalizeModel(model) {
      return normalizeMimoCanonicalModelId(model);
    },
    transportModel(model) {
      return normalizeMimoModelId(model);
    },
    resolveRequestMode() {
      return 'chat_completions';
    },
    resolveStructuredOutputProtocol() {
      return 'native_chat_json_schema';
    },
    describeForConsole(model) {
      const option = getMimoChatModelOption(model);
      return {
        description: '当前按 Xiaomi MIMO Token Plan 的 OpenAI 兼容 chat/completions 接口接入，聊天模型限定为已验证列表。',
        modelHint: option
          ? `当前选择 ${option.label}。TTS / VoiceClone / VoiceDesign 模型不会进入主聊天。`
          : '仅支持已验证可走 chat/completions 的 MIMO 模型；TTS 模型不会出现在此列表。',
      };
    },
  },
] as const;

export function getBuiltinMainChatTabDefinition(id: MainChatBuiltinTabId): BuiltinTabDefinition {
  const found = BUILTIN_MAIN_CHAT_TABS.find((item) => item.id === id);
  if (!found) {
    throw new Error(`Unknown main chat tab definition: ${id}`);
  }
  return found;
}

export function getMainChatProviderStrategy(id: MainChatProviderStrategy['id']): MainChatProviderStrategy {
  const found = MAIN_CHAT_PROVIDER_STRATEGIES.find((item) => item.id === id);
  if (!found) {
    throw new Error(`Unknown main chat provider strategy: ${id}`);
  }
  return found;
}

export function getMainChatProviderStrategyForTab(id: MainChatBuiltinTabId): MainChatProviderStrategy {
  return getMainChatProviderStrategy(getBuiltinMainChatTabDefinition(id).strategyId);
}

export function normalizeMainChatBuiltinTabId(value: unknown): MainChatBuiltinTabId {
  const normalized = String(value ?? '').trim();
  if (normalized === 'siliconflow' || normalized === 'openai' || normalized === 'codex' || normalized === 'copilot' || normalized === 'deepseek' || normalized === 'mimo') {
    return normalized;
  }
  throw new Error(`不支持这个模型 Tab：${normalized || 'unknown'}`);
}

export function resolveMainChatRuntimeProfileFromEnv(env: Record<string, string> | NodeJS.ProcessEnv): MainChatRuntimeProfile {
  const activeTab = resolveMainChatActiveTabFromEnv(env);
  return resolveMainChatRuntimeProfileFromTabConfig(
    activeTab,
    MAIN_CHAT_BUILTIN_TAB_IDS.map((id) => resolveMainChatTabStateFromEnv(id, env)),
  );
}

export function resolveMainChatActiveTabFromEnv(env: Record<string, string> | NodeJS.ProcessEnv): MainChatBuiltinTabId {
  const raw = String(env.CHATLUNA_ACTIVE_TAB ?? '').trim();
  if (raw === 'openai' || raw === 'codex' || raw === 'copilot' || raw === 'deepseek' || raw === 'mimo') return raw;
  return 'siliconflow';
}

export function resolveMainChatTabStateFromEnv(
  id: MainChatBuiltinTabId,
  env: Record<string, string> | NodeJS.ProcessEnv,
): MainChatBuiltinTabState {
  const definition = getBuiltinMainChatTabDefinition(id);
  const strategy = getMainChatProviderStrategy(definition.strategyId);
  const activeTab = resolveMainChatActiveTabFromEnv(env);
  const baseUrl =
    id === 'siliconflow'
      ? definition.defaultBaseUrl
      : (
        trimOptionalEnvValue(env[definition.envKeys.baseUrl]) ||
        (activeTab === id ? trimOptionalEnvValue(env.CHATLUNA_BASE_URL) : null) ||
        definition.defaultBaseUrl
      );
  const apiKey =
    trimOptionalEnvValue(env[definition.envKeys.apiKey]) ||
    (activeTab === id ? trimOptionalEnvValue(env.CHATLUNA_API_KEY) : null) ||
    (id === 'openai' ? WYZAI_DEFAULT_API_KEY : '');
  const defaultModel =
    trimOptionalEnvValue(env[definition.envKeys.defaultModel]) ||
    (activeTab === id ? trimOptionalEnvValue(env.CHATLUNA_DEFAULT_MODEL) : null) ||
    definition.defaultModel;
  const canonicalModel = strategy.normalizeModel(defaultModel) ?? definition.defaultModel;
  const reasoningEffort = id === 'codex'
    ? normalizeCodexReasoningEffort(definition.envKeys.reasoningEffort ? env[definition.envKeys.reasoningEffort] : null) ?? CODEX_DEFAULT_REASONING_EFFORT
    : null;
  const { description, modelHint } = strategy.describeForConsole(canonicalModel, { reasoningEffort });

  return {
    id,
    tabId: id,
    title: definition.title,
    provider: definition.provider,
    strategyId: strategy.id,
    requestMode: strategy.resolveRequestMode(canonicalModel),
    structuredOutputProtocol: strategy.resolveStructuredOutputProtocol(canonicalModel),
    authKind: id === 'copilot' ? 'oauth_device' : id === 'codex' ? 'codex_oauth' : 'manual',
    authStatus: apiKey ? 'ready' : (id === 'copilot' || id === 'codex') ? 'unauthenticated' : 'ready',
    accountLabel: null,
    authError: null,
    baseUrl,
    apiKey,
    defaultModel: canonicalModel,
    reasoningEffort,
    canonicalModel,
    transportModel: strategy.transportModel(canonicalModel) ?? canonicalModel,
    description,
    modelHint,
  };
}

export function resolveMainChatRuntimeProfileFromTabConfig(
  activeTab: MainChatBuiltinTabId,
  tabs: readonly (Pick<MainChatBuiltinTabState, 'id' | 'baseUrl' | 'apiKey' | 'defaultModel'> &
    Partial<Pick<MainChatBuiltinTabState, 'canonicalModel' | 'transportModel' | 'reasoningEffort'>>)[],
): MainChatRuntimeProfile {
  const activeConfig = tabs.find((item) => item.id === activeTab);
  if (!activeConfig) {
    throw new Error(`缺少内置模型 Tab：${activeTab}`);
  }

  const definition = getBuiltinMainChatTabDefinition(activeTab);
  const strategy = getMainChatProviderStrategy(definition.strategyId);
  const canonicalModel =
    strategy.normalizeModel(activeConfig.canonicalModel ?? activeConfig.defaultModel) ?? definition.defaultModel;
  const reasoningEffort = activeTab === 'codex'
    ? normalizeCodexReasoningEffort((activeConfig as { reasoningEffort?: unknown }).reasoningEffort) ?? CODEX_DEFAULT_REASONING_EFFORT
    : null;
  const { description, modelHint } = strategy.describeForConsole(canonicalModel, { reasoningEffort });

  return {
    tabId: activeTab,
    title: definition.title,
    provider: definition.provider,
    strategyId: strategy.id,
    requestMode: strategy.resolveRequestMode(canonicalModel),
    structuredOutputProtocol: strategy.resolveStructuredOutputProtocol(canonicalModel),
    authKind: activeTab === 'copilot' ? 'oauth_device' : activeTab === 'codex' ? 'codex_oauth' : 'manual',
    authStatus: activeConfig.apiKey.trim() ? 'ready' : (activeTab === 'copilot' || activeTab === 'codex') ? 'unauthenticated' : 'ready',
    accountLabel: null,
    authError: null,
    baseUrl: activeTab === 'siliconflow' ? definition.defaultBaseUrl : activeConfig.baseUrl.trim(),
    apiKey: activeConfig.apiKey.trim(),
    defaultModel: canonicalModel,
    reasoningEffort,
    canonicalModel,
    transportModel: strategy.transportModel(canonicalModel) ?? canonicalModel,
    description,
    modelHint,
  };
}

export function buildMainChatRuntimeEnvPatch(
  activeTab: MainChatBuiltinTabId,
  tabs: readonly (Pick<MainChatBuiltinTabState, 'id' | 'baseUrl' | 'apiKey' | 'defaultModel'> &
    Partial<Pick<MainChatBuiltinTabState, 'canonicalModel' | 'transportModel' | 'reasoningEffort'>>)[],
): Record<string, string> {
  const runtimeProfile = resolveMainChatRuntimeProfileFromTabConfig(activeTab, tabs);
  const siliconflowTab = requireMainChatTabConfig(tabs, 'siliconflow');
  const openaiTab = requireMainChatTabConfig(tabs, 'openai');
  const codexTab = requireMainChatTabConfig(tabs, 'codex');
  const copilotTab = requireMainChatTabConfig(tabs, 'copilot');
  const deepseekTab = requireMainChatTabConfig(tabs, 'deepseek');
  const mimoTab = requireMainChatTabConfig(tabs, 'mimo');

  return {
    CHATLUNA_ACTIVE_TAB: activeTab,
    CHATLUNA_PLATFORM: runtimeProfile.provider,
    CHATLUNA_BASE_URL: runtimeProfile.baseUrl,
    CHATLUNA_API_KEY: runtimeProfile.apiKey,
    CHATLUNA_DEFAULT_MODEL: runtimeProfile.canonicalModel,
    CHATLUNA_SILICONFLOW_BASE_URL: SILICONFLOW_DEFAULT_BASE_URL,
    CHATLUNA_SILICONFLOW_API_KEY: siliconflowTab.apiKey.trim(),
    CHATLUNA_SILICONFLOW_DEFAULT_MODEL: (siliconflowTab.canonicalModel ?? siliconflowTab.defaultModel).trim(),
    CHATLUNA_OPENAI_BASE_URL: openaiTab.baseUrl.trim(),
    CHATLUNA_OPENAI_API_KEY: openaiTab.apiKey.trim(),
    CHATLUNA_OPENAI_DEFAULT_MODEL: (openaiTab.canonicalModel ?? openaiTab.defaultModel).trim(),
    CHATLUNA_CODEX_BASE_URL: codexTab.baseUrl.trim(),
    CHATLUNA_CODEX_API_KEY: codexTab.apiKey.trim(),
    CHATLUNA_CODEX_DEFAULT_MODEL: (codexTab.canonicalModel ?? codexTab.defaultModel).trim(),
    CHATLUNA_CODEX_REASONING_EFFORT: normalizeCodexReasoningEffort((codexTab as { reasoningEffort?: unknown }).reasoningEffort) ?? CODEX_DEFAULT_REASONING_EFFORT,
    CHATLUNA_COPILOT_BASE_URL: copilotTab.baseUrl.trim(),
    CHATLUNA_COPILOT_API_KEY: copilotTab.apiKey.trim(),
    CHATLUNA_COPILOT_DEFAULT_MODEL: (copilotTab.canonicalModel ?? copilotTab.defaultModel).trim(),
    CHATLUNA_DEEPSEEK_BASE_URL: deepseekTab.baseUrl.trim(),
    CHATLUNA_DEEPSEEK_API_KEY: deepseekTab.apiKey.trim(),
    CHATLUNA_DEEPSEEK_DEFAULT_MODEL: (deepseekTab.canonicalModel ?? deepseekTab.defaultModel).trim(),
    CHATLUNA_MIMO_BASE_URL: mimoTab.baseUrl.trim(),
    CHATLUNA_MIMO_API_KEY: mimoTab.apiKey.trim(),
    CHATLUNA_MIMO_DEFAULT_MODEL: (mimoTab.canonicalModel ?? mimoTab.defaultModel).trim(),
  };
}

export function isSupportedMainChatModelForTab(tabId: MainChatBuiltinTabId, model?: string | null): boolean {
  const strategy = getMainChatProviderStrategyForTab(tabId);
  return strategy.supportsModel(model);
}

export function supportsStructuredReplyJsonSchema(model?: string | null): boolean {
  return MAIN_CHAT_PROVIDER_STRATEGIES.some((strategy) =>
    strategy.supportsModel(model) && strategy.resolveStructuredOutputProtocol(model) !== 'chat_reply_v1');
}

export function buildStructuredReplyModelOverride(model?: string | null): Record<string, unknown> | null {
  const strategy = resolveMainChatProviderStrategyForModel(model);
  return strategy?.buildRequestOverride(model) ?? null;
}

export function buildSiliconFlowKimiK25NonThinkingOverride(model?: string | null): Record<string, unknown> | null {
  if (!isSiliconFlowKimiK25Model(model)) return null;
  return getMainChatProviderStrategy('siliconflow-kimi-main-chat').buildRequestOverride(model);
}

export function buildReplyOutputContract(args: {
  model?: string | null;
  profile?: MainChatRuntimeProfile | null;
  canMention?: boolean;
  canVoice?: boolean;
  canMeme?: boolean;
  voiceOutputLanguage?: import('../voice/language.js').VoiceOutputLanguage;
}): MainChatReplyOutputContract {
  const strategy = args.profile
    ? getMainChatProviderStrategy(args.profile.strategyId)
    : resolveMainChatProviderStrategyForModel(args.model) ?? getMainChatProviderStrategy('siliconflow-kimi-main-chat');
  const model = strategy.normalizeModel(args.model ?? args.profile?.canonicalModel ?? args.profile?.defaultModel ?? null);
  const baseContract = strategy.buildReplyOutputContract(model, {
    reasoningEffort: args.profile?.reasoningEffort ?? null,
  });
  return createReplyOutputContract({
    requestMode: baseContract.requestMode,
    protocol: baseContract.protocol,
    overrideRequestParams: baseContract.overrideRequestParams,
    name: baseContract.name,
    canMention: args.canMention,
    canVoice: args.canVoice,
    canMeme: args.canMeme,
    voiceOutputLanguage: args.voiceOutputLanguage,
  });
}

function requireMainChatTabConfig<T extends Pick<MainChatBuiltinTabState, 'id'>>(tabs: readonly T[], id: MainChatBuiltinTabId): T {
  const found = tabs.find((item) => item.id === id);
  if (!found) {
    throw new Error(`缺少内置模型 Tab：${id}`);
  }
  return found;
}

function resolveMainChatProviderStrategyForModel(model?: string | null): MainChatProviderStrategy | null {
  const candidates = MAIN_CHAT_PROVIDER_STRATEGIES.filter((strategy) => strategy.supportsModel(model));
  return candidates.find((strategy) => strategy.id !== 'codex-chatgpt-oauth-main-chat') ?? candidates[0] ?? null;
}

function isSiliconFlowKimiK25Model(model?: string | null): boolean {
  const value = normalizeSiliconFlowKimiK25ModelId(model);
  if (!value) return false;
  return value === SILICONFLOW_DEFAULT_MODEL;
}

function normalizeSiliconFlowKimiK25ModelId(model?: string | null): string | null {
  const value = model?.trim();
  if (!value) return null;
  if (/^siliconflow\/pro\/moonshotai\/kimi-k2\.5$/iu.test(value)) return SILICONFLOW_DEFAULT_MODEL;
  if (/^pro\/moonshotai\/kimi-k2\.5$/iu.test(value)) return SILICONFLOW_DEFAULT_MODEL;
  return value;
}

function isOpenAIGpt54ModelFamily(model?: string | null): boolean {
  const value = normalizeOpenAICanonicalModelId(model);
  if (!value || !value.startsWith('openai/')) return false;
  const normalized = value.slice('openai/'.length);
  return /^gpt-5\.4(?:-(?:non|minimal|low|medium|high|xhigh)-thinking|-thinking)?$/i.test(normalized);
}

function normalizeOpenAICanonicalModelId(model?: string | null): string | null {
  const value = model?.trim();
  if (!value) return null;
  if (value.startsWith('openai/')) return value;
  if (value.startsWith('github-copilot/')) {
    const normalized = value.slice('github-copilot/'.length).trim();
    return normalized ? `openai/${normalized}` : null;
  }
  if (value.includes('/') && !value.startsWith('openai/')) return value;
  return `openai/${value}`;
}

export function normalizeCopilotModelId(model?: string | null): string | null {
  const value = model?.trim();
  if (!value) return null;
  if (value.startsWith('openai/')) {
    const normalized = value.slice('openai/'.length).trim();
    return normalized.toLowerCase() === COPILOT_AUTO_MODEL_ID ? COPILOT_AUTO_MODEL_ID : normalized || null;
  }
  if (value.startsWith('github-copilot/')) {
    const normalized = value.slice('github-copilot/'.length).trim();
    return normalized.toLowerCase() === COPILOT_AUTO_MODEL_ID ? COPILOT_AUTO_MODEL_ID : normalized || null;
  }
  if (value.toLowerCase() === COPILOT_AUTO_MODEL_ID) return COPILOT_AUTO_MODEL_ID;
  return value;
}

export function normalizeCodexModelId(model?: string | null): string | null {
  const value = model?.trim();
  if (!value) return null;
  if (value.startsWith('openai/')) {
    const normalized = value.slice('openai/'.length).trim();
    return normalized && !normalized.includes('/') ? normalized : null;
  }
  return value.includes('/') ? null : value;
}

export function normalizeCodexReasoningEffort(value: unknown): MainChatReasoningEffort | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') return normalized;
  return null;
}

function normalizeCodexCanonicalModelId(model?: string | null): string | null {
  const normalized = normalizeCodexModelId(model);
  return normalized ? `openai/${normalized}` : null;
}

function normalizeCopilotCanonicalModelId(model?: string | null): string | null {
  const normalized = normalizeCopilotModelId(model);
  if (!normalized) return null;
  if (normalized.includes('/')) return normalized;
  return `openai/${normalized}`;
}

export function normalizeDeepSeekModelId(model?: string | null): string | null {
  const value = model?.trim();
  if (!value) return null;
  if (value.startsWith('deepseek/')) {
    return value.slice('deepseek/'.length).trim() || null;
  }
  return value.includes('/') ? null : value;
}

export function normalizeMimoModelId(model?: string | null): string | null {
  const value = model?.trim();
  if (!value) return null;
  if (value.startsWith('mimo/')) {
    return value.slice('mimo/'.length).trim() || null;
  }
  return value.includes('/') ? null : value;
}

function normalizeDeepSeekCanonicalModelId(model?: string | null): string | null {
  const normalized = normalizeDeepSeekModelId(model);
  return normalized ? `deepseek/${normalized}` : null;
}

function normalizeMimoCanonicalModelId(model?: string | null): string | null {
  const normalized = normalizeMimoModelId(model);
  return normalized ? `mimo/${normalized}` : null;
}

function isDeepSeekModelId(model?: string | null): boolean {
  const rawValue = model?.trim();
  const modelId = normalizeDeepSeekModelId(model);
  if (!rawValue || !modelId) return false;
  return rawValue.startsWith('deepseek/') || getDeepSeekOfficialModelOption(modelId) != null;
}

function isMimoChatModelId(model?: string | null): boolean {
  const rawValue = model?.trim();
  const modelId = normalizeMimoModelId(model);
  if (!rawValue || !modelId) return false;
  return rawValue.startsWith('mimo/') || getMimoChatModelOption(modelId) != null;
}

function normalizeProviderTransportModel(model?: string | null): string | null {
  const value = model?.trim();
  if (!value) return null;
  if (value.startsWith('openai/')) return value.slice('openai/'.length).trim() || null;
  return value;
}

function isCopilotModelId(model?: string | null): boolean {
  return getCopilotModelOption(model) != null;
}

function isCodexModelId(model?: string | null): boolean {
  return getCodexModelOption(model) != null;
}

function getCopilotRequestMode(model?: string | null): MainChatRequestMode {
  return requireCopilotModelOption(model).requestMode;
}

function getCopilotStructuredOutputProtocol(model?: string | null): StructuredOutputProtocol {
  return requireCopilotModelOption(model).structuredOutputProtocol;
}

function requireCopilotModelOption(model?: string | null): CopilotModelOption {
  const option = getCopilotModelOption(model);
  if (!option) {
    throw new Error(`GitHub Copilot Auto 入口列表不支持：${String(model ?? '').trim() || '<empty>'}`);
  }
  return option;
}

function resolveOpenAIGpt54ReasoningEffort(model?: string | null): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  const value = model?.trim().toLowerCase() ?? '';
  if (value.endsWith('-non-thinking')) return 'none';
  if (value.endsWith('-minimal-thinking')) return 'minimal';
  if (value.endsWith('-low-thinking')) return 'low';
  if (value.endsWith('-high-thinking')) return 'high';
  if (value.endsWith('-xhigh-thinking')) return 'xhigh';
  return 'medium';
}

function trimOptionalEnvValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

export function resolveMainChatModelDescriptor(args: {
  tabId: MainChatBuiltinTabId;
  model?: string | null;
}): MainChatModelDescriptor {
  const definition = getBuiltinMainChatTabDefinition(args.tabId);
  const strategy = getMainChatProviderStrategy(definition.strategyId);
  const canonicalModel = strategy.normalizeModel(args.model ?? definition.defaultModel) ?? definition.defaultModel;
  const transportModel = strategy.transportModel(canonicalModel) ?? canonicalModel;
  return {
    tabId: args.tabId,
    provider: definition.provider,
    strategyId: definition.strategyId,
    requestMode: strategy.resolveRequestMode(canonicalModel),
    canonicalModel,
    transportModel,
  };
}

// ─── UI schema (single source of truth for the bot-console Models tab) ────────

export type ModelInputKind = 'select-static' | 'select-dynamic' | 'free-text';
export type SecondaryActionKind = 'codex-oauth' | 'copilot-oauth' | 'deepseek-refresh' | 'mimo-refresh' | null;

export interface ModelOptionSummary {
  modelId: string;
  label: string;
  deprecated?: boolean;
}

export interface BuiltinTabUiSchema {
  id: MainChatBuiltinTabId;
  baseUrlEditable: boolean;
  apiKeyEditable: boolean;
  apiKeyVisible: boolean;
  modelInputKind: ModelInputKind;
  modelOptions: readonly ModelOptionSummary[];
  /** Concrete examples shown when the user enters an invalid model. */
  allowedModelExamples: readonly string[];
  /** Human-readable description of the allowed model family for tooltips and error messages. */
  allowedModelsDescription: string;
  secondaryAction: SecondaryActionKind;
}

export const OPENAI_GPT54_REASONING_EFFORTS = ['non', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export const OPENAI_GPT54_MODEL_OPTIONS: readonly ModelOptionSummary[] = [
  { modelId: 'openai/gpt-5.4', label: 'GPT-5.4 (default thinking)' },
  { modelId: 'openai/gpt-5.4-non-thinking', label: 'GPT-5.4 (non-thinking)' },
  { modelId: 'openai/gpt-5.4-minimal-thinking', label: 'GPT-5.4 (minimal thinking)' },
  { modelId: 'openai/gpt-5.4-low-thinking', label: 'GPT-5.4 (low thinking)' },
  { modelId: 'openai/gpt-5.4-medium-thinking', label: 'GPT-5.4 (medium thinking)' },
  { modelId: 'openai/gpt-5.4-high-thinking', label: 'GPT-5.4 (high thinking)' },
  { modelId: 'openai/gpt-5.4-xhigh-thinking', label: 'GPT-5.4 (xhigh thinking)' },
  { modelId: 'openai/gpt-5.4-thinking', label: 'GPT-5.4 (thinking)' },
];

const SILICONFLOW_UI_SCHEMA: BuiltinTabUiSchema = {
  id: 'siliconflow',
  baseUrlEditable: false,
  apiKeyEditable: true,
  apiKeyVisible: true,
  modelInputKind: 'select-static',
  modelOptions: [{ modelId: SILICONFLOW_DEFAULT_MODEL, label: SILICONFLOW_DEFAULT_MODEL }],
  allowedModelExamples: [SILICONFLOW_DEFAULT_MODEL],
  allowedModelsDescription: '硅基流动 Tab 仅支持 Pro/moonshotai/Kimi-K2.5。',
  secondaryAction: null,
};

const OPENAI_UI_SCHEMA: BuiltinTabUiSchema = {
  id: 'openai',
  baseUrlEditable: true,
  apiKeyEditable: true,
  apiKeyVisible: true,
  modelInputKind: 'select-static',
  modelOptions: OPENAI_GPT54_MODEL_OPTIONS,
  allowedModelExamples: OPENAI_GPT54_MODEL_OPTIONS.map((option) => option.modelId),
  allowedModelsDescription: 'OpenAI Tab 仅支持 openai/gpt-5.4 系列（含 -non/-minimal/-low/-medium/-high/-xhigh-thinking 变体）。',
  secondaryAction: null,
};

const CODEX_UI_SCHEMA: BuiltinTabUiSchema = {
  id: 'codex',
  baseUrlEditable: false,
  apiKeyEditable: false,
  apiKeyVisible: false,
  modelInputKind: 'select-dynamic',
  modelOptions: [],
  allowedModelExamples: CODEX_MODEL_OPTIONS.map((option) => option.modelId),
  allowedModelsDescription: 'Codex Tab 只能选择当前可见且 supported_in_api=true 的模型；OAuth、bridge 地址和内部密钥由机器人后台接管。',
  secondaryAction: 'codex-oauth',
};

const COPILOT_UI_SCHEMA: BuiltinTabUiSchema = {
  id: 'copilot',
  baseUrlEditable: false,
  apiKeyEditable: false,
  apiKeyVisible: false,
  modelInputKind: 'select-dynamic',
  modelOptions: [],
  allowedModelExamples: COPILOT_MODEL_OPTIONS.map((option) => option.modelId),
  allowedModelsDescription: 'GitHub Copilot Tab 只暴露 Auto 入口。Bridge 地址 / API key 由本地 OAuth bridge 自动接管，具体模型由 Copilot Auto session 选择。',
  secondaryAction: 'copilot-oauth',
};

const DEEPSEEK_UI_SCHEMA: BuiltinTabUiSchema = {
  id: 'deepseek',
  baseUrlEditable: true,
  apiKeyEditable: true,
  apiKeyVisible: true,
  modelInputKind: 'select-dynamic',
  modelOptions: DEEPSEEK_OFFICIAL_MODEL_OPTIONS.map((option) => ({
    modelId: option.modelId,
    label: formatDeepSeekModelOptionLabel(option),
    deprecated: (option as { deprecated?: boolean }).deprecated,
  })),
  allowedModelExamples: DEEPSEEK_OFFICIAL_MODEL_OPTIONS.map((option) => option.modelId),
  allowedModelsDescription: 'DeepSeek Tab 只能选择 DeepSeek 官方 /models 列表中的模型；API key 缺失时使用静态兜底列表。',
  secondaryAction: 'deepseek-refresh',
};

const MIMO_UI_SCHEMA: BuiltinTabUiSchema = {
  id: 'mimo',
  baseUrlEditable: true,
  apiKeyEditable: true,
  apiKeyVisible: true,
  modelInputKind: 'select-dynamic',
  modelOptions: MIMO_CHAT_MODEL_OPTIONS.map((option) => ({ ...option })),
  allowedModelExamples: MIMO_CHAT_MODEL_OPTIONS.map((option) => option.modelId),
  allowedModelsDescription: 'MIMO Tab 只能选择已验证可走 chat/completions 的模型；TTS / VoiceClone / VoiceDesign 模型不允许用于主聊天。',
  secondaryAction: 'mimo-refresh',
};

export const BUILTIN_MAIN_CHAT_TAB_UI_SCHEMA: Readonly<Record<MainChatBuiltinTabId, BuiltinTabUiSchema>> = {
  siliconflow: SILICONFLOW_UI_SCHEMA,
  openai: OPENAI_UI_SCHEMA,
  codex: CODEX_UI_SCHEMA,
  copilot: COPILOT_UI_SCHEMA,
  deepseek: DEEPSEEK_UI_SCHEMA,
  mimo: MIMO_UI_SCHEMA,
};

export function getBuiltinMainChatTabUiSchema(id: MainChatBuiltinTabId): BuiltinTabUiSchema {
  return BUILTIN_MAIN_CHAT_TAB_UI_SCHEMA[id];
}

export interface MainChatModelValidationResult {
  ok: boolean;
  message?: string;
  suggestions?: readonly string[];
}

/**
 * Validate a tab's defaultModel value with provider-owned model lists.
 * Returns a structured result so callers can render the same message client-side and server-side.
 */
export function validateMainChatTabModel(
  id: MainChatBuiltinTabId,
  rawModel: string | null | undefined,
  options: {
    codexDynamicModelIds?: readonly string[];
    copilotModelIds?: readonly string[];
    deepseekDynamicModelIds?: readonly string[];
    mimoDynamicModelIds?: readonly string[];
  } = {},
): MainChatModelValidationResult {
  const definition = getBuiltinMainChatTabDefinition(id);
  const strategy = getMainChatProviderStrategy(definition.strategyId);
  const schema = getBuiltinMainChatTabUiSchema(id);
  const trimmed = String(rawModel ?? '').trim();

  if (!trimmed) {
    return {
      ok: false,
      message: `${definition.title} Tab 默认模型不能为空。${schema.allowedModelsDescription}`,
      suggestions: schema.allowedModelExamples,
    };
  }

  if (id === 'deepseek') {
    const transportModel = normalizeDeepSeekModelId(trimmed);
    const dynamicIds = (options.deepseekDynamicModelIds ?? [])
      .map((value) => normalizeDeepSeekModelId(value))
      .filter((value): value is string => Boolean(value));
    const supportedIds = new Set<string>(dynamicIds.length > 0
      ? dynamicIds
      : DEEPSEEK_OFFICIAL_MODEL_OPTIONS.map((option) => option.modelId));
    if (!transportModel || !supportedIds.has(transportModel)) {
      return {
        ok: false,
        message: `DeepSeek Tab：'${trimmed}' 不在允许的模型列表中。可选：${[...supportedIds].slice(0, 6).join(' / ')}${supportedIds.size > 6 ? ' …' : ''}`,
        suggestions: [...supportedIds],
      };
    }
    return { ok: true };
  }

  if (id === 'mimo') {
    const transportModel = normalizeMimoModelId(trimmed);
    const dynamicIds = (options.mimoDynamicModelIds ?? [])
      .map((value) => normalizeMimoModelId(value))
      .filter((value): value is string => Boolean(value));
    const supportedIds = new Set<string>(dynamicIds.length > 0
      ? dynamicIds
      : MIMO_CHAT_MODEL_OPTIONS.map((option) => option.modelId));
    if (!transportModel || !supportedIds.has(transportModel)) {
      return {
        ok: false,
        message: `MIMO Tab：'${trimmed}' 不在允许的聊天模型列表中。可选：${[...supportedIds].slice(0, 6).join(' / ')}${supportedIds.size > 6 ? ' …' : ''}`,
        suggestions: [...supportedIds],
      };
    }
    return { ok: true };
  }

  if (id === 'codex') {
    const transportModel = normalizeCodexModelId(trimmed);
    const dynamicIds = (options.codexDynamicModelIds ?? [])
      .map((value) => normalizeCodexModelId(value))
      .filter((value): value is string => Boolean(value));
    if (dynamicIds.length > 0) {
      const supportedIds = new Set<string>(dynamicIds);
      if (!transportModel || !supportedIds.has(transportModel)) {
        return {
          ok: false,
          message: `Codex Tab：'${trimmed}' 不在当前 Codex 可见 API 模型列表内。可选：${[...supportedIds].slice(0, 6).join(' / ')}${supportedIds.size > 6 ? ' …' : ''}`,
          suggestions: [...supportedIds],
        };
      }
      return { ok: true };
    }

    const fallbackIds = CODEX_MODEL_OPTIONS.map((option) => option.modelId);
    if (!transportModel || (trimmed.includes('/') && !trimmed.startsWith('openai/'))) {
      return {
        ok: false,
        message: `Codex Tab 默认模型必须是 openai/<slug> 或 <slug>。${schema.allowedModelsDescription}`,
        suggestions: fallbackIds,
      };
    }
    return { ok: true };
  }

  if (id === 'copilot') {
    const transportModel = normalizeCopilotModelId(trimmed);
    const configuredIds = (options.copilotModelIds ?? COPILOT_MODEL_OPTIONS.map((option) => option.modelId))
      .map((value) => normalizeCopilotModelId(value))
      .filter((value): value is string => Boolean(value));
    const supportedIds = new Set<string>(configuredIds);
    if (!transportModel || !supportedIds.has(transportModel)) {
      return {
        ok: false,
        message: `GitHub Copilot Tab：'${trimmed}' 不在 Copilot Auto 入口列表内。可选：${[...supportedIds].slice(0, 6).join(' / ')}${supportedIds.size > 6 ? ' …' : ''}`,
        suggestions: [...supportedIds],
      };
    }

    return { ok: true };
  }

  if (!strategy.supportsModel(trimmed)) {
    return {
      ok: false,
      message: `${definition.title} Tab：'${trimmed}' 不在允许的模型族内。${schema.allowedModelsDescription} 例如：${schema.allowedModelExamples.slice(0, 4).join(' / ')}${schema.allowedModelExamples.length > 4 ? ' …' : ''}`,
      suggestions: schema.allowedModelExamples,
    };
  }
  return { ok: true };
}

/**
 * Resolve the credentials any auxiliary feature should use when it doesn't have a dedicated provider.
 * The active main chat tab is the single source of truth.
 */
export function resolveDefaultLlmCredentials(env: Record<string, string> | NodeJS.ProcessEnv): {
  baseUrl: string;
  apiKey: string;
  model: string;
} {
  const profile = resolveMainChatRuntimeProfileFromEnv(env);
  return {
    baseUrl: profile.baseUrl.trim(),
    apiKey: profile.apiKey.trim(),
    model: profile.canonicalModel.trim(),
  };
}
