import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => ({
  Logger: class {
    static DEBUG = 3;
    static INFO = 2;
    static targets: Array<{ levels?: Record<string, number>; record?: (record: unknown) => void }> = [];
  },
}));

import { Logger } from 'koishi';
import { AdminLogService, redactAdminLogContent } from '../src/plugins/admin-api/logs.js';

const services: AdminLogService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

describe('admin runtime logs', () => {
  it('captures records with cursor pagination and bounded history', () => {
    const service = new AdminLogService(2, {});
    services.push(service);
    const target = Logger.targets.at(-1);
    expect(target?.record).toBeTypeOf('function');
    expect(target?.levels).toEqual({ base: Logger.DEBUG, sqlite: Logger.INFO });

    target?.record?.({ id: 10, timestamp: 1000, level: 2, type: 'info', name: 'alpha', content: 'one', meta: {} });
    target?.record?.({ id: 11, timestamp: 2000, level: 2, type: 'warn', name: 'beta', content: 'two', meta: {} });
    target?.record?.({ id: 12, timestamp: 3000, level: 1, type: 'error', name: 'gamma', content: 'three', meta: {} });

    expect(service.read(0, 100)).toEqual({
      entries: [
        { id: 11, timestamp: 2000, level: 'warn', namespace: 'beta', content: 'two' },
        { id: 12, timestamp: 3000, level: 'error', namespace: 'gamma', content: 'three' },
      ],
      nextCursor: 12,
      truncated: false,
    });
    expect(service.read(10, 1)).toMatchObject({
      entries: [{ id: 11 }],
      nextCursor: 11,
      truncated: false,
    });
    expect(service.read(9, 100).truncated).toBe(true);
  });

  it('redacts configured secrets and credential-shaped log values', () => {
    const secret = 'server-secret-value';
    const content = `secret=${secret} Authorization: Bearer abc.def.ghi api_key=query-key https://a.test/?access_token=url-token`;
    const redacted = redactAdminLogContent(content, [secret]);

    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain('abc.def.ghi');
    expect(redacted).not.toContain('query-key');
    expect(redacted).not.toContain('url-token');
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
