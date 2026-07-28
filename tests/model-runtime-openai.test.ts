import { describe, expect, it, vi } from 'vitest';
import type {
  ModelRuntimeExecutionRequest,
  ResolvedModelTarget,
} from '../src/plugins/model-config/index.js';
import {
  OpenAiConnectionExecutor,
} from '../src/plugins/model-config/index.js';
import {
  toManagedOpenAIModel,
} from '../src/plugins/model-runtime/managed-model.js';

describe('managed OpenAI-compatible executor', () => {
  it('passes every canonical request default to the managed ChatLuna profile', () => {
    expect(toManagedOpenAIModel(createTarget().model)).toMatchObject({
      requestMode: 'chatCompletions',
      requestDefaults: {
        temperature: 0.4,
        topP: 0.9,
        maxTokens: 2048,
        reasoningEffort: 'medium',
        thinkingMode: 'disabled',
      },
    });
    expect(toManagedOpenAIModel(createTarget({
      requestMode: 'responses',
      structuredOutputProtocol: 'native_responses_json_schema',
    }).model)).toMatchObject({
      requestMode: 'responses',
      requestDefaults: {
        temperature: 0.4,
        topP: 0.9,
        maxTokens: 2048,
        reasoningEffort: 'medium',
        thinkingMode: 'disabled',
      },
    });
  });

  it('serializes chat-completions vision and strict structured output requests', async () => {
    const fetchFn = mockFetch(async () => jsonResponse({
      choices: [
        {
          message: {
            content: '{"caption":"hello"}',
          },
        },
      ],
    }));
    const executor = createExecutor(fetchFn);
    const target = createTarget();

    const response = await executor.execute({
      operation: 'chat',
      target,
      payload: {
        temperature: 0,
        maxOutputTokens: 512,
        structuredOutput: {
          name: 'sticker_metadata',
          schema: {
            type: 'object',
            properties: {
              caption: { type: 'string' },
            },
            required: ['caption'],
            additionalProperties: false,
          },
          strict: true,
        },
        messages: [
          { role: 'system', content: 'describe image' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'inspect' },
              {
                type: 'imageUrl',
                url: 'data:image/png;base64,cG5n',
                detail: 'low',
              },
            ],
          },
        ],
      },
    });

    expect(response).toMatchObject({ text: '{"caption":"hello"}' });
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://models.example.test/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer test-api-key',
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'provider-model',
      messages: [
        { role: 'system', content: 'describe image' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect' },
            {
              type: 'image_url',
              image_url: {
                url: 'data:image/png;base64,cG5n',
                detail: 'low',
              },
            },
          ],
        },
      ],
      temperature: 0,
      top_p: 0.9,
      max_tokens: 512,
      reasoning_effort: 'medium',
      thinking: { type: 'disabled' },
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'sticker_metadata',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              caption: { type: 'string' },
            },
            required: ['caption'],
            additionalProperties: false,
          },
        },
      },
    });
  });

  it('serializes Responses API requests and extracts output text', async () => {
    const fetchFn = mockFetch(async () => jsonResponse({
      output: [
        {
          content: [
            { type: 'output_text', text: '{"decision":"reply"}' },
          ],
        },
      ],
    }));
    const executor = createExecutor(fetchFn);
    const target = createTarget({
      requestMode: 'responses',
      structuredOutputProtocol: 'native_responses_json_schema',
    });

    const response = await executor.execute({
      operation: 'chat',
      target,
      payload: {
        messages: [{ role: 'user', content: 'decide' }],
        structuredOutput: {
          name: 'decision',
          schema: { type: 'object' },
          strict: true,
        },
      },
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));

    expect(url).toBe('https://models.example.test/v1/responses');
    expect(response).toMatchObject({ text: '{"decision":"reply"}' });
    expect(body).toMatchObject({
      model: 'provider-model',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'decide' }],
        },
      ],
      store: false,
      temperature: 0.4,
      top_p: 0.9,
      max_output_tokens: 2048,
      reasoning: { effort: 'medium' },
      thinking: { type: 'disabled' },
      text: {
        format: {
          type: 'json_schema',
          name: 'decision',
          strict: true,
          schema: { type: 'object' },
        },
      },
    });
  });

  it('preserves provider status and safe error code without exposing response bodies', async () => {
    const executor = createExecutor(mockFetch(async () => jsonResponse(
      {
        error: {
          code: 'rate_limit_exceeded',
          message: 'secret provider detail',
        },
      },
      429,
    )));

    let caught: unknown;
    try {
      await executor.execute(createChatExecution(createTarget()));
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'upstream_failed',
      stage: 'transport',
      upstreamStatus: 429,
      providerCode: 'rate_limit_exceeded',
    });
    expect(JSON.stringify(caught)).not.toContain('secret provider detail');
  });

  it('distinguishes timeout from caller abort', async () => {
    const fetchFn = vi.fn<TestFetch>((_url, init) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      })
    ));
    const executor = createExecutor(fetchFn);
    const target = createTarget({ timeoutMs: 10 });

    await expect(
      executor.execute(createChatExecution(target)),
    ).rejects.toMatchObject({
      code: 'upstream_failed',
      stage: 'transport',
      providerCode: 'request_timeout',
    });
  });

  it('rejects base URLs containing credentials or query parameters', () => {
    expect(() => new OpenAiConnectionExecutor({
      connectionId: 'primary',
      baseUrl: 'https://user:secret@models.example.test/v1',
      apiKey: null,
    })).toThrow('cannot contain credentials');
    expect(() => new OpenAiConnectionExecutor({
      connectionId: 'primary',
      baseUrl: 'https://models.example.test/v1?api_key=secret',
      apiKey: null,
    })).toThrow('cannot contain credentials');
  });
});

type TestFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function mockFetch(
  response: () => Response | Promise<Response>,
): ReturnType<typeof vi.fn<TestFetch>> {
  return vi.fn<TestFetch>(async (_input, _init) => response());
}

function createExecutor(fetchFn: TestFetch) {
  return new OpenAiConnectionExecutor({
    connectionId: 'primary',
    baseUrl: 'https://models.example.test/v1/',
    apiKey: 'test-api-key',
    fetchFn: fetchFn as typeof fetch,
  });
}

function createChatExecution(
  target: ResolvedModelTarget,
): ModelRuntimeExecutionRequest {
  return {
    operation: 'chat',
    target,
    payload: {
      messages: [{ role: 'user', content: 'hello' }],
    },
  };
}

function createTarget(
  overrides: Partial<ResolvedModelTarget['model']> = {},
): ResolvedModelTarget {
  return {
    canonicalModel: 'qqbot-primary/chat',
    connection: {
      id: 'primary',
      displayName: 'Primary',
      adapter: 'openaiCompatible',
      baseUrl: 'https://models.example.test/v1',
      auth: { kind: 'apiKey', secretRef: 'connection:primary:api-key' },
      catalogDriver: 'static',
      apiKey: 'test-api-key',
    },
    model: {
      id: 'chat',
      connectionId: 'primary',
      displayName: 'Chat',
      transportModel: 'provider-model',
      contextSize: 128_000,
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'native_chat_json_schema',
      capabilities: {
        vision: true,
        tools: true,
        structuredOutput: true,
      },
      timeoutMs: 30_000,
      requestDefaults: {
        temperature: 0.4,
        topP: 0.9,
        maxOutputTokens: 2048,
        reasoningEffort: 'medium',
        thinkingMode: 'disabled',
      },
      ...overrides,
    },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
