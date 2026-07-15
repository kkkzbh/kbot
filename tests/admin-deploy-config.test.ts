import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), 'scripts/validate-admin-config.mjs');

function validate(overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      QQBOT_ADMIN_ACCESS_TOKEN: 'admin-access-token',
      QQBOT_ADMIN_SESSION_SECRET: 'admin-session-secret-with-32-characters',
      QQBOT_ADMIN_ORIGIN: 'https://admin.qqbot.example',
      ...overrides,
    },
  });
}

describe('admin deployment configuration', () => {
  it('accepts complete credentials and an exact origin', () => {
    const result = validate();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('credentials and origin verified');
  });

  it('rejects example secrets before deployment', () => {
    const result = validate({
      QQBOT_ADMIN_ACCESS_TOKEN: 'replace-with-at-least-16-characters',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('still contains the example placeholder');
    expect(result.stderr).not.toContain('replace-with-at-least-16-characters');
  });

  it('rejects origins with paths', () => {
    const result = validate({
      QQBOT_ADMIN_ORIGIN: 'https://admin.qqbot.example/admin',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('must contain only scheme, host, and optional port');
  });
});
