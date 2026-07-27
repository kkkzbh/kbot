import { describe, expect, it } from 'vitest';
import { AdminAccessPolicy, AdminHttpError } from '../src/plugins/admin-api/access-policy.js';

describe('admin Tailnet access policy', () => {
  it('accepts only the configured Host and mutation Origin', () => {
    const policy = new AdminAccessPolicy(['https://admin.example.com']);

    expect(() => policy.assertHost('public.example.com')).toThrow(AdminHttpError);
    expect(() => policy.assertMutationOrigin('https://evil.example.com')).toThrow(AdminHttpError);
    expect(() => policy.assertHost('admin.example.com')).not.toThrow();
    expect(() => policy.assertMutationOrigin('https://admin.example.com')).not.toThrow();
  });

  it('requires explicit origins without paths or credentials', () => {
    expect(() => new AdminAccessPolicy([])).toThrow(/不能为空/);
    expect(() => new AdminAccessPolicy(['https://admin.example.com/path'])).toThrow(/格式不正确/);
    expect(() => new AdminAccessPolicy(['https://user:secret@admin.example.com'])).toThrow(/格式不正确/);
  });
});
