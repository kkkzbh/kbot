import {
  buildNativeStructuredReplyEnvelopeSchema,
  normalizeStructuredReply,
  STRUCTURED_REPLY_SCHEMA,
  type StructuredReply,
  unwrapNativeStructuredReplyEnvelope,
} from './types.js';
import type { ReplyOutputProtocol } from '../../shared/llm/reply-output-contract.js';
import { ChatReplyV1ParseError, ChatReplyV1Parser } from './chat-reply-v1.js';

const PROVIDER_RESPONSE_DIAGNOSTIC_KEY = '__chatluna_provider_response_diagnostic_v1';

export type ReplyCompilerOutputProtocol = ReplyOutputProtocol;

export type StructuredReplyFailureKind =
  | 'provider_empty_finish'
  | 'provider_tool_calls_lost'
  | 'invalid_structured_json'
  | 'invalid_text_protocol'
  | 'invalid_structured_schema'
  | 'empty_after_flatten';

export interface StructuredReplyProviderDiagnostic {
  requestMode?: string | null;
  providerToolCallCount?: number | null;
  messageToolCallCount?: number | null;
  toolCallChunkCount?: number | null;
  functionCallPresent?: boolean | null;
  providerOutputTokens?: number | null;
  rawMessageKeys?: string[];
  rawChoiceKeys?: string[];
  rawContentKind?: string | null;
  rawContentLength?: number | null;
}

export interface StructuredReplyCompilerDiagnostic {
  failureKind: StructuredReplyFailureKind;
  rawOutputKind: string;
  rawTextLength: number;
  rawTextPreview: string;
  requestMode: string | null;
  providerToolCallCount: number;
  messageToolCallCount: number;
  toolCallChunkCount: number;
  functionCallPresent: boolean;
  providerOutputTokens: number | null;
  rawMessageKeys: string[];
  rawChoiceKeys: string[];
  rawContentKind: string | null;
  rawContentLength: number | null;
  outputProtocol: ReplyCompilerOutputProtocol;
  protocolErrorCode?: string | null;
  protocolErrorLine?: number | null;
}

export class StructuredReplyCompilerError extends Error {
  constructor(
    message: string,
    readonly diagnostic: StructuredReplyCompilerDiagnostic,
  ) {
    super(message);
    this.name = 'StructuredReplyCompilerError';
  }
}

export class StructuredReplyEmptyModelOutputError extends Error {
  constructor(readonly diagnostic: StructuredReplyCompilerDiagnostic) {
    super('structured reply compiler received empty model output.');
    this.name = 'StructuredReplyEmptyModelOutputError';
  }
}

export function flattenModelOutputContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => flattenModelOutputContent(part)).filter(Boolean).join('\n').trim();
  }
  if (!content || typeof content !== 'object') return '';

  const node = content as {
    type?: string;
    content?: unknown;
    attrs?: { content?: unknown };
    children?: unknown[];
  };

  const ownText =
    typeof node.attrs?.content === 'string'
      ? node.attrs.content
      : typeof node.content === 'string'
        ? node.content
        : '';
  const childText = Array.isArray(node.children) ? node.children.map((child) => flattenModelOutputContent(child)).join('\n') : '';
  return `${ownText}\n${childText}`.trim();
}

function detectRawOutputKind(content: unknown): string {
  if (content == null) return 'null';
  if (Array.isArray(content)) return 'array';
  return typeof content;
}

function extractDiagnosticContent(rawModelOutput: unknown): unknown {
  if (!rawModelOutput || typeof rawModelOutput !== 'object' || Array.isArray(rawModelOutput)) {
    return rawModelOutput;
  }

  if (!('content' in rawModelOutput)) {
    return rawModelOutput;
  }

  return (rawModelOutput as { content?: unknown }).content;
}

function extractProviderDiagnostic(rawModelOutput: unknown): StructuredReplyProviderDiagnostic | null {
  if (!rawModelOutput || typeof rawModelOutput !== 'object' || Array.isArray(rawModelOutput)) {
    return null;
  }

  const additionalKwargs = (rawModelOutput as { additional_kwargs?: unknown }).additional_kwargs;
  if (!additionalKwargs || typeof additionalKwargs !== 'object' || Array.isArray(additionalKwargs)) {
    return null;
  }

  const diagnostic = (additionalKwargs as Record<string, unknown>)[PROVIDER_RESPONSE_DIAGNOSTIC_KEY];
  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) {
    return null;
  }

  return diagnostic as StructuredReplyProviderDiagnostic;
}

function countMessageToolCalls(rawModelOutput: unknown): number {
  if (!rawModelOutput || typeof rawModelOutput !== 'object' || Array.isArray(rawModelOutput)) {
    return 0;
  }

  const toolCalls = (rawModelOutput as { tool_calls?: unknown }).tool_calls;
  if (Array.isArray(toolCalls)) return toolCalls.length;
  return 0;
}

function countMessageToolCallChunks(rawModelOutput: unknown): number {
  if (!rawModelOutput || typeof rawModelOutput !== 'object' || Array.isArray(rawModelOutput)) {
    return 0;
  }

  const toolCallChunks = (rawModelOutput as { tool_call_chunks?: unknown }).tool_call_chunks;
  if (Array.isArray(toolCallChunks)) return toolCallChunks.length;
  return 0;
}

function hasFunctionCall(rawModelOutput: unknown): boolean {
  if (!rawModelOutput || typeof rawModelOutput !== 'object' || Array.isArray(rawModelOutput)) {
    return false;
  }

  const additionalKwargs = (rawModelOutput as { additional_kwargs?: unknown }).additional_kwargs;
  if (!additionalKwargs || typeof additionalKwargs !== 'object' || Array.isArray(additionalKwargs)) {
    return false;
  }

  return (additionalKwargs as { function_call?: unknown }).function_call != null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function toFiniteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildCompilerDiagnostic(
  rawModelOutput: unknown,
  rawText: string,
  failureKind: StructuredReplyFailureKind,
  outputProtocol: ReplyCompilerOutputProtocol,
  protocolError?: { code: string; line: number } | null,
): StructuredReplyCompilerDiagnostic {
  const providerDiagnostic = extractProviderDiagnostic(rawModelOutput);
  const messageToolCallCount = Math.max(
    countMessageToolCalls(rawModelOutput),
    toFiniteNumberOrNull(providerDiagnostic?.messageToolCallCount) ?? 0,
  );
  const toolCallChunkCount = Math.max(
    countMessageToolCallChunks(rawModelOutput),
    toFiniteNumberOrNull(providerDiagnostic?.toolCallChunkCount) ?? 0,
  );

  return {
    failureKind,
    rawOutputKind: detectRawOutputKind(rawModelOutput),
    rawTextLength: rawText.length,
    rawTextPreview: rawText.slice(0, 300),
    requestMode: typeof providerDiagnostic?.requestMode === 'string' ? providerDiagnostic.requestMode : null,
    providerToolCallCount: toFiniteNumberOrNull(providerDiagnostic?.providerToolCallCount) ?? 0,
    messageToolCallCount,
    toolCallChunkCount,
    functionCallPresent:
      typeof providerDiagnostic?.functionCallPresent === 'boolean'
        ? providerDiagnostic.functionCallPresent
        : hasFunctionCall(rawModelOutput),
    providerOutputTokens: toFiniteNumberOrNull(providerDiagnostic?.providerOutputTokens),
    rawMessageKeys: toStringArray(providerDiagnostic?.rawMessageKeys),
    rawChoiceKeys: toStringArray(providerDiagnostic?.rawChoiceKeys),
    rawContentKind: typeof providerDiagnostic?.rawContentKind === 'string' ? providerDiagnostic.rawContentKind : null,
    rawContentLength: toFiniteNumberOrNull(providerDiagnostic?.rawContentLength),
    outputProtocol,
    protocolErrorCode: protocolError?.code ?? null,
    protocolErrorLine: protocolError?.line ?? null,
  };
}

function resolveEmptyFailureKind(rawModelOutput: unknown): StructuredReplyFailureKind {
  const rawOutputKind = detectRawOutputKind(extractDiagnosticContent(rawModelOutput));
  const providerDiagnostic = extractProviderDiagnostic(rawModelOutput);
  const providerToolCallCount = toFiniteNumberOrNull(providerDiagnostic?.providerToolCallCount) ?? 0;
  const messageToolCallCount = Math.max(
    countMessageToolCalls(rawModelOutput),
    toFiniteNumberOrNull(providerDiagnostic?.messageToolCallCount) ?? 0,
  );
  const toolCallChunkCount = Math.max(
    countMessageToolCallChunks(rawModelOutput),
    toFiniteNumberOrNull(providerDiagnostic?.toolCallChunkCount) ?? 0,
  );
  const functionCallPresent =
    typeof providerDiagnostic?.functionCallPresent === 'boolean'
      ? providerDiagnostic.functionCallPresent
      : hasFunctionCall(rawModelOutput);

  if (providerToolCallCount > 0 && messageToolCallCount < 1 && toolCallChunkCount < 1 && !functionCallPresent) {
    return 'provider_tool_calls_lost';
  }

  if (rawOutputKind === 'array' || rawOutputKind === 'object') {
    return 'empty_after_flatten';
  }

  return 'provider_empty_finish';
}

export class StructuredReplyCompilerService {
  constructor(
    private readonly rawModelOutput:
      | unknown
      | {
          content?: unknown;
          additional_kwargs?: Record<string, unknown>;
          tool_calls?: unknown[];
          tool_call_chunks?: unknown[];
        },
    private readonly options: {
      outputProtocol?: ReplyCompilerOutputProtocol;
      canVoice?: boolean;
      canMeme?: boolean;
    } = {},
  ) {}

  compile(): StructuredReply {
    const normalizedOutput =
      this.rawModelOutput && typeof this.rawModelOutput === 'object' && !Array.isArray(this.rawModelOutput) && 'content' in this.rawModelOutput
        ? this.rawModelOutput
        : { content: this.rawModelOutput };
    const rawText = flattenModelOutputContent(normalizedOutput.content);
    const outputProtocol = this.options.outputProtocol ?? 'native_chat_json_schema';
    if (!rawText) {
      throw new StructuredReplyEmptyModelOutputError(
        buildCompilerDiagnostic(normalizedOutput, rawText, resolveEmptyFailureKind(normalizedOutput), outputProtocol),
      );
    }

    let rawReply: unknown;
    if (outputProtocol === 'chat_reply_v1') {
      try {
        rawReply = new ChatReplyV1Parser().parse(rawText);
      } catch (error) {
        const protocolError = error instanceof ChatReplyV1ParseError
          ? { code: error.code, line: error.line }
          : null;
        throw new StructuredReplyCompilerError(
          `structured reply compiler expected CHAT_REPLY_V1: ${(error as Error).message}`,
          buildCompilerDiagnostic(normalizedOutput, rawText, 'invalid_text_protocol', outputProtocol, protocolError),
        );
      }
    } else {
      try {
        rawReply = JSON.parse(rawText);
      } catch (error) {
        throw new StructuredReplyCompilerError(
          `structured reply compiler expected JSON: ${(error as Error).message}`,
          buildCompilerDiagnostic(normalizedOutput, rawText, 'invalid_structured_json', outputProtocol),
        );
      }

      const parsedEnvelope = buildNativeStructuredReplyEnvelopeSchema({
        canVoice: this.options.canVoice,
        canMeme: this.options.canMeme,
      }).safeParse(rawReply);
      if (!parsedEnvelope.success) {
        throw new StructuredReplyCompilerError(
          `structured reply compiler received invalid provider envelope: ${parsedEnvelope.error.issues
            .map((issue) => `${issue.path.join('.') || 'root'} ${issue.message}`)
            .join('; ')}`,
          buildCompilerDiagnostic(normalizedOutput, rawText, 'invalid_structured_schema', outputProtocol),
        );
      }
      rawReply = unwrapNativeStructuredReplyEnvelope(parsedEnvelope.data);
    }

    const parsedReply = STRUCTURED_REPLY_SCHEMA.safeParse(rawReply);
    if (!parsedReply.success) {
      throw new StructuredReplyCompilerError(
        `structured reply compiler received invalid StructuredReply: ${parsedReply.error.issues
          .map((issue) => `${issue.path.join('.') || 'root'} ${issue.message}`)
          .join('; ')}`,
        buildCompilerDiagnostic(normalizedOutput, rawText, 'invalid_structured_schema', outputProtocol),
      );
    }

    const normalized = normalizeStructuredReply(parsedReply.data);
    if (!normalized) {
      throw new StructuredReplyCompilerError(
        'structured reply compiler failed to normalize StructuredReply.',
        buildCompilerDiagnostic(normalizedOutput, rawText, 'invalid_structured_schema', outputProtocol),
      );
    }

    return normalized;
  }
}
