import { randomUUID } from 'node:crypto';
import { Context, h, Logger, Schema, type Session, type Universal } from 'koishi';
import type { FeaturePolicyServiceLike } from '../../../types/feature-policy.js';
import type { ScopedFeatureKey } from '../../../types/feature-policy.js';
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
  sendBotMessageByNormalizedContent,
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
} from '../pipeline/types.js';
import {
  buildReplyPromptCompilerInput,
  compileReplyPromptEnvelope,
} from '../prompt/compiler.js';
import {
  ReplyRuntime,
  type ReplyTurnContinuationContext,
  type ReplyRunMode,
  type ReplyRuntimeRoomLike,
} from '../runtime/index.js';
import {
  migrateStructuredReplyHistoryRows,
  type StructuredReplyHistoryDatabaseLike,
} from '../history-migration.js';

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
  required: ['chatluna', 'database', 'featurePolicy', 'modelConfig', 'naturalTriggerConfig'],
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

export interface ReplyCapabilitySnapshot {
  canMultiline: true;
  canVoice: boolean;
  voiceOutputLanguage: VoiceOutputLanguage;
  source: ReplyCapabilitySource;
  refreshedAt: number;
}

interface ReplyTransportState {
  capabilitySnapshot?: ReplyCapabilitySnapshot;
  runId?: string;
  suppressErrorNotice?: boolean;
  handleRequestModelError?: (error: unknown) => Promise<string | void> | string | void;
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
  capabilitySnapshot?: Pick<NonNullable<TurnContext['capabilitySnapshot']>, 'canMention' | 'canVoice' | 'canSticker' | 'voiceOutputLanguage'> | null;
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

type InputMessageContentPart = {
  type?: unknown;
  text?: unknown;
};

type ReplyInputContentMeta = {
  hasImageInput: boolean;
  imageCount: number;
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
  | { status: 'failed_before_send'; historyText: string }
  | { status: 'failed_after_partial_send'; historyText: string }
  | { status: 'transport_unavailable'; historyText: string }
  | { status: 'interrupted'; historyText: string };

type ChatLunaLike = {
  chat?: unknown;
  stopChat?: (room: unknown, requestId: string) => Promise<boolean>;
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
  conversationRuntime?: {
    clearConversationCache: (conversationId: string) => Promise<unknown>;
  };
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

export async function synthesizeVoice(
  runtime: RuntimeConfig,
  text: string,
  style: 'white' | 'black',
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!runtime.ttsBaseUrl) {
    throw new Error('missing TTS base url');
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), runtime.synthTimeoutMs);

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
      throw new Error(`TTS http ${response.status}`);
    }

    return new Uint8Array(await response.arrayBuffer());
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

function buildContentBlockedFallbackText(session: SessionWithVoiceState): string {
  const fallback = session.isDirect
    ? '这个话题我不方便展开，换个别的吧。'
    : '这个话题我不方便在群里展开，换个别的吧。';
  return sanitizeStructuredReplyText(fallback, 'message');
}

async function sendFailureReply(session: SessionWithVoiceState, message: string): Promise<void> {
  if (!session.channelId) {
    const { sendWhole } = createSessionMessageDispatchers(session);
    await sendWhole(message);
    return;
  }

  await sendBotMessageByNormalizedContent(session.bot as OneBotBotLike, session.channelId, message, session);
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

function removeStickerSegments(plan: ReplyTransportPlan): ReplyTransportPlan {
  return {
    segments: plan.segments.filter((segment) => segment.kind !== 'sticker'),
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
  visibleHistoryText: string,
): Promise<void> {
  const chatluna = (ctx.get?.('chatluna') ?? (ctx as { chatluna?: any }).chatluna) as ChatLunaLike | undefined;
  const conversationId = typeof room?.conversationId === 'string' ? room.conversationId.trim() : '';
  const normalizeHistory = requireReplyHistoryNormalizer(chatluna);
  const clearConversationCache = requireReplyHistoryCacheInvalidator(chatluna);
  if (!conversationId) {
    throw new Error('reply runtime history normalization requires room.conversationId.');
  }
  await clearConversationCache(conversationId);
  await normalizeHistory(room!, visibleHistoryText.trim());
}

function requireReplyHistoryNormalizer(
  chatluna: { normalizeResearchReplyHistory?: (room: Record<string, unknown>, visibleHistoryText: string) => Promise<unknown> } | undefined,
): (room: Record<string, unknown>, visibleHistoryText: string) => Promise<unknown> {
  if (typeof chatluna?.normalizeResearchReplyHistory !== 'function') {
    throw new Error('reply runtime requires chatluna.normalizeResearchReplyHistory.');
  }
  return chatluna.normalizeResearchReplyHistory.bind(chatluna);
}

function requireReplyHistoryCacheInvalidator(
  chatluna: ChatLunaLike | undefined,
): (conversationId: string) => Promise<unknown> {
  const conversationRuntime = chatluna?.conversationRuntime;
  const clearConversationCache = conversationRuntime?.clearConversationCache;
  if (typeof clearConversationCache !== 'function') {
    throw new Error('reply runtime requires chatluna.conversationRuntime.clearConversationCache.');
  }
  return clearConversationCache.bind(conversationRuntime);
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
  if (!force && capabilityCache.has(cacheKey)) {
    return capabilityCache.get(cacheKey) ?? false;
  }

  if (typeof bot.internal?._request !== 'function') {
    capabilityCache.delete(cacheKey);
    return false;
  }

  let result = false;
  try {
    result = (await bot.internal?.canSendRecord?.()) ?? false;
  } catch (error) {
    if (/_request is not a function/i.test((error as Error).message)) {
      capabilityCache.delete(cacheKey);
      return false;
    }

    logger.warn('canSendRecord failed for %s: %s', cacheKey, (error as Error).message);
    capabilityCache.delete(cacheKey);
    return false;
  }

  capabilityCache.set(cacheKey, result);
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

function registerReplyRunRequestModelGuard(args: {
  session: SessionWithVoiceState;
  replyRuntime: ReplyRuntime;
  runId: string;
  conversationId?: string;
}): void {
  const { session, replyRuntime, runId, conversationId } = args;
  setReplyRequestModelErrorHandler(session, async (error) => {
    const finished = replyRuntime.finishRun(runId);
    if (!finished) {
      return;
    }
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
    return formatReplyModelFailureNotice(error) ?? undefined;
  });
}

function formatReplyModelFailureNotice(error: unknown): string | null {
  const failure = readReplyProviderHttpFailure(error);
  if (!failure) return null;

  if (failure.httpStatus === 402 && failure.providerCode === 'quota_exceeded') {
    return '主聊天服务请求失败：HTTP 402，error_code=quota_exceeded，当前额度已用完。请等待额度重置、补充额度，或在管理页切换服务。';
  }

  return `主聊天服务请求失败：HTTP ${failure.httpStatus}。请稍后重试；持续失败请联系管理员并提供错误发生时间。`;
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

export function buildTurnCapabilitySnapshot(session: SessionWithVoiceState, snapshot: ReplyCapabilitySnapshot): NonNullable<TurnContext['capabilitySnapshot']> {
  const stickerState = session.state?.qqSticker;
  const stickerAvailableCount = stickerState?.availableCount ?? 0;
  return {
    canMultiline: snapshot.canMultiline,
    canMention: canSessionUseMention(session),
    canVoice: snapshot.canVoice,
    voiceOutputLanguage: snapshot.voiceOutputLanguage,
    canSticker: stickerAvailableCount > 0,
    stickerAvailableCount,
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
    canMention: options.capabilitySnapshot?.canMention !== false,
    canVoice: options.capabilitySnapshot?.canVoice !== false,
    canMeme: options.capabilitySnapshot?.canSticker === true,
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
  turnInput: Pick<TurnInput, 'hasImageInput' | 'imageCount' | 'displayName' | 'userId' | 'isDirect'>,
): void {
  if (!inputMessage) return;

  const existingSpeakerFormat =
    (inputMessage.additional_kwargs?.qqbot_speaker_format as ReplySpeakerFormatMeta | undefined) ?? undefined;

  inputMessage.additional_kwargs = {
    ...(inputMessage.additional_kwargs ?? {}),
    qqbot_input_content_meta: {
      hasImageInput: turnInput.hasImageInput,
      imageCount: turnInput.imageCount,
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

function applyPreparedInputText(
  session: SessionWithVoiceState,
  context: MiddlewareContextLike,
  inputText: string | undefined,
  inputTextSpeakerTagged?: boolean,
): void {
  const normalized = inputText?.trim();
  if (!normalized) return;

  session.content = normalized;
  const inputMessage = context.options?.inputMessage;
  if (inputMessage) {
    const currentContent = inputMessage.content;
    if (!Array.isArray(currentContent)) {
      inputMessage.content = normalized;
    } else {
      let textUpdated = false;
      inputMessage.content = currentContent.map((part) => {
        if (
          !textUpdated &&
          part &&
          typeof part === 'object' &&
          (part as InputMessageContentPart).type === 'text'
        ) {
          textUpdated = true;
          return {
            ...(part as Record<string, unknown>),
            text: normalized,
          };
        }
        return part;
      });

      if (!textUpdated) {
        inputMessage.content = [
          { type: 'text', text: normalized },
          ...currentContent,
        ];
      }
    }

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
  };
  ttsCapabilityStates.set(cacheKey, created);
  return created;
}

function updateTtsCapabilityObservation(state: TtsCapabilityState, healthy: boolean): void {
  const now = Date.now();
  state.lastKnownHealthy = healthy;
  state.lastProbeAt = now;
  state.lastProbeTurn = state.turnCounter;
  state.failureBackoffUntil = healthy ? 0 : now + TTS_PROBE_FAILURE_BACKOFF_MS;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(runtime.synthTimeoutMs, TTS_PROBE_TIMEOUT_MS));

    try {
      const response = await fetch(`${runtime.ttsBaseUrl}/healthz`, {
        method: 'GET',
        headers: createAuthHeaders(runtime.ttsApiKey),
        signal: controller.signal,
      });
      healthy = response.ok;
    } catch (error) {
      logger.warn('tts health probe failed: %s', (error as Error).message);
      healthy = false;
    } finally {
      clearTimeout(timer);
    }

    updateTtsCapabilityObservation(state, healthy);
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
  waitForProbe?: boolean;
}): Promise<ReplyCapabilitySnapshot> {
  const {
    runtime,
    session,
    canSendRecordCache = sharedReplyTransportCanSendRecordCache,
    ttsCapabilityStates = sharedReplyTransportTtsCapabilityStates,
    voiceOutputEnabled = false,
    waitForProbe = false,
  } = args;
  const snapshot: ReplyCapabilitySnapshot = {
    canMultiline: true,
    canVoice: false,
    voiceOutputLanguage: runtime.voiceOutputLanguage,
    source: 'cached',
    refreshedAt: Date.now(),
  };

  if (!voiceOutputEnabled || !isVoiceOutputConfigured(runtime)) {
    return snapshot;
  }

  const bot = session.bot as OneBotBotLike;
  if (!(await ensureCanSendRecord(bot, canSendRecordCache))) {
    return snapshot;
  }

  const ttsState = getTtsCapabilityState(runtime, ttsCapabilityStates);
  ttsState.turnCounter += 1;
  const due = isTtsProbeDue(ttsState, snapshot.refreshedAt);

  if (waitForProbe && ttsState.lastKnownHealthy == null) {
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
}): Promise<{ preparedByRaw: Map<string, PreparedVoiceDelivery>; effectivePlan: ReplyTransportPlan }> {
  const { runtime, plan, bot, canSendRecordCache, ttsCapabilityStates } = args;
  const outboundPlan = buildOutboundMessagePlanFromReplyPlan(plan);
  if (!hasVoiceSegments(outboundPlan)) {
    return { preparedByRaw: new Map(), effectivePlan: plan };
  }
  if (!isVoiceOutputConfigured(runtime)) {
    return { preparedByRaw: new Map(), effectivePlan: downgradeVoiceSegmentsToText(plan) };
  }
  if (!(await ensureCanSendRecord(bot, canSendRecordCache))) {
    return { preparedByRaw: new Map(), effectivePlan: downgradeVoiceSegmentsToText(plan) };
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
          throw new Error('empty_voice_segment');
        }
        const wordCount = countVoiceWords(text);
        if (wordCount > runtime.outputMaxWords) {
          throw new Error(`voice_segment_too_many_words:${runtime.outputMaxWords}`);
        }

        const style = pickVoiceStyle(text);
        const wav = await synthesizeVoice(runtime, text, style);
        const durationMs = estimateWavDurationMs(wav);
        if (durationMs && durationMs > runtime.outputMaxSeconds * 1000) {
          throw new Error(`voice_segment_too_long_duration:${runtime.outputMaxSeconds}`);
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
    updateTtsCapabilityObservation(ttsState, false);
    const reason = (error as Error).message;
    if (
      reason.startsWith('voice_segment_too_many_words:') ||
      reason.startsWith('voice_segment_too_long_duration:') ||
      reason === 'empty_voice_segment'
    ) {
      return { preparedByRaw: new Map(), effectivePlan: downgradeVoiceSegmentsToText(plan) };
    }
    logger.warn('voice preflight failed: %s', reason);
    return { preparedByRaw: new Map(), effectivePlan: downgradeVoiceSegmentsToText(plan) };
  }
}

async function prepareStickerDeliveries(args: {
  session: SessionWithVoiceState;
  plan: ReplyTransportPlan;
}): Promise<{ preparedByRaw: Map<string, PreparedStickerDelivery>; effectivePlan: ReplyTransportPlan }> {
  const { session, plan } = args;
  const outboundPlan = buildOutboundMessagePlanFromReplyPlan(plan);
  if (!hasStickerSegments(outboundPlan)) {
    return { preparedByRaw: new Map(), effectivePlan: plan };
  }

  const stickerState = session.state?.qqSticker;
  if (!stickerState?.catalog) {
    return { preparedByRaw: new Map(), effectivePlan: removeStickerSegments(plan) };
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
    if (!selected) continue;

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
  onDeliveryReceipt?: (receipt: unknown) => void;
}): Promise<ReplyPlanDeliveryResult> {
  const {
    runtime,
    session,
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
  } = args;
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
  });
  const preparedSticker = await prepareStickerDeliveries({
    session,
    plan: preparedVoice.effectivePlan,
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
  onPlannedUnitHistoryLines?.(plannedUnitHistoryLines);
  let beganSending = false;
  let sendAbortSignal: AbortSignal | null = null;
  const committedHistoryLines: string[] = [];
  const wasSendAborted = () => (sendAbortSignal as AbortSignal | null)?.aborted === true;
  const sendTask = async () => {
    sendAbortSignal = beginSend?.() ?? null;
    if (beginSend && !sendAbortSignal) {
      return;
    }

    const { sendWhole, sendLine } = createBotMessageDispatchers(bot, session.channelId!, session);
    await dispatchOutboundMessagePlan(outboundPlan, async (segment) => {
      const historyLine = plannedUnitHistoryLines[outboundPlan.segments.indexOf(segment)] ?? '';
      const quoteTargetMessageId = resolveQuoteTargetMessageId?.(segment.kind !== 'voice-block') ?? null;
      if (segment.kind === 'text-line') {
        const receipt = await sendLine(createQuotedMessageContent(segment.content, quoteTargetMessageId));
        beganSending = true;
        onDeliveryReceipt?.(receipt);
        if (historyLine) {
          committedHistoryLines.push(historyLine);
          onCommittedUnit?.(historyLine);
        }
        return;
      }

      if (segment.kind === 'message-block') {
        const receipt = await sendWhole(createQuotedMessageContent(createMessageMessageContent(segment), quoteTargetMessageId));
        beganSending = true;
        onDeliveryReceipt?.(receipt);
        if (historyLine) {
          committedHistoryLines.push(historyLine);
          onCommittedUnit?.(historyLine);
        }
        return;
      }

      if (segment.kind === 'structured-block') {
        const receipt = await sendWhole(createQuotedMessageContent(h.text(segment.content), quoteTargetMessageId));
        beganSending = true;
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

        const receipt = await sendWhole(createQuotedMessageContent(h.image(prepared.buffer, prepared.mime), quoteTargetMessageId));
        beganSending = true;
        onDeliveryReceipt?.(receipt);
        if (historyLine) {
          committedHistoryLines.push(historyLine);
          onCommittedUnit?.(historyLine);
        }
        return;
      }

      if (segment.kind === 'image-block') {
        const receipt = await sendWhole(createQuotedMessageContent(h.image(segment.assetRef), quoteTargetMessageId));
        beganSending = true;
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

      const receipt = await sendWhole(h.audio(createAudioDataUri(prepared.wav)));
      beganSending = true;
      onDeliveryReceipt?.(receipt);
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
    const errorMessage = (error as Error).message;
    const committedHistoryText = committedHistoryLines.join('\n').trim();
    if (wasSendAborted() || wasInterrupted?.()) {
      return { status: 'interrupted', historyText: committedHistoryText };
    }
    if (isOneBotRpcTransportUnavailableError(error)) {
      logger.warn('reply plan delivery skipped because onebot rpc transport is unavailable: %s', errorMessage);
      return beganSending
        ? { status: 'failed_after_partial_send', historyText: committedHistoryText }
        : { status: 'transport_unavailable', historyText: committedHistoryText };
    }
    logger.warn('reply plan delivery failed: %s', errorMessage);
    if (beganSending) {
      return { status: 'failed_after_partial_send', historyText: committedHistoryText };
    }
    if (isOneBotContentBlockedError(error)) {
      const blockedFallbackText = buildContentBlockedFallbackText(session);
      try {
        await sendFailureReply(session, blockedFallbackText);
        return { status: 'delivered', historyText: blockedFallbackText };
      } catch (fallbackError) {
        logger.warn('content blocked reply replacement failed: %s', (fallbackError as Error).message);
      }
    }
    return { status: 'failed_before_send', historyText: '' };
  }

  if ((beginSend && !sendAbortSignal) || wasSendAborted() || wasInterrupted?.()) {
    return { status: 'interrupted', historyText: committedHistoryLines.join('\n').trim() };
  }

  return { status: 'delivered', historyText: effectiveHistoryText };
}

async function deliverReplyPlan(args: {
  runtime: RuntimeConfig;
  session: SessionWithVoiceState;
  plan: ReplyTransportPlan;
  replyRuntime: ReplyRuntime;
  runId: string;
}): Promise<ReplyPlanDeliveryResult> {
  const { runtime, session, plan, replyRuntime, runId } = args;
  return deliverReplyPlanCore({
    runtime,
    session,
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
  });
}

export async function deliverStandaloneReplyPlan(args: {
  runtime: RuntimeConfig;
  session: SessionWithVoiceState;
  plan: ReplyTransportPlan;
}): Promise<ReplyPlanDeliveryResult & { receipts: unknown[] }> {
  const receipts: unknown[] = [];
  const result = await deliverReplyPlanCore({
    runtime: args.runtime,
    session: args.session,
    plan: args.plan,
    queueKey: resolveReplyQueueKey(args.session),
    onDeliveryReceipt: (receipt) => {
      receipts.push(receipt);
    },
  });
  return {
    ...result,
    receipts,
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
    const replyInterruptFeatureKey = 'QQBOT_REPLY_INTERRUPT_ENABLED' as ScopedFeatureKey;
    const replyInterruptEnabled = await featurePolicy.resolveFeatureEnabled(session, replyInterruptFeatureKey);
    return replyInterruptEnabled ? 'interrupt' : 'queue';
  };

  const replyRuntime = new ReplyRuntime({
    stopChat: async (room, requestId) => {
      const chatluna = resolveChatLunaService();
      if (typeof chatluna?.stopChat !== 'function') return;
      await chatluna.stopChat(room, requestId);
    },
    collectWindowMs: runtime.replyInterruptCollectWindowMs,
    maxPendingInputs: runtime.replyInterruptMaxPendingInputs,
  });

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
        applyPreparedInputText(session, context, prepared.inputText, prepared.inputTextSpeakerTagged);
        beginPromptAssemblyTurn(conversationId, { turnId: runId });
        registerReplyTurnStateFragment(conversationId, prepared.continuationContext);
        setReplyRunId(session, runId);
        registerReplyRunRequestModelGuard({
          session,
          replyRuntime,
          runId,
          conversationId,
        });
        if (context.options) {
          context.options.messageId = runId;
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
        suppressReplyErrorNotice(session);
        const voiceFeatureState = await resolveVoiceFeatureState(session);

        const snapshot =
          getAuthorizedReplyCapabilitySnapshot(session, replyCapabilitySnapshots) ??
          (await resolveReplyCapabilitySnapshot({
            runtime,
            session,
            voiceOutputEnabled: voiceFeatureState.outputEnabled,
          }));
        rememberReplyCapabilitySnapshot(session, snapshot, replyCapabilitySnapshots);
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
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
        ensureReplyPluginRoom(room);
        const mainModelTarget = resolveMainModelTarget();
        ensureSupportedStructuredReplyModel(mainModelTarget);

        const capability = getAuthorizedReplyCapabilitySnapshot(session, replyCapabilitySnapshots);
        const turnInput = buildReplyTurnInput(session, room, context.options?.inputMessage);
        applyReplyTurnInputMetadata(context.options?.inputMessage, turnInput);
        const turnCapabilitySnapshot = capability ? buildTurnCapabilitySnapshot(session, capability) : null;
        const schemaCapabilitySnapshot = {
          canMention: canSessionUseMention(session),
          canVoice: turnCapabilitySnapshot?.canVoice ?? false,
          voiceOutputLanguage: runtime.voiceOutputLanguage,
          canSticker: turnCapabilitySnapshot?.canSticker ?? false,
        };
        const replyOutputContract = buildModelReplyOutputContract({
          canonicalModel: mainModelTarget.canonicalModel,
          model: mainModelTarget.model,
          canMention: schemaCapabilitySnapshot.canMention,
          canVoice: schemaCapabilitySnapshot.canVoice,
          canMeme: schemaCapabilitySnapshot.canSticker,
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
      }) as ChatLunaChainBuilderLike;
    promptCompilerBuilder.after('qqbot_reply_transport_policy');
    promptCompilerBuilder.after('qqbot_turn_context');
    promptCompilerBuilder.after('qqbot_memory');
    promptCompilerBuilder.after('qqbot_sticker_policy');
    promptCompilerBuilder.before('qqbot_prompt_envelope');
    promptCompilerBuilder.before('lifecycle-handle_command');

    const executorBuilder = chain.middleware('qqbot_reply_plan_executor', async (rawSession, rawContext) => {
        const session = rawSession as SessionWithVoiceState;
        const context = rawContext as MiddlewareContextLike;
        if (!isReplyPlanSessionAvailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }
        suppressReplyErrorNotice(session);

        const responseMessage = context.options?.responseMessage;
        if (!responseMessage) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        const room = resolveChatLunaRoomLike(context.options) as ReplyRuntimeRoomLike | undefined;
        const conversationId = room?.conversationId?.trim();
        ensureReplyPluginRoom(room);
        ensureSupportedStructuredReplyModel(resolveMainModelTarget());
        const runMode = await resolveReplyRunMode(session);
        let runId = getReplyRunId(session);
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
          applyPreparedInputText(session, context, prepared.inputText, prepared.inputTextSpeakerTagged);
          setReplyRunId(session, runId);
          registerReplyRunRequestModelGuard({
            session,
            replyRuntime,
            runId,
            conversationId,
          });
        }
        if (!replyRuntime.isCurrentRun(runId)) {
          if (context.options) {
            context.options.responseMessage = null;
          }
          replyRuntime.finishRun(runId);
          return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
        }

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
            }));
          rememberReplyCapabilitySnapshot(session, snapshot, replyCapabilitySnapshots);
          const turnCapabilitySnapshot = buildTurnCapabilitySnapshot(session, snapshot);
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
            try {
              await normalizeResearchReplyHistory(ctx, room, '');
            } catch (cleanupError) {
              logger.warn('structured model failure history cleanup failed: %s', (cleanupError as Error).message);
            }
            if (context.options) {
              context.options.responseMessage = null;
            }
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }

          if (orchestration.status === 'no_reply') {
            if (context.options) {
              context.options.responseMessage = null;
            }
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }
          if (orchestration.status !== 'ready') {
            throw new Error(`reply v2 orchestrator expected ready status, got ${orchestration.status}.`);
          }
          if (orchestration.actions.length === 1 && orchestration.actions[0]?.kind === 'no_reply') {
            if (context.options) {
              context.options.responseMessage = null;
            }
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }

          const executablePlan = buildReplyTransportPlanFromResolvedActions(orchestration.actions);
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
            plan: executablePlan,
            replyRuntime,
            runId,
          });

          if (result.status === 'failed_before_send' || result.status === 'transport_unavailable') {
            if (context.options) {
              context.options.responseMessage = null;
            }
          } else if (context.options) {
            context.options.responseMessage = null;
          }

          if (result.status !== 'transport_unavailable') {
            try {
              const visibleHistoryText = buildTextOnlyAssistantHistoryText(result.historyText, outputProtocol);
              await normalizeResearchReplyHistory(ctx, room, visibleHistoryText);
            } catch (error) {
              logger.warn('research reply history normalization failed: %s', (error as Error).message);
            }
          }

          if (result.status === 'failed_before_send') {
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }
          if (result.status === 'transport_unavailable') {
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }

          return result.status === 'failed_after_partial_send'
            ? ChatLunaChains.ChainMiddlewareRunStatus.STOP
            : ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        } finally {
          setReplyRequestModelErrorHandler(session, undefined);
          clearReplyRunId(session);
          replyRuntime.finishRun(runId);
        }
      }) as ChatLunaChainBuilderLike;
    executorBuilder.after('request_conversation');
    executorBuilder.before('censor');
    replyRuntimeMiddlewaresRegistered = true;
    return true;
  };

  ctx.on('ready', async () => {
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

    if (isVoiceOutputConfigured(runtime)) {
      const ttsState = getTtsCapabilityState(runtime, sharedReplyTransportTtsCapabilityStates);
      ttsState.failureBackoffUntil = Math.max(ttsState.failureBackoffUntil, Date.now() + INITIAL_TTS_PROBE_DELAY_MS);
      initialTtsProbeTimer = setTimeout(() => {
        void runTtsHealthProbe(runtime, ttsState, true).catch((error) => {
          logger.warn('initial tts health probe failed: %s', (error as Error).message);
        });
      }, INITIAL_TTS_PROBE_DELAY_MS);
    }

    ensureReplyRuntimeMiddlewaresRegistered();
  });

  ctx.on('chatluna/chat-chain-added', () => {
    ensureReplyRuntimeMiddlewaresRegistered();
  });

  ctx.on('dispose', () => {
    if (initialTtsProbeTimer) {
      clearTimeout(initialTtsProbeTimer);
      initialTtsProbeTimer = null;
    }
  });
}
