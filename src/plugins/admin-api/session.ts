import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const ADMIN_SESSION_COOKIE = 'qqbot_admin_session';

export type AdminSessionOptions = {
  accessToken: string;
  sessionSecret: string;
  allowedOrigins: string[];
  ttlSeconds: number;
};

export type AdminSessionState = {
  authenticated: boolean;
  expiresAt: number | null;
};

export class AdminHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | 'bad_request'
      | 'unauthenticated'
      | 'forbidden_origin'
      | 'invalid_host'
      | 'not_found'
      | 'conflict'
      | 'upstream_error'
      | 'service_unavailable'
      | 'internal_error',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
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

export class AdminSessionService {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowedHosts: ReadonlySet<string>;
  readonly secureHosts: ReadonlySet<string>;

  constructor(readonly options: AdminSessionOptions) {
    if (typeof options.accessToken !== 'string' || options.accessToken.length < 16) {
      throw new Error('Admin access token 至少需要 16 个字符。');
    }
    if (typeof options.sessionSecret !== 'string' || options.sessionSecret.length < 32) {
      throw new Error('Admin session secret 至少需要 32 个字符。');
    }
    if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds < 300 || options.ttlSeconds > 31_536_000) {
      throw new Error('Admin session TTL 必须在 300 到 31536000 秒之间。');
    }
    if (!Array.isArray(options.allowedOrigins) || options.allowedOrigins.length === 0) {
      throw new Error('Admin allowed origins 不能为空。');
    }
    const origins = options.allowedOrigins.map(normalizeOrigin);
    this.allowedOrigins = new Set(origins);
    this.allowedHosts = new Set(origins.map((origin) => new URL(origin).host));
    this.secureHosts = new Set(origins.filter((origin) => new URL(origin).protocol === 'https:').map((origin) => new URL(origin).host));
  }

  shouldUseSecureCookie(host: string): boolean {
    return this.secureHosts.has(host.trim().toLowerCase());
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

  authenticateAccessToken(accessToken: string): void {
    if (!constantTimeEqual(accessToken, this.options.accessToken)) {
      throw new AdminHttpError(401, 'unauthenticated', 'Access token 无效。');
    }
  }

  issue(now = Date.now()): { token: string; expiresAt: number } {
    const issuedAt = Math.floor(now / 1000);
    const expiresAtSeconds = issuedAt + this.options.ttlSeconds;
    const payload = `v1.${issuedAt}.${expiresAtSeconds}.${randomUUID()}`;
    return {
      token: `${payload}.${this.sign(payload)}`,
      expiresAt: expiresAtSeconds * 1000,
    };
  }

  verify(token: string | undefined, now = Date.now()): AdminSessionState {
    if (!token) return { authenticated: false, expiresAt: null };
    const segments = token.split('.');
    if (segments.length !== 5 || segments[0] !== 'v1') {
      return { authenticated: false, expiresAt: null };
    }
    const payload = segments.slice(0, 4).join('.');
    const expectedSignature = this.sign(payload);
    if (!constantTimeEqual(segments[4], expectedSignature)) {
      return { authenticated: false, expiresAt: null };
    }
    const expiresAtSeconds = Number(segments[2]);
    if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds * 1000 <= now) {
      return { authenticated: false, expiresAt: null };
    }
    return { authenticated: true, expiresAt: expiresAtSeconds * 1000 };
  }

  require(token: string | undefined, now = Date.now()): AdminSessionState {
    const state = this.verify(token, now);
    if (!state.authenticated) {
      throw new AdminHttpError(401, 'unauthenticated', '管理会话无效或已过期。');
    }
    return state;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.options.sessionSecret).update(payload).digest('base64url');
  }
}

export function createRequestId(): string {
  return randomUUID();
}
