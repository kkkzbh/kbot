import { describe, expect, it } from 'vitest';
import { AdminAccessPolicy, AdminHttpError } from '../src/plugins/admin-api/access-policy.js';

describe('admin Tailnet access policy', () => {
  it('accepts the configured Tailnet and SSH forwarding origins', () => {
    const policy = new AdminAccessPolicy([
      'https://admin.example.com',
      'http://127.0.0.1:5140',
    ]);

    expect(() => policy.assertHost('public.example.com')).toThrow(AdminHttpError);
    expect(() => policy.assertMutationOrigin('https://evil.example.com')).toThrow(AdminHttpError);
    expect(() => policy.assertHost('admin.example.com')).not.toThrow();
    expect(() => policy.assertMutationOrigin('https://admin.example.com')).not.toThrow();
    expect(() => policy.assertHost('127.0.0.1:5140')).not.toThrow();
    expect(() => policy.assertMutationOrigin('http://127.0.0.1:5140')).not.toThrow();
  });

  it('requires explicit origins without paths or credentials', () => {
    expect(() => new AdminAccessPolicy([])).toThrow(/不能为空/);
    expect(() => new AdminAccessPolicy(['https://admin.example.com/path'])).toThrow(/格式不正确/);
    expect(() => new AdminAccessPolicy(['https://user:secret@admin.example.com'])).toThrow(/格式不正确/);
  });
});
