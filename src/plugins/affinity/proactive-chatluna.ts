import type { Session } from 'koishi';
import type { ReplyOutputProtocol } from '../shared/llm/reply-output-contract.js';
import type { ResolvedModelTarget } from '../model-config/index.js';
import {
  buildOutboundMessagePlanFromReplyPlan,
  renderOutboundMessageSegmentsHistoryText,
  type ReplyTransportPlan,
} from '../shared/outbound/index.js';
import {
  injectPromptEnvelope,
  type PromptEnvelopeMessage,
} from '../shared/prompt-context/index.js';
import {
  applyReplyOutputContract,
  buildReplyTransportPlanFromResolvedActions,
  buildReplyPromptCompilerInput,
  buildReplyTurnInput,
  compileReplyPromptEnvelope,
  isVoiceOutputConfigured,
  ReplyOrchestratorService,
  type ReplyInputMessageLike,
  type RuntimeConfig as ReplyVoiceRuntimeConfig,
  type TurnContext,
} from '../reply/index.js';
import type {
  AffinityRandomGenerationInput,
  AffinityRandomGenerationResult,
} from './proactive-types.js';
import {
  buildProactiveMemorySummary,
  buildProactiveTaskFragment,
  resolveProactiveEventTypeHint,
  summarizeProactiveContext,
} from './proactive-task.js';

type ChatLunaMessageLike = ReplyInputMessageLike;

export type AffinityProactiveChatLunaService = {
  chat?: (
    session: Session,
    conversation: AffinityProactiveChatLunaConversation,
    message: ChatLunaMessageLike,
    options?: {
      event?: Record<string, unknown>;
      stream?: boolean;
      variables?: Record<string, unknown>;
      requestId?: string;
      toolMask?: unknown;
    },
  ) => Promise<ChatLunaMessageLike | null | undefined>;
  contextManager?: {
    inject: (options: {
      name: string;
      value: PromptEnvelopeMessage[];
      once?: boolean;
      conversationId?: string;
      stage?: string;
    }) => void;
  };
};

export type AffinityProactiveChatLunaConversation = {
  id: string;
  bindingKey: string;
  title: string;
  model: string;
  preset: string;
  chatMode: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastChatAt?: Date | null;
  status: string;
  latestMessageId?: string | null;
  additional_kwargs?: string | null;
  compression?: string | null;
  archivedAt?: Date | null;
  archiveId?: string | null;
  autoTitle?: boolean | null;
  [key: string]: unknown;
};

export interface AffinityProactiveGenerationResult extends AffinityRandomGenerationResult {
  transportPlan: ReplyTransportPlan | null;
  outputProtocol: ReplyOutputProtocol | null;
}

const proactiveReplyOrchestrator = new ReplyOrchestratorService();

function createNoopChatEvents(): Record<string, () => Promise<void>> {
  return {
    'llm-new-token': async () => undefined,
    'llm-queue-waiting': async () => undefined,
    'llm-used-token-count': async () => undefined,
    'llm-call-tool': async () => undefined,
    'llm-new-chunk': async () => undefined,
  };
}

function resolveStickerAvailableCount(session: Session): number {
  const state = (session as Session & { state?: Record<string, unknown> }).state;
  const sticker = state?.qqSticker;
  if (!sticker || typeof sticker !== 'object' || Array.isArray(sticker)) return 0;
  const count = (sticker as { availableCount?: unknown }).availableCount;
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function buildCapabilitySnapshot(args: {
  runtime: ReplyVoiceRuntimeConfig;
  session: Session;
}): NonNullable<TurnContext['capabilitySnapshot']> {
  const stickerAvailableCount = resolveStickerAvailableCount(args.session);
  return {
    canMultiline: true,
    canMention: true,
    canVoice: isVoiceOutputConfigured(args.runtime),
    voiceOutputLanguage: args.runtime.voiceOutputLanguage,
    canSticker: stickerAvailableCount > 0,
    stickerAvailableCount,
    source: 'affinity_proactive',
  };
}

function buildProactiveTriggerText(input: AffinityRandomGenerationInput): string {
  return [
    '[affinity-proactive-trigger]',
    `direction: ${input.direction}`,
    '请根据已注入的主动发言任务判断是否发送。这不是新的用户聊天内容。',
  ].join('\n');
}

function skipResult(reason: string): AffinityProactiveGenerationResult {
  return {
    shouldSend: false,
    message: null,
    contextSeedSummary: null,
    eventTypeHint: 'none',
    memorySummary: null,
    reason,
    risk: 'low',
    skipReason: reason,
    transportPlan: null,
    outputProtocol: null,
  };
}

export async function generateAffinityProactiveViaChatLuna(args: {
  chatluna: AffinityProactiveChatLunaService | undefined;
  conversation: AffinityProactiveChatLunaConversation;
  session: Session;
  input: AffinityRandomGenerationInput;
  requestId: string;
  runtime: ReplyVoiceRuntimeConfig;
  modelTarget: ResolvedModelTarget;
}): Promise<AffinityProactiveGenerationResult> {
  const chat = args.chatluna?.chat?.bind(args.chatluna);
  const contextManager = args.chatluna?.contextManager;
  const conversationId = args.conversation.id.trim();
  if (typeof chat !== 'function') {
    throw new Error('affinity proactive generation requires chatluna.chat.');
  }
  if (!contextManager) {
    throw new Error('affinity proactive generation requires chatluna.contextManager.');
  }
  if (!conversationId) {
    throw new Error('affinity proactive generation requires a conversation id.');
  }

  const runtime = args.runtime;
  const capabilitySnapshot = buildCapabilitySnapshot({
    runtime,
    session: args.session,
  });
  const message: ChatLunaMessageLike = {
    content: buildProactiveTriggerText(args.input),
  };
  const outputContract = applyReplyOutputContract(message, {
    modelTarget: args.modelTarget,
    capabilitySnapshot,
  });
  const turnInput = buildReplyTurnInput(args.session, { conversationId }, message);
  const taskFragment = buildProactiveTaskFragment(args.input);
  const envelope = compileReplyPromptEnvelope(buildReplyPromptCompilerInput({
    input: turnInput,
    capabilitySnapshot,
    continuationContext: null,
  }, [taskFragment], {
    outputProtocol: outputContract.protocol,
  }));
  if (!envelope?.messages.length) return skipResult('prompt_envelope_empty');

  injectPromptEnvelope(contextManager, {
    name: 'qqbot_affinity_proactive_prompt_envelope',
    envelope,
    once: true,
    conversationId,
  });

  try {
    const response = await chat(
      args.session,
      args.conversation,
      message,
      {
        event: createNoopChatEvents(),
        stream: false,
        variables: {},
        requestId: args.requestId,
      },
    );
    const orchestration = await proactiveReplyOrchestrator.handle(turnInput, args.session, {
      responseMessage: response,
      outputProtocol: outputContract.protocol,
      capabilitySnapshot,
      routeHint: 'agent',
    });
    if (orchestration.status === 'no_reply') return skipResult('provider_no_reply');
    if (orchestration.status !== 'ready') return skipResult('provider_await_model');
    if (orchestration.actions.length === 1 && orchestration.actions[0]?.kind === 'no_reply') {
      return skipResult('provider_no_reply');
    }

    const transportPlan = buildReplyTransportPlanFromResolvedActions(orchestration.actions);
    const visibleSummary = renderOutboundMessageSegmentsHistoryText(
      buildOutboundMessagePlanFromReplyPlan(transportPlan).segments,
    );
    if (!transportPlan.segments.length || !visibleSummary) return skipResult('empty_reply_plan');

    return {
      shouldSend: true,
      message: visibleSummary,
      contextSeedSummary: summarizeProactiveContext(args.input),
      eventTypeHint: resolveProactiveEventTypeHint(args.input.direction),
      memorySummary: buildProactiveMemorySummary(args.input, visibleSummary),
      reason: 'chatluna_provider_reply',
      risk: 'low',
      skipReason: null,
      transportPlan,
      outputProtocol: outputContract.protocol,
    };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'StructuredReplyCompilerError'
      ? 'structured_reply_invalid'
      : error instanceof Error && error.name === 'StructuredReplyEmptyModelOutputError'
        ? 'empty_model_output'
        : 'chatluna_generation_error';
    return skipResult(reason);
  }
}
