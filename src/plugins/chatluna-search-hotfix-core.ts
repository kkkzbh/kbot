export type SearchResult = {
  title: string;
  url: string;
  description: string;
  image?: string;
};

const SEARCH_PREFIX_PATTERN = /^(?:再)?(?:去)?(?:搜(?:索)?|查(?:询)?)(?:一下|一查|一搜)?[:：,\s]*/i;
const SEARCH_LEADING_PRONOUN_PATTERN = /^(?:请|麻烦)?(?:你|你再|你帮我|帮我|给我)\s*/i;
const SEARCH_SUFFIX_PATTERN = /(?:吧|呢|呀|吗|可以吗|行吗|谢谢)[!！?？。]*$/i;
const SOFT_STOPWORDS = new Set([
  '你',
  '我',
  '帮',
  '帮我',
  '一下',
  '搜索',
  '搜',
  '查',
  '查询',
  '请',
  '麻烦',
  '一下吧',
  '是谁',
  '是什么',
  '今天',
  '现在',
]);

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' '));
}

function normalizeSearchToken(token: string): string {
  return normalizeText(token)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[。！？!?，、;；]+$/g, '');
}

export function sanitizeSearchQueryInput(raw: string): string {
  const normalized = normalizeText(raw);
  if (!normalized) return '';

  let value = normalized;
  value = value.replace(/^@\S+\s*/g, '');
  value = value.replace(SEARCH_LEADING_PRONOUN_PATTERN, '');
  value = value.replace(SEARCH_PREFIX_PATTERN, '');
  value = value.replace(SEARCH_PREFIX_PATTERN, '');
  value = value.replace(SEARCH_SUFFIX_PATTERN, '');
  value = normalizeSearchToken(value);
  return value || normalized;
}

export function parseRewrittenSearchTerms(payload: string): { zhTerms: string[]; enTerms: string[] } {
  const normalized = normalizeText(payload);
  if (!normalized) return { zhTerms: [], enTerms: [] };

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    const block = normalized.match(/\{[\s\S]*\}/)?.[0];
    if (block) {
      try {
        parsed = JSON.parse(block);
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== 'object') return { zhTerms: [], enTerms: [] };

  const value = parsed as {
    zh_terms?: unknown;
    en_terms?: unknown;
    zhTerms?: unknown;
    enTerms?: unknown;
  };
  const toArray = (input: unknown): string[] => {
    if (!Array.isArray(input)) return [];
    return input
      .map((item) => normalizeSearchToken(typeof item === 'string' ? item : String(item ?? '')))
      .filter(Boolean);
  };

  const zhTerms = toArray(value.zh_terms ?? value.zhTerms);
  const enTerms = toArray(value.en_terms ?? value.enTerms);
  return { zhTerms, enTerms };
}

function tokenizeKeywordCandidates(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const zhTokens = normalized.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  const enTokens = normalized.match(/[A-Za-z0-9][A-Za-z0-9\-_.]{1,}/g) ?? [];
  const normalizedZhTokens = zhTokens.flatMap((token) => {
    const withoutSuffix = token.replace(/(?:是谁|是什么|有哪些|介绍|资料|百科|新闻|消息|条目)$/g, '');
    const pieces = withoutSuffix
      .split(/[与和跟及、]/g)
      .map((part) => part.trim())
      .filter(Boolean);
    return pieces.length ? pieces : [token];
  });

  return [...normalizedZhTokens, ...enTokens].map((token) => token.toLowerCase());
}

function isUsefulKeyword(token: string): boolean {
  if (!token) return false;
  if (SOFT_STOPWORDS.has(token)) return false;
  if (token.length <= 1) return false;
  if (/^(是谁|是什么|多少|怎么|如何)$/.test(token)) return false;
  return true;
}

export function extractRelevanceKeywords(terms: string[]): string[] {
  const deduped = new Set<string>();
  for (const term of terms) {
    for (const token of tokenizeKeywordCandidates(term)) {
      if (!isUsefulKeyword(token)) continue;
      deduped.add(token);
    }
  }
  return [...deduped];
}

function calculateResultScore(result: SearchResult, keywords: string[]): number {
  const title = normalizeText(result.title).toLowerCase();
  const description = normalizeText(result.description).toLowerCase();
  const url = normalizeText(result.url).toLowerCase();

  let score = 0;
  for (const keyword of keywords) {
    if (title.includes(keyword)) score += 3;
    if (description.includes(keyword)) score += 1;
    if (url.includes(keyword)) score += 0.5;
  }
  return score;
}

export function rankSearchResultsByRelevance(results: SearchResult[], keywords: string[], limit: number): SearchResult[] {
  const deduped = dedupeSearchResults(results, Math.max(limit, results.length));
  if (!keywords.length) return deduped.slice(0, limit);

  const withScore = deduped.map((result, index) => ({
    result,
    index,
    score: calculateResultScore(result, keywords),
  }));

  const relevant = withScore.filter((item) => item.score > 0);
  if (!relevant.length) return [];
  const source = relevant;

  source.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.index - right.index;
  });

  return source.slice(0, limit).map((item) => item.result);
}

export function parseBingWebResults(html: string, limit: number): SearchResult[] {
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
  const results: SearchResult[] = [];
  for (const block of blocks) {
    if (results.length >= limit) break;

    const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;

    const rawUrl = decodeHtmlEntities(titleMatch[1]).trim();
    const rawTitle = normalizeText(stripHtml(titleMatch[2]));
    if (!rawUrl || !rawTitle || !/^https?:\/\//i.test(rawUrl)) continue;

    const descriptionMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const rawDescription = normalizeText(stripHtml(descriptionMatch?.[1] ?? ''));

    results.push({
      title: rawTitle,
      url: rawUrl,
      description: rawDescription,
    });
  }
  return results;
}

export function dedupeSearchResults(results: SearchResult[], limit: number): SearchResult[] {
  const seen = new Set<string>();
  const output: SearchResult[] = [];
  for (const result of results) {
    if (output.length >= limit) break;
    const key = result.url || result.title.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(result);
  }
  return output;
}
