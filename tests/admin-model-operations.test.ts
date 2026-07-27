import { describe, expect, it, vi } from 'vitest';
import type { CodexOAuthBridgeService } from '../src/plugins/codex-oauth/index.js';
import type { CopilotOAuthBridgeService } from '../src/plugins/copilot-oauth/index.js';
import type {
  ModelConfigAggregate,
  ModelConfigService,
} from '../src/plugins/model-config/index.js';
import { ModelConnectionOperations } from '../src/plugins/admin-api/model-operations.js';
import { AdminHttpError } from '../src/plugins/admin-api/access-policy.js';

const connection = {
  id: 'openai',
  displayName: 'OpenAI',
  adapter: 'openaiCompatible' as const,
  baseUrl: 'https://api.example.com/v1',
  auth: { kind: 'apiKey' as const, secretRef: 'connection:openai' },
  catalogDriver: 'openaiModels' as const,
};

const model = {
  id: 'gpt-test',
  connectionId: 'openai',
  displayName: 'GPT Test',
  transportModel: 'gpt-test',
  modelType: 'chat' as const,
  contextSize: 128_000,
  requestMode: 'responses' as const,
  structuredOutputProtocol: 'native_responses_json_schema' as const,
  capabilities: {
    chat: true,
    embedding: false,
    vision: true,
    tools: true,
    structuredOutput: true,
  },
  timeoutMs: 180_000,
  requestDefaults: {},
};

function bridge(status: 'ready' | 'error' = 'ready') {
  const adminStatus = {
    authKind: 'oauth_device' as const,
    authStatus: status,
    accountLabel: null,
    authError: status === 'error' ? 'token=oauth-secret' : null,
    tokenExpiresAt: null,
    attempt: status === 'error'
      ? {
          attemptId: 'attempt-1',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://example.com/device',
          expiresAt: Date.now() + 60_000,
          intervalSec: 5,
          nextPollAt: Date.now(),
          state: 'failed' as const,
          error: 'Bearer oauth-secret',
        }
      : null,
  };
  return {
    getAdminStatus: vi.fn(async () => adminStatus),
    startLogin: vi.fn(async () => adminStatus),
    pollLogin: vi.fn(async () => adminStatus),
    logout: vi.fn(async () => adminStatus),
    proxyModels: vi.fn(async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ data: [{ id: 'bridge-model' }] }),
    })),
  };
}

function modelConfig() {
  return {
    getConnectionRuntime: vi.fn(() => ({
      revision: 2,
      connection: { ...connection, apiKey: 'runtime-secret' },
      models: [model],
    })),
  } as unknown as ModelConfigService;
}

describe('admin model connection operations', () => {
  it('uses runtime credentials for catalog requests without returning them', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer runtime-secret',
        Accept: 'application/json',
      });
      return new Response(JSON.stringify({
        data: [{ id: 'gpt-test', name: 'GPT Test' }],
      }), { status: 200 });
    });
    const operations = new ModelConnectionOperations({
      modelConfig: modelConfig(),
      codexBridge: bridge() as unknown as CodexOAuthBridgeService,
      copilotBridge: bridge() as unknown as CopilotOAuthBridgeService,
      fetchFn: fetchFn as typeof fetch,
      now: () => new Date('2026-07-26T12:00:00.000Z'),
    });

    const result = await operations.catalog('openai');

    expect(result).toEqual({
      connectionId: 'openai',
      fetchedAt: '2026-07-26T12:00:00.000Z',
      models: [{
        transportModel: 'gpt-test',
        displayName: 'GPT Test',
        requestMode: null,
        structuredOutputProtocol: null,
        metadataTags: [],
      }],
    });
    expect(JSON.stringify(result)).not.toContain('runtime-secret');
  });

  it('preserves typed bridge status and provider code without leaking the cause', async () => {
    const codexBridge = bridge();
    codexBridge.proxyModels.mockRejectedValueOnce(Object.assign(
      new Error('Bearer bridge-secret'),
      { status: 429, code: 'rate_limit' },
    ));
    const operations = new ModelConnectionOperations({
      modelConfig: {
        getConnectionRuntime: vi.fn(() => ({
          revision: 2,
          connection: {
            id: 'codex',
            displayName: 'Codex',
            adapter: 'codexBridge',
            baseUrl: null,
            auth: { kind: 'oauth', provider: 'codex' },
            catalogDriver: 'codexBridge',
            apiKey: null,
          },
          models: [],
        })),
      } as unknown as ModelConfigService,
      codexBridge: codexBridge as unknown as CodexOAuthBridgeService,
      copilotBridge: bridge() as unknown as CopilotOAuthBridgeService,
    });

    const error = await operations.catalog('codex').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AdminHttpError);
    expect(error).toMatchObject({
      status: 502,
      code: 'upstream_error',
      details: {
        operation: 'catalog',
        stage: 'transport',
        connectionId: 'codex',
        upstreamStatus: 429,
        providerCode: 'rate_limit',
      },
    });
    expect(JSON.stringify(error)).not.toContain('bridge-secret');
  });

  it('redacts OAuth diagnostics and attempt errors in aggregate auth state', async () => {
    const copilotBridge = bridge('error');
    const operations = new ModelConnectionOperations({
      modelConfig: modelConfig(),
      codexBridge: bridge() as unknown as CodexOAuthBridgeService,
      copilotBridge: copilotBridge as unknown as CopilotOAuthBridgeService,
    });
    const aggregate = {
      connections: [{
        id: 'copilot',
        displayName: 'Copilot',
        adapter: 'copilotBridge',
        baseUrl: null,
        auth: { kind: 'oauth', provider: 'copilot' },
        catalogDriver: 'copilotBridge',
        credentialState: 'external',
        hasSecret: false,
      }],
    } as ModelConfigAggregate;

    const states = await operations.getAuthStates(aggregate);

    expect(states[0]).toMatchObject({
      connectionId: 'copilot',
      status: 'error',
      error: '[credential redacted]',
      attempt: { error: 'Bearer [redacted]' },
    });
    expect(JSON.stringify(states)).not.toContain('oauth-secret');
  });
});
