import { randomUUID } from 'node:crypto';

export class AdminHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | 'bad_request'
      | 'unauthorized'
      | 'forbidden_origin'
      | 'invalid_host'
      | 'not_found'
      | 'conflict'
      | 'provider_auth_required'
      | 'memory_error'
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
  private readonly loopbackHosts: ReadonlySet<string>;

  constructor(allowedOrigins: string[]) {
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
      throw new Error('Admin allowed origins 不能为空。');
    }
    const origins = allowedOrigins.map(normalizeOrigin);
    this.allowedOrigins = new Set(origins);
    this.allowedHosts = new Set(origins.map((origin) => new URL(origin).host));
    this.loopbackHosts = new Set(
      origins
        .map((origin) => new URL(origin))
        .filter((url) => isLoopbackHostname(url.hostname))
        .map((url) => url.host),
    );
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

  assertAuthenticatedTransport(input: {
    host: string;
    remoteAddress: string;
    tailscaleUserLogin: string;
  }): void {
    const host = input.host.trim().toLowerCase();
    this.assertHost(host);
    if (!isLoopbackAddress(input.remoteAddress)) {
      throw new AdminHttpError(401, 'unauthorized', '管理端只接受本机认证代理或 SSH 转发连接。');
    }
    if (this.loopbackHosts.has(host)) return;
    if (!input.tailscaleUserLogin.trim()) {
      throw new AdminHttpError(401, 'unauthorized', 'Tailnet 管理端请求缺少认证身份。');
    }
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1';
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1';
}

export function createRequestId(): string {
  return randomUUID();
}
