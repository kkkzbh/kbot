import { randomUUID } from 'node:crypto';
import { StructuredTool } from '@langchain/core/tools';
import type { BaseMessage } from '@langchain/core/messages';
import type { Session } from 'koishi';
import type {
  ChatLunaTool,
  ChatLunaToolRunnable,
} from 'koishi-plugin-chatluna/llm-core/platform/types';
import { z } from 'zod';
import { QQBOT_SUBMIT_REPLY_TOOL_NAME } from '../../shared/internal-tool-names.js';
import { encodeChatReplyV1 } from '../pipeline/chat-reply-v1.js';
import {
  buildNativeStructuredReplyEnvelopeSchema,
  unwrapNativeStructuredReplyEnvelope,
} from '../pipeline/types.js';
import { normalizeStructuredReplyForDelivery } from '../pipeline/normalizer.js';
import { assertExplicitModalityInvariant } from '../modality/explicit-invariant.js';

const FINAL_REPLY_SCHEMA = buildNativeStructuredReplyEnvelopeSchema({
  canVoice: true,
  canMeme: true,
});

export interface ReplyFinalizerRequestContext {
  canVoice: boolean;
  canMeme: boolean;
  explicitVoiceRequested: boolean;
  explicitMemeRequested: boolean;
  hasImageAssetRef: (assetRef: string) => boolean;
}

function sameContext(
  left: ReplyFinalizerRequestContext,
  right: ReplyFinalizerRequestContext,
): boolean {
  return left.canVoice === right.canVoice
    && left.canMeme === right.canMeme
    && left.explicitVoiceRequested === right.explicitVoiceRequested
    && left.explicitMemeRequested === right.explicitMemeRequested
    && left.hasImageAssetRef === right.hasImageAssetRef;
}

export class ReplyFinalizerRequestRegistry {
  private readonly requests = new Map<string, ReplyFinalizerRequestContext>();

  begin(requestId: string, context: ReplyFinalizerRequestContext): void {
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) {
      throw new Error('reply finalizer request identity is required.');
    }
    if (context.explicitVoiceRequested && !context.canVoice) {
      throw new Error('reply finalizer explicit voice intent must be permitted by the turn contract.');
    }
    if (context.explicitMemeRequested && !context.canMeme) {
      throw new Error('reply finalizer explicit sticker intent must be permitted by the turn contract.');
    }
    const current = this.requests.get(normalizedRequestId);
    if (current && !sameContext(current, context)) {
      throw new Error(`reply finalizer request ${normalizedRequestId} changed capability ownership.`);
    }
    this.requests.set(normalizedRequestId, { ...context });
  }

  get(requestId: string): ReplyFinalizerRequestContext | undefined {
    const context = this.requests.get(requestId.trim());
    return context ? { ...context } : undefined;
  }

  finish(requestId: string): boolean {
    return this.requests.delete(requestId.trim());
  }
}

export const replyFinalizerRequestRegistry = new ReplyFinalizerRequestRegistry();

function selectsTerminalReplyContract(history: BaseMessage[]): boolean {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.getType() !== 'human') continue;
    const rawContract = message.additional_kwargs?.qqbot_final_response_contract;
    if (!rawContract || typeof rawContract !== 'object' || Array.isArray(rawContract)) return false;
    return (rawContract as Record<string, unknown>).terminalTool === QQBOT_SUBMIT_REPLY_TOOL_NAME;
  }
  return false;
}

function requireMainRequestContext(
  config: ChatLunaToolRunnable,
  registry: ReplyFinalizerRequestRegistry,
): ReplyFinalizerRequestContext {
  const agentContext = config.configurable.agentContext;
  if (agentContext?.kind !== 'main') {
    throw new Error('qqbot_submit_reply is available only to the main Agent.');
  }
  const requestId = agentContext.requestId?.trim();
  if (!requestId) {
    throw new Error('qqbot_submit_reply requires a request-scoped Agent identity.');
  }
  const context = registry.get(requestId);
  if (!context) {
    throw new Error(`qqbot_submit_reply has no active reply contract for request ${requestId}.`);
  }
  return context;
}

export class ReplyFinalizerTool extends StructuredTool {
  name = QQBOT_SUBMIT_REPLY_TOOL_NAME;

  description = [
    'Submit the final user-visible QQ reply after all required research and actions are complete.',
    'Every main Agent reply must end by calling this tool exactly once.',
    'Use result.messages for ordered text, structured blocks, and tool-produced images.',
    'Set voice_message or meme_message only when the current turn contract permits it.',
    'Do not emit final prose outside this tool.',
  ].join(' ');

  schema = FINAL_REPLY_SCHEMA;

  constructor(private readonly registry: ReplyFinalizerRequestRegistry) {
    super({});
  }

  async _call(
    input: z.infer<typeof FINAL_REPLY_SCHEMA>,
    _runManager: unknown,
    config: ChatLunaToolRunnable,
  ): Promise<{ lc_direct_tool_output: true; output: string }> {
    const context = requireMainRequestContext(config, this.registry);
    const envelope = FINAL_REPLY_SCHEMA.parse(input);
    const voiceMessage = envelope.result.voice_message;
    const memeMessage = envelope.result.meme_message;

    if (!context.canVoice && voiceMessage != null) {
      throw new Error('voice_message is unavailable for the current turn; submit it as null.');
    }
    if (!context.canMeme && memeMessage != null) {
      throw new Error('meme_message is unavailable for the current turn; submit it as null.');
    }
    const reply = normalizeStructuredReplyForDelivery(unwrapNativeStructuredReplyEnvelope(envelope));
    assertExplicitModalityInvariant({
      voiceReason: context.explicitVoiceRequested ? 'explicit_request' : 'not_admitted',
      stickerReason: context.explicitMemeRequested ? 'explicit_request' : 'not_admitted',
    }, {
      stage: 'orchestration',
      reply,
    });
    for (const message of reply.outbound_messages ?? []) {
      if (message.type !== 'image') continue;
      if (!context.hasImageAssetRef(message.assetRef)) {
        throw new Error(`image assetRef is unavailable for the current reply run: ${message.assetRef}`);
      }
    }

    const nonce = randomUUID().replaceAll('-', '').slice(0, 16);
    return {
      lc_direct_tool_output: true,
      output: encodeChatReplyV1(reply, nonce),
    };
  }
}

export function createReplyFinalizerToolEntry(
  registry: ReplyFinalizerRequestRegistry = replyFinalizerRequestRegistry,
): ChatLunaTool {
  return {
    name: QQBOT_SUBMIT_REPLY_TOOL_NAME,
    description: 'Submit the validated final QQ reply. Internal main-Agent terminal tool.',
    selector: selectsTerminalReplyContract,
    authorization: (session: Session) => session.platform === 'onebot',
    createTool: () => new ReplyFinalizerTool(registry),
    meta: {
      internalContract: true,
      source: 'extension',
      group: 'qqbot-internal',
      tags: ['internal', 'terminal-reply'],
      defaultAvailability: {
        enabled: true,
        main: true,
        chatluna: true,
        characterScope: 'all',
      },
    },
  };
}
