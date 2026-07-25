import { adminErrorSchema } from '@contracts';
import type { z } from 'zod';

const API_BASE = '/api/admin/v1';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function parseErrorResponse(response: Response): Promise<never> {
  const body = await response.json().catch(() => null);
  const parsed = adminErrorSchema.safeParse(body);
  if (parsed.success) {
    throw new ApiError(
      parsed.data.error.message,
      response.status,
      parsed.data.error.code,
      parsed.data.error.requestId,
      parsed.data.error.details,
    );
  }
  throw new ApiError(`Admin API 返回 HTTP ${response.status}`, response.status, 'unknown', response.headers.get('x-request-id'));
}

async function readResponse(response: Response): Promise<unknown> {
  if (response.ok) {
    if (response.status === 204) return undefined;
    return response.json();
  }
  return parseErrorResponse(response);
}

async function request(path: string, options: RequestInit): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
}

export async function api<Schema extends z.ZodTypeAny>(
  path: string,
  responseSchema: Schema,
  options: RequestInit = {},
): Promise<z.infer<Schema>> {
  const response = await request(path, options);
  return responseSchema.parse(await readResponse(response));
}

export async function rawApi<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await request(path, options);
  return await readResponse(response) as T;
}

export function jsonBody<Schema extends z.ZodTypeAny>(
  requestSchema: Schema,
  value: unknown,
): string {
  return JSON.stringify(requestSchema.parse(value));
}

export function rawJsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export async function apiAudio(path: string, body: unknown): Promise<Blob> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  if (!response.ok) await readResponse(response);
  return response.blob();
}
