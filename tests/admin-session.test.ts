import { describe, expect, it } from 'vitest';
import { AdminHttpError, AdminSessionService } from '../src/plugins/admin-api/session.js';

function createSession() {
  return new AdminSessionService({
    accessToken: 'admin-access-token',
    sessionSecret: 'admin-session-secret-with-more-than-32-characters',
    allowedOrigins: ['https://admin.example.com'],
    ttlSeconds: 3600,
  });
}

describe('admin session security boundary', () => {
  it('issues and validates expiring HMAC sessions', () => {
    const service = createSession();
    const issued = service.issue(1_800_000_000_000);
    expect(service.verify(issued.token, 1_800_000_001_000)).toEqual({ authenticated: true, expiresAt: 1_800_003_600_000 });
    expect(service.verify(`${issued.token}x`, 1_800_000_001_000)).toEqual({ authenticated: false, expiresAt: null });
    expect(service.verify(issued.token, issued.expiresAt)).toEqual({ authenticated: false, expiresAt: null });
  });

  it('rejects invalid access tokens, hosts and mutation origins', () => {
    const service = createSession();
    expect(() => service.authenticateAccessToken('wrong-access-token')).toThrow(AdminHttpError);
    expect(() => service.assertHost('public.example.com')).toThrowError(/Host/);
    expect(() => service.assertMutationOrigin('https://evil.example.com')).toThrowError(/Origin/);
    expect(() => service.assertHost('admin.example.com')).not.toThrow();
    expect(() => service.assertMutationOrigin('https://admin.example.com')).not.toThrow();
  });

  it('requires explicit secure configuration', () => {
    expect(() => new AdminSessionService({ accessToken: 'short', sessionSecret: 'x'.repeat(32), allowedOrigins: ['https://admin.example.com'], ttlSeconds: 3600 })).toThrow(/16/);
    expect(() => new AdminSessionService({ accessToken: 'x'.repeat(16), sessionSecret: 'short', allowedOrigins: ['https://admin.example.com'], ttlSeconds: 3600 })).toThrow(/32/);
    expect(() => new AdminSessionService({ accessToken: 'x'.repeat(16), sessionSecret: 'x'.repeat(32), allowedOrigins: [], ttlSeconds: 3600 })).toThrow(/不能为空/);
    expect(() => new AdminSessionService({ accessToken: 'x'.repeat(16), sessionSecret: 'x'.repeat(32), allowedOrigins: ['https://admin.example.com'], ttlSeconds: 31_536_001 })).toThrow(/31536000/);
  });
});
