import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

vi.mock('koishi-plugin-chatluna', () => ({
  logger: {
    error: vi.fn(),
  },
}));
vi.mock('koishi-plugin-chatluna/llm-core/utils/count_tokens', () => ({
  getModelContextSize: vi.fn(),
}));
vi.mock('koishi-plugin-chatluna/utils/sse', () => ({
  sseIterable: vi.fn(),
}));
vi.mock('koishi-plugin-chatluna/utils/string', () => ({
  getImageMimeType: vi.fn(),
  getMessageContent: vi.fn(),
  getMimeTypeFromSource: vi.fn(),
  isMessageContentImageUrl: vi.fn(),
}));
vi.mock('koishi-plugin-chatluna/utils/langchain', () => ({
  isChatLunaUserMessage: vi.fn(),
  isMessageContentAudio: vi.fn(),
}));
vi.mock('koishi-plugin-chatluna/utils/logger', () => ({
  logger: undefined,
  trackLogToLocal: vi.fn(),
}));
vi.mock('koishi-plugin-chatluna/utils/object', () => ({
  deepAssign: vi.fn(),
}));

import {
  ChatLunaError,
  ChatLunaHttpError,
  isRetryableModelError,
} from 'koishi-plugin-chatluna/utils/error';
import { resolveChatlunaSiblingPackageRoot } from './helpers/chatluna-paths.js';

async function captureResponseError(status: number, body: unknown): Promise<ChatLunaError> {
  const sharedAdapterUrl = pathToFileURL(
    join(resolveChatlunaSiblingPackageRoot('shared-adapter'), 'lib/index.mjs'),
  ).href;
  const { processResponseApiResponse } = await import(sharedAdapterUrl) as {
    processResponseApiResponse: (response: Response) => Promise<unknown>;
  };
  try {
    await processResponseApiResponse(new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }));
  } catch (error) {
    if (error instanceof ChatLunaError) return error;
    throw error;
  }
  throw new Error(`expected HTTP ${status} to reject`);
}

describe('ChatLuna provider HTTP diagnostics', () => {
  it('preserves quota status, provider code, and non-retryable classification', async () => {
    const error = await captureResponseError(402, {
      error: {
        message: 'You have exceeded your monthly quota',
        code: 'quota_exceeded',
      },
    });

    expect(error.originError).toBeInstanceOf(ChatLunaHttpError);
    expect(error.originError).toMatchObject({
      status: 402,
      providerCode: 'quota_exceeded',
      providerMessage: 'You have exceeded your monthly quota',
    });
    expect(isRetryableModelError(error)).toBe(false);
  });

  it('keeps gateway failures retryable', async () => {
    const error = await captureResponseError(502, {
      error: {
        message: 'Copilot Auto router transport failed',
        code: 'upstream_transport_error',
      },
    });

    expect(error.originError).toMatchObject({
      status: 502,
      providerCode: 'upstream_transport_error',
    });
    expect(isRetryableModelError(error)).toBe(true);
  });
});
