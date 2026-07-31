import { describe, expect, it } from 'vitest';
import type { ModelUsagePayload } from 'koishi-plugin-chatluna/llm-core/platform/usage';
import {
  buildContextTargets,
  MODEL_CONTEXT_MAX_SESSIONS,
  MODEL_CONTEXT_PENDING_TTL_MS,
  ModelContextSnapshotStore,
  sanitizeContextSchema,
  sanitizeContextValue,
  type ModelContextPayload,
} from '../src/plugins/admin-api/model-context.js';

function contextPayload(options: {
  requestId?: string;
  callId?: string;
  callOrdinal?: number;
  conversationId?: string;
  model?: string;
  content?: ModelContextPayload['assembledMessages'][number]['content'];
  message?: Partial<ModelContextPayload['assembledMessages'][number]>;
  createdAt?: Date;
} = {}): ModelContextPayload {
  const requestId = options.requestId ?? 'request-1';
  const conversationId = options.conversationId ?? 'conversation-1';
  const model = options.model ?? 'openai/model-a';
  const content = options.content ?? 'hello';
  return {
    requestId,
    callId: options.callId ?? `${requestId}-call`,
    callOrdinal: options.callOrdinal ?? 1,
    conversationId,
    platform: 'openai',
    model,
    canonicalModel: model,
    transportModel: model.replace('openai/', ''),
    requestMode: 'responses',
    stream: true,
    semanticStage: 'before_provider_serialization',
    contextLimit: 32_000,
    modelContextSize: 128_000,
    estimatedTokens: 120,
    assembledCount: 1,
    finalCount: 1,
    truncated: false,
    assembledMessages: [{
      id: `${conversationId}-message`,
      role: 'human',
      content,
      tokenEstimate: 120,
      stage: 'input',
      source: { kind: 'input', name: 'current input' },
      ...options.message,
    }],
    finalMessages: [{
      id: `${conversationId}-message`,
      role: 'human',
      content,
      tokenEstimate: 120,
      stage: 'input',
      source: { kind: 'input', name: 'current input' },
      ...options.message,
    }],
    trace: [],
    tools: [{
      name: 'lookup',
      description: 'Lookup data',
      schema: {
        type: 'object',
        headers: { authorization: 'Bearer tool-secret' },
      },
    }],
    presetId: 'sakiko',
    presetRevision: 'revision-1',
    presetResolution: {
      source: 'conversation',
      presetId: 'sakiko',
      bindingKey: 'shared:onebot:bot:group',
    },
    createdAt: options.createdAt ?? new Date('2026-07-25T00:00:00.000Z'),
  };
}

function usagePayload(options: {
  requestId?: string;
  callId?: string;
  callOrdinal?: number;
  model?: string;
  inputTokens?: number;
} = {}): ModelUsagePayload & {
  context: NonNullable<ModelUsagePayload['context']> & {
    callId: string;
    callOrdinal: number;
  };
} {
  const requestId = options.requestId ?? 'request-1';
  return {
    source: 'chatluna',
    callType: 'llm',
    platform: 'openai',
    model: options.model ?? 'openai/model-a',
    usageMetadata: {
      input_tokens: options.inputTokens ?? 144,
      output_tokens: 21,
      total_tokens: (options.inputTokens ?? 144) + 21,
    },
    estimated: false,
    success: true,
    createdAt: new Date('2026-07-25T00:00:01.000Z'),
    context: {
      requestId,
      callId: options.callId ?? `${requestId}-call`,
      callOrdinal: options.callOrdinal ?? 1,
    },
  };
}

describe('model context snapshot store', () => {
  it('joins usage, keeps semantic request metadata, and removes credentials', () => {
    const store = new ModelContextSnapshotStore();
    store.ingestContext(contextPayload({
      content: [{
        type: 'image_url',
        image_url: {
          url: 'https://alice:password@example.com/file?token=query-secret&name=visible',
          headers: { authorization: 'Bearer header-secret' },
        },
      }, {
        type: 'text',
        text: 'data:text/plain;base64,c2Vuc2l0aXZlLWJ5dGVz',
      }],
      message: {
        name: 'assistant',
        toolCalls: [{
          id: 'call-1',
          name: 'lookup',
          args: {
            query: 'visible',
            apiKey: 'tool-call-secret',
          },
        }],
      },
    }));
    store.ingestUsage(usagePayload());

    const result = store.latest('conversation-1');
    expect(result.snapshot).toMatchObject({
      requestId: 'request-1',
      callId: 'request-1-call',
      callOrdinal: 1,
      stream: true,
      semanticStage: 'before_provider_serialization',
      contextSize: 120,
      contextRatio: 120 / 32_000,
      contextLimit: 32_000,
      modelContextSize: 128_000,
      providerInputTokens: 144,
      providerOutputTokens: 21,
      providerUsageEstimated: false,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('query-secret');
    expect(serialized).not.toContain('header-secret');
    expect(serialized).not.toContain('tool-secret');
    expect(serialized).not.toContain('tool-call-secret');
    expect(serialized).not.toContain('sensitive-bytes');
    expect(result.snapshot?.messages[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        text: {
          kind: 'binary',
          mimeType: 'text/plain',
          size: 15,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      }),
    ]));
    expect(result.snapshot?.messages[0]).toMatchObject({
      name: 'assistant',
      toolCalls: [{
        id: 'call-1',
        name: 'lookup',
        args: { query: 'visible' },
      }],
    });
  });

  it('correlates repeated request ids by provider call id and expires unmatched usage', () => {
    let now = 1_000;
    const store = new ModelContextSnapshotStore(() => now);
    store.ingestContext(contextPayload({
      requestId: 'shared-request',
      callId: 'call-a',
      callOrdinal: 1,
      conversationId: 'conversation-a',
      model: 'openai/same-model',
    }));
    store.ingestContext(contextPayload({
      requestId: 'shared-request',
      callId: 'call-b',
      callOrdinal: 2,
      conversationId: 'conversation-b',
      model: 'openai/same-model',
    }));
    store.ingestUsage(usagePayload({
      requestId: 'shared-request',
      callId: 'call-b',
      callOrdinal: 2,
      model: 'openai/same-model',
      inputTokens: 222,
    }));

    expect(store.latest('conversation-a').snapshot?.providerInputTokens).toBeNull();
    expect(store.latest('conversation-b').snapshot?.providerInputTokens).toBe(222);

    store.ingestUsage(usagePayload({
      requestId: 'late-request',
      callId: 'late-call',
      inputTokens: 999,
    }));
    now += MODEL_CONTEXT_PENDING_TTL_MS + 1;
    store.prunePending();
    store.ingestContext(contextPayload({
      requestId: 'late-request',
      callId: 'late-call',
      conversationId: 'conversation-late',
    }));
    expect(store.latest('conversation-late').snapshot?.providerInputTokens).toBeNull();
  });

  it('keeps the highest process call ordinal when context events arrive out of order', () => {
    const store = new ModelContextSnapshotStore();
    store.ingestContext(contextPayload({
      requestId: 'request-new',
      callId: 'call-new',
      callOrdinal: 20,
      conversationId: 'conversation-shared',
      content: 'new context',
    }));
    store.ingestContext(contextPayload({
      requestId: 'request-old',
      callId: 'call-old',
      callOrdinal: 19,
      conversationId: 'conversation-shared',
      content: 'old context',
    }));

    expect(store.latest('conversation-shared').snapshot).toMatchObject({
      requestId: 'request-new',
      callId: 'call-new',
      callOrdinal: 20,
    });
  });

  it('evicts whole least-recently-used session snapshots', () => {
    const store = new ModelContextSnapshotStore();
    for (let index = 0; index <= MODEL_CONTEXT_MAX_SESSIONS; index += 1) {
      store.ingestContext(contextPayload({
        requestId: `request-${index}`,
        conversationId: `conversation-${index}`,
      }));
    }

    expect(store.latest('conversation-0').snapshot).toBeNull();
    expect(store.latest(`conversation-${MODEL_CONTEXT_MAX_SESSIONS}`).snapshot).not.toBeNull();
  });

  it('does not retain a snapshot larger than two MiB', () => {
    const store = new ModelContextSnapshotStore();
    store.ingestContext(contextPayload({
      conversationId: 'oversized',
      content: 'x'.repeat(2 * 1024 * 1024),
    }));

    const result = store.latest('oversized');
    expect(result.snapshot).toBeNull();
    expect(result.unavailableReason).toContain('超过');
  });

  it('enforces the sixteen MiB total after usage updates replace snapshots', () => {
    const store = new ModelContextSnapshotStore();
    for (let index = 0; index < 9; index += 1) {
      const requestId = `large-request-${index}`;
      store.ingestContext(contextPayload({
        requestId,
        callOrdinal: index + 1,
        conversationId: `large-conversation-${index}`,
        content: 'x'.repeat(1_900_000),
      }));
      store.ingestUsage(usagePayload({
        requestId,
        callOrdinal: index + 1,
      }));
    }

    expect(store.latest('large-conversation-0').snapshot).toBeNull();
    expect(store.latest('large-conversation-8').snapshot).not.toBeNull();
  });

  it('rejects LLM usage without call identity and records a diagnostic', () => {
    const diagnostics: string[] = [];
    const store = new ModelContextSnapshotStore(Date.now, (message) => diagnostics.push(message));
    const payload = usagePayload({
      requestId: 'request-without-call-id',
    });
    store.ingestUsage({
      ...payload,
      context: {
        requestId: 'request-without-call-id',
        conversationId: 'conversation-without-call-id',
      },
    });

    expect(store.latest('conversation-without-call-id')).toMatchObject({
      snapshot: null,
      unavailableReason: expect.stringContaining('缺少有效 callId/callOrdinal'),
    });
    expect(diagnostics).toEqual([
      'ignored llm model-usage without valid call identity: requestId=request-without-call-id',
    ]);
  });

  it('removes an older snapshot when a newer event cannot be correlated', () => {
    const store = new ModelContextSnapshotStore();
    store.ingestContext(contextPayload({
      requestId: 'valid-request',
      callId: 'valid-call',
      callOrdinal: 1,
      conversationId: 'conversation-invalidated',
      content: 'old snapshot',
    }));
    expect(store.latest('conversation-invalidated').snapshot).not.toBeNull();

    store.ingestContext(contextPayload({
      requestId: 'invalid-request',
      callId: ' ',
      callOrdinal: 2,
      conversationId: 'conversation-invalidated',
      content: 'new event without valid identity',
    }));

    expect(store.latest('conversation-invalidated')).toMatchObject({
      snapshot: null,
      unavailableReason: expect.stringContaining('缺少有效 callId/callOrdinal'),
    });
  });

  it('keeps a newer snapshot when an older malformed context arrives late', () => {
    const store = new ModelContextSnapshotStore();
    store.ingestContext(contextPayload({
      requestId: 'new-request',
      callId: 'new-call',
      callOrdinal: 20,
      conversationId: 'conversation-out-of-order-invalid',
    }));
    store.ingestContext(contextPayload({
      requestId: 'old-invalid-request',
      callId: ' ',
      callOrdinal: 19,
      conversationId: 'conversation-out-of-order-invalid',
    }));

    expect(store.latest('conversation-out-of-order-invalid')).toMatchObject({
      snapshot: {
        requestId: 'new-request',
        callId: 'new-call',
        callOrdinal: 20,
      },
      unavailableReason: null,
    });
  });

  it('does not expose a stale snapshot after an uncorrelated LLM usage event', () => {
    const store = new ModelContextSnapshotStore();
    store.ingestContext(contextPayload({
      requestId: 'valid-request',
      callId: 'valid-call',
      callOrdinal: 1,
      conversationId: 'conversation-invalid-usage',
    }));

    const usage = usagePayload({ requestId: 'invalid-usage' });
    store.ingestUsage({
      ...usage,
      context: {
        requestId: 'invalid-usage',
        conversationId: 'conversation-invalid-usage',
      },
    });

    expect(store.latest('conversation-invalid-usage')).toMatchObject({
      snapshot: null,
      unavailableReason: expect.stringContaining('LLM usage 缺少有效 callId/callOrdinal'),
    });

    store.ingestContext(contextPayload({
      requestId: 'delayed-old-request',
      callId: 'delayed-old-call',
      callOrdinal: 1,
      conversationId: 'conversation-invalid-usage',
    }));
    expect(store.latest('conversation-invalid-usage')).toMatchObject({
      snapshot: null,
      unavailableReason: expect.stringContaining('LLM usage 缺少有效 callId/callOrdinal'),
    });
  });

  it('rejects a call ordinal mismatch for the same call id', () => {
    const store = new ModelContextSnapshotStore();
    store.ingestContext(contextPayload({
      requestId: 'request-mismatch',
      callId: 'call-mismatch',
      callOrdinal: 7,
      conversationId: 'conversation-mismatch',
    }));

    expect(() => store.ingestUsage(usagePayload({
      requestId: 'request-mismatch',
      callId: 'call-mismatch',
      callOrdinal: 8,
    }))).toThrow(/callOrdinal mismatch/);
    expect(store.latest('conversation-mismatch').snapshot?.providerInputTokens).toBeNull();
  });
});

describe('context targets', () => {
  it('lists selector metadata without guessing request-scoped resolution', async () => {
    const tables: Record<string, unknown[]> = {
      chatluna_conversation: [{
        id: 'conversation-1',
        bindingKey: 'shared:qq:bot:group-1:preset:lane-preset',
        title: 'Group chat',
        model: 'openai/conversation-model',
        preset: 'conversation-preset',
        createdBy: 'user-1',
        status: 'active',
      }],
      chatluna_constraint: [{
        name: 'managed:qq:bot:guild:group-1',
        enabled: true,
        priority: 1000,
        platform: 'qq',
        selfId: 'bot',
        guildId: 'group-1',
        fixedPreset: 'fixed-preset',
        fixedModel: 'openai/fixed-model',
      }],
      chathub_room: [{
        roomId: 12,
        roomName: 'Test room',
        conversationId: 'conversation-1',
        visibility: 'public',
      }],
      chathub_room_group_member: [{ roomId: 12, groupId: 'group-1' }],
    };
    const requestedTables: string[] = [];

    const targets = await buildContextTargets({
      get: async (table) => {
        requestedTables.push(table);
        return tables[table] ?? [];
      },
    });

    expect(targets).toEqual([{
      conversationId: 'conversation-1',
      roomId: 12,
      label: 'Test room',
      scope: 'group:group-1',
    }]);
    expect(requestedTables).not.toContain('chatluna_constraint');
  });
});

describe('context sanitizer', () => {
  it('removes exact secret fields without removing token metrics', () => {
    expect(sanitizeContextValue({
      estimatedTokens: 10,
      client_secret: 'hidden',
      nested: { session_secret: 'hidden-too' },
    })).toEqual({
      estimatedTokens: 10,
      nested: {},
    });
  });

  it('preserves parameter names while removing schema annotations and credentials', () => {
    expect(sanitizeContextSchema({
      type: 'object',
      headers: { authorization: 'Bearer secret' },
      properties: {
        apiKey: {
          type: 'string',
          description: 'Credential supplied by the caller',
          default: 'secret',
        },
      },
      required: ['apiKey'],
      examples: [{ apiKey: 'secret' }],
    })).toEqual({
      type: 'object',
      properties: {
        apiKey: {
          type: 'string',
          description: 'Credential supplied by the caller',
        },
      },
      required: ['apiKey'],
    });
  });

  it('removes data URL payloads from tool schema strings', () => {
    const sanitized = sanitizeContextSchema({
      type: 'string',
      description: 'Example data:text/plain;base64,c2NoZW1hLXNlY3JldA== payload',
      enum: ['data:text/plain,enum%20secret'],
    });
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain('c2NoZW1hLXNlY3JldA==');
    expect(serialized).not.toContain('enum%20secret');
    expect(serialized).not.toContain('schema-secret');
    expect(serialized).toContain('sha256');
  });

  it('fully removes parameterized, percent-encoded, embedded, and malformed data URLs', () => {
    const sanitized = sanitizeContextValue({
      parameterized: 'data:image/png;charset=utf-8;base64,YWJj',
      percentEncoded: 'data:text/plain;charset=utf-8,hello%20secret',
      embedded: 'before data:text/plain,private%20payload after',
      malformed: 'data:text/plain,private%2Gpayload',
    });

    expect(sanitized).toMatchObject({
      parameterized: {
        kind: 'binary',
        mimeType: 'image/png',
        size: 3,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      percentEncoded: {
        kind: 'binary',
        mimeType: 'text/plain',
        size: 12,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      malformed: {
        kind: 'binary',
        mimeType: 'text/plain',
        malformed: true,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const serialized = JSON.stringify(sanitized);
    for (const secret of [
      'YWJj',
      'hello',
      '%20secret',
      'private',
      'payload',
      '%2G',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('redacts standalone and embedded signed URLs including fragments', () => {
    const sanitized = sanitizeContextValue({
      aws: 'https://alice:password@s3.example.com/object?X-Amz-Credential=credential-secret&X-Amz-Signature=signature-secret&X-Amz-Security-Token=security-secret#fragment-secret',
      gcp: 'inspect https://storage.example.com/object?X-Goog-Credential=gcp-secret&X-Goog-Signature=gcp-signature now',
      azure: 'https://blob.example.com/object?sv=2026-01-01&sig=azure-secret',
      chinese: '请查看https://bucket.example.com/o?sig=chinese-secret，然后总结',
      markdown: '[link](https://bucket.example.com/o?sig=markdown-secret#fragment)，然后总结',
      english: 'Inspect https://bucket.example.com/o?sig=english-secret). next',
      signedFields: {
        xAmzCredential: 'field-credential',
        signature: 'field-signature',
        xAmzSecurityToken: 'field-token',
        visible: true,
      },
    });
    const serialized = JSON.stringify(sanitized);

    for (const secret of [
      'password',
      'credential-secret',
      'signature-secret',
      'security-secret',
      'fragment-secret',
      'gcp-secret',
      'gcp-signature',
      'azure-secret',
      'chinese-secret',
      'markdown-secret',
      'english-secret',
      'field-credential',
      'field-signature',
      'field-token',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(sanitized).toMatchObject({
      chinese: expect.stringContaining('，然后总结'),
      markdown: expect.stringContaining(')，然后总结'),
      english: expect.stringContaining('). next'),
      signedFields: { visible: true },
    });
    expect(serialized).toContain('X-Amz-Credential');
    expect(serialized).toContain('X-Goog-Signature');
    expect(serialized).toContain('sig');
  });

  it('handles cyclic arrays and camelCase credential fields', () => {
    const value: unknown[] = [];
    value.push(value, {
      apiToken: 'hidden',
      toolCredentials: 'hidden-too',
      visible: true,
    });

    expect(sanitizeContextValue(value)).toEqual([
      { kind: 'redacted', reason: 'cyclic_reference' },
      { visible: true },
    ]);
  });
});
