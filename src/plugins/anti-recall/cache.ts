import type { Session } from 'koishi';

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_RETENTION_MS = 12 * 60 * 60 * 1_000;

export interface AntiRecallMessageEntry {
  key: string;
  userId: string;
  content: string;
  capturedAt: number;
}

type AntiRecallSession = Pick<Session, 'platform' | 'channelId' | 'messageId' | 'userId'> & {
  bot?: { selfId?: string | null };
  content?: string;
};

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function buildAntiRecallMessageKey(session: AntiRecallSession): string | null {
  const platform = normalizeText(session.platform);
  const selfId = normalizeText(session.bot?.selfId);
  const channelId = normalizeText(session.channelId);
  const messageId = normalizeText(session.messageId);
  if (!platform || !selfId || !channelId || !messageId) return null;
  return `${platform}:${selfId}:${channelId}:${messageId}`;
}

export class AntiRecallMessageCache {
  private readonly entries = new Map<string, AntiRecallMessageEntry>();

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly retentionMs = DEFAULT_RETENTION_MS,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('anti-recall cache maxEntries must be a positive integer.');
    }
    if (!Number.isFinite(retentionMs) || retentionMs < 1) {
      throw new Error('anti-recall cache retentionMs must be positive.');
    }
  }

  capture(session: AntiRecallSession): boolean {
    const key = buildAntiRecallMessageKey(session);
    const userId = normalizeText(session.userId);
    const content = typeof session.content === 'string' ? session.content : '';
    if (!key || !userId || !content || userId === normalizeText(session.bot?.selfId)) return false;

    const capturedAt = this.now();
    this.prune(capturedAt);
    this.entries.delete(key);
    this.entries.set(key, { key, userId, content, capturedAt });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      this.entries.delete(oldestKey);
    }
    return true;
  }

  find(session: AntiRecallSession): AntiRecallMessageEntry | null {
    const key = buildAntiRecallMessageKey(session);
    if (!key) return null;
    const now = this.now();
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (now - entry.capturedAt > this.retentionMs) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.capturedAt <= this.retentionMs) break;
      this.entries.delete(key);
    }
  }
}
