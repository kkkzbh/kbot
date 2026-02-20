export interface ChatRequest {
  groupId: string;
  userId: string;
  message: string;
  timestamp: number;
}

export interface ChatResponse {
  text: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  finishReason?: string;
}

export interface ChatPolicyDecision {
  allowed: boolean;
  reason:
    | 'ok'
    | 'group-not-enabled'
    | 'not-mention-trigger'
    | 'empty-content'
    | 'cooldown'
    | 'group-busy';
  retryAfterMs?: number;
}

export type OpenAIRole = 'system' | 'user' | 'assistant';

export interface OpenAIMessage {
  role: OpenAIRole;
  content: string;
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
}

export interface OpenAIChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}
