import {
  ModelCapabilities as ChatLunaModelCapability,
} from 'koishi-plugin-chatluna/llm-core/platform/types';
import type {
  ManagedOpenAIModel,
} from 'koishi-plugin-chatluna-openai-like-adapter';
import type {
  ModelDefinition,
} from '../model-config/index.js';

export function toManagedOpenAIModel(
  model: ModelDefinition,
): ManagedOpenAIModel {
  const capabilities: ChatLunaModelCapability[] = [];
  if (model.capabilities.chat) {
    capabilities.push(ChatLunaModelCapability.TextInput);
  }
  if (model.capabilities.tools) {
    capabilities.push(ChatLunaModelCapability.ToolCall);
  }
  if (model.capabilities.vision) {
    capabilities.push(ChatLunaModelCapability.ImageInput);
  }
  return {
    id: model.id,
    transportModel: model.transportModel,
    type: model.modelType === 'embedding' ? 'embeddings' : 'llm',
    contextSize: model.contextSize,
    capabilities,
    requestMode: model.requestMode === 'chat_completions'
      ? 'chatCompletions'
      : model.requestMode === 'responses'
        ? 'responses'
        : undefined,
    timeoutMs: model.timeoutMs,
    requestDefaults: {
      ...(model.requestDefaults.temperature === undefined
        ? {}
        : { temperature: model.requestDefaults.temperature }),
      ...(model.requestDefaults.topP === undefined
        ? {}
        : { topP: model.requestDefaults.topP }),
      ...(model.requestDefaults.maxOutputTokens === undefined
        ? {}
        : { maxTokens: model.requestDefaults.maxOutputTokens }),
      ...(model.requestDefaults.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: model.requestDefaults.reasoningEffort }),
      ...(model.requestDefaults.thinkingMode === undefined
        ? {}
        : { thinkingMode: model.requestDefaults.thinkingMode }),
    },
  };
}
