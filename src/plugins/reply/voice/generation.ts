import { randomUUID } from 'node:crypto';
import { Context, h, Logger, Schema, type Session, type Universal } from 'koishi';
import type { FeaturePolicyServiceLike } from '../../../types/feature-policy.js';
import type { ToolPolicyServiceLike } from '../../../types/tool-policy.js';
import {
  createStickerHistoryLine,
  resolveStickerSelection,
  type StickerCapabilityState,
} from '../../sticker/index.js';
import {
  buildVoiceFailureReply,
  normalizeVoiceSynthesisText,
  pickVoiceStyle,
} from './tts.js';
import {
  downloadIncomingAudio,
  extractFirstIncomingVoice,
  extractTextContentWithoutVoice,
  isVoiceInputRuntimeAvailable,
  mergeVoiceInputText,
  requireVoiceOutputLanguage,
  transcribeAudio,
  type VoiceOutputLanguage,
} from '../../shared/voice/index.js';
import {
  buildOutboundMessagePlanFromReplyPlan,
  createBotMessageDispatchers,
  createMessageMessageContent,
  createSessionMessageDispatchers,
  createQuotedMessageContent,
  createKeyedStrandRunner,
  dispatchOutboundMessagePlan,
  renderModelFacingMessageText,
  renderMessageVisibleText,
  resolveReplyActorKey,
  resolveReplyQueueKey,
  sanitizeStructuredReplyText,
  type BotMessageContent,
  type OutboundMessagePlan,
  type OutboundMessageSegment,
  type ReplyTransportPlan,
} from '../../shared/outbound/index.js';
import {
  beginPromptAssemblyTurn,
  clearPromptAssemblyTurn,
  injectPromptEnvelope,
  peekPromptFragments,
  registerPromptFragment,
  type PromptEnvelopeMessage,
} from '../../shared/prompt-context/index.js';
import {
  resolveChatLunaRoomLike,
  type QqbotChatLunaContextOptionsLike,
} from '../../shared/chatluna-conversation.js';
import { normalizeReplyChatMode } from '../../shared/reply-chat-mode.js';
import {
  StructuredReplyCompilerError,
  StructuredReplyEmptyModelOutputError,
  type ReplyCompilerOutputProtocol,
} from '../pipeline/compiler.js';
import { ReplyOrchestratorService } from '../pipeline/orchestrator.js';
import { buildReplyTurnInput, normalizeReplyRouteHint } from '../pipeline/context-builder.js';
import {
  buildReplyOutputContractAdditionalKwargs,
  buildModelReplyOutputContract,
  type MainChatReplyOutputContract,
} from '../../shared/llm/index.js';
import { normalizeGroupId } from '../../shared/group-id.js';
import {
  CanonicalModelBindingResolver,
  type ModelConfigService,
  type ResolvedModelTarget,
} from '../../model-config/index.js';
import type { NaturalTriggerConfigService } from '../../natural-trigger-config/index.js';
import {
  type ReplyRoute,
  type ResolvedAction,
  type TurnContext,
  type TurnInput,
  type TurnInputImagePart,
} from '../pipeline/types.js';
import {
  buildReplyPromptCompilerInput,
  compileReplyPromptEnvelope,
} from '../prompt/compiler.js';
import {
  ReplyRuntime,
  ReplyRunCancellationError,
  type ReplyTurnContinuationContext,
  type ReplyRunMode,
  type ReplyRuntimeRoomLike,
} from '../runtime/index.js';
import {
  migrateStructuredReplyHistoryRows,
  type StructuredReplyHistoryDatabaseLike,
} from '../history-migration.js';
import {
  isExplicitVoiceRequest,
  isExclusiveVoiceRequest,
  ModalityDirector,
  type ModalityPolicySnapshot,
} from '../modality/director.js';
import {
  ModalityPreferenceStore,
  registerModalityPreferenceTable,
  type ModalityPreferenceDatabase,
} from '../modality/preference-store.js';
import { ReplyArtifactRegistry } from '../modality/artifact-registry.js';
import {
  assertExplicitModalityInvariant,
  ExplicitModalityInvariantError,
  type ExplicitReplyModality,
} from '../modality/explicit-invariant.js';
import {
  createAgentProgressCallbacksProvider,
  type AgentEvent,
  type AgentProgressCallbacksProvider,
  type ChatCallbacksProviderLike,
} from '../progress/narrator.js';
import {
  replyFinalizerRequestRegistry,
} from '../finalizer/tool.js';
import {
  ReplyDeliveryCheckpointStore,
  registerReplyDeliveryCheckpointTable,
  type ReplyDeliveryCheckpointDatabase,
  type ReplyDeliveryCheckpointRecord,
  type ReplyDeliveryPlannedUnit,
} from '../delivery/checkpoint-store.js';
import { recoverReplyDeliveryCheckpoints } from '../delivery/recovery.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { STOP: number; CONTINUE: number };
};

const logger = new Logger('qq-voice');
const TTS_PROBE_TURN_INTERVAL = 12;
const TTS_PROBE_TIME_INTERVAL_MS = 45_000;
const TTS_PROBE_FAILURE_BACKOFF_MS = 10_000;
const TTS_PROBE_TIMEOUT_MS = 5_000;
const INITIAL_TTS_PROBE_DELAY_MS = 15_000;
const ONEBOT_CONTENT_BLOCKED_RETCODE = 1200;
const VOICE_WORD_SEGMENTER =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh', { granularity: 'word' })
    : null;
export const name = 'qq-voice';
export const inject = {
  required: ['chatluna', 'database', 'featurePolicy', 'modelConfig', 'naturalTriggerConfig', 'toolPolicy'],
} as const;
const sharedReplyTransportSendStrand = createKeyedStrandRunner();
const sharedReplyTransportCanSendRecordCache = new Map<string, boolean>();
const sharedReplyTransportTtsCapabilityStates = new Map<string, TtsCapabilityState>();

export interface Config {
  inputEnabled?: boolean;
  outputEnabled?: boolean;
  asrBaseUrl?: string;
  asrApiKey?: string;
  ttsBaseUrl?: string;
  ttsApiKey?: string;
  inputMaxSeconds?: number;
  outputMaxWords?: number;
  outputMaxSeconds?: number;
  voiceOutputLanguage?: string;
  transcribeTimeoutMs?: number;
  synthTimeoutMs?: number;
  replyInterruptCollectWindowMs?: number;
  replyInterruptMaxPendingInputs?: number;
}

export const Config: Schema<Config> = Schema.object({
  inputEnabled: Schema.boolean().description('是否启用 QQ 语音转文字。'),
  outputEnabled: Schema.boolean().description('是否启用 QQ 文本附带语音回复。'),
  asrBaseUrl: Schema.string().role('link').description('ASR HTTP 服务地址。'),
  asrApiKey: Schema.string().role('secret').description('ASR HTTP 服务鉴权 token。'),
  ttsBaseUrl: Schema.string().role('link').description('TTS HTTP 服务地址。'),
  ttsApiKey: Schema.string().role('secret').description('TTS HTTP 服务鉴权 token。'),
  inputMaxSeconds: Schema.natural().description('单条入站语音最大时长（秒）。'),
  outputMaxWords: Schema.natural().description('单个语音段最大词数。'),
  outputMaxSeconds: Schema.natural().description('单个语音段最大时长（秒）。'),
  voiceOutputLanguage: Schema.string().description('模型生成语音回复文本的目标语言：zh、ja、en 或 auto。'),
  transcribeTimeoutMs: Schema.natural().role('time').description('ASR 请求超时（毫秒）。'),
  synthTimeoutMs: Schema.natural().role('time').description('TTS 请求超时（毫秒）。'),
  replyInterruptCollectWindowMs: Schema.natural().role('time').description('回复中断聚合窗口（毫秒）。'),
  replyInterruptMaxPendingInputs: Schema.natural().description('回复中断最多暂存的新消息条数。'),
});

export interface RuntimeConfig {
  inputEnabled: boolean;
  outputEnabled: boolean;
  asrBaseUrl: string;
  asrApiKey: string;
  ttsBaseUrl: string;
  ttsApiKey: string;
  inputMaxSeconds: number;
  outputMaxWords: number;
  outputMaxSeconds: number;
  voiceOutputLanguage: VoiceOutputLanguage;
  transcribeTimeoutMs: number;
  synthTimeoutMs: number;
  replyInterruptCollectWindowMs: number;
  replyInterruptMaxPendingInputs: number;
}

interface QqVoiceState {
  transcript: string;
  durationMs: number;
  source: string;
}

type ReplyCapabilitySource = 'cached' | 'probed';

export type VoiceOutputFailureCode =
  | 'feature_disabled'
  | 'tts_not_configured'
  | 'platform_record_unsupported'
  | 'platform_capability_rpc'
  | 'tts_health_pending'
  | 'tts_health_http'
  | 'tts_health_timeout'
  | 'tts_health_transport'
  | 'tts_synthesis_http'
  | 'tts_synthesis_timeout'
  | 'tts_synthesis_transport'
  | 'tts_synthesis_invalid_audio'
  | 'voice_delivery_rpc'
  | 'voice_content_empty'
  | 'voice_content_word_limit'
  | 'voice_content_duration_limit';

export interface VoiceOutputFailure {
  code: VoiceOutputFailureCode;
  stage: 'policy' | 'configuration' | 'platform_capability' | 'health_probe' | 'synthesis' | 'content_validation' | 'delivery';
  operation: string;
  httpStatus?: number;
  providerCode?: string;
  limit?: number;
}

class VoiceOutputError extends Error {
  constructor(readonly failure: VoiceOutputFailure, message: string) {
    super(message);
    this.name = 'VoiceOutputError';
  }
}

export interface ReplyCapabilitySnapshot {
  canMultiline: true;
  canVoice: boolean;
  voiceOutputLanguage: VoiceOutputLanguage;
  source: ReplyCapabilitySource;
  refreshedAt: number;
  voiceFailure?: VoiceOutputFailure | null;
}

interface ReplyTransportState {
  capabilitySnapshot?: ReplyCapabilitySnapshot;
  runId?: string;
  suppressErrorNotice?: boolean;
  handleRequestModelError?: (
    error: unknown,
    requestState: { requestBoundaryPersisted: boolean },
  ) => Promise<string | void> | string | void;
  handleRequestBoundaryPersisted?: () => Promise<void> | void;
}

interface ReplyV2State {
  route?: ReplyRoute;
}

export type ReplySessionLike = Session & {
  stripped?: { content?: string };
  state?: Record<string, unknown> & {
    qqVoice?: QqVoiceState;
    qqReplyTransport?: ReplyTransportState;
    qqReplyV2?: ReplyV2State;
    qqSticker?: StickerCapabilityState;
  };
};
type SessionWithVoiceState = ReplySessionLike;

export type OneBotInternalLike = {
  _request?: (action: string, params?: Record<string, unknown>) => Promise<unknown>;
  canSendRecord?: () => Promise<boolean>;
  getRecord?: (file: string, format: 'wav', fullPath?: boolean) => Promise<{ file?: string }>;
  sendPrivateMsg?: (...args: unknown[]) => Promise<unknown>;
  sendGroupMsg?: (...args: unknown[]) => Promise<unknown>;
};

export type OneBotBotLike = {
  selfId?: string;
  platform?: string;
  internal?: OneBotInternalLike;
  sendMessage: (
    channelId: string,
    content: BotMessageContent,
    guildId?: string,
    options?: Universal.SendOptions,
  ) => Promise<unknown>;
};

export type ReplyInputMessageLike = {
  content?: unknown;
  additional_kwargs?: Record<string, unknown>;
};

export type ReplyOutputContractApplyOptions = {
  modelTarget: ResolvedModelTarget;
  replyMode?: 'agent' | 'automation';
  capabilitySnapshot?: Pick<NonNullable<TurnContext['capabilitySnapshot']>, 'canMention' | 'canVoice' | 'canSticker' | 'stickerIntentHints' | 'voiceOutputLanguage'> | null;
  replyOutputContract?: MainChatReplyOutputContract;
};

type MiddlewareContextLike = {
  options?: QqbotChatLunaContextOptionsLike & {
    messageId?: string;
    inputMessage?: ReplyInputMessageLike;
    responseMessage?: {
      content?: unknown;
      additional_kwargs?: Record<string, unknown>;
    } | null;
  };
};

type ReplyInputContentMeta = {
  hasImageInput: boolean;
  imageCount: number;
  hasVoiceInput: boolean;
};

type ReplySpeakerFormatMeta = {
  version: 'speaker_id_v1';
  speakerId: string;
  speakerName: string;
  isDirect: boolean;
  preformatted?: boolean;
};

interface TtsCapabilityState {
  lastKnownHealthy: boolean | null;
  lastProbeAt: number;
  lastProbeTurn: number;
  turnCounter: number;
  pendingProbe: Promise<boolean> | null;
  failureBackoffUntil: number;
  lastFailure: VoiceOutputFailure | null;
}

interface PreparedVoiceDelivery {
  segment: OutboundMessageSegment & { kind: 'voice-block' };
  text: string;
  style: 'white' | 'black';
  wav: Uint8Array;
}

interface PreparedStickerDelivery {
  segment: OutboundMessageSegment & { kind: 'sticker-block' };
  historyLine: string;
  buffer: Buffer;
  mime: string;
}

type ReplyPlanDeliveryResult =
  | { status: 'delivered'; historyText: string }
  | {
      status: 'failed_semantic';
      historyText: string;
      semanticFailure: ExplicitModalityInvariantError;
    }
  | { status: 'failed_before_send'; historyText: string }
  | { status: 'failed_after_partial_send'; historyText: string }
  | { status: 'outcome_unknown'; historyText: string }
  | { status: 'transport_unavailable'; historyText: string }
  | { status: 'interrupted'; historyText: string };

type DeliveryReceipt = string[];

class ReplyDeliveryReceiptError extends Error {
  constructor(readonly code: 'missing' | 'empty' | 'malformed') {
    super(`reply plan delivery returned an invalid receipt: ${code}`);
    this.name = 'ReplyDeliveryReceiptError';
  }
}

function requireDeliveryReceipt(receipt: unknown): DeliveryReceipt {
  if (receipt == null) {
    throw new ReplyDeliveryReceiptError('missing');
  }
  if (!Array.isArray(receipt)) {
    throw new ReplyDeliveryReceiptError('malformed');
  }
  if (receipt.length === 0) {
    throw new ReplyDeliveryReceiptError('empty');
  }

  const messageIds = receipt.map((messageId) => {
    if (typeof messageId !== 'string' || !messageId.trim()) {
      throw new ReplyDeliveryReceiptError('malformed');
    }
    return messageId.trim();
  });
  return messageIds;
}

type ChatLunaLike = {
  chat?: unknown;
  createChatModel?: (fullModelName: string) => Promise<{ value?: { invoke: (input: unknown, options?: Record<string, unknown>) => Promise<{ content?: unknown }> } | undefined }>;
  contextManager?: {
    inject: (options: {
      name: string;
      value: unknown;
      once?: boolean;
      conversationId?: string;
      stage?: string;
    }) => void;
  };
  normalizeResearchReplyHistory?: (
    room: Record<string, unknown>,
    finalVisibleText: string,
    updatedAt?: Date,
  ) => Promise<unknown>;
  registerCallbacksProvider?: (provider: ChatCallbacksProviderLike) => () => void;
  registerAgentEventProvider?: (provider: (input: {
    session: Session;
    conversation: { id?: unknown };
    requestId: string;
    event: AgentEvent;
  }) => Promise<void> | void) => () => void;
  chatChain?: {
    middleware: (name: string, middleware: (session: unknown, context: unknown) => Promise<number>) => {
      after: (name: string) => { before: (name: string) => unknown };
      before: (name: string) => unknown;
    };
    receiveMessage?: (session: unknown, ctx?: unknown) => Promise<unknown>;
  };
};

type ChatLunaChainLike = NonNullable<ChatLunaLike['chatChain']>;
type ChatLunaChainBuilderLike = ReturnType<ChatLunaChainLike['middleware']>;

type ReplyVoiceServicesLike = {
  chatluna?: ChatLunaLike;
  featurePolicy?: FeaturePolicyServiceLike;
  modelConfig?: ModelConfigService;
  naturalTriggerConfig?: NaturalTriggerConfigService;
  toolPolicy?: ToolPolicyServiceLike;
  database: StructuredReplyHistoryDatabaseLike;
};
type RuntimeRole = 'local' | 'server' | 'unknown';

function normalizeBaseUrl(input?: string | null): string {
  return String(input ?? '').trim().replace(/\/+$/, '');
}

function requireConfigValue<T>(config: Config, key: keyof Config): NonNullable<T> {
  const value = config[key] as T | null | undefined;
  if (value == null) {
    throw new Error(`QQ 语音配置缺失：${String(key)}。默认值必须由 koishi.yml 显式传入。`);
  }
  return value as NonNullable<T>;
}

function requireBooleanConfig(config: Config, key: keyof Config): boolean {
  const value = requireConfigValue<unknown>(config, key);
  if (typeof value !== 'boolean') {
    throw new Error(`QQ 语音配置 ${String(key)} 必须是 boolean。`);
  }
  return value;
}

function requireStringConfig(config: Config, key: keyof Config): string {
  return String(requireConfigValue<unknown>(config, key)).trim();
}

function requireNaturalConfig(config: Config, key: keyof Config): number {
  const value = Number(requireConfigValue<unknown>(config, key));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`QQ 语音配置 ${String(key)} 必须是正整数。`);
  }
  return Math.floor(value);
}

function requireEnvValue(env: NodeJS.ProcessEnv, key: string): string {
  if (!(key in env)) {
    throw new Error(`${key} 未配置。默认值必须由 env/koishi.yml 显式提供。`);
  }
  return String(env[key] ?? '');
}

function requireBooleanEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = requireEnvValue(env, key).trim().toLowerCase();
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(`${key} 必须是 true 或 false。`);
  }
  return raw === 'true';
}

function detectRuntimeRole(): RuntimeRole {
  const candidates = [
    process.env.QQBOT_ENV_BASE_FILE,
    process.env.QQBOT_ENV_FILE,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  if (candidates.some((value) => value.endsWith('.env.server'))) {
    return 'server';
  }

  if (candidates.some((value) => value.endsWith('.env.local'))) {
    return 'local';
  }

  return 'unknown';
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.trim().toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return /:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(url);
  }
}

function toRuntimeConfig(config: Config): RuntimeConfig {
  return {
    inputEnabled: requireBooleanConfig(config, 'inputEnabled'),
    outputEnabled: requireBooleanConfig(config, 'outputEnabled'),
    asrBaseUrl: normalizeBaseUrl(requireStringConfig(config, 'asrBaseUrl')),
    asrApiKey: requireStringConfig(config, 'asrApiKey'),
    ttsBaseUrl: normalizeBaseUrl(requireStringConfig(config, 'ttsBaseUrl')),
    ttsApiKey: requireStringConfig(config, 'ttsApiKey'),
    inputMaxSeconds: requireNaturalConfig(config, 'inputMaxSeconds'),
    outputMaxWords: requireNaturalConfig(config, 'outputMaxWords'),
    outputMaxSeconds: requireNaturalConfig(config, 'outputMaxSeconds'),
    voiceOutputLanguage: requireVoiceOutputLanguage(requireStringConfig(config, 'voiceOutputLanguage')),
    transcribeTimeoutMs: requireNaturalConfig(config, 'transcribeTimeoutMs'),
    synthTimeoutMs: requireNaturalConfig(config, 'synthTimeoutMs'),
    replyInterruptCollectWindowMs: requireNaturalConfig(config, 'replyInterruptCollectWindowMs'),
    replyInterruptMaxPendingInputs: requireNaturalConfig(config, 'replyInterruptMaxPendingInputs'),
  };
}

export function createVoiceRuntimeConfig(config: Config): RuntimeConfig {
  return toRuntimeConfig(config);
}

export function createVoiceRuntimeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return createVoiceRuntimeConfig({
    inputEnabled: requireBooleanEnv(env, 'QQ_VOICE_INPUT_ENABLED'),
    outputEnabled: requireBooleanEnv(env, 'QQ_VOICE_OUTPUT_ENABLED'),
    asrBaseUrl: requireEnvValue(env, 'QQ_VOICE_ASR_BASE_URL'),
    asrApiKey: requireEnvValue(env, 'QQ_VOICE_ASR_API_KEY'),
    ttsBaseUrl: requireEnvValue(env, 'QQ_VOICE_TTS_BASE_URL'),
    ttsApiKey: requireEnvValue(env, 'QQ_VOICE_TTS_API_KEY'),
    inputMaxSeconds: Number(requireEnvValue(env, 'QQ_VOICE_INPUT_MAX_SECONDS')),
    outputMaxWords: Number(requireEnvValue(env, 'QQ_VOICE_OUTPUT_MAX_WORDS')),
    outputMaxSeconds: Number(requireEnvValue(env, 'QQ_VOICE_OUTPUT_MAX_SECONDS')),
    voiceOutputLanguage: requireEnvValue(env, 'QQ_VOICE_OUTPUT_LANGUAGE'),
    transcribeTimeoutMs: Number(requireEnvValue(env, 'QQ_VOICE_TRANSCRIBE_TIMEOUT_MS')),
    synthTimeoutMs: Number(requireEnvValue(env, 'QQ_VOICE_SYNTH_TIMEOUT_MS')),
    replyInterruptCollectWindowMs: Number(requireEnvValue(env, 'QQBOT_REPLY_COLLECT_WINDOW_MS')),
    replyInterruptMaxPendingInputs: Number(requireEnvValue(env, 'QQBOT_REPLY_MAX_PENDING_INPUTS')),
  });
}

function assertVoiceRuntimeConfig(runtime: RuntimeConfig): void {
  const runtimeRole = detectRuntimeRole();

  if (runtimeRole === 'server' && runtime.inputEnabled) {
    throw new Error('server runtime does not support QQ voice input; keep QQ_VOICE_INPUT_ENABLED=false.');
  }

  if (runtime.inputEnabled && !runtime.asrBaseUrl) {
    throw new Error('QQ voice input is enabled but QQ_VOICE_ASR_BASE_URL is empty.');
  }

  if (!runtime.outputEnabled) {
    return;
  }

  if (!runtime.ttsBaseUrl) {
    throw new Error('QQ voice output is enabled but QQ_VOICE_TTS_BASE_URL is empty.');
  }

  if (!runtime.ttsApiKey.trim()) {
    throw new Error('QQ voice output is enabled but QQ_VOICE_TTS_API_KEY is empty.');
  }

  if (runtimeRole === 'server' && isLoopbackUrl(runtime.ttsBaseUrl)) {
    throw new Error('server QQ voice output must point to a laptop Tailnet TTS endpoint, not a loopback address.');
  }
}

function createAuthHeaders(apiKey: string): Record<string, string> {
  const token = apiKey.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function readProviderCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : null;
  const candidate = record.code ?? record.error_code ?? nested?.code ?? nested?.error_code;
  if (typeof candidate !== 'string' && typeof candidate !== 'number') return undefined;
  const normalized = String(candidate).trim();
  return normalized ? normalized.slice(0, 80) : undefined;
}

async function readHttpProviderCode(response: Response): Promise<string | undefined> {
  const body = (await response.text()).slice(0, 8_192).trim();
  if (!body) return undefined;
  try {
    return readProviderCode(JSON.parse(body));
  } catch {
    return undefined;
  }
}

export async function synthesizeVoice(
  runtime: RuntimeConfig,
  text: string,
  style: 'white' | 'black',
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!runtime.ttsBaseUrl) {
    throw new VoiceOutputError({
      code: 'tts_not_configured',
      stage: 'configuration',
      operation: 'tts.synthesize',
    }, 'TTS synthesis is not configured.');
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, runtime.synthTimeoutMs);

  try {
    const response = await fetch(`${runtime.ttsBaseUrl}/synthesize`, {
      method: 'POST',
      headers: {
        ...createAuthHeaders(runtime.ttsApiKey),
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

    if (!response.ok) {
      const providerCode = await readHttpProviderCode(response);
      throw new VoiceOutputError({
        code: 'tts_synthesis_http',
        stage: 'synthesis',
        operation: 'tts.synthesize',
        httpStatus: response.status,
        ...(providerCode ? { providerCode } : {}),
      }, `TTS synthesis failed with HTTP ${response.status}${providerCode ? ` (${providerCode})` : ''}.`);
    }

    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof VoiceOutputError) throw error;
    if (timedOut) {
      throw new VoiceOutputError({
        code: 'tts_synthesis_timeout',
        stage: 'synthesis',
        operation: 'tts.synthesize',
      }, `TTS synthesis timed out after ${runtime.synthTimeoutMs} ms.`);
    }
    throw new VoiceOutputError({
      code: 'tts_synthesis_transport',
      stage: 'synthesis',
      operation: 'tts.synthesize',
    }, `TTS synthesis transport failed: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function createAudioDataUri(bytes: Uint8Array): string {
  return `data:audio/wav;base64,${Buffer.from(bytes).toString('base64')}`;
}

function countVoiceWords(text: string): number {
  const normalized = normalizeVoiceSynthesisText(text);
  if (!normalized) return 0;

  if (VOICE_WORD_SEGMENTER) {
    let count = 0;
    for (const segment of VOICE_WORD_SEGMENTER.segment(normalized)) {
      if (segment.isWordLike) count += 1;
    }
    if (count > 0) return count;
  }

  return normalized.split(/\s+/).filter(Boolean).length;
}

function estimateWavDurationMs(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 44) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readChunkId = (offset: number): string => Buffer.from(bytes.subarray(offset, offset + 4)).toString('ascii');

  if (readChunkId(0) !== 'RIFF' || readChunkId(8) !== 'WAVE') {
    return null;
  }

  const byteRate = view.getUint32(28, true);
  if (!byteRate) return null;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readChunkId(offset);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 'data') {
      return Math.round((chunkSize / byteRate) * 1000);
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  return null;
}

function getTextInputContent(session: SessionWithVoiceState): string {
  const stripped = session.stripped?.content?.trim();
  if (stripped) return stripped;
  return extractTextContentWithoutVoice(session.content ?? '');
}

type IncomingElementLike = {
  type?: string;
  attrs?: Record<string, unknown>;
};

function getIncomingElements(session: SessionWithVoiceState): IncomingElementLike[] {
  if (Array.isArray(session.elements)) {
    return session.elements as IncomingElementLike[];
  }
  return h.parse(session.content ?? '') as IncomingElementLike[];
}

function resolveIncomingGroupId(session: SessionWithVoiceState): string | null {
  return normalizeGroupId(session.guildId) ?? normalizeGroupId(session.channelId);
}

function isIncomingGroupVoiceExplicitlyAddressed(session: SessionWithVoiceState): boolean {
  const botSelfId = session.bot?.selfId?.trim();
  if (!botSelfId) return false;

  const stripped = session.stripped as { atSelf?: unknown } | undefined;
  if (stripped?.atSelf === true) return true;

  const quote = session.quote as { user?: { id?: unknown } } | undefined;
  if (String(quote?.user?.id ?? '').trim() === botSelfId) return true;

  return getIncomingElements(session).some((element) => {
    const type = typeof element?.type === 'string' ? element.type.toLowerCase() : '';
    if (type !== 'at') return false;
    return String(element.attrs?.id ?? '').trim() === botSelfId;
  });
}

async function shouldHandleIncomingVoiceInput(args: {
  runtime: RuntimeConfig;
  naturalTriggerConfig: NaturalTriggerConfigService;
  session: SessionWithVoiceState;
  voiceFeatureState: { inputEnabled: boolean };
}): Promise<boolean> {
  const { runtime, naturalTriggerConfig, session, voiceFeatureState } = args;
  if (!voiceFeatureState.inputEnabled || !isVoiceInputRuntimeAvailable(runtime)) return false;
  if (session.isDirect) return true;
  if (isIncomingGroupVoiceExplicitlyAddressed(session)) return true;

  const naturalTrigger = naturalTriggerConfig.getRuntimeSnapshot();
  if (!naturalTrigger.config.enabled || !naturalTrigger.config.voiceAdmission.enabled) return false;
  const groupId = resolveIncomingGroupId(session);
  return Boolean(groupId && naturalTrigger.allowedGroupIds.has(groupId));
}

function updateVoiceState(session: SessionWithVoiceState, state: QqVoiceState): void {
  const current = session.state ?? {};
  current.qqVoice = state;
  session.state = current;
}

function isOneBotContentBlockedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const code = Number((error as { code?: unknown }).code);
  if (Number.isFinite(code) && code === ONEBOT_CONTENT_BLOCKED_RETCODE) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /\bretcode:\s*1200\b/.test(message);
}

function isOneBotRpcTransportUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b_request is not a function\b/i.test(message);
}

function readOneBotActionRetcode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const record = error as Record<string, unknown>;
  const message = error instanceof Error ? error.message : String(error);
  const messageRetcode = /\bretcode:\s*(-?\d+)\b/i.exec(message)?.[1];
  const candidate = record.retcode ?? messageRetcode ?? (
    typeof record.code === 'number' ? record.code : undefined
  );
  const retcode = typeof candidate === 'number' ? candidate : Number(candidate);
  return Number.isSafeInteger(retcode) ? retcode : null;
}

function isAuthoritativeOneBotActionRejection(error: unknown): boolean {
  const retcode = readOneBotActionRetcode(error);
  return retcode != null && retcode !== 0;
}

function extractOneBotFailureDetails(error: unknown): Pick<VoiceOutputFailure, 'httpStatus' | 'providerCode'> {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : String(error);
  const messageRetcode = /\bretcode:\s*(-?\d+)\b/i.exec(message)?.[1];
  const rawProviderCode = record.retcode ?? record.code ?? messageRetcode;
  const rawHttpStatus = record.httpStatus ?? record.status;
  const providerCode = (
    (typeof rawProviderCode === 'string' && rawProviderCode.trim())
    || (typeof rawProviderCode === 'number' && Number.isFinite(rawProviderCode) ? String(rawProviderCode) : '')
  );
  const httpStatus = typeof rawHttpStatus === 'number' && Number.isFinite(rawHttpStatus)
    ? rawHttpStatus
    : undefined;
  return {
    ...(providerCode ? { providerCode } : {}),
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

function buildContentBlockedFallbackText(session: SessionWithVoiceState): string {
  const fallback = session.isDirect
    ? '这个话题我不方便展开，换个别的吧。'
    : '这个话题我不方便在群里展开，换个别的吧。';
  return sanitizeStructuredReplyText(fallback, 'message');
}

async function sendFailureReply(session: SessionWithVoiceState, message: string): Promise<DeliveryReceipt> {
  if (!session.channelId) {
    const { sendWhole } = createSessionMessageDispatchers(session);
    return requireDeliveryReceipt(await sendWhole(message));
  }

  const { sendWhole } = createBotMessageDispatchers(
    session.bot as OneBotBotLike,
    session.channelId,
    session,
  );
  return requireDeliveryReceipt(await sendWhole(message));
}

async function sendCheckpointedVisibleReply(args: {
  session: SessionWithVoiceState;
  replyRuntime: ReplyRuntime;
  runId: string;
  deliveryCheckpointStore: ReplyDeliveryCheckpointStore;
  deliveryCheckpoint: ReplyDeliveryCheckpointRecord;
  message: string;
}): Promise<void> {
  const [unit] = await args.deliveryCheckpointStore.appendPlannedUnits(
    args.deliveryCheckpoint,
    [{
      index: 0,
      kind: 'text-line',
      payload: { content: args.message },
      historyText: args.message,
      persistToHistory: true,
    }],
  );
  await args.deliveryCheckpointStore.beginUnit(args.deliveryCheckpoint, unit.index);
  try {
    const receipt = await sendFailureReply(args.session, args.message);
    await args.deliveryCheckpointStore.confirmUnit(args.deliveryCheckpoint, unit, receipt);
  } catch (error) {
    await args.deliveryCheckpointStore.markOutcomeUnknown(args.deliveryCheckpoint, error);
    throw error;
  }
  args.replyRuntime.recordCommittedUnit(args.runId, args.message);
}

async function closeVisibleProgress(args: {
  session: SessionWithVoiceState;
  replyRuntime: ReplyRuntime;
  runId: string;
  deliveryCheckpointStore: ReplyDeliveryCheckpointStore;
  deliveryCheckpoint: ReplyDeliveryCheckpointRecord;
  message: string;
  normalizeHistory: (visibleText: string) => Promise<void>;
}): Promise<boolean> {
  const progress = args.replyRuntime.getProgressState(args.runId);
  if (!progress?.visibleLines.length) return false;

  const message = sanitizeStructuredReplyText(args.message, 'message');
  await sendCheckpointedVisibleReply({ ...args, message });
  await args.normalizeHistory(message);
  return true;
}

function formatExplicitModalityInvariantNotice(args: {
  failure: ExplicitModalityInvariantError;
  capability: ReplyCapabilitySnapshot;
  stickerState: StickerCapabilityState | null;
}): string {
  const { missingModalities } = args.failure;
  if (missingModalities.length === 1 && missingModalities[0] === 'voice' && !args.capability.canVoice) {
    return formatVoiceOutputFailure(args.capability.voiceFailure ?? {
      code: 'tts_health_pending',
      stage: 'health_probe',
      operation: 'tts.healthz',
    });
  }
  if (missingModalities.length === 1 && missingModalities[0] === 'sticker' && !args.stickerState?.catalog) {
    return '这次没找到合适的表情，我先不乱发。';
  }
  if (missingModalities.length === 2) {
    return '我刚才漏了你要的语音和表情包。你再叫我一次，我重新发。';
  }
  return missingModalities[0] === 'voice'
    ? '我刚才漏了语音。你再叫我一次，我重新发。'
    : '我刚才漏了你要的表情包。你再叫我一次，我重新发。';
}

async function closeExplicitModalityInvariantFailure(args: {
  session: SessionWithVoiceState;
  replyRuntime: ReplyRuntime;
  runId: string;
  deliveryCheckpointStore: ReplyDeliveryCheckpointStore;
  deliveryCheckpoint: ReplyDeliveryCheckpointRecord;
  failure: ExplicitModalityInvariantError;
  capability: ReplyCapabilitySnapshot;
  stickerState: StickerCapabilityState | null;
  normalizeHistory: (visibleText: string) => Promise<void>;
}): Promise<void> {
  const message = sanitizeStructuredReplyText(
    formatExplicitModalityInvariantNotice(args),
    'message',
  );
  const closedProgress = await closeVisibleProgress({
    session: args.session,
    replyRuntime: args.replyRuntime,
    runId: args.runId,
    deliveryCheckpointStore: args.deliveryCheckpointStore,
    deliveryCheckpoint: args.deliveryCheckpoint,
    message,
    normalizeHistory: args.normalizeHistory,
  });
  if (closedProgress) return;

  await sendCheckpointedVisibleReply({ ...args, message });
  await args.normalizeHistory(message);
}

function downgradeVoiceSegmentsToText(plan: ReplyTransportPlan): ReplyTransportPlan {
  return {
    segments: plan.segments.map((segment) =>
      segment.kind === 'voice'
        ? {
            kind: 'message',
            parts: [{ kind: 'text', content: segment.content }],
          }
        : segment,
    ),
  };
}

function formatVoiceOutputFailure(failure: VoiceOutputFailure): string {
  const providerCode = failure.providerCode ? `，error_code=${failure.providerCode}` : '';
  const oneBotCode = failure.providerCode ? `，retcode=${failure.providerCode}` : '';
  switch (failure.code) {
    case 'feature_disabled':
      return '我这会儿发不了语音，语音输出还没有启用。';
    case 'tts_not_configured':
      return `我这会儿发不了语音，语音合成还没有配置好（${failure.operation}）。`;
    case 'platform_record_unsupported':
      return 'QQ 这边现在不让我发语音（onebot.can_send_record=false）。';
    case 'platform_capability_rpc':
      return `我刚才没问到 QQ 能不能发语音（${failure.operation}${oneBotCode}）。`;
    case 'tts_health_pending':
      return '语音服务还没准备好，过一会儿再叫我试试。';
    case 'tts_health_http':
      return `语音服务的健康检查出错了（${failure.operation}，HTTP ${failure.httpStatus ?? 'unknown'}${providerCode}）。`;
    case 'tts_health_timeout':
      return `语音服务一直没回应，健康检查超时了（${failure.operation}）。`;
    case 'tts_health_transport':
      return `我刚才没连上语音服务（${failure.operation}）。`;
    case 'tts_synthesis_http':
      return `刚才的语音没合成出来（${failure.operation}，HTTP ${failure.httpStatus ?? 'unknown'}${providerCode}）。`;
    case 'tts_synthesis_timeout':
      return `语音服务一直没回应，合成请求超时了（${failure.operation}）。`;
    case 'tts_synthesis_transport':
      return `我刚才没连上语音合成服务（${failure.operation}）。`;
    case 'tts_synthesis_invalid_audio':
      return `语音服务刚才返回的音频有问题（${failure.operation}）。`;
    case 'voice_delivery_rpc':
      return `语音发出去时被 QQ 拒绝了（${failure.operation}${oneBotCode}）。`;
    case 'voice_content_empty':
      return '这段话没有可以朗读的内容，所以没法发成语音。';
    case 'voice_content_word_limit':
      return `这段话太长了，超过单段 ${failure.limit ?? 'unknown'} 词的语音限制。`;
    case 'voice_content_duration_limit':
      return `这段语音太长了，超过单段 ${failure.limit ?? 'unknown'} 秒的限制。`;
  }
}

function replaceRequestedVoiceWithFailure(
  plan: ReplyTransportPlan,
  failure: VoiceOutputFailure,
  preserveExistingWhenVoiceAbsent = false,
): ReplyTransportPlan {
  let inserted = false;
  const failureSegment = {
    kind: 'message' as const,
    parts: [{ kind: 'text' as const, content: formatVoiceOutputFailure(failure) }],
  };
  if (!plan.segments.some((segment) => segment.kind === 'voice')) {
    return {
      segments: preserveExistingWhenVoiceAbsent && plan.segments.length > 0
        ? [...plan.segments, failureSegment]
        : [failureSegment],
    };
  }
  return {
    segments: plan.segments.flatMap((segment) => {
      if (segment.kind !== 'voice') return [segment];
      if (inserted) return [];
      inserted = true;
      return [failureSegment];
    }),
  };
}

function removeStickerSegments(plan: ReplyTransportPlan): ReplyTransportPlan {
  return {
    segments: plan.segments.filter((segment) => segment.kind !== 'sticker'),
  };
}

function replaceStickerSegmentsWithFailure(plan: ReplyTransportPlan): ReplyTransportPlan {
  let inserted = false;
  const failureSegment = {
    kind: 'message' as const,
    parts: [{ kind: 'text' as const, content: '这次没找到合适的表情，我先不乱发。' }],
  };
  return {
    segments: plan.segments.flatMap((segment) => {
      if (segment.kind !== 'sticker') return [segment];
      if (inserted) return [];
      inserted = true;
      return [failureSegment];
    }),
  };
}

export function buildReplyTransportPlanFromResolvedActions(actions: ResolvedAction[]): ReplyTransportPlan {
  const segments: ReplyTransportPlan['segments'] = [];

  for (const action of actions) {
    if (action.kind === 'no_reply') {
      continue;
    }
    if (action.kind === 'message') {
      segments.push({
        kind: 'message' as const,
        parts: action.parts,
      });
      continue;
    }
    if (action.kind === 'structured_block') {
      segments.push({
        kind: 'structured_block' as const,
        content: action.content,
      });
      continue;
    }
    if (action.kind === 'voice') {
      segments.push({
        kind: 'voice' as const,
        content: action.content,
      });
      continue;
    }
    if (action.kind === 'sticker') {
      segments.push({
        kind: 'sticker' as const,
        content: action.intent,
      });
      continue;
    }
    if (action.kind === 'image') {
      segments.push({
        kind: 'image' as const,
        assetRef: action.assetRef,
        alt: action.alt,
      });
      continue;
    }
  }

  return { segments };
}

function renderDeliveredReplyPlanHistoryText(
  plan: ReplyTransportPlan,
  preparedStickerByRaw: Map<string, PreparedStickerDelivery> = new Map(),
): string {
  const outboundPlan = buildOutboundMessagePlanFromReplyPlan(plan);
  const stickerHistoryByRaw = new Map(
    [...preparedStickerByRaw.entries()].map(([raw, prepared]) => [raw, prepared.historyLine] as const),
  );
  const stickerSegments = outboundPlan.segments.filter(
    (segment): segment is OutboundMessageSegment & { kind: 'sticker-block' } => segment.kind === 'sticker-block',
  );
  let stickerIndex = 0;

  return plan.segments
    .map((segment) => {
      if (segment.kind === 'image') {
        return segment.alt ? `（发送图片：${segment.alt}）` : '（发送图片）';
      }

      if (segment.kind === 'voice') {
        return `（发送语音：${sanitizeStructuredReplyText(segment.content, 'voice')}）`;
      }

      if (segment.kind === 'message') {
        return renderModelFacingMessageText(segment);
      }

      if (segment.kind === 'sticker') {
        const outboundSticker = stickerSegments[stickerIndex];
        stickerIndex += 1;
        return outboundSticker ? stickerHistoryByRaw.get(outboundSticker.raw) ?? '（发送表情包）' : '（发送表情包）';
      }

      return sanitizeStructuredReplyText(segment.content, 'structured_block');
    })
    .filter((segment) => segment.trim().length > 0)
    .join('\n')
    .trim();
}

function buildPlannedUnitHistoryLines(args: {
  outboundPlan: OutboundMessagePlan;
  preparedVoiceByRaw: Map<string, PreparedVoiceDelivery>;
  preparedStickerByRaw: Map<string, PreparedStickerDelivery>;
}): string[] {
  const { outboundPlan, preparedVoiceByRaw, preparedStickerByRaw } = args;
  return outboundPlan.segments.map((segment) => {
    if (segment.kind === 'text-line') {
      return segment.content;
    }
    if (segment.kind === 'message-block') {
      return renderModelFacingMessageText(segment);
    }
    if (segment.kind === 'structured-block') {
      return sanitizeStructuredReplyText(segment.content, 'structured_block');
    }
    if (segment.kind === 'image-block') {
      return segment.alt ? `（发送图片：${segment.alt}）` : '（发送图片）';
    }
    if (segment.kind === 'sticker-block') {
      return preparedStickerByRaw.get(segment.raw)?.historyLine ?? '（发送表情包）';
    }
    return `（发送语音：${preparedVoiceByRaw.get(segment.raw)?.text ?? segment.content}）`;
  });
}

function buildPlannedDeliveryUnits(args: {
  outboundPlan: OutboundMessagePlan;
  historyLines: readonly string[];
  preparedVoiceByRaw: Map<string, PreparedVoiceDelivery>;
  preparedStickerByRaw: Map<string, PreparedStickerDelivery>;
}): ReplyDeliveryPlannedUnit[] {
  return args.outboundPlan.segments.map((segment, index) => {
    const historyText = args.historyLines[index]?.trim() ?? '';
    if (!historyText) {
      throw new Error(`reply delivery unit ${index} has no visible history text.`);
    }
    let payload: Record<string, unknown>;
    if (segment.kind === 'text-line' || segment.kind === 'structured-block') {
      payload = { content: segment.content };
    } else if (segment.kind === 'message-block') {
      payload = { content: renderModelFacingMessageText(segment) };
    } else if (segment.kind === 'image-block') {
      payload = { assetRef: segment.assetRef, alt: segment.alt };
    } else if (segment.kind === 'sticker-block') {
      payload = {
        selection: args.preparedStickerByRaw.get(segment.raw)?.historyLine ?? historyText,
      };
    } else {
      payload = {
        content: args.preparedVoiceByRaw.get(segment.raw)?.text ?? segment.content,
      };
    }
    return {
      index,
      kind: segment.kind,
      payload,
      historyText,
      persistToHistory: true,
    };
  });
}

function buildOptimisticPlannedUnitHistoryLines(plan: ReplyTransportPlan): string[] {
  return buildPlannedUnitHistoryLines({
    outboundPlan: buildOutboundMessagePlanFromReplyPlan(plan),
    preparedVoiceByRaw: new Map(),
    preparedStickerByRaw: new Map(),
  });
}

async function normalizeResearchReplyHistory(
  ctx: Context,
  room: Record<string, unknown> | undefined,
  requestId: string,
  visibleHistoryText: string,
  requestDisposition: 'retain_request' | 'drop_request' = 'retain_request',
  allowMissingBoundary = false,
): Promise<void> {
  const chatluna = (ctx.get?.('chatluna') ?? (ctx as { chatluna?: any }).chatluna) as ChatLunaLike | undefined;
  const conversationId = typeof room?.conversationId === 'string' ? room.conversationId.trim() : '';
  const normalizeHistory = requireReplyHistoryNormalizer(chatluna);
  if (!conversationId) {
    throw new Error('reply runtime history normalization requires room.conversationId.');
  }
  const result = await normalizeHistory(
    { ...room!, requestId, requestDisposition },
    visibleHistoryText.trim(),
  );
  const requestBoundaryFound = (
    result != null &&
    typeof result === 'object' &&
    'requestBoundaryFound' in result
  ) ? (result as { requestBoundaryFound?: unknown }).requestBoundaryFound : undefined;
  if (requestBoundaryFound === true) return;
  if (allowMissingBoundary && requestBoundaryFound === false) return;
  throw new Error(
    `reply runtime history normalization did not find request boundary for ${requestId}.`,
  );
}

function requireReplyHistoryNormalizer(
  chatluna: { normalizeResearchReplyHistory?: (room: Record<string, unknown>, visibleHistoryText: string) => Promise<unknown> } | undefined,
): (room: Record<string, unknown>, visibleHistoryText: string) => Promise<unknown> {
  if (typeof chatluna?.normalizeResearchReplyHistory !== 'function') {
    throw new Error('reply runtime requires chatluna.normalizeResearchReplyHistory.');
  }
  return chatluna.normalizeResearchReplyHistory.bind(chatluna);
}

function buildTextOnlyAssistantHistoryText(
  text: string,
  _outputProtocol: ReplyCompilerOutputProtocol | undefined,
): string {
  return text.trim();
}

export async function ensureCanSendRecord(
  bot: OneBotBotLike,
  capabilityCache: Map<string, boolean>,
  force = false,
): Promise<boolean> {
  const cacheKey = `${bot.platform ?? 'onebot'}:${bot.selfId ?? 'default'}`;
  if (!force && capabilityCache.get(cacheKey) === true) {
    return true;
  }

  if (typeof bot.internal?._request !== 'function') {
    capabilityCache.delete(cacheKey);
    throw new VoiceOutputError({
      code: 'platform_capability_rpc',
      stage: 'platform_capability',
      operation: 'onebot.can_send_record',
    }, 'onebot can_send_record transport is unavailable: _request is not a function.');
  }

  let result = false;
  try {
    result = (await bot.internal?.canSendRecord?.()) ?? false;
  } catch (error) {
    if (/_request is not a function/i.test((error as Error).message)) {
      capabilityCache.delete(cacheKey);
      throw new VoiceOutputError({
        code: 'platform_capability_rpc',
        stage: 'platform_capability',
        operation: 'onebot.can_send_record',
      }, `onebot can_send_record transport is unavailable: ${(error as Error).message}`);
    }

    capabilityCache.delete(cacheKey);
    const details = extractOneBotFailureDetails(error);
    throw new VoiceOutputError({
      code: 'platform_capability_rpc',
      stage: 'platform_capability',
      operation: 'onebot.can_send_record',
      ...details,
    }, `onebot can_send_record failed: ${(error as Error).message}`);
  }

  if (result) capabilityCache.set(cacheKey, true);
  else capabilityCache.delete(cacheKey);
  return result;
}

export function isVoiceOutputConfigured(runtime: RuntimeConfig): boolean {
  return Boolean(runtime.ttsBaseUrl);
}

function getReplyTransportState(session: SessionWithVoiceState): ReplyTransportState {
  const current = session.state ?? {};
  const transportState = current.qqReplyTransport ?? {};
  current.qqReplyTransport = transportState;
  session.state = current;
  return transportState;
}

function getReplyCapabilitySnapshot(session: SessionWithVoiceState): ReplyCapabilitySnapshot | undefined {
  return session.state?.qqReplyTransport?.capabilitySnapshot;
}

function setReplyCapabilitySnapshot(session: SessionWithVoiceState, snapshot: ReplyCapabilitySnapshot): void {
  getReplyTransportState(session).capabilitySnapshot = snapshot;
}

function getReplyRunId(session: SessionWithVoiceState): string | undefined {
  const runId = session.state?.qqReplyTransport?.runId;
  return typeof runId === 'string' && runId.trim() ? runId.trim() : undefined;
}

function setReplyRunId(session: SessionWithVoiceState, runId: string): void {
  getReplyTransportState(session).runId = runId;
}

function clearReplyRunId(session: SessionWithVoiceState): void {
  const transportState = session.state?.qqReplyTransport;
  if (!transportState) return;
  delete transportState.runId;
}

function suppressReplyErrorNotice(session: SessionWithVoiceState): void {
  getReplyTransportState(session).suppressErrorNotice = true;
}

function setReplyRequestModelErrorHandler(
  session: SessionWithVoiceState,
  handler: ReplyTransportState['handleRequestModelError'],
): void {
  const transportState = getReplyTransportState(session);
  if (handler) {
    transportState.handleRequestModelError = handler;
    return;
  }
  delete transportState.handleRequestModelError;
}

function setReplyRequestBoundaryPersistedHandler(
  session: SessionWithVoiceState,
  handler: ReplyTransportState['handleRequestBoundaryPersisted'],
): void {
  const transportState = getReplyTransportState(session);
  if (handler) {
    transportState.handleRequestBoundaryPersisted = handler;
    return;
  }
  delete transportState.handleRequestBoundaryPersisted;
}

function registerReplyRunRequestModelGuard(args: {
  session: SessionWithVoiceState;
  runId: string;
  conversationId?: string;
  finishRun: (requestSettlementError?: unknown) => boolean;
  normalizeHistory: (
    visibleText: string,
    requestDisposition?: 'retain_request' | 'drop_request',
    allowMissingBoundary?: boolean,
  ) => Promise<void>;
}): void {
  const {
    session,
    runId,
    conversationId,
    finishRun,
    normalizeHistory,
  } = args;
  setReplyRequestModelErrorHandler(session, async (error, requestState) => {
    const expectedCancellation = error instanceof ReplyRunCancellationError && error.runId === runId;
    const userNotice = expectedCancellation ? null : formatReplyModelFailureNotice(error);
    if (!expectedCancellation) {
      const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
      logger.error(
        'reply request_conversation failed before executor cleanup: runId=%s conversationId=%s error=%s',
        runId,
        conversationId ?? '<unknown>',
        message,
      );
      const providerFailure = readReplyProviderHttpFailure(error);
      if (providerFailure) {
        logger.error(
          'reply model upstream failure: runId=%s conversationId=%s chatlunaCode=%s operation=%s httpStatus=%s providerCode=%s providerMessage=%j retryable=%s',
          runId,
          conversationId ?? '<unknown>',
          String(providerFailure.chatlunaCode),
          providerFailure.operation,
          String(providerFailure.httpStatus),
          providerFailure.providerCode ?? '<none>',
          providerFailure.providerMessage ?? '<none>',
          providerFailure.retryable ? 'true' : 'false',
        );
      }
      if (error instanceof Error && error.stack) {
        logger.debug(error.stack);
      }
      const terminalFailure = readAgentTerminalContractFailure(error);
      if (terminalFailure) {
        logger.error(
          'reply terminal contract failed: runId=%s conversationId=%s code=%s',
          runId,
          conversationId ?? '<unknown>',
          terminalFailure.code,
        );
      }
    }
    // Model failures have not crossed the OneBot delivery boundary here.
    // Keep the request, but never persist an unconfirmed failure notice as an AI reply.
    const visibleHistoryText = '';
    try {
      await normalizeHistory(
        visibleHistoryText,
        expectedCancellation ? 'drop_request' : 'retain_request',
        !requestState.requestBoundaryPersisted,
      );
    } catch (cleanupError) {
      logger.warn(
        'reply request failure history cleanup failed: runId=%s conversationId=%s error=%s',
        runId,
        conversationId ?? '<unknown>',
        (cleanupError as Error).message,
      );
      finishRun(cleanupError);
      throw cleanupError;
    }
    finishRun();
    return userNotice ?? undefined;
  });
}

function formatReplyModelFailureNotice(error: unknown): string | null {
  if (readAgentTerminalContractFailure(error)) {
    return '刚才那条没整理好。你再发一次，我重新来。';
  }
  const failure = readReplyProviderHttpFailure(error);
  if (!failure) return null;

  if (failure.httpStatus === 402 && failure.providerCode === 'quota_exceeded') {
    return '主聊天服务请求失败：HTTP 402，error_code=quota_exceeded，当前额度已用完。请等待额度重置、补充额度，或在管理页切换服务。';
  }

  return `主聊天服务请求失败：HTTP ${failure.httpStatus}。请稍后重试；持续失败请联系管理员并提供错误发生时间。`;
}

function readAgentTerminalContractFailure(error: unknown): { code: string } | null {
  const visited = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    if (visited.has(current)) break;
    visited.add(current);
    const record = current as Record<string, unknown>;
    if (record.name === 'AgentTerminalContractError') {
      const code = typeof record.code === 'string' && record.code.trim()
        ? record.code.trim()
        : 'UNKNOWN';
      return { code };
    }
    current = record.originError ?? record.cause;
  }
  return null;
}

type ReplyProviderHttpFailure = {
  chatlunaCode: number;
  operation: string;
  httpStatus: number;
  providerCode: string | null;
  providerMessage: string | null;
  retryable: boolean;
};

function readReplyProviderHttpFailure(error: unknown): ReplyProviderHttpFailure | null {
  if (!(error instanceof Error) || error.name !== 'ChatLunaError') return null;
  const chatlunaError = error as Error & {
    errorCode?: unknown;
    originError?: unknown;
    retryable?: unknown;
  };
  const origin = chatlunaError.originError;
  if (!(origin instanceof Error) || origin.name !== 'ChatLunaHttpError') return null;
  const httpError = origin as Error & {
    operation?: unknown;
    status?: unknown;
    providerCode?: unknown;
    providerMessage?: unknown;
  };
  if (typeof chatlunaError.errorCode !== 'number' || typeof httpError.status !== 'number') return null;
  if (typeof httpError.operation !== 'string' || !httpError.operation.trim()) return null;
  return {
    chatlunaCode: chatlunaError.errorCode,
    operation: httpError.operation,
    httpStatus: httpError.status,
    providerCode: typeof httpError.providerCode === 'string' && httpError.providerCode.trim()
      ? httpError.providerCode.trim()
      : null,
    providerMessage: typeof httpError.providerMessage === 'string' && httpError.providerMessage.trim()
      ? httpError.providerMessage.trim()
      : null,
    retryable: chatlunaError.retryable !== false,
  };
}

function getReplyV2State(session: SessionWithVoiceState): ReplyV2State {
  const current = session.state ?? {};
  const replyV2 = current.qqReplyV2 ?? {};
  current.qqReplyV2 = replyV2;
  session.state = current;
  return replyV2;
}

function getReplyRouteState(session: SessionWithVoiceState): ReplyRoute | null {
  const route = session.state?.qqReplyV2?.route;
  return route ?? null;
}

function setReplyRouteState(session: SessionWithVoiceState, route: ReplyRoute): void {
  getReplyV2State(session).route = route;
}

function canSessionUseMention(session: SessionWithVoiceState): boolean {
  return !session.isDirect;
}

function resolveStickerIntentHints(state: StickerCapabilityState | undefined): string[] {
  if (!state?.catalog) return [];
  const presetScope = state.preset ? `persona:${state.preset.trim().toLowerCase()}` : null;
  const hints = state.catalog.entries
    .filter((entry) => entry.scopes.some((scope) => (
      scope.trim().toLowerCase() === 'global'
      || (presetScope != null && scope.trim().toLowerCase() === presetScope)
    )))
    .flatMap((entry) => entry.moods)
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(hints)].slice(0, 12);
}

export function buildTurnCapabilitySnapshot(
  session: SessionWithVoiceState,
  snapshot: ReplyCapabilitySnapshot,
  modalityPolicy: ModalityPolicySnapshot,
  stickerState: StickerCapabilityState | null,
  imageAssetRefs: readonly string[],
): NonNullable<TurnContext['capabilitySnapshot']> {
  const stickerAvailableCount = stickerState?.availableCount ?? 0;
  const voiceIntentAllowed = modalityPolicy.canVoice || modalityPolicy.voiceReason === 'explicit_request';
  const stickerIntentAllowed = modalityPolicy.canSticker || modalityPolicy.stickerReason === 'explicit_request';
  return {
    canMultiline: snapshot.canMultiline,
    canMention: canSessionUseMention(session),
    canVoice: voiceIntentAllowed,
    voiceOutputLanguage: snapshot.voiceOutputLanguage,
    canSticker: stickerIntentAllowed,
    stickerAvailableCount,
    stickerIntentHints: resolveStickerIntentHints(stickerState ?? undefined),
    imageAssetRefs: [...imageAssetRefs],
    source: snapshot.source,
  };
}

function ensureReplyPluginRoom(room: ReplyRuntimeRoomLike | undefined): void {
  const chatMode = String((room as { chatMode?: unknown } | undefined)?.chatMode ?? '').trim();
  if (chatMode === 'plugin') return;

  throw new Error(`qqbot reply requires room.chatMode=plugin, got ${chatMode || 'unknown'}.`);
}

export function ensureSupportedStructuredReplyModel(
  target: ResolvedModelTarget,
): void {
  if (
    target.model.capabilities.structuredOutput
    && target.model.structuredOutputProtocol !== null
    && target.model.structuredOutputProtocol !== 'json_mode'
  ) {
    return;
  }
  throw new Error(
    `qqbot reply output contract requires a typed structured-output model, got ${target.canonicalModel}.`,
  );
}

export function applyReplyOutputContract(
  inputMessage: ReplyInputMessageLike,
  options: ReplyOutputContractApplyOptions,
): MainChatReplyOutputContract;
export function applyReplyOutputContract(
  inputMessage: ReplyInputMessageLike | undefined,
  options: ReplyOutputContractApplyOptions,
): MainChatReplyOutputContract | null;
export function applyReplyOutputContract(
  inputMessage: ReplyInputMessageLike | undefined,
  options: ReplyOutputContractApplyOptions,
): MainChatReplyOutputContract | null {
  if (!inputMessage) return null;

  ensureSupportedStructuredReplyModel(options.modelTarget);
  const replyOutputContract = options.replyOutputContract ?? buildModelReplyOutputContract({
    canonicalModel: options.modelTarget.canonicalModel,
    model: options.modelTarget.model,
    canVoice: options.capabilitySnapshot?.canVoice !== false,
    canMeme: options.capabilitySnapshot?.canSticker === true,
    stickerIntentHints: options.capabilitySnapshot?.stickerIntentHints,
    voiceOutputLanguage: options.capabilitySnapshot?.voiceOutputLanguage,
  });
  const overrideRequestParams = mergeReplyOverrideRequestParams(inputMessage.additional_kwargs, replyOutputContract.overrideRequestParams);
  const replyMode = options.replyMode ?? 'agent';

  inputMessage.additional_kwargs = {
    ...(inputMessage.additional_kwargs ?? {}),
    qqbot_reply_mode: replyMode,
    ...buildReplyOutputContractAdditionalKwargs(replyOutputContract, {
      overrideRequestParams,
    }),
  };
  return replyOutputContract;
}

export function mergeReplyOverrideRequestParams(
  additionalKwargs: Record<string, unknown> | undefined,
  overridePatch: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const existingOverride = asPlainRecord(additionalKwargs?.overrideRequestParams);

  if (!existingOverride && !overridePatch) return null;
  return {
    ...(existingOverride ?? {}),
    ...(overridePatch ?? {}),
  };
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveReplyOutputProtocolFromMessage(
  inputMessage: ReplyInputMessageLike | undefined,
): ReplyCompilerOutputProtocol {
  if (!inputMessage) {
    throw new Error('reply executor requires inputMessage with qqbot_final_response_contract.protocol.');
  }

  const contract = asPlainRecord(inputMessage?.additional_kwargs?.qqbot_final_response_contract);
  const protocol = contract?.protocol;
  if (
    protocol === 'native_chat_json_schema' ||
    protocol === 'native_responses_json_schema' ||
    protocol === 'chat_reply_v1'
  ) {
    return protocol;
  }
  throw new Error('reply executor requires inputMessage with qqbot_final_response_contract.protocol.');
}

function applyReplyTurnInputMetadata(
  inputMessage: ReplyInputMessageLike | undefined,
  turnInput: Pick<TurnInput, 'hasImageInput' | 'imageCount' | 'hasVoiceInput' | 'displayName' | 'userId' | 'isDirect'>,
): void {
  if (!inputMessage) return;

  const existingSpeakerFormat =
    (inputMessage.additional_kwargs?.qqbot_speaker_format as ReplySpeakerFormatMeta | undefined) ?? undefined;

  inputMessage.additional_kwargs = {
    ...(inputMessage.additional_kwargs ?? {}),
    qqbot_input_content_meta: {
      hasImageInput: turnInput.hasImageInput,
      imageCount: turnInput.imageCount,
      hasVoiceInput: turnInput.hasVoiceInput,
    } satisfies ReplyInputContentMeta,
    qqbot_speaker_format: {
      version: 'speaker_id_v1',
      speakerId: turnInput.userId,
      speakerName: turnInput.displayName,
      isDirect: turnInput.isDirect,
      ...(existingSpeakerFormat?.preformatted === true ? { preformatted: true } : {}),
    } satisfies ReplySpeakerFormatMeta,
  };
}

function cloneTurnInputImagePart(part: TurnInputImagePart): TurnInputImagePart {
  return {
    type: 'image_url',
    image_url: typeof part.image_url === 'string'
      ? part.image_url
      : { ...part.image_url },
  };
}

function applyPreparedTurnInput(
  session: SessionWithVoiceState,
  context: MiddlewareContextLike,
  turnInput: TurnInput,
  inputTextSpeakerTagged?: boolean,
): void {
  const normalized = turnInput.text.trim();

  session.content = normalized;
  const inputMessage = context.options?.inputMessage;
  if (inputMessage) {
    inputMessage.content = turnInput.imageParts.length > 0
      ? [
          ...(normalized ? [{ type: 'text', text: normalized }] : []),
          ...turnInput.imageParts.map(cloneTurnInputImagePart),
        ]
      : normalized;

    const speakerFormat = inputMessage.additional_kwargs?.qqbot_speaker_format as ReplySpeakerFormatMeta | undefined;
    if (speakerFormat?.version === 'speaker_id_v1') {
      inputMessage.additional_kwargs = {
        ...(inputMessage.additional_kwargs ?? {}),
        qqbot_speaker_format: {
          ...speakerFormat,
          ...(inputTextSpeakerTagged ? { preformatted: true } : {}),
        },
      };
      if (!inputTextSpeakerTagged) {
        delete (inputMessage.additional_kwargs.qqbot_speaker_format as ReplySpeakerFormatMeta).preformatted;
      }
    }
  }
}

function buildReplyTurnStateText(context: ReplyTurnContinuationContext): string {
  const lines = ['这是一次回复中断后的重生成。'];
  if (context.alreadySentText) {
    lines.push('以下内容已经发给用户，不要重复：');
    lines.push(context.alreadySentText);
  }
  if (context.pendingUnitTexts.length > 0) {
    lines.push('以下内容是上一轮尚未发出的剩余发送单元，仅供承接参考，不要机械复述：');
    lines.push(context.pendingUnitTexts.join('\n'));
  }
  if (context.progressVisibleLines.length > 0) {
    lines.push('以下过程短句已经发给用户，不要重复开场，也不要当作最终答复：');
    lines.push(context.progressVisibleLines.join('\n'));
  }
  if (context.supplementalMessages.length > 0) {
    lines.push('在当前主消息之前，还收到了这些补充消息：');
    lines.push(...context.supplementalMessages);
  }
  lines.push('请基于当前用户输入，自然决定现在应该怎么回复。');
  return lines.join('\n');
}

function registerReplyTurnStateFragment(
  conversationId: string,
  continuationContext: ReplyTurnContinuationContext | undefined,
): void {
  if (!continuationContext) return;
  registerPromptFragment(conversationId, {
    source: 'qqbot_reply_interrupt_state',
    title: 'Reply Interrupt State',
    authority: 'assistant_state',
    trust: 'trusted',
    ttl: 'turn',
    channel: 'required',
    payload: {
      kind: 'text',
      value: buildReplyTurnStateText(continuationContext),
    },
  });
}

function injectReplyPromptEnvelope(args: {
  chatluna: ChatLunaLike;
  conversationId: string;
  turnContext: Pick<TurnContext, 'input' | 'policySnapshot' | 'capabilitySnapshot' | 'continuationContext'>;
  outputProtocol?: ReplyCompilerOutputProtocol;
}): PromptEnvelopeMessage[] {
  const contextManager = args.chatluna.contextManager;
  if (!contextManager) {
    throw new Error('reply prompt compiler requires chatluna.contextManager.');
  }

  const workingContext = peekPromptFragments(args.conversationId);
  const envelope = compileReplyPromptEnvelope(buildReplyPromptCompilerInput(args.turnContext, workingContext, {
    outputProtocol: args.outputProtocol,
  }));
  clearPromptAssemblyTurn(args.conversationId);
  if (!envelope?.messages.length) return [];

  injectPromptEnvelope(contextManager, {
    name: 'qqbot_reply_prompt_envelope',
    envelope,
    once: true,
    conversationId: args.conversationId,
  });

  return envelope.messages;
}

function rememberReplyCapabilitySnapshot(
  session: SessionWithVoiceState,
  snapshot: ReplyCapabilitySnapshot,
  replyCapabilitySnapshots: Map<string, ReplyCapabilitySnapshot>,
): void {
  setReplyCapabilitySnapshot(session, snapshot);
  const queueKey = resolveReplyQueueKey(session);
  if (queueKey) {
    replyCapabilitySnapshots.set(queueKey, snapshot);
  }
}

function getAuthorizedReplyCapabilitySnapshot(
  session: Session,
  replyCapabilitySnapshots: Map<string, ReplyCapabilitySnapshot>,
): ReplyCapabilitySnapshot | undefined {
  const sessionSnapshot = getReplyCapabilitySnapshot(session as SessionWithVoiceState);
  if (sessionSnapshot) return sessionSnapshot;

  const queueKey = resolveReplyQueueKey(session);
  if (!queueKey) return undefined;
  return replyCapabilitySnapshots.get(queueKey);
}

function getTtsCapabilityState(
  runtime: RuntimeConfig,
  ttsCapabilityStates: Map<string, TtsCapabilityState>,
): TtsCapabilityState {
  const cacheKey = runtime.ttsBaseUrl || 'disabled';
  const existing = ttsCapabilityStates.get(cacheKey);
  if (existing) return existing;

  const created: TtsCapabilityState = {
    lastKnownHealthy: null,
    lastProbeAt: 0,
    lastProbeTurn: 0,
    turnCounter: 0,
    pendingProbe: null,
    failureBackoffUntil: 0,
    lastFailure: null,
  };
  ttsCapabilityStates.set(cacheKey, created);
  return created;
}

function updateTtsCapabilityObservation(
  state: TtsCapabilityState,
  healthy: boolean,
  failure: VoiceOutputFailure | null = null,
): void {
  const now = Date.now();
  state.lastKnownHealthy = healthy;
  state.lastProbeAt = now;
  state.lastProbeTurn = state.turnCounter;
  state.failureBackoffUntil = healthy ? 0 : now + TTS_PROBE_FAILURE_BACKOFF_MS;
  state.lastFailure = healthy ? null : failure;
}

function isTtsProbeDue(state: TtsCapabilityState, now = Date.now()): boolean {
  if (!state.lastProbeAt) return true;
  if (state.turnCounter - state.lastProbeTurn >= TTS_PROBE_TURN_INTERVAL) return true;
  return now - state.lastProbeAt >= TTS_PROBE_TIME_INTERVAL_MS;
}

async function runTtsHealthProbe(
  runtime: RuntimeConfig,
  state: TtsCapabilityState,
  force = false,
): Promise<boolean> {
  if (!runtime.ttsBaseUrl) return false;
  if (!force && state.pendingProbe) return state.pendingProbe;
  if (!force && state.failureBackoffUntil > Date.now()) {
    return state.lastKnownHealthy === true;
  }

  const task = (async () => {
    let healthy = false;
    let failure: VoiceOutputFailure | null = null;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.min(runtime.synthTimeoutMs, TTS_PROBE_TIMEOUT_MS));

    try {
      const response = await fetch(`${runtime.ttsBaseUrl}/healthz`, {
        method: 'GET',
        headers: createAuthHeaders(runtime.ttsApiKey),
        signal: controller.signal,
      });
      healthy = response.ok;
      if (!healthy) {
        const providerCode = await readHttpProviderCode(response);
        failure = {
          code: 'tts_health_http',
          stage: 'health_probe',
          operation: 'tts.healthz',
          httpStatus: response.status,
          ...(providerCode ? { providerCode } : {}),
        };
      }
    } catch (error) {
      logger.warn('tts health probe failed: %s', (error as Error).message);
      healthy = false;
      failure = {
        code: timedOut ? 'tts_health_timeout' : 'tts_health_transport',
        stage: 'health_probe',
        operation: 'tts.healthz',
      };
    } finally {
      clearTimeout(timer);
    }

    updateTtsCapabilityObservation(state, healthy, failure);
    return healthy;
  })().finally(() => {
    if (state.pendingProbe === task) {
      state.pendingProbe = null;
    }
  });

  state.pendingProbe = task;
  return task;
}

export async function resolveReplyCapabilitySnapshot(args: {
  runtime: RuntimeConfig;
  session: SessionWithVoiceState;
  canSendRecordCache?: Map<string, boolean>;
  ttsCapabilityStates?: Map<string, TtsCapabilityState>;
  voiceOutputEnabled?: boolean;
  requireFreshVoiceCapability?: boolean;
}): Promise<ReplyCapabilitySnapshot> {
  const {
    runtime,
    session,
    canSendRecordCache = sharedReplyTransportCanSendRecordCache,
    ttsCapabilityStates = sharedReplyTransportTtsCapabilityStates,
    voiceOutputEnabled = false,
    requireFreshVoiceCapability = false,
  } = args;
  const snapshot: ReplyCapabilitySnapshot = {
    canMultiline: true,
    canVoice: false,
    voiceOutputLanguage: runtime.voiceOutputLanguage,
    source: 'cached',
    refreshedAt: Date.now(),
    voiceFailure: null,
  };

  if (!voiceOutputEnabled) {
    snapshot.voiceFailure = {
      code: 'feature_disabled',
      stage: 'policy',
      operation: 'voice.output_policy',
    };
    return snapshot;
  }
  if (!isVoiceOutputConfigured(runtime)) {
    snapshot.voiceFailure = {
      code: 'tts_not_configured',
      stage: 'configuration',
      operation: 'tts.synthesize',
    };
    return snapshot;
  }

  const bot = session.bot as OneBotBotLike;
  let canSendRecord = false;
  try {
    canSendRecord = await ensureCanSendRecord(
      bot,
      canSendRecordCache,
      requireFreshVoiceCapability,
    );
  } catch (error) {
    if (!(error instanceof VoiceOutputError)) throw error;
    logger.warn(
      'onebot voice capability probe failed: operation=%s code=%s providerCode=%s error=%s',
      error.failure.operation,
      error.failure.code,
      error.failure.providerCode ?? '<none>',
      error.message,
    );
    snapshot.voiceFailure = error.failure;
    return snapshot;
  }
  if (!canSendRecord) {
    snapshot.voiceFailure = {
      code: 'platform_record_unsupported',
      stage: 'platform_capability',
      operation: 'onebot.can_send_record',
    };
    return snapshot;
  }

  const ttsState = getTtsCapabilityState(runtime, ttsCapabilityStates);
  ttsState.turnCounter += 1;
  const due = isTtsProbeDue(ttsState, snapshot.refreshedAt);

  if (requireFreshVoiceCapability) {
    try {
      await runTtsHealthProbe(runtime, ttsState, true);
    } catch (error) {
      logger.warn('blocking tts probe failed: %s', (error as Error).message);
    }
  }

  if (due && snapshot.refreshedAt >= ttsState.failureBackoffUntil && !ttsState.pendingProbe) {
    void runTtsHealthProbe(runtime, ttsState).catch((error) => {
      logger.warn('background tts probe failed: %s', (error as Error).message);
    });
  }

  snapshot.canVoice = ttsState.lastKnownHealthy === true;
  snapshot.voiceFailure = snapshot.canVoice
    ? null
    : ttsState.lastFailure ?? {
        code: 'tts_health_pending',
        stage: 'health_probe',
        operation: 'tts.healthz',
      };
  return snapshot;
}

function hasVoiceSegments(plan: OutboundMessagePlan): boolean {
  return plan.segments.some((segment) => segment.kind === 'voice-block');
}

function hasStickerSegments(plan: OutboundMessagePlan): boolean {
  return plan.segments.some((segment) => segment.kind === 'sticker-block');
}

async function prepareVoiceDeliveries(args: {
  runtime: RuntimeConfig;
  plan: ReplyTransportPlan;
  bot: OneBotBotLike;
  canSendRecordCache: Map<string, boolean>;
  ttsCapabilityStates: Map<string, TtsCapabilityState>;
  explicitVoiceRequested: boolean;
}): Promise<{ preparedByRaw: Map<string, PreparedVoiceDelivery>; effectivePlan: ReplyTransportPlan }> {
  const { runtime, plan, bot, canSendRecordCache, ttsCapabilityStates, explicitVoiceRequested } = args;
  const unavailablePlan = (failure: VoiceOutputFailure) => explicitVoiceRequested
    ? replaceRequestedVoiceWithFailure(plan, failure)
    : downgradeVoiceSegmentsToText(plan);
  const outboundPlan = buildOutboundMessagePlanFromReplyPlan(plan);
  if (!hasVoiceSegments(outboundPlan)) {
    return { preparedByRaw: new Map(), effectivePlan: plan };
  }
  if (!isVoiceOutputConfigured(runtime)) {
    return {
      preparedByRaw: new Map(),
      effectivePlan: unavailablePlan({
        code: 'tts_not_configured',
        stage: 'configuration',
        operation: 'tts.synthesize',
      }),
    };
  }
  let canSendRecord = false;
  try {
    canSendRecord = await ensureCanSendRecord(bot, canSendRecordCache);
  } catch (error) {
    if (!(error instanceof VoiceOutputError)) throw error;
    return {
      preparedByRaw: new Map(),
      effectivePlan: unavailablePlan(error.failure),
    };
  }
  if (!canSendRecord) {
    return {
      preparedByRaw: new Map(),
      effectivePlan: unavailablePlan({
        code: 'platform_record_unsupported',
        stage: 'platform_capability',
        operation: 'onebot.can_send_record',
      }),
    };
  }

  const voiceSegments = outboundPlan.segments.filter(
    (segment): segment is OutboundMessageSegment & { kind: 'voice-block' } => segment.kind === 'voice-block',
  );
  const ttsState = getTtsCapabilityState(runtime, ttsCapabilityStates);
  const preparedByRaw = new Map<string, PreparedVoiceDelivery>();

  try {
    const preparedEntries = await Promise.all(
      voiceSegments.map(async (segment) => {
        const text = normalizeVoiceSynthesisText(segment.content);
        if (!text) {
          throw new VoiceOutputError({
            code: 'voice_content_empty',
            stage: 'content_validation',
            operation: 'voice.normalize',
          }, 'voice segment is empty after normalization.');
        }
        const wordCount = countVoiceWords(text);
        if (wordCount > runtime.outputMaxWords) {
          throw new VoiceOutputError({
            code: 'voice_content_word_limit',
            stage: 'content_validation',
            operation: 'voice.word_limit',
            limit: runtime.outputMaxWords,
          }, `voice segment exceeds ${runtime.outputMaxWords} words.`);
        }

        const style = pickVoiceStyle(text);
        const wav = await synthesizeVoice(runtime, text, style);
        const durationMs = estimateWavDurationMs(wav);
        if (durationMs == null) {
          throw new VoiceOutputError({
            code: 'tts_synthesis_invalid_audio',
            stage: 'synthesis',
            operation: 'tts.synthesize_response',
          }, 'TTS synthesis returned invalid WAV data.');
        }
        if (durationMs > runtime.outputMaxSeconds * 1000) {
          throw new VoiceOutputError({
            code: 'voice_content_duration_limit',
            stage: 'content_validation',
            operation: 'voice.duration_limit',
            limit: runtime.outputMaxSeconds,
          }, `voice segment exceeds ${runtime.outputMaxSeconds} seconds.`);
        }
        return [segment.raw, { segment, text, style, wav }] as const;
      }),
    );

    for (const [raw, prepared] of preparedEntries) {
      preparedByRaw.set(raw, prepared);
    }

    updateTtsCapabilityObservation(ttsState, true);
    return { preparedByRaw, effectivePlan: plan };
  } catch (error) {
    const failure = error instanceof VoiceOutputError
      ? error.failure
      : {
          code: 'tts_synthesis_transport' as const,
          stage: 'synthesis' as const,
          operation: 'tts.synthesize',
        };
    if (failure.stage !== 'content_validation') {
      updateTtsCapabilityObservation(ttsState, false, failure);
    }
    logger.warn(
      'voice preflight failed: stage=%s operation=%s code=%s httpStatus=%s providerCode=%s error=%s',
      failure.stage,
      failure.operation,
      failure.code,
      failure.httpStatus == null ? '<none>' : String(failure.httpStatus),
      failure.providerCode ?? '<none>',
      (error as Error).message,
    );
    return { preparedByRaw: new Map(), effectivePlan: unavailablePlan(failure) };
  }
}

async function prepareStickerDeliveries(args: {
  stickerState: StickerCapabilityState | null;
  plan: ReplyTransportPlan;
  explicitStickerRequested: boolean;
}): Promise<{ preparedByRaw: Map<string, PreparedStickerDelivery>; effectivePlan: ReplyTransportPlan }> {
  const { stickerState, plan, explicitStickerRequested } = args;
  const outboundPlan = buildOutboundMessagePlanFromReplyPlan(plan);
  if (!hasStickerSegments(outboundPlan)) {
    return { preparedByRaw: new Map(), effectivePlan: plan };
  }

  if (!stickerState?.catalog) {
    return {
      preparedByRaw: new Map(),
      effectivePlan: explicitStickerRequested
        ? replaceStickerSegmentsWithFailure(plan)
        : removeStickerSegments(plan),
    };
  }

  const stickerSegments = outboundPlan.segments.filter(
    (segment): segment is OutboundMessageSegment & { kind: 'sticker-block' } => segment.kind === 'sticker-block',
  );
  const preparedByRaw = new Map<string, PreparedStickerDelivery>();
  const effectiveSegments: ReplyTransportPlan['segments'] = [];
  const usedStickerIds = new Set<string>();
  let stickerIndex = 0;

  for (const segment of plan.segments) {
    if (segment.kind !== 'sticker') {
      effectiveSegments.push(segment);
      continue;
    }

    const outboundSticker = stickerSegments[stickerIndex];
    stickerIndex += 1;
    if (!outboundSticker) continue;

    const selected = resolveStickerSelection(stickerState.catalog, segment.content, stickerState.preset, {
      usedIds: usedStickerIds,
      sequenceIndex: preparedByRaw.size,
    });
    if (!selected) {
      if (explicitStickerRequested) {
        effectiveSegments.push({
          kind: 'message',
          parts: [{ kind: 'text', content: '这次没找到合适的表情，我先不乱发。' }],
        });
      }
      continue;
    }

    preparedByRaw.set(outboundSticker.raw, {
      segment: outboundSticker,
      historyLine: createStickerHistoryLine(selected),
      buffer: selected.buffer,
      mime: selected.mime,
    });
    usedStickerIds.add(selected.id.trim().toLowerCase());
    effectiveSegments.push(segment);
  }

  return { preparedByRaw, effectivePlan: { segments: effectiveSegments } };
}

async function deliverReplyPlanCore(args: {
  runtime: RuntimeConfig;
  session: SessionWithVoiceState;
  stickerState: StickerCapabilityState | null;
  plan: ReplyTransportPlan;
  sendStrand?: ReturnType<typeof createKeyedStrandRunner>;
  canSendRecordCache?: Map<string, boolean>;
  ttsCapabilityStates?: Map<string, TtsCapabilityState>;
  queueKey?: string | null;
  beginSend?: () => AbortSignal | null;
  wasInterrupted?: () => boolean;
  resolveQuoteTargetMessageId?: (supports: boolean) => string | null;
  onPlannedUnitHistoryLines?: (historyLines: string[]) => void;
  onCommittedUnit?: (historyLine: string) => void;
  onDeliveryReceipt?: (receipt: DeliveryReceipt) => void;
  onPlannedDeliveryUnits?: (
    units: ReplyDeliveryPlannedUnit[],
  ) => Promise<ReplyDeliveryPlannedUnit[] | void>;
  onUnitDispatching?: (unit: ReplyDeliveryPlannedUnit) => Promise<void>;
  onUnitReplanned?: (unit: ReplyDeliveryPlannedUnit) => Promise<void>;
  onUnitConfirmed?: (unit: ReplyDeliveryPlannedUnit, receipt: DeliveryReceipt) => Promise<void>;
  onUnitNotSent?: (unit: ReplyDeliveryPlannedUnit, error: unknown) => Promise<void>;
  onUnitOutcomeUnknown?: (unit: ReplyDeliveryPlannedUnit, error: unknown) => Promise<void>;
  onDeliveredModality?: (modality: 'sticker' | 'voice') => void;
  modalityPolicy: ModalityPolicySnapshot | null;
}): Promise<ReplyPlanDeliveryResult> {
  const {
    runtime,
    session,
    stickerState,
    plan,
    sendStrand = sharedReplyTransportSendStrand,
    canSendRecordCache = sharedReplyTransportCanSendRecordCache,
    ttsCapabilityStates = sharedReplyTransportTtsCapabilityStates,
    queueKey,
    beginSend,
    wasInterrupted,
    resolveQuoteTargetMessageId,
    onPlannedUnitHistoryLines,
    onCommittedUnit,
    onDeliveryReceipt,
    onPlannedDeliveryUnits,
    onUnitDispatching,
    onUnitReplanned,
    onUnitConfirmed,
    onUnitNotSent,
    onUnitOutcomeUnknown,
    onDeliveredModality,
    modalityPolicy,
  } = args;
  const explicitVoiceRequested = modalityPolicy?.voiceReason === 'explicit_request';
  const explicitStickerRequested = modalityPolicy?.stickerReason === 'explicit_request';
  const historyText = renderDeliveredReplyPlanHistoryText(plan);
  if (session.platform !== 'onebot' || !session.channelId) {
    throw new Error('reply plan delivery requires a onebot session with channelId.');
  }

  const preparedVoice = await prepareVoiceDeliveries({
    runtime,
    plan,
    bot: session.bot as OneBotBotLike,
    canSendRecordCache,
    ttsCapabilityStates,
    explicitVoiceRequested,
  });
  const preparedSticker = await prepareStickerDeliveries({
    stickerState,
    plan: preparedVoice.effectivePlan,
    explicitStickerRequested,
  });
  const effectivePlan = preparedSticker.effectivePlan;
  const outboundPlan = buildOutboundMessagePlanFromReplyPlan(effectivePlan);
  if (!outboundPlan.segments.length) {
    return { status: 'failed_before_send', historyText: '' };
  }

  const bot = session.bot as OneBotBotLike;
  const effectiveHistoryText = renderDeliveredReplyPlanHistoryText(effectivePlan, preparedSticker.preparedByRaw) || historyText;
  const plannedUnitHistoryLines = buildPlannedUnitHistoryLines({
    outboundPlan,
    preparedVoiceByRaw: preparedVoice.preparedByRaw,
    preparedStickerByRaw: preparedSticker.preparedByRaw,
  });
  let plannedDeliveryUnits = buildPlannedDeliveryUnits({
    outboundPlan,
    historyLines: plannedUnitHistoryLines,
    preparedVoiceByRaw: preparedVoice.preparedByRaw,
    preparedStickerByRaw: preparedSticker.preparedByRaw,
  });
  onPlannedUnitHistoryLines?.(plannedUnitHistoryLines);
  const durablePlannedUnits = await onPlannedDeliveryUnits?.(plannedDeliveryUnits);
  if (durablePlannedUnits) {
    if (durablePlannedUnits.length !== plannedDeliveryUnits.length) {
      throw new Error('reply delivery checkpoint returned a mismatched unit count.');
    }
    plannedDeliveryUnits = durablePlannedUnits;
  }
  let hasConfirmedDelivery = false;
  let deliveryHistoryChanged = false;
  const deliveredModalities = new Set<ExplicitReplyModality>();
  const resolveCompletedDelivery = (completedHistoryText: string): ReplyPlanDeliveryResult => {
    try {
      assertExplicitModalityInvariant(modalityPolicy, {
        stage: 'delivery',
        deliveredModalities: [...deliveredModalities],
      });
    } catch (error) {
      if (!(error instanceof ExplicitModalityInvariantError)) throw error;
      return {
        status: 'failed_semantic',
        historyText: completedHistoryText,
        semanticFailure: error,
      };
    }
    return {
      status: 'delivered',
      historyText: completedHistoryText,
    };
  };
  let sendAbortSignal: AbortSignal | null = null;
  let activeDeliveryUnit: ReplyDeliveryPlannedUnit | null = null;
  let activeUnitSendAttempted = false;
  let hasUnknownDeliveryOutcome = false;
  const readActiveDeliveryUnit = (): ReplyDeliveryPlannedUnit | null => activeDeliveryUnit;
  const committedHistoryLines: string[] = [];
  const wasSendAborted = () => (sendAbortSignal as AbortSignal | null)?.aborted === true;
  const sendTask = async () => {
    sendAbortSignal = beginSend?.() ?? null;
    if (beginSend && !sendAbortSignal) {
      return;
    }

    const { sendWhole, sendLine } = createBotMessageDispatchers(bot, session.channelId!, session);
    await dispatchOutboundMessagePlan(outboundPlan, async (segment) => {
      const unitIndex = outboundPlan.segments.indexOf(segment);
      const plannedDeliveryUnit = plannedDeliveryUnits[unitIndex];
      if (!plannedDeliveryUnit) {
        throw new Error(`reply delivery unit ${unitIndex} was not prepared.`);
      }
      await onUnitDispatching?.(plannedDeliveryUnit);
      activeDeliveryUnit = plannedDeliveryUnit;
      activeUnitSendAttempted = false;
      const confirmDeliveryUnit = async (
        receipt: DeliveryReceipt,
        confirmedUnit: ReplyDeliveryPlannedUnit = plannedDeliveryUnit,
      ) => {
        await onUnitConfirmed?.(confirmedUnit, receipt);
        activeDeliveryUnit = null;
        activeUnitSendAttempted = false;
      };
      const historyLine = plannedUnitHistoryLines[unitIndex] ?? '';
      const quoteTargetMessageId = resolveQuoteTargetMessageId?.(segment.kind !== 'voice-block') ?? null;
      if (segment.kind === 'text-line') {
        activeUnitSendAttempted = true;
        const receipt = requireDeliveryReceipt(
          await sendLine(createQuotedMessageContent(segment.content, quoteTargetMessageId)),
        );
        await confirmDeliveryUnit(receipt);
        hasConfirmedDelivery = true;
        onDeliveryReceipt?.(receipt);
        if (historyLine) {
          committedHistoryLines.push(historyLine);
          onCommittedUnit?.(historyLine);
        }
        return;
      }

      if (segment.kind === 'message-block') {
        activeUnitSendAttempted = true;
        const receipt = requireDeliveryReceipt(
          await sendWhole(createQuotedMessageContent(createMessageMessageContent(segment), quoteTargetMessageId)),
        );
        await confirmDeliveryUnit(receipt);
        hasConfirmedDelivery = true;
        onDeliveryReceipt?.(receipt);
        if (historyLine) {
          committedHistoryLines.push(historyLine);
          onCommittedUnit?.(historyLine);
        }
        return;
      }

      if (segment.kind === 'structured-block') {
        activeUnitSendAttempted = true;
        const receipt = requireDeliveryReceipt(
          await sendWhole(createQuotedMessageContent(h.text(segment.content), quoteTargetMessageId)),
        );
        await confirmDeliveryUnit(receipt);
        hasConfirmedDelivery = true;
        onDeliveryReceipt?.(receipt);
        if (historyLine) {
          committedHistoryLines.push(historyLine);
          onCommittedUnit?.(historyLine);
        }
        return;
      }

      if (segment.kind === 'sticker-block') {
        const prepared = preparedSticker.preparedByRaw.get(segment.raw);
        if (!prepared) {
          throw new Error('missing_prepared_sticker');
        }

        activeUnitSendAttempted = true;
        const receipt = requireDeliveryReceipt(
          await sendWhole(createQuotedMessageContent(h.image(prepared.buffer, prepared.mime), quoteTargetMessageId)),
        );
        await confirmDeliveryUnit(receipt);
        hasConfirmedDelivery = true;
        onDeliveryReceipt?.(receipt);
        deliveredModalities.add('sticker');
        onDeliveredModality?.('sticker');
        if (historyLine) {
          committedHistoryLines.push(historyLine);
          onCommittedUnit?.(historyLine);
        }
        return;
      }

      if (segment.kind === 'image-block') {
        activeUnitSendAttempted = true;
        const receipt = requireDeliveryReceipt(
          await sendWhole(createQuotedMessageContent(h.image(segment.assetRef), quoteTargetMessageId)),
        );
        await confirmDeliveryUnit(receipt);
        hasConfirmedDelivery = true;
        onDeliveryReceipt?.(receipt);
        if (historyLine) {
          committedHistoryLines.push(historyLine);
          onCommittedUnit?.(historyLine);
        }
        return;
      }

      const prepared = preparedVoice.preparedByRaw.get(segment.raw);
      if (!prepared) {
        throw new Error('missing_prepared_voice');
      }

      let receipt: DeliveryReceipt;
      try {
        activeUnitSendAttempted = true;
        receipt = requireDeliveryReceipt(await sendWhole(h.audio(createAudioDataUri(prepared.wav))));
      } catch (error) {
        if (
          error instanceof ReplyDeliveryReceiptError
          || !explicitVoiceRequested
          || isOneBotRpcTransportUnavailableError(error)
          || !isAuthoritativeOneBotActionRejection(error)
        ) {
          throw error;
        }
        const failure: VoiceOutputFailure = {
          code: 'voice_delivery_rpc',
          stage: 'delivery',
          operation: 'onebot.send_record',
          ...extractOneBotFailureDetails(error),
        };
        const failureText = formatVoiceOutputFailure(failure);
        logger.warn(
          'explicit voice delivery failed: operation=%s code=%s providerCode=%s httpStatus=%s error=%s',
          failure.operation,
          failure.code,
          failure.providerCode ?? '<none>',
          failure.httpStatus == null ? '<none>' : String(failure.httpStatus),
          (error as Error).message,
        );
        const fallbackUnit: ReplyDeliveryPlannedUnit = {
          index: plannedDeliveryUnit.index,
          kind: 'text-line',
          payload: { content: failureText },
          historyText: failureText,
          persistToHistory: true,
        };
        await onUnitReplanned?.(fallbackUnit);
        activeDeliveryUnit = fallbackUnit;
        activeUnitSendAttempted = true;
        const failureReceipt = await sendFailureReply(session, failureText);
        await confirmDeliveryUnit(failureReceipt, fallbackUnit);
        hasConfirmedDelivery = true;
        deliveryHistoryChanged = true;
        onDeliveryReceipt?.(failureReceipt);
        committedHistoryLines.push(failureText);
        onCommittedUnit?.(failureText);
        return;
      }
      await confirmDeliveryUnit(receipt);
      hasConfirmedDelivery = true;
      onDeliveryReceipt?.(receipt);
      deliveredModalities.add('voice');
      onDeliveredModality?.('voice');
      if (historyLine) {
        committedHistoryLines.push(historyLine);
        onCommittedUnit?.(historyLine);
      }
    }, {
      abortSignal: sendAbortSignal ?? undefined,
    });
  };

  try {
    if (queueKey) {
      await sendStrand.run(queueKey, sendTask);
    } else {
      await sendTask();
    }
  } catch (error) {
    let deliveryError = error;
    const committedHistoryText = committedHistoryLines.join('\n').trim();
    const blockedDeliveryUnit = readActiveDeliveryUnit();
    if (blockedDeliveryUnit && isOneBotContentBlockedError(deliveryError)) {
      const blockedFallbackText = buildContentBlockedFallbackText(session);
      const fallbackUnit: ReplyDeliveryPlannedUnit = {
        index: blockedDeliveryUnit.index,
        kind: 'text-line',
        payload: { content: blockedFallbackText },
        historyText: blockedFallbackText,
        persistToHistory: true,
      };
      try {
        await onUnitReplanned?.(fallbackUnit);
        activeDeliveryUnit = fallbackUnit;
        activeUnitSendAttempted = true;
        const fallbackReceipt = await sendFailureReply(session, blockedFallbackText);
        await onUnitConfirmed?.(fallbackUnit, fallbackReceipt);
        activeDeliveryUnit = null;
        onDeliveryReceipt?.(fallbackReceipt);
        onPlannedUnitHistoryLines?.([blockedFallbackText]);
        onCommittedUnit?.(blockedFallbackText);
        return resolveCompletedDelivery(blockedFallbackText);
      } catch (fallbackError) {
        deliveryError = fallbackError;
        logger.warn('content blocked reply replacement failed: %s', (fallbackError as Error).message);
      }
    }
    const unresolvedDeliveryUnit = readActiveDeliveryUnit();
    if (unresolvedDeliveryUnit) {
      const knownNotSent = !activeUnitSendAttempted || isOneBotRpcTransportUnavailableError(deliveryError);
      if (knownNotSent) {
        await onUnitNotSent?.(unresolvedDeliveryUnit, deliveryError);
      } else {
        hasUnknownDeliveryOutcome = true;
        await onUnitOutcomeUnknown?.(unresolvedDeliveryUnit, deliveryError);
      }
      activeDeliveryUnit = null;
      activeUnitSendAttempted = false;
    }
    const errorMessage = (deliveryError as Error).message;
    if (hasUnknownDeliveryOutcome) {
      logger.warn('reply plan delivery outcome is unknown: %s', errorMessage);
      return { status: 'outcome_unknown', historyText: committedHistoryText };
    }
    if (wasSendAborted() || wasInterrupted?.()) {
      return { status: 'interrupted', historyText: committedHistoryText };
    }
    if (deliveryError instanceof ReplyDeliveryReceiptError) {
      logger.warn('reply plan delivery receipt validation failed: %s', errorMessage);
      return hasConfirmedDelivery
        ? { status: 'failed_after_partial_send', historyText: committedHistoryText }
        : { status: 'failed_before_send', historyText: '' };
    }
    if (isOneBotRpcTransportUnavailableError(deliveryError)) {
      logger.warn('reply plan delivery skipped because onebot rpc transport is unavailable: %s', errorMessage);
      return hasConfirmedDelivery
        ? { status: 'failed_after_partial_send', historyText: committedHistoryText }
        : { status: 'transport_unavailable', historyText: committedHistoryText };
    }
    logger.warn('reply plan delivery failed: %s', errorMessage);
    if (hasConfirmedDelivery) {
      return { status: 'failed_after_partial_send', historyText: committedHistoryText };
    }
    return { status: 'failed_before_send', historyText: '' };
  }

  if ((beginSend && !sendAbortSignal) || wasSendAborted() || wasInterrupted?.()) {
    return { status: 'interrupted', historyText: committedHistoryLines.join('\n').trim() };
  }

  const finalHistoryText = deliveryHistoryChanged
    ? committedHistoryLines.join('\n').trim()
    : effectiveHistoryText;
  return resolveCompletedDelivery(finalHistoryText);
}

async function deliverReplyPlan(args: {
  runtime: RuntimeConfig;
  session: SessionWithVoiceState;
  stickerState: StickerCapabilityState | null;
  plan: ReplyTransportPlan;
  replyRuntime: ReplyRuntime;
  runId: string;
  deliveryCheckpointStore: ReplyDeliveryCheckpointStore;
  deliveryCheckpoint: ReplyDeliveryCheckpointRecord;
  onDeliveredModality?: (modality: 'sticker' | 'voice') => void;
  modalityPolicy: ModalityPolicySnapshot;
}): Promise<ReplyPlanDeliveryResult> {
  const {
    runtime,
    session,
    stickerState,
    plan,
    replyRuntime,
    runId,
    deliveryCheckpointStore,
    deliveryCheckpoint,
    onDeliveredModality,
    modalityPolicy,
  } = args;
  return deliverReplyPlanCore({
    runtime,
    session,
    stickerState,
    plan,
    queueKey: resolveReplyQueueKey(session),
    beginSend: () => {
      const signal = replyRuntime.beginSending(runId);
      if (!signal || !replyRuntime.isCurrentRun(runId)) {
        return null;
      }
      return signal;
    },
    wasInterrupted: () => replyRuntime.wasInterrupted(runId),
    resolveQuoteTargetMessageId: (supports) => replyRuntime.consumeFirstReplyQuote(runId, supports),
    onPlannedUnitHistoryLines: (historyLines) => replyRuntime.setPlannedUnitHistory(runId, historyLines),
    onCommittedUnit: (historyLine) => replyRuntime.recordCommittedUnit(runId, historyLine),
    onPlannedDeliveryUnits: async (units) => {
      return deliveryCheckpointStore.appendPlannedUnits(deliveryCheckpoint, units);
    },
    onUnitDispatching: async (unit) => {
      await deliveryCheckpointStore.beginUnit(deliveryCheckpoint, unit.index);
    },
    onUnitReplanned: async (unit) => {
      await deliveryCheckpointStore.replaceDispatchingUnit(deliveryCheckpoint, unit);
    },
    onUnitConfirmed: async (unit, receipt) => {
      await deliveryCheckpointStore.confirmUnit(deliveryCheckpoint, unit, receipt);
    },
    onUnitNotSent: async (_unit, error) => {
      await deliveryCheckpointStore.cancelDispatchingUnit(deliveryCheckpoint, error);
    },
    onUnitOutcomeUnknown: async (_unit, error) => {
      await deliveryCheckpointStore.markOutcomeUnknown(deliveryCheckpoint, error);
    },
    onDeliveredModality,
    modalityPolicy,
  });
}

export async function deliverStandaloneReplyPlan(args: {
  runtime: RuntimeConfig;
  session: SessionWithVoiceState;
  plan: ReplyTransportPlan;
  modalityPolicy: ModalityPolicySnapshot | null;
}): Promise<ReplyPlanDeliveryResult & {
  receipts: DeliveryReceipt[];
  deliveredModalities: Array<'sticker' | 'voice'>;
}> {
  const receipts: DeliveryReceipt[] = [];
  const deliveredModalities: Array<'sticker' | 'voice'> = [];
  const result = await deliverReplyPlanCore({
    runtime: args.runtime,
    session: args.session,
    stickerState: args.session.state?.qqSticker ?? null,
    plan: args.plan,
    queueKey: resolveReplyQueueKey(args.session),
    modalityPolicy: args.modalityPolicy,
    onDeliveredModality: (modality) => {
      deliveredModalities.push(modality);
    },
    onDeliveryReceipt: (receipt) => {
      receipts.push(receipt);
    },
  });
  return {
    ...result,
    receipts,
    deliveredModalities,
  };
}

function isReplyPlanSessionAvailable(session: Session): boolean {
  return session.platform === 'onebot' && Boolean(session.channelId);
}

export function apply(ctx: Context, config: Config = {}): void {
  const runtime = toRuntimeConfig(config);
  assertVoiceRuntimeConfig(runtime);
  const services = ctx as unknown as ReplyVoiceServicesLike;
  const featurePolicy = services.featurePolicy;
  if (!featurePolicy) {
    throw new Error('qq-voice requires featurePolicy service.');
  }
  const modelConfig = services.modelConfig;
  if (!modelConfig) {
    throw new Error('qq-voice requires modelConfig service.');
  }
  const naturalTriggerConfig = services.naturalTriggerConfig;
  if (!naturalTriggerConfig) {
    throw new Error('qq-voice requires naturalTriggerConfig service.');
  }
  if (!services.toolPolicy) {
    throw new Error('qq-voice requires toolPolicy service.');
  }
  registerModalityPreferenceTable(ctx.model);
  registerReplyDeliveryCheckpointTable(ctx.model);
  const resolveMainModelTarget = (): ResolvedModelTarget => {
    const resolved = new CanonicalModelBindingResolver(
      modelConfig.getRuntimeSnapshot(),
    ).resolve('main.chat');
    if (!resolved.target) {
      throw new Error('main.chat binding must resolve to a model target.');
    }
    return resolved.target;
  };
  const replyOrchestrator = new ReplyOrchestratorService();
  const replyCapabilitySnapshots = new Map<string, ReplyCapabilitySnapshot>();
  let initialTtsProbeTimer: NodeJS.Timeout | null = null;

  const resolveChatLunaService = (): ChatLunaLike | undefined => {
    const byGetter = typeof (ctx as { get?: (name: string) => unknown }).get === 'function'
      ? ((ctx as { get: (name: string) => unknown }).get('chatluna') as ChatLunaLike | undefined)
      : undefined;
    return byGetter ?? services.chatluna;
  };

  const resolveVoiceFeatureState = async (session: SessionWithVoiceState): Promise<{
    inputEnabled: boolean;
    outputEnabled: boolean;
  }> => {
    const [inputEnabled, outputEnabled] = await Promise.all([
      featurePolicy.resolveFeatureEnabled(session, 'QQ_VOICE_INPUT_ENABLED'),
      featurePolicy.resolveFeatureEnabled(session, 'QQ_VOICE_OUTPUT_ENABLED'),
    ]);

    return {
      inputEnabled,
      outputEnabled,
    };
  };

  const resolveReplyRunMode = async (session: SessionWithVoiceState): Promise<ReplyRunMode> => {
    const replyInterruptEnabled = await featurePolicy.resolveFeatureEnabled(
      session,
      'QQBOT_REPLY_INTERRUPT_ENABLED',
    );
    return replyInterruptEnabled ? 'interrupt' : 'queue';
  };

  const replyRuntime = new ReplyRuntime({
    drainOutbound: async (queueKey) => {
      await sharedReplyTransportSendStrand.run(queueKey, async () => undefined);
    },
    collectWindowMs: runtime.replyInterruptCollectWindowMs,
    maxPendingInputs: runtime.replyInterruptMaxPendingInputs,
  });
  const modalityDirector = new ModalityDirector();
  const modalityTurnContexts = new Map<string, {
    policy: ModalityPolicySnapshot;
    stickerState: StickerCapabilityState | null;
  }>();
  const modalityPreferenceStore = new ModalityPreferenceStore(
    services.database as StructuredReplyHistoryDatabaseLike & ModalityPreferenceDatabase,
  );
  const replyDeliveryCheckpointStore = new ReplyDeliveryCheckpointStore(
    services.database as StructuredReplyHistoryDatabaseLike & ReplyDeliveryCheckpointDatabase,
  );
  const replyDeliveryCheckpointByRunId = new Map<string, ReplyDeliveryCheckpointRecord>();
  const replyDeliveryCheckpointStrand = createKeyedStrandRunner();
  const activeReplyDeliveryByConversation = new Map<string, {
    runId: string;
    settled: Promise<void>;
    release: () => void;
  }>();
  const artifactRegistry = new ReplyArtifactRegistry();
  let progressCallbacksController: AgentProgressCallbacksProvider | null = null;

  const recoverPersistedReplyDeliveries = async (
    conversationId?: string,
  ) => {
    const normalizeHistory = requireReplyHistoryNormalizer(resolveChatLunaService());
    return recoverReplyDeliveryCheckpoints({
      store: replyDeliveryCheckpointStore,
      conversationId,
      reconcileHistory: async (input) => {
        const result = await normalizeHistory({
          conversationId: input.conversationId,
          requestId: input.requestId,
          requestDisposition: input.requestDisposition,
        }, input.confirmedVisibleText);
        const requestBoundaryFound = (
          result != null
          && typeof result === 'object'
          && 'requestBoundaryFound' in result
        ) ? (result as { requestBoundaryFound?: unknown }).requestBoundaryFound : undefined;
        if (typeof requestBoundaryFound !== 'boolean') {
          throw new Error('reply delivery recovery requires an explicit requestBoundaryFound result.');
        }
        return { requestBoundaryFound };
      },
    });
  };

  const beginReplyDeliveryCheckpoint = async (
    session: SessionWithVoiceState,
    runId: string,
    conversationId: string,
  ): Promise<ReplyDeliveryCheckpointRecord> => {
    return replyDeliveryCheckpointStrand.run(conversationId, async () => {
      const active = activeReplyDeliveryByConversation.get(conversationId);
      if (active) await active.settled;

      await recoverPersistedReplyDeliveries(conversationId);
      const checkpoint = await replyDeliveryCheckpointStore.beginRequest(runId, conversationId);
      let release: () => void = () => {};
      const settled = new Promise<void>((resolve) => {
        release = resolve;
      });
      activeReplyDeliveryByConversation.set(conversationId, { runId, settled, release });
      replyDeliveryCheckpointByRunId.set(runId, checkpoint);
      setReplyRequestBoundaryPersistedHandler(session, async () => {
        await replyDeliveryCheckpointStore.markRequestBoundaryPersisted(checkpoint);
      });
      return checkpoint;
    });
  };

  const requireReplyDeliveryCheckpoint = (runId: string): ReplyDeliveryCheckpointRecord => {
    const checkpoint = replyDeliveryCheckpointByRunId.get(runId);
    if (!checkpoint) {
      throw new Error(`reply delivery checkpoint is missing for ${runId}.`);
    }
    return checkpoint;
  };

  const reconcileReplyDeliveryHistory = async (
    room: Record<string, unknown> | undefined,
    runId: string,
    visibleHistoryText: string,
    requestDisposition: 'retain_request' | 'drop_request' = 'retain_request',
    allowMissingBoundary = false,
  ): Promise<void> => {
    const checkpoint = requireReplyDeliveryCheckpoint(runId);
    await replyDeliveryCheckpointStore.beginReconciliation(
      checkpoint,
      requestDisposition,
      visibleHistoryText,
    );
    await normalizeResearchReplyHistory(
      ctx,
      room,
      runId,
      visibleHistoryText,
      requestDisposition,
      allowMissingBoundary,
    );
    await replyDeliveryCheckpointStore.markReconciled(checkpoint);
    await replyDeliveryCheckpointStore.pruneReconciledDiagnostics({
      maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
      maxRecords: 256,
    });
  };

  const finishReplyRun = (
    session: SessionWithVoiceState,
    runId: string,
    requestSettlementError?: unknown,
  ): boolean => {
    progressCallbacksController?.disposeRun(runId);
    modalityDirector.finishTurn(runId);
    modalityTurnContexts.delete(runId);
    replyFinalizerRequestRegistry.finish(runId);
    artifactRegistry.finishRun(runId);
    setReplyRequestModelErrorHandler(session, undefined);
    setReplyRequestBoundaryPersistedHandler(session, undefined);
    const deliveryCheckpoint = replyDeliveryCheckpointByRunId.get(runId);
    replyDeliveryCheckpointByRunId.delete(runId);
    const deliveryConversationId = deliveryCheckpoint?.conversationId ?? '';
    const deliveryGate = activeReplyDeliveryByConversation.get(deliveryConversationId);
    if (deliveryConversationId && deliveryGate?.runId === runId) {
      activeReplyDeliveryByConversation.delete(deliveryConversationId);
      deliveryGate.release();
    }
    if (getReplyRunId(session) === runId) clearReplyRunId(session);
    return replyRuntime.finishRun(runId, requestSettlementError) != null;
  };

  const beginModalityTurn = async (args: {
    session: SessionWithVoiceState;
    runId: string;
    conversationId: string;
    turnInput: TurnInput;
    capability: ReplyCapabilitySnapshot;
  }): Promise<{ policy: ModalityPolicySnapshot; stickerState: StickerCapabilityState | null }> => {
    const active = modalityTurnContexts.get(args.runId);
    if (active) return active;

    const stickerState = args.session.state?.qqSticker ?? null;
    const stickerAvailableCount = stickerState?.availableCount ?? 0;
    const preference = await modalityPreferenceStore.resolveForTurn({
      platform: args.session.platform,
      botSelfId: String(args.session.bot?.selfId ?? '').trim(),
      userId: String(args.session.userId ?? '').trim(),
      conversationId: args.conversationId,
    }, args.turnInput.text);
    const policy = modalityDirector.beginTurn({
      turnId: args.runId,
      conversationKey: args.conversationId,
      input: args.turnInput,
      transport: {
        canVoice: args.capability.canVoice,
        canSticker: stickerAvailableCount > 0,
        stickerAvailableCount,
      },
      preference,
    });
    const context = { policy, stickerState };
    modalityTurnContexts.set(args.runId, context);
    replyFinalizerRequestRegistry.begin(args.runId, {
      canVoice: policy.canVoice || policy.voiceReason === 'explicit_request',
      canMeme: policy.canSticker || policy.stickerReason === 'explicit_request',
      explicitVoiceRequested: policy.voiceReason === 'explicit_request',
      explicitMemeRequested: policy.stickerReason === 'explicit_request',
      hasImageAssetRef: (assetRef) => artifactRegistry.list(args.runId).includes(assetRef),
    });
    return context;
  };

  let progressCallbacksDispose: (() => void) | null = null;
  const ensureProgressCallbacksRegistered = (): boolean => {
    if (progressCallbacksDispose) return true;
    const chatluna = resolveChatLunaService();
    if (!chatluna) return false;
    if (typeof chatluna.registerAgentEventProvider !== 'function') {
      throw new Error('reply progress requires chatluna.registerAgentEventProvider.');
    }
    const controller = createAgentProgressCallbacksProvider({
      resolveReplyRunId: (rawSession, requestId) => {
        const sessionRunId = getReplyRunId(rawSession as SessionWithVoiceState);
        if (sessionRunId) return sessionRunId;
        return replyRuntime.getRun(requestId) ? requestId : undefined;
      },
      resolveInitialState: (replyRunId) => {
        const state = replyRuntime.getProgressState(replyRunId);
        if (!state) {
          throw new Error(`reply progress state is unavailable for run ${replyRunId}.`);
        }
        return {
          messageCount: state.visibleLines.length,
          lastMessageAt: state.lastSentAt ?? 0,
        };
      },
      send: async ({ session: rawSession, replyRunId, text }) => {
        const session = rawSession as SessionWithVoiceState;
        const run = replyRuntime.getRun(replyRunId);
        if (!run) return false;
        return sharedReplyTransportSendStrand.run(run.queueKey, async () => {
          const current = replyRuntime.getRun(replyRunId);
          if (!current || current.state !== 'computing' || !replyRuntime.isCurrentRun(replyRunId)) {
            return false;
          }
          const checkpoint = requireReplyDeliveryCheckpoint(replyRunId);
          const [unit] = await replyDeliveryCheckpointStore.appendPlannedUnits(checkpoint, [{
            index: 0,
            kind: 'progress',
            payload: { content: text },
            historyText: text,
            persistToHistory: false,
          }]);
          await replyDeliveryCheckpointStore.beginUnit(checkpoint, unit.index);
          let receipt: DeliveryReceipt;
          try {
            receipt = requireDeliveryReceipt(await session.send(text));
          } catch (error) {
            await replyDeliveryCheckpointStore.markOutcomeUnknown(checkpoint, error);
            throw error;
          }
          await replyDeliveryCheckpointStore.confirmUnit(checkpoint, unit, receipt);
          if (!replyRuntime.recordProgressVisibleLine(replyRunId, text)) {
            throw new Error(`reply progress run ${replyRunId} ended before delivery was recorded.`);
          }
          return true;
        });
      },
      onAgentEvent: ({ replyRunId, event }) => {
        if (event.type !== 'tool-result') return;
        for (const step of event.steps) {
          artifactRegistry.registerObservation(replyRunId, step.action.tool, step.observation);
        }
      },
      onSendError: (error) => {
        logger.warn('agent progress message delivery failed: %s', (error as Error).message);
      },
    });
    const callbacksByRequestId = new Map<
      string,
      NonNullable<ReturnType<ChatCallbacksProviderLike>>
    >();
    const unregister = chatluna.registerAgentEventProvider(async (input) => {
      let callbacks = callbacksByRequestId.get(input.requestId);
      if (!callbacks) {
        callbacks = controller({
          session: input.session,
          conversation: input.conversation,
          requestId: input.requestId,
        });
        if (!callbacks) return;
        callbacksByRequestId.set(input.requestId, callbacks);
      }
      const terminal = input.event.type === 'done' || input.event.type === 'human-update';
      try {
        await callbacks.handleCustomEvent?.('chatluna-agent-event', {
          context: { kind: 'main', requestId: input.requestId },
          event: input.event,
        }, input.requestId);
      } finally {
        if (terminal) callbacksByRequestId.delete(input.requestId);
      }
    });
    progressCallbacksController = controller;
    progressCallbacksDispose = () => {
      unregister();
      callbacksByRequestId.clear();
      controller.dispose();
      if (progressCallbacksController === controller) progressCallbacksController = null;
    };
    return true;
  };

  ctx.middleware(
    async (rawSession, next) => {
      const session = rawSession as SessionWithVoiceState;
      if (session.platform !== 'onebot') return next();
      if (!session.userId || session.userId === session.bot?.selfId) return next();
      if (!session.content || !extractFirstIncomingVoice(session.content)) return next();
      const voiceFeatureState = await resolveVoiceFeatureState(session);
      const admitted = await shouldHandleIncomingVoiceInput({
        runtime,
        naturalTriggerConfig,
        session,
        voiceFeatureState,
      });
      if (!admitted) return next();

      const bot = session.bot as OneBotBotLike;
      try {
        const downloaded = await downloadIncomingAudio(session, runtime, bot);
        const transcript = await transcribeAudio(runtime, downloaded);

        if (!transcript.text) {
          await sendFailureReply(session, buildVoiceFailureReply('empty', runtime.inputMaxSeconds));
          return;
        }

        if (transcript.durationMs > runtime.inputMaxSeconds * 1000) {
          await sendFailureReply(session, buildVoiceFailureReply('too-long', runtime.inputMaxSeconds));
          return;
        }

        const originalText = getTextInputContent(session);
        const merged = mergeVoiceInputText(originalText, transcript.text);
        updateVoiceState(session, {
          transcript: transcript.text,
          durationMs: transcript.durationMs,
          source: downloaded.source,
        });

        session.content = merged;
        return next();
      } catch (error) {
        logger.warn('voice input handling failed: %s', (error as Error).message);
        await sendFailureReply(session, buildVoiceFailureReply('broken', runtime.inputMaxSeconds));
        return;
      }
    },
    true,
  );

  ctx.middleware(
    async (rawSession, next) => {
      const session = rawSession as SessionWithVoiceState;
      if (!isReplyPlanSessionAvailable(session)) return next();
      if (!session.userId || session.userId === session.bot?.selfId) return next();
      const voiceFeatureState = await resolveVoiceFeatureState(session);

      const snapshot = await resolveReplyCapabilitySnapshot({
        runtime,
        session,
        voiceOutputEnabled: voiceFeatureState.outputEnabled,
        requireFreshVoiceCapability: isExplicitVoiceRequest(getTextInputContent(session)),
      });
      rememberReplyCapabilitySnapshot(session, snapshot, replyCapabilitySnapshots);
      return next();
    },
    true,
  );

  let replyRuntimeMiddlewaresRegistered = false;

  const ensureReplyRuntimeMiddlewaresRegistered = (): boolean => {
    if (replyRuntimeMiddlewaresRegistered) return true;
    const chatluna = resolveChatLunaService();
    const chain = chatluna?.chatChain as ChatLunaChainLike | undefined;
    if (!chatluna || !chain?.middleware) {
      return false;
    }
    if (!chatluna.contextManager) {
      throw new Error('reply runtime requires chatluna.contextManager.');
    }
    requireReplyHistoryNormalizer(chatluna);

    const prepareBuilder = chain.middleware('qqbot_reply_runtime_prepare', async (rawSession, rawContext) => {
        const session = rawSession as SessionWithVoiceState;
        const context = rawContext as MiddlewareContextLike;
        if (!isReplyPlanSessionAvailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }
        suppressReplyErrorNotice(session);

        const room = resolveChatLunaRoomLike(context.options) as ReplyRuntimeRoomLike | undefined;
        const conversationId = room?.conversationId?.trim();
        const queueKey = resolveReplyQueueKey(session);
        const actorKey = resolveReplyActorKey(session);
        if (!room || !conversationId || !queueKey || !actorKey) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }
        ensureReplyPluginRoom(room);
        ensureSupportedStructuredReplyModel(resolveMainModelTarget());
        const turnInput = buildReplyTurnInput(session, room, context.options?.inputMessage);
        applyReplyTurnInputMetadata(context.options?.inputMessage, turnInput);
        const routeHint = normalizeReplyRouteHint(normalizeReplyChatMode((room as { chatMode?: unknown }).chatMode));
        const orchestration = await replyOrchestrator.handle(turnInput, session, {
          routeHint,
        });
        setReplyRouteState(session, orchestration.route);
        if (orchestration.status === 'no_reply') {
          return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
        }

        const runMode = await resolveReplyRunMode(session);
        const runId = `qqreply:${randomUUID()}`;
        const prepared = await replyRuntime.prepareRun({
          runId,
          queueKey,
          actorKey,
          conversationId,
          room,
          mode: runMode,
          input: turnInput,
        });
        if (prepared.action === 'stop') {
          return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
        }
        try {
          if (!prepared.run) {
            throw new Error('reply runtime prepare returned continue without a run.');
          }
          await beginReplyDeliveryCheckpoint(session, runId, conversationId);
          applyPreparedTurnInput(session, context, prepared.run.input, prepared.inputTextSpeakerTagged);
          applyReplyTurnInputMetadata(context.options?.inputMessage, prepared.run.input);
          beginPromptAssemblyTurn(conversationId, { turnId: runId });
          registerReplyTurnStateFragment(conversationId, prepared.continuationContext);
          setReplyRunId(session, runId);
          registerReplyRunRequestModelGuard({
            session,
            runId,
            conversationId,
            finishRun: (error) => finishReplyRun(session, runId, error),
            normalizeHistory: (visibleText, disposition, allowMissingBoundary) => reconcileReplyDeliveryHistory(
              room,
              runId,
              visibleText,
              disposition,
              allowMissingBoundary,
            ),
          });
          if (context.options) {
            const requestSignal = replyRuntime.getRequestSignal(runId);
            if (!requestSignal) {
              throw new Error(`reply runtime has no request signal for run ${runId}.`);
            }
            context.options.messageId = runId;
            context.options.requestSignal = requestSignal;
          }
        } catch (error) {
          finishReplyRun(session, runId);
          throw error;
        }
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      }) as ChatLunaChainBuilderLike;
    prepareBuilder.after('read_chat_message');
    prepareBuilder.after('resolve_conversation');
    prepareBuilder.after('chatluna_model_guard');
    prepareBuilder.before('message_delay');
    prepareBuilder.before('qqbot_turn_context');
    prepareBuilder.before('qqbot_memory');
    prepareBuilder.before('qqbot_reply_transport_policy');

    const policyBuilder = chain.middleware('qqbot_reply_transport_policy', async (rawSession, rawContext) => {
        const session = rawSession as SessionWithVoiceState;
        const context = rawContext as MiddlewareContextLike;
        if (!isReplyPlanSessionAvailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const room = resolveChatLunaRoomLike(context.options);
        const conversationId = room?.conversationId;
        if (!conversationId || !room) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (getReplyRouteState(session) !== 'agent') {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }
        const runId = getReplyRunId(session);
        try {
          suppressReplyErrorNotice(session);
          const voiceFeatureState = await resolveVoiceFeatureState(session);

          const snapshot =
            getAuthorizedReplyCapabilitySnapshot(session, replyCapabilitySnapshots) ??
            (await resolveReplyCapabilitySnapshot({
              runtime,
              session,
              voiceOutputEnabled: voiceFeatureState.outputEnabled,
              requireFreshVoiceCapability: isExplicitVoiceRequest(getTextInputContent(session)),
            }));
          rememberReplyCapabilitySnapshot(session, snapshot, replyCapabilitySnapshots);
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        } catch (error) {
          if (runId) finishReplyRun(session, runId);
          throw error;
        }
      }) as ChatLunaChainBuilderLike;
    policyBuilder.after('qqbot_turn_context');
    policyBuilder.after('qqbot_memory');
    policyBuilder.after('qqbot_sticker_policy');
    policyBuilder.before('lifecycle-handle_command');

    const promptCompilerBuilder = chain.middleware('qqbot_reply_prompt_compiler', async (rawSession, rawContext) => {
        const session = rawSession as SessionWithVoiceState;
        const context = rawContext as MiddlewareContextLike;
        if (!isReplyPlanSessionAvailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const route = getReplyRouteState(session);
        if (route !== 'agent') {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const room = resolveChatLunaRoomLike(context.options) as ReplyRuntimeRoomLike | undefined;
        const conversationId = room?.conversationId?.trim();
        const chatlunaService = resolveChatLunaService();
        if (!room || !conversationId || !chatlunaService) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }
        const runId = getReplyRunId(session);
        if (!runId) {
          throw new Error('reply prompt compiler requires an active reply run.');
        }
        try {
          ensureReplyPluginRoom(room);
          const mainModelTarget = resolveMainModelTarget();
          ensureSupportedStructuredReplyModel(mainModelTarget);

          const capability = getAuthorizedReplyCapabilitySnapshot(session, replyCapabilitySnapshots);
          if (!capability) {
            throw new Error('reply prompt compiler requires an authorized transport capability snapshot.');
          }
          const turnInput = buildReplyTurnInput(session, room, context.options?.inputMessage);
          applyReplyTurnInputMetadata(context.options?.inputMessage, turnInput);
          const { policy: modalityPolicy, stickerState } = await beginModalityTurn({
            session,
            runId,
            conversationId,
            turnInput,
            capability,
          });
          const turnCapabilitySnapshot = buildTurnCapabilitySnapshot(
            session,
            capability,
            modalityPolicy,
            stickerState,
            artifactRegistry.list(runId),
          );
          const schemaCapabilitySnapshot = {
            canMention: canSessionUseMention(session),
            canVoice: turnCapabilitySnapshot.canVoice,
            voiceOutputLanguage: runtime.voiceOutputLanguage,
            canSticker: turnCapabilitySnapshot.canSticker,
            stickerIntentHints: turnCapabilitySnapshot.stickerIntentHints ?? [],
          };
          const replyOutputContract = buildModelReplyOutputContract({
            canonicalModel: mainModelTarget.canonicalModel,
            model: mainModelTarget.model,
            canVoice: schemaCapabilitySnapshot.canVoice,
            canMeme: schemaCapabilitySnapshot.canSticker,
            stickerIntentHints: schemaCapabilitySnapshot.stickerIntentHints,
            voiceOutputLanguage: schemaCapabilitySnapshot.voiceOutputLanguage,
          });
          injectReplyPromptEnvelope({
            chatluna: chatlunaService,
            conversationId,
            turnContext: {
              input: turnInput,
              policySnapshot: {
                route,
                toolRouteProfile: route,
              },
              capabilitySnapshot: turnCapabilitySnapshot,
              continuationContext: null,
            },
            outputProtocol: replyOutputContract.protocol,
          });
          applyReplyOutputContract(context.options?.inputMessage, {
            modelTarget: mainModelTarget,
            capabilitySnapshot: schemaCapabilitySnapshot,
            replyOutputContract,
          });
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        } catch (error) {
          finishReplyRun(session, runId);
          throw error;
        }
      }) as ChatLunaChainBuilderLike;
    promptCompilerBuilder.after('qqbot_reply_transport_policy');
    promptCompilerBuilder.after('qqbot_turn_context');
    promptCompilerBuilder.after('qqbot_memory');
    promptCompilerBuilder.after('qqbot_sticker_policy');
    promptCompilerBuilder.before('qqbot_prompt_envelope');
    promptCompilerBuilder.before('lifecycle-handle_command');

    const requestGuardBuilder = chain.middleware('qqbot_reply_request_guard', async (rawSession, rawContext) => {
        const session = rawSession as SessionWithVoiceState;
        const context = rawContext as MiddlewareContextLike;
        if (!isReplyPlanSessionAvailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (getReplyRouteState(session) !== 'agent') return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        const runId = getReplyRunId(session);
        if (!runId) {
          throw new Error('reply request guard requires an active reply run.');
        }
        if (replyRuntime.isCurrentRun(runId)) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }
        if (context.options) context.options.responseMessage = null;
        finishReplyRun(session, runId);
        return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
      }) as ChatLunaChainBuilderLike;
    requestGuardBuilder.after('qqbot_reply_prompt_compiler');
    requestGuardBuilder.before('lifecycle-request_conversation');

    const executorBuilder = chain.middleware('qqbot_reply_plan_executor', async (rawSession, rawContext) => {
        const session = rawSession as SessionWithVoiceState;
        const context = rawContext as MiddlewareContextLike;
        if (!isReplyPlanSessionAvailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }
        suppressReplyErrorNotice(session);

        const responseMessage = context.options?.responseMessage;
        if (!responseMessage) {
          const unfinishedRunId = getReplyRunId(session);
          if (unfinishedRunId) {
            const unfinishedRoom = resolveChatLunaRoomLike(context.options) as ReplyRuntimeRoomLike | undefined;
            try {
              await reconcileReplyDeliveryHistory(unfinishedRoom, unfinishedRunId, '');
              finishReplyRun(session, unfinishedRunId);
            } catch (error) {
              finishReplyRun(session, unfinishedRunId, error);
              throw error;
            }
          }
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }
        let runId = getReplyRunId(session);
        let room: ReplyRuntimeRoomLike | undefined;
        let conversationId: string | undefined;
        let runMode: ReplyRunMode;
        try {
          room = resolveChatLunaRoomLike(context.options) as ReplyRuntimeRoomLike | undefined;
          conversationId = room?.conversationId?.trim();
          ensureReplyPluginRoom(room);
          ensureSupportedStructuredReplyModel(resolveMainModelTarget());
          runMode = await resolveReplyRunMode(session);
          if (!runId) {
            const queueKey = resolveReplyQueueKey(session);
            const actorKey = resolveReplyActorKey(session);
            if (!room || !conversationId || !queueKey || !actorKey) {
              if (context.options) {
                context.options.responseMessage = null;
              }
              return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
            }
            runId = `qqreply:${randomUUID()}`;
            const prepared = await replyRuntime.prepareRun({
              runId,
              queueKey,
              actorKey,
              conversationId,
              room,
              mode: runMode,
              input: buildReplyTurnInput(session, room, context.options?.inputMessage),
            });
            if (prepared.action === 'stop') {
              if (context.options) {
                context.options.responseMessage = null;
              }
              return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
            }
            if (!prepared.run) {
              throw new Error('reply runtime executor prepare returned continue without a run.');
            }
            await beginReplyDeliveryCheckpoint(session, runId, conversationId);
            applyPreparedTurnInput(session, context, prepared.run.input, prepared.inputTextSpeakerTagged);
            applyReplyTurnInputMetadata(context.options?.inputMessage, prepared.run.input);
            setReplyRunId(session, runId);
            const guardedRunId = runId;
            registerReplyRunRequestModelGuard({
              session,
              runId: guardedRunId,
              conversationId,
              finishRun: (error) => finishReplyRun(session, guardedRunId, error),
              normalizeHistory: (visibleText, disposition, allowMissingBoundary) => reconcileReplyDeliveryHistory(
                room,
                guardedRunId,
                visibleText,
                disposition,
                allowMissingBoundary,
              ),
            });
          }
        } catch (error) {
          if (runId) finishReplyRun(session, runId);
          throw error;
        }
        if (!replyRuntime.isCurrentRun(runId)) {
          if (context.options) {
            context.options.responseMessage = null;
          }
          try {
            await reconcileReplyDeliveryHistory(room, runId, '', 'drop_request');
            finishReplyRun(session, runId);
          } catch (error) {
            finishReplyRun(session, runId, error);
            throw error;
          }
          return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
        }

        let executorError: unknown;
        try {
          const turnInput = buildReplyTurnInput(session, room, context.options?.inputMessage);
          applyReplyTurnInputMetadata(context.options?.inputMessage, turnInput);
          const routeHint = normalizeReplyRouteHint(normalizeReplyChatMode((room as { chatMode?: unknown }).chatMode));
          const voiceFeatureState = await resolveVoiceFeatureState(session);
          const queueKey = resolveReplyQueueKey(session);
          const actorKey = resolveReplyActorKey(session);

          const snapshot =
            getAuthorizedReplyCapabilitySnapshot(session, replyCapabilitySnapshots) ??
            (await resolveReplyCapabilitySnapshot({
              runtime,
              session,
              voiceOutputEnabled: voiceFeatureState.outputEnabled,
              requireFreshVoiceCapability: isExplicitVoiceRequest(turnInput.text),
            }));
          rememberReplyCapabilitySnapshot(session, snapshot, replyCapabilitySnapshots);
          if (!conversationId) {
            throw new Error('reply plan executor requires conversationId.');
          }
          const { policy: modalityPolicy, stickerState } = await beginModalityTurn({
            session,
            runId,
            conversationId,
            turnInput,
            capability: snapshot,
          });
          const turnCapabilitySnapshot = buildTurnCapabilitySnapshot(
            session,
            snapshot,
            modalityPolicy,
            stickerState,
            artifactRegistry.list(runId),
          );
          const outputProtocol = resolveReplyOutputProtocolFromMessage(context.options?.inputMessage);
          let orchestration;
          try {
            orchestration = await replyOrchestrator.handle(turnInput, session, {
              responseMessage,
              outputProtocol,
              capabilitySnapshot: turnCapabilitySnapshot,
              continuationContext: null,
              routeHint,
            });
          } catch (error) {
            if (!(error instanceof StructuredReplyCompilerError || error instanceof StructuredReplyEmptyModelOutputError)) {
              throw error;
            }
            const diagnostic = error.diagnostic;
            logger.error(
              'reply plan executor suppressed structured model failure: runId=%s conversationId=%s messageId=%s queueKey=%s actorKey=%s failureKind=%s requestMode=%s providerOutputTokens=%s toolCallCount=%s toolCallChunkCount=%s functionCallPresent=%s rawOutputKind=%s rawTextLength=%s outputProtocol=%s protocolErrorCode=%s protocolErrorLine=%s rawTextPreview=%j',
              runId,
              conversationId ?? '<unknown>',
              String(session.messageId ?? '<unknown>'),
              queueKey ?? '<unknown>',
              actorKey ?? '<unknown>',
              diagnostic.failureKind,
              diagnostic.requestMode ?? '<unknown>',
              diagnostic.providerOutputTokens == null ? '<unknown>' : String(diagnostic.providerOutputTokens),
              String(diagnostic.messageToolCallCount),
              String(diagnostic.toolCallChunkCount),
              diagnostic.functionCallPresent ? 'true' : 'false',
              diagnostic.rawOutputKind,
              String(diagnostic.rawTextLength),
              diagnostic.outputProtocol,
              diagnostic.protocolErrorCode ?? '<none>',
              diagnostic.protocolErrorLine == null ? '<none>' : String(diagnostic.protocolErrorLine),
              diagnostic.rawTextPreview,
            );
            const progressClosed = await closeVisibleProgress({
              session,
              replyRuntime,
              runId,
              deliveryCheckpointStore: replyDeliveryCheckpointStore,
              deliveryCheckpoint: requireReplyDeliveryCheckpoint(runId),
              message: '刚才没整理好，麻烦你再问我一次。',
              normalizeHistory: (visibleText) => reconcileReplyDeliveryHistory(room, runId, visibleText),
            });
            if (!progressClosed) {
              await reconcileReplyDeliveryHistory(room, runId, '');
            }
            if (context.options) {
              context.options.responseMessage = null;
            }
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }

          try {
            if (orchestration.status === 'no_reply' || orchestration.status === 'ready') {
              assertExplicitModalityInvariant(modalityPolicy, {
                stage: 'orchestration',
                reply: orchestration.status === 'ready' ? orchestration.reply : null,
              });
            }
          } catch (error) {
            if (!(error instanceof ExplicitModalityInvariantError)) throw error;
            await closeExplicitModalityInvariantFailure({
              session,
              replyRuntime,
              runId,
              deliveryCheckpointStore: replyDeliveryCheckpointStore,
              deliveryCheckpoint: requireReplyDeliveryCheckpoint(runId),
              failure: error,
              capability: snapshot,
              stickerState,
              normalizeHistory: (visibleText) => reconcileReplyDeliveryHistory(room, runId, visibleText),
            });
            if (context.options) context.options.responseMessage = null;
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }

          if (orchestration.status === 'no_reply') {
            const progressClosed = await closeVisibleProgress({
              session,
              replyRuntime,
              runId,
              deliveryCheckpointStore: replyDeliveryCheckpointStore,
              deliveryCheckpoint: requireReplyDeliveryCheckpoint(runId),
              message: '我看完了，暂时没找到合适的答案。',
              normalizeHistory: (visibleText) => reconcileReplyDeliveryHistory(room, runId, visibleText),
            });
            if (!progressClosed) {
              await reconcileReplyDeliveryHistory(room, runId, '');
            }
            if (context.options) {
              context.options.responseMessage = null;
            }
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }
          if (orchestration.status !== 'ready') {
            throw new Error(`reply v2 orchestrator expected ready status, got ${orchestration.status}.`);
          }
          if (orchestration.actions.length === 1 && orchestration.actions[0]?.kind === 'no_reply') {
            const progressClosed = await closeVisibleProgress({
              session,
              replyRuntime,
              runId,
              deliveryCheckpointStore: replyDeliveryCheckpointStore,
              deliveryCheckpoint: requireReplyDeliveryCheckpoint(runId),
              message: '我看完了，暂时没找到合适的答案。',
              normalizeHistory: (visibleText) => reconcileReplyDeliveryHistory(room, runId, visibleText),
            });
            if (!progressClosed) {
              await reconcileReplyDeliveryHistory(room, runId, '');
            }
            if (context.options) {
              context.options.responseMessage = null;
            }
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }

          const plannedTransport = buildReplyTransportPlanFromResolvedActions(orchestration.actions);
          const executablePlan = modalityPolicy.voiceReason === 'explicit_request' && !snapshot.canVoice
            ? replaceRequestedVoiceWithFailure(
                plannedTransport,
                snapshot.voiceFailure ?? {
                  code: 'tts_health_pending',
                  stage: 'health_probe',
                  operation: 'tts.healthz',
                },
                !isExclusiveVoiceRequest(turnInput.text),
              )
            : plannedTransport;
          replyRuntime.setPlannedUnitHistory(runId, buildOptimisticPlannedUnitHistoryLines(executablePlan));
          if (!replyRuntime.completeCompute(runId)) {
            if (context.options) {
              context.options.responseMessage = null;
            }
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }

          const result = await deliverReplyPlan({
            runtime,
            session,
            stickerState,
            plan: executablePlan,
            replyRuntime,
            runId,
            deliveryCheckpointStore: replyDeliveryCheckpointStore,
            deliveryCheckpoint: requireReplyDeliveryCheckpoint(runId),
            onDeliveredModality: (modality) => modalityDirector.recordDelivered(runId, modality),
            modalityPolicy,
          });

          if (result.status === 'failed_semantic' && !result.historyText) {
            await closeExplicitModalityInvariantFailure({
              session,
              replyRuntime,
              runId,
              deliveryCheckpointStore: replyDeliveryCheckpointStore,
              deliveryCheckpoint: requireReplyDeliveryCheckpoint(runId),
              failure: result.semanticFailure,
              capability: snapshot,
              stickerState,
              normalizeHistory: (visibleText) => reconcileReplyDeliveryHistory(room, runId, visibleText),
            });
            if (context.options) context.options.responseMessage = null;
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }

          if (result.status === 'failed_before_send' || result.status === 'transport_unavailable') {
            if (context.options) {
              context.options.responseMessage = null;
            }
          } else if (context.options) {
            context.options.responseMessage = null;
          }

          const visibleHistoryText = result.status === 'transport_unavailable'
            ? ''
            : buildTextOnlyAssistantHistoryText(result.historyText, outputProtocol);
          await reconcileReplyDeliveryHistory(room, runId, visibleHistoryText);

          if (result.status === 'failed_before_send') {
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }
          if (result.status === 'transport_unavailable') {
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }
          if (result.status === 'outcome_unknown') {
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }
          if (result.status === 'failed_semantic') {
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }

          return result.status === 'failed_after_partial_send'
            ? ChatLunaChains.ChainMiddlewareRunStatus.STOP
            : ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        } catch (error) {
          executorError = error;
          throw error;
        } finally {
          finishReplyRun(session, runId, executorError);
        }
      }) as ChatLunaChainBuilderLike;
    executorBuilder.after('request_conversation');
    executorBuilder.before('censor');
    replyRuntimeMiddlewaresRegistered = true;
    return true;
  };

  ctx.on('ready', async () => {
    ensureReplyRuntimeMiddlewaresRegistered();
    ensureProgressCallbacksRegistered();

    const historyMigration = await migrateStructuredReplyHistoryRows(services.database);
    if (historyMigration.migrated > 0) {
      logger.info(
        'migrated %d reply history row(s): structured=%d, legacyDirectHumans=%d, submitPlans=%d, emptySubmitTools=%d, protocolPrompts=%d, failedToolErrors=%d, danglingToolTails=%d, completedToolTraces=%d, transientKwargs=%d, invisibleNames=%d, nonAiToolCalls=%d, emptyAssistants=%d.',
        historyMigration.migrated,
        historyMigration.structuredRowsMigrated,
        historyMigration.legacyDirectHumanRowsTagged,
        historyMigration.submitReplyPlansMigrated,
        historyMigration.emptySubmitReplyPlanToolsRemoved,
        historyMigration.protocolViolationPromptsRemoved,
        historyMigration.failedToolCallErrorRowsRemoved,
        historyMigration.danglingToolCallTailRowsRemoved,
        historyMigration.completedToolTraceRowsMigrated,
        historyMigration.transientAdditionalKwargsRowsCleaned,
        historyMigration.invisibleMessageNamesCleared,
        historyMigration.nonAiToolCallsCleared,
        historyMigration.emptyAssistantRowsRemoved,
      );
    }

    const recovery = await recoverPersistedReplyDeliveries();
    if (recovery.scanned > 0) {
      logger.warn(
        'recovered %d interactive reply delivery checkpoint(s): reconciled=%d outcomeUnknown=%d.',
        recovery.scanned,
        recovery.reconciled,
        recovery.outcomeUnknown,
      );
    }

    if (isVoiceOutputConfigured(runtime)) {
      const ttsState = getTtsCapabilityState(runtime, sharedReplyTransportTtsCapabilityStates);
      ttsState.failureBackoffUntil = Math.max(ttsState.failureBackoffUntil, Date.now() + INITIAL_TTS_PROBE_DELAY_MS);
      initialTtsProbeTimer = setTimeout(() => {
        void runTtsHealthProbe(runtime, ttsState, true).catch((error) => {
          logger.warn('initial tts health probe failed: %s', (error as Error).message);
        });
      }, INITIAL_TTS_PROBE_DELAY_MS);
    }

  });

  ctx.on('chatluna/chat-chain-added', () => {
    ensureReplyRuntimeMiddlewaresRegistered();
    ensureProgressCallbacksRegistered();
  });

  ctx.on('dispose', () => {
    if (initialTtsProbeTimer) {
      clearTimeout(initialTtsProbeTimer);
      initialTtsProbeTimer = null;
    }
    progressCallbacksDispose?.();
    progressCallbacksDispose = null;
  });
}
