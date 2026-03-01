export const DEFAULT_TRIGGER_ALIASES = ['祥子', '祥', '丰川', '丰川祥子', 'saki', 'saki酱', 'sakiko'];

const ASK_VERB_PATTERN = /(帮我|给我|请问|麻烦|告诉我|解释|总结|翻译|写|算|分析|推荐|建议|看看|查一下|答一下)/i;
const QUESTION_PATTERN = /[?？]|(吗|么|呢|咋|如何|为什么|怎么|啥|什么|几|哪|可不可以|能不能)/;
const SECOND_PERSON_PATTERN = /(你|你能|你会|你可以|机器人|bot|qbot)/i;

export interface SpamState {
  timestamps: number[];
  mutedUntil: number;
}

export interface SpamPolicy {
  windowMs: number;
  threshold: number;
  muteMs: number;
}

export interface SpamRecordResult {
  state: SpamState;
  muted: boolean;
  justMuted: boolean;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
}

function isAsciiAlias(value: string): boolean {
  return /^[a-zA-Z0-9_\- ]+$/.test(value);
}

export function parseAliasList(value?: string[] | string): string[] {
  const raw = Array.isArray(value) ? value : value?.split(',') ?? [];
  const normalized = raw
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.toLowerCase());

  const unique = new Set<string>();
  for (const item of normalized) unique.add(item);
  if (!unique.size) {
    for (const item of DEFAULT_TRIGGER_ALIASES) unique.add(item.toLowerCase());
  }
  return [...unique];
}

export function containsAlias(content: string, aliases: string[]): boolean {
  const text = content.trim().toLowerCase();
  if (!text) return false;

  for (const alias of aliases) {
    if (!alias) continue;
    if (isAsciiAlias(alias)) {
      const reg = new RegExp(`(^|[^a-zA-Z0-9])${escapeRegex(alias)}([^a-zA-Z0-9]|$)`, 'i');
      if (reg.test(text)) return true;
      continue;
    }
    if (text.includes(alias)) return true;
  }
  return false;
}

export function shouldTriggerByRule(content: string, aliases: string[], quotedToBot: boolean): boolean {
  const text = content.trim();
  if (!text) return false;
  if (quotedToBot) return true;
  if (containsAlias(text, aliases)) return true;

  const hasAskVerb = ASK_VERB_PATTERN.test(text);
  const hasQuestion = QUESTION_PATTERN.test(text);
  const hasSecondPerson = SECOND_PERSON_PATTERN.test(text);

  if (hasAskVerb && (hasQuestion || hasSecondPerson)) return true;
  if (hasQuestion && hasSecondPerson) return true;
  if (/^(请|麻烦|帮我|给我|告诉我|解释|总结|翻译|写|算|查一下)/.test(text)) return true;

  return false;
}

export function createEmptySpamState(): SpamState {
  return { timestamps: [], mutedUntil: 0 };
}

export function recordSpamMessage(state: SpamState, now: number, policy: SpamPolicy): SpamRecordResult {
  if (now < state.mutedUntil) {
    return { state, muted: true, justMuted: false };
  }

  const nextTimestamps = state.timestamps.filter((ts) => now - ts <= policy.windowMs);
  nextTimestamps.push(now);

  if (nextTimestamps.length >= policy.threshold) {
    const mutedState: SpamState = {
      timestamps: [],
      mutedUntil: now + policy.muteMs,
    };
    return { state: mutedState, muted: true, justMuted: true };
  }

  return {
    state: {
      timestamps: nextTimestamps,
      mutedUntil: state.mutedUntil,
    },
    muted: false,
    justMuted: false,
  };
}
