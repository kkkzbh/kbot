export type IntentAction = 'create-once' | 'create-cron' | 'list' | 'delete' | 'pause' | 'resume';

export interface AutomationIntent {
  action: IntentAction;
  confidence: number;
  runAt?: number;
  cronExpr?: string;
  message?: string;
  taskId?: number;
}

const MANAGEMENT_PATTERNS = {
  list: /(?:任务.*(?:列表|清单|有哪些|查看|查询)|(?:查看|查询).{0,8}任务|我的任务)/,
  delete: /(?:删除|取消|移除)[^\d]{0,8}(?:任务|提醒|定时)?\s*#?\s*(\d+)/,
  pause: /(?:暂停|停止|关闭)[^\d]{0,8}(?:任务|提醒|定时)?\s*#?\s*(\d+)/,
  resume: /(?:恢复|继续|开启|重启)[^\d]{0,8}(?:任务|提醒|定时)?\s*#?\s*(\d+)/,
};

const ABSOLUTE_DATE_PATTERN = /(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/;
const RELATIVE_DAY_PATTERN = /(今天|明天|后天|今晚)/;
const RELATIVE_OFFSET_PATTERN = /(\d+)\s*(秒钟|秒|s|sec|分钟|分|min|mins|小时|h|hr|hrs|天|d)\s*(?:后|以后|之后)/i;
const NAMED_RELATIVE_OFFSET_PATTERNS: Array<{ pattern: RegExp; deltaMs: number }> = [
  { pattern: /半(?:个)?小时(?:后|以后|之后)/, deltaMs: 30 * 60 * 1000 },
  { pattern: /一刻钟(?:后|以后|之后)/, deltaMs: 15 * 60 * 1000 },
  { pattern: /两刻钟(?:后|以后|之后)/, deltaMs: 30 * 60 * 1000 },
  { pattern: /半天(?:后|以后|之后)/, deltaMs: 12 * 60 * 60 * 1000 },
];
const CLOCK_TIME_PATTERN = /(?:凌晨|早上|上午|中午|下午|晚上)?\s*\d{1,2}\s*(?::|点|时)\s*(?:\d{1,2}|半)?/;
const CREATE_ACTION_HINT = /(提醒我|提醒|通知我|叫我|闹钟|定时|任务|计划|给我发|发我|发条|发一条|发个|告诉我|打招呼|喊我)/i;

const WEEKDAY_MAP: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

const FIXED_TIMEZONE = 'Asia/Shanghai';
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;
const COMPLEX_REASONER_HINT =
  /(分析|推理|证明|解释|归纳|总结|比较|方案|计划|提纲|润色|改写|翻译|算法|代码|脚本|sql|正则|多步骤|详细)/i;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clampHour(raw: number): number {
  return Math.min(23, Math.max(0, raw));
}

function clampMinute(raw: number): number {
  return Math.min(59, Math.max(0, raw));
}

function parseMinuteToken(raw: string | undefined): number {
  if (!raw) return 0;
  if (raw === '半') return 30;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return clampMinute(value);
}

function normalizeHour(period: string | undefined, hour: number): number {
  const h = clampHour(hour);
  if (!period) return h;
  if ((period === '下午' || period === '晚上') && h < 12) return h + 12;
  if (period === '中午' && h < 11) return h + 12;
  if (period === '凌晨' && h === 12) return 0;
  return h;
}

function buildLocalDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  return Date.UTC(year, month - 1, day, hour, minute, 0, 0) - UTC8_OFFSET_MS;
}

function addUtc8Days(ts: number, dayOffset: number): number {
  const d = new Date(ts + UTC8_OFFSET_MS);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d.getTime() - UTC8_OFFSET_MS;
}

function setUtc8Clock(ts: number, hour: number, minute: number): number {
  const d = new Date(ts + UTC8_OFFSET_MS);
  d.setUTCHours(hour, minute, 0, 0);
  return d.getTime() - UTC8_OFFSET_MS;
}

function parseAbsoluteTime(text: string): number | null {
  const m = text.match(
    /(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})(?:日)?(?:\s+|T)?(?:(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})(?:[:点时](\d{1,2}|半))?)?/,
  );
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hourRaw = m[5] ? Number(m[5]) : 9;
  const minuteRaw = parseMinuteToken(m[6]);
  const hour = normalizeHour(m[4], hourRaw);
  const minute = clampMinute(minuteRaw);
  return buildLocalDate(year, month, day, hour, minute);
}

function parseRelativeOffsetTime(text: string, now: number): number | null {
  const m = text.match(RELATIVE_OFFSET_PATTERN);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = m[2].toLowerCase();
  let deltaMs = 0;
  if (unit === '天' || unit === 'd') deltaMs = value * 24 * 60 * 60 * 1000;
  else if (unit === '小时' || unit === 'h' || unit === 'hr' || unit === 'hrs') deltaMs = value * 60 * 60 * 1000;
  else if (unit === '秒' || unit === '秒钟' || unit === 's' || unit === 'sec') {
    deltaMs = value * 1000;
  } else deltaMs = value * 60 * 1000;
  return now + deltaMs;
}

function parseNamedRelativeOffsetTime(text: string, now: number): number | null {
  const hit = NAMED_RELATIVE_OFFSET_PATTERNS.find((item) => item.pattern.test(text));
  if (!hit) return null;
  return now + hit.deltaMs;
}

function parseRelativeDayTime(text: string, now: number): number | null {
  const m = text.match(
    /(今天|明天|后天|今晚)(?:\s*(凌晨|早上|上午|中午|下午|晚上))?\s*(\d{1,2})?(?:[:点时](\d{1,2}|半))?/,
  );
  if (!m) return null;

  const dayHint = m[1];
  const period = m[2];
  const hourRaw = m[3] ? Number(m[3]) : dayHint === '今晚' ? 20 : 9;
  const minuteRaw = parseMinuteToken(m[4]);
  const hour = normalizeHour(period, hourRaw);
  const minute = clampMinute(minuteRaw);

  const dayOffset = dayHint === '明天' ? 1 : dayHint === '后天' ? 2 : 0;
  let target = addUtc8Days(now, dayOffset);
  target = setUtc8Clock(target, hour, minute);

  if (target <= now && (dayHint === '今天' || dayHint === '今晚')) {
    target = addUtc8Days(target, 1);
  }
  return target;
}

function parseFallbackClockTime(text: string, now: number): number | null {
  const m = text.match(/(?:凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})\s*(?::|点|时)\s*(\d{1,2}|半)?/);
  if (!m) return null;
  const periodMatch = text.match(/(凌晨|早上|上午|中午|下午|晚上)/);
  const hour = normalizeHour(periodMatch?.[1], Number(m[1]));
  const minute = parseMinuteToken(m[2]);

  let target = setUtc8Clock(now, hour, minute);
  if (target <= now) {
    target = addUtc8Days(target, 1);
  }
  return target;
}

export function parseOnceRunAt(text: string, now = Date.now()): number | null {
  return (
    parseAbsoluteTime(text) ??
    parseRelativeOffsetTime(text, now) ??
    parseNamedRelativeOffsetTime(text, now) ??
    parseRelativeDayTime(text, now) ??
    parseFallbackClockTime(text, now)
  );
}

export function formatAutomationTimestamp(ts: number): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: FIXED_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts));

  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  return `${lookup.get('year')}-${lookup.get('month')}-${lookup.get('day')} ${lookup.get('hour')}:${lookup.get('minute')}`;
}

type Utc8DateParts = {
  year: number;
  month: number;
  day: number;
  hour: string;
  minute: string;
};

function getUtc8DateParts(ts: number): Utc8DateParts {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: FIXED_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts));

  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(lookup.get('year') || 0),
    month: Number(lookup.get('month') || 0),
    day: Number(lookup.get('day') || 0),
    hour: lookup.get('hour') || '00',
    minute: lookup.get('minute') || '00',
  };
}

function getUtc8DayIndex(parts: Utc8DateParts): number {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / (24 * 60 * 60 * 1000));
}

export function formatNaturalRunAtText(runAt: number, now = Date.now()): string {
  const target = getUtc8DateParts(runAt);
  const base = getUtc8DateParts(now);
  const hhmm = `${target.hour}:${target.minute}`;
  const dayDiff = getUtc8DayIndex(target) - getUtc8DayIndex(base);

  if (dayDiff === 0) return hhmm;
  if (dayDiff === 1) return `明天${hhmm}`;
  if (dayDiff === 2) return `后天${hhmm}`;
  if (target.year === base.year) return `${target.month}月${target.day}日 ${hhmm}`;
  return `${target.year}-${target.month}-${target.day} ${hhmm}`;
}

export function shouldPreferReasonerForTaskMessage(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (text.length >= 48) return true;
  if (/[\n\r]/.test(text)) return true;
  if (COMPLEX_REASONER_HINT.test(text)) return true;
  return false;
}

export function selectDeliveryModelForTaskMessage(
  message: string,
  deliveryModel: string,
  fastModel = 'deepseek-chat',
): string {
  const complex = shouldPreferReasonerForTaskMessage(message);
  const normalized = deliveryModel.trim().toLowerCase();
  const isReasoner = normalized.includes('reasoner') || normalized.includes('r1');
  if (complex) return deliveryModel;
  return isReasoner ? fastModel : deliveryModel;
}

function parseDailyCron(text: string): string | null {
  const m = text.match(/每(?:天|日)(?:\s*(凌晨|早上|上午|中午|下午|晚上))?\s*(\d{1,2})(?:[:点时](\d{1,2}|半))?/);
  if (!m) return null;
  const hour = normalizeHour(m[1], Number(m[2]));
  const minute = parseMinuteToken(m[3]);
  return `${minute} ${hour} * * *`;
}

function parseWeeklyCron(text: string): string | null {
  const m = text.match(
    /每(?:周|星期)\s*([一二三四五六日天])(?:\s*(凌晨|早上|上午|中午|下午|晚上))?\s*(\d{1,2})(?:[:点时](\d{1,2}|半))?/,
  );
  if (!m) return null;
  const weekday = WEEKDAY_MAP[m[1]];
  if (weekday === undefined) return null;
  const hour = normalizeHour(m[2], Number(m[3]));
  const minute = parseMinuteToken(m[4]);
  return `${minute} ${hour} * * ${weekday}`;
}

function parseMonthlyCron(text: string): string | null {
  const m = text.match(
    /每月\s*(\d{1,2})[号日]?(?:\s*(凌晨|早上|上午|中午|下午|晚上))?\s*(\d{1,2})(?:[:点时](\d{1,2}|半))?/,
  );
  if (!m) return null;
  const day = Number(m[1]);
  if (day < 1 || day > 31) return null;
  const hour = normalizeHour(m[2], Number(m[3]));
  const minute = parseMinuteToken(m[4]);
  return `${minute} ${hour} ${day} * *`;
}

function parseIntervalCron(text: string): string | null {
  const m = text.match(/每隔\s*(\d+)\s*(分钟|小时|天)/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  if (m[2] === '分钟') {
    if (value > 59) return null;
    return `*/${value} * * * *`;
  }
  if (m[2] === '小时') {
    if (value > 23) return null;
    return `0 */${value} * * *`;
  }
  if (value > 31) return null;
  return `0 9 */${value} * *`;
}

export function parseCronExpr(text: string): string | null {
  return parseWeeklyCron(text) ?? parseDailyCron(text) ?? parseMonthlyCron(text) ?? parseIntervalCron(text);
}

export function isValidCronExpr(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field) => /^[\d*/,\-]+$/.test(field));
}

function extractReminderMessage(text: string): string {
  const extractors: Array<{ pattern: RegExp; map?: (value: string) => string }> = [
    { pattern: /(?:提醒我|提醒|通知我|叫我)\s*(.*)$/ },
    { pattern: /给我\s*(.*)$/ },
    { pattern: /发我\s*(.*)$/, map: (value) => `发${value}` },
    { pattern: /告诉我\s*(.*)$/ },
    { pattern: /(打招呼.*)$/ },
    { pattern: /(?:定时任务|任务|计划)\s*(.*)$/ },
    { pattern: /(?:定时|闹钟)\s*(.*)$/ },
  ];

  let candidate = text;
  for (const extractor of extractors) {
    const matched = text.match(extractor.pattern);
    const body = matched?.[1]?.trim();
    if (!body) continue;
    candidate = extractor.map ? extractor.map(body) : body;
    break;
  }

  const removable = [
    /(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})日?/g,
    /(今天|明天|后天|今晚)/g,
    /每(?:周|星期)[一二三四五六日天]/g,
    /每(?:天|日)/g,
    /每月\d{1,2}[号日]?/g,
    /每隔\d+(?:分钟|小时|天)/g,
    /\d+\s*(?:秒钟|秒|s|sec|min|mins|分钟|分|小时|h|hr|hrs|天|d)\s*(?:后|以后|之后)/gi,
    /半(?:个)?小时(?:后|以后|之后)/g,
    /[一两]刻钟(?:后|以后|之后)/g,
    /半天(?:后|以后|之后)/g,
    /(凌晨|早上|上午|中午|下午|晚上)?\s*\d{1,2}\s*(?::|点|时)\s*(?:\d{1,2}|半)?/g,
    /(提醒我|提醒|通知我|叫我|创建|设置|新增|任务|计划|定时|闹钟|给我发|发我|告诉我|到时候|时候)/g,
    /[\s,，。.!！?？]+/g,
  ];

  for (const pattern of removable) {
    candidate = candidate.replace(pattern, ' ');
  }

  const normalized = normalizeWhitespace(candidate)
    .replace(/^(给我|请|请你|麻烦|麻烦你|帮我|帮忙|你在|在|于|到|的时候|时候)+/, '')
    .replace(/(的时候|时候)$/, '')
    .trim();
  return normalized || '定时提醒';
}

function parseManagementIntent(text: string): AutomationIntent | null {
  if (MANAGEMENT_PATTERNS.list.test(text)) {
    return { action: 'list', confidence: 0.98 };
  }

  const deleteMatch = text.match(MANAGEMENT_PATTERNS.delete);
  if (deleteMatch) {
    return { action: 'delete', taskId: Number(deleteMatch[1]), confidence: 0.98 };
  }

  const pauseMatch = text.match(MANAGEMENT_PATTERNS.pause);
  if (pauseMatch) {
    return { action: 'pause', taskId: Number(pauseMatch[1]), confidence: 0.98 };
  }

  const resumeMatch = text.match(MANAGEMENT_PATTERNS.resume);
  if (resumeMatch) {
    return { action: 'resume', taskId: Number(resumeMatch[1]), confidence: 0.98 };
  }

  return null;
}

function hasTimeSignal(content: string): boolean {
  return (
    ABSOLUTE_DATE_PATTERN.test(content) ||
    RELATIVE_DAY_PATTERN.test(content) ||
    RELATIVE_OFFSET_PATTERN.test(content) ||
    NAMED_RELATIVE_OFFSET_PATTERNS.some((item) => item.pattern.test(content)) ||
    CLOCK_TIME_PATTERN.test(content)
  );
}

export function shouldTryAutomationIntent(text: string): boolean {
  const content = normalizeWhitespace(text);
  if (!content) return false;
  return hasTimeSignal(content) || Boolean(parseCronExpr(content));
}

export function parseAutomationIntentByRule(text: string, now = Date.now()): AutomationIntent | null {
  const content = normalizeWhitespace(text);
  if (!content) return null;

  const management = parseManagementIntent(content);
  if (management) return management;

  const hasCreateAction = CREATE_ACTION_HINT.test(content);
  const cronExpr = parseCronExpr(content);
  if (hasCreateAction && cronExpr) {
    return {
      action: 'create-cron',
      cronExpr,
      message: extractReminderMessage(content),
      confidence: 0.9,
    };
  }

  const allowOnceByRule = hasCreateAction && hasTimeSignal(content);
  if (!allowOnceByRule) return null;

  const runAt = parseOnceRunAt(content, now);
  if (runAt) {
    return {
      action: 'create-once',
      runAt,
      message: extractReminderMessage(content),
      confidence: 0.88,
    };
  }

  return null;
}

export function parseGroupSet(value?: string[] | string): Set<string> {
  if (!value) return new Set<string>();
  if (Array.isArray(value)) {
    return new Set(value.map((item) => normalizeGroupId(item)).filter((item): item is string => Boolean(item)));
  }
  return new Set(
    value
      .split(',')
      .map((item) => normalizeGroupId(item))
      .filter((item): item is string => Boolean(item)),
  );
}

export function normalizeGroupId(input?: string | null): string | null {
  if (!input) return null;
  const value = String(input).trim();
  if (!value) return null;
  if (value.startsWith('group:')) return value.slice('group:'.length);
  if (value.startsWith('guild:')) return value.slice('guild:'.length);
  return value;
}
