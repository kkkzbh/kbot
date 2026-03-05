import { Context, Logger, Schema } from 'koishi';
import {
  extractRelevanceKeywords,
  parseBingWebResults,
  parseRewrittenSearchTerms,
  rankSearchResultsByRelevance,
  sanitizeSearchQueryInput,
  type SearchResult,
} from './chatluna-search-hotfix-core.js';

export const name = 'chatluna-search-hotfix';
export const inject = ['chatluna'];

const logger = new Logger(name);
const DEFAULT_TOP_K = 5;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_WIKIPEDIA_BASE_URLS = ['https://zh.wikipedia.org/w/api.php', 'https://en.wikipedia.org/w/api.php'];
const DEFAULT_QUERY_REWRITE_MODEL = process.env.OPENAI_MODEL || 'deepseek/deepseek-chat';
const DEFAULT_QUERY_REWRITE_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1';
const DEFAULT_QUERY_REWRITE_MAX_TERMS = 3;
const QUERY_REWRITE_SYSTEM_PROMPT = [
  '你是搜索词规划器，只输出 JSON。',
  '你要把用户输入改写为“可直接用于搜索引擎”的词条，按中文和英文分组。',
  '输出格式必须是：{"zh_terms":["..."],"en_terms":["..."]}',
  '要求：',
  '1) 删除口语前缀（例如：你搜一下、帮我查一下、麻烦你搜）。',
  '2) 必须保留关键实体（人名、作品名、组织名）的原始写法。',
  '3) zh_terms 每项 2-16 个中文字符；en_terms 每项 1-6 个英文词。',
  '4) 每组最多 3 项，按相关性从高到低。',
  '5) 禁止解释、禁止 markdown、禁止输出除 JSON 之外的内容。',
].join('\n');

export interface Config {
  enabled?: boolean;
  topK?: number;
  timeoutMs?: number;
  wikipediaBaseURL?: string[] | string;
  queryRewriteEnabled?: boolean;
  queryRewriteModel?: string;
  queryRewriteBaseURL?: string;
  queryRewriteApiKey?: string;
  queryRewriteMaxTerms?: number;
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用 web_search 热修复实现。'),
  topK: Schema.number().min(1).max(10).default(DEFAULT_TOP_K).description('返回结果条数。'),
  timeoutMs: Schema.natural().default(DEFAULT_TIMEOUT_MS).description('单次搜索请求超时（毫秒）。'),
  wikipediaBaseURL: Schema.union([
    Schema.array(Schema.string()).role('table').description('Wikipedia API 基础 URL 列表。'),
    Schema.string().description('Wikipedia API 基础 URL（逗号分隔）。'),
  ]).description('Bing 结果不足时的 Wikipedia 兜底源。'),
  queryRewriteEnabled: Schema.boolean().default(true).description('是否启用 DeepSeek 查询改写（输出中英文搜索词条）。'),
  queryRewriteModel: Schema.string().default(DEFAULT_QUERY_REWRITE_MODEL).description('查询改写使用的模型。'),
  queryRewriteBaseURL: Schema.string()
    .default(DEFAULT_QUERY_REWRITE_BASE_URL)
    .description('查询改写 API Base URL（OpenAI 兼容）。'),
  queryRewriteApiKey: Schema.string().default('').description('查询改写 API Key（为空则跳过改写）。'),
  queryRewriteMaxTerms: Schema.number().min(1).max(6).default(DEFAULT_QUERY_REWRITE_MAX_TERMS).description('查询改写最多保留词条数。'),
});

type RuntimeConfig = {
  topK: number;
  timeoutMs: number;
  wikipediaBaseURLs: string[];
  queryRewriteEnabled: boolean;
  queryRewriteModel: string;
  queryRewriteBaseURL: string;
  queryRewriteApiKey: string;
  queryRewriteMaxTerms: number;
};

type HotfixToolDescriptor = {
  createTool: (params: unknown) => unknown;
  selector: () => boolean;
};

type PlatformLike = {
  registerTool?: (name: string, tool: HotfixToolDescriptor) => unknown;
};

type ChatLunaLike = {
  platform?: PlatformLike;
};

type ContextWithChatLuna = Context & { chatluna?: ChatLunaLike };

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeBaseURL(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function takeUnique(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of items) {
    const normalized = normalizeText(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
}

function parseWikipediaBaseURLs(raw?: string[] | string): string[] {
  if (Array.isArray(raw)) {
    const values = raw.map((item) => item.trim()).filter(Boolean);
    return values.length ? values : [...DEFAULT_WIKIPEDIA_BASE_URLS];
  }

  const fromText = (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return fromText.length ? fromText : [...DEFAULT_WIKIPEDIA_BASE_URLS];
}

function toRuntimeConfig(config: Config): RuntimeConfig {
  const topK = Number(config.topK ?? DEFAULT_TOP_K);
  const timeoutMs = Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const queryRewriteMaxTerms = Number(config.queryRewriteMaxTerms ?? DEFAULT_QUERY_REWRITE_MAX_TERMS);
  const queryRewriteModel = normalizeText(config.queryRewriteModel ?? DEFAULT_QUERY_REWRITE_MODEL);
  const queryRewriteBaseURL = normalizeBaseURL(config.queryRewriteBaseURL ?? DEFAULT_QUERY_REWRITE_BASE_URL);
  const queryRewriteApiKey = normalizeText(config.queryRewriteApiKey ?? process.env.OPENAI_API_KEY ?? '');

  return {
    topK: Number.isFinite(topK) ? clampInteger(topK, 1, 10) : DEFAULT_TOP_K,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(3000, Math.floor(timeoutMs)) : DEFAULT_TIMEOUT_MS,
    wikipediaBaseURLs: parseWikipediaBaseURLs(config.wikipediaBaseURL),
    queryRewriteEnabled: config.queryRewriteEnabled !== false,
    queryRewriteModel,
    queryRewriteBaseURL,
    queryRewriteApiKey,
    queryRewriteMaxTerms: Number.isFinite(queryRewriteMaxTerms)
      ? clampInteger(queryRewriteMaxTerms, 1, 6)
      : DEFAULT_QUERY_REWRITE_MAX_TERMS,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function searchByBingWeb(query: string, limit: number, timeoutMs: number): Promise<SearchResult[]> {
  const url = `https://cn.bing.com/search?form=QBRE&q=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      },
    },
    timeoutMs,
  );
  if (!response.ok) {
    throw new Error(`bing-web status=${response.status}`);
  }
  const html = await response.text();
  return parseBingWebResults(html, limit);
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

type QueryRewriteOutput = {
  zhTerms: string[];
  enTerms: string[];
};

function extractMessageText(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => (typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n');
}

async function rewriteSearchTerms(query: string, runtime: RuntimeConfig): Promise<QueryRewriteOutput | null> {
  if (!runtime.queryRewriteEnabled) return null;
  if (!runtime.queryRewriteApiKey || !runtime.queryRewriteBaseURL || !runtime.queryRewriteModel) return null;

  const response = await fetchWithTimeout(
    `${runtime.queryRewriteBaseURL}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${runtime.queryRewriteApiKey}`,
      },
      body: JSON.stringify({
        model: runtime.queryRewriteModel,
        temperature: 0,
        messages: [
          { role: 'system', content: QUERY_REWRITE_SYSTEM_PROMPT },
          { role: 'user', content: `用户搜索请求：${query}` },
        ],
      }),
    },
    runtime.timeoutMs,
  );

  if (!response.ok) {
    throw new Error(`query rewrite status=${response.status}`);
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  const messageText = extractMessageText(payload.choices?.[0]?.message?.content);
  if (!messageText) return null;

  const rewritten = parseRewrittenSearchTerms(messageText);
  const zhTerms = takeUnique(rewritten.zhTerms, runtime.queryRewriteMaxTerms);
  const enTerms = takeUnique(rewritten.enTerms, runtime.queryRewriteMaxTerms);
  if (!zhTerms.length && !enTerms.length) return null;

  return { zhTerms, enTerms };
}

function appendSearchParams(baseURL: string, params: Record<string, string>): string {
  const url = new URL(baseURL);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
}

function shouldRequireStrictMatch(query: string): boolean {
  return /(?:是谁|是什么人|人物|角色|资料|百科|是哪位)/.test(query);
}

async function searchByMediaWiki(
  query: string,
  baseURL: string,
  limit: number,
  timeoutMs: number,
): Promise<SearchResult[]> {
  const searchUrl = appendSearchParams(baseURL, {
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: String(limit),
    format: 'json',
  });
  const response = await fetchWithTimeout(searchUrl, {}, timeoutMs);
  if (!response.ok) throw new Error(`wikipedia status=${response.status}`);
  const payload = (await response.json()) as {
    query?: { search?: Array<{ title?: string }> };
  };
  const titles = (payload.query?.search ?? [])
    .map((item) => (item.title ?? '').trim())
    .filter(Boolean)
    .slice(0, limit);
  if (!titles.length) return [];

  const detailUrl = appendSearchParams(baseURL, {
    action: 'query',
    prop: 'extracts|info',
    inprop: 'url',
    explaintext: '1',
    redirects: '1',
    format: 'json',
    titles: titles.join('|'),
  });
  const detailResponse = await fetchWithTimeout(detailUrl, {}, timeoutMs);
  if (!detailResponse.ok) throw new Error(`wikipedia detail status=${detailResponse.status}`);
  const detailPayload = (await detailResponse.json()) as {
    query?: {
      pages?: Record<string, { title?: string; extract?: string; fullurl?: string }>;
    };
  };

  return Object.values(detailPayload.query?.pages ?? {})
    .map((page) => ({
      title: (page.title ?? '').trim(),
      description: normalizeText((page.extract ?? '').slice(0, 420)),
      url: (page.fullurl ?? '').trim(),
    }))
    .filter((item) => item.title && item.url);
}

class StableWebSearchTool {
  name = 'web_search';
  description =
    'A reliable web search tool that returns JSON search results (title/url/description) for current knowledge questions.';

  constructor(private runtime: RuntimeConfig) {}

  async invoke(input: unknown): Promise<string> {
    const rawQuery = normalizeText(typeof input === 'string' ? input : String(input ?? ''));
    if (!rawQuery) return '[]';

    const normalizedQuery = sanitizeSearchQueryInput(rawQuery) || rawQuery;
    let rewrittenTerms: QueryRewriteOutput | null = null;
    try {
      rewrittenTerms = await rewriteSearchTerms(normalizedQuery, this.runtime);
    } catch (error) {
      logger.warn('query rewrite failed: %s', (error as Error).message);
    }

    const searchTerms = takeUnique(
      [
        ...(rewrittenTerms?.zhTerms ?? []),
        ...(rewrittenTerms?.enTerms ?? []),
        normalizedQuery,
      ],
      this.runtime.queryRewriteMaxTerms,
    );
    const relevanceKeywords = extractRelevanceKeywords([rawQuery, normalizedQuery, ...searchTerms]);

    const merged: SearchResult[] = [];

    for (const term of searchTerms) {
      try {
        const bingResults = await searchByBingWeb(term, this.runtime.topK * 2, this.runtime.timeoutMs);
        merged.push(...bingResults);
      } catch (error) {
        logger.warn('bing web search failed (term=%s): %s', term, (error as Error).message);
      }
      if (merged.length >= this.runtime.topK * 4) break;
    }

    let ranked = rankSearchResultsByRelevance(merged, relevanceKeywords, this.runtime.topK);

    if (ranked.length < this.runtime.topK) {
      const wikiTerms = searchTerms.filter((term) => /[\u3400-\u9fff]/.test(term)).slice(0, 2);
      if (!wikiTerms.length) wikiTerms.push(normalizedQuery);
      for (const baseURL of this.runtime.wikipediaBaseURLs) {
        for (const term of wikiTerms) {
          if (ranked.length >= this.runtime.topK) break;
          try {
            const wikiResults = await searchByMediaWiki(
              term,
              baseURL,
              this.runtime.topK,
              this.runtime.timeoutMs,
            );
            merged.push(...wikiResults);
          } catch (error) {
            logger.debug('wikipedia fallback failed (%s, term=%s): %s', baseURL, term, (error as Error).message);
          }
          ranked = rankSearchResultsByRelevance(merged, relevanceKeywords, this.runtime.topK);
        }
        if (ranked.length >= this.runtime.topK) break;
      }
    }

    let output = rankSearchResultsByRelevance(merged, relevanceKeywords, this.runtime.topK);
    if (!output.length && merged.length && !shouldRequireStrictMatch(normalizedQuery)) {
      output = rankSearchResultsByRelevance(merged, [], this.runtime.topK);
    }
    if (!output.length) {
      return JSON.stringify([{ title: 'No results found', description: 'No results found', url: '' }]);
    }
    return JSON.stringify(output);
  }
}

function registerWebSearchHotfix(platform: PlatformLike | undefined, runtime: RuntimeConfig): boolean {
  if (!platform?.registerTool) return false;
  platform.registerTool('web_search', {
    createTool: () => new StableWebSearchTool(runtime),
    selector: () => true,
  });
  return true;
}

export function apply(ctx: Context, config: Config): void {
  const runtime = toRuntimeConfig(config);
  let registered = false;
  let warnedUnavailable = false;
  const ensureHotfixRegistered = (trigger: string) => {
    if (config.enabled === false || registered) return;
    const chatluna = (ctx as ContextWithChatLuna).chatluna;
    if (!registerWebSearchHotfix(chatluna?.platform, runtime)) {
      if (!warnedUnavailable || trigger === 'ready') {
        logger.warn('chatluna platform is not available yet, retry web_search hotfix later.');
        warnedUnavailable = true;
      }
      return;
    }
    registered = true;
    logger.info('registered stable web_search hotfix (topK=%d).', runtime.topK);
  };

  ctx.on('ready', () => {
    ensureHotfixRegistered('ready');
  });
  ctx.setInterval(() => ensureHotfixRegistered('interval'), 15_000);
}
