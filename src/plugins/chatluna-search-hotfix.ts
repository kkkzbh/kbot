import { Context, Logger, Schema } from 'koishi';
import {
  dedupeSearchResults,
  parseBingWebResults,
  parseDuckDuckGoLiteResults,
  parseQueryPlan,
  parseWikipediaOpenSearchResults,
  rankSearchResultsByRelevance,
  sanitizeSearchQueryInput,
  type QueryPlan,
  type SearchProviderResult,
  type SearchResult,
} from './chatluna-search-hotfix-core.js';

export const name = 'chatluna-search-hotfix';
export const inject = ['chatluna'];

const logger = new Logger(name);
const DEFAULT_TOP_K = 5;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_QUERY_REWRITE_MODEL = process.env.OPENAI_MODEL || 'deepseek/deepseek-chat';
const DEFAULT_QUERY_REWRITE_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1';
const DEFAULT_QUERY_REWRITE_MAX_TERMS = 6;
const DEFAULT_WIKIPEDIA_BASE_URLS = ['https://zh.wikipedia.org/w/api.php', 'https://en.wikipedia.org/w/api.php'];
const QUERY_REWRITE_SYSTEM_PROMPT = [
  '你是搜索查询规划器。',
  '你只输出 JSON，不要解释。',
  '输出格式固定为 {"primary_entities":[],"related_works":[],"aliases_zh":[],"aliases_en":[],"queries":[]}。',
  'primary_entities: 用户要找的核心人物/组织/地点/概念，最多4项。',
  'related_works: 这些实体最可能关联的作品名/系列名/世界观，最多4项。',
  'aliases_zh / aliases_en: 常见别名、译名、英文写法，最多各4项。',
  'queries: 适合搜索引擎的查询串，最多6项，必须优先保留原始实体，可加入作品名辅助 disambiguation。',
  '禁止臆造不存在的实体；如果不确定作品名，可以留空，不要瞎编。',
].join('\n');
const SEARCH_SUMMARY_SYSTEM_PROMPT = [
  '你是搜索结果总结器。',
  '输入包含用户问题与候选搜索结果(title/url/description/source)。',
  '只基于输入结果总结，不得编造。',
  '先给简洁结论，再给2-4条来源链接。',
  '若证据不足或结果明显不相关，直接输出澄清提问（例如让用户确认人物/作品/游戏）。',
  '输出纯文本，不要 JSON，不要 markdown 代码块。',
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
  ]).description('可选的 Wikipedia API Base URL 列表。'),
  queryRewriteEnabled: Schema.boolean().default(true).description('是否启用 DeepSeek 查询规划与总结。'),
  queryRewriteModel: Schema.string().default(DEFAULT_QUERY_REWRITE_MODEL).description('查询规划与总结使用的模型。'),
  queryRewriteBaseURL: Schema.string()
    .default(DEFAULT_QUERY_REWRITE_BASE_URL)
    .description('查询规划 API Base URL（OpenAI 兼容）。'),
  queryRewriteApiKey: Schema.string().default('').description('查询规划 API Key（为空则跳过规划）。'),
  queryRewriteMaxTerms: Schema.number().min(1).max(6).default(DEFAULT_QUERY_REWRITE_MAX_TERMS).description('查询规划最多保留词条数。'),
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

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

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
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
}

function normalizeWikipediaBaseURLs(raw: Config['wikipediaBaseURL']): string[] {
  if (Array.isArray(raw)) {
    const normalized = takeUnique(raw.map((item) => normalizeBaseURL(item)), 4);
    return normalized.length ? normalized : DEFAULT_WIKIPEDIA_BASE_URLS;
  }

  if (typeof raw === 'string') {
    const normalized = takeUnique(
      raw
        .split(',')
        .map((item) => normalizeBaseURL(item))
        .filter(Boolean),
      4,
    );
    return normalized.length ? normalized : DEFAULT_WIKIPEDIA_BASE_URLS;
  }

  return DEFAULT_WIKIPEDIA_BASE_URLS;
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
    wikipediaBaseURLs: normalizeWikipediaBaseURLs(config.wikipediaBaseURL),
    queryRewriteEnabled: config.queryRewriteEnabled !== false,
    queryRewriteModel,
    queryRewriteBaseURL,
    queryRewriteApiKey,
    queryRewriteMaxTerms: Number.isFinite(queryRewriteMaxTerms)
      ? clampInteger(queryRewriteMaxTerms, 1, 6)
      : DEFAULT_QUERY_REWRITE_MAX_TERMS,
  };
}

function isDeepSeekCompatibleBaseURL(baseURL: string): boolean {
  return /(^https?:\/\/)?api\.deepseek\.com(?:\/|$)/i.test(baseURL);
}

function buildModelCandidates(model: string, baseURL: string): string[] {
  const normalized = normalizeText(model);
  if (!normalized) return [];

  const shortName = normalized.includes('/') ? normalizeText(normalized.split('/').pop() ?? '') : '';
  if (isDeepSeekCompatibleBaseURL(baseURL) && shortName) {
    return takeUnique([shortName, normalized], 2);
  }

  return takeUnique([normalized, shortName], 2);
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

function extractMessageText(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => (typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n');
}

async function invokeOpenAICompatible(
  runtime: RuntimeConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const modelCandidates = buildModelCandidates(runtime.queryRewriteModel, runtime.queryRewriteBaseURL);
  if (!modelCandidates.length) {
    throw new Error('no available model candidates');
  }

  let lastError: Error | null = null;
  for (const model of modelCandidates) {
    const response = await fetchWithTimeout(
      `${runtime.queryRewriteBaseURL}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${runtime.queryRewriteApiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      },
      runtime.timeoutMs,
    );

    if (response.ok) {
      const payload = (await response.json()) as ChatCompletionResponse;
      return extractMessageText(payload.choices?.[0]?.message?.content);
    }

    const error = new Error(`openai-compatible status=${response.status} model=${model}`);
    lastError = error;
    if (response.status < 500) continue;
    throw error;
  }

  throw lastError ?? new Error('openai-compatible request failed');
}

async function searchByDuckDuckGoLite(query: string, limit: number, timeoutMs: number): Promise<SearchProviderResult[]> {
  const url = `https://lite.duckduckgo.com/lite/?dc=${limit}&q=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0 Safari/537.36',
        Referer: 'https://lite.duckduckgo.com/',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      },
    },
    timeoutMs,
  );
  if (!response.ok) {
    throw new Error(`duckduckgo-lite status=${response.status}`);
  }
  return parseDuckDuckGoLiteResults(await response.text(), limit);
}

async function searchByBingWeb(query: string, limit: number, timeoutMs: number): Promise<SearchProviderResult[]> {
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
  return parseBingWebResults(await response.text(), limit);
}

async function searchByWikipedia(
  query: string,
  baseURL: string,
  limit: number,
  timeoutMs: number,
): Promise<SearchProviderResult[]> {
  const url = `${baseURL}?action=opensearch&search=${encodeURIComponent(query)}&limit=${limit}&namespace=0&format=json`;
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      },
    },
    timeoutMs,
  );
  if (!response.ok) {
    throw new Error(`wikipedia status=${response.status}`);
  }
  return parseWikipediaOpenSearchResults(await response.text(), limit, baseURL);
}

async function rewriteSearchPlan(query: string, runtime: RuntimeConfig): Promise<QueryPlan | null> {
  if (!runtime.queryRewriteEnabled) return null;
  if (!runtime.queryRewriteApiKey || !runtime.queryRewriteBaseURL || !runtime.queryRewriteModel) return null;

  const messageText = await invokeOpenAICompatible(runtime, QUERY_REWRITE_SYSTEM_PROMPT, `用户搜索请求：${query}`);
  if (!messageText) return null;

  return parseQueryPlan(messageText, query);
}

function toSearchObservation(results: SearchResult[]): string {
  if (results.length) return JSON.stringify(results);
  return JSON.stringify([{ title: 'No results found', description: 'No results found', url: '' }]);
}

async function summarizeSearchResults(
  query: string,
  rankedResults: SearchResult[],
  runtime: RuntimeConfig,
): Promise<string | null> {
  if (!runtime.queryRewriteEnabled) return null;
  if (!runtime.queryRewriteApiKey || !runtime.queryRewriteBaseURL || !runtime.queryRewriteModel) return null;

  const messageText = (
    await invokeOpenAICompatible(
      runtime,
      SEARCH_SUMMARY_SYSTEM_PROMPT,
      `用户问题：${query}\n候选搜索结果(JSON)：${JSON.stringify(rankedResults)}`,
    )
  )
    .replace(/\r\n?/g, '\n')
    .trim();
  return messageText || null;
}

class StableWebSearchTool {
  name = 'web_search';
  description =
    'A reliable web search tool for current questions. It returns concise summary text with source links, and falls back to JSON results when summary fails.';

  constructor(private runtime: RuntimeConfig) {}

  async invoke(input: unknown): Promise<string> {
    const originalQuery = normalizeText(typeof input === 'string' ? input : String(input ?? ''));
    if (!originalQuery) return '[]';

    const sanitizedQuery = sanitizeSearchQueryInput(originalQuery);
    const fallbackPlan = parseQueryPlan('', sanitizedQuery);

    let queryPlan = fallbackPlan;
    try {
      const rewrittenPlan = await rewriteSearchPlan(sanitizedQuery, this.runtime);
      if (rewrittenPlan) {
        queryPlan = {
          ...rewrittenPlan,
          queries: takeUnique(rewrittenPlan.queries, this.runtime.queryRewriteMaxTerms),
        };
      }
    } catch (error) {
      logger.warn('query rewrite failed: %s', (error as Error).message);
    }

    const searchQueries = takeUnique(queryPlan.queries.length ? queryPlan.queries : [sanitizedQuery], this.runtime.queryRewriteMaxTerms);
    const wikipediaQueries = takeUnique(
      [sanitizedQuery, ...queryPlan.primaryEntities, ...queryPlan.relatedWorks],
      Math.min(4, this.runtime.queryRewriteMaxTerms),
    );

    const searchTasks: Array<Promise<SearchProviderResult[]>> = [];
    for (const term of searchQueries) {
      searchTasks.push(
        searchByDuckDuckGoLite(term, this.runtime.topK * 2, this.runtime.timeoutMs).catch((error) => {
          logger.warn('duckduckgo-lite search failed (term=%s): %s', term, (error as Error).message);
          return [] as SearchProviderResult[];
        }),
      );
      searchTasks.push(
        searchByBingWeb(term, this.runtime.topK * 2, this.runtime.timeoutMs).catch((error) => {
          logger.warn('bing web search failed (term=%s): %s', term, (error as Error).message);
          return [] as SearchProviderResult[];
        }),
      );
    }
    for (const baseURL of this.runtime.wikipediaBaseURLs) {
      for (const term of wikipediaQueries) {
        searchTasks.push(
          searchByWikipedia(term, baseURL, this.runtime.topK, this.runtime.timeoutMs).catch((error) => {
            logger.warn('wikipedia search failed (base=%s term=%s): %s', baseURL, term, (error as Error).message);
            return [] as SearchProviderResult[];
          }),
        );
      }
    }

    const merged = (await Promise.all(searchTasks)).flat();
    const ranked = rankSearchResultsByRelevance(merged, queryPlan, this.runtime.topK, sanitizedQuery);
    const summaryCandidates = ranked.length ? ranked : dedupeSearchResults(merged, this.runtime.topK);
    const serializableCandidates = summaryCandidates.map(({ title, url, description, image }) => ({
      title,
      url,
      description,
      ...(image ? { image } : {}),
    }));

    try {
      const summary = await summarizeSearchResults(originalQuery, serializableCandidates, this.runtime);
      if (summary) return summary;
    } catch (error) {
      logger.warn('search summary failed: %s', (error as Error).message);
    }

    return toSearchObservation(serializableCandidates);
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
