import type { Session, Universal } from 'koishi';

const MIN_SMART_SEND_DELAY_MS = 1000;
const MAX_SMART_SEND_DELAY_MS = 4000;
const bypassSplitOptions = new WeakSet<Universal.SendOptions>();

type AsyncTask<T> = () => Promise<T>;

export interface KeyedStrandRunner {
  run<T>(key: string, task: AsyncTask<T>): Promise<T>;
}

export type SessionStrandLike = {
  platform?: string;
  isDirect?: boolean;
  channelId?: string;
  guildId?: string;
  userId?: string;
  bot?: {
    selfId?: string;
  };
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createKeyedStrandRunner(): KeyedStrandRunner {
  const tails = new Map<string, Promise<void>>();

  return {
    async run<T>(key: string, task: AsyncTask<T>): Promise<T> {
      const tail = tails.get(key);
      const previous = tail ? tail.catch(() => undefined) : Promise.resolve();
      let releaseCurrent: () => void = () => {};
      const current = new Promise<void>((resolve) => {
        releaseCurrent = () => resolve();
      });
      const nextTail = previous.then(() => current);
      tails.set(key, nextTail);

      await previous;

      try {
        return await task();
      } finally {
        releaseCurrent();
        if (tails.get(key) === nextTail) {
          tails.delete(key);
        }
      }
    },
  };
}

function resolveSessionStrandScope(session: SessionStrandLike): string | null {
  if (session.isDirect) {
    const privateId = session.channelId?.trim() || session.userId?.trim();
    return privateId ? `private:${privateId}` : null;
  }

  const groupId = session.channelId?.trim() || session.guildId?.trim();
  if (groupId) return `group:${groupId}`;

  const fallbackPrivateId = session.userId?.trim();
  return fallbackPrivateId ? `private:${fallbackPrivateId}` : null;
}

export function resolveSessionStrandKey(session: SessionStrandLike): string | null {
  const platform = session.platform?.trim();
  if (!platform) return null;

  const botSelfId = session.bot?.selfId?.trim() || 'default-bot';
  const scope = resolveSessionStrandScope(session);
  if (!scope) return null;

  return `${platform}:${botSelfId}:${scope}`;
}

export function createBypassLineSplitOptions(session?: Session): Universal.SendOptions {
  const options: Universal.SendOptions = session ? { session } : {};
  bypassSplitOptions.add(options);
  return options;
}

export function shouldBypassLineSplit(options: Universal.SendOptions): boolean {
  return bypassSplitOptions.has(options);
}

export function splitMessageByLines(message: string): string[] {
  const normalized = message.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length) return lines;
  const fallback = message.trim();
  return fallback ? [fallback] : [];
}

export function calculateSmartSendDelayMs(line: string): number {
  const text = line.trim();
  if (!text) return MIN_SMART_SEND_DELAY_MS;

  const cjkCount = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const alphaNumCount = (text.match(/[A-Za-z0-9]/g) ?? []).length;
  const nonSpaceCount = text.replace(/\s+/g, '').length;
  const symbolCount = Math.max(0, nonSpaceCount - cjkCount - alphaNumCount);
  const punctuationCount = (text.match(/[，。！？；：,.!?;:]/g) ?? []).length;

  const weightedLength = cjkCount + alphaNumCount * 0.6 + symbolCount * 0.8;
  const estimate = Math.round(900 + weightedLength * 55 + punctuationCount * 180);
  return clamp(estimate, MIN_SMART_SEND_DELAY_MS, MAX_SMART_SEND_DELAY_MS);
}

export async function sendByLinesWithSmartInterval(
  message: string,
  sendLine: (line: string) => Promise<unknown>,
): Promise<void> {
  const lines = splitMessageByLines(message);
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) {
      const delayMs = calculateSmartSendDelayMs(lines[index - 1]);
      await sleep(delayMs);
    }
    await sendLine(lines[index]);
  }
}
