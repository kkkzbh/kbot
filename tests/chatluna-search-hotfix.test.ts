import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply } from '../src/plugins/chatluna-search-hotfix.js';
import {
  parseBingWebResults,
  parseDuckDuckGoLiteResults,
  parseQueryPlan,
  parseWikipediaOpenSearchResults,
  rankSearchResultsByRelevance,
  sanitizeSearchQueryInput,
  type QueryPlan,
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

function createDuckDuckGoLiteHtml(results: Array<{ title: string; url: string; description: string }>): string {
  return `
    <table>
      ${results
        .map(
          (item) => `
            <tr>
              <td><a href="/l/?uddg=${encodeURIComponent(item.url)}" class="result-link">${item.title}</a></td>
            </tr>
            <tr>
              <td class="result-snippet">${item.description}</td>
            </tr>
          `,
        )
        .join('\n')}
    </table>
  `;
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
      </ul>
    `;
    expect(parseBingWebResults(html, 5)).toEqual([
      {
        title: '彩叶是谁',
        url: 'https://example.com/a',
        description: '彩叶是某作品中的角色',
        source: 'bing-web',
      },
    ]);
  });

  it('parses duckduckgo lite results and decodes redirect urls', () => {
    const html = createDuckDuckGoLiteHtml([
      {
        title: '超时空辉夜姬! - 萌娘百科',
        url: 'https://mzh.moegirl.org.cn/%E8%B6%85%E6%97%B6%E7%A9%BA%E8%BE%89%E5%A4%9C%E5%A7%AC%EF%BC%81',
        description: '原创网络动画电影。',
      },
    ]);
    expect(parseDuckDuckGoLiteResults(html, 5)).toEqual([
      {
        title: '超时空辉夜姬! - 萌娘百科',
        url: 'https://mzh.moegirl.org.cn/%E8%B6%85%E6%97%B6%E7%A9%BA%E8%BE%89%E5%A4%9C%E5%A7%AC%EF%BC%81',
        description: '原创网络动画电影。',
        source: 'duckduckgo-lite',
      },
    ]);
  });

  it('parses wikipedia opensearch payload', () => {
    const payload = JSON.stringify([
      '辉夜',
      ['辉夜姬'],
      ['日本传说人物'],
      ['https://zh.wikipedia.org/wiki/%E8%BE%89%E5%A4%9C%E5%A7%AC'],
    ]);

    expect(parseWikipediaOpenSearchResults(payload, 5, 'https://zh.wikipedia.org/w/api.php')).toEqual([
      {
        title: '辉夜姬',
        url: 'https://zh.wikipedia.org/wiki/%E8%BE%89%E5%A4%9C%E5%A7%AC',
        description: '日本传说人物',
        source: 'wikipedia',
      },
    ]);
  });

  it('sanitizes conversational search prompt before query planning', () => {
    expect(sanitizeSearchQueryInput('你再搜一下 彩叶与辉叶是谁')).toBe('彩叶与辉叶是谁');
    expect(sanitizeSearchQueryInput('@小祥 查一下 高康嘉 是谁 呢')).toBe('高康嘉 是谁');
  });

  it('parses query plan json and falls back when planner output is missing', () => {
    const payload = JSON.stringify({
      primary_entities: ['彩叶', '辉夜'],
      related_works: ['超时空辉夜姬'],
      aliases_zh: ['酒寄彩叶'],
      aliases_en: ['Kaguya'],
      queries: ['彩叶和辉夜是谁', '彩叶 辉夜 超时空辉夜姬'],
    });
    expect(parseQueryPlan(payload, '彩叶和辉夜是谁')).toMatchObject({
      primaryEntities: ['彩叶', '辉夜'],
      relatedWorks: ['超时空辉夜姬'],
      aliasesZh: ['酒寄彩叶'],
      aliasesEn: ['Kaguya'],
    });
    expect(parseQueryPlan(payload, '彩叶和辉夜是谁').queries).toEqual(
      expect.arrayContaining(['彩叶和辉夜是谁', '彩叶 辉夜 超时空辉夜姬']),
    );

    expect(parseQueryPlan('', '彩叶和辉夜是谁').queries).toEqual(
      expect.arrayContaining(['彩叶 辉夜 角色', '彩叶 辉夜 同一作品']),
    );
  });

  it('ranks results by entity and related work relevance', () => {
    const plan: QueryPlan = {
      primaryEntities: ['彩叶', '辉夜'],
      relatedWorks: ['超时空辉夜姬'],
      aliasesZh: ['酒寄彩叶'],
      aliasesEn: [],
      queries: ['彩叶和辉夜是谁'],
    };
    const results = [
      {
        title: '超时空辉夜姬! - 萌娘百科',
        url: 'https://mzh.moegirl.org.cn/超时空辉夜姬！',
        description: '酒寄彩叶与辉夜是该作品主要角色',
        source: 'duckduckgo-lite' as const,
      },
      {
        title: 'Qual a forma correta de aguar as plantas?',
        url: 'https://example.com/plants',
        description: '浇水技巧',
        source: 'bing-web' as const,
      },
    ];

    expect(rankSearchResultsByRelevance(results, plan, 5, '彩叶和辉夜是谁')).toEqual([results[0]]);
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

  it('prefers DeepSeek short model name on official base url and uses sanitized query for planner', async () => {
    const tool = createTool({
      queryRewriteApiKey: 'test-key',
      queryRewriteBaseURL: 'https://api.deepseek.com/v1',
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
        requestedModels.push(body.model ?? '');
        const systemPrompt = body.messages?.[0]?.content ?? '';
        const userPrompt = body.messages?.[1]?.content ?? '';
        if (systemPrompt.includes('搜索查询规划器')) {
          expect(userPrompt).toContain('用户搜索请求：彩叶和辉夜是谁');
          return createJsonResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    primary_entities: ['彩叶', '辉夜'],
                    related_works: ['超时空辉夜姬'],
                    aliases_zh: ['酒寄彩叶'],
                    aliases_en: ['Kaguya'],
                    queries: ['彩叶和辉夜是谁', '彩叶 辉夜 超时空辉夜姬'],
                  }),
                },
              },
            ],
          });
        }
        if (systemPrompt.includes('搜索结果总结器')) {
          return createJsonResponse({
            choices: [{ message: { content: '结论：彩叶与辉夜来自《超时空辉夜姬》\n来源：https://example.com/moe' } }],
          });
        }
      }
      if (url.includes('lite.duckduckgo.com/lite/')) {
        return new Response(
          createDuckDuckGoLiteHtml([
            {
              title: '超时空辉夜姬! - 萌娘百科',
              url: 'https://example.com/moe',
              description: '彩叶与辉夜是该作品主要角色',
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('cn.bing.com/search')) {
        return new Response(
          createBingHtml([
            {
              title: '无关结果',
              url: 'https://example.com/irrelevant',
              description: '浇花技巧',
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('wikipedia.org/w/api.php')) {
        return createJsonResponse(['彩叶', [], [], []]);
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const output = await tool.invoke('你搜一下 彩叶和辉夜是谁');
    expect(output).toContain('超时空辉夜姬');
    expect(requestedModels[0]).toBe('deepseek-chat');
  });

  it('returns summary from multi-source results even when bing drifts badly', async () => {
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
        if (systemPrompt.includes('搜索查询规划器')) {
          return createJsonResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    primary_entities: ['彩叶', '辉夜'],
                    related_works: ['超时空辉夜姬'],
                    aliases_zh: ['酒寄彩叶'],
                    aliases_en: [],
                    queries: ['彩叶和辉夜是谁', '彩叶 辉夜 超时空辉夜姬'],
                  }),
                },
              },
            ],
          });
        }
        if (systemPrompt.includes('搜索结果总结器')) {
          return createJsonResponse({
            choices: [{ message: { content: '结论：彩叶与辉夜是《超时空辉夜姬！》相关角色\n来源：https://example.com/moe' } }],
          });
        }
      }
      if (url.includes('lite.duckduckgo.com/lite/')) {
        return new Response(
          createDuckDuckGoLiteHtml([
            {
              title: '超时空辉夜姬! - 萌娘百科',
              url: 'https://example.com/moe',
              description: '酒寄彩叶与辉夜是该作品主要角色',
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('cn.bing.com/search')) {
        return new Response(
          createBingHtml([
            {
              title: 'Qual a forma correta de aguar as plantas?',
              url: 'https://example.com/plants',
              description: 'regar as plantas',
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('wikipedia.org/w/api.php')) {
        return createJsonResponse([
          '彩叶',
          ['辉夜姬'],
          ['日本传说人物'],
          ['https://zh.wikipedia.org/wiki/%E8%BE%89%E5%A4%9C%E5%A7%AC'],
        ]);
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const output = await tool.invoke('彩叶和辉夜是谁');
    expect(output).toContain('超时空辉夜姬');
  });

  it('avoids single-entity wikipedia fallback for ambiguous multi-entity queries', async () => {
    const tool = createTool({
      queryRewriteApiKey: 'test-key',
      queryRewriteBaseURL: 'https://api.example.com/v1',
      queryRewriteModel: 'deepseek/test-model',
    });
    const requestedWikipediaUrls: string[] = [];
    const requestedSearchTerms: string[] = [];

    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/chat/completions')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          messages?: Array<{ content?: string }>;
        };
        const systemPrompt = body.messages?.[0]?.content ?? '';
        if (systemPrompt.includes('搜索查询规划器')) {
          return createJsonResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    primary_entities: ['彩叶', '辉夜'],
                    related_works: [],
                    aliases_zh: [],
                    aliases_en: [],
                    queries: ['彩叶和辉夜是谁', '彩叶', '辉夜'],
                  }),
                },
              },
            ],
          });
        }
        if (systemPrompt.includes('搜索结果总结器')) {
          return createJsonResponse({
            choices: [{ message: { content: '结论：彩叶与辉夜指向《超时空辉夜姬！》\n来源：https://example.com/moe' } }],
          });
        }
      }
      if (url.includes('lite.duckduckgo.com/lite/')) {
        requestedSearchTerms.push(new URL(url).searchParams.get('q') ?? '');
        return new Response(
          createDuckDuckGoLiteHtml([
            {
              title: '超时空辉夜姬! - 萌娘百科',
              url: 'https://example.com/moe',
              description: '酒寄彩叶与辉夜是该作品主要角色',
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('cn.bing.com/search')) {
        requestedSearchTerms.push(new URL(url).searchParams.get('q') ?? '');
        return new Response(createBingHtml([]), { status: 200 });
      }
      if (url.includes('wikipedia.org/w/api.php')) {
        requestedWikipediaUrls.push(url);
        return createJsonResponse(['彩叶', ['彩叶万年青'], ['植物'], ['https://zh.wikipedia.org/wiki/%E5%BD%A9%E5%8F%B6%E4%B8%87%E5%B9%B4%E9%9D%92']]);
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const output = await tool.invoke('彩叶和辉夜是谁');
    expect(output).toContain('超时空辉夜姬');
    expect(requestedSearchTerms).toContain('彩叶和辉夜是谁');
    expect(requestedSearchTerms).not.toContain('彩叶');
    expect(requestedSearchTerms).not.toContain('辉夜');
    expect(requestedWikipediaUrls).toHaveLength(0);
  });

  it('prefers multi-entity ddg hit over single-entity wikipedia pages', () => {
    const plan: QueryPlan = {
      primaryEntities: ['彩叶', '辉夜'],
      relatedWorks: [],
      aliasesZh: [],
      aliasesEn: [],
      queries: ['彩叶和辉夜是谁', '彩叶 辉夜 同一作品'],
    };
    const ddgResult = {
      title: '超时空辉夜姬! - 萌娘百科',
      url: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fmzh.moegirl.org.cn%2F%E8%B6%85%E6%97%B6%E7%A9%BA%E8%BE%89%E5%A4%9C%E5%A7%AC%EF%BC%81',
      description: '酒寄彩叶与辉夜是该作品主要角色',
      source: 'duckduckgo-lite' as const,
    };
    const wikiResult = {
      title: '辉夜月',
      url: 'https://zh.wikipedia.org/wiki/%E8%BE%89%E5%A4%9C%E6%9C%88',
      description: '日本虚拟YouTuber',
      source: 'wikipedia' as const,
    };

    expect(rankSearchResultsByRelevance([wikiResult, ddgResult], plan, 5, '彩叶和辉夜是谁')[0]).toEqual(ddgResult);
  });

  it('falls back to json search results when summary model fails but ddg still succeeds', async () => {
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
        if (systemPrompt.includes('搜索查询规划器')) {
          return createJsonResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    primary_entities: ['彩叶', '辉夜'],
                    related_works: ['超时空辉夜姬'],
                    aliases_zh: ['酒寄彩叶'],
                    aliases_en: [],
                    queries: ['彩叶和辉夜是谁'],
                  }),
                },
              },
            ],
          });
        }
        if (systemPrompt.includes('搜索结果总结器')) {
          return createJsonResponse({ error: 'summary failed' }, 500);
        }
      }
      if (url.includes('lite.duckduckgo.com/lite/')) {
        return new Response(
          createDuckDuckGoLiteHtml([
            {
              title: '超时空辉夜姬! - 萌娘百科',
              url: 'https://example.com/moe',
              description: '酒寄彩叶与辉夜是该作品主要角色',
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('cn.bing.com/search')) {
        return new Response(
          createBingHtml([
            {
              title: '无关结果',
              url: 'https://example.com/irrelevant',
              description: '浇花技巧',
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('wikipedia.org/w/api.php')) {
        return createJsonResponse(['彩叶', [], [], []]);
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const output = await tool.invoke('彩叶和辉夜是谁');
    const parsed = JSON.parse(output) as Array<{ title: string; url: string; description: string }>;
    expect(parsed[0].url).toBe('https://example.com/moe');
  });
});
