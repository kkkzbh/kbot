export type SearchResult = {
  title: string;
  url: string;
  description: string;
  image?: string;
};

export type SearchProviderResult = SearchResult & {
  source: 'duckduckgo-lite' | 'bing-web' | 'wikipedia';
};

export type QueryPlan = {
  primaryEntities: string[];
  relatedWorks: string[];
  aliasesZh: string[];
  aliasesEn: string[];
  queries: string[];
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
  '角色',
  '人物',
  '资料',
  '百科',
]);
const HIGH_SIGNAL_DOMAIN_WEIGHTS: Array<[RegExp, number]> = [
  [/moegirl\.org\.cn/i, 8],
  [/wikipedia\.org/i, 7],
  [/baike\.baidu\.com/i, 7],
  [/bangumi\.tv/i, 6],
  [/anibase\.net/i, 5],
  [/fandom\.com/i, 4],
  [/bilibili\.com/i, 3],
];

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

function takeUnique(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const normalized = normalizeSearchToken(item);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
}

function parseJsonBlock(payload: string): Record<string, unknown> | null {
  const normalized = normalizeText(payload);
  if (!normalized) return null;

  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    const block = normalized.match(/\{[\s\S]*\}/)?.[0];
    if (!block) return null;
    try {
      const parsed = JSON.parse(block);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeSearchToken(typeof item === 'string' ? item : String(item ?? '')))
    .filter(Boolean);
}

function splitEntityCandidates(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const zhTokens = normalized.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  const enTokens = normalized.match(/[A-Za-z0-9][A-Za-z0-9\-_.]{1,}/g) ?? [];
  const results: string[] = [];

  for (const token of zhTokens) {
    const trimmed = token.replace(/(?:是谁|是什么|有哪些|介绍|资料|百科|新闻|消息|条目|角色|人物)$/g, '');
    const pieces = trimmed
      .split(/[与和跟及、]/g)
      .map((part) => part.trim())
      .filter(Boolean);
    if (pieces.length) {
      results.push(...pieces);
    } else {
      results.push(token);
    }
  }

  results.push(...enTokens);
  return takeUnique(results, 12);
}

function isUsefulKeyword(token: string): boolean {
  if (!token) return false;
  if (SOFT_STOPWORDS.has(token)) return false;
  if (token.length <= 1) return false;
  if (/^(是谁|是什么|多少|怎么|如何)$/.test(token)) return false;
  return true;
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
  const parsed = parseJsonBlock(payload);
  if (!parsed) return { zhTerms: [], enTerms: [] };

  return {
    zhTerms: toStringArray(parsed.zh_terms ?? parsed.zhTerms),
    enTerms: toStringArray(parsed.en_terms ?? parsed.enTerms),
  };
}

function buildFallbackQueries(query: string, entities: string[], relatedWorks: string[]): string[] {
  const fallbackQueries = [query];
  if (entities.length >= 2) {
    fallbackQueries.push(`${entities.join(' ')} 角色`);
    fallbackQueries.push(`${entities.join(' ')} 作品`);
  }
  for (const work of relatedWorks) {
    fallbackQueries.push(`${query} ${work}`);
    for (const entity of entities) {
      fallbackQueries.push(`${entity} ${work}`);
    }
  }
  fallbackQueries.push(...entities);
  return takeUnique(fallbackQueries, 6);
}

export function parseQueryPlan(payload: string, fallbackQuery: string): QueryPlan {
  const parsed = parseJsonBlock(payload);
  const fallbackEntities = splitEntityCandidates(fallbackQuery);
  const fallbackPlan = {
    primaryEntities: takeUnique(fallbackEntities, 4),
    relatedWorks: [] as string[],
    aliasesZh: [] as string[],
    aliasesEn: [] as string[],
    queries: buildFallbackQueries(fallbackQuery, fallbackEntities, []),
  };

  if (!parsed) return fallbackPlan;

  const legacyTerms = parseRewrittenSearchTerms(payload);
  const primaryEntities = takeUnique(
    toStringArray(parsed.primaryEntities ?? parsed.primary_entities).length
      ? toStringArray(parsed.primaryEntities ?? parsed.primary_entities)
      : fallbackEntities,
    4,
  );
  const relatedWorks = takeUnique(toStringArray(parsed.relatedWorks ?? parsed.related_works), 4);
  const aliasesZh = takeUnique(
    [...toStringArray(parsed.aliasesZh ?? parsed.aliases_zh), ...legacyTerms.zhTerms],
    4,
  );
  const aliasesEn = takeUnique(
    [...toStringArray(parsed.aliasesEn ?? parsed.aliases_en), ...legacyTerms.enTerms],
    4,
  );
  const queries = takeUnique(
    [
      ...toStringArray(parsed.queries),
      fallbackQuery,
      ...primaryEntities,
      ...relatedWorks,
      ...aliasesZh,
      ...aliasesEn,
      ...buildFallbackQueries(fallbackQuery, primaryEntities, relatedWorks),
    ],
    6,
  );

  return {
    primaryEntities: primaryEntities.length ? primaryEntities : fallbackPlan.primaryEntities,
    relatedWorks,
    aliasesZh,
    aliasesEn,
    queries: queries.length ? queries : fallbackPlan.queries,
  };
}

function tokenizeKeywordCandidates(text: string): string[] {
  return splitEntityCandidates(text).map((token) => token.toLowerCase());
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

function cleanDuckDuckGoRedirect(rawUrl: string): string {
  const decoded = decodeHtmlEntities(rawUrl).trim();
  if (!decoded) return '';
  let normalized = decoded;
  if (normalized.startsWith('//')) {
    normalized = `https:${normalized}`;
  }
  if (normalized.startsWith('/l/?uddg=')) {
    const encodedTarget = normalized.slice('/l/?uddg='.length).split('&')[0];
    try {
      return decodeURIComponent(encodedTarget);
    } catch {
      return encodedTarget;
    }
  }
  return normalized;
}

function canonicalizeUrl(rawUrl: string): string {
  const cleaned = cleanDuckDuckGoRedirect(rawUrl);
  if (!cleaned) return '';
  try {
    const url = new URL(cleaned);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|form$|spm$|from$|ref$|source$|ved$|rut$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.protocol}//${url.host}${pathname}${url.search ? `?${url.searchParams.toString()}` : ''}`.toLowerCase();
  } catch {
    return cleaned.trim().toLowerCase();
  }
}

export function parseDuckDuckGoLiteResults(html: string, limit: number): SearchProviderResult[] {
  const resultLinkRegex = /<a[^>]*?href="([^"]*)"[^>]*?class=['"]result-link['"][^>]*?>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<td[^>]*?class=['"]result-snippet['"][^>]*?>([\s\S]*?)<\/td>/gi;
  const links: Array<{ url: string; title: string }> = [];
  const snippets: string[] = [];
  let match: RegExpExecArray | null = null;

  while ((match = resultLinkRegex.exec(html)) !== null) {
    const url = cleanDuckDuckGoRedirect(match[1]);
    const title = normalizeText(stripHtml(match[2]));
    if (!url || !title) continue;
    links.push({ url, title });
  }

  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(normalizeText(stripHtml(match[1])));
  }

  const results: SearchProviderResult[] = [];
  for (let index = 0; index < links.length && results.length < limit; index += 1) {
    const link = links[index];
    if (!/^https?:\/\//i.test(link.url)) continue;
    results.push({
      title: link.title,
      url: link.url,
      description: snippets[index] ?? '',
      source: 'duckduckgo-lite',
    });
  }

  return results;
}

export function parseBingWebResults(html: string, limit: number): SearchProviderResult[] {
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
  const results: SearchProviderResult[] = [];
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
      source: 'bing-web',
    });
  }
  return results;
}

export function parseWikipediaOpenSearchResults(payload: string, limit: number, sourceUrl: string): SearchProviderResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length < 4) return [];

  const titles = Array.isArray(parsed[1]) ? parsed[1] : [];
  const descriptions = Array.isArray(parsed[2]) ? parsed[2] : [];
  const urls = Array.isArray(parsed[3]) ? parsed[3] : [];
  const results: SearchProviderResult[] = [];
  const host = (() => {
    try {
      return new URL(sourceUrl).host;
    } catch {
      return 'wikipedia.org';
    }
  })();

  for (let index = 0; index < titles.length && results.length < limit; index += 1) {
    const title = normalizeSearchToken(String(titles[index] ?? ''));
    const description = normalizeText(String(descriptions[index] ?? ''));
    const url = normalizeText(String(urls[index] ?? ''));
    if (!title || !url || !/^https?:\/\//i.test(url)) continue;
    results.push({
      title,
      url,
      description: description || `${title} - ${host}`,
      source: 'wikipedia',
    });
  }

  return results;
}

export function dedupeSearchResults<T extends SearchResult>(results: T[], limit: number): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const result of results) {
    if (output.length >= limit) break;
    const key = canonicalizeUrl(result.url) || normalizeText(result.title).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(result);
  }
  return output;
}

function scoreSignal(text: string, terms: string[], titleWeight: number, descriptionWeight: number): number {
  let score = 0;
  const normalized = normalizeText(text).toLowerCase();
  for (const term of terms) {
    const token = term.toLowerCase();
    if (!token) continue;
    if (normalized.includes(token)) {
      score += normalized.startsWith(token) ? titleWeight + 1 : titleWeight;
      if (token.length >= 4 || /[\u3400-\u9fff]{2,}/.test(token)) {
        score += descriptionWeight;
      }
    }
  }
  return score;
}

function calculateResultScore(result: SearchResult, plan: QueryPlan, keywords: string[], originalQuery: string): number {
  const title = normalizeText(result.title).toLowerCase();
  const description = normalizeText(result.description).toLowerCase();
  const url = canonicalizeUrl(result.url);
  const combined = `${title} ${description} ${url}`;
  const normalizedQuery = normalizeText(originalQuery).toLowerCase();

  let score = 0;
  if (normalizedQuery && title.includes(normalizedQuery)) score += 18;
  if (normalizedQuery && description.includes(normalizedQuery)) score += 7;

  const entityHits = plan.primaryEntities.filter((entity) => combined.includes(entity.toLowerCase()));
  const workHits = plan.relatedWorks.filter((work) => combined.includes(work.toLowerCase()));
  const aliasHits = [...plan.aliasesZh, ...plan.aliasesEn].filter((alias) => combined.includes(alias.toLowerCase()));

  score += scoreSignal(title, plan.primaryEntities, 8, 0);
  score += scoreSignal(description, plan.primaryEntities, 4, 0);
  score += scoreSignal(title, plan.relatedWorks, 6, 0);
  score += scoreSignal(description, plan.relatedWorks, 3, 0);
  score += scoreSignal(title, [...plan.aliasesZh, ...plan.aliasesEn], 5, 0);
  score += scoreSignal(description, [...plan.aliasesZh, ...plan.aliasesEn], 2, 0);

  for (const keyword of keywords) {
    if (title.includes(keyword)) score += 2.5;
    if (description.includes(keyword)) score += 1;
    if (url.includes(keyword)) score += 0.75;
  }

  if (plan.primaryEntities.length > 1 && entityHits.length >= Math.min(2, plan.primaryEntities.length)) score += 12;
  if (plan.relatedWorks.length && workHits.length) score += 8;
  if (aliasHits.length) score += 4 + aliasHits.length;

  for (const [pattern, weight] of HIGH_SIGNAL_DOMAIN_WEIGHTS) {
    if (pattern.test(url)) score += weight;
  }

  if (plan.primaryEntities.length && entityHits.length === 0 && workHits.length === 0) {
    score -= 12;
  }

  return score;
}

export function rankSearchResultsByRelevance<T extends SearchResult>(
  results: T[],
  input: QueryPlan | string[],
  limit: number,
  originalQuery = '',
): T[] {
  const deduped = dedupeSearchResults(results, Math.max(limit, results.length));
  const plan = Array.isArray(input)
    ? {
        primaryEntities: takeUnique(input, 4),
        relatedWorks: [] as string[],
        aliasesZh: [] as string[],
        aliasesEn: [] as string[],
        queries: takeUnique(input, 6),
      }
    : input;
  const keywords = Array.isArray(input)
    ? takeUnique(input, 8).map((item) => item.toLowerCase())
    : extractRelevanceKeywords([
        originalQuery,
        ...plan.primaryEntities,
        ...plan.relatedWorks,
        ...plan.aliasesZh,
        ...plan.aliasesEn,
        ...plan.queries,
      ]);

  if (!keywords.length && !plan.primaryEntities.length && !plan.relatedWorks.length) {
    return deduped.slice(0, limit);
  }

  const withScore = deduped.map((result, index) => ({
    result,
    index,
    score: calculateResultScore(result, plan, keywords, originalQuery),
  }));

  const relevant = withScore.filter((item) => item.score > 0);
  if (!relevant.length) return [];

  relevant.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.index - right.index;
  });

  return relevant.slice(0, limit).map((item) => item.result);
}
