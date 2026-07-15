import { adminErrorSchema } from '@contracts';

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

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
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

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  return parseResponse<T>(response);
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export async function apiAudio(path: string, body: unknown): Promise<Blob> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  if (!response.ok) await parseResponse(response);
  return response.blob();
}
