import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), 'scripts/validate-admin-config.mjs');

function validate(overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      QQBOT_ADMIN_ORIGIN: 'https://admin.qqbot.example',
      ...overrides,
    },
  });
}

describe('admin deployment configuration', () => {
  it('accepts an exact origin', () => {
    const result = validate();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('origin verified');
  });

  it('rejects origins with paths', () => {
    const result = validate({
      QQBOT_ADMIN_ORIGIN: 'https://admin.qqbot.example/admin',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('must contain only scheme, host, and optional port');
  });
});
