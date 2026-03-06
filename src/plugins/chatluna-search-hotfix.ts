import { Context, Logger, Schema } from 'koishi';
import {
  dedupeSearchResults,
  looksLikeDuckDuckGoLiteAnomalyPage,
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

function queryContainsAllEntities(query: string, entities: string[]): boolean {
  const normalizedQuery = normalizeText(query);
  return entities.every((entity) => normalizedQuery.includes(entity));
}

function queryContainsAnyEntity(query: string, entities: string[]): boolean {
  const normalizedQuery = normalizeText(query);
  return entities.some((entity) => normalizedQuery.includes(entity));
}

function extractWorkTitleCandidates(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const results: string[] = [];
  for (const match of normalized.matchAll(/《([^》]{2,40})》/g)) {
    results.push(normalizeText(match[1]));
  }

  const titlePrefix = normalized.split(/\s*[-|｜]\s*/)[0];
  if (
    titlePrefix &&
    /[\u3400-\u9fff]/.test(titlePrefix) &&
    titlePrefix.length >= 3 &&
    titlePrefix.length <= 20 &&
    !/[：:]/.test(titlePrefix) &&
    !/(百度百科|萌娘百科|维基百科|bilibili|知乎|微博|论坛|讨论|角色|人物|百科全书)/i.test(titlePrefix)
  ) {
    results.push(normalizeText(titlePrefix));
  }

  return takeUnique(results, 4);
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
  if (!response.ok || response.status !== 200) {
    throw new Error(`duckduckgo-lite status=${response.status}`);
  }
  const html = await response.text();
  if (looksLikeDuckDuckGoLiteAnomalyPage(html)) {
    throw new Error('duckduckgo-lite anomaly challenge');
  }
  return parseDuckDuckGoLiteResults(html, limit);
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

type SearchObservation = {
  query: string;
  normalized_query: string;
  status: 'resolved' | 'ambiguous' | 'no_match';
  entities: string[];
  likely_works: string[];
  top_results: Array<{
    title: string;
    url: string;
    description: string;
    source?: string;
    image?: string;
  }>;
};

function buildSearchObservation(
  originalQuery: string,
  sanitizedQuery: string,
  plan: QueryPlan,
  results: SearchResult[],
): string {
  const workCounts = new Map<string, number>();
  for (const result of results) {
    const weight = Math.max(1, 5 - results.indexOf(result));
    for (const work of extractWorkTitleCandidates(`${result.title}\n${result.description}`)) {
      workCounts.set(work, (workCounts.get(work) ?? 0) + weight);
    }
  }

  const likelyWorks = [...workCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([work]) => work)
    .slice(0, 4);

  const status: SearchObservation['status'] = results.length
    ? likelyWorks.length > 1 && plan.primaryEntities.length <= 1
      ? 'ambiguous'
      : 'resolved'
    : 'no_match';

  const payload: SearchObservation = {
    query: originalQuery,
    normalized_query: sanitizedQuery,
    status,
    entities: plan.primaryEntities,
    likely_works: likelyWorks,
    top_results: results.length
      ? results.map(({ title, url, description, image }) => ({
          title,
          url,
          description,
          ...(image ? { image } : {}),
        }))
      : [{ title: 'No results found', url: '', description: 'No relevant search results were found.' }],
  };

  return JSON.stringify(payload, null, 2);
}

function buildSearchQueries(plan: QueryPlan, runtime: RuntimeConfig, sanitizedQuery: string): string[] {
  const isAmbiguousMultiEntityQuery = plan.primaryEntities.length >= 2 && plan.relatedWorks.length === 0;
  const searchQueries = takeUnique(
    (plan.queries.length ? plan.queries : [sanitizedQuery]).filter(
      (query) => !isAmbiguousMultiEntityQuery || queryContainsAllEntities(query, plan.primaryEntities),
    ),
    runtime.queryRewriteMaxTerms,
  );
  return searchQueries.length ? searchQueries : [sanitizedQuery];
}

function buildWikipediaQueries(plan: QueryPlan, runtime: RuntimeConfig, sanitizedQuery: string): string[] {
  const isAmbiguousMultiEntityQuery = plan.primaryEntities.length >= 2 && plan.relatedWorks.length === 0;
  if (isAmbiguousMultiEntityQuery) return [];
  return takeUnique([sanitizedQuery, ...plan.primaryEntities, ...plan.relatedWorks], Math.min(4, runtime.queryRewriteMaxTerms));
}

function extractEntityPreservingQueries(
  rewrittenPlan: QueryPlan,
  fallbackPlan: QueryPlan,
  runtime: RuntimeConfig,
): string[] {
  if (!fallbackPlan.primaryEntities.length) return [];

  const guard = fallbackPlan.primaryEntities.length >= 2
    ? (query: string) => queryContainsAllEntities(query, fallbackPlan.primaryEntities)
    : (query: string) => queryContainsAnyEntity(query, fallbackPlan.primaryEntities);

  return takeUnique(
    rewrittenPlan.queries.filter((query) => guard(query)),
    runtime.queryRewriteMaxTerms,
  );
}

async function executeSearchPlan(
  plan: QueryPlan,
  sanitizedQuery: string,
  runtime: RuntimeConfig,
): Promise<SearchProviderResult[]> {
  const searchTasks: Array<Promise<SearchProviderResult[]>> = [];
  for (const term of buildSearchQueries(plan, runtime, sanitizedQuery)) {
    searchTasks.push(
      searchByDuckDuckGoLite(term, runtime.topK * 2, runtime.timeoutMs).catch((error) => {
        logger.warn('duckduckgo-lite search failed (term=%s): %s', term, (error as Error).message);
        return [] as SearchProviderResult[];
      }),
    );
    searchTasks.push(
      searchByBingWeb(term, runtime.topK * 2, runtime.timeoutMs).catch((error) => {
        logger.warn('bing web search failed (term=%s): %s', term, (error as Error).message);
        return [] as SearchProviderResult[];
      }),
    );
  }

  for (const baseURL of runtime.wikipediaBaseURLs) {
    for (const term of buildWikipediaQueries(plan, runtime, sanitizedQuery)) {
      searchTasks.push(
        searchByWikipedia(term, baseURL, runtime.topK, runtime.timeoutMs).catch((error) => {
          logger.warn('wikipedia search failed (base=%s term=%s): %s', baseURL, term, (error as Error).message);
          return [] as SearchProviderResult[];
        }),
      );
    }
  }

  return (await Promise.all(searchTasks)).flat();
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
    let merged = await executeSearchPlan(fallbackPlan, sanitizedQuery, this.runtime);
    let ranked = rankSearchResultsByRelevance(merged, fallbackPlan, this.runtime.topK, sanitizedQuery);

    if (!ranked.length) {
      try {
        const rewrittenPlan = await rewriteSearchPlan(sanitizedQuery, this.runtime);
        if (rewrittenPlan) {
          const expandedQueries = extractEntityPreservingQueries(rewrittenPlan, fallbackPlan, this.runtime);
          if (expandedQueries.length) {
            const expandedPlan: QueryPlan = {
              ...fallbackPlan,
              queries: takeUnique([...fallbackPlan.queries, ...expandedQueries], this.runtime.queryRewriteMaxTerms),
            };
            merged = dedupeSearchResults(
              [...merged, ...(await executeSearchPlan(expandedPlan, sanitizedQuery, this.runtime))],
              Math.max(this.runtime.topK * this.runtime.queryRewriteMaxTerms, this.runtime.topK * 2),
            );
            ranked = rankSearchResultsByRelevance(merged, fallbackPlan, this.runtime.topK, sanitizedQuery);
          }
        }
      } catch (error) {
        logger.warn('query rewrite failed: %s', (error as Error).message);
      }
    }

    const observationResults = ranked.length ? ranked : dedupeSearchResults(merged, this.runtime.topK);
    return buildSearchObservation(originalQuery, sanitizedQuery, fallbackPlan, observationResults);
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
