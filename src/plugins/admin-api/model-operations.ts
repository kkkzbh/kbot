import type {
  ModelCatalogEntry,
  ModelConnectionAuthState,
} from '../../admin/contracts/index.js';
import type { CodexOAuthBridgeService } from '../codex-oauth/index.js';
import type { CopilotOAuthBridgeService } from '../copilot-oauth/index.js';
import {
  capabilityProbeKindsForWorkload,
  modelCapabilityProbeFingerprint,
  ModelConfigError,
  verifyModelCapabilityProbe,
  type ConnectionRuntimeView,
  type ModelConfigAggregate,
  type ModelConfigPutInput,
  type ModelConfigService,
  OpenAiConnectionExecutor,
  type RuntimeConnection,
} from '../model-config/index.js';
import { AdminHttpError } from '../shared/internal-access-policy.js';

type OAuthAction = 'start' | 'poll' | 'logout';
const CAPABILITY_VERIFICATION_TTL_MS = 60 * 60 * 1_000;
const MAX_CAPABILITY_VERIFICATIONS = 512;

type BridgeAdminStatus = {
  authStatus: 'unauthenticated' | 'pending' | 'ready' | 'expired' | 'error';
  accountLabel: string | null;
  authError: string | null;
  tokenExpiresAt?: number | null;
  attempt: ModelConnectionAuthState['attempt'];
};

type BridgeModelsResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export interface ModelConnectionOperationsOptions {
  modelConfig: ModelConfigService;
  codexBridge: CodexOAuthBridgeService;
  copilotBridge: CopilotOAuthBridgeService;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

export class ModelConnectionOperations {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly verifiedCapabilityFingerprints = new Map<string, number>();
  private readonly pendingCapabilityVerifications = new Map<string, Promise<void>>();

  constructor(private readonly options: ModelConnectionOperationsOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getAuthStates(
    aggregate: ModelConfigAggregate = this.options.modelConfig.getAggregate(),
  ): Promise<ModelConnectionAuthState[]> {
    return Promise.all(aggregate.connections.map(async (connection) => {
      if (connection.auth.kind === 'none') {
        return createAuthState(connection.id, {
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          attempt: null,
        }, 'not_required');
      }
      if (connection.auth.kind === 'apiKey') {
        return createAuthState(connection.id, {
          authStatus: connection.hasSecret ? 'ready' : 'unauthenticated',
          accountLabel: null,
          authError: connection.hasSecret ? null : 'API key 尚未配置。',
          attempt: null,
        });
      }
      const bridge = this.bridge(connection.auth.provider);
      try {
        return createAuthState(
          connection.id,
          await bridge.getAdminStatus({ probe: false }),
        );
      } catch (error) {
        return createAuthState(connection.id, {
          authStatus: 'error',
          accountLabel: null,
          authError: safeDiagnostic(error),
          tokenExpiresAt: null,
          attempt: null,
        });
      }
    }));
  }

  async verifyBindings(input: ModelConfigPutInput): Promise<void> {
    const connectionById = new Map(
      input.draft.connections.map((connection) => [connection.id, connection]),
    );
    const modelByIdentity = new Map(
      input.draft.models.map((model) => [
        modelIdentity(model.connectionId, model.id),
        model,
      ]),
    );
    const main = input.draft.bindings.find(
      (binding) => binding.workload === 'main.chat' && binding.mode === 'dedicated',
    );
    if (!main || main.mode !== 'dedicated') {
      throw new ModelConfigError({
        code: 'binding_invalid',
        operation: 'save',
        stage: 'validate',
        workload: 'main.chat',
        message: 'main.chat requires a dedicated model before capability verification',
      });
    }

    const secretOperationByConnection = new Map(
      input.secretOperations.map((operation) => [operation.connectionId, operation]),
    );
    const runtimeConnectionById = new Map<string, RuntimeConnection>();
    const executorByConnectionId = new Map<string, OpenAiConnectionExecutor>();

    for (const binding of input.draft.bindings) {
      const reference = binding.mode === 'dedicated'
        ? binding
        : binding.mode === 'inheritMain'
          ? main
          : null;
      if (!reference || reference.mode !== 'dedicated') continue;
      const connection = connectionById.get(reference.connectionId);
      const model = modelByIdentity.get(
        modelIdentity(reference.connectionId, reference.modelId),
      );
      if (!connection || !model) {
        throw new ModelConfigError({
          code: 'binding_invalid',
          operation: 'save',
          stage: 'validate',
          workload: binding.workload,
          connectionId: reference.connectionId,
          modelId: reference.modelId,
          message: `${binding.workload} references a missing model target`,
        });
      }

      let runtimeConnection = runtimeConnectionById.get(connection.id);
      if (!runtimeConnection) {
        runtimeConnection = this.createDraftRuntimeConnection(
          connection,
          secretOperationByConnection.get(connection.id),
        );
        runtimeConnectionById.set(connection.id, runtimeConnection);
      }
      let executor = executorByConnectionId.get(connection.id);
      if (!executor) {
        const transport = await this.resolveTransport(runtimeConnection);
        executor = new OpenAiConnectionExecutor({
          connectionId: connection.id,
          baseUrl: transport.baseUrl,
          apiKey: transport.apiKey,
          fetchFn: this.fetchFn,
        });
        executorByConnectionId.set(connection.id, executor);
      }
      const target = {
        canonicalModel: `qqbot-${connection.id}/${model.id}`,
        connection: runtimeConnection,
        model,
      };
      for (const kind of capabilityProbeKindsForWorkload(binding.workload, model)) {
        const fingerprint = modelCapabilityProbeFingerprint({
          connection: runtimeConnection,
          model,
          kind,
        });
        await this.verifyWithCache(fingerprint, () => verifyModelCapabilityProbe({
          workload: binding.workload,
          kind,
          target,
          executor,
        }));
      }
    }
  }

  async probe(connectionId: string): Promise<{
    connectionId: string;
    status: 'ready';
    checkedAt: string;
    latencyMs: number;
  }> {
    const runtime = this.connection(connectionId);
    const startedAt = performance.now();
    if (runtime.connection.adapter === 'codexBridge') {
      const status = await this.runBridgeOperation(
        connectionId,
        'probe',
        'oauth',
        () => this.options.codexBridge.getAdminStatus({ probe: true }),
      );
      this.assertBridgeReady(connectionId, status);
    } else if (runtime.connection.adapter === 'copilotBridge') {
      const status = await this.runBridgeOperation(
        connectionId,
        'probe',
        'oauth',
        () => this.options.copilotBridge.getAdminStatus({ probe: true }),
      );
      this.assertBridgeReady(connectionId, status);
    } else {
      await this.fetchOpenAiModels(runtime, 'probe');
    }
    return {
      connectionId,
      status: 'ready',
      checkedAt: this.now().toISOString(),
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  }

  async catalog(connectionId: string): Promise<{
    connectionId: string;
    fetchedAt: string;
    models: ModelCatalogEntry[];
  }> {
    const runtime = this.connection(connectionId);
    let models: ModelCatalogEntry[];
    if (runtime.connection.catalogDriver === 'static') {
      models = runtime.models.map((model) => ({
        transportModel: model.transportModel,
        displayName: model.displayName,
        requestMode: model.requestMode,
        structuredOutputProtocol: model.structuredOutputProtocol,
        metadataTags: [
          'chat',
          ...Object.entries(model.capabilities)
            .filter(([, enabled]) => enabled)
            .map(([capability]) => capability),
        ],
      }));
    } else if (runtime.connection.catalogDriver === 'openaiModels') {
      models = parseCatalogPayload(
        (await this.fetchOpenAiModels(runtime, 'catalog')).payload,
        'openaiCompatible',
      );
    } else if (runtime.connection.catalogDriver === 'codexBridge') {
      const response = await this.requireBridgeModels(
        connectionId,
        await this.runBridgeOperation(
          connectionId,
          'catalog',
          'transport',
          () => this.options.codexBridge.proxyModels({ forceRefresh: true }),
        ),
      );
      models = parseCatalogPayload(parseJson(response.body, connectionId), 'codexBridge');
    } else {
      const response = await this.requireBridgeModels(
        connectionId,
        await this.runBridgeOperation(
          connectionId,
          'catalog',
          'transport',
          () => this.options.copilotBridge.proxyModels(),
        ),
      );
      models = parseCatalogPayload(parseJson(response.body, connectionId), 'copilotBridge');
    }
    if (models.length === 0) {
      throw new AdminHttpError(
        502,
        'upstream_error',
        `连接 ${connectionId} 的 catalog 没有返回可用模型。`,
        { operation: 'catalog', stage: 'parse', connectionId },
      );
    }
    return {
      connectionId,
      fetchedAt: this.now().toISOString(),
      models,
    };
  }

  async oauth(
    connectionId: string,
    action: OAuthAction,
    attemptId?: string,
  ): Promise<ModelConnectionAuthState> {
    const runtime = this.connection(connectionId);
    if (runtime.connection.auth.kind !== 'oauth') {
      throw new AdminHttpError(
        400,
        'bad_request',
        `连接 ${connectionId} 没有使用 OAuth。`,
        { operation: `oauth_${action}`, stage: 'validate', connectionId },
      );
    }
    const bridge = this.bridge(runtime.connection.auth.provider);
    let status: BridgeAdminStatus;
    status = await this.runBridgeOperation(
      connectionId,
      `oauth_${action}`,
      'transport',
      async () => {
        if (action === 'start') return bridge.startLogin();
        if (action === 'logout') return bridge.logout();
        if (!attemptId) {
          throw new AdminHttpError(
            400,
            'bad_request',
            'OAuth poll 缺少 attemptId。',
            { operation: 'oauth_poll', stage: 'validate', connectionId },
          );
        }
        return bridge.pollLogin(attemptId);
      },
    );
    return createAuthState(connectionId, status);
  }

  private connection(connectionId: string): ConnectionRuntimeView {
    try {
      return this.options.modelConfig.getConnectionRuntime(connectionId);
    } catch (error) {
      if (error instanceof ModelConfigError) {
        throw new AdminHttpError(
          error.httpStatus,
          error.httpStatus === 404 ? 'not_found' : 'service_unavailable',
          error.message,
          modelConfigErrorDetails(error),
        );
      }
      throw error;
    }
  }

  private createDraftRuntimeConnection(
    connection: ModelConfigPutInput['draft']['connections'][number],
    secretOperation: ModelConfigPutInput['secretOperations'][number] | undefined,
  ): RuntimeConnection {
    if (connection.auth.kind !== 'apiKey') {
      return { ...connection, apiKey: null };
    }
    if (!secretOperation) {
      throw new ModelConfigError({
        code: 'secret_operation_invalid',
        operation: 'save',
        stage: 'credential',
        connectionId: connection.id,
        message: `missing secret operation for capability verification: ${connection.id}`,
      });
    }
    if (secretOperation.operation === 'set') {
      return { ...connection, apiKey: secretOperation.value };
    }
    if (secretOperation.operation === 'clear') {
      throw new ModelConfigError({
        code: 'credential_invalid',
        operation: 'save',
        stage: 'credential',
        connectionId: connection.id,
        message: `active model binding cannot clear the credential for ${connection.id}`,
      });
    }
    const current = this.connection(connection.id).connection;
    if (current.auth.kind !== 'apiKey') {
      throw new ModelConfigError({
        code: 'credential_invalid',
        operation: 'save',
        stage: 'credential',
        connectionId: connection.id,
        message: `retained credential source is invalid for ${connection.id}`,
      });
    }
    return { ...connection, apiKey: current.apiKey };
  }

  private async resolveTransport(
    connection: RuntimeConnection,
  ): Promise<{ baseUrl: string; apiKey: string | null }> {
    if (connection.adapter === 'codexBridge') {
      return this.options.codexBridge.getRuntimeConfig();
    }
    if (connection.adapter === 'copilotBridge') {
      return this.options.copilotBridge.getRuntimeConfig();
    }
    if (!connection.baseUrl) {
      throw new ModelConfigError({
        code: 'binding_invalid',
        operation: 'save',
        stage: 'validate',
        connectionId: connection.id,
        message: `connection ${connection.id} has no capability probe endpoint`,
      });
    }
    return {
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
    };
  }

  private async verifyWithCache(
    fingerprint: string,
    run: () => Promise<void>,
  ): Promise<void> {
    const now = this.now().getTime();
    const verifiedAt = this.verifiedCapabilityFingerprints.get(fingerprint);
    if (
      verifiedAt !== undefined
      && now - verifiedAt < CAPABILITY_VERIFICATION_TTL_MS
    ) {
      return;
    }
    this.verifiedCapabilityFingerprints.delete(fingerprint);
    const pending = this.pendingCapabilityVerifications.get(fingerprint);
    if (pending) return pending;
    const verification = run()
      .then(() => {
        this.verifiedCapabilityFingerprints.set(
          fingerprint,
          this.now().getTime(),
        );
        while (
          this.verifiedCapabilityFingerprints.size > MAX_CAPABILITY_VERIFICATIONS
        ) {
          const oldest = this.verifiedCapabilityFingerprints.keys().next().value;
          if (typeof oldest !== 'string') break;
          this.verifiedCapabilityFingerprints.delete(oldest);
        }
      })
      .finally(() => {
        this.pendingCapabilityVerifications.delete(fingerprint);
      });
    this.pendingCapabilityVerifications.set(fingerprint, verification);
    return verification;
  }

  private bridge(provider: 'codex' | 'copilot') {
    return provider === 'codex'
      ? this.options.codexBridge
      : this.options.copilotBridge;
  }

  private assertBridgeReady(connectionId: string, status: BridgeAdminStatus): void {
    if (status.authStatus === 'ready') return;
    throw new AdminHttpError(
      status.authStatus === 'unauthenticated' || status.authStatus === 'expired' ? 401 : 502,
      status.authStatus === 'unauthenticated' || status.authStatus === 'expired'
        ? 'provider_auth_required'
        : 'upstream_error',
      `连接 ${connectionId} 的 OAuth 状态为 ${status.authStatus}。`,
      {
        operation: 'probe',
        stage: 'oauth',
        connectionId,
        providerCode: status.authStatus,
        diagnostic: safeDiagnostic(status.authError),
      },
    );
  }

  private async fetchOpenAiModels(
    runtime: ConnectionRuntimeView,
    operation: 'probe' | 'catalog',
  ): Promise<{ payload: unknown }> {
    const baseUrl = runtime.connection.baseUrl;
    if (!baseUrl) {
      throw new AdminHttpError(
        400,
        'bad_request',
        `连接 ${runtime.connection.id} 缺少 Base URL。`,
        { operation, stage: 'validate', connectionId: runtime.connection.id },
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetchFn(`${baseUrl.replace(/\/+$/u, '')}/models`, {
        headers: {
          Accept: 'application/json',
          ...(runtime.connection.apiKey
            ? { Authorization: `Bearer ${runtime.connection.apiKey}` }
            : {}),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw upstreamHttpError(
          operation,
          runtime.connection.id,
          response.status,
          providerErrorCode(text),
        );
      }
      return { payload: parseJson(text, runtime.connection.id) };
    } catch (error) {
      if (error instanceof AdminHttpError) throw error;
      throw new AdminHttpError(
        502,
        'upstream_error',
        `连接 ${runtime.connection.id} 的 ${operation} 请求失败。`,
        {
          operation,
          stage: 'transport',
          connectionId: runtime.connection.id,
          providerCode: error instanceof Error && error.name === 'AbortError'
            ? 'request_timeout'
            : 'transport_failure',
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requireBridgeModels(
    connectionId: string,
    response: BridgeModelsResponse,
  ): Promise<BridgeModelsResponse> {
    if (response.status >= 200 && response.status < 300) return response;
    throw upstreamHttpError(
      'catalog',
      connectionId,
      response.status,
      providerErrorCode(response.body),
    );
  }

  private async runBridgeOperation<T>(
    connectionId: string,
    operation: 'probe' | 'catalog' | `oauth_${OAuthAction}`,
    stage: 'oauth' | 'transport',
    execute: () => Promise<T>,
  ): Promise<T> {
    try {
      return await execute();
    } catch (error) {
      if (error instanceof AdminHttpError) throw error;
      throw new AdminHttpError(
        502,
        'upstream_error',
        `连接 ${connectionId} 的 ${operation} 操作失败。`,
        {
          operation,
          stage,
          connectionId,
          ...upstreamFailureDetails(error),
        },
      );
    }
  }
}

function modelIdentity(connectionId: string, modelId: string): string {
  return `${connectionId}/${modelId}`;
}

function createAuthState(
  connectionId: string,
  status: BridgeAdminStatus,
  overrideStatus?: ModelConnectionAuthState['status'],
): ModelConnectionAuthState {
  return {
    connectionId,
    status: overrideStatus ?? status.authStatus,
    accountLabel: status.accountLabel,
    error: safeDiagnostic(status.authError),
    tokenExpiresAt: status.tokenExpiresAt ?? null,
    attempt: status.attempt
      ? { ...status.attempt, error: safeDiagnostic(status.attempt.error) }
      : null,
  };
}

function parseCatalogPayload(
  payload: unknown,
  adapter: 'openaiCompatible' | 'codexBridge' | 'copilotBridge',
): ModelCatalogEntry[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  const seen = new Set<string>();
  const entries: ModelCatalogEntry[] = [];
  for (const item of payload.data) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim()) continue;
    const transportModel = item.id.trim();
    if (seen.has(transportModel)) continue;
    seen.add(transportModel);
    const qqbot = isRecord(item.qqbot) ? item.qqbot : {};
    const requestMode = adapter === 'codexBridge'
      ? 'responses'
      : qqbot.requestMode === 'responses'
        ? 'responses'
        : qqbot.requestMode === 'chat_completions'
          ? 'chat_completions'
          : null;
    const structuredOutputProtocol = adapter === 'codexBridge'
      ? 'native_responses_json_schema'
      : [
          'native_chat_json_schema',
          'native_responses_json_schema',
          'chat_reply_v1',
          'json_mode',
        ].includes(String(qqbot.structuredOutputProtocol))
        ? qqbot.structuredOutputProtocol as ModelCatalogEntry['structuredOutputProtocol']
        : null;
    entries.push({
      transportModel,
      displayName: typeof item.name === 'string' && item.name.trim()
        ? item.name.trim()
        : transportModel,
      requestMode,
      structuredOutputProtocol,
      metadataTags: Array.isArray(qqbot.metadataTags)
        ? qqbot.metadataTags.filter((tag): tag is string => typeof tag === 'string' && Boolean(tag.trim()))
        : [],
    });
  }
  return entries;
}

function parseJson(text: string, connectionId: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AdminHttpError(
      502,
      'upstream_error',
      `连接 ${connectionId} 返回了无效 JSON。`,
      { operation: 'catalog', stage: 'parse', connectionId, providerCode: 'invalid_json' },
    );
  }
}

function providerErrorCode(text: string): string | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value) || !isRecord(value.error)) return null;
    const code = value.error.code;
    return typeof code === 'string'
      ? code.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 120) || null
      : null;
  } catch {
    return null;
  }
}

function upstreamHttpError(
  operation: 'probe' | 'catalog',
  connectionId: string,
  upstreamStatus: number,
  providerCode: string | null,
): AdminHttpError {
  return new AdminHttpError(
    502,
    'upstream_error',
    `连接 ${connectionId} 的 ${operation} 请求返回 HTTP ${upstreamStatus}。`,
    {
      operation,
      stage: 'transport',
      connectionId,
      upstreamStatus,
      ...(providerCode ? { providerCode } : {}),
    },
  );
}

function safeDiagnostic(value: unknown): string | null {
  if (value == null) return null;
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/([?&](?:api[_-]?key|token|secret|code)=)[^&\s]+/giu, '$1[redacted]')
    .replace(/\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, '[credential redacted]')
    .replace(/\b(?:sk|key|token)-[a-z0-9._-]{8,}\b/giu, '[credential redacted]')
    .slice(0, 500);
}

function upstreamFailureDetails(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { providerCode: 'bridge_failure' };
  const numericStatus = Number(value.status ?? value.statusCode);
  const providerCode = typeof value.code === 'string'
    ? value.code.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 120)
    : '';
  return {
    ...(Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599
      ? { upstreamStatus: numericStatus }
      : {}),
    providerCode: providerCode || 'bridge_failure',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function modelConfigErrorDetails(error: ModelConfigError): Record<string, unknown> {
  return {
    modelConfigErrorCode: error.code,
    operation: error.operation,
    stage: error.stage,
    ...(error.path ? { path: error.path } : {}),
    ...(error.connectionId ? { connectionId: error.connectionId } : {}),
    ...(error.modelId ? { modelId: error.modelId } : {}),
    ...(error.workload ? { workload: error.workload } : {}),
    ...(error.expectedRevision === undefined ? {} : { expectedRevision: error.expectedRevision }),
    ...(error.actualRevision === undefined ? {} : { actualRevision: error.actualRevision }),
    ...(error.upstreamStatus === undefined ? {} : { upstreamStatus: error.upstreamStatus }),
    ...(error.providerCode ? { providerCode: error.providerCode } : {}),
  };
}
