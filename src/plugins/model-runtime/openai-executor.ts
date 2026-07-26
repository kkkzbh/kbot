import {
  ModelConfigError,
  type ManagedChatRequest,
  type ManagedChatResponse,
  type ManagedEmbeddingResponse,
  type ModelConnectionExecutor,
  type ModelRuntimeExecutionRequest,
  type ResolvedModelTarget,
} from '../model-config/index.js';
import { createProxyFetchRequest } from '../shared/proxy-fetch.js';

export interface OpenAiConnectionExecutorOptions {
  connectionId: string;
  baseUrl: string;
  apiKey: string | null;
  fetchFn?: typeof fetch;
}

export class OpenAiConnectionExecutor implements ModelConnectionExecutor {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: OpenAiConnectionExecutorOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async execute(
    request: ModelRuntimeExecutionRequest,
  ): Promise<ManagedChatResponse | ManagedEmbeddingResponse> {
    if (request.target.connection.id !== this.options.connectionId) {
      throw runtimeError(
        request.target,
        'validate',
        `executor ${this.options.connectionId} cannot execute connection ${request.target.connection.id}`,
      );
    }
    return request.operation === 'chat'
      ? this.executeChat(request.target, request.payload, request.signal)
      : this.executeEmbedding(request.target, request.payload.inputs, request.signal);
  }

  private async executeChat(
    target: ResolvedModelTarget,
    request: ManagedChatRequest,
    signal?: AbortSignal,
  ): Promise<ManagedChatResponse> {
    if (target.model.requestMode === 'chat_completions') {
      const payload = await this.postJson(
        target,
        '/chat/completions',
        buildChatCompletionsBody(target, request),
        signal,
      );
      const text = extractChatCompletionsText(payload);
      if (!text) {
        throw upstreamResponseError(
          target,
          'chat completions response contains no text',
        );
      }
      return { text, raw: payload };
    }
    if (target.model.requestMode === 'responses') {
      const payload = await this.postJson(
        target,
        '/responses',
        buildResponsesBody(target, request),
        signal,
      );
      const text = extractResponsesText(payload);
      if (!text) {
        throw upstreamResponseError(
          target,
          'responses API response contains no text',
        );
      }
      return { text, raw: payload };
    }
    throw runtimeError(target, 'validate', 'chat model has no request mode');
  }

  private async executeEmbedding(
    target: ResolvedModelTarget,
    inputs: readonly string[],
    signal?: AbortSignal,
  ): Promise<ManagedEmbeddingResponse> {
    const payload = await this.postJson(
      target,
      '/embeddings',
      {
        model: target.model.transportModel,
        input: inputs,
      },
      signal,
    );
    let vectors: readonly (readonly number[])[];
    try {
      vectors = extractEmbeddingVectors(payload);
    } catch (error) {
      throw upstreamResponseError(
        target,
        'embedding response contains invalid vectors',
        error,
      );
    }
    if (vectors.length !== inputs.length) {
      throw upstreamResponseError(
        target,
        `embedding response count mismatch: expected ${inputs.length}, got ${vectors.length}`,
      );
    }
    return { vectors };
  }

  private async postJson(
    target: ResolvedModelTarget,
    path: string,
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromParent();
    else signal?.addEventListener('abort', abortFromParent, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, target.model.timeoutMs);
    const request = createProxyFetchRequest(url, {
      method: 'POST',
      headers: {
        ...(this.options.apiKey
          ? { Authorization: `Bearer ${this.options.apiKey}` }
          : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    try {
      const response = await this.fetchFn(url, request.init);
      if (!response.ok) {
        const providerCode = await readProviderCode(response);
        throw new ModelConfigError({
          code: 'upstream_failed',
          operation: 'execute',
          stage: 'transport',
          connectionId: target.connection.id,
          modelId: target.model.id,
          upstreamStatus: response.status,
          providerCode: providerCode ?? undefined,
          message: `managed model upstream returned HTTP ${response.status}`,
        });
      }
      try {
        return await response.json();
      } catch (error) {
        throw new ModelConfigError({
          code: 'upstream_failed',
          operation: 'execute',
          stage: 'parse',
          connectionId: target.connection.id,
          modelId: target.model.id,
          upstreamStatus: response.status,
          providerCode: 'invalid_json',
          message: 'managed model upstream returned invalid JSON',
          cause: error,
        });
      }
    } catch (error) {
      if (error instanceof ModelConfigError) throw error;
      throw new ModelConfigError({
        code: 'upstream_failed',
        operation: 'execute',
        stage: 'transport',
        connectionId: target.connection.id,
        modelId: target.model.id,
        providerCode: timedOut
          ? 'request_timeout'
          : controller.signal.aborted
            ? 'request_aborted'
            : undefined,
        message: `managed model transport failed for ${target.connection.id}/${target.model.id}`,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromParent);
    }
  }
}

function buildChatCompletionsBody(
  target: ResolvedModelTarget,
  request: ManagedChatRequest,
): Readonly<Record<string, unknown>> {
  const defaults = target.model.requestDefaults;
  return {
    model: target.model.transportModel,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => (
            part.type === 'text'
              ? { type: 'text', text: part.text }
              : {
                  type: 'image_url',
                  image_url: {
                    url: part.url,
                    ...(part.detail ? { detail: part.detail } : {}),
                  },
                }
          )),
    })),
    ...((request.temperature ?? defaults.temperature) === undefined
      ? {}
      : { temperature: request.temperature ?? defaults.temperature }),
    ...(defaults.topP === undefined ? {} : { top_p: defaults.topP }),
    ...((request.maxOutputTokens ?? defaults.maxOutputTokens) === undefined
      ? {}
      : { max_tokens: request.maxOutputTokens ?? defaults.maxOutputTokens }),
    ...(defaults.reasoningEffort
      ? { reasoning_effort: defaults.reasoningEffort }
      : {}),
    ...(defaults.thinkingMode
      ? { thinking: { type: defaults.thinkingMode } }
      : {}),
    ...buildChatStructuredOutput(target, request),
  };
}

function buildResponsesBody(
  target: ResolvedModelTarget,
  request: ManagedChatRequest,
): Readonly<Record<string, unknown>> {
  const defaults = target.model.requestDefaults;
  return {
    model: target.model.transportModel,
    input: request.messages.map((message) => ({
      role: message.role,
      content: typeof message.content === 'string'
        ? [{ type: 'input_text', text: message.content }]
        : message.content.map((part) => (
            part.type === 'text'
              ? { type: 'input_text', text: part.text }
              : {
                  type: 'input_image',
                  image_url: part.url,
                  ...(part.detail ? { detail: part.detail } : {}),
                }
          )),
    })),
    store: false,
    ...((request.temperature ?? defaults.temperature) === undefined
      ? {}
      : { temperature: request.temperature ?? defaults.temperature }),
    ...(defaults.topP === undefined ? {} : { top_p: defaults.topP }),
    ...((request.maxOutputTokens ?? defaults.maxOutputTokens) === undefined
      ? {}
      : { max_output_tokens: request.maxOutputTokens ?? defaults.maxOutputTokens }),
    ...(defaults.reasoningEffort
      ? { reasoning: { effort: defaults.reasoningEffort } }
      : {}),
    ...(defaults.thinkingMode
      ? { thinking: { type: defaults.thinkingMode } }
      : {}),
    ...buildResponsesStructuredOutput(target, request),
  };
}

function buildChatStructuredOutput(
  target: ResolvedModelTarget,
  request: ManagedChatRequest,
): Readonly<Record<string, unknown>> {
  if (!request.structuredOutput) return {};
  if (target.model.structuredOutputProtocol !== 'native_chat_json_schema') {
    throw runtimeError(
      target,
      'validate',
      'structured chat request requires native_chat_json_schema',
    );
  }
  return {
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: request.structuredOutput.name,
        strict: request.structuredOutput.strict,
        schema: request.structuredOutput.schema,
      },
    },
  };
}

function buildResponsesStructuredOutput(
  target: ResolvedModelTarget,
  request: ManagedChatRequest,
): Readonly<Record<string, unknown>> {
  if (!request.structuredOutput) return {};
  if (target.model.structuredOutputProtocol !== 'native_responses_json_schema') {
    throw runtimeError(
      target,
      'validate',
      'structured responses request requires native_responses_json_schema',
    );
  }
  return {
    text: {
      format: {
        type: 'json_schema',
        name: request.structuredOutput.name,
        strict: request.structuredOutput.strict,
        schema: request.structuredOutput.schema,
      },
    },
  };
}

function extractChatCompletionsText(payload: unknown): string {
  const record = asRecord(payload);
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first?.message);
  return extractTextContent(message?.content);
}

function extractResponsesText(payload: unknown): string {
  const record = asRecord(payload);
  if (typeof record?.output_text === 'string') return record.output_text.trim();
  const output = Array.isArray(record?.output) ? record.output : [];
  return output.flatMap((entry) => {
    const content = asRecord(entry)?.content;
    return Array.isArray(content)
      ? content.map((item) => {
          const text = asRecord(item)?.text;
          return typeof text === 'string' ? text : '';
        })
      : [];
  }).join('').trim();
}

function extractEmbeddingVectors(payload: unknown): readonly (readonly number[])[] {
  const record = asRecord(payload);
  const data = Array.isArray(record?.data) ? record.data : [];
  return data.map((entry) => {
    const embedding = asRecord(entry)?.embedding;
    if (
      !Array.isArray(embedding)
      || embedding.length === 0
      || embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))
    ) {
      throw new Error('embedding response contains an invalid vector');
    }
    return embedding as number[];
  });
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (typeof item === 'string') return item;
    const text = asRecord(item)?.text;
    return typeof text === 'string' ? text : '';
  }).join('').trim();
}

async function readProviderCode(response: Response): Promise<string | null> {
  try {
    const payload = asRecord(await response.json());
    const error = asRecord(payload?.error);
    const code = error?.code ?? error?.type ?? payload?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  const url = new URL(normalized);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported managed model protocol: ${url.protocol}`);
  }
  if (
    url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error('managed model base URL cannot contain credentials, query, or fragment');
  }
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function runtimeError(
  target: ResolvedModelTarget,
  stage: 'validate' | 'parse',
  message: string,
): ModelConfigError {
  return new ModelConfigError({
    code: 'runtime_operation_invalid',
    operation: 'execute',
    stage,
    connectionId: target.connection.id,
    modelId: target.model.id,
    message,
  });
}

function upstreamResponseError(
  target: ResolvedModelTarget,
  message: string,
  cause?: unknown,
): ModelConfigError {
  return new ModelConfigError({
    code: 'upstream_failed',
    operation: 'execute',
    stage: 'parse',
    connectionId: target.connection.id,
    modelId: target.model.id,
    upstreamStatus: 200,
    providerCode: 'invalid_response',
    message,
    cause,
  });
}
