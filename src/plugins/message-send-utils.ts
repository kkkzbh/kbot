import type { Session, Universal } from 'koishi';

const MIN_SMART_SEND_DELAY_MS = 1000;
const MAX_SMART_SEND_DELAY_MS = 4000;
const bypassSplitOptions = new WeakSet<Universal.SendOptions>();
const LEAKED_REASONING_LINE_PATTERN =
  /(根据(?:之前|以上|当前)?的?对话|根据我的身份设定|用户(?:让我|让我去|让我搜|只说|曾(?:经)?|问|想|没有|没说)|我(?:需要|得|先|要|应该)(?:确认|判断|看看|先确认|以角色身份自然回应)|没有指定(?:具体)?(?:搜索)?内容|确认用户想让|搜索什么具体内容|不应该有特殊的技术能力|搜索工具(?:似乎|好像)?(?:不可用|有问题|出问题))/;
const LEAKED_REASONING_MARKER_PATTERN =
  /(用户让我搜索|根据我的身份设定|我应该以角色身份|我需要确认|搜索工具似乎不可用|不应该有特殊的技术能力|工具好像又出问题了)/g;
const LEAKED_REASONING_START_PATTERN =
  /^(?:用户(?:让我|要我|叫我|希望我)|根据(?:之前|以上|当前)?的?对话|根据我的身份设定|我(?:需要|得|要|应该))/;
const SEARCH_INTENT_HINT_PATTERN = /(搜|搜索|web_search|联网|查一下|查一查)/i;

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

export function looksLikeLeakedReasoningLine(line: string): boolean {
  const text = line.trim();
  if (text.length < 20) return false;
  return LEAKED_REASONING_LINE_PATTERN.test(text);
}

export function dropLeadingLeakedReasoningLines(lines: string[]): string[] {
  let index = 0;
  while (lines.length - index > 1 && looksLikeLeakedReasoningLine(lines[index])) {
    index += 1;
  }
  return index > 0 ? lines.slice(index) : lines;
}

function splitBySentence(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  return normalized.match(/[^。！？!?]+[。！？!?]?/g)?.map((item) => item.trim()).filter(Boolean) ?? [normalized];
}

function stripLeakedReasoningFromLine(line: string): string {
  const segments = splitBySentence(line);
  if (!segments.length) return '';
  const filtered = segments.filter((segment) => !LEAKED_REASONING_LINE_PATTERN.test(segment));
  return filtered.join('').trim();
}

export function sanitizeLeakedReasoningMessage(message: string): string {
  const normalized = message.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return normalized;

  const markerCount = (normalized.match(LEAKED_REASONING_MARKER_PATTERN) ?? []).length;
  const startsLikeLeak = LEAKED_REASONING_START_PATTERN.test(normalized);
  const likelyLeak = startsLikeLeak || markerCount >= 2;
  if (!likelyLeak) return normalized;

  const strippedLines = dropLeadingLeakedReasoningLines(splitMessageByLines(normalized))
    .map((line) => stripLeakedReasoningFromLine(line))
    .filter(Boolean);

  if (strippedLines.length) return strippedLines.join('\n');

  return SEARCH_INTENT_HINT_PATTERN.test(normalized)
    ? '你想让我搜什么具体内容呢？'
    : '你再具体说一下，我好准确回复你';
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
