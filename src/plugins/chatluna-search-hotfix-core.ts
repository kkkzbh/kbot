export type SearchResult = {
  title: string;
  url: string;
  description: string;
  image?: string;
};

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
