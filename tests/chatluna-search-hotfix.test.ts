import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply } from '../src/plugins/chatluna-search-hotfix.js';
import {
  dedupeSearchResults,
  parseBingWebResults,
  parseRewrittenSearchTerms,
  rankSearchResultsByRelevance,
  sanitizeSearchQueryInput,
} from '../src/plugins/chatluna-search-hotfix-core.js';

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

function createJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createBingHtml(results: Array<{ title: string; url: string; description: string }>): string {
  const items = results
    .map(
      (item) => `
        <li class="b_algo">
          <h2><a href="${item.url}">${item.title}</a></h2>
          <div class="b_caption"><p>${item.description}</p></div>
        </li>
      `,
    )
    .join('\n');
  return `<ul id="b_results">${items}</ul>`;
}

function createTool(overrides: Record<string, unknown> = {}): { invoke: (input: unknown) => Promise<string> } {
  const readyHandlers: Array<() => void> = [];
  const registerTool = vi.fn();
  const ctx = {
    chatluna: {
      platform: { registerTool },
    },
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'ready') readyHandlers.push(handler);
    }),
    setInterval: vi.fn(() => ({}) as unknown),
  };

  apply(ctx as never, {
    enabled: true,
    topK: 5,
    timeoutMs: 12_000,
    ...overrides,
  });
  readyHandlers[0]();
  const [, descriptor] = registerTool.mock.calls[0] as [string, { createTool: (params: unknown) => unknown }];
  return descriptor.createTool({}) as { invoke: (input: unknown) => Promise<string> };
}

describe('chatluna-search-hotfix', () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

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

  it('sanitizes conversational search prompt into direct query', () => {
    expect(sanitizeSearchQueryInput('你再搜一下 彩叶与绯叶是谁')).toBe('彩叶与绯叶是谁');
    expect(sanitizeSearchQueryInput('@小祥 查一下 高康嘉 是谁 呢')).toBe('高康嘉 是谁');
  });

  it('parses rewritten zh/en terms from json content', () => {
    const payload =
      '```json\n{"zh_terms":["彩叶 与 绯叶","彩叶和绯夜 人物"],"en_terms":["Sayo and Hiye"]}\n```';
    expect(parseRewrittenSearchTerms(payload)).toEqual({
      zhTerms: ['彩叶 与 绯叶', '彩叶和绯夜 人物'],
      enTerms: ['Sayo and Hiye'],
    });
  });

  it('ranks by relevance and drops unrelated result set', () => {
    const results = [
      { title: '彩叶角色介绍', url: 'https://example.com/a', description: '角色资料' },
      { title: 'Pascal 语法总结', url: 'https://example.com/pascal', description: '编程语言' },
    ];
    expect(rankSearchResultsByRelevance(results, ['彩叶'], 5)).toEqual([
      { title: '彩叶角色介绍', url: 'https://example.com/a', description: '角色资料' },
    ]);
    expect(rankSearchResultsByRelevance(results, ['完全不存在的实体'], 5)).toEqual([]);
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

  it('uses raw query for rewrite and limits bing search terms to 6', async () => {
    const tool = createTool({
      queryRewriteApiKey: 'test-key',
      queryRewriteBaseURL: 'https://api.example.com/v1',
      queryRewriteModel: 'deepseek/test-model',
    });
    const bingQueries: string[] = [];
    const rewriteTerms = {
      zh_terms: ['彩叶', '辉夜', '角色', '人物'],
      en_terms: ['Sayo', 'Kaguya', 'BanG Dream'],
    };

    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/chat/completions')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          messages?: Array<{ content?: string }>;
        };
        const systemPrompt = body.messages?.[0]?.content ?? '';
        const userPrompt = body.messages?.[1]?.content ?? '';
        if (systemPrompt.includes('搜索关键词规划器')) {
          expect(userPrompt).toContain('用户搜索请求：你搜一下 彩叶和辉夜');
          return createJsonResponse({
            choices: [{ message: { content: JSON.stringify(rewriteTerms) } }],
          });
        }
        if (systemPrompt.includes('搜索结果总结器')) {
          return createJsonResponse({
            choices: [{ message: { content: '总结：这两个词更像角色名\n来源：https://example.com/source' } }],
          });
        }
      }
      if (url.includes('cn.bing.com/search')) {
        const query = new URL(url).searchParams.get('q') ?? '';
        bingQueries.push(query);
        return new Response(
          createBingHtml([
            {
              title: `${query} 词条`,
              url: `https://example.com/${encodeURIComponent(query)}`,
              description: `${query} 相关介绍`,
            },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const output = await tool.invoke('你搜一下 彩叶和辉夜');
    expect(output).toContain('总结：');
    expect(bingQueries).toEqual(['彩叶', '辉夜', '角色', '人物', 'Sayo', 'Kaguya']);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('wikipedia.org'))).toBe(false);
  });

  it('runs bing fetches in parallel for generated terms', async () => {
    const tool = createTool({
      queryRewriteApiKey: 'test-key',
      queryRewriteBaseURL: 'https://api.example.com/v1',
      queryRewriteModel: 'deepseek/test-model',
    });
    const bingQueries: string[] = [];
    const bingResolvers = new Map<string, (value: Response) => void>();

    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/chat/completions')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          messages?: Array<{ content?: string }>;
        };
        const systemPrompt = body.messages?.[0]?.content ?? '';
        if (systemPrompt.includes('搜索关键词规划器')) {
          return createJsonResponse({
            choices: [{ message: { content: '{"zh_terms":["彩叶","辉夜"],"en_terms":[]}' } }],
          });
        }
        if (systemPrompt.includes('搜索结果总结器')) {
          return createJsonResponse({
            choices: [{ message: { content: '并发总结\n来源：https://example.com/a' } }],
          });
        }
      }
      if (url.includes('cn.bing.com/search')) {
        const query = new URL(url).searchParams.get('q') ?? '';
        bingQueries.push(query);
        return await new Promise<Response>((resolve) => {
          bingResolvers.set(
            query,
            () =>
              resolve(
                new Response(
                  createBingHtml([
                    {
                      title: `${query} 介绍`,
                      url: `https://example.com/${encodeURIComponent(query)}`,
                      description: `${query} 描述`,
                    },
                  ]),
                  { status: 200 },
                ),
              ),
          );
        });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const invokePromise = tool.invoke('彩叶和辉夜');
    for (let i = 0; i < 20 && bingQueries.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(bingQueries).toHaveLength(2);
    expect(bingResolvers.size).toBe(2);

    bingResolvers.get('彩叶')?.(new Response());
    bingResolvers.get('辉夜')?.(new Response());

    const output = await invokePromise;
    expect(output).toContain('并发总结');
  });

  it('falls back to json search results when summary model fails', async () => {
    const tool = createTool({
      queryRewriteApiKey: 'test-key',
      queryRewriteBaseURL: 'https://api.example.com/v1',
      queryRewriteModel: 'deepseek/test-model',
    });

    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/chat/completions')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          messages?: Array<{ content?: string }>;
        };
        const systemPrompt = body.messages?.[0]?.content ?? '';
        if (systemPrompt.includes('搜索关键词规划器')) {
          return createJsonResponse({
            choices: [{ message: { content: '{"zh_terms":["彩叶"],"en_terms":[]}' } }],
          });
        }
        if (systemPrompt.includes('搜索结果总结器')) {
          return createJsonResponse({ error: 'summary failed' }, 500);
        }
      }
      if (url.includes('cn.bing.com/search')) {
        return new Response(
          createBingHtml([
            {
              title: '彩叶 角色介绍',
              url: 'https://example.com/sayo',
              description: '彩叶是某作品角色',
            },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const output = await tool.invoke('彩叶');
    const parsed = JSON.parse(output) as Array<{ title: string; url: string; description: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].url).toBe('https://example.com/sayo');
  });

  it('falls back to provider-stripped model name when openai endpoint rejects prefixed model', async () => {
    const tool = createTool({
      queryRewriteApiKey: 'test-key',
      queryRewriteBaseURL: 'https://api.example.com/v1',
      queryRewriteModel: 'deepseek/deepseek-chat',
    });
    const requestedModels: string[] = [];

    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/chat/completions')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          model?: string;
          messages?: Array<{ content?: string }>;
        };
        const model = body.model ?? '';
        requestedModels.push(model);
        if (model === 'deepseek/deepseek-chat') {
          return createJsonResponse({ error: 'Model Not Exist' }, 400);
        }
        const systemPrompt = body.messages?.[0]?.content ?? '';
        if (systemPrompt.includes('搜索关键词规划器')) {
          return createJsonResponse({
            choices: [{ message: { content: '{"zh_terms":["彩叶"],"en_terms":[]}' } }],
          });
        }
        if (systemPrompt.includes('搜索结果总结器')) {
          return createJsonResponse({
            choices: [{ message: { content: '结论：彩叶是角色名\n来源：https://example.com/sayo' } }],
          });
        }
      }
      if (url.includes('cn.bing.com/search')) {
        return new Response(
          createBingHtml([
            {
              title: '彩叶 角色介绍',
              url: 'https://example.com/sayo',
              description: '彩叶是某作品角色',
            },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const output = await tool.invoke('彩叶');
    expect(output).toContain('结论：彩叶是角色名');
    expect(requestedModels).toContain('deepseek/deepseek-chat');
    expect(requestedModels).toContain('deepseek-chat');
  });
});
