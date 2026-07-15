import { Context, h } from 'koishi';
import {
  createAudioDataUri,
  createVoiceRuntimeConfigFromEnv,
  ensureCanSendRecord,
  isVoiceOutputConfigured,
  synthesizeVoice,
  type OneBotBotLike,
  normalizeVoiceSynthesisText,
  pickVoiceStyle,
  type VoiceStyle,
} from '../reply/index.js';
import { createBotMessageDispatchers } from '../shared/outbound/index.js';

export interface QqVoiceBridgeRequest {
  chatType: 'private' | 'group';
  targetId: string;
  text: string;
  speaker?: string;
  style?: 'auto' | VoiceStyle;
}

export interface QqVoiceBridgeResponse {
  ok: true;
  normalizedText: string;
  resolvedStyle: VoiceStyle;
  messageId: string | null;
}

export class QqVoiceBridgeHttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'QqVoiceBridgeHttpError';
    this.status = status;
    this.code = code;
  }
}

const canSendRecordCache = new Map<string, boolean>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeChatType(value: unknown): 'private' | 'group' | null {
  return value === 'private' || value === 'group' ? value : null;
}

function normalizeTargetId(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeStyle(value: unknown): 'auto' | VoiceStyle | null {
  return value === 'auto' || value === 'white' || value === 'black' ? value : null;
}

function normalizeSpeaker(value: unknown): string {
  return String(value ?? 'sakiko').trim() || 'sakiko';
}

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

function extractMessageId(result: unknown): string | null {
  if (typeof result === 'string' || typeof result === 'number') {
    const normalized = String(result).trim();
    return normalized || null;
  }

  if (Array.isArray(result)) {
    for (const item of result) {
      const extracted = extractMessageId(item);
      if (extracted) return extracted;
    }
    return null;
  }

  if (!isRecord(result)) {
    return null;
  }

  for (const key of ['messageId', 'message_id', 'id']) {
    const extracted = extractMessageId(result[key]);
    if (extracted) return extracted;
  }

  return null;
}

function resolveVoiceBridgeApiKey(): string {
  return String(process.env.QQ_VOICE_BRIDGE_API_KEY ?? '').trim();
}

export function validateVoiceBridgeAuthHeader(authHeader: string): boolean {
  const expected = resolveVoiceBridgeApiKey();
  return Boolean(expected) && authHeader.trim() === `Bearer ${expected}`;
}

function resolveOneBotBot(ctx: Context): OneBotBotLike {
  const configuredSelfId = String(process.env.ONEBOT_SELF_ID ?? '').trim();
  const onebotBots = ctx.bots.filter((bot) => bot.platform === 'onebot') as unknown as OneBotBotLike[];

  if (!configuredSelfId) {
    throw new QqVoiceBridgeHttpError(503, 'bot_unavailable', 'ONEBOT_SELF_ID is required for voice bridge bot resolution');
  }

  const exact = onebotBots.find((bot) => String(bot.selfId ?? '').trim() === configuredSelfId);
  if (exact) {
    return exact;
  }

  throw new QqVoiceBridgeHttpError(503, 'bot_unavailable', `configured ONEBOT_SELF_ID is not online: ${configuredSelfId}`);
}

export function parseQqVoiceBridgeRequest(payload: unknown): QqVoiceBridgeRequest {
  if (!isRecord(payload)) {
    throw new QqVoiceBridgeHttpError(400, 'invalid_payload', 'request body must be a JSON object');
  }

  const chatType = normalizeChatType(payload.chatType);
  if (!chatType) {
    throw new QqVoiceBridgeHttpError(400, 'invalid_chat_type', 'chatType must be private or group');
  }

  const targetId = normalizeTargetId(payload.targetId);
  if (!targetId) {
    throw new QqVoiceBridgeHttpError(400, 'invalid_target_id', 'targetId is required');
  }

  const speaker = normalizeSpeaker(payload.speaker);
  if (speaker !== 'sakiko') {
    throw new QqVoiceBridgeHttpError(400, 'unsupported_speaker', 'only sakiko is supported in bridge mode');
  }

  const style = normalizeStyle(payload.style ?? 'auto');
  if (!style) {
    throw new QqVoiceBridgeHttpError(400, 'invalid_style', 'style must be auto, white, or black');
  }

  const text = normalizeText(payload.text);
  if (!text) {
    throw new QqVoiceBridgeHttpError(400, 'invalid_text', 'text is required');
  }

  return {
    chatType,
    targetId,
    text,
    speaker,
    style,
  };
}

export async function sendVoiceByBridge(ctx: Context, request: QqVoiceBridgeRequest): Promise<QqVoiceBridgeResponse> {
  const runtime = createVoiceRuntimeConfigFromEnv();
  if (!runtime.outputEnabled) {
    throw new QqVoiceBridgeHttpError(503, 'voice_output_disabled', 'QQ voice output is disabled on the server');
  }
  if (!isVoiceOutputConfigured(runtime)) {
    throw new QqVoiceBridgeHttpError(503, 'tts_not_configured', 'QQ_VOICE_TTS_BASE_URL is not configured');
  }
  if (!runtime.ttsApiKey.trim()) {
    throw new QqVoiceBridgeHttpError(503, 'tts_not_configured', 'QQ_VOICE_TTS_API_KEY is not configured');
  }

  const normalizedText = normalizeVoiceSynthesisText(request.text);
  if (!normalizedText) {
    throw new QqVoiceBridgeHttpError(400, 'invalid_text', 'normalized text is empty');
  }

  const bot = resolveOneBotBot(ctx);
  if (typeof bot.internal?._request !== 'function') {
    throw new QqVoiceBridgeHttpError(503, 'bot_unavailable', 'current onebot rpc transport is not ready');
  }
  const canSendRecord = await ensureCanSendRecord(bot, canSendRecordCache, true);
  if (!canSendRecord) {
    throw new QqVoiceBridgeHttpError(409, 'record_unavailable', 'current bot cannot send voice records');
  }

  const requestedStyle = request.style === 'white' || request.style === 'black' || request.style === 'auto'
    ? request.style
    : 'auto';
  const resolvedStyle = requestedStyle === 'auto' ? pickVoiceStyle(normalizedText) : requestedStyle;
  let wav: Uint8Array;
  try {
    wav = await synthesizeVoice(runtime, normalizedText, resolvedStyle);
  } catch (error) {
    throw new QqVoiceBridgeHttpError(502, 'tts_failed', (error as Error).message || 'failed to synthesize voice');
  }

  try {
    const { sendWhole } = createBotMessageDispatchers(bot, request.targetId);
    const sendResult = await sendWhole(h.audio(createAudioDataUri(wav)));
    return {
      ok: true,
      normalizedText,
      resolvedStyle,
      messageId: extractMessageId(sendResult),
    };
  } catch (error) {
    throw new QqVoiceBridgeHttpError(502, 'send_failed', (error as Error).message || 'failed to send voice');
  }
}
