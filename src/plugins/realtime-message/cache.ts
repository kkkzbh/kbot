import { resolveSessionDisplayName } from '../shared/session/index.js';
import { buildGroupSessionScopeKey } from '../shared/group-id.js';
import type {
  RealtimeMessageEntry,
  RealtimeMessageEntryKind,
  RealtimeMessageModality,
  RealtimeMessageQuery,
  RealtimeMessageSessionLike,
} from './types.js';

const DEFAULT_MAX_GROUPS = 128;
const DEFAULT_MAX_MESSAGES_PER_GROUP = 64;

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMessageId(value: unknown): string | null {
  const normalized = normalizeText(value);
  return normalized || null;
}

function normalizeImageUrl(value: unknown): string | null {
  const normalized = normalizeText(value);
  return normalized || null;
}

function normalizeVoiceTranscript(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export class RealtimeMessageCache {
  private readonly buckets = new Map<string, RealtimeMessageEntry[]>();

  constructor(
    private readonly maxGroups = DEFAULT_MAX_GROUPS,
    private readonly maxMessagesPerGroup = DEFAULT_MAX_MESSAGES_PER_GROUP,
  ) {}

  append(groupScopeKey: string, entry: RealtimeMessageEntry): void {
    const normalizedKey = groupScopeKey.trim();
    if (!normalizedKey) return;

    const existing = this.buckets.get(normalizedKey) ?? [];
    const nextEntries = [...existing, entry];
    if (nextEntries.length > this.maxMessagesPerGroup) {
      nextEntries.splice(0, nextEntries.length - this.maxMessagesPerGroup);
    }

    this.buckets.delete(normalizedKey);
    this.buckets.set(normalizedKey, nextEntries);

    while (this.buckets.size > this.maxGroups) {
      const oldestKey = this.buckets.keys().next().value;
      if (!oldestKey) break;
      this.buckets.delete(oldestKey);
    }
  }

  get(groupScopeKey: string): RealtimeMessageEntry[] {
    const normalizedKey = groupScopeKey.trim();
    if (!normalizedKey) return [];

    const bucket = this.buckets.get(normalizedKey);
    if (!bucket?.length) return [];

    this.buckets.delete(normalizedKey);
    this.buckets.set(normalizedKey, bucket);
    return [...bucket];
  }

  clearGroup(groupScopeKey: string): void {
    const normalizedKey = groupScopeKey.trim();
    if (!normalizedKey) return;
    this.buckets.delete(normalizedKey);
  }

  discardSession(groupScopeKey: string, session: RealtimeMessageSessionLike): boolean {
    const normalizedKey = groupScopeKey.trim();
    if (!normalizedKey) return false;
    const existing = this.buckets.get(normalizedKey);
    if (!existing?.length) return false;

    const remaining = existing.filter((entry) => !isRealtimeEntryFromSession(entry, session));
    if (remaining.length === existing.length) return false;
    if (remaining.length > 0) {
      this.buckets.set(normalizedKey, remaining);
    } else {
      this.buckets.delete(normalizedKey);
    }
    return true;
  }

  clear(): void {
    this.buckets.clear();
  }
}

export const realtimeMessageCache = new RealtimeMessageCache();

export function buildGroupScopeKey(session: RealtimeMessageSessionLike): string | null {
  return buildGroupSessionScopeKey(session);
}

export function discardRealtimeMessageForSession(session: RealtimeMessageSessionLike): boolean {
  const groupScopeKey = buildGroupScopeKey(session);
  return groupScopeKey ? realtimeMessageCache.discardSession(groupScopeKey, session) : false;
}

function sanitizeContextText(text: string): string {
  return text
    .replace(/\[CQ:reply,[^\]]+\]/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/\[CQ:image,[^\]]+\]/gi, ' ')
    .replace(/<audio\b[^>]*\/?>/gi, ' ')
    .replace(/\[CQ:record,[^\]]+\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeMessageText(session: RealtimeMessageSessionLike): string {
  const stripped = typeof session.stripped?.content === 'string' ? sanitizeContextText(session.stripped.content) : '';
  if (stripped) return stripped;
  return typeof session.content === 'string' ? sanitizeContextText(session.content) : '';
}

function extractImageUrlsFromElements(session: RealtimeMessageSessionLike): string[] {
  const elements = Array.isArray(session.elements) ? session.elements : [];
  return dedupeStrings(
    elements
      .map((element) => {
        const typedElement =
          element && typeof element === 'object'
            ? (element as { type?: unknown; attrs?: Record<string, unknown> })
            : null;
        const type = normalizeText(typedElement?.type).toLowerCase();
        if (type !== 'img' && type !== 'image') return null;

        const attrs = typedElement?.attrs ?? {};
        return normalizeImageUrl(attrs.imageUrl) ?? normalizeImageUrl(attrs.url) ?? normalizeImageUrl(attrs.src);
      })
      .filter((value): value is string => Boolean(value)),
  );
}

function extractImageUrlsFromRawContent(rawContent: string): string[] {
  const urls = [
    ...rawContent.matchAll(/<img\b[^>]*\bsrc=(["'])(.*?)\1/gi),
  ].map((match) => match[2]?.trim() ?? '');

  for (const match of rawContent.matchAll(/\[CQ:image,([^\]]+)\]/gi)) {
    const attrs = match[1] ?? '';
    const resolved =
      attrs.match(/(?:^|,)url=([^,\]]+)/i)?.[1] ??
      attrs.match(/(?:^|,)src=([^,\]]+)/i)?.[1] ??
      attrs.match(/(?:^|,)file=(base64:\/\/[^,\]]+)/i)?.[1] ??
      attrs.match(/(?:^|,)file=(data:image[^,\]]+)/i)?.[1];
    if (resolved?.trim()) {
      urls.push(resolved.trim());
    }
  }

  return dedupeStrings(urls);
}

export function collectImageUrls(session: RealtimeMessageSessionLike): string[] {
  const elementUrls = extractImageUrlsFromElements(session);
  if (elementUrls.length > 0) return elementUrls;

  const rawContent = typeof session.content === 'string' ? session.content : '';
  if (!rawContent) return [];
  return extractImageUrlsFromRawContent(rawContent);
}

export function buildSessionSnapshot(session: RealtimeMessageSessionLike): RealtimeMessageSessionLike {
  return {
    platform: session.platform,
    bot: session.bot,
    guildId: session.guildId,
    channelId: session.channelId,
    userId: session.userId,
    isDirect: session.isDirect,
    messageId: session.messageId,
    content: session.content,
    stripped: session.stripped ? { content: session.stripped.content } : undefined,
    elements: Array.isArray(session.elements) ? [...session.elements] : undefined,
    author: session.author
      ? {
          ...(typeof session.author.nick === 'string' ? { nick: session.author.nick } : {}),
          ...(typeof session.author.name === 'string' ? { name: session.author.name } : {}),
        }
      : undefined,
    username: session.username,
  };
}

export function resolveSpeakerName(session: RealtimeMessageSessionLike, userId: string): string {
  return resolveSessionDisplayName({
    author: session.author
      ? {
          ...(typeof session.author.nick === 'string' ? { nick: session.author.nick } : {}),
          ...(typeof session.author.name === 'string' ? { name: session.author.name } : {}),
        }
      : undefined,
    username: typeof session.username === 'string' ? session.username : undefined,
    userId,
  });
}

export function buildRealtimeModalities(args: {
  text: string;
  imageUrls: string[];
  voiceTranscript?: string | null;
}): RealtimeMessageModality[] {
  const modalities: RealtimeMessageModality[] = [];
  if (args.text.trim()) modalities.push('text');
  if (args.imageUrls.length > 0) modalities.push('image');
  if (normalizeVoiceTranscript(args.voiceTranscript).length > 0) modalities.push('voice');
  return modalities;
}

export function resolveSessionVoiceTranscript(session: RealtimeMessageSessionLike): string {
  return normalizeVoiceTranscript(session.state?.qqVoice?.transcript);
}

export function buildRealtimeEntryKind(entry: RealtimeMessageEntry): RealtimeMessageEntryKind {
  if (entry.modalities.length === 1) {
    return entry.modalities[0];
  }
  return 'mixed';
}

export function parseFlexibleTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') return null;

  const normalized = value.trim();
  if (!normalized) return null;

  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildRealtimeSearchText(entry: RealtimeMessageEntry): string {
  return [
    entry.speakerName,
    entry.userId,
    entry.text,
    entry.voiceTranscript ?? '',
    ...entry.imageUrls,
  ]
    .join('\n')
    .toLowerCase();
}

export function isRealtimeEntryFromSession(
  entry: RealtimeMessageEntry,
  session: RealtimeMessageSessionLike,
): boolean {
  const messageId = normalizeMessageId(session.messageId);
  if (messageId) {
    return entry.messageId === messageId;
  }

  const userId = normalizeText(session.userId);
  if (!userId || entry.userId !== userId) return false;
  if (entry.text !== normalizeMessageText(session)) return false;
  if ((entry.voiceTranscript ?? '') !== resolveSessionVoiceTranscript(session)) return false;
  return arraysEqual(entry.imageUrls, collectImageUrls(session));
}

export function selectRealtimeMessageWindow(
  entries: RealtimeMessageEntry[],
  session: RealtimeMessageSessionLike,
  limit: number,
): RealtimeMessageEntry[] {
  const cappedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 12;
  const filtered = entries.filter((entry) => !isRealtimeEntryFromSession(entry, session));
  return filtered.slice(Math.max(0, filtered.length - cappedLimit));
}

export function queryRealtimeMessageEntries(
  entries: RealtimeMessageEntry[],
  query: RealtimeMessageQuery,
): { total: number; items: RealtimeMessageEntry[] } {
  const speakerIds = dedupeStrings(query.speakerIds ?? []);
  const keyword = normalizeText(query.keyword).toLowerCase();
  const since = query.since ?? null;
  const until = query.until ?? null;

  const filtered = entries.filter((entry) => {
    if (speakerIds.length > 0 && !speakerIds.includes(entry.userId)) {
      return false;
    }
    if (keyword && !buildRealtimeSearchText(entry).includes(keyword)) {
      return false;
    }
    if (since != null && entry.capturedAt < since) {
      return false;
    }
    if (until != null && entry.capturedAt > until) {
      return false;
    }
    if (query.modality !== 'any' && buildRealtimeEntryKind(entry) !== query.modality) {
      return false;
    }
    return true;
  });

  const ordered = query.order === 'latest_first' ? [...filtered].reverse() : filtered;
  const offset = Math.max(0, Math.floor(query.offset));
  const limit = Math.max(1, Math.floor(query.limit));

  return {
    total: filtered.length,
    items: ordered.slice(offset, offset + limit),
  };
}
