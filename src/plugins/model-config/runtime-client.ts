import { ModelConfigError } from './errors.js';
import {
  CanonicalModelBindingResolver,
  type ResolveModelBindingContext,
  type ResolvedModelBinding,
  type ResolvedModelTarget,
} from './resolver.js';
import type {
  ModelRuntimeSnapshot,
  ModelWorkload,
} from './types.js';
import { workloadRequiresNativeStructuredOutput } from './types.js';

export type ManagedChatContentPart =
  | {
      readonly type: 'text';
      readonly text: string;
    }
  | {
      readonly type: 'imageUrl';
      readonly url: string;
      readonly detail?: 'auto' | 'low' | 'high';
    };

export interface ManagedChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string | readonly ManagedChatContentPart[];
}

export interface ManagedStructuredOutput {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly strict: boolean;
}

export interface ManagedChatRequest {
  readonly messages: readonly ManagedChatMessage[];
  readonly structuredOutput?: ManagedStructuredOutput | null;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export interface ManagedEmbeddingRequest {
  readonly inputs: readonly string[];
}

export interface ManagedChatResponse {
  readonly text: string;
  readonly raw?: unknown;
}

export interface ManagedEmbeddingResponse {
  readonly vectors: readonly (readonly number[])[];
}

export type ModelRuntimeExecutionRequest =
  | {
      readonly operation: 'chat';
      readonly target: ResolvedModelTarget;
      readonly payload: ManagedChatRequest;
      readonly signal?: AbortSignal;
    }
  | {
      readonly operation: 'embedding';
      readonly target: ResolvedModelTarget;
      readonly payload: ManagedEmbeddingRequest;
      readonly signal?: AbortSignal;
    };

export type ModelRuntimeExecutionResponse =
  | ManagedChatResponse
  | ManagedEmbeddingResponse;

export interface ModelConnectionExecutor {
  execute(
    request: ModelRuntimeExecutionRequest,
  ): Promise<ModelRuntimeExecutionResponse>;
}

export interface ModelConnectionExecutorRegistry {
  get(connectionId: string): ModelConnectionExecutor | undefined;
}

export interface ExecuteManagedChatInput {
  workload: ModelWorkload;
  request: ManagedChatRequest;
  context?: ResolveModelBindingContext;
  signal?: AbortSignal;
}

export interface ExecuteManagedEmbeddingInput {
  workload: ModelWorkload;
  request: ManagedEmbeddingRequest;
  context?: ResolveModelBindingContext;
  signal?: AbortSignal;
}

export class ModelRuntimeClient {
  private readonly resolver: CanonicalModelBindingResolver;

  constructor(
    snapshot: ModelRuntimeSnapshot,
    private readonly executors: ModelConnectionExecutorRegistry,
  ) {
    this.resolver = new CanonicalModelBindingResolver(snapshot);
  }

  resolve(
    workload: ModelWorkload,
    context: ResolveModelBindingContext = {},
  ): ResolvedModelBinding {
    return this.resolver.resolve(workload, context);
  }

  async executeChat(input: ExecuteManagedChatInput): Promise<ManagedChatResponse> {
    if (!Array.isArray(input.request.messages) || input.request.messages.length === 0) {
      throw invalidRuntimeRequest(input.workload, 'chat requests require at least one message');
    }
    for (const message of input.request.messages) {
      if (
        message.role !== 'system'
        && message.role !== 'user'
        && message.role !== 'assistant'
      ) {
        throw invalidRuntimeRequest(input.workload, 'chat message role is invalid');
      }
      if (!isValidManagedContent(message.content)) {
        throw invalidRuntimeRequest(input.workload, 'chat message content cannot be empty');
      }
    }
    if (
      input.request.structuredOutput
      && (
        input.request.structuredOutput.name.trim().length === 0
        || typeof input.request.structuredOutput.schema !== 'object'
        || input.request.structuredOutput.schema === null
        || Array.isArray(input.request.structuredOutput.schema)
      )
    ) {
      throw invalidRuntimeRequest(input.workload, 'structuredOutput is invalid');
    }
    if (
      workloadRequiresNativeStructuredOutput(input.workload)
      && !input.request.structuredOutput
    ) {
      throw invalidRuntimeRequest(
        input.workload,
        `${input.workload} requires structuredOutput`,
      );
    }
    if (
      input.request.temperature !== undefined
      && (
        !Number.isFinite(input.request.temperature)
        || input.request.temperature < 0
        || input.request.temperature > 2
      )
    ) {
      throw invalidRuntimeRequest(input.workload, 'temperature must be between 0 and 2');
    }
    if (
      input.request.maxOutputTokens !== undefined
      && (
        !Number.isInteger(input.request.maxOutputTokens)
        || input.request.maxOutputTokens <= 0
      )
    ) {
      throw invalidRuntimeRequest(input.workload, 'maxOutputTokens must be a positive integer');
    }
    const response = await this.execute(
      input.workload,
      'chat',
      input.request,
      input.context,
      input.signal,
    );
    if (
      typeof response !== 'object'
      || response === null
      || !('text' in response)
      || typeof response.text !== 'string'
    ) {
      throw invalidRuntimeResponse(input.workload, 'chat');
    }
    return response as ManagedChatResponse;
  }

  async executeEmbedding(
    input: ExecuteManagedEmbeddingInput,
  ): Promise<ManagedEmbeddingResponse> {
    if (
      !Array.isArray(input.request.inputs)
      || input.request.inputs.length === 0
      || input.request.inputs.some(
        (value) => typeof value !== 'string' || value.length === 0,
      )
    ) {
      throw invalidRuntimeRequest(
        input.workload,
        'embedding requests require non-empty inputs',
      );
    }
    const response = await this.execute(
      input.workload,
      'embedding',
      input.request,
      input.context,
      input.signal,
    );
    if (
      typeof response !== 'object'
      || response === null
      || !('vectors' in response)
      || !Array.isArray(response.vectors)
      || response.vectors.some(
        (vector) => (
          !Array.isArray(vector)
          || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))
        ),
      )
      || response.vectors.length !== input.request.inputs.length
    ) {
      throw invalidRuntimeResponse(input.workload, 'embedding');
    }
    return response as ManagedEmbeddingResponse;
  }

  private async execute(
    workload: ModelWorkload,
    operation: 'chat' | 'embedding',
    payload: ManagedChatRequest | ManagedEmbeddingRequest,
    context: ResolveModelBindingContext | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ModelRuntimeExecutionResponse> {
    const resolved = this.resolver.resolve(workload, context);
    if (!resolved.target) {
      throw new ModelConfigError({
        code: 'runtime_operation_invalid',
        operation: 'execute',
        stage: 'validate',
        workload,
        message: `model workload is disabled: ${workload}`,
      });
    }
    if (!resolved.target.model.capabilities[operation]) {
      throw new ModelConfigError({
        code: 'runtime_operation_invalid',
        operation: 'execute',
        stage: 'validate',
        workload,
        connectionId: resolved.target.connection.id,
        modelId: resolved.target.model.id,
        message: `${workload} model does not support ${operation}`,
      });
    }
    if (
      operation === 'chat'
      && 'structuredOutput' in payload
      && payload.structuredOutput
      && !resolved.target.model.capabilities.structuredOutput
    ) {
      throw new ModelConfigError({
        code: 'runtime_operation_invalid',
        operation: 'execute',
        stage: 'validate',
        workload,
        connectionId: resolved.target.connection.id,
        modelId: resolved.target.model.id,
        message: `${workload} model does not support structured output`,
      });
    }
    if (
      operation === 'chat'
      && 'messages' in payload
      && containsImage(payload.messages)
      && !resolved.target.model.capabilities.vision
    ) {
      throw new ModelConfigError({
        code: 'runtime_operation_invalid',
        operation: 'execute',
        stage: 'validate',
        workload,
        connectionId: resolved.target.connection.id,
        modelId: resolved.target.model.id,
        message: `${workload} model does not support vision input`,
      });
    }

    const executor = this.executors.get(resolved.target.connection.id);
    if (!executor) {
      throw new ModelConfigError({
        code: 'runtime_executor_missing',
        operation: 'execute',
        stage: 'lookup',
        workload,
        connectionId: resolved.target.connection.id,
        modelId: resolved.target.model.id,
        message: `managed model connection is unavailable: ${resolved.target.connection.id}`,
      });
    }

    try {
      if (operation === 'chat') {
        return await executor.execute({
          operation,
          target: resolved.target,
          payload: payload as ManagedChatRequest,
          signal,
        });
      }
      return await executor.execute({
        operation,
        target: resolved.target,
        payload: payload as ManagedEmbeddingRequest,
        signal,
      });
    } catch (error) {
      if (error instanceof ModelConfigError) throw error;
      throw new ModelConfigError({
        code: 'upstream_failed',
        operation: 'execute',
        stage: 'transport',
        workload,
        connectionId: resolved.target.connection.id,
        modelId: resolved.target.model.id,
        message: `managed model request failed for ${workload}`,
        cause: error,
      });
    }
  }
}

function isValidManagedContent(
  content: string | readonly ManagedChatContentPart[],
): boolean {
  if (typeof content === 'string') return content.length > 0;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((part) => {
    if (typeof part !== 'object' || part === null || !('type' in part)) return false;
    if (part.type === 'text') return typeof part.text === 'string' && part.text.length > 0;
    if (part.type === 'imageUrl') {
      return typeof part.url === 'string' && part.url.length > 0;
    }
    return false;
  });
}

function containsImage(messages: readonly ManagedChatMessage[]): boolean {
  return messages.some(
    (message) => (
      Array.isArray(message.content)
      && message.content.some((part) => part.type === 'imageUrl')
    ),
  );
}

function invalidRuntimeRequest(
  workload: ModelWorkload,
  message: string,
): ModelConfigError {
  return new ModelConfigError({
    code: 'runtime_operation_invalid',
    operation: 'execute',
    stage: 'validate',
    workload,
    message,
  });
}

function invalidRuntimeResponse(
  workload: ModelWorkload,
  operation: 'chat' | 'embedding',
): ModelConfigError {
  return new ModelConfigError({
    code: 'runtime_operation_invalid',
    operation: 'execute',
    stage: 'validate',
    workload,
    message: `managed ${operation} response validation failed for ${workload}`,
  });
}
