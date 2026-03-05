import { Context, Logger, Schema } from 'koishi';
import {
  extractRelevanceKeywords,
  parseBingWebResults,
  parseRewrittenSearchTerms,
  rankSearchResultsByRelevance,
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
const QUERY_REWRITE_SYSTEM_PROMPT = [
  '你是搜索关键词规划器。',
  '你只输出 JSON，不要解释。',
  '输出格式固定为 {"zh_terms":[],"en_terms":[]}。',
  '目标是把用户原始查询转换为可用于搜索引擎的关键词。',
  '必须保留核心实体名称，不得臆造不存在实体。',
  '可补充常见英文写法/别名。',
  '总关键词数(zh_terms+en_terms)不得超过6，每项简短可检索。',
].join('\n');
const SEARCH_SUMMARY_SYSTEM_PROMPT = [
  '你是搜索结果总结器。',
  '输入包含用户问题与候选搜索结果(title/url/description)。',
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
  ]).description('兼容保留字段（当前热修复链路不再使用）。'),
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
    queryRewriteEnabled: config.queryRewriteEnabled !== false,
    queryRewriteModel,
    queryRewriteBaseURL,
    queryRewriteApiKey,
    queryRewriteMaxTerms: Number.isFinite(queryRewriteMaxTerms)
      ? clampInteger(queryRewriteMaxTerms, 1, 6)
      : DEFAULT_QUERY_REWRITE_MAX_TERMS,
  };
}

function buildModelCandidates(model: string): string[] {
  const normalized = normalizeText(model);
  if (!normalized) return [];
  const candidates = [normalized];
  if (normalized.includes('/')) {
    const shortName = normalizeText(normalized.split('/').pop() ?? '');
    if (shortName && shortName !== normalized) candidates.push(shortName);
  }
  return takeUnique(candidates, 2);
}

async function invokeOpenAICompatible(
  runtime: RuntimeConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const modelCandidates = buildModelCandidates(runtime.queryRewriteModel);
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

  const messageText = await invokeOpenAICompatible(runtime, QUERY_REWRITE_SYSTEM_PROMPT, `用户搜索请求：${query}`);
  if (!messageText) return null;

  const rewritten = parseRewrittenSearchTerms(messageText);
  const zhTerms = takeUnique(rewritten.zhTerms, 6);
  const enTerms = takeUnique(rewritten.enTerms, 6);
  if (!zhTerms.length && !enTerms.length) return null;

  return { zhTerms, enTerms };
}

function buildSearchTerms(rewritten: QueryRewriteOutput | null, limit: number, fallbackQuery: string): string[] {
  const terms = takeUnique([...(rewritten?.zhTerms ?? []), ...(rewritten?.enTerms ?? [])], limit);
  if (terms.length) return terms;
  return [fallbackQuery];
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
    const rawQuery = normalizeText(typeof input === 'string' ? input : String(input ?? ''));
    if (!rawQuery) return '[]';

    let rewrittenTerms: QueryRewriteOutput | null = null;
    try {
      rewrittenTerms = await rewriteSearchTerms(rawQuery, this.runtime);
    } catch (error) {
      logger.warn('query rewrite failed: %s', (error as Error).message);
    }

    const searchTerms = buildSearchTerms(rewrittenTerms, this.runtime.queryRewriteMaxTerms, rawQuery);
    const relevanceKeywords = extractRelevanceKeywords([rawQuery, ...searchTerms]);

    const merged: SearchResult[] = [];
    const searchBatches = await Promise.allSettled(
      searchTerms.map(async (term) => {
        try {
          return await searchByBingWeb(term, this.runtime.topK * 2, this.runtime.timeoutMs);
        } catch (error) {
          logger.warn('bing web search failed (term=%s): %s', term, (error as Error).message);
          return [] as SearchResult[];
        }
      }),
    );
    for (const batch of searchBatches) {
      if (batch.status === 'fulfilled') {
        merged.push(...batch.value);
      }
    }

    const ranked = rankSearchResultsByRelevance(merged, relevanceKeywords, this.runtime.topK);
    try {
      const summary = await summarizeSearchResults(rawQuery, ranked, this.runtime);
      if (summary) return summary;
    } catch (error) {
      logger.warn('search summary failed: %s', (error as Error).message);
    }

    const fallbackResults = ranked.length
      ? ranked
      : rankSearchResultsByRelevance(merged, [], this.runtime.topK);
    return toSearchObservation(fallbackResults);
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
