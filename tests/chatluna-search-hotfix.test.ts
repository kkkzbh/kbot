import { describe, expect, it, vi } from 'vitest';
import { apply } from '../src/plugins/chatluna-search-hotfix.js';
import { dedupeSearchResults, parseBingWebResults } from '../src/plugins/chatluna-search-hotfix-core.js';

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
    debug(): void {}
  }

  return {
    Context: class {},
    Logger: MockLogger,
    Schema: {
      object: () => createSchemaNode(),
      boolean: () => createSchemaNode(),
      number: () => createSchemaNode(),
      natural: () => createSchemaNode(),
      union: () => createSchemaNode(),
      array: () => createSchemaNode(),
      string: () => createSchemaNode(),
    },
  };
});

describe('chatluna-search-hotfix', () => {
  it('parses bing html search blocks into structured results', () => {
    const html = `
      <ul id="b_results">
        <li class="b_algo">
          <h2><a href="https://example.com/a">彩叶是谁</a></h2>
          <div class="b_caption"><p>彩叶是某作品中的角色</p></div>
        </li>
        <li class="b_algo">
          <h2><a href="https://example.com/b">辉叶是谁</a></h2>
          <div class="b_caption"><p>辉叶是另一位角色</p></div>
        </li>
      </ul>
    `;
    expect(parseBingWebResults(html, 5)).toEqual([
      {
        title: '彩叶是谁',
        url: 'https://example.com/a',
        description: '彩叶是某作品中的角色',
      },
      {
        title: '辉叶是谁',
        url: 'https://example.com/b',
        description: '辉叶是另一位角色',
      },
    ]);
  });

  it('deduplicates search results by url and keeps order', () => {
    const results = dedupeSearchResults(
      [
        { title: 'A', url: 'https://example.com/a', description: '1' },
        { title: 'B', url: 'https://example.com/a', description: '2' },
        { title: 'C', url: 'https://example.com/c', description: '3' },
      ],
      5,
    );
    expect(results).toEqual([
      { title: 'A', url: 'https://example.com/a', description: '1' },
      { title: 'C', url: 'https://example.com/c', description: '3' },
    ]);
  });

  it('registers web_search tool when chatluna platform is available on ready', () => {
    const readyHandlers: Array<() => void> = [];
    const intervalHandlers: Array<{ callback: () => void; ms: number }> = [];
    const registerTool = vi.fn();
    const ctx = {
      chatluna: {
        platform: { registerTool },
      },
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'ready') readyHandlers.push(handler);
      }),
      setInterval: vi.fn((callback: () => void, ms: number) => {
        intervalHandlers.push({ callback, ms });
        return {} as NodeJS.Timeout;
      }),
    };

    apply(ctx as never, { enabled: true, topK: 5, timeoutMs: 12_000 });

    expect(readyHandlers).toHaveLength(1);
    expect(intervalHandlers).toHaveLength(1);
    expect(intervalHandlers[0].ms).toBe(15_000);

    readyHandlers[0]();

    expect(registerTool).toHaveBeenCalledTimes(1);
    const [toolName, descriptor] = registerTool.mock.calls[0] as [string, { selector: () => boolean }];
    expect(toolName).toBe('web_search');
    expect(descriptor.selector()).toBe(true);
  });

  it('retries registration by interval when platform becomes available later', () => {
    const readyHandlers: Array<() => void> = [];
    const intervalHandlers: Array<() => void> = [];
    const registerTool = vi.fn();
    const ctx: {
      chatluna: { platform?: { registerTool: typeof registerTool } };
      on: (event: string, handler: () => void) => void;
      setInterval: (callback: () => void, ms: number) => NodeJS.Timeout;
    } = {
      chatluna: {},
      on: (event, handler) => {
        if (event === 'ready') readyHandlers.push(handler);
      },
      setInterval: (callback) => {
        intervalHandlers.push(callback);
        return {} as NodeJS.Timeout;
      },
    };

    apply(ctx as never, { enabled: true });

    readyHandlers[0]();
    expect(registerTool).not.toHaveBeenCalled();

    ctx.chatluna.platform = { registerTool };
    intervalHandlers[0]();
    expect(registerTool).toHaveBeenCalledTimes(1);

    intervalHandlers[0]();
    expect(registerTool).toHaveBeenCalledTimes(1);
  });
});
