import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => ({
  h: {
    parse: () => [],
  },
}));

import { buildNativeStructuredReplyEnvelopeSchema } from '../src/plugins/reply/pipeline/types.js';
import { buildStructuredReplyJsonSchema } from '../src/plugins/shared/llm/structured-reply-schema.js';

type JsonSchema = Record<string, unknown>;

const SUPPORTED_JSON_SCHEMA_KEYS = new Set([
  'additionalProperties',
  'anyOf',
  'description',
  'enum',
  'items',
  'maxItems',
  'maxLength',
  'minItems',
  'minLength',
  'properties',
  'required',
  'title',
  'type',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonSchemaAccepts(schema: JsonSchema, value: unknown): boolean {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_JSON_SCHEMA_KEYS.has(key)) {
      throw new Error(`unsupported JSON Schema keyword in contract test: ${key}`);
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const variants = schema.anyOf as JsonSchema[];
    if (!variants.some((variant) => jsonSchemaAccepts(variant, value))) return false;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    return false;
  }

  if (schema.type === 'null') return value === null;
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false;
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false;
    return true;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return false;
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
    if (isRecord(schema.items)) {
      return value.every((item) => jsonSchemaAccepts(schema.items as JsonSchema, item));
    }
    return true;
  }
  if (schema.type === 'object') {
    if (!isRecord(value)) return false;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    if (required.some((key) => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false) {
      if (Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        if (!isRecord(propertySchema) || !jsonSchemaAccepts(propertySchema, value[key])) return false;
      }
    }
  }

  return true;
}

interface Capabilities {
  canVoice: boolean;
  canMeme: boolean;
}

interface ContractCase {
  name: string;
  value: unknown;
  accepted: boolean;
}

interface ReplyFields {
  messages: unknown;
  voice?: unknown;
  meme?: unknown;
}

function message(content = '好'): Record<string, unknown> {
  return { type: 'message', content };
}

function structuredBlock(content = '列表'): Record<string, unknown> {
  return { type: 'structured_block', content };
}

function image(assetRef = 'asset:image:1', alt = '图片'): Record<string, unknown> {
  return { type: 'image', assetRef, alt };
}

function voice(content = '好'): Record<string, unknown> {
  return { type: 'voice', content };
}

function meme(content = '开心'): Record<string, unknown> {
  return { type: 'meme', content };
}

function replyEnvelope(
  capabilities: Capabilities,
  fields: ReplyFields,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    decision: 'reply',
    messages: fields.messages,
  };
  if (capabilities.canVoice || Object.hasOwn(fields, 'voice')) {
    result.voice_message = fields.voice ?? null;
  }
  if (capabilities.canMeme || Object.hasOwn(fields, 'meme')) {
    result.meme_message = fields.meme ?? null;
  }
  return { result };
}

function noReplyEnvelope(
  capabilities: Capabilities,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    decision: 'no_reply',
    messages: null,
  };
  if (capabilities.canVoice) result.voice_message = null;
  if (capabilities.canMeme) result.meme_message = null;
  return { result: { ...result, ...overrides } };
}

function withoutResultField(
  envelope: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const result = { ...(envelope.result as Record<string, unknown>) };
  delete result[field];
  return { result };
}

function buildContractCorpus(capabilities: Capabilities): ContractCase[] {
  const textReply = () => replyEnvelope(capabilities, { messages: [message()] });
  const cases: ContractCase[] = [
    { name: 'canonical no_reply', value: noReplyEnvelope(capabilities), accepted: true },
    { name: 'one text message', value: textReply(), accepted: true },
    {
      name: 'four text messages',
      value: replyEnvelope(capabilities, { messages: Array.from({ length: 4 }, () => message()) }),
      accepted: true,
    },
    {
      name: 'five text messages',
      value: replyEnvelope(capabilities, { messages: Array.from({ length: 5 }, () => message()) }),
      accepted: false,
    },
    {
      name: 'reply with no outbound content',
      value: replyEnvelope(capabilities, { messages: [] }),
      accepted: false,
    },
    {
      name: 'reply with null messages',
      value: replyEnvelope(capabilities, { messages: null }),
      accepted: false,
    },
    {
      name: 'no_reply with an array of messages',
      value: noReplyEnvelope(capabilities, { messages: [] }),
      accepted: false,
    },
    {
      name: 'empty text content',
      value: replyEnvelope(capabilities, { messages: [message('')] }),
      accepted: false,
    },
    {
      name: 'empty structured block content',
      value: replyEnvelope(capabilities, { messages: [structuredBlock('')] }),
      accepted: false,
    },
    {
      name: 'empty image asset reference',
      value: replyEnvelope(capabilities, { messages: [image('', '图片')] }),
      accepted: false,
    },
    {
      name: 'empty image alt text',
      value: replyEnvelope(capabilities, { messages: [image('asset:image:1', '')] }),
      accepted: false,
    },
    {
      name: 'voice inside ordered messages',
      value: replyEnvelope(capabilities, { messages: [voice()] }),
      accepted: false,
    },
    {
      name: 'meme inside ordered messages',
      value: replyEnvelope(capabilities, { messages: [meme()] }),
      accepted: false,
    },
    {
      name: 'extra result field',
      value: {
        result: {
          ...(textReply().result as Record<string, unknown>),
          extra: true,
        },
      },
      accepted: false,
    },
    {
      name: 'extra envelope field',
      value: { ...textReply(), extra: true },
      accepted: false,
    },
  ];

  for (const capability of [
    {
      name: 'voice',
      enabled: capabilities.canVoice,
      field: 'voice_message',
      value: voice(),
    },
    {
      name: 'meme',
      enabled: capabilities.canMeme,
      field: 'meme_message',
      value: meme(),
    },
  ] as const) {
    const presentNull = capability.name === 'voice'
      ? replyEnvelope(capabilities, { messages: [message()], voice: null })
      : replyEnvelope(capabilities, { messages: [message()], meme: null });
    const presentObject = capability.name === 'voice'
      ? replyEnvelope(capabilities, { messages: [message()], voice: capability.value })
      : replyEnvelope(capabilities, { messages: [message()], meme: capability.value });
    const presentArray = capability.name === 'voice'
      ? replyEnvelope(capabilities, { messages: [message()], voice: [capability.value] })
      : replyEnvelope(capabilities, { messages: [message()], meme: [capability.value] });

    cases.push(
      {
        name: `${capability.name} null follows capability`,
        value: presentNull,
        accepted: capability.enabled,
      },
      {
        name: `${capability.name} object follows capability`,
        value: presentObject,
        accepted: capability.enabled,
      },
      {
        name: `${capability.name} field is required when enabled`,
        value: withoutResultField(textReply(), capability.field),
        accepted: !capability.enabled,
      },
      {
        name: `${capability.name} singleton rejects an array`,
        value: presentArray,
        accepted: false,
      },
    );
  }

  if (capabilities.canVoice) {
    cases.push(
      {
        name: 'no_reply rejects a voice object',
        value: noReplyEnvelope(capabilities, { voice_message: voice() }),
        accepted: false,
      },
      {
        name: 'voice content length 180',
        value: replyEnvelope(capabilities, { messages: [], voice: voice('v'.repeat(180)) }),
        accepted: true,
      },
      {
        name: 'voice content length 181',
        value: replyEnvelope(capabilities, { messages: [], voice: voice('v'.repeat(181)) }),
        accepted: false,
      },
      {
        name: 'empty voice content',
        value: replyEnvelope(capabilities, { messages: [], voice: voice('') }),
        accepted: false,
      },
      {
        name: 'four total messages including voice',
        value: replyEnvelope(capabilities, {
          messages: Array.from({ length: 3 }, () => message()),
          voice: voice(),
        }),
        accepted: true,
      },
      {
        name: 'five total messages including voice',
        value: replyEnvelope(capabilities, {
          messages: Array.from({ length: 4 }, () => message()),
          voice: voice(),
        }),
        accepted: false,
      },
    );
  }

  if (capabilities.canMeme) {
    cases.push(
      {
        name: 'no_reply rejects a meme object',
        value: noReplyEnvelope(capabilities, { meme_message: meme() }),
        accepted: false,
      },
      {
        name: 'meme content length 80',
        value: replyEnvelope(capabilities, { messages: [], meme: meme('m'.repeat(80)) }),
        accepted: true,
      },
      {
        name: 'meme content length 81',
        value: replyEnvelope(capabilities, { messages: [], meme: meme('m'.repeat(81)) }),
        accepted: false,
      },
      {
        name: 'empty meme content',
        value: replyEnvelope(capabilities, { messages: [], meme: meme('') }),
        accepted: false,
      },
      {
        name: 'four total messages including meme',
        value: replyEnvelope(capabilities, {
          messages: Array.from({ length: 3 }, () => message()),
          meme: meme(),
        }),
        accepted: true,
      },
      {
        name: 'five total messages including meme',
        value: replyEnvelope(capabilities, {
          messages: Array.from({ length: 4 }, () => message()),
          meme: meme(),
        }),
        accepted: false,
      },
    );
  }

  if (capabilities.canVoice && capabilities.canMeme) {
    cases.push(
      {
        name: 'four total messages including voice and meme',
        value: replyEnvelope(capabilities, {
          messages: [message(), message()],
          voice: voice(),
          meme: meme(),
        }),
        accepted: true,
      },
      {
        name: 'five total messages including voice and meme',
        value: replyEnvelope(capabilities, {
          messages: [message(), message(), message()],
          voice: voice(),
          meme: meme(),
        }),
        accepted: false,
      },
    );
  }

  return cases;
}

const CAPABILITY_CASES = [
  { name: 'text only', capabilities: { canVoice: false, canMeme: false } },
  { name: 'voice only', capabilities: { canVoice: true, canMeme: false } },
  { name: 'meme only', capabilities: { canVoice: false, canMeme: true } },
  { name: 'voice and meme', capabilities: { canVoice: true, canMeme: true } },
] as const;

describe.each(CAPABILITY_CASES)('structured reply schema contract: $name', ({ capabilities }) => {
  const providerSchema = buildStructuredReplyJsonSchema(capabilities);
  const runtimeSchema = buildNativeStructuredReplyEnvelopeSchema(capabilities);

  it.each(buildContractCorpus(capabilities))('$name', ({ value, accepted }) => {
    expect(jsonSchemaAccepts(providerSchema, value), 'provider JSON Schema').toBe(accepted);
    expect(runtimeSchema.safeParse(value).success, 'runtime Zod').toBe(accepted);
  });
});
