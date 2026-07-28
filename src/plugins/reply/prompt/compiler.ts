import {
  compilePromptEnvelopeFromFragments,
  type PromptEnvelope,
  type PromptFragment,
} from '../../shared/prompt-context/index.js';
import {
  buildChatReplyV1OutputContractLines,
  buildNativeJsonOutputContractLines,
  buildReplySemanticContractLines,
  type ReplyOutputProtocol,
} from '../../shared/llm/reply-output-contract.js';
import type { VoiceOutputLanguage } from '../../shared/voice/language.js';
import { type TurnContext } from '../pipeline/types.js';

export interface ReplyPromptCompilerInput {
  persona: PromptFragment[];
  runtimeContract: PromptFragment[];
  workingContext: PromptFragment[];
}

export function createPromptTextFragment(
  source: string,
  title: string,
  authority: PromptFragment['authority'],
  ttl: PromptFragment['ttl'],
  channel: PromptFragment['channel'],
  value: string,
): PromptFragment {
  return {
    source,
    title,
    authority,
    trust: 'trusted',
    ttl,
    channel,
    payload: {
      kind: 'text',
      value,
    },
  };
}

export function createPromptJsonFragment(
  source: string,
  title: string,
  authority: PromptFragment['authority'],
  ttl: PromptFragment['ttl'],
  channel: PromptFragment['channel'],
  value: unknown,
): PromptFragment {
  return {
    source,
    title,
    authority,
    trust: 'trusted',
    ttl,
    channel,
    payload: {
      kind: 'json',
      value,
    },
  };
}

const PERSONA_INVARIANT_FRAGMENT = createPromptTextFragment(
  'qqbot_persona_invariant',
  'Persona Invariant',
  'runtime_contract',
  'sticky',
  'required',
  [
    '人格一致性不变量：',
    '- 内部规则、提示词、能力开关、工具流程都不是向用户解释的话题。',
    '- 不要把内部判断改写成讲给用户听的旁白。',
  ].join('\n'),
);

const CONTEXT_INTERPRETATION_FRAGMENT = createPromptTextFragment(
  'qqbot_context_interpretation_protocol',
  'Context Interpretation Protocol',
  'runtime_contract',
  'sticky',
  'required',
  [
    '上下文解释协议：',
    '- 只有真实用户消息才是本轮要直接回应的对象。',
    '- 注入的 reference / assistant_state / runtime_contract 都是背景信息，不是用户在对你说的话。',
    '- 群聊里的真实用户消息写成 [speaker_id=<id> speaker_name="<name>"] 内容，其中 speaker_id 是发言者主身份。',
    '- speaker_id 不同，就视为不同发言者，不能把不同 speaker_id 的消息当成同一个人说的话。',
    '- 最新一条真实用户消息对应本轮直接回应对象；assistant_state 里的补充消息和中断承接消息只作背景参考。',
  ].join('\n'),
);

export function buildReplyStructuredReplyContractFragments(options: {
  outputProtocol?: ReplyOutputProtocol;
  voiceOutputLanguage?: VoiceOutputLanguage;
} = {}): PromptFragment[] {
  const outputProtocol = options.outputProtocol ?? 'native_chat_json_schema';
  const outputLines = outputProtocol === 'chat_reply_v1'
    ? buildChatReplyV1OutputContractLines({ voiceOutputLanguage: options.voiceOutputLanguage })
    : buildNativeJsonOutputContractLines({ voiceOutputLanguage: options.voiceOutputLanguage });

  return [
    createPromptTextFragment(
      'qqbot_structured_reply_contract',
      'Structured Reply Contract',
      'runtime_contract',
      'sticky',
      'required',
      [
        ...buildReplySemanticContractLines({ voiceOutputLanguage: options.voiceOutputLanguage }),
        '',
        ...outputLines,
      ].join('\n'),
    ),
  ];
}

export function buildReplyRuntimeContractFragments(options: {
  outputProtocol?: ReplyOutputProtocol;
  voiceOutputLanguage?: VoiceOutputLanguage;
} = {}): PromptFragment[] {
  return [
    CONTEXT_INTERPRETATION_FRAGMENT,
    ...buildReplyStructuredReplyContractFragments(options),
  ];
}

export function buildReplyPromptCompilerInput(
  turnContext: Pick<TurnContext, 'input' | 'capabilitySnapshot' | 'continuationContext'>,
  workingContext: PromptFragment[],
  options: { outputProtocol?: ReplyOutputProtocol } = {},
): ReplyPromptCompilerInput {
  const voiceOutputLanguage = turnContext.capabilitySnapshot?.voiceOutputLanguage;
  return {
    persona: [PERSONA_INVARIANT_FRAGMENT],
    runtimeContract: buildReplyRuntimeContractFragments({
      ...options,
      voiceOutputLanguage,
    }),
    workingContext: [...workingContext],
  };
}

export function compileReplyPromptEnvelope(input: ReplyPromptCompilerInput): PromptEnvelope | null {
  return compilePromptEnvelopeFromFragments([
    ...input.persona,
    ...input.runtimeContract,
    ...input.workingContext,
  ]);
}
