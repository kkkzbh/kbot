import {
  normalizeVoiceOutputLanguage,
  VOICE_OUTPUT_LANGUAGE_LABELS,
  type VoiceOutputLanguage,
} from '../voice/language.js';

export interface StructuredReplySchemaOptions {
  canVoice?: boolean;
  canMeme?: boolean;
  stickerIntentHints?: readonly string[];
  voiceOutputLanguage?: VoiceOutputLanguage;
}

type JsonSchema = Record<string, unknown>;

function strictObject(properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

function decisionSchema(value: 'reply' | 'no_reply'): JsonSchema {
  return {
    type: 'string',
    enum: [value],
  };
}

function messageItemSchema(
  type: 'message' | 'structured_block',
  description: string,
): JsonSchema {
  return {
    ...strictObject({
    type: {
      type: 'string',
      enum: [type],
    },
    content: {
      type: 'string',
      minLength: 1,
      description,
    },
    }),
    title: type === 'message' ? 'MessageItem' : 'StructuredBlockItem',
  };
}

const MESSAGE_SCHEMA = messageItemSchema(
  'message',
  'A concise natural chat message, usually one or two sentences and one idea. To mention a group member, write @name followed by a space.',
);

const STRUCTURED_BLOCK_SCHEMA = messageItemSchema(
  'structured_block',
  'Structured text that must stay intact, such as code, a list, or a quotation.',
);

const IMAGE_SCHEMA = {
  ...strictObject({
    type: {
      type: 'string',
      enum: ['image'],
    },
    assetRef: {
      type: 'string',
      minLength: 1,
      description: 'An image asset reference returned by a tool during this reply run.',
    },
    alt: {
      type: 'string',
      minLength: 1,
      description: 'A short description of the image.',
    },
  }),
  title: 'ImageItem',
};

function buildVoiceSchema(options: StructuredReplySchemaOptions): JsonSchema {
  const language = normalizeVoiceOutputLanguage(options.voiceOutputLanguage);
  const languageDescription = language === 'auto'
    ? 'Use the most natural spoken language for this turn.'
    : `Write this content directly in ${VOICE_OUTPUT_LANGUAGE_LABELS[language]}.`;
  return {
    ...strictObject({
      type: {
        type: 'string',
        enum: ['voice'],
      },
      content: {
        type: 'string',
        minLength: 1,
        maxLength: 180,
        description: `One short spoken utterance. ${languageDescription} Do not put links, code, lists, or essential facts here.`,
      },
    }),
    title: 'VoiceItem',
  };
}

function buildMemeSchema(options: StructuredReplySchemaOptions): JsonSchema {
  const hints = options.stickerIntentHints?.map((value) => value.trim()).filter(Boolean) ?? [];
  return {
    ...strictObject({
      type: {
        type: 'string',
        enum: ['meme'],
      },
      content: {
        type: 'string',
        minLength: 1,
        maxLength: 80,
        description: hints.length > 0
          ? `A specific, nonessential sticker intent matching one of these available moods: ${hints.join(', ')}.`
          : 'A specific, nonessential sticker intent for a light social moment.',
      },
    }),
    title: 'MemeItem',
  };
}

function contentMessagesSchema(minItems: number, maxItems: number): JsonSchema {
  return {
    type: 'array',
    minItems,
    maxItems,
    description: 'Ordered text messages, structured blocks, and tool-produced images.',
    items: {
      anyOf: [MESSAGE_SCHEMA, STRUCTURED_BLOCK_SCHEMA, IMAGE_SCHEMA],
    },
  };
}

export function buildStructuredReplyJsonSchema(
  options: StructuredReplySchemaOptions = {},
): Record<string, unknown> {
  const canVoice = options.canVoice !== false;
  const canMeme = options.canMeme !== false;
  const voiceSchema = buildVoiceSchema(options);
  const memeSchema = buildMemeSchema(options);

  const noReplyProperties: Record<string, JsonSchema> = {
    decision: decisionSchema('no_reply'),
    messages: { type: 'null' },
  };
  if (canVoice) noReplyProperties.voice_message = { type: 'null' };
  if (canMeme) noReplyProperties.meme_message = { type: 'null' };

  const replyVariant = (args: {
    minMessages: number;
    maxMessages: number;
    voice: JsonSchema;
    meme: JsonSchema;
  }): JsonSchema => {
    const properties: Record<string, JsonSchema> = {
      decision: decisionSchema('reply'),
      messages: contentMessagesSchema(args.minMessages, args.maxMessages),
    };
    if (canVoice) properties.voice_message = args.voice;
    if (canMeme) properties.meme_message = args.meme;
    return strictObject(properties);
  };

  const variants: JsonSchema[] = [
    strictObject(noReplyProperties),
    replyVariant({
      minMessages: 1,
      maxMessages: 4,
      voice: { type: 'null' },
      meme: { type: 'null' },
    }),
  ];
  if (canVoice) {
    variants.push(replyVariant({
      minMessages: 0,
      maxMessages: 3,
      voice: voiceSchema,
      meme: { type: 'null' },
    }));
  }
  if (canMeme) {
    variants.push(replyVariant({
      minMessages: 0,
      maxMessages: 3,
      voice: { type: 'null' },
      meme: memeSchema,
    }));
  }
  if (canVoice && canMeme) {
    variants.push(replyVariant({
      minMessages: 0,
      maxMessages: 2,
      voice: voiceSchema,
      meme: memeSchema,
    }));
  }

  return {
    ...strictObject({
      result: {
        anyOf: variants,
      },
    }),
    title: 'StructuredReplyEnvelope',
    description: 'A constrained reply decision and its outbound content for one QQBot turn.',
  };
}

export const STRUCTURED_REPLY_JSON_SCHEMA = buildStructuredReplyJsonSchema();
