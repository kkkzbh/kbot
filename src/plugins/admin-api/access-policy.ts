import { randomUUID } from 'node:crypto';

export class AdminHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | 'bad_request'
      | 'forbidden_origin'
      | 'invalid_host'
      | 'not_found'
      | 'conflict'
      | 'provider_auth_required'
      | 'upstream_error'
      | 'service_unavailable'
      | 'internal_error',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`管理端 Origin 格式不正确：${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`管理端 Origin 仅支持 HTTP/HTTPS：${value}`);
  }
  return url.origin;
}

export class AdminAccessPolicy {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowedHosts: ReadonlySet<string>;

  constructor(allowedOrigins: string[]) {
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
      throw new Error('Admin allowed origins 不能为空。');
    }
    const origins = allowedOrigins.map(normalizeOrigin);
    this.allowedOrigins = new Set(origins);
    this.allowedHosts = new Set(origins.map((origin) => new URL(origin).host));
  }

  assertHost(host: string): void {
    if (!this.allowedHosts.has(host.trim().toLowerCase())) {
      throw new AdminHttpError(421, 'invalid_host', '当前 Host 不允许访问管理端。');
    }
  }

  assertMutationOrigin(origin: string): void {
    if (!this.allowedOrigins.has(origin.trim())) {
      throw new AdminHttpError(403, 'forbidden_origin', '当前 Origin 不允许执行管理操作。');
    }
  }
}

export function createRequestId(): string {
  return randomUUID();
}
