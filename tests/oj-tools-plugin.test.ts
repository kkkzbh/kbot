import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => {
  type MockSchemaNode = {
    default: () => MockSchemaNode;
    description: () => MockSchemaNode;
    min: () => MockSchemaNode;
    max: () => MockSchemaNode;
    role: () => MockSchemaNode;
  };

  const createSchemaNode = (): MockSchemaNode => ({
    default: () => createSchemaNode(),
    description: () => createSchemaNode(),
    min: () => createSchemaNode(),
    max: () => createSchemaNode(),
    role: () => createSchemaNode(),
  });

  class MockLogger {
    info(): void {}
    warn(): void {}
    error(): void {}
  }

  return {
    Context: class {},
    Logger: MockLogger,
    Schema: {
      object: () => createSchemaNode(),
      natural: () => createSchemaNode(),
    },
  };
});

import {
  apply,
  CF_CONTESTS_TOOL,
  CF_USER_PROFILE_TOOL,
  CF_USER_RATING_TOOL,
  CF_USER_SUBMISSIONS_TOOL,
  inject,
} from '../src/plugins/oj-tools/index.js';
import { TOOL_CATALOG } from '../src/plugins/shared/tool-policy-catalog.js';

describe('oj-tools plugin', () => {
  it('declares the expected injections', () => {
    expect(inject).toEqual({ required: ['chatluna', 'chatluna_storage'] });
  });

  it('registers all codeforces tools', () => {
    const tools = new Map<string, unknown>();
    const disposeHandlers: Array<() => void> = [];
    const ctx = {
      chatluna: {
        platform: {
          registerTool: vi.fn((name: string, tool: unknown) => {
            tools.set(name, tool);
            return () => tools.delete(name);
          }),
        },
      },
      chatluna_storage: {
        createTempFile: vi.fn(),
      },
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'dispose') disposeHandlers.push(handler);
      }),
    };

    apply(ctx as never, {
      cacheTtlMs: 300_000,
      requestIntervalMs: 2_100,
      ratingChartWidth: 1_789,
      ratingChartHeight: 838,
    });

    expect([...tools.keys()].sort()).toEqual([
      CF_CONTESTS_TOOL,
      CF_USER_PROFILE_TOOL,
      CF_USER_RATING_TOOL,
      CF_USER_SUBMISSIONS_TOOL,
    ]);

    disposeHandlers.forEach((handler) => handler());
    expect(tools.size).toBe(0);
  });

  it('fails fast when the ChatLuna tool registry is unavailable', () => {
    const ctx = {
      chatluna: {
        platform: {},
      },
      chatluna_storage: {
        createTempFile: vi.fn(),
      },
      on: vi.fn(),
    };

    expect(() => apply(ctx as never, {
      cacheTtlMs: 300_000,
      requestIntervalMs: 2_100,
      ratingChartWidth: 1_789,
      ratingChartHeight: 838,
    })).toThrow('oj-tools requires chatluna.platform.registerTool.');
  });

  it('exposes all codeforces tools in tool policy catalog', () => {
    const cfEntries = TOOL_CATALOG.filter((entry) => entry.toolName.startsWith('cf_'));
    expect(cfEntries.map((entry) => entry.toolName).sort()).toEqual([
      CF_CONTESTS_TOOL,
      CF_USER_PROFILE_TOOL,
      CF_USER_RATING_TOOL,
      CF_USER_SUBMISSIONS_TOOL,
    ]);
    expect(cfEntries.every((entry) => (
      entry.management === 'locked_off'
      && !entry.defaultEnabledByRoute.agent
      && !entry.defaultEnabledByRoute.automation
    ))).toBe(true);
  });
});
