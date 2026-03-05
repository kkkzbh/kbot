import { Context, Logger, Schema } from 'koishi';
import { dedupeSearchResults, parseBingWebResults, type SearchResult } from './chatluna-search-hotfix-core.js';

export const name = 'chatluna-search-hotfix';
export const inject = ['chatluna'];

const logger = new Logger(name);
const DEFAULT_TOP_K = 5;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_WIKIPEDIA_BASE_URLS = ['https://zh.wikipedia.org/w/api.php', 'https://en.wikipedia.org/w/api.php'];

export interface Config {
  enabled?: boolean;
  topK?: number;
  timeoutMs?: number;
  wikipediaBaseURL?: string[] | string;
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用 web_search 热修复实现。'),
  topK: Schema.number().min(1).max(10).default(DEFAULT_TOP_K).description('返回结果条数。'),
  timeoutMs: Schema.natural().default(DEFAULT_TIMEOUT_MS).description('单次搜索请求超时（毫秒）。'),
  wikipediaBaseURL: Schema.union([
    Schema.array(Schema.string()).role('table').description('Wikipedia API 基础 URL 列表。'),
    Schema.string().description('Wikipedia API 基础 URL（逗号分隔）。'),
  ]).description('Bing 结果不足时的 Wikipedia 兜底源。'),
});

type RuntimeConfig = {
  topK: number;
  timeoutMs: number;
  wikipediaBaseURLs: string[];
};

type ChatLunaLike = {
  registerTool?: (
    name: string,
    tool: {
      createTool: (params: unknown) => unknown;
      selector: () => boolean;
    },
  ) => void;
};

type ContextWithChatLuna = Context & { chatluna?: ChatLunaLike };

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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
  return {
    topK: Number.isFinite(topK) ? Math.max(1, Math.min(10, Math.floor(topK))) : DEFAULT_TOP_K,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(3000, Math.floor(timeoutMs)) : DEFAULT_TIMEOUT_MS,
    wikipediaBaseURLs: parseWikipediaBaseURLs(config.wikipediaBaseURL),
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

function appendSearchParams(baseURL: string, params: Record<string, string>): string {
  const url = new URL(baseURL);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
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
    const query = normalizeText(typeof input === 'string' ? input : String(input ?? ''));
    if (!query) return '[]';

    const merged: SearchResult[] = [];

    try {
      const bingResults = await searchByBingWeb(query, this.runtime.topK, this.runtime.timeoutMs);
      merged.push(...bingResults);
    } catch (error) {
      logger.warn('bing web search failed: %s', (error as Error).message);
    }

    if (merged.length < this.runtime.topK) {
      for (const baseURL of this.runtime.wikipediaBaseURLs) {
        try {
          const wikiResults = await searchByMediaWiki(
            query,
            baseURL,
            this.runtime.topK - merged.length,
            this.runtime.timeoutMs,
          );
          merged.push(...wikiResults);
        } catch (error) {
          logger.debug('wikipedia fallback failed (%s): %s', baseURL, (error as Error).message);
        }
        if (merged.length >= this.runtime.topK) break;
      }
    }

    const output = dedupeSearchResults(merged, this.runtime.topK);
    if (!output.length) {
      return JSON.stringify([{ title: 'No results found', description: 'No results found', url: '' }]);
    }
    return JSON.stringify(output);
  }
}

export function apply(ctx: Context, config: Config): void {
  const runtime = toRuntimeConfig(config);
  ctx.on('ready', () => {
    if (config.enabled === false) return;
    const chatluna = (ctx as ContextWithChatLuna).chatluna;
    if (!chatluna?.registerTool) {
      logger.warn('chatluna service is not available, skip web_search hotfix.');
      return;
    }

    chatluna.registerTool('web_search', {
      createTool: () => new StableWebSearchTool(runtime),
      selector: () => true,
    });

    logger.info('registered stable web_search hotfix (topK=%d).', runtime.topK);
  });
}
