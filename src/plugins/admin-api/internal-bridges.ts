import type { Context, Logger } from 'koishi';
import type {} from '@koishijs/plugin-server';
import { CopilotOAuthBridgeService } from '../copilot-oauth/index.js';
import { CodexOAuthBridgeService } from '../codex-oauth/index.js';
import type { AffinityServiceLike } from '../../types/affinity.js';
import {
  AffinityBridgeHttpError,
  parseAffinityRandomPlanBridgeRequest,
} from './affinity-bridge.js';
import {
  parseQqVoiceBridgeRequest,
  QqVoiceBridgeHttpError,
  sendVoiceByBridge,
  validateVoiceBridgeAuthHeader,
} from './voice-bridge.js';

function writeJsonError(koaCtx: any, status: number, type: string, message: string): void {
  koaCtx.status = status;
  koaCtx.type = 'application/json';
  koaCtx.body = { error: { message, type } };
}

function setBridgeCorsHeaders(koaCtx: any): void {
  koaCtx.set('access-control-allow-origin', '*');
  koaCtx.set('access-control-allow-methods', 'POST, OPTIONS');
  koaCtx.set('access-control-allow-headers', 'authorization, content-type');
  koaCtx.set('access-control-max-age', '600');
}

function logBridgeFailure(
  logger: Logger,
  provider: 'codex',
  operation: 'models' | 'responses',
  result: { status: number; body: string },
): void {
  if (result.status < 400) return;
  let providerCode = '<none>';
  let providerType = '<none>';
  let providerMessage = '<unavailable>';
  try {
    const parsed = JSON.parse(result.body) as {
      error?: { code?: unknown; type?: unknown; message?: unknown };
    };
    const error = parsed.error;
    if (typeof error?.code === 'string' && error.code.trim()) providerCode = error.code.trim();
    if (typeof error?.type === 'string' && error.type.trim()) providerType = error.type.trim();
    if (typeof error?.message === 'string' && error.message.trim()) {
      providerMessage = error.message.trim().slice(0, 1_000);
    }
  } catch {
    providerMessage = '<non-json response>';
  }
  logger.error(
    '%s bridge failure: operation=%s httpStatus=%s providerCode=%s providerType=%s providerMessage=%j',
    provider,
    operation,
    String(result.status),
    providerCode,
    providerType,
    providerMessage,
  );
}

async function validateCopilotBridgeAuth(koaCtx: any, bridge: CopilotOAuthBridgeService): Promise<boolean> {
  const expected = await bridge.getRuntimeConfig();
  if (String(koaCtx.get('authorization') || '').trim() === `Bearer ${expected.apiKey}`) return true;
  writeJsonError(koaCtx, 401, 'invalid_request_error', 'invalid copilot bridge authorization');
  return false;
}

async function validateCodexBridgeAuth(koaCtx: any, bridge: CodexOAuthBridgeService): Promise<boolean> {
  const expected = await bridge.getRuntimeConfig();
  if (String(koaCtx.get('authorization') || '').trim() === `Bearer ${expected.apiKey}`) return true;
  writeJsonError(koaCtx, 401, 'invalid_request_error', 'invalid codex bridge authorization');
  return false;
}

export function registerInternalBridges(options: {
  ctx: Context;
  copilotBridge: CopilotOAuthBridgeService;
  codexBridge: CodexOAuthBridgeService;
  getAffinity: () => AffinityServiceLike | undefined;
  logger: Logger;
}): void {
  const server = options.ctx.server as any;

  server.get('/api/internal/copilot/v1/models', async (koaCtx: any) => {
    if (!(await validateCopilotBridgeAuth(koaCtx, options.copilotBridge))) return;
    const result = await options.copilotBridge.proxyModels();
    koaCtx.status = result.status;
    for (const [key, value] of Object.entries(result.headers)) koaCtx.set(key, value);
    koaCtx.body = result.body;
  });
  server.post('/api/internal/copilot/v1/responses', async (koaCtx: any) => {
    if (!(await validateCopilotBridgeAuth(koaCtx, options.copilotBridge))) return;
    const result = await options.copilotBridge.proxyResponses(koaCtx.request.body);
    koaCtx.status = result.status;
    for (const [key, value] of Object.entries(result.headers)) koaCtx.set(key, value);
    koaCtx.body = result.body;
  });
  server.post('/api/internal/copilot/v1/chat/completions', async (koaCtx: any) => {
    if (!(await validateCopilotBridgeAuth(koaCtx, options.copilotBridge))) return;
    const result = await options.copilotBridge.proxyChatCompletions(koaCtx.request.body);
    koaCtx.status = result.status;
    for (const [key, value] of Object.entries(result.headers)) koaCtx.set(key, value);
    koaCtx.body = result.body;
  });
  server.get('/api/internal/codex/v1/models', async (koaCtx: any) => {
    if (!(await validateCodexBridgeAuth(koaCtx, options.codexBridge))) return;
    const result = await options.codexBridge.proxyModels();
    logBridgeFailure(options.logger, 'codex', 'models', result);
    koaCtx.status = result.status;
    for (const [key, value] of Object.entries(result.headers)) koaCtx.set(key, value);
    koaCtx.body = result.body;
  });
  server.post('/api/internal/codex/v1/responses', async (koaCtx: any) => {
    if (!(await validateCodexBridgeAuth(koaCtx, options.codexBridge))) return;
    const result = await options.codexBridge.proxyResponses(koaCtx.request.body);
    logBridgeFailure(options.logger, 'codex', 'responses', result);
    koaCtx.status = result.status;
    for (const [key, value] of Object.entries(result.headers)) koaCtx.set(key, value);
    koaCtx.body = result.body;
  });

  server.options('/api/internal/qq-voice/v1/send', (koaCtx: any) => {
    setBridgeCorsHeaders(koaCtx);
    koaCtx.status = 204;
  });
  server.options('/api/internal/affinity/v1/random-plans', (koaCtx: any) => {
    setBridgeCorsHeaders(koaCtx);
    koaCtx.status = 204;
  });
  server.post('/api/internal/qq-voice/v1/send', async (koaCtx: any) => {
    setBridgeCorsHeaders(koaCtx);
    if (!validateVoiceBridgeAuthHeader(String(koaCtx.get('authorization') || ''))) {
      writeJsonError(koaCtx, 401, 'invalid_request_error', 'invalid qq voice bridge authorization');
      return;
    }
    try {
      const response = await sendVoiceByBridge(options.ctx, parseQqVoiceBridgeRequest(koaCtx.request.body));
      koaCtx.status = 200;
      koaCtx.type = 'application/json';
      koaCtx.body = response;
    } catch (error) {
      if (error instanceof QqVoiceBridgeHttpError) {
        writeJsonError(koaCtx, error.status, error.code, error.message);
        return;
      }
      options.logger.warn('qq voice bridge failed: %s', error instanceof Error ? error.message : String(error));
      writeJsonError(koaCtx, 500, 'internal_error', 'qq voice bridge failed');
    }
  });
  server.post('/api/internal/affinity/v1/random-plans', async (koaCtx: any) => {
    setBridgeCorsHeaders(koaCtx);
    if (!validateVoiceBridgeAuthHeader(String(koaCtx.get('authorization') || ''))) {
      writeJsonError(koaCtx, 401, 'invalid_request_error', 'invalid affinity bridge authorization');
      return;
    }
    const affinity = options.getAffinity();
    if (!affinity?.createManualRandomPlan) {
      writeJsonError(koaCtx, 503, 'affinity_unavailable', 'affinity service is unavailable');
      return;
    }
    try {
      const response = await affinity.createManualRandomPlan(parseAffinityRandomPlanBridgeRequest(koaCtx.request.body));
      koaCtx.status = 200;
      koaCtx.type = 'application/json';
      koaCtx.body = response;
    } catch (error) {
      if (error instanceof AffinityBridgeHttpError) {
        writeJsonError(koaCtx, error.status, error.code, error.message);
        return;
      }
      if (error instanceof Error && error.message === 'affinity is disabled') {
        writeJsonError(koaCtx, 503, 'affinity_disabled', error.message);
        return;
      }
      options.logger.warn('affinity bridge failed: %s', error instanceof Error ? error.message : String(error));
      writeJsonError(koaCtx, 500, 'internal_error', 'affinity bridge failed');
    }
  });
}
