import type { Session } from 'koishi';
import { resolveSessionDisplayName } from '../../shared/session/index.js';
import { normalizeMentionLikeText } from '../../shared/mention-text.js';
import type { ReplyRuntimeRoomLike } from '../runtime/index.js';
import {
  classifyReplyRoute,
  type ReplyRoute,
  type TurnContext,
  type TurnInput,
  type TurnInputImagePart,
  type TurnInputImageReference,
} from './types.js';

type SessionWithContent = Session & {
  stripped?: { content?: string };
  state?: Record<string, unknown> & {
    qqVoice?: {
      transcript?: unknown;
    };
  };
};

type InputMessageLike = {
  content?: unknown;
  additional_kwargs?: {
    qqbot_input_content_meta?: {
      hasImageInput?: unknown;
      imageCount?: unknown;
      hasVoiceInput?: unknown;
    };
  };
} | null | undefined;

type ContentPart = {
  type?: unknown;
  text?: unknown;
  image_url?: unknown;
};

function sanitizeInputText(text: string): string {
  return text
    .replace(/\[CQ:reply,[^\]]+\]/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/\[CQ:image,[^\]]+\]/gi, ' ')
}

function normalizeInputText(text: string): string {
  return sanitizeInputText(normalizeMentionLikeText(text))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export interface BuildReplyTurnContextOptions {
  room?: ReplyRuntimeRoomLike | null;
  capabilitySnapshot?: TurnContext['capabilitySnapshot'];
  continuationContext?: TurnContext['continuationContext'];
  routeHint?: ReplyRoute | null;
}

export function normalizeReplyRouteHint(chatMode: unknown): ReplyRoute | null {
  const value = String(chatMode ?? '').trim();
  if (!value) return null;
  if (value === 'agent') return 'agent';
  if (value === 'automation') return 'automation';
  return null;
}

function normalizeImageReference(value: unknown): TurnInputImageReference {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('reply input image_url must be a non-empty string or object.');
  }

  const record = value as Record<string, unknown>;
  if (typeof record.url !== 'string' || !record.url.trim()) {
    throw new Error('reply input image_url.url must be a non-empty string.');
  }
  if (
    record.detail !== undefined
    && record.detail !== 'auto'
    && record.detail !== 'low'
    && record.detail !== 'high'
  ) {
    throw new Error('reply input image_url.detail must be auto, low, or high.');
  }

  return {
    url: record.url,
    ...(record.detail === undefined ? {} : { detail: record.detail }),
  };
}

function collectInputContentInfo(content: unknown): { text: string; imageParts: TurnInputImagePart[] } {
  if (typeof content === 'string') {
    return { text: normalizeInputText(content), imageParts: [] };
  }

  if (!Array.isArray(content)) {
    return { text: '', imageParts: [] };
  }

  let text = '';
  const imageParts: TurnInputImagePart[] = [];

  for (const part of content as ContentPart[]) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      text += part.text;
      continue;
    }
    if (part.type === 'image_url') {
      imageParts.push({
        type: 'image_url',
        image_url: normalizeImageReference(part.image_url),
      });
    }
  }

  return { text: normalizeInputText(text), imageParts };
}

export function buildReplyTurnInput(
  session: SessionWithContent,
  room?: Pick<ReplyRuntimeRoomLike, 'conversationId'> | null,
  inputMessage?: InputMessageLike,
): TurnInput {
  const stripped = typeof session.stripped?.content === 'string' ? session.stripped.content : '';
  const { text: inputMessageText, imageParts } = collectInputContentInfo(inputMessage?.content);
  const inputMeta = inputMessage?.additional_kwargs?.qqbot_input_content_meta;
  const imageCount = imageParts.length;
  const hasVoiceInput = typeof inputMeta?.hasVoiceInput === 'boolean'
    ? inputMeta.hasVoiceInput
    : typeof session.state?.qqVoice?.transcript === 'string'
      && session.state.qqVoice.transcript.trim().length > 0;
  const rawText = inputMessageText.trim() || normalizeInputText(stripped) || normalizeInputText(String(session.content ?? ''));
  return {
    text: rawText,
    imageParts,
    hasImageInput: imageCount > 0,
    imageCount,
    hasVoiceInput,
    displayName: resolveSessionDisplayName(session),
    userId: session.userId?.trim() || '用户',
    isDirect: Boolean(session.isDirect),
    messageId: typeof session.messageId === 'string' && session.messageId.trim() ? session.messageId.trim() : null,
    channelId: typeof session.channelId === 'string' && session.channelId.trim() ? session.channelId.trim() : null,
    guildId: typeof session.guildId === 'string' && session.guildId.trim() ? session.guildId.trim() : null,
    conversationId: room?.conversationId?.trim() || null,
  };
}

export function buildReplyTurnContext(
  turnInput: TurnInput,
  options: BuildReplyTurnContextOptions = {},
): { route: ReplyRoute; turnContext: TurnContext } {
  const route = classifyReplyRoute(turnInput, options.routeHint ?? null);
  return {
    route,
    turnContext: {
      input: turnInput,
      capabilitySnapshot: options.capabilitySnapshot ?? null,
      policySnapshot: {
        route,
        toolRouteProfile: route === 'agent' ? route : null,
      },
      continuationContext: options.continuationContext ?? null,
    },
  };
}
