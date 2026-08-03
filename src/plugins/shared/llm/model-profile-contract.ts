import type { ModelDefinition } from '../../model-config/index.js';
import {
  createReplyOutputContract,
  type ReplyOutputContract,
  type ReplyOutputProtocol,
} from './reply-output-contract.js';
import type { VoiceOutputLanguage } from '../voice/language.js';

export type MainChatReplyOutputContract = ReplyOutputContract;

function requireReplyProtocol(model: ModelDefinition): ReplyOutputProtocol {
  const protocol = model.structuredOutputProtocol;
  if (
    protocol === 'native_chat_json_schema'
    || protocol === 'native_responses_json_schema'
    || protocol === 'chat_reply_v1'
  ) {
    return protocol;
  }
  throw new Error(
    `main.chat model ${model.id} requires a supported structured output protocol.`,
  );
}

function requireRequestMode(
  model: ModelDefinition,
): 'chat_completions' | 'responses' {
  if (model.requestMode === 'chat_completions' || model.requestMode === 'responses') {
    return model.requestMode;
  }
  throw new Error(`main.chat model ${model.id} requires a chat request mode.`);
}

export function buildModelRequestOverrides(args: {
  canonicalModel: string;
  model: ModelDefinition;
}): Record<string, unknown> {
  const { model } = args;
  const defaults = model.requestDefaults as ModelDefinition['requestDefaults'] & {
    reasoningEffort?: string;
    thinkingMode?: 'enabled' | 'disabled';
  };
  const requestMode = requireRequestMode(model);
  return {
    qqbot_request_mode: requestMode,
    qqbot_canonical_model: args.canonicalModel,
    qqbot_transport_model: model.transportModel,
    qqbot_tool_profile: 'qqbot_openai_main_chat',
    ...(defaults.temperature === undefined
      ? {}
      : { temperature: defaults.temperature }),
    ...(defaults.topP === undefined ? {} : { top_p: defaults.topP }),
    ...(defaults.maxOutputTokens === undefined
      ? {}
      : requestMode === 'responses'
        ? { max_output_tokens: defaults.maxOutputTokens }
        : { max_tokens: defaults.maxOutputTokens }),
    ...(defaults.reasoningEffort
      ? { reasoning: { effort: defaults.reasoningEffort } }
      : {}),
    ...(defaults.thinkingMode
      ? { thinking: { type: defaults.thinkingMode } }
      : {}),
  };
}

export function buildModelReplyOutputContract(args: {
  canonicalModel: string;
  model: ModelDefinition;
  canVoice?: boolean;
  canMeme?: boolean;
  stickerIntentHints?: readonly string[];
  voiceOutputLanguage?: VoiceOutputLanguage;
}): MainChatReplyOutputContract {
  return createReplyOutputContract({
    requestMode: requireRequestMode(args.model),
    protocol: requireReplyProtocol(args.model),
    overrideRequestParams: buildModelRequestOverrides(args),
    canVoice: args.canVoice,
    canMeme: args.canMeme,
    stickerIntentHints: args.stickerIntentHints,
    voiceOutputLanguage: args.voiceOutputLanguage,
  });
}
