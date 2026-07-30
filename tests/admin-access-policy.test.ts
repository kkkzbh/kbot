import { describe, expect, it } from 'vitest';
import {
  AdminAccessPolicy,
  AdminHttpError,
} from '../src/plugins/shared/internal-access-policy.js';

describe('admin Tailnet access policy', () => {
  it('accepts the configured Tailnet and SSH forwarding origins', () => {
    const policy = new AdminAccessPolicy([
      'https://admin.example.com',
      'http://127.0.0.1:5140',
    ]);

    expect(() => policy.assertHost('public.example.com')).toThrow(AdminHttpError);
    expect(() => policy.assertMutationOrigin('https://evil.example.com')).toThrow(AdminHttpError);
    expect(() => policy.assertAuthenticatedTransport({
      host: 'admin.example.com',
      remoteAddress: '127.0.0.1',
      tailscaleUserLogin: 'operator@example.com',
    })).not.toThrow();
    expect(() => policy.assertMutationOrigin('https://admin.example.com')).not.toThrow();
    expect(() => policy.assertAuthenticatedTransport({
      host: '127.0.0.1:5140',
      remoteAddress: '::ffff:127.0.0.1',
      tailscaleUserLogin: '',
    })).not.toThrow();
    expect(() => policy.assertMutationOrigin('http://127.0.0.1:5140')).not.toThrow();
  });

  it('requires a loopback transport and a Tailnet identity outside the SSH origin', () => {
    const policy = new AdminAccessPolicy([
      'https://admin.example.com',
      'http://127.0.0.1:5140',
    ]);

    expect(() => policy.assertAuthenticatedTransport({
      host: 'admin.example.com',
      remoteAddress: '127.0.0.1',
      tailscaleUserLogin: '',
    })).toThrowError(expect.objectContaining({ status: 401, code: 'unauthorized' }));
    expect(() => policy.assertAuthenticatedTransport({
      host: '127.0.0.1:5140',
      remoteAddress: '192.0.2.40',
      tailscaleUserLogin: '',
    })).toThrowError(expect.objectContaining({ status: 401, code: 'unauthorized' }));
  });

  it('requires explicit origins without paths or credentials', () => {
    expect(() => new AdminAccessPolicy([])).toThrow(/不能为空/);
    expect(() => new AdminAccessPolicy(['https://admin.example.com/path'])).toThrow(/格式不正确/);
    expect(() => new AdminAccessPolicy(['https://user:secret@admin.example.com'])).toThrow(/格式不正确/);
  });
});
