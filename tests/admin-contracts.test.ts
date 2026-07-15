import { describe, expect, it } from 'vitest';
import {
  adminErrorSchema,
  loginRequestSchema,
  modelTabsPatchRequestSchema,
  pageQuerySchema,
  settingsPatchRequestSchema,
} from '../src/admin/contracts/index.js';

describe('admin shared contracts', () => {
  it('validates login and structured errors', () => {
    expect(loginRequestSchema.parse({ accessToken: 'secret' })).toEqual({ accessToken: 'secret' });
    expect(adminErrorSchema.parse({ error: { code: 'unauthenticated', message: 'expired', requestId: 'request-1' } })).toEqual({
      error: { code: 'unauthenticated', message: 'expired', requestId: 'request-1' },
    });
  });

  it('models secret retention and explicit clear as separate operations', () => {
    expect(settingsPatchRequestSchema.parse({ changes: [{ key: 'API_KEY' }] })).toEqual({ changes: [{ key: 'API_KEY' }] });
    expect(settingsPatchRequestSchema.parse({ changes: [{ key: 'API_KEY', clear: true }] })).toEqual({ changes: [{ key: 'API_KEY', clear: true }] });
    expect(() => settingsPatchRequestSchema.parse({ changes: [{ key: 'API_KEY', value: 'next', clear: true }] })).toThrow();
  });

  it('normalizes bounded pagination query values', () => {
    expect(pageQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(pageQuerySchema.parse({ page: '2', pageSize: '50' })).toEqual({ page: 2, pageSize: 50 });
    expect(() => pageQuerySchema.parse({ pageSize: 101 })).toThrow();
  });

  it('requires explicit model dirty tabs and explicit key clear', () => {
    expect(modelTabsPatchRequestSchema.parse({
      activeTab: 'openai',
      dirtyTabIds: ['openai'],
      tabs: [{ id: 'openai', baseUrl: 'https://example.com/v1', defaultModel: 'gpt-test', clearApiKey: true }],
    }).tabs[0].clearApiKey).toBe(true);
    expect(() => modelTabsPatchRequestSchema.parse({
      activeTab: 'openai', dirtyTabIds: ['openai'],
      tabs: [{ id: 'openai', defaultModel: 'gpt-test', apiKey: 'next', clearApiKey: true }],
    })).toThrow();
  });
});
