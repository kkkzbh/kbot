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

const CREATE_HINT = /(提醒我|提醒|通知我|叫我|闹钟|定时|任务|计划|每周|每天|每月|分钟后|小时后|明天|后天|今天)/;

const CREATE_CANDIDATE = /(提醒|通知|叫我|闹钟|定时|任务|计划|每周|每天|每月|分钟后|小时后|明天|后天|今天|今晚)/;

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

const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clampHour(raw: number): number {
  return Math.min(23, Math.max(0, raw));
}

function clampMinute(raw: number): number {
  return Math.min(59, Math.max(0, raw));
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
    /(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})(?:日)?(?:\s+|T)?(?:(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})(?:[:点时](\d{1,2}))?)?/,
  );
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hourRaw = m[5] ? Number(m[5]) : 9;
  const minuteRaw = m[6] ? Number(m[6]) : 0;
  const hour = normalizeHour(m[4], hourRaw);
  const minute = clampMinute(minuteRaw);
  return buildLocalDate(year, month, day, hour, minute);
}

function parseRelativeOffsetTime(text: string, now: number): number | null {
  const m = text.match(/(\d+)\s*(分钟|分|小时|天)后/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  let deltaMs = 0;
  if (m[2] === '天') deltaMs = value * 24 * 60 * 60 * 1000;
  else if (m[2] === '小时') deltaMs = value * 60 * 60 * 1000;
  else deltaMs = value * 60 * 1000;
  return now + deltaMs;
}

function parseRelativeDayTime(text: string, now: number): number | null {
  const m = text.match(
    /(今天|明天|后天|今晚)(?:\s*(凌晨|早上|上午|中午|下午|晚上))?\s*(\d{1,2})?(?:[:点时](\d{1,2}))?/,
  );
  if (!m) return null;

  const dayHint = m[1];
  const period = m[2];
  const hourRaw = m[3] ? Number(m[3]) : dayHint === '今晚' ? 20 : 9;
  const minuteRaw = m[4] ? Number(m[4]) : 0;
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
  const m = text.match(/(?:凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})[:点时](\d{1,2})?/);
  if (!m) return null;
  const periodMatch = text.match(/(凌晨|早上|上午|中午|下午|晚上)/);
  const hour = normalizeHour(periodMatch?.[1], Number(m[1]));
  const minute = clampMinute(Number(m[2] ?? 0));

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
    parseRelativeDayTime(text, now) ??
    parseFallbackClockTime(text, now)
  );
}

function parseDailyCron(text: string): string | null {
  const m = text.match(/每(?:天|日)(?:\s*(凌晨|早上|上午|中午|下午|晚上))?\s*(\d{1,2})(?:[:点时](\d{1,2}))?/);
  if (!m) return null;
  const hour = normalizeHour(m[1], Number(m[2]));
  const minute = clampMinute(Number(m[3] ?? 0));
  return `${minute} ${hour} * * *`;
}

function parseWeeklyCron(text: string): string | null {
  const m = text.match(
    /每(?:周|星期)\s*([一二三四五六日天])(?:\s*(凌晨|早上|上午|中午|下午|晚上))?\s*(\d{1,2})(?:[:点时](\d{1,2}))?/,
  );
  if (!m) return null;
  const weekday = WEEKDAY_MAP[m[1]];
  if (weekday === undefined) return null;
  const hour = normalizeHour(m[2], Number(m[3]));
  const minute = clampMinute(Number(m[4] ?? 0));
  return `${minute} ${hour} * * ${weekday}`;
}

function parseMonthlyCron(text: string): string | null {
  const m = text.match(
    /每月\s*(\d{1,2})[号日]?(?:\s*(凌晨|早上|上午|中午|下午|晚上))?\s*(\d{1,2})(?:[:点时](\d{1,2}))?/,
  );
  if (!m) return null;
  const day = Number(m[1]);
  if (day < 1 || day > 31) return null;
  const hour = normalizeHour(m[2], Number(m[3]));
  const minute = clampMinute(Number(m[4] ?? 0));
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
  const remindMatch =
    text.match(/(?:提醒我|提醒|通知我|叫我)(.*)$/) ??
    text.match(/(?:定时任务|任务|计划)(.*)$/) ??
    text.match(/(?:定时|闹钟)(.*)$/);
  let candidate = remindMatch?.[1] ?? text;

  const removable = [
    /(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})日?/g,
    /(今天|明天|后天|今晚)/g,
    /每(?:周|星期)[一二三四五六日天]/g,
    /每(?:天|日)/g,
    /每月\d{1,2}[号日]?/g,
    /每隔\d+(?:分钟|小时|天)/g,
    /\d+\s*(?:分钟|分|小时|天)后/g,
    /(凌晨|早上|上午|中午|下午|晚上)?\s*\d{1,2}(?:[:点时]\d{1,2})?/g,
    /(提醒我|提醒|通知我|叫我|创建|设置|新增|任务|计划|定时|闹钟)/g,
    /[\s,，。.!！?？]+/g,
  ];

  for (const pattern of removable) {
    candidate = candidate.replace(pattern, ' ');
  }

  const normalized = normalizeWhitespace(candidate);
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

export function shouldTryAutomationIntent(text: string): boolean {
  return CREATE_CANDIDATE.test(text);
}

export function parseAutomationIntentByRule(text: string, now = Date.now()): AutomationIntent | null {
  const content = normalizeWhitespace(text);
  if (!content) return null;

  const management = parseManagementIntent(content);
  if (management) return management;

  if (!CREATE_HINT.test(content)) return null;

  const cronExpr = parseCronExpr(content);
  if (cronExpr) {
    return {
      action: 'create-cron',
      cronExpr,
      message: extractReminderMessage(content),
      confidence: 0.9,
    };
  }

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
