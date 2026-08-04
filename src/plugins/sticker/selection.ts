import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const STICKER_CATALOG_FILENAME = 'catalog.generated.json';
const PERSONA_SCOPE_PREFIX = 'persona:';
const MIN_STICKER_MATCH_SCORE = 18;
const GENERIC_INTENT_TOKENS = new Set([
  '一个', '一张', '发个', '来个', '图片', '表情', '表情包', '贴图', 'meme', '聊天', '二次元', '少女',
]);
const STICKER_INTENT_SYNONYM_GROUPS = [
  ['开心', '喜悦', '欢快', '热烈', '庆祝', '欢呼', '鼓掌', '好耶', '成功', '顺利', '太棒', '干杯'],
  ['生气', '愤怒', '气恼', '不满', '气鼓鼓', '叉腰', '瞪人', '怒气', '恼火'],
  ['演出', '舞台', 'live', '乐队', '谢幕'],
] as const;
const STICKER_INTENT_SEGMENTER =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh', { granularity: 'word' })
    : null;

export interface StickerCatalogEntry {
  id: string;
  file: string;
  hash: string;
  mime: string;
  scopes: string[];
  caption: string;
  keywords: string[];
  moods: string[];
  scenes: string[];
  historyLabel: string;
  confidence: number;
}

export interface StickerCatalogDocument {
  version: 1;
  generatedAt: string;
  model: string;
  entries: StickerCatalogEntry[];
}

export interface LoadedStickerEntry extends StickerCatalogEntry {
  buffer: Buffer;
}

export interface LoadedStickerCatalog {
  version: 1;
  generatedAt: string;
  model: string;
  entries: LoadedStickerEntry[];
  byId: Map<string, LoadedStickerEntry>;
}

export interface StickerMatch {
  entry: LoadedStickerEntry;
  score: number;
}

export interface StickerCapabilityState {
  catalog: LoadedStickerCatalog | null;
  preset: string | null;
  availableCount: number;
}

export function mimeFromExtension(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function tokenizeIntent(intent: string): string[] {
  const normalized = intent
    .toLowerCase()
    .replace(/[，。！？、,.;:!?/\\()[\]{}"'`]+/g, ' ')
    .trim();
  if (!normalized) return [];

  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (STICKER_INTENT_SEGMENTER) {
    for (const segment of STICKER_INTENT_SEGMENTER.segment(normalized)) {
      const token = segment.segment.trim();
      if (!token || token === normalized) continue;
      tokens.push(token);
    }
  }

  if (normalized && !tokens.includes(normalized)) {
    tokens.unshift(normalized);
  }
  const semanticTokens = [...new Set(tokens)].filter((token) => (
    !GENERIC_INTENT_TOKENS.has(token)
    && (!/^\p{Script=Han}$/u.test(token) || token === normalized)
  ));
  for (const synonymGroup of STICKER_INTENT_SYNONYM_GROUPS) {
    if (synonymGroup.some((term) => normalized.includes(term))) {
      semanticTokens.push(...synonymGroup);
    }
  }
  return [...new Set(semanticTokens)];
}

function extractIntentFragments(intent: string): string[] {
  const normalized = intent
    .toLowerCase()
    .replace(/[。！？；;]+/g, '，')
    .replace(/\s+/g, '')
    .trim();
  if (!normalized) return [];

  const fragments = normalized
    .split(/(?:，|,|然后|再|接着|之后)/)
    .map((fragment) =>
      fragment
        .replace(/^(?:连续发[^，,]*表情包|发[^，,]*表情包|来[^，,]*表情包)+/g, '')
        .replace(/^(?:先|第一张|第二张|第一个|第二个|一张|一个|两张|两个)+/g, '')
        .replace(/(?:不要发文字|也不要发文字|不要解释|也不要解释|只发文字|只发表情包)+$/g, '')
        .trim(),
    )
    .filter((fragment) => fragment.length >= 2);

  return [...new Set(fragments)];
}

function matchesScope(scopes: string[], preset?: string | null): boolean {
  if (scopes.includes('global')) return true;
  const normalizedPreset = normalizeText(preset ?? '');
  if (!normalizedPreset) return false;
  return scopes.some((scope) => normalizeText(scope) === `${PERSONA_SCOPE_PREFIX}${normalizedPreset}`);
}

function collectEntryTerms(entry: LoadedStickerEntry): string[] {
  return [
    entry.id,
    entry.caption,
    entry.historyLabel,
    ...entry.keywords,
    ...entry.moods,
    ...entry.scenes,
  ]
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function scoreEntry(entry: LoadedStickerEntry, intent: string, tokens: string[]): number {
  if (!intent) return -1;

  const normalizedIntent = normalizeText(intent);
  const terms = collectEntryTerms(entry);
  let score = 0;

  if (normalizeText(entry.id) === normalizedIntent) score += 200;
  if (normalizeText(entry.historyLabel) === normalizedIntent) score += 120;

  for (const term of terms) {
    if (!term) continue;
    if (term === normalizedIntent) {
      score += 80;
      continue;
    }
    if (term.includes(normalizedIntent) || normalizedIntent.includes(term)) {
      score += 24;
    }
  }

  for (const token of tokens) {
    if (!token) continue;
    if (normalizeText(entry.id) === token) {
      score += 80;
      continue;
    }
    if (entry.moods.some((item) => normalizeText(item) === token)) score += 32;
    if (entry.moods.some((item) => normalizeText(item).includes(token) || token.includes(normalizeText(item)))) {
      score += 18;
    }
    if (entry.keywords.some((item) => normalizeText(item) === token)) score += 18;
    if (entry.keywords.some((item) => normalizeText(item).includes(token) || token.includes(normalizeText(item)))) {
      score += 10;
    }
    if (entry.scenes.some((item) => normalizeText(item) === token)) score += 12;
    if (entry.scenes.some((item) => normalizeText(item).includes(token) || token.includes(normalizeText(item)))) {
      score += 8;
    }
    if (normalizeText(entry.caption).includes(token)) score += 10;
    if (normalizeText(entry.historyLabel).includes(token)) score += 10;
  }

  if (score <= 0) return score;
  const catalogConfidenceWeight = 0.5 + Math.min(1, Math.max(0, entry.confidence)) * 0.5;
  return Math.round(score * catalogConfidenceWeight);
}

export function loadStickerCatalog(stickerDir: string): LoadedStickerCatalog | null {
  const catalogPath = resolve(stickerDir, STICKER_CATALOG_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(catalogPath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: StickerCatalogDocument;
  try {
    parsed = JSON.parse(raw) as StickerCatalogDocument;
  } catch {
    return null;
  }

  if (!Array.isArray(parsed?.entries)) return null;

  const entries: LoadedStickerEntry[] = [];
  const byId = new Map<string, LoadedStickerEntry>();
  for (const candidate of parsed.entries) {
    if (!candidate?.id || !candidate?.file) continue;
    const filePath = resolve(stickerDir, candidate.file);
    try {
      const buffer = readFileSync(filePath);
      const entry: LoadedStickerEntry = {
        ...candidate,
        mime: candidate.mime || mimeFromExtension(filePath),
        scopes: Array.isArray(candidate.scopes) && candidate.scopes.length > 0 ? candidate.scopes : ['global'],
        keywords: Array.isArray(candidate.keywords) ? candidate.keywords : [],
        moods: Array.isArray(candidate.moods) ? candidate.moods : [],
        scenes: Array.isArray(candidate.scenes) ? candidate.scenes : [],
        caption: candidate.caption ?? '',
        historyLabel: candidate.historyLabel ?? candidate.id,
        confidence: Number.isFinite(candidate.confidence) ? candidate.confidence : 0.5,
        buffer,
      };
      entries.push(entry);
      byId.set(normalizeText(entry.id), entry);
    } catch {}
  }

  return {
    version: 1,
    generatedAt: parsed.generatedAt ?? '',
    model: parsed.model ?? '',
    entries,
    byId,
  };
}

export function resolveStickerMatches(
  catalog: LoadedStickerCatalog | null,
  intent: string,
  preset?: string | null,
): StickerMatch[] {
  if (!catalog || !intent.trim()) return [];
  const tokens = tokenizeIntent(intent);
  const matches = catalog.entries
    .filter((entry) => matchesScope(entry.scopes, preset))
    .map((entry) => ({
      entry,
      score: scoreEntry(entry, intent, tokens),
    }))
    .filter((match) => match.score >= MIN_STICKER_MATCH_SCORE)
    .sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id));

  return matches;
}

export function resolveStickerSelection(
  catalog: LoadedStickerCatalog | null,
  intent: string,
  preset?: string | null,
  options?: {
    usedIds?: Set<string>;
    maxReuseScoreGap?: number;
    sequenceIndex?: number;
  },
): LoadedStickerEntry | null {
  const matches = resolveStickerMatches(catalog, intent, preset);
  const firstMatch = matches[0];
  if (!firstMatch) return null;

  const usedIds = options?.usedIds;
  if (!usedIds?.size) return firstMatch.entry;
  if (!usedIds.has(normalizeText(firstMatch.entry.id))) return firstMatch.entry;

  const fragments = extractIntentFragments(intent);
  if (fragments.length > 1) {
    const sequenceIndex = Math.max(0, options?.sequenceIndex ?? usedIds.size);
    const orderedFragments = [
      ...fragments.slice(sequenceIndex, sequenceIndex + 1),
      ...fragments.slice(0, sequenceIndex),
      ...fragments.slice(sequenceIndex + 1),
    ].filter(Boolean);

    for (const fragment of orderedFragments) {
      const fragmentMatch = resolveStickerMatches(catalog, fragment, preset).find(
        (match) => !usedIds.has(normalizeText(match.entry.id)),
      );
      if (fragmentMatch) {
        return fragmentMatch.entry;
      }
    }
  }

  const alternative = matches.find((match) => !usedIds.has(normalizeText(match.entry.id)));
  if (!alternative) return firstMatch.entry;

  const maxReuseScoreGap = options?.maxReuseScoreGap ?? 40;
  return firstMatch.score - alternative.score <= maxReuseScoreGap ? alternative.entry : firstMatch.entry;
}

export function createStickerHistoryLine(entry: LoadedStickerEntry): string {
  return `（发送表情包：${entry.historyLabel || entry.id}）`;
}
