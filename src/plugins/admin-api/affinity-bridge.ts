import type { AffinityManualRandomPlanInput } from '../../types/affinity.js';

export class AffinityBridgeHttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AffinityBridgeHttpError';
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeDelayMs(value: unknown): number {
  const parsed = Number(value ?? 5000);
  if (!Number.isFinite(parsed)) {
    throw new AffinityBridgeHttpError(400, 'invalid_delay', 'delayMs must be a finite number');
  }
  return Math.max(0, Math.min(10 * 60 * 1000, Math.floor(parsed)));
}

export function parseAffinityRandomPlanBridgeRequest(payload: unknown): AffinityManualRandomPlanInput {
  if (!isRecord(payload)) {
    throw new AffinityBridgeHttpError(400, 'invalid_payload', 'request body must be a JSON object');
  }
  if (payload.scopeKind !== 'group') {
    throw new AffinityBridgeHttpError(400, 'invalid_scope_kind', 'scopeKind must be group');
  }
  const scopeId = normalizeText(payload.scopeId);
  if (!scopeId) {
    throw new AffinityBridgeHttpError(400, 'invalid_scope_id', 'scopeId is required');
  }
  return {
    scopeKind: 'group',
    scopeId,
    delayMs: normalizeDelayMs(payload.delayMs),
    platform: normalizeText(payload.platform) || null,
    botSelfId: normalizeText(payload.botSelfId) || null,
    channelId: normalizeText(payload.channelId) || scopeId,
    guildId: normalizeText(payload.guildId) || scopeId,
    conversationId: normalizeText(payload.conversationId) || null,
  };
}
