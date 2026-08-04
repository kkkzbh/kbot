import { z } from 'zod';
import { sanitizeStructuredReplyText } from '../../shared/outbound/index.js';
import type { ReplyMessagePart } from '../../shared/outbound/index.js';
import { STRUCTURED_REPLY_JSON_SCHEMA } from '../../shared/llm/structured-reply-schema.js';
import type { VoiceOutputLanguage } from '../../shared/voice/language.js';

export const REPLY_ROUTES = [
  'no_reply',
  'agent',
  'automation',
] as const;

export type ReplyRoute = (typeof REPLY_ROUTES)[number];
export type ReplyToolRouteProfile = Extract<ReplyRoute, 'agent'>;
export type PromptAssemblyRouteProfile = ReplyToolRouteProfile | 'automation';

export type TurnInputImageReference = string | {
  url: string;
  detail?: 'auto' | 'low' | 'high';
};

export interface TurnInputImagePart {
  type: 'image_url';
  image_url: TurnInputImageReference;
}

export interface TurnInput {
  text: string;
  imageParts: TurnInputImagePart[];
  hasImageInput: boolean;
  imageCount: number;
  hasVoiceInput: boolean;
  displayName: string;
  userId: string;
  isDirect: boolean;
  messageId?: string | null;
  channelId?: string | null;
  guildId?: string | null;
  conversationId?: string | null;
}

export interface TurnContinuationContext {
  alreadySentText: string;
  pendingUnitTexts: string[];
  supplementalMessages: string[];
  progressVisibleLines: string[];
}

export interface TurnContext {
  input: TurnInput;
  capabilitySnapshot: {
    canMultiline: boolean;
    canMention?: boolean;
    canVoice: boolean;
    voiceOutputLanguage?: VoiceOutputLanguage;
    canSticker: boolean;
    stickerAvailableCount: number;
    stickerIntentHints?: readonly string[];
    imageAssetRefs: readonly string[];
    source: string;
  } | null;
  policySnapshot: {
    route: ReplyRoute;
    toolRouteProfile: ReplyToolRouteProfile | null;
  };
  continuationContext: TurnContinuationContext | null;
}

export type StructuredReplyMessage =
  | {
      type: 'message';
      content: string;
    }
  | {
      type: 'structured_block';
      content: string;
    }
  | {
      type: 'voice';
      content: string;
    }
  | {
      type: 'image';
      assetRef: string;
      alt: string;
    }
  | {
      type: 'meme';
      content: string;
    };

export interface StructuredReply {
  decision: 'reply' | 'no_reply';
  outbound_messages: StructuredReplyMessage[] | null;
}

export type ResolvedAction =
  | {
      kind: 'message';
      parts: ReplyMessagePart[];
    }
  | {
      kind: 'structured_block';
      content: string;
    }
  | {
      kind: 'voice';
      content: string;
    }
  | {
      kind: 'image';
      assetRef: string;
      alt: string;
    }
  | {
      kind: 'sticker';
      intent: string;
    }
  | {
      kind: 'no_reply';
    };

const STRUCTURED_REPLY_MESSAGE_ITEM_SCHEMA = z.object({
  type: z.literal('message'),
  content: z.string().trim().min(1),
}).strict();

const STRUCTURED_REPLY_STRUCTURED_BLOCK_ITEM_SCHEMA = z.object({
  type: z.literal('structured_block'),
  content: z.string().trim().min(1),
}).strict();

const STRUCTURED_REPLY_VOICE_ITEM_SCHEMA = z.object({
  type: z.literal('voice'),
  content: z.string().trim().min(1).max(180),
}).strict();

const STRUCTURED_REPLY_IMAGE_ITEM_SCHEMA = z.object({
  type: z.literal('image'),
  assetRef: z.string().trim().min(1),
  alt: z.string().trim().min(1),
}).strict();

const STRUCTURED_REPLY_MEME_ITEM_SCHEMA = z.object({
  type: z.literal('meme'),
  content: z.string().trim().min(1).max(80),
}).strict();

const STRUCTURED_REPLY_OUTBOUND_ITEM_SCHEMA = z.discriminatedUnion('type', [
  STRUCTURED_REPLY_MESSAGE_ITEM_SCHEMA,
  STRUCTURED_REPLY_STRUCTURED_BLOCK_ITEM_SCHEMA,
  STRUCTURED_REPLY_VOICE_ITEM_SCHEMA,
  STRUCTURED_REPLY_IMAGE_ITEM_SCHEMA,
  STRUCTURED_REPLY_MEME_ITEM_SCHEMA,
]);

const NATIVE_STRUCTURED_REPLY_CONTENT_ITEM_SCHEMA = z.discriminatedUnion('type', [
  STRUCTURED_REPLY_MESSAGE_ITEM_SCHEMA,
  STRUCTURED_REPLY_STRUCTURED_BLOCK_ITEM_SCHEMA,
  STRUCTURED_REPLY_IMAGE_ITEM_SCHEMA,
]);

export interface NativeStructuredReplySchemaOptions {
  canVoice?: boolean;
  canMeme?: boolean;
}

type NativeStructuredReplyResult = {
  decision: 'reply' | 'no_reply';
  messages: Array<z.infer<typeof NATIVE_STRUCTURED_REPLY_CONTENT_ITEM_SCHEMA>> | null;
  voice_message?: z.infer<typeof STRUCTURED_REPLY_VOICE_ITEM_SCHEMA> | null;
  meme_message?: z.infer<typeof STRUCTURED_REPLY_MEME_ITEM_SCHEMA> | null;
};

function refineNativeStructuredReply(
  reply: NativeStructuredReplyResult,
  context: z.RefinementCtx,
): void {
  if (reply.decision === 'no_reply') {
    if (reply.messages !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['messages'],
        message: 'decision=no_reply requires null messages.',
      });
    }
    for (const field of ['voice_message', 'meme_message'] as const) {
      if (reply[field] != null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `decision=no_reply requires null ${field}.`,
        });
      }
    }
    return;
  }

  if (reply.messages === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['messages'],
      message: 'decision=reply requires an array of messages.',
    });
    return;
  }

  const total = reply.messages.length
    + (reply.voice_message == null ? 0 : 1)
    + (reply.meme_message == null ? 0 : 1);
  if (total < 1 || total > 4) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['messages'],
      message: 'decision=reply requires one to four total outbound messages.',
    });
  }
}

export function buildNativeStructuredReplyEnvelopeSchema(
  options: NativeStructuredReplySchemaOptions = {},
) {
  const canVoice = options.canVoice !== false;
  const canMeme = options.canMeme !== false;
  const resultShape = {
    decision: z.enum(['reply', 'no_reply']),
    messages: z.array(NATIVE_STRUCTURED_REPLY_CONTENT_ITEM_SCHEMA).max(4).nullable(),
    ...(canVoice ? { voice_message: STRUCTURED_REPLY_VOICE_ITEM_SCHEMA.nullable() } : {}),
    ...(canMeme ? { meme_message: STRUCTURED_REPLY_MEME_ITEM_SCHEMA.nullable() } : {}),
  };
  const resultSchema = z.object(resultShape).strict() as z.ZodType<NativeStructuredReplyResult>;
  return z.object({
    result: resultSchema.superRefine(refineNativeStructuredReply),
  }).strict();
}

export const NATIVE_STRUCTURED_REPLY_ENVELOPE_SCHEMA = buildNativeStructuredReplyEnvelopeSchema();

export type NativeStructuredReplyEnvelope = z.infer<typeof NATIVE_STRUCTURED_REPLY_ENVELOPE_SCHEMA>;

export function unwrapNativeStructuredReplyEnvelope(
  envelope: NativeStructuredReplyEnvelope,
): StructuredReply {
  const result = envelope.result;
  if (result.decision === 'no_reply') {
    return {
      decision: 'no_reply',
      outbound_messages: null,
    };
  }

  return {
    decision: 'reply',
    outbound_messages: [
      ...(result.messages ?? []),
      ...(result.voice_message == null ? [] : [result.voice_message]),
      ...(result.meme_message == null ? [] : [result.meme_message]),
    ],
  };
}

export const STRUCTURED_REPLY_SCHEMA = z.object({
  decision: z.enum(['reply', 'no_reply']),
  outbound_messages: z.array(STRUCTURED_REPLY_OUTBOUND_ITEM_SCHEMA).min(1).max(4).nullable(),
}).strict().superRefine((reply, context) => {
  if (reply.decision === 'reply' && reply.outbound_messages === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['outbound_messages'],
      message: 'decision=reply requires outbound messages.',
    });
  }
  if (reply.decision === 'no_reply' && reply.outbound_messages !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['outbound_messages'],
      message: 'decision=no_reply requires null outbound messages.',
    });
  }
  if (reply.outbound_messages) {
    for (const type of ['voice', 'meme'] as const) {
      if (reply.outbound_messages.filter((message) => message.type === type).length > 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['outbound_messages'],
          message: `at most one ${type} message is allowed.`,
        });
      }
    }
  }
});

export function normalizeStructuredReply(raw: unknown): StructuredReply | null {
  const parsed = STRUCTURED_REPLY_SCHEMA.safeParse(raw);
  if (!parsed.success) return null;

  if (parsed.data.decision === 'no_reply') {
    return {
      decision: 'no_reply',
      outbound_messages: null,
    };
  }

  const outboundMessages = parsed.data.outbound_messages?.map((message) =>
    message.type === 'message'
      ? {
          type: 'message' as const,
          content: sanitizeStructuredReplyText(message.content, 'message'),
        }
      : message.type === 'structured_block'
        ? {
            type: 'structured_block' as const,
            content: sanitizeStructuredReplyText(message.content, 'structured_block'),
          }
      : message.type === 'voice'
        ? {
            type: 'voice' as const,
            content: sanitizeStructuredReplyText(message.content, 'voice'),
          }
        : message.type === 'image'
          ? {
              type: 'image' as const,
              assetRef: message.assetRef.trim(),
              alt: sanitizeStructuredReplyText(message.alt, 'image_alt'),
            }
          : {
              type: 'meme' as const,
              content: sanitizeStructuredReplyText(message.content, 'meme'),
            },
  ) ?? null;
  if (!outboundMessages || outboundMessages.some((message) => (
    message.type === 'image' ? !message.assetRef || !message.alt : !message.content
  ))) {
    return null;
  }

  return {
    decision: 'reply',
    outbound_messages: outboundMessages,
  };
}

export function classifyReplyRoute(input: TurnInput, routeHint?: ReplyRoute | null): ReplyRoute {
  if (!input.text.trim() && !input.hasImageInput) return 'no_reply';
  if (routeHint === 'automation') return 'automation';
  if (routeHint === 'agent') return 'agent';
  return 'agent';
}

export { STRUCTURED_REPLY_JSON_SCHEMA };
