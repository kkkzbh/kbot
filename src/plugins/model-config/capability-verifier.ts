import { createHash } from 'node:crypto';
import { ModelConfigError } from './errors.js';
import type {
  ManagedChatResponse,
  ModelConnectionExecutor,
} from './runtime-client.js';
import type { ResolvedModelTarget } from './resolver.js';
import type {
  ModelDefinition,
  ModelWorkload,
  RuntimeConnection,
} from './types.js';

export type ModelCapabilityProbeKind =
  | 'nativeStructuredOutput'
  | 'toolCalling'
  | 'visionStructuredOutput';

const PROBE_TOOL_NAME = 'qqbot_capability_probe';
const RED_PIXEL_DATA_URL = [
  'data:image/png;base64,',
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOk',
  'AAAAUSURBVAiZY/zPwPCfgYGBgYkBCgAfFwICvtwYPAAAAABJRU5ErkJggg==',
].join('');

const STRICT_OK_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', const: true },
  },
  required: ['ok'],
  additionalProperties: false,
} as const;

const STRICT_COLOR_SCHEMA = {
  type: 'object',
  properties: {
    color: { type: 'string', enum: ['red'] },
  },
  required: ['color'],
  additionalProperties: false,
} as const;

export function capabilityProbeKindsForWorkload(
  workload: ModelWorkload,
  model: ModelDefinition,
): readonly ModelCapabilityProbeKind[] {
  if (workload === 'sticker.index') return ['visionStructuredOutput'];
  if (
    workload === 'memory.extract'
    || workload === 'affinity.analysis'
    || workload === 'naturalTrigger.decision'
  ) {
    return ['nativeStructuredOutput'];
  }
  if (workload === 'main.chat') {
    return model.structuredOutputProtocol === 'native_chat_json_schema'
      || model.structuredOutputProtocol === 'native_responses_json_schema'
      ? ['toolCalling', 'nativeStructuredOutput']
      : ['toolCalling'];
  }
  return workload.startsWith('agent.subagent.')
    ? ['toolCalling']
    : [];
}

export function modelCapabilityProbeFingerprint(args: {
  connection: RuntimeConnection;
  model: ModelDefinition;
  kind: ModelCapabilityProbeKind;
}): string {
  const { connection, model, kind } = args;
  return createHash('sha256').update(JSON.stringify({
    connection: {
      id: connection.id,
      adapter: connection.adapter,
      baseUrl: connection.baseUrl,
      authKind: connection.auth.kind,
      authProvider: connection.auth.kind === 'oauth'
        ? connection.auth.provider
        : null,
      credentialDigest: connection.apiKey
        ? createHash('sha256').update(connection.apiKey).digest('hex')
        : null,
    },
    model: {
      id: model.id,
      connectionId: model.connectionId,
      transportModel: model.transportModel,
      requestMode: model.requestMode,
      structuredOutputProtocol: model.structuredOutputProtocol,
      capabilities: model.capabilities,
    },
    kind,
  })).digest('hex');
}

export async function verifyModelCapabilityProbe(args: {
  workload: ModelWorkload;
  kind: ModelCapabilityProbeKind;
  target: ResolvedModelTarget;
  executor: ModelConnectionExecutor;
}): Promise<void> {
  const { workload, kind, target, executor } = args;
  try {
    if (kind === 'toolCalling') {
      const response = await executor.execute({
        operation: 'chat',
        target,
        payload: {
          messages: [{
            role: 'user',
            content: 'Call the required function once with marker set to "ok".',
          }],
          tools: [{
            name: PROBE_TOOL_NAME,
            description: 'Minimal model capability verification function.',
            parameters: {
              type: 'object',
              properties: {
                marker: { type: 'string', const: 'ok' },
              },
              required: ['marker'],
              additionalProperties: false,
            },
            strict: true,
          }],
          toolChoice: PROBE_TOOL_NAME,
          temperature: 0,
          maxOutputTokens: 24,
        },
      });
      assertToolProbeResponse(response, workload, target);
      return;
    }

    const vision = kind === 'visionStructuredOutput';
    const response = await executor.execute({
      operation: 'chat',
      target,
      payload: {
        messages: [{
          role: 'user',
          content: vision
            ? [
                { type: 'text', text: 'Identify the dominant color of this image.' },
                { type: 'imageUrl', url: RED_PIXEL_DATA_URL, detail: 'low' },
              ]
            : 'Return the required JSON object.',
        }],
        structuredOutput: {
          name: vision ? 'qqbot_vision_capability_probe' : 'qqbot_schema_capability_probe',
          schema: vision ? STRICT_COLOR_SCHEMA : STRICT_OK_SCHEMA,
          strict: true,
        },
        temperature: 0,
        maxOutputTokens: 16,
      },
    });
    const payload = parseObjectResponse(response, workload, target);
    if (vision ? payload.color !== 'red' : payload.ok !== true) {
      throw invalidProbeResult(workload, target, 'structured result failed semantic validation');
    }
  } catch (error) {
    if (error instanceof ModelConfigError) {
      if (error.workload) throw error;
      throw new ModelConfigError({
        code: error.code,
        operation: error.operation,
        stage: error.stage,
        httpStatus: error.httpStatus,
        connectionId: error.connectionId ?? target.connection.id,
        modelId: error.modelId ?? target.model.id,
        workload,
        upstreamStatus: error.upstreamStatus,
        providerCode: error.providerCode,
        message: error.message,
        cause: error,
      });
    }
    throw invalidProbeResult(
      workload,
      target,
      error instanceof Error ? error.message : 'unknown verification failure',
      error,
    );
  }
}

function assertToolProbeResponse(
  response: ManagedChatResponse,
  workload: ModelWorkload,
  target: ResolvedModelTarget,
): void {
  const calls = response.toolCalls ?? [];
  if (calls.length !== 1 || calls[0].name !== PROBE_TOOL_NAME) {
    throw invalidProbeResult(workload, target, 'required tool call is missing');
  }
  let value: unknown;
  try {
    value = JSON.parse(calls[0].arguments) as unknown;
  } catch (error) {
    throw invalidProbeResult(workload, target, 'tool arguments are not valid JSON', error);
  }
  if (!isRecord(value) || value.marker !== 'ok') {
    throw invalidProbeResult(workload, target, 'tool arguments failed semantic validation');
  }
}

function parseObjectResponse(
  response: ManagedChatResponse,
  workload: ModelWorkload,
  target: ResolvedModelTarget,
): Record<string, unknown> {
  if (response.text.trim().length === 0) {
    throw invalidProbeResult(workload, target, 'structured response is empty');
  }
  let value: unknown;
  try {
    value = JSON.parse(response.text) as unknown;
  } catch (error) {
    throw invalidProbeResult(workload, target, 'structured response is not valid JSON', error);
  }
  if (!isRecord(value)) {
    throw invalidProbeResult(workload, target, 'structured response is not an object');
  }
  return value;
}

function invalidProbeResult(
  workload: ModelWorkload,
  target: ResolvedModelTarget,
  reason: string,
  cause?: unknown,
): ModelConfigError {
  return new ModelConfigError({
    code: 'binding_invalid',
    operation: 'save',
    stage: 'validate',
    connectionId: target.connection.id,
    modelId: target.model.id,
    workload,
    providerCode: 'capability_probe_failed',
    message: `${workload} capability verification failed: ${reason}`,
    cause,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
