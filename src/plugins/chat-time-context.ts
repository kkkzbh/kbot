const FIXED_TIMEZONE = 'Asia/Shanghai';

function formatUtc8Now(now = Date.now()): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: FIXED_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(now));

  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  return `${lookup.get('year')}-${lookup.get('month')}-${lookup.get('day')} ${lookup.get('hour')}:${lookup.get('minute')}:${lookup.get('second')}`;
}

export function formatUserStampedPrompt(userName: string, message: string, now = Date.now()): string {
  const normalizedUserName = userName.trim() || '用户';
  return `${normalizedUserName}, ${formatUtc8Now(now)}: ${message}`;
}

export function injectUserStampedPrompt(content: unknown, userName: string, now = Date.now()): unknown {
  if (typeof content === 'string') {
    return formatUserStampedPrompt(userName, content, now);
  }
  if (Array.isArray(content)) {
    return [{ type: 'text', text: `${userName.trim() || '用户'}, ${formatUtc8Now(now)}:` }, ...content];
  }
  return content;
}
